import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues, nativeRunResults, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { isUuidLike } from "@paperclipai/shared";
import { queuedCommentIdsFromRunContext, queuedCommentIdsFromWakePayload, withQueuedCommentIdsInRunContext, withQueuedCommentIdsInWakePayload } from "../issue-queued-comment-queue.js";
import { hasNativeExecutionStartEvidence } from "./native-restart-recovery.js";
import { readFirstTurnQueuedInputReceipt } from "./first-turn-queued-input.js";
import { currentConversationCommentCondition } from "../agent-conversations.js";
import { deliveredQueuedCommentIds } from "../queued-comment-delivery.js";
import { hasNativePreDispatchFailureRecord } from "../heartbeat/run-failure-cause.js";
import { resolveSessionContinuity } from "./continued-session.js";
import { recoverContinuousNativeReplies } from "./native-continuous-reply.js";
import { issueService } from "../issues.js";

/** Hand unanswered delivery receipts back to the ordinary deferred queue before release. */
export async function requeueContinuousUnanswered(db: Db, scope: { id: string; companyId: string }) {
  await recoverContinuousNativeReplies(db, scope);
  const [source] = await db.select({ issueId: sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}::text,
    ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId)));
  if (!source?.issueId) return;
  await db.transaction(async tx => {
    // Serialize issue ownership without blocking a run event writer's FK KEY SHARE.
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, source.issueId!),
      eq(issues.companyId, scope.companyId))).for("no key update");
    const [row] = await tx.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId)))
      .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId)))
      .for("update", { of: heartbeatRuns });
    if (!issue || !row || !["failed", "cancelled", "timed_out", "interrupted"].includes(row.run.status) ||
        row.config.provider !== "pi_rpc") return;
    const result = parseObject(row.run.resultJson);
    const contextSnapshot = parseObject(row.run.contextSnapshot);
    // Bootstrap failure is unconsumed input, not a failed delivery. Keep the
    // stock execution-evidence fence: a setup error label alone proves nothing.
    const recovery = parseObject(result.executionRecovery);
    const inheritedProcess = typeof row.run.runnerProfileJson?.inheritedProcessIdentityRunId === "string";
    const preDispatch = row.run.status === "failed" && recovery.providerWorkStarted !== true &&
      (recovery.providerWorkStarted === false || hasNativePreDispatchFailureRecord(result)) &&
      !row.run.sessionIdAfter && (inheritedProcess || !row.run.processPid && !row.run.processGroupId && !row.run.processStartedAt) &&
      !(await hasNativeExecutionStartEvidence(tx, row.run)) &&
      !(await tx.select({ id: nativeRunResults.id }).from(nativeRunResults).where(and(
        eq(nativeRunResults.companyId, scope.companyId), eq(nativeRunResults.runId, scope.id))).limit(1)).length;
    // Post-provider failures keep their existing continuous steering contract.
    if (!preDispatch && (row.run.runtimeMode !== "native" ||
        resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous")) return;
    if (preDispatch && (issue.assigneeAgentId !== row.run.agentId || ["done", "cancelled"].includes(issue.status) ||
      issue.conversationAgentId && (issue.conversationAgentId !== row.run.agentId ||
        contextSnapshot.conversationSessionGeneration !== issue.conversationSessionGeneration))) return;
    // Nothing self-starts after a person's Stop (0260): whatever was not taken went back to their input box.
    if (result.continuousUnansweredWakeId || parseObject(result.personStop).requestedAt !== undefined) return;
    const outputWithoutResult = !preDispatch && row.run.errorCode === "native_provider_output_without_result";
    const answered = new Set(Object.values(parseObject(result.continuousReplies)).flatMap(value => {
      const ids = parseObject(value).questionCommentIds;
      return Array.isArray(ids) ? ids : [];
    }));
    // A comment a person's Stop handed back to the input box is the person's to send again, never the next run's.
    const returned = parseObject(result.personStop).returned;
    if (Array.isArray(returned)) for (const id of returned) answered.add(id);
    const inherited = parseObject(result.continuedSessionInput);
    const inheritedIds = inherited.runId === row.run.id && inherited.sessionId === row.run.nativeSessionId && Array.isArray(inherited.commentIds)
      ? inherited.commentIds.filter((id): id is string => typeof id === "string") : [];
    let ids = [...new Set([
      ...Object.entries(parseObject(result.queuedSteeringAcknowledgements))
        .filter(([, receipt]) => parseObject(receipt).status === "acknowledged")
        .sort((a, b) => String(parseObject(a[1]).acknowledgedAt).localeCompare(String(parseObject(b[1]).acknowledgedAt)))
        .map(([id]) => id),
      ...inheritedIds,
    ])].filter(id => !answered.has(id));
    if (preDispatch) {
      const [wake] = row.run.wakeupRequestId ? await tx.select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, scope.companyId),
          eq(agentWakeupRequests.id, row.run.wakeupRequestId))) : [];
      ids = [...new Set([...queuedCommentIdsFromRunContext(contextSnapshot), contextSnapshot.wakeCommentId,
        ...queuedCommentIdsFromWakePayload(wake?.payload), wake?.payload?.commentId,
        parseObject(wake?.payload?._paperclipWakeContext).wakeCommentId,
        ...(readFirstTurnQueuedInputReceipt(row.run)?.commentIds ?? []), ...ids])]
        .filter((id): id is string => typeof id === "string" && isUuidLike(id) && !answered.has(id));
      // A successor already admitted under this issue lock owns its input. A
      // prior handback or ordinary deferred wake also keeps its exact receipt.
      const owners = await tx.select({ context: heartbeatRuns.contextSnapshot, result: heartbeatRuns.resultJson }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, row.run.agentId),
          ne(heartbeatRuns.id, scope.id), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
          sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text,
            ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issue.id}`));
      const owned = new Set(owners.flatMap(owner => [
        ...queuedCommentIdsFromRunContext(owner.context),
        ...(typeof owner.context?.wakeCommentId === "string" ? [owner.context.wakeCommentId] : []),
        ...(Array.isArray(parseObject(parseObject(owner.context).firstTurnQueuedInput).commentIds)
          ? parseObject(parseObject(owner.context).firstTurnQueuedInput).commentIds as string[] : []),
        ...Object.keys(parseObject(parseObject(owner.result).queuedSteeringAcknowledgements)),
      ]));
      const pending = await tx.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, row.run.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`));
      for (const wake of pending) for (const id of queuedCommentIdsFromWakePayload(wake.payload)) owned.add(id);
      const delivered = await deliveredQueuedCommentIds(tx, { companyId: scope.companyId, issueId: issue.id,
        agentId: row.run.agentId, commentIds: ids });
      // Messages, not the system retry's requester, carry the person's authority.
      // Re-read authors/generation/boundary and chronology, never arbitrary IDs
      // copied into a run context. Stop-returned inputs were removed above.
      const person = issue.conversationUserId ?? row.run.responsibleUserId;
      const comments = ids.length && person ? await tx.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, scope.companyId), eq(issueComments.issueId, issue.id), inArray(issueComments.id, ids),
        eq(issueComments.authorUserId, person), eq(issueComments.authorType, "user"), isNull(issueComments.authorAgentId),
        isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt), isNull(issueComments.conversationSessionGeneration),
        sql`btrim(${issueComments.body}) <> '/new'`, currentConversationCommentCondition(),
      )).orderBy(asc(issueComments.createdAt), asc(issueComments.id)) : [];
      ids = comments.map(comment => comment.id).filter(id => !owned.has(id) && !delivered.has(id));
    }
    if (!ids.length) return;
    const context = withQueuedCommentIdsInRunContext({ issueId: issue.id, source: "issue.comment",
      wakeReason: "issue_commented", forceFreshSession: false,
      ...(issue.conversationAgentId ? { conversationSessionGeneration: issue.conversationSessionGeneration } : {}),
    }, ids);
    const [wake] = await tx.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: row.run.agentId,
      source: "issue", triggerDetail: "comment", reason: "issue_commented",
      // Retain exact per-message delivery identities for explicit user retry,
      // but never make these follow-ups dispatchable.
      status: outputWithoutResult ? "failed" : "deferred_issue_execution",
      ...(outputWithoutResult ? { finishedAt: new Date(), error: "native_provider_output_without_result" } : {}),
      // This is a pending input receipt, not another automatic start. Only the
      // existing bounded retry scheduler (or the person's next message/Retry)
      // may start a successor; its first turn claims these saved inputs.
      payload: withQueuedCommentIdsInWakePayload({ issueId: issue.id, _paperclipWakeContext: context,
        ...(preDispatch ? { preDispatchInputOnly: true, preDispatchSourceRunId: scope.id } : {}) }, ids),
      requestedByActorType: row.run.responsibleUserId ? "user" : "system", requestedByActorId: row.run.responsibleUserId,
      idempotencyKey: `continuous-unanswered:${scope.id}` }).returning({ id: agentWakeupRequests.id });
    if (outputWithoutResult) {
      // Use the existing system-notice path rather than silently dropping ACKed
      // messages or misreporting a person's Stop. Same transaction/idempotency
      // fence as the receipt: one unanswered notice per follow-up, not an answer.
      for (const id of ids) await issueService(tx as unknown as Db).addComment(issue.id,
        `Your follow-up remains unanswered (message ${id}). Automatic retries are stopped; nothing was re-sent. You can send the follow-up again when you choose.`,
        {}, { authorType: "system", clientRequestId: `native-unanswered:${scope.id}:${id}`,
          presentation: { kind: "system_notice", tone: "danger", detailsDefaultOpen: false } }, tx);
    }
    await tx.update(heartbeatRuns).set({ resultJson: { ...result, continuousUnansweredWakeId: wake.id } })
      .where(eq(heartbeatRuns.id, scope.id));
  });
}
