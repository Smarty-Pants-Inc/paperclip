import { and, asc, eq, lt, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { completedPlanProposalIds, nativeFinalReplyKey, readCompletedAssistantMessageCandidate, resolveHeartbeatRunResponse } from "../heartbeat-run-summary.js";
import { issueService } from "../issues.js";
import { resolveChatRunPresentationAuthorizationReason } from "../chat-run-publications.js";
import { logActivity } from "../activity-log.js";
import { hasChatRunOwnedProviderInteraction } from "../chat-interaction-arbitration.js";
import { agentRunWritesRevoked } from "../../agent-run-cancellation.js";
import { resolveSessionContinuity } from "./continued-session.js";
import { parseObject } from "../../adapters/utils.js";

/** Replay the ingestion/publication crash gap before terminal presentation or queue release. */
export async function recoverContinuousNativeReplies(db: Db, scope: { id: string; companyId: string }) {
  const [row] = await db.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId)))
    .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId)));
  if (!row?.run.nativeIssueId || row.run.runtimeMode !== "native" || row.config.provider !== "pi_rpc" ||
      resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous") return;
  const events = await db.select({ seq: heartbeatRunEvents.seq, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.companyId, scope.companyId), eq(heartbeatRunEvents.runId, scope.id),
      eq(heartbeatRunEvents.eventType, "item.completed"))).orderBy(asc(heartbeatRunEvents.seq));
  for (const event of events) await publishContinuousNativeReply({ db, cursor: event.seq, recoverTerminal: true,
    execution: { binding: { companyId: scope.companyId, issueId: row.run.nativeIssueId, runId: scope.id, agentId: row.run.agentId },
      provider: { kind: "pi_rpc" } },
    event: { ...parseObject(parseObject(event.payload).prpEvent), eventType: "item.completed" } as Parameters<typeof publishContinuousNativeReply>[0]["event"],
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
  event: Pick<PrpEvent, "eventType" | "payload" | "sourceEventId" | "runId" | "normalizedSessionId" | "itemId">;
}) {
  if (input.execution.provider.kind !== "pi_rpc" || input.event.eventType !== "item.completed") return;
  const finalAgentMessage = readCompletedAssistantMessageCandidate({ seq: 0, prpEvent: input.event });
  if (finalAgentMessage?.channel !== "final" || !input.event.itemId) return;
  const { companyId, issueId, runId, agentId } = input.execution.binding;
  if (input.event.runId !== runId) return;
  await input.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.id, issueId), eq(issues.companyId, companyId),
    )).for("update");
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
    const result = parseObject(row.run.resultJson);
    const replies = parseObject(result.continuousReplies);
    if (replies[input.event.itemId!]) return;
    const answered = new Set(Object.values(replies).flatMap(value => {
      const ids = parseObject(value).questionCommentIds;
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    }));
    const pending = Object.entries(parseObject(result.queuedSteeringAcknowledgements))
      .filter(([id, receipt]) => !answered.has(id) && parseObject(receipt).status === "acknowledged" &&
        (typeof parseObject(receipt).afterEventSeq !== "number" || Number(parseObject(receipt).afterEventSeq) < input.cursor))
      .sort((a, b) => String(parseObject(a[1]).acknowledgedAt).localeCompare(String(parseObject(b[1]).acknowledgedAt)));
    const wakeId = row.run.contextSnapshot?.wakeCommentId;
    const questionCommentIds = [...new Set([
      ...(typeof wakeId === "string" && !answered.has(wakeId) ? [wakeId] : []),
      ...(pending[0] ? [pending[0][0]] : []),
    ])];
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
    const authorizationReason = await resolveChatRunPresentationAuthorizationReason(tx, { companyId, issueId, runId });
    const comment = await issueService(input.db).addComment(issueId, resolved.text, { agentId, runId }, {
      authorizationReason, clientRequestId,
    }, tx);
    await tx.update(heartbeatRuns).set({ resultJson: { ...result, continuousReplies: { ...replies,
      [input.event.itemId!]: { questionCommentIds, commentId: comment.id, sourceEventId: input.event.sourceEventId },
    } } }).where(eq(heartbeatRuns.id, runId));
    await logActivity(tx, { companyId, actorType: "agent", actorId: agentId, agentId, runId, issueId,
      action: "issue.comment_added", entityType: "issue", entityId: issueId,
      details: { commentId: comment.id, bodySnippet: comment.body.slice(0, 120), identifier: issue.identifier,
        issueTitle: issue.title, authorizationReason, source: "run_presentation_resolver",
        presentationSource: resolved.decision.chosenSource, sourceEventId: finalAgentMessage.sourceEventId } });
  });
}
