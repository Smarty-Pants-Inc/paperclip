import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueComments, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { claimedAdapterType } from "./conversation-continuation.js";
import { executionStartedEventPredicate } from "./pre-dispatch-execution-evidence.js";
import { readFirstTurnQueuedInputReceipt } from "./native-runtime/first-turn-queued-input.js";
import { queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload } from "../lib/queued-comment-context.js";
import { logger } from "../middleware/logger.js";
import { notifyDeferredWakesForIssue } from "./deferred-execution-notifications.js";
import { deliveredQueuedCommentIds } from "./queued-comment-delivery.js";

const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
type Run = typeof heartbeatRuns.$inferSelect;
export type PersonStop = { pressedAt: string; userId: string | null };

/** Shared with first-turn admission: issue -> run -> wake input, never run -> issue.
 * Issue serialization must permit event persistence's FK KEY SHARE; no issue key changes. */
export async function settleStartupStop(db: Db, existing: Run, stop: PersonStop) {
  const { pressedAt } = stop, runId = existing.id;
  return db.transaction(async tx => {
    const issueId = existing.nativeIssueId ?? existing.issueId ?? asRecord(existing.contextSnapshot)?.issueId;
    if (typeof issueId === "string") await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, existing.companyId))).for("no key update");
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
    if (!current || current.status === "queued") return null;
    const terminal = ["failed", "cancelled", "timed_out", "interrupted", "succeeded"].includes(current.status);
    // A running native Pi process/session is not delivery of its first input.
    // Keep generic and terminal absence-of-work safeguards unchanged.
    const nativePi = !terminal && current.status === "running" && current.runtimeMode === "native" &&
      asRecord(asRecord(asRecord(current.runnerProfileJson)?.nativeExecutionInput)?.provider)?.kind === "pi_rpc";
    if ((!nativePi && (current.processPid || current.processGroupId || current.processStartedAt ||
        asRecord(asRecord(current.usageJson)?.budgetDispatch)?.handedOffAt)) || readFirstTurnQueuedInputReceipt(current) ||
        Object.keys(asRecord(current.resultJson?.queuedSteeringAcknowledgements) ?? {}).length) return null;
    const stillPreparing = current.runtimeMode === "legacy" && !current.runtimeModeResolvedAt &&
      current.executionStage === "preparing" && claimedAdapterType(current) === "paperclip_runner" &&
      asRecord(current.runnerProfileJson)?.nativeExecutionInput == null;
    if (!terminal && current.status !== "running") return null;
    const [started] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, runId), nativePi ? sql`${heartbeatRunEvents.eventType} like 'turn.%'` :
        or(executionStartedEventPredicate(), inArray(heartbeatRunEvents.eventType,
          ["turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"])))).limit(1);
    const [finalization] = await tx.select({ resultId: nativeRunFinalizations.resultId })
      .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)).limit(1);
    // Durable dispatch/turn evidence owns this decision. Never call session
    // capabilities/snapshot (provider I/O) with issue/run ownership locked.
    if (current.resultJson?.firstTurnDispatchCommitted || started || finalization?.resultId) return null;
    const returned = await returnWakeComments(tx as unknown as Db, current, stop, true);
    if (terminal && !returned && !current.resultJson?.personStop) return null;
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
      startupCancellation: { requestedAt: pressedAt, beforeNativeSelection: stillPreparing },
      cancelledByActorType: "user", cancelledByUserId: stop.userId,
    })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    const [settled] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return settled;
  });
}

/** A provider's clear_queue receipt cannot move the person's click cutoff. */
export async function settleProviderReturnedStopInput(db: Db, run: Run, returnedIds: string[]) {
  const issueId = run.nativeIssueId ?? run.issueId ?? asRecord(run.contextSnapshot)?.issueId;
  if (typeof issueId !== "string") return;
  await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId))).for("no key update");
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId))).for("update");
    const stop = asRecord(current?.resultJson?.personStop);
    if (!current || typeof stop?.requestedAt !== "string") return;
    const ids = [...new Set(returnedIds.filter(isUuidLike))];
    const comments = ids.length ? await tx.select({ id: issueComments.id, authorUserId: issueComments.authorUserId,
      beforePress: sql<boolean>`${issueComments.createdAt} <= ${stop.requestedAt}::timestamptz` }).from(issueComments).where(and(inArray(issueComments.id, ids),
      eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), eq(issueComments.authorType, "user"),
      isNull(issueComments.deletedAt))) : [];
    const mine = comments.filter(comment => comment.beforePress && comment.authorUserId === stop.userId).map(comment => comment.id);
    // The issue lock serializes admission and replay. Lock only this issue's
    // wakes, once, in id order; never sweep an agent's other issues under it.
    const wakes = comments.some(comment => !comment.beforePress) ? await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    )).orderBy(asc(agentWakeupRequests.id)).for("update") : [];
    const delivered = await deliveredQueuedCommentIds(tx, { companyId: run.companyId, issueId, agentId: run.agentId,
      commentIds: comments.filter(comment => !comment.beforePress).map(comment => comment.id) });
    const readmitted = { ...(asRecord(current.resultJson?.personStopReadmitted) ?? {}) };
    for (const comment of comments.filter(comment => !comment.beforePress)) {
      if (delivered.has(comment.id)) continue;
      const queued = wakes.find(wake => (wake.id === readmitted[comment.id] || queuedCommentIdsFromWakePayload(wake.payload).includes(comment.id))
        && (wake.runId ? wake.runId !== run.id : ["queued", "deferred_issue_execution"].includes(wake.status)));
      if (queued) { readmitted[comment.id] = queued.id; continue; }
      // A marker is custody, not proof of an answer: a cancelled/skipped/failed
      // unbound wake can be replaced. A wake bound to another run is never
      // re-admitted, including while its provider receipt is still in flight.
      const payload = withQueuedCommentIdsInWakePayload({ issueId, _paperclipWakeContext: {
        issueId, wakeReason: "issue_commented", wakeCommentId: comment.id, forceFreshSession: false,
      } }, [comment.id]);
      const [wake] = await tx.insert(agentWakeupRequests).values({ companyId: run.companyId, agentId: run.agentId,
        source: "issue", triggerDetail: "comment", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: comment.authorUserId, payload,
        idempotencyKey: `person-stop-postpress:${run.id}:${comment.id}` }).returning({ id: agentWakeupRequests.id });
      readmitted[comment.id] = wake.id;
    }
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
      jsonb_build_object('personStopReadmitted', ${JSON.stringify(readmitted)}::jsonb, 'personStop',
        (${heartbeatRuns.resultJson}->'personStop') || jsonb_build_object('returned',
          (select coalesce(jsonb_agg(distinct id), '[]'::jsonb) from jsonb_array_elements(
            coalesce(${heartbeatRuns.resultJson}#>'{personStop,returned}', '[]'::jsonb) || ${JSON.stringify(mine)}::jsonb) as ids(id))))` })
      .where(eq(heartbeatRuns.id, run.id));
    if (Object.keys(readmitted).length) await notifyDeferredWakesForIssue(tx, { companyId: run.companyId, issueId });
  });
}

export async function returnWakeComments(target: Db, run: Run, { pressedAt, userId }: PersonStop, settleWakeInput = false) {
  if (!userId) return;
  const runId = run.id, context = asRecord(run.contextSnapshot), issueId = run.nativeIssueId ?? run.issueId ?? context?.issueId;
  const contextIds = (value: unknown) => { const object = asRecord(value);
    return [...new Set([...(Array.isArray(object?.wakeCommentIds) ? object.wakeCommentIds : []), object?.wakeCommentId, object?.commentId]
      .filter((id): id is string => typeof id === "string" && isUuidLike(id)))]; };
  const wakeIds = (payload: unknown) => [...new Set([...queuedCommentIdsFromWakePayload(payload),
    ...contextIds(asRecord(payload)?._paperclipWakeContext), ...contextIds(payload)])];
  const wakes = settleWakeInput ? await target.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    or(eq(agentWakeupRequests.runId, run.id), ...(run.wakeupRequestId ? [eq(agentWakeupRequests.id, run.wakeupRequestId)] : []),
      and(isNull(agentWakeupRequests.runId), inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${typeof issueId === "string" ? issueId : null}`)),
  )).orderBy(asc(agentWakeupRequests.id)).for("update") : [];
  const received = Object.keys(asRecord(run.resultJson?.queuedSteeringAcknowledgements) ?? {})
    .concat(readFirstTurnQueuedInputReceipt(run)?.commentIds ?? []);
  const ids = [...new Set([...contextIds(context), ...wakes.flatMap(wake => wakeIds(wake.payload))])].filter(id => !received.includes(id));
  const mine = ids.length ? (await target.select({ id: issueComments.id }).from(issueComments).where(and(
    inArray(issueComments.id, ids), eq(issueComments.companyId, run.companyId),
    ...(typeof issueId === "string" ? [eq(issueComments.issueId, issueId)] : []), eq(issueComments.authorUserId, userId),
    isNull(issueComments.deletedAt), sql`${issueComments.createdAt} <= coalesce(
      (select result_json#>>'{personStop,requestedAt}' from ${heartbeatRuns} where id = ${runId}), ${pressedAt})::timestamptz`))).map(row => row.id) : [];
  for (const wake of wakes) {
    const original = wakeIds(wake.payload);
    if (!original.some(id => mine.includes(id))) continue;
    const left = original.filter(id => !mine.includes(id)), now = new Date();
    await target.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(wake.payload, left),
      ...(left.length ? {} : { status: "cancelled", finishedAt: now }), updatedAt: now }).where(eq(agentWakeupRequests.id, wake.id));
  }
  if (mine.length || run.status === "running" || (settleWakeInput && run.resultJson?.personStop)) await target.update(heartbeatRuns).set({ resultJson:
    sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object('personStop',
      ${JSON.stringify({ requestedAt: pressedAt, userId })}::jsonb || coalesce(${heartbeatRuns.resultJson}->'personStop', '{}'::jsonb) ||
      jsonb_build_object('returned', (select coalesce(jsonb_agg(distinct id), '[]'::jsonb) from jsonb_array_elements(
        coalesce(${heartbeatRuns.resultJson}->'personStop'->'returned', '[]'::jsonb) || ${JSON.stringify(mine)}::jsonb) as ids(id))))` })
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, run.status))).returning({ id: heartbeatRuns.id }).then(rows => {
      if (!rows.length) logger.info({ runId }, "Run changed while returning stopped input; returning current Stop state");
    });
  return mine.length;
}
