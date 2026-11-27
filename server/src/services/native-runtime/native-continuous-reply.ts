import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { completedPlanProposalIds, nativeFinalReplyKey, readCompletedAssistantMessageCandidate, resolveHeartbeatRunResponse } from "../heartbeat-run-summary.js";
import { issueService } from "../issues.js";
import { acknowledgeChatCompletionReply } from "../chat-completion-delivery.js";
import { resolveChatRunPresentationAuthorizationReason } from "../chat-run-publications.js";
import { logActivity } from "../activity-log.js";
import { hasChatRunOwnedProviderInteraction } from "../chat-interaction-arbitration.js";
import { agentRunWritesRevoked } from "../../agent-run-cancellation.js";
import { resolveSessionContinuity } from "./continued-session.js";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { drainContinuousPersonMessages } from "./native-continuous-drain.js";
import { readFirstTurnQueuedInputReceipt } from "./first-turn-queued-input.js";
import { readContinuousSessionInput, settleContinuousSessionInput } from "./continuous-session-input.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "../issue-queued-comment-queue.js";
import { queuedInteractionId } from "../queued-interaction-response.js";

/** Replay the ingestion/publication crash gap before terminal presentation or queue release. */
export async function recoverContinuousNativeReplies(db: Db, scope: { id: string; companyId: string }) {
  const [row] = await db.select({ issueId: heartbeatRuns.nativeIssueId, agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId)))
    .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRuns.runtimeMode, "native"), sql`${heartbeatRuns.nativeIssueId} is not null`,
      sql`${agents.adapterConfig}->'provider' = '"pi_rpc"'::jsonb`,
      // Pi defaults to continuous for every value except the explicit paperclip setting.
      sql`${agents.adapterConfig}->'sessionContinuity' is distinct from '"paperclip"'::jsonb`));
  if (!row?.issueId) return;
  const prpEvent = sql`${heartbeatRunEvents.payload}->'prpEvent'`;
  const payload = sql`${prpEvent}->'payload'`;
  const events = await db.select({ seq: heartbeatRunEvents.seq,
    // Preserve absent keys as absent (not JSON null): the publisher compares
    // session identity and persists optional receipt fields verbatim.
    event: sql<Parameters<typeof publishContinuousNativeReply>[0]["event"]>`
      coalesce((select jsonb_object_agg(key, value) from jsonb_each(${prpEvent})
        where key in ('runId', 'normalizedSessionId', 'itemId', 'sourceEventId', 'turnId')), '{}'::jsonb)
      || jsonb_build_object('payload', (select jsonb_object_agg(key, value) from jsonb_each(${payload})
        where key in ('kind', 'channel', 'text', 'answers', 'itemId')))`,
  }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.id),
      eq(heartbeatRunEvents.eventType, "item.completed"),
      sql`${payload}->'kind' in ('"agentMessage"'::jsonb, '"assistant_message"'::jsonb)`,
      sql`${payload}->'channel' = '"final"'::jsonb`)).orderBy(asc(heartbeatRunEvents.seq));
  for (const event of events) await publishContinuousNativeReply({ db, cursor: event.seq, recoverTerminal: true,
    execution: { binding: { companyId: scope.companyId, issueId: row.issueId, runId: scope.id, agentId: row.agentId },
      provider: { kind: "pi_rpc" } },
    event: { ...event.event, eventType: "item.completed" },
  });
}

/** A held turn can answer more than once; the event, not the run, owns each reply. */
export async function publishContinuousNativeReply(input: {
  db: Db;
  cursor: number;
  recoverTerminal?: boolean;
  execution: {
    binding: Pick<NativeExecutionInput["binding"], "companyId" | "issueId" | "runId" | "agentId">;
    provider: Pick<NativeExecutionInput["provider"], "kind">;
  };
  event: Pick<PrpEvent, "eventType" | "payload" | "sourceEventId" | "runId" | "normalizedSessionId" | "itemId" | "turnId">;
}) {
  if (input.execution.provider.kind !== "pi_rpc" || input.event.eventType !== "item.completed") return;
  const finalAgentMessage = readCompletedAssistantMessageCandidate({ seq: 0, prpEvent: input.event });
  if (finalAgentMessage?.channel !== "final" || !input.event.itemId) return;
  const { companyId, issueId, runId, agentId } = input.execution.binding;
  if (input.event.runId !== runId) return;
  const inheritedInput = await readContinuousSessionInput(input.db, { companyId, issueId, runId, agentId });
  let steerableFinal = false;
  const published = await input.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await settleContinuousSessionInput(tx, { companyId, issueId, runId, agentId }, inheritedInput);
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, companyId),
    )).for("no key update");
    const [row] = await tx.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.nativeIssueId, issueId))).for("update", { of: heartbeatRuns });
    if (!issue || !row || (row.run.status !== "running" && !input.recoverTerminal) || row.run.runtimeMode !== "native" ||
        row.run.nativeSessionId !== input.event.normalizedSessionId || agentRunWritesRevoked(row.run) ||
        (issue.conversationAgentId && (issue.conversationAgentId !== agentId || issue.conversationState !== "active" ||
          row.run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration)) ||
        row.run.contextSnapshot?.skipIssueComment === true ||
        resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous") return;
    const [recovery] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "lifecycle"), lt(heartbeatRunEvents.seq, input.cursor),
      sql`${heartbeatRunEvents.payload}->>'retryReasonCode' = 'semantic_result_missing'`)).limit(1);
    if (recovery) return;
    steerableFinal = row.run.status === "running" && !input.recoverTerminal;
    const result = parseObject(row.run.resultJson);
    const replies = parseObject(result.continuousReplies);
    if (replies[input.event.itemId!]) return true;
    const answered = new Set(Object.values(replies).flatMap(value => {
      const ids = parseObject(value).questionCommentIds;
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    }));
    const pending = Object.entries(parseObject(result.queuedSteeringAcknowledgements))
      .filter(([id, receipt]) => !answered.has(id) && parseObject(receipt).status === "acknowledged" &&
        (typeof parseObject(receipt).afterEventSeq !== "number" || Number(parseObject(receipt).afterEventSeq) < input.cursor))
      .sort((a, b) => String(parseObject(a[1]).acknowledgedAt).localeCompare(String(parseObject(b[1]).acknowledgedAt)));
    const wakeId = row.run.contextSnapshot?.wakeCommentId;
    // Nonempty answers own only the ACKs they name. Otherwise the first final
    // after an ACK's cursor in the accepting turn owns it, never an earlier
    // final or one from another turn. Unqualified legacy ACKs are not implied.
    const sameTurnAcknowledgements = input.event.turnId ? pending
      .filter(([, receipt]) => parseObject(receipt).turnId === input.event.turnId &&
        typeof parseObject(receipt).afterEventSeq === "number")
      .map(([id]) => id) : [];
    const answers = input.event.payload.answers;
    const explicitAnswers = Array.isArray(answers);
    const sealed = readFirstTurnQueuedInputReceipt(row.run);
    const sealedIds = [...(sealed?.commentIds ?? []), ...(sealed?.interactionIds ?? [])];
    // Submitted IDs alias the sealed first-turn inputs even after earlier
    // finals answered nothing or something else. Only steer-ACK ownership is
    // restricted by a nonempty explicit answers list.
    const submittedInputIds = [
      ...(Array.isArray(row.run.contextSnapshot?.wakeCommentIds) ? row.run.contextSnapshot.wakeCommentIds : []),
      ...(typeof wakeId === "string" ? [wakeId] : []),
    ].filter((id): id is string => typeof id === "string");
    const firstInputIds = Object.keys(replies).length === 0
      ? [...submittedInputIds, ...sealedIds].filter(id => !answered.has(id)) : [];
    const continued = parseObject(result.continuedSessionInput);
    const impliedInputIds = Object.keys(replies).length === 0 && continued.runId === runId &&
      continued.sessionId === row.run.nativeSessionId && Array.isArray(continued.commentIds)
      ? continued.commentIds.filter((id): id is string => typeof id === "string" && !answered.has(id)) : [];
    const handback = row.run.contextSnapshot?.preDispatchInputHandback === true;
    const nonemptyExplicitAnswers = explicitAnswers && answers.length > 0;
    let questionCommentIds = [...new Set(nonemptyExplicitAnswers
      ? [
        ...answers.filter((id): id is string => typeof id === "string" && !answered.has(id)),
        ...(answers.some(id => submittedInputIds.includes(id)) ? sealedIds.filter(id => !answered.has(id)) : []),
      ]
      : [
        ...(!explicitAnswers ? [...impliedInputIds, ...firstInputIds] : []),
        ...(input.event.turnId ? firstInputIds : []),
        ...sameTurnAcknowledgements,
      ])];
    if (handback && questionCommentIds.length) {
      const chronological = (await tx.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, questionCommentIds),
      )).orderBy(asc(issueComments.createdAt), asc(issueComments.id))).map(comment => comment.id);
      // Interaction delivery IDs are not comments; keep their attribution too.
      const commentIds = new Set(chronological);
      questionCommentIds = [...chronological, ...questionCommentIds.filter(id => !commentIds.has(id))];
    }
    const clientRequestId = `${nativeFinalReplyKey(runId, input.event.itemId!)}:${questionCommentIds.join(",") || "opening"}`;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.authorAgentId, agentId), eq(issueComments.clientRequestId, clientRequestId)));
    if (existing) return;
    const proposedItemIds = completedPlanProposalIds(await tx.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "plan.proposed"))));
    const resolved = resolveHeartbeatRunResponse({ resultJson: null,
      finalAgentMessage: readCompletedAssistantMessageCandidate({ seq: input.cursor, prpEvent: input.event, proposedItemIds }),
      nativeConversationFinalResponse: Boolean(issue.conversationAgentId),
      interactionOwnsResponse: Boolean(issue.conversationAgentId) && await hasChatRunOwnedProviderInteraction(tx, { companyId, issueId, runId }),
    });
    if (!resolved.text || resolved.decision.commentAction !== "create") return;
    const normalizedText = resolved.text.trim().replace(/\s+/g, " ");
    const receipt = { questionCommentIds, sourceEventId: input.event.sourceEventId,
      turnId: input.event.turnId ?? null, cursor: input.cursor, normalizedText };
    // Different items can repeat one final. Only a newly answered input earns
    // another identical comment; keep every item in the ledger for replay.
    const previous = input.event.turnId ? Object.values(replies).map(parseObject)
      .filter(reply => reply.turnId === input.event.turnId && typeof reply.cursor === "number")
      .sort((a, b) => Number(b.cursor) - Number(a.cursor))[0] : undefined;
    if (!questionCommentIds.length && previous?.normalizedText === normalizedText && typeof previous.commentId === "string") {
      await tx.update(heartbeatRuns).set({ resultJson: { ...result, continuousReplies: { ...replies,
        [input.event.itemId!]: { ...receipt, commentId: previous.commentId, publishedByReference: true },
      } } }).where(eq(heartbeatRuns.id, runId));
      return true;
    }
    // A tool may already have published this answer. Reuse only an unclaimed
    // comment inside this turn's first-event/final window, never an earlier answer
    // to a different input (even if its text is identical).
    const [firstInput] = input.event.turnId ? await tx.select({ createdAt: heartbeatRunEvents.createdAt }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId), lt(heartbeatRunEvents.seq, input.cursor),
      // A held turn answers many messages: start after this turn's previous
      // final, else at its first event (turn.* events are not always persisted).
      typeof previous?.cursor === "number" ? eq(heartbeatRunEvents.seq, Number(previous.cursor))
        : sql`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId' = ${input.event.turnId}`,
    )).orderBy(asc(heartbeatRunEvents.seq)).limit(1) : [];
    const claimedCommentIds = new Set(Object.values(replies).map(value => parseObject(value).commentId));
    const candidates = firstInput ? await tx.select({ id: issueComments.id, body: issueComments.body }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId), eq(issueComments.authorAgentId, agentId),
      eq(issueComments.createdByRunId, runId), isNull(issueComments.deletedAt), gte(issueComments.createdAt, firstInput.createdAt),
      lte(issueComments.createdAt, sql`coalesce((select ${heartbeatRunEvents.createdAt} from ${heartbeatRunEvents}
        where ${heartbeatRunEvents.companyId} = ${companyId} and ${heartbeatRunEvents.runId} = ${runId}
          and ${heartbeatRunEvents.seq} = ${input.cursor}), 'infinity'::timestamptz)`),
    )).orderBy(asc(issueComments.createdAt), asc(issueComments.id)) : [];
    const referenced = candidates.find(comment => !claimedCommentIds.has(comment.id) &&
      comment.body.trim().replace(/\s+/g, " ") === normalizedText);
    const authorizationReason = await resolveChatRunPresentationAuthorizationReason(tx, { companyId, issueId, runId });
    const comment = referenced ?? await issueService(input.db).addComment(issueId, resolved.text, { agentId, runId }, {
      authorizationReason, clientRequestId,
    }, tx);
    // Only the first final owns this run's frozen completion input. Later
    // steered completions require the final's explicit delivery-id attribution.
    if (Object.keys(replies).length === 0 && Array.isArray(row.run.contextSnapshot?.chatCompletionDeliveryIds) && row.run.contextSnapshot.chatCompletionDeliveryIds.length)
      await acknowledgeChatCompletionReply(tx, runId, comment.id,
        row.run.contextSnapshot.chatCompletionDeliveryIds.filter((id): id is string => typeof id === "string"));
    if (explicitAnswers && answers.length)
      await acknowledgeChatCompletionReply(tx, runId, comment.id, answers.filter((id): id is string => typeof id === "string"));
    await tx.update(heartbeatRuns).set({ resultJson: { ...result, continuousReplies: { ...replies,
      [input.event.itemId!]: { ...receipt, commentId: comment.id, ...(referenced ? { publishedByReference: true } : {}) },
    } } }).where(eq(heartbeatRuns.id, runId));
    // Reply attribution and queue settlement commit together. A claim alone is
    // not consumption: before this final, failed starts still owe every answer.
    if (sealed?.wakeupRequestIds.length) {
      const wakes = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
        inArray(agentWakeupRequests.id, sealed.wakeupRequestIds), eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      )).for("update");
      const consumed = new Set(questionCommentIds), now = new Date();
      for (const wake of wakes) {
        const interactionId = queuedInteractionId(wake.payload);
        const ids = queuedCommentIdsFromWakePayload(wake.payload);
        const remaining = ids.filter(id => !consumed.has(id));
        if (interactionId ? !sealed.interactionIds?.includes(interactionId) || !consumed.has(interactionId)
          : remaining.length === ids.length) continue;
        await tx.update(agentWakeupRequests).set({ ...(remaining.length
          ? { payload: withQueuedCommentIdsInWakePayload(wake.payload, remaining) }
          : { status: "cancelled", finishedAt: now }), updatedAt: now }).where(eq(agentWakeupRequests.id, wake.id));
      }
    }
    if (handback && questionCommentIds.length) {
      const receipts = await tx.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
        sql`${agentWakeupRequests.payload}->'preDispatchInputOnly' = 'true'::jsonb`,
      ));
      const handled = new Set(questionCommentIds);
      for (const receipt of receipts) {
        const ids = queuedCommentIdsFromWakePayload(receipt.payload);
        const remaining = ids.filter(id => !handled.has(id));
        if (remaining.length === ids.length) continue;
        await tx.update(agentWakeupRequests).set({
          payload: withQueuedCommentIdsInWakePayload(receipt.payload, remaining), updatedAt: new Date(),
          ...(!remaining.length ? { status: "completed", finishedAt: new Date() } : {}),
        }).where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.id, receipt.id)));
      }
    }
    if (!referenced) await logActivity(tx, { companyId, actorType: "agent", actorId: agentId, agentId, runId, issueId,
      action: "issue.comment_added", entityType: "issue", entityId: issueId,
      details: { commentId: comment.id, bodySnippet: comment.body.slice(0, 120), identifier: issue.identifier,
        issueTitle: issue.title, authorizationReason, source: "run_presentation_resolver",
        presentationSource: resolved.decision.chosenSource, sourceEventId: finalAgentMessage.sourceEventId } });
    return true;
  });
  // Never steer inside the publication transaction: it owns the ISSUE row,
  // while steering must persist run events before taking its own ACK locks.
  if (steerableFinal) {
    try { await drainContinuousPersonMessages(input.db, { companyId, issueId, runId, agentId }); }
    catch (error) {
      // A competing queue mutation, Stop, or uncertain ACK leaves the durable
      // wake intact for replay/the ordinary end-of-run release path.
      logger.warn({ error, companyId, issueId, runId }, "held-run person-message drain deferred");
    }
  }
  // The executor may mark this run idle and request a reset close only after
  // publication commits and the deferred person-message drain finishes.
  return published;
}
