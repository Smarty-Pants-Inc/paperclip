import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunResults, runIdentityContexts, type Db } from "@paperclipai/db";
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
import { rejectSteeredIdentity, storedSteeringAcknowledgement } from "../run-identity.js";
import { returnWakeComments } from "../person-stop-before-turn.js";

/** Replay only notices persisted by this run's bound runner, including after a crash between event and observer. */
export async function settleClaimReturnedInput(db: Db, scope: { id: string; companyId: string }) {
  const notices = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, heartbeatRunEvents.runId), eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId)))
    .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId),
      eq(heartbeatRunEvents.eventType, "provider.notice.recorded"), sql`${heartbeatRunEvents.sourceEventId} is not null`,
      sql`${heartbeatRunEvents.sourceInstanceId} = ${heartbeatRuns.runnerInstanceId}::text`,
      sql`${heartbeatRunEvents.payload} #>> '{prpEvent,sourceKind}' = 'runner'`,
      sql`${heartbeatRunEvents.payload} #>> '{prpEvent,normalizedSessionId}' = ${heartbeatRuns.nativeSessionId}::text`,
      sql`${heartbeatRunEvents.payload} #>> '{prpEvent,payload,category}' = 'pi_claim_returned_input'`));
  for (const notice of notices) {
    const details = parseObject(parseObject(notice.payload?.prpEvent).payload).details;
    const ids = (Array.isArray(details) ? details : []).filter(detail => parseObject(detail).name === "returnedCommentIds")
      .flatMap(detail => String(parseObject(detail).value ?? "").split(",")).map(id => id.trim()).filter(isUuidLike);
    if (ids.length) await requeueContinuousUnanswered(db, scope, ids);
  }
}

/** Hand unanswered delivery receipts back to the ordinary deferred queue before release. */
export async function requeueContinuousUnanswered(db: Db, scope: { id: string; companyId: string }, claimReturnedIds?: string[]) {
  const claimReturn = claimReturnedIds !== undefined;
  if (!claimReturn) {
    await settleClaimReturnedInput(db, scope);
    await recoverContinuousNativeReplies(db, scope);
  }
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
    if (!issue || !row || (!claimReturn && !["failed", "cancelled", "timed_out", "interrupted"].includes(row.run.status)) ||
        (claimReturn ? row.run.runtimeMode !== "native" : row.config.provider !== "pi_rpc")) return;
    const result = parseObject(row.run.resultJson);
    const returnedReceipts = { ...parseObject(result.claimReturnedInput) };
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
    if (!claimReturn && !preDispatch && (row.run.runtimeMode !== "native" ||
        resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous")) return;
    if ((preDispatch || claimReturn) && (issue.assigneeAgentId !== row.run.agentId || (!claimReturn && ["done", "cancelled"].includes(issue.status)) ||
      issue.conversationAgentId && (issue.conversationAgentId !== row.run.agentId ||
        contextSnapshot.conversationSessionGeneration !== issue.conversationSessionGeneration))) return;
    // Nothing self-starts after a person's Stop (0260): whatever was not taken went back to their input box.
    if (!claimReturn && (result.continuousUnansweredWakeId || parseObject(result.personStop).requestedAt !== undefined)) return;
    const outputWithoutResult = !claimReturn && !preDispatch && row.run.errorCode === "native_provider_output_without_result";
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
    if (claimReturn) {
      ids = [];
      for (const id of new Set(claimReturnedIds)) {
        if (returnedReceipts[id] || !isUuidLike(id)) continue;
        if (parseObject(parseObject(result.queuedSteeringAcknowledgements)[id]).status === "acknowledged" ||
            await storedSteeringAcknowledgement(tx, { companyId: scope.companyId, runId: scope.id, messageId: id })) ids.push(id);
      }
    }
    if (preDispatch || claimReturn) {
      const [wake] = row.run.wakeupRequestId ? await tx.select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, scope.companyId),
          eq(agentWakeupRequests.id, row.run.wakeupRequestId))) : [];
      ids = claimReturn ? ids : [...new Set([...queuedCommentIdsFromRunContext(contextSnapshot), contextSnapshot.wakeCommentId,
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
      const pending = await tx.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, row.run.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`));
      for (const wake of pending) for (const id of queuedCommentIdsFromWakePayload(wake.payload)) owned.add(id);
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
      ids = comments.map(comment => comment.id);
      if (claimReturn && ids.length) {
        // Invalidate only this run's queue acceptance before asking any delivery
        // reader. A later run's genuine receipt must still win over replay.
        const acknowledgements = { ...parseObject(result.queuedSteeringAcknowledgements) };
        for (const id of ids) { returnedReceipts[id] = { ...parseObject(acknowledgements[id]) }; delete acknowledgements[id]; }
        result.queuedSteeringAcknowledgements = acknowledgements;
        result.claimReturnedInput = returnedReceipts;
        for (const wake of pending) if (queuedCommentIdsFromWakePayload(wake.payload).some(id => ids.includes(id)))
          await tx.update(agentWakeupRequests).set({ payload: { ...wake.payload, claimReturnedSourceRunId: scope.id } })
            .where(eq(agentWakeupRequests.id, wake.id));
        const continued = parseObject(result.continuedSessionInput);
        if (Array.isArray(continued.commentIds)) result.continuedSessionInput = { ...continued,
          commentIds: continued.commentIds.filter(id => !ids.includes(id)) };
        result.continuousReplies = Object.fromEntries(Object.entries(parseObject(result.continuousReplies)).map(([key, value]) => {
          const reply = parseObject(value);
          return [key, { ...reply, questionCommentIds: Array.isArray(reply.questionCommentIds)
            ? reply.questionCommentIds.filter(id => !ids.includes(id)) : [] }];
        }));
        const identities = await tx.select().from(runIdentityContexts).where(and(
          eq(runIdentityContexts.companyId, scope.companyId), eq(runIdentityContexts.runId, scope.id),
          eq(runIdentityContexts.cause, "steering"), inArray(runIdentityContexts.messageId, ids)));
        for (const identity of identities) await rejectSteeredIdentity(tx as unknown as Db, identity, { returnedInput: true });
        await tx.update(heartbeatRuns).set({ resultJson: result }).where(eq(heartbeatRuns.id, scope.id));
      }
      const delivered = await deliveredQueuedCommentIds(tx, { companyId: scope.companyId, issueId: issue.id,
        agentId: row.run.agentId, commentIds: ids });
      ids = ids.filter(id => !owned.has(id) && !delivered.has(id));
    }
    if (!ids.length) {
      const stop = parseObject(result.personStop);
      if (claimReturn && typeof stop.requestedAt === "string") await returnWakeComments(tx as unknown as Db,
        { ...row.run, resultJson: result }, { pressedAt: stop.requestedAt, userId: typeof stop.userId === "string" ? stop.userId : null }, true);
      return;
    }
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
        ...(preDispatch ? { preDispatchInputOnly: true, preDispatchSourceRunId: scope.id } : {}),
        ...(claimReturn ? { claimReturnedSourceRunId: scope.id } : {}) }, ids),
      requestedByActorType: row.run.responsibleUserId ? "user" : "system", requestedByActorId: row.run.responsibleUserId,
      idempotencyKey: claimReturn ? `claim-returned:${scope.id}:${createHash("sha256").update(ids.slice().sort().join(",")).digest("hex")}` : `continuous-unanswered:${scope.id}` }).returning({ id: agentWakeupRequests.id });
    if (outputWithoutResult) {
      // Use the existing system-notice path rather than silently dropping ACKed
      // messages or misreporting a person's Stop. Same transaction/idempotency
      // fence as the receipt: one unanswered notice per follow-up, not an answer.
      for (const id of ids) await issueService(tx as unknown as Db).addComment(issue.id,
        `Your follow-up remains unanswered (message ${id}). Automatic retries are stopped; nothing was re-sent. You can send the follow-up again when you choose.`,
        {}, { authorType: "system", clientRequestId: `native-unanswered:${scope.id}:${id}`,
          presentation: { kind: "system_notice", tone: "danger", detailsDefaultOpen: false } }, tx);
    }
    if (claimReturn) {
      for (const id of ids) returnedReceipts[id] = { ...parseObject(returnedReceipts[id]), wakeId: wake.id };
      result.claimReturnedInput = returnedReceipts;
    } else result.continuousUnansweredWakeId = wake.id;
    await tx.update(heartbeatRuns).set({ resultJson: result }).where(eq(heartbeatRuns.id, scope.id));
    const stop = parseObject(result.personStop);
    if (claimReturn && typeof stop.requestedAt === "string") await returnWakeComments(tx as unknown as Db,
      { ...row.run, resultJson: result }, { pressedAt: stop.requestedAt, userId: typeof stop.userId === "string" ? stop.userId : null }, true);
  });
}
