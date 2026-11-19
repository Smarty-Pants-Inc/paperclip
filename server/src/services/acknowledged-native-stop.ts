import { and, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, environmentLeases, heartbeatRunEvents, heartbeatRuns, issueComments, issueTreeHolds, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { resolveProviderApiPlacement } from "./native-runtime/provider-api-placement.js";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRecoveredCleanupStopReceipt, hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { validatePrpEvent } from "../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { isConfirmedCursorCloudTerminalObservation } from "./native-runtime/cursor-cloud-runtime.js";
import { isAgentLifecycleStopRecord } from "./governance-pause-stop.js";
import { queuedCommentIdsFromWakePayload } from "./issue-queued-comment-queue.js";
import { isWellFormedExecutionWait, wellFormedExecutionWaitSql } from "./deferred-execution-wait.js";
import { stopAcceptanceEventSql } from "./heartbeat-run-events.js";
import { QUEUED_SEND_AFTER_STOP_KEY, recordedUserStop } from "./run-cancellation.js";

export function hasAcknowledgedNativeRunStopRequest(run: {
  id: string; companyId: string; status: string; nativeIssueId: string | null;
  resultJson: Record<string, unknown> | null;
}): boolean {
  const result = run.resultJson;
  const intent = result?.nativeCancellation as Record<string, unknown> | undefined;
  return intent?.schema === "paperclip.native-cancellation.v1" && intent.runId === run.id &&
    intent.companyId === run.companyId && intent.issueId === run.nativeIssueId &&
    intent.scope === "run" && intent.reasonCode === "cancellation_run_only" &&
    intent.dispatchState === "acknowledged" && typeof intent.dispatched === "boolean" &&
    typeof intent.intentAuditId === "string" && Boolean(intent.intentAuditId) &&
    typeof intent.acknowledgementAuditId === "string" && Boolean(intent.acknowledgementAuditId);
}

export function hasAcknowledgedNativeRunStopReceipt(run: Parameters<typeof hasAcknowledgedNativeRunStopRequest>[0]): boolean {
  return hasAcknowledgedNativeRunStopRequest(run) &&
    (run.resultJson?.nativeCancellation as Record<string, unknown>).dispatched === true;
}

export function hasAcknowledgedNativeStopIntent(run: Parameters<typeof hasAcknowledgedNativeRunStopReceipt>[0]): boolean {
  return run.resultJson?.cancelledByActorType === "user" &&
    typeof run.resultJson.cancelledByUserId === "string" && Boolean(run.resultJson.cancelledByUserId) &&
    hasAcknowledgedNativeRunStopReceipt(run);
}

export function hasRecordedUserStopRequest(run: { resultJson: Record<string, unknown> | null }): boolean {
  const result = run.resultJson;
  if (result?.cancelledByActorType !== "user" || typeof result.cancelledByUserId !== "string" || !result.cancelledByUserId) return false;
  const state = parseObject(result.executionCancellation).state;
  const startup = result.startupCancellation;
  return state === "requested" || state === "acknowledged" ||
    (Boolean(startup) && typeof startup === "object" && !Array.isArray(startup));
}

export function recordedUserStopRequestSql() {
  const result = heartbeatRuns.resultJson;
  return sql`(coalesce(${result}->>'cancelledByActorType', '') = 'user'
    and coalesce(${result}->>'cancelledByUserId', '') <> ''
    and (coalesce(${result}->'executionCancellation'->>'state', '') in ('requested', 'acknowledged')
      or jsonb_typeof(${result}->'startupCancellation') = 'object'))`;
}

export function hasAcknowledgedNativeLifecycleStopIntent(run: Parameters<typeof hasAcknowledgedNativeRunStopReceipt>[0]): boolean {
  return isAgentLifecycleStopRecord(run.resultJson) && hasAcknowledgedNativeRunStopReceipt(run);
}

/** An intentional handoff retains task state and deferred work for its successor. */
export function hasAcknowledgedNativeReassignmentStopIntent(run: Parameters<typeof hasAcknowledgedNativeRunStopReceipt>[0]): boolean {
  return run.resultJson?.reassignmentStopRequested === true && hasAcknowledgedNativeRunStopReceipt(run);
}

export function isAcknowledgedNativeReassignmentStop(run: Parameters<typeof hasAcknowledgedNativeRunStopReceipt>[0]): boolean {
  return run.status === "cancelled" && hasAcknowledgedNativeReassignmentStopIntent(run);
}

export function isAcknowledgedNativeStop(run: Parameters<typeof hasAcknowledgedNativeStopIntent>[0]): boolean {
  return run.status === "cancelled" && hasAcknowledgedNativeStopIntent(run);
}

/** API-owned execution has no Computer lease. Its provider terminal and retired
 * local controller must both be recorded before publishing shared Stop proof. */
export async function acknowledgedNativeApiStopExecutionHasStopped(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId" | "status" | "resultJson" | "processPid" | "processGroupId" |
  "runtimeMode" | "driverKind" | "runnerProfileJson" | "nativeSessionId" | "runnerInstanceId">): Promise<boolean> {
  if (run.runtimeMode !== "native" || run.driverKind !== "cursor_cloud_api" || !isAcknowledgedNativeStop(run) ||
      run.processPid !== null || run.processGroupId !== null || !run.nativeIssueId || !run.nativeSessionId || !run.runnerInstanceId) return false;
  const intent = parseObject(run.resultJson?.nativeCancellation);
  const requestedAt = typeof intent.recordedAt === "string" ? Date.parse(intent.recordedAt) : NaN;
  if (!Number.isFinite(requestedAt) || !Array.isArray(intent.effects) || intent.effects.length !== 1 ||
      intent.effects[0] !== "release_run_resources" ||
      !String(intent.intentAuditId ?? "").trim() || !String(intent.acknowledgementAuditId ?? "").trim()) return false;
  const profile = parseObject(run.runnerProfileJson);
  const execution = parseObject(profile.nativeExecutionInput);
  const binding = parseObject(execution.binding), session = parseObject(execution.session);
  if (profile.executionPlacement === undefined || profile.backend !== "cursor_cloud_api" ||
      binding.companyId !== run.companyId || binding.runId !== run.id || binding.issueId !== run.nativeIssueId ||
      binding.agentId !== run.agentId || session.normalizedSessionId !== run.nativeSessionId || session.driverKind !== "cursor_cloud_api") return false;
  try {
    if (!resolveProviderApiPlacement({ run, agent: { adapterType: "process", adapterConfig: {} } })) return false;
  } catch { return false; }
  const [lease] = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  )).limit(1);
  if (lease || !await hasNativeLocalProcessStop(db, run.companyId, run.id)) return false;
  const [terminal] = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    isNotNull(heartbeatRunEvents.sourceEventId),
    inArray(heartbeatRunEvents.eventType, ["turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const validated = validatePrpEvent(parseObject(terminal?.payload).prpEvent);
  if (!terminal || !validated.ok || terminal.sourcePayloadSha256 !== nativeSha256(validated.event)) return false;
  const event = validated.event;
  return isConfirmedCursorCloudTerminalObservation({ eventType: terminal.eventType, payload: event.payload }) && terminal.agentId === run.agentId &&
    event.schema === "paperclip.prp.event.v1" && [1, 2].includes(Number(event.schemaVersion)) &&
    terminal.protocolSchemaVersion === event.schemaVersion && event.eventType === terminal.eventType &&
    event.sourceKind === "runner" && event.runId === run.id && event.normalizedSessionId === run.nativeSessionId &&
    event.sourceInstanceId === run.runnerInstanceId && terminal.sourceInstanceId === event.sourceInstanceId &&
    terminal.sourceEventId === event.sourceEventId && terminal.sourceSeq === event.sourceSeq &&
    Number.isSafeInteger(event.sourceSeq) && Number(event.sourceSeq) > 0 &&
    typeof event.turnId === "string" && Boolean(event.turnId);
}

/** A Stop acknowledgement alone does not prove provider cleanup completed. */
export async function acknowledgedNativeStopExecutionHasStopped(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "nativeIssueId" | "status" | "resultJson" | "processPid" | "processGroupId">) {
  if (!isAcknowledgedNativeStop(run)) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  // Provider PIDs are meaningful only on their own host. A recovered sandbox
  // queued for destroy keeps its verified stop; the destroy is only cleanup.
  if (leases.some(lease => lease.provider !== "local"))
    return leases.every(lease => hasRemoteTerminationReceipt(lease) || hasRecoveredCleanupStopReceipt(lease));
  if (leases.some(lease => !lease.releasedAt || lease.cleanupStatus === "failed")) return false;
  if (!run.processPid && !run.processGroupId) return hasNativeLocalProcessStop(db, run.companyId, run.id);
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  return (!run.processPid || absent(run.processPid)) && (!run.processGroupId || absent(-run.processGroupId));
}

/** The cause and fingerprint run of the hold the wake queue's release writes for
 * a native run that ended before its Stop was acknowledged
 * (modules/wake-queue/adapters/postgres.ts recordNativeTerminalRecoveryIfNeeded:
 * cause native_continuation_requires_reconciliation, evidence.runId = the run). */
export const PERSON_STOP_OWN_HOLD_CAUSE = "native_continuation_requires_reconciliation";

/**
 * The ONE same-person fact of a person's Stop (RFL 06:56Z): a held message
 * belongs to the Stop only when its author is the Stop's person, and only that
 * same person's Send may move it. `personUserId` is a held message's author or
 * the Send-er; `stopUserId` is the person who stopped (cancelledByUserId /
 * the acceptance row's userId). Read by readPersonStopHold (a), the Stop merge
 * (wake-queue gatherPersonStoppedChatMessages) and isPersonAcceptedStartupStop.
 * Never re-derive this check elsewhere.
 */
export function isStoppingPersonsOwn(personUserId: string | null | undefined, stopUserId: string | null | undefined): boolean {
  return typeof stopUserId === "string" && stopUserId.length > 0 && personUserId === stopUserId;
}

export type PersonStopHold = {
  stoppedRunId: string; userId: string; acceptedAt: string; wakeIds: string[];
  /** Only with `reportEndedByTypedMessage`: the Stop's held wakes whose hold that
   * person's own typed message ended (state (b)); the message runs first and
   * these go right after it. Never a hold: callers that keep messages waiting
   * must not read it as one. */
  endedByTypedCommentId?: string;
};

function personStopWakeCarries(payload: unknown, issueId: string, messageId?: string): boolean {
  const value = parseObject(payload);
  const nested = parseObject(value._paperclipWakeContext);
  if (value.issueId !== issueId && nested.issueId !== issueId && value.taskId !== issueId) return false;
  const ids = [...queuedCommentIdsFromWakePayload(value), value.commentId, nested.wakeCommentId,
    ...(Array.isArray(nested.wakeCommentIds) ? nested.wakeCommentIds : [])]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return messageId ? ids.includes(messageId) : ids.length > 0;
}

export function personStopWakeCommentIds(payload: unknown): string[] {
  const value = parseObject(payload);
  const nested = parseObject(value._paperclipWakeContext);
  return [...new Set([...queuedCommentIdsFromWakePayload(value), value.commentId, nested.wakeCommentId,
    ...(Array.isArray(nested.wakeCommentIds) ? nested.wakeCommentIds : [])]
    .filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))];
}

/**
 * Stop means stop: the ONE reader of "these messages are held by a person's
 * Stop" (H2 section 3). Every promoter of a saved wake asks it, so none of
 * them can run a held message by itself. Held when ALL of these are true:
 * - no run is running on the issue;
 * - the latest Stop/Interrupt acceptance on this agent's turns on the issue is
 *   the Stop route's own server-owned row (`run.stop.accepted`, kind
 *   `person_stop`), and its run recorded that person's Stop (recordedUserStop).
 *   An Interrupt (kind `interrupt`), an agent's or the system's cancel, or no
 *   row at all is never a hold (NULL-safe: no row, no hold);
 * - that person has not typed a new message on the issue since the Stop (a
 *   typed message runs first; the held ones follow it);
 * - a deferred_issue_execution wake, or a deferred wake with a well-formed
 *   saved wait, carries the issue's messages (the given message, or wake, when
 *   named), WITH OR WITHOUT a saved wait, and has no queuedCommentInterrupt nor
 *   a Send-after-Stop receipt (a person's Send is delivering it);
 * - every live message it carries was written by THAT person at or before the
 *   Stop. Another person's message, or anything newer, is not held.
 * A saved wait (execution_active, execution_recovery, stopped_execution) does
 * not undo the Stop: nothing clears it after the Stop, so it is stale.
 * `admittingTypedCommentIds`: the typed message(s) being admitted right now do
 * not count as "typed since the Stop", so admission can ask, wake by wake,
 * whether a saved wake was held by the Stop up to this very message (it runs
 * first, alone; the held ones follow it).
 * `reportEndedByTypedMessage`: when that person's typed message has ended the
 * hold (state (b)), return the wakes it held anyway, with
 * `endedByTypedCommentId` set, even while a run (the typed message's) runs.
 * Only the queue line asks this: its held messages go right after that message.
 * (ported from al/c1-heldstop-sweep-c1d 61f43a23; keyed on S's acceptance row)
 */
export async function readPersonStopHold(db: Db, input: {
  companyId: string; issueId: string; agentId: string; messageId?: string; wakeId?: string;
  admittingTypedCommentIds?: string[]; reportEndedByTypedMessage?: boolean;
  /** The person's Send now delivering this exact held wake (it carries
   * queuedCommentInterrupt); only that wake is read through the Send. */
  sendingWakeId?: string;
}): Promise<PersonStopHold | null> {
  const onIssue = or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`);
  const isRunning = async () => (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), or(onIssue, eq(heartbeatRuns.issueId, input.issueId)),
    eq(heartbeatRuns.status, "running"))).limit(1)).length > 0;
  if (!input.reportEndedByTypedMessage && await isRunning()) return null;
  const [stop] = await db.select({ runId: heartbeatRuns.id, status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
    payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, heartbeatRunEvents.runId),
      eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId)))
    .where(and(eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), onIssue,
      stopAcceptanceEventSql()))
    .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id)).limit(1);
  const accepted = parseObject(stop?.payload);
  const userId = typeof accepted.userId === "string" && accepted.userId ? accepted.userId : null;
  const acceptedAt = typeof accepted.acceptedAt === "string" ? new Date(accepted.acceptedAt) : null;
  if (!stop || accepted.schema !== "paperclip.stop-acceptance.v1" || accepted.kind !== "person_stop" ||
      accepted.issueId !== input.issueId || !userId || !acceptedAt || !Number.isFinite(acceptedAt.getTime())) return null;
  const stopped = recordedUserStop(stop);
  if (!stopped || stopped.source !== "operator" || parseObject(stop.resultJson).cancelledByUserId !== userId ||
      parseObject(stop.resultJson).queuedCommentInterruptQueueId) return null;
  const [typedAfterStop] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "user"), eq(issueComments.authorUserId, userId), isNull(issueComments.createdByRunId),
    gt(issueComments.createdAt, acceptedAt),
    input.admittingTypedCommentIds?.length ? notInArray(issueComments.id, input.admittingTypedCommentIds) : undefined)).limit(1);
  if (typedAfterStop && !input.reportEndedByTypedMessage) return null;
  if (!typedAfterStop && input.reportEndedByTypedMessage && await isRunning()) return null;
  const wakes = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      input.wakeId ? eq(agentWakeupRequests.id, input.wakeId) : undefined,
      or(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        and(eq(agentWakeupRequests.status, "deferred"), wellFormedExecutionWaitSql(agentWakeupRequests.payload)))));
  const candidates = wakes.filter(wake => (!input.wakeId || wake.id === input.wakeId)
    && (wake.status === "deferred_issue_execution" || isWellFormedExecutionWait(parseObject(wake.payload).executionWait))
    && (wake.id === input.sendingWakeId || (parseObject(wake.payload).queuedCommentInterrupt == null
      && parseObject(wake.payload)[QUEUED_SEND_AFTER_STOP_KEY] == null))
    && personStopWakeCarries(wake.payload, input.issueId, input.messageId));
  const ids = [...new Set(candidates.flatMap(wake => personStopWakeCommentIds(wake.payload)))];
  const comments = ids.length ? await db.select({ id: issueComments.id, authorUserId: issueComments.authorUserId,
    createdAt: issueComments.createdAt }).from(issueComments).where(and(eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId), inArray(issueComments.id, ids), isNull(issueComments.deletedAt))) : [];
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const held = candidates.filter(wake => {
    const live = personStopWakeCommentIds(wake.payload).map(id => byId.get(id)).filter(comment => comment !== undefined);
    return live.length > 0 && live.every(comment => isStoppingPersonsOwn(comment.authorUserId, userId) && comment.createdAt <= acceptedAt);
  });
  return held.length ? { stoppedRunId: stop.runId, userId, acceptedAt: acceptedAt.toISOString(), wakeIds: held.map(wake => wake.id),
    ...(typedAfterStop ? { endedByTypedCommentId: typedAfterStop.id } : {}) } : null;
}

/** The run-control cancel reason of a board user's task-tree Pause
 * (routes/issue-tree-control.ts, heartbeat.cancelRun for each active run). */
export const SUBTREE_PAUSE_CANCEL_REASON = "Cancelled by a board operator's subtree pause";

/**
 * ONE fact: a person's OWN accepted Stop of a run still in STARTUP (no
 * provider session ever existed to acknowledge it, so isAcknowledgedNativeStop
 * never holds). Read by the wake-queue release (no reconciliation), by Send
 * admission (explicit-native-continuation: the stop counts as proven) and by
 * the task interruption projection (resolved, not failed). True only when:
 * - the run is cancelled with errorCode 'cancelled' and a startupCancellation
 *   fence, and is native; or, the one exception, it was stopped before native
 *   selection (beforeNativeSelection) on a paperclip_runner agent and the
 *   person-Stop arm (readPersonStopHold names it) holds;
 * - the cause is the person's: readPersonStopHold (the ONE person-Stop reader)
 *   names THIS run, or the run was cancelled by a board user's task-tree Pause
 *   (SUBTREE_PAUSE_CANCEL_REASON, cancelledByActorType 'user') and a pause
 *   hold created by a user is still active on the task or an ancestor
 *   (issueTreeControlService.getActivePauseHoldGate);
 * - no coordinator lease owner and no adapter control own it here;
 * - provesNoNativeRunProviderWork: no provider event, tool call or result.
 * System cancels, timeouts, failures and runs with provider work never match.
 */
export async function isPersonAcceptedStartupStop(db: Db, input: {
  id: string; companyId: string; status: string; errorCode: string | null; issueId: string;
}, options: { sendingWakeId?: string; sendingUserId?: string } = {}): Promise<boolean> {
  if (input.status !== "cancelled" || input.errorCode !== "cancelled" || !input.issueId) return false;
  // Callers hold partial or redacted run shapes; read the stored row once.
  const [stored] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error, resultJson: heartbeatRuns.resultJson,
    runtimeMode: heartbeatRuns.runtimeMode })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.id)));
  if (!stored || stored.status !== "cancelled" || stored.errorCode !== "cancelled"
    || Object.keys(parseObject(stored.resultJson?.startupCancellation)).length === 0) return false;
  // Native shape only (rf-2 F3), with ONE deliberate exception: a person's own
  // Stop BEFORE native selection (run-control beforeNativeSelection; runtimeMode
  // still the 'legacy' default) of a native-bound (paperclip_runner) agent's
  // run. Its legacy release then settles it as this fact (no reconciliation,
  // held messages gathered), so the banner, the release and Send agree. Only
  // the person-Stop arm below admits it; a direct adapter's legacy run, a
  // tree Pause and any system cancel before selection never match.
  const preselection = stored.runtimeMode !== "native";
  if (preselection && (parseObject(stored.resultJson?.startupCancellation).beforeNativeSelection !== true
    || (await db.select({ adapterType: agents.adapterType }).from(agents).where(and(eq(agents.companyId, stored.companyId),
      eq(agents.id, stored.agentId))))[0]?.adapterType !== "paperclip_runner")) return false;
  const run = { ...stored, issueId: input.issueId };
  const { adapterExecutionControls } = await import("./adapter-execution-control.js");
  if (adapterExecutionControls.has(run.id)) return false;
  const [coordinator] = await db.select({ leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id)));
  if (coordinator?.leaseOwner) return false;
  // rf-2 F1: the Stop is the person's OWN. The reader's (a) already binds the
  // held messages' author to the Stop's person; a Send binds the Send-er too.
  // Another person's Stop (or Pause) of my run never gives my Send the bypass.
  const hold = await readPersonStopHold(db, { companyId: run.companyId, issueId: run.issueId,
    agentId: run.agentId, sendingWakeId: options.sendingWakeId });
  const personStop = hold?.stoppedRunId === run.id
    && (options.sendingUserId === undefined || isStoppingPersonsOwn(options.sendingUserId, hold.userId));
  if (!personStop && (preselection || !(await isPersonTreePauseCancel(db, run, options.sendingUserId)))) return false;
  const { provesNoNativeRunProviderWork } = await import("./native-runtime/native-provider-work-proof.js");
  return provesNoNativeRunProviderWork(db, { companyId: run.companyId, runId: run.id });
}

async function isPersonTreePauseCancel(db: Db, run: { companyId: string; issueId: string; error: string | null;
  resultJson: Record<string, unknown> | null }, sendingUserId?: string) {
  if (run.error !== SUBTREE_PAUSE_CANCEL_REASON || run.resultJson?.cancelledByActorType !== "user") return false;
  const pausedBy = typeof run.resultJson?.cancelledByUserId === "string" ? run.resultJson.cancelledByUserId : null;
  if (sendingUserId !== undefined && !isStoppingPersonsOwn(sendingUserId, pausedBy)) return false;
  const { issueTreeControlService } = await import("./issue-tree-control.js");
  const gate = await issueTreeControlService(db).getActivePauseHoldGate(run.companyId, run.issueId);
  if (!gate) return false;
  const [hold] = await db.select({ by: issueTreeHolds.createdByActorType }).from(issueTreeHolds)
    .where(and(eq(issueTreeHolds.companyId, run.companyId), eq(issueTreeHolds.id, gate.holdId)));
  return hold?.by === "user";
}

/** The Stop's OWN board hold: the release wrote it for the very run the person
 * stopped (the acknowledgement landed after the release). Any other hold (a
 * real failure, or a person Stop of a different run) is not this. */
export function isPersonStopOwnHold(hold: { cause: string | null; evidence: unknown } | null | undefined, stop: PersonStopHold | null): boolean {
  return Boolean(hold && stop && hold.cause === PERSON_STOP_OWN_HOLD_CAUSE && parseObject(hold.evidence).runId === stop.stoppedRunId);
}
