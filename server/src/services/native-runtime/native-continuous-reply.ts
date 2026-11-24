import { and, asc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { findHeartbeatRunCompletionComment, nativeFinalReplyKey, resolveHeartbeatRunResponse, type CompletedFinalAgentMessageCandidate, type SteeredTaskResponseScope } from "../heartbeat-run-summary.js";
import { loadNativeVisibleReply } from "./native-visible-reply.js";
import { issueService } from "../issues.js";
import { acknowledgeChatCompletionReply } from "../chat-completion-delivery.js";
import { resolveChatRunPresentationAuthorizationReason } from "../chat-run-publications.js";
import { logActivity } from "../activity-log.js";
import { hasChatRunOwnedProviderInteraction } from "../chat-interaction-arbitration.js";
import { agentRunSupersededByFreshContinuation, agentRunWritesRevoked } from "../../agent-run-cancellation.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { readNativeSessionContinuity, resolveSessionContinuity } from "./continued-session.js";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import { drainContinuousPersonMessages } from "./native-continuous-drain.js";
import { readFirstTurnQueuedInputReceipt } from "./first-turn-queued-input.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "../issue-queued-comment-queue.js";
import { publishLiveEvent } from "../live-events.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "../heartbeat-run-status-payload.js";

/** Terminal finish and steering answer different questions. Reuse the existing
 * per-item reply/placement contract; never concatenate or compare their prose.
 * The caller supplies only an accepted result, after its presentation gates. */
export async function materializeSteeredTaskReplies(db: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string;
  resultJson: Record<string, unknown>;
  scope: SteeredTaskResponseScope;
  finalAgentMessage: CompletedFinalAgentMessageCandidate & { reasonCode?: string };
  authorizationReason: string | null;
}) {
  const finalResponse = resolveHeartbeatRunResponse({ resultJson: null, finalAgentMessage: input.finalAgentMessage });
  if (!finalResponse.text || finalResponse.decision.chosenSource !== "final_agent_message" ||
      finalResponse.decision.reasonCodes.includes("bounded_final_agent_message_without_complete_source")) return null;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.nativeIssueId, input.issueId))).for("update");
    if (!run) throw new Error("native_task_reply_run_missing");
    const summary = resolveHeartbeatRunResponse({ resultJson: input.resultJson }).text;
    if (!summary) throw new Error("native_task_reply_accepted_summary_missing");
    const summaryKey = nativeFinalReplyKey(run.id, "accepted-summary");
    const finalKey = input.finalAgentMessage.replyKey ?? nativeFinalReplyKey(run.id, `terminal-${input.finalAgentMessage.seq}`);
    const comments = await tx.select().from(issueComments).where(and(eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId), eq(issueComments.createdByRunId, run.id)));
    const existingSummary = comments.find(comment => comment.clientRequestId === summaryKey);
    const selectedId = parseObject(run.resultJson?.presentationDecision).commentId;
    // A selected reply that was removed must not be resurrected by recovery.
    if (typeof selectedId === "string" && !comments.some(comment => comment.id === selectedId)) return null;
    const existingFinal = comments.find(comment => comment.clientRequestId === finalKey || comment.clientRequestId?.startsWith(`${finalKey}:`))
      ?? comments.find(comment => comment.id === selectedId && comment.id !== existingSummary?.id)
      ?? findHeartbeatRunCompletionComment(comments.filter(comment => comment.id !== existingSummary?.id), run.resultJson, finalKey);
    const actor = { agentId: input.agentId, runId: run.id };
    const options = { authorizationReason: input.authorizationReason, completionReply: true };
    const summaryComment = existingSummary ?? await issueService(db).addComment(input.issueId, summary, actor,
      { authorizationReason: input.authorizationReason, clientRequestId: summaryKey,
        ...(existingFinal ? { createdAt: new Date(existingFinal.createdAt.getTime() - 1) } : {}) }, tx);
    const finalComment = existingFinal ?? await issueService(db).addComment(input.issueId, finalResponse.text!, actor,
      { ...options, clientRequestId: finalKey }, tx);
    const replies = parseObject(run.resultJson?.continuousReplies);
    const finalItemId = finalKey.slice(`native-final:${run.id}:`.length);
    const decision = { ...finalResponse.decision,
      commentAction: "reuse" as const, commentId: finalComment.id,
      reasonCodes: ["accepted_summary_and_steered_final_separate_replies"] };
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
      presentationDecision: decision,
      continuousReplies: { ...replies,
        "accepted-summary": { questionCommentIds: input.scope.originalQuestionCommentIds, commentId: summaryComment.id, sourceEventId: null },
        [finalItemId]: { questionCommentIds: input.scope.steeredQuestionCommentIds, commentId: finalComment.id,
          sourceEventId: input.finalAgentMessage.sourceEventId },
      },
    })}::jsonb`, updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    for (const comment of [!existingSummary && summaryComment, !existingFinal && finalComment]) {
      if (comment) await logActivity(tx, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
        agentId: input.agentId, runId: run.id, issueId: input.issueId, action: "issue.comment_added", entityType: "issue",
        entityId: input.issueId, details: { commentId: comment.id, source: "run_presentation_resolver" } });
    }
    return { decision, created: !existingSummary || !existingFinal };
  });
}

/** A Stop receipt is durable while its original comments await draft restoration. */
async function applyNativePersonStopNotice(input: Parameters<typeof publishContinuousNativeReply>[0]) {
  const payload = parseObject(input.event.payload);
  if (input.event.eventType !== "provider.notice.recorded" || payload.category !== "pi_stop_returned_input") return;
  const { companyId, issueId, runId, agentId } = input.execution.binding;
  const ids = (Array.isArray(payload.details) ? payload.details : [])
    .filter(detail => parseObject(detail).name === "returnedCommentIds")
    .flatMap(detail => String(parseObject(detail).value ?? "").split(",")).map(id => id.trim()).filter(Boolean);
  const updated = await input.db.transaction(async tx => {
    const [issue] = await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("no key update");
    if (!issue) return;
    // Queue mutations lock the issue, then its wakes, then the run.
    const wakes = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]), isNull(agentWakeupRequests.runId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`)).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.nativeIssueId, issueId))).for("update");
    const result = parseObject(run?.resultJson), stop = parseObject(result.personStop);
    // Post-commit callbacks may race; a maximum cursor alone would lose an older receipt.
    const applied = Array.isArray(stop.returnedNoticeSeqs) ? stop.returnedNoticeSeqs : [];
    // This is a person's return receipt, not an agent write: terminal Stop recovery still applies it.
    if (!run || run.runtimeMode !== "native" || run.nativeSessionId !== input.event.normalizedSessionId ||
        !stop.requestedAt || applied.includes(input.cursor)) return;
    const previous = Array.isArray(stop.returned) ? stop.returned.filter((id): id is string => typeof id === "string") : [];
    // Keep the text readable: the browser copies to its draft BEFORE author-delete.
    // UUIDs are compared as text so a malformed provider detail cannot abort ingestion.
    const returned = ids.length ? (await tx.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      inArray(sql<string>`${issueComments.id}::text`, [...previous, ...ids]),
    )).orderBy(asc(issueComments.createdAt), asc(issueComments.id)))
      .filter(comment => previous.includes(comment.id) || (typeof stop.userId === "string" && comment.authorUserId === stop.userId &&
        !comment.deletedAt && comment.createdAt <= new Date(String(stop.requestedAt))))
      .map(comment => comment.id) : previous;
    for (const wake of wakes) {
      const queued = queuedCommentIdsFromWakePayload(wake.payload), left = queued.filter(id => !returned.includes(id));
      if (left.length === queued.length) continue;
      const now = new Date();
      await tx.update(agentWakeupRequests).set(left.length
        ? { payload: withQueuedCommentIdsInWakePayload(wake.payload, left), updatedAt: now }
        : { status: "cancelled", finishedAt: now, updatedAt: now }).where(eq(agentWakeupRequests.id, wake.id));
    }
    // A final may already have published when this post-commit observer is replayed.
    const published = Object.keys(parseObject(result.continuousReplies));
    const [answer] = published.length && !stop.settledAt && !stop.resumedAt && input.cursor > Number(stop.afterEventSeq ?? -1)
      ? await tx.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
        eq(heartbeatRunEvents.eventType, "item.completed"), gt(heartbeatRunEvents.seq, input.cursor),
        inArray(sql<string>`${heartbeatRunEvents.payload} #>> '{prpEvent,itemId}'`, published),
      )).orderBy(asc(heartbeatRunEvents.seq)).limit(1) : [];
    const [saved] = await tx.update(heartbeatRuns).set({ resultJson: { ...result, personStop: {
      ...stop, returned, returnedNoticeSeq: Math.max(Number(stop.returnedNoticeSeq ?? -1), input.cursor),
      ...(answer ? { settledAt: new Date().toISOString(), answerItemId: parseObject(parseObject(answer.payload).prpEvent).itemId } : {}),
      returnedNoticeSeqs: [...applied, input.cursor],
      ...(input.cursor > Number(stop.afterEventSeq ?? -1) ? { noticeSeq: Math.max(Number(stop.noticeSeq ?? -1), input.cursor) } : {}),
    } } }).where(eq(heartbeatRuns.id, runId)).returning();
    return saved;
  });
  if (updated) publishLiveEvent({
    companyId, type: "heartbeat.run.status", payload: buildHeartbeatRunStatusLiveEventPayload(updated),
  });
}

/** Replay the ingestion/publication crash gap before terminal presentation or queue release. */
export async function recoverContinuousNativeReplies(db: Db, scope: { id: string; companyId: string; sessionContinuity?: "continuous" | "paperclip" }) {
  const [row] = await db.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId)))
    .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId)));
  const provider = parseObject(parseObject(row?.run.runnerProfileJson).nativeExecutionInput).provider;
  if (!row?.run.nativeIssueId || row.run.runtimeMode !== "native" || (parseObject(provider).kind ?? row.config.provider) !== "pi_rpc" ||
      resolveSessionContinuity("pi_rpc", readNativeSessionContinuity(row.run.runnerProfileJson) ?? scope.sessionContinuity ?? row.config.sessionContinuity) !== "continuous") return;
  const events = await db.select({ seq: heartbeatRunEvents.seq, eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.id),
      inArray(heartbeatRunEvents.eventType, ["item.completed", "provider.notice.recorded"]))).orderBy(asc(heartbeatRunEvents.seq));
  for (const event of events) await publishContinuousNativeReply({ db, cursor: event.seq, recoverTerminal: true, sessionContinuity: scope.sessionContinuity,
    execution: { binding: { companyId: scope.companyId, issueId: row.run.nativeIssueId, runId: scope.id, agentId: row.run.agentId },
      provider: { kind: "pi_rpc" } },
    event: { ...parseObject(parseObject(event.payload).prpEvent), eventType: event.eventType } as Parameters<typeof publishContinuousNativeReply>[0]["event"],
  });
}

/** Interrupted turns need no accepted semantic result to retain their shown prose.
 * This is server-owned history publication, not restored execution authority. */
export async function recoverTerminalNativeVisibleReply(db: Db, scope: { companyId: string; issueId: string; runId: string }) {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId))).for("no key update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, scope.runId),
      eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.nativeIssueId, scope.issueId))).for("update");
    if (!issue || !run || run.runtimeMode !== "native" || !run.finishedAt || isNativeRunnerOwnershipHeld(run) ||
        !["cancelled", "interrupted", "failed", "timed_out"].includes(run.status) || agentRunSupersededByFreshContinuation(run) ||
        run.contextSnapshot?.skipIssueComment === true ||
        (issue.conversationAgentId && (issue.conversationAgentId !== run.agentId ||
          issue.conversationUserId !== run.responsibleUserId ||
          run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration))) return false;
    const presentation = parseObject(run.resultJson?.presentationDecision);
    if (typeof presentation.commentId === "string" ||
        (presentation.commentAction !== undefined && presentation.commentAction !== "create")) return false;
    const finalAgentMessage = await loadNativeVisibleReply(tx, { ...scope, agentId: run.agentId, normalizedSessionId: run.nativeSessionId });
    if (!finalAgentMessage) return false;
    const comments = await tx.select({ id: issueComments.id, body: issueComments.body, presentation: issueComments.presentation,
      clientRequestId: issueComments.clientRequestId }).from(issueComments).where(and(eq(issueComments.companyId, scope.companyId),
        eq(issueComments.issueId, scope.issueId), eq(issueComments.createdByRunId, scope.runId))).orderBy(asc(issueComments.createdAt));
    const resolved = resolveHeartbeatRunResponse({ resultJson: null, finalAgentMessage,
      nativeConversationFinalResponse: Boolean(issue.conversationAgentId),
      existingComment: findHeartbeatRunCompletionComment(comments, run.resultJson, finalAgentMessage.replyKey) });
    if (!resolved.text || resolved.decision.commentAction === "none") return false;
    const authorizationReason = await resolveChatRunPresentationAuthorizationReason(tx, scope);
    const commentId = resolved.decision.commentAction === "reuse" ? resolved.decision.commentId :
      (await issueService(db).addComment(scope.issueId, resolved.text, { agentId: run.agentId, runId: run.id },
        { authorizationReason, completionReply: true, clientRequestId: finalAgentMessage.replyKey ?? `native-visible:${run.id}:${finalAgentMessage.seq}` }, tx)).id;
    await tx.update(heartbeatRuns).set({ resultJson: { ...parseObject(run.resultJson),
      presentationDecision: { ...resolved.decision, commentId, reasonCodes: [...resolved.decision.reasonCodes, "terminal_visible_reply_recovered"] } },
      updatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    if (resolved.decision.commentAction === "create") await logActivity(tx, { ...scope, actorType: "agent", actorId: run.agentId,
      agentId: run.agentId, action: "issue.comment_added", entityType: "issue", entityId: scope.issueId,
      details: { commentId, source: "run_presentation_resolver", presentationSource: resolved.decision.chosenSource } });
    return resolved.decision.commentAction === "create";
  });
}

/** A held turn can answer more than once; the event, not the run, owns each reply. */
export async function publishContinuousNativeReply(input: {
  db: Db;
  cursor: number;
  recoverTerminal?: boolean;
  sessionContinuity?: "continuous" | "paperclip";
  execution: {
    binding: Pick<NativeExecutionInput["binding"], "companyId" | "issueId" | "runId" | "agentId">;
    provider: Pick<NativeExecutionInput["provider"], "kind">;
  };
  event: Pick<PrpEvent, "eventType" | "payload" | "sourceEventId" | "runId" | "normalizedSessionId" | "itemId">;
}): Promise<boolean | undefined> {
  if (input.execution.provider.kind !== "pi_rpc" || input.event.runId !== input.execution.binding.runId) return;
  await applyNativePersonStopNotice(input);
  if (input.event.eventType !== "item.completed") return;
  const payload = parseObject(input.event.payload);
  if (!["agentMessage", "assistant_message"].includes(String(payload.kind)) || payload.channel !== "final" || !input.event.itemId) return;
  const { companyId, issueId, runId, agentId } = input.execution.binding;
  let steerableFinal = false;
  let published = false;
  const updated = await input.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, companyId),
    )).for("no key update");
    const [row] = await tx.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.nativeIssueId, issueId))).for("update", { of: heartbeatRuns });
    const terminalReplay = Boolean(input.recoverTerminal && row?.run.finishedAt &&
      ["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(row.run.status) &&
      !agentRunSupersededByFreshContinuation(row.run));
    if (!issue || !row || (row.run.status !== "running" && !terminalReplay) || row.run.runtimeMode !== "native" ||
        row.run.nativeSessionId !== input.event.normalizedSessionId || (agentRunWritesRevoked(row.run) && !terminalReplay) ||
        (issue.conversationAgentId && (issue.conversationAgentId !== agentId || issue.conversationState !== "active" ||
          row.run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration)) ||
        row.run.contextSnapshot?.skipIssueComment === true ||
        resolveSessionContinuity("pi_rpc", readNativeSessionContinuity(row.run.runnerProfileJson) ?? input.sessionContinuity ?? row.config.sessionContinuity) !== "continuous") return;
    const [recovery] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.eventType, "lifecycle"), lt(heartbeatRunEvents.seq, input.cursor),
      sql`${heartbeatRunEvents.payload}->>'retryReasonCode' = 'semantic_result_missing'`)).limit(1);
    if (recovery) return;
    steerableFinal = row.run.status === "running" && !input.recoverTerminal;
    const result = parseObject(row.run.resultJson);
    const replies = parseObject(result.continuousReplies);
    if (replies[input.event.itemId!]) { published = true; return; }
    const stop = parseObject(result.personStop);
    const returned = new Set(Array.isArray(stop.returned) ? stop.returned : []);
    const answered = new Set(Object.values(replies).flatMap(value => {
      const ids = parseObject(value).questionCommentIds;
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    }));
    const pending = Object.entries(parseObject(result.queuedSteeringAcknowledgements))
      .filter(([id, receipt]) => !answered.has(id) && !returned.has(id) && parseObject(receipt).status === "acknowledged" &&
        (typeof parseObject(receipt).afterEventSeq !== "number" || Number(parseObject(receipt).afterEventSeq) < input.cursor))
      .sort((a, b) => String(parseObject(a[1]).acknowledgedAt).localeCompare(String(parseObject(b[1]).acknowledgedAt)));
    const wakeId = row.run.contextSnapshot?.wakeCommentId;
    // Pi knows which inputs entered the model before this final. An explicit
    // empty list is authoritative too: do not shift the next question onto it.
    // Older packs omit answers and retain the original FIFO behavior.
    const answers = input.event.payload.answers;
    const explicitAnswers = Array.isArray(answers);
    const firstInputIds = Object.keys(replies).length === 0 ? [
      ...(Array.isArray(row.run.contextSnapshot?.wakeCommentIds) ? row.run.contextSnapshot.wakeCommentIds : []),
      ...(typeof wakeId === "string" ? [wakeId] : []),
      ...(readFirstTurnQueuedInputReceipt(row.run)?.commentIds ?? []),
    ].filter((id): id is string => typeof id === "string" && !answered.has(id) && !returned.has(id)) : [];
    const questionCommentIds = [...new Set([
      ...(explicitAnswers ? firstInputIds : typeof wakeId === "string" && !answered.has(wakeId) && !returned.has(wakeId) ? [wakeId] : []),
      ...(explicitAnswers
        ? answers.filter((id): id is string => typeof id === "string" && !answered.has(id) && !returned.has(id))
        : pending[0] ? [pending[0][0]] : []),
    ])];
    const clientRequestId = `${nativeFinalReplyKey(runId, input.event.itemId!)}:${questionCommentIds.join(",") || "opening"}`;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.authorAgentId, agentId), eq(issueComments.clientRequestId, clientRequestId)));
    if (existing) return;
    const finalAgentMessage = await loadNativeVisibleReply(tx, { companyId, runId, agentId,
      normalizedSessionId: row.run.nativeSessionId, throughSeq: input.cursor,
      finalEvent: { seq: input.cursor, prpEvent: input.event } });
    const resolved = resolveHeartbeatRunResponse({ resultJson: null,
      finalAgentMessage,
      nativeConversationFinalResponse: Boolean(issue.conversationAgentId),
      interactionOwnsResponse: Boolean(issue.conversationAgentId) && await hasChatRunOwnedProviderInteraction(tx, { companyId, issueId, runId }),
    });
    if (!resolved.text || resolved.decision.commentAction !== "create") return;
    const authorizationReason = await resolveChatRunPresentationAuthorizationReason(tx, { companyId, issueId, runId });
    const comment = await issueService(input.db).addComment(issueId, resolved.text, { agentId, runId }, {
      authorizationReason, clientRequestId,
      ...(terminalReplay ? { persistedVisibleReplyThroughSeq: input.cursor } : {}),
    }, tx);
    if (Object.keys(replies).length === 0 && Array.isArray(row.run.contextSnapshot?.chatCompletionDeliveryIds) && row.run.contextSnapshot.chatCompletionDeliveryIds.length)
      await acknowledgeChatCompletionReply(tx, runId, comment.id);
    if (Array.isArray(payload.answers) && payload.answers.length)
      await acknowledgeChatCompletionReply(tx, runId, comment.id, payload.answers.filter((id): id is string => typeof id === "string"));
    const [saved] = await tx.update(heartbeatRuns).set({ resultJson: { ...result,
      ...(stop.requestedAt && !stop.settledAt && !stop.resumedAt && typeof stop.noticeSeq === "number" && stop.noticeSeq < input.cursor
        ? { personStop: { ...stop, settledAt: new Date().toISOString(), answerItemId: input.event.itemId } } : {}),
      continuousReplies: { ...replies,
        [input.event.itemId!]: { questionCommentIds, commentId: comment.id, sourceEventId: input.event.sourceEventId },
      } } }).where(eq(heartbeatRuns.id, runId)).returning();
    await logActivity(tx, { companyId, actorType: "agent", actorId: agentId, agentId, runId, issueId,
      action: "issue.comment_added", entityType: "issue", entityId: issueId,
      details: { commentId: comment.id, bodySnippet: comment.body.slice(0, 120), identifier: issue.identifier,
        issueTitle: issue.title, authorizationReason, source: "run_presentation_resolver",
        presentationSource: resolved.decision.chosenSource, sourceEventId: input.event.sourceEventId } });
    published = true;
    return saved;
  });
  if (updated) publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: buildHeartbeatRunStatusLiveEventPayload(updated) });
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
