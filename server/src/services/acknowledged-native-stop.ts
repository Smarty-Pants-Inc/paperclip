import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
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
import { userStopBoundaryAt } from "./run-cancellation.js";

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
  if (leases.some(lease => lease.provider !== "local")) {
    const unreceipted = leases.filter(lease => !hasRemoteTerminationReceipt(lease) && !hasRecoveredCleanupStopReceipt(lease));
    if (!unreceipted.length) return true;
    // pl/send-after-stop2: a warm box the Stop handed off never gets a receipt;
    // it is settled through the SAME predicate as the explicit Send's gate.
    const [owner] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).limit(1);
    if (!owner) return false;
    const { handedOffWarmLeaseSettled } = await import("./native-runtime/handed-off-warm-lease.js");
    // rf-4 row 22a: DB-only; the proof itself ran outside any transaction (run-control).
    for (const lease of unreceipted) if (!handedOffWarmLeaseSettled(owner, lease)) return false;
    return true;
  }
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

/** `stoppedByUserId` and `stopBoundaryAt` are the hold's own facts about WHO pressed Stop and WHEN (the stopped
 * run's cancelledByUserId and its Stop boundary, run-cancellation.ts userStopBoundaryAt). A reader that tells a
 * person "you pressed Stop" reads them here, never from a stored wait's text. */
export type PersonStopHold = { stoppedRunId: string; wakeIds: string[]; stoppedByUserId: string | null; stopBoundaryAt: Date | null };

function personStopWakeCarries(payload: unknown, issueId: string, messageId?: string): boolean {
  const value = parseObject(payload);
  const nested = parseObject(value._paperclipWakeContext);
  if (value.issueId !== issueId && nested.issueId !== issueId && value.taskId !== issueId) return false;
  const ids = [...queuedCommentIdsFromWakePayload(value), value.commentId, nested.wakeCommentId,
    ...(Array.isArray(nested.wakeCommentIds) ? nested.wakeCommentIds : [])]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return messageId ? ids.includes(messageId) : ids.length > 0;
}

/**
 * Stop means stop: the ONE reader of "these messages are held by a person's
 * Stop" (H2 section 3). Both the queued-comments header (routes/issues.ts) and
 * the per-message note (recovery/unanswered-person-message.ts) read it, so they
 * cannot disagree. Held when ALL of these are true:
 * - no run is running on the issue;
 * - the latest run of the assignee on the issue (nativeIssueId OR
 *   contextSnapshot.issueId) is cancelled by a user (cancelledByActorType
 *   "user") and is not a queued-comment interrupt (queuedCommentInterruptQueueId);
 * - a deferred_issue_execution wake, or a deferred wake with a well-formed
 *   saved wait, carries the issue's messages (the given message, or wake, when
 *   named), WITH OR WITHOUT a saved wait, and has no queuedCommentInterrupt
 *   (a person's Send is delivering it).
 * A saved wait (execution_active, execution_recovery, stopped_execution) does
 * not undo the Stop: nothing clears it after the Stop, so it is stale.
 */
export async function readPersonStopHold(db: Db, input: {
  companyId: string; issueId: string; agentId: string; messageId?: string; wakeId?: string;
}): Promise<PersonStopHold | null> {
  const onIssue = or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`);
  const [running] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), or(onIssue, eq(heartbeatRuns.issueId, input.issueId)),
    eq(heartbeatRuns.status, "running"))).limit(1);
  if (running) return null;
  const [lastTurn] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
    finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), onIssue))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  const stop = parseObject(lastTurn?.resultJson);
  if (!lastTurn || lastTurn.status !== "cancelled" || stop.cancelledByActorType !== "user" || stop.queuedCommentInterruptQueueId) return null;
  const wakes = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
      or(eq(agentWakeupRequests.status, "deferred_issue_execution"),
        and(eq(agentWakeupRequests.status, "deferred"), wellFormedExecutionWaitSql(agentWakeupRequests.payload)))));
  const held = wakes.filter(wake => (!input.wakeId || wake.id === input.wakeId)
    && (wake.status === "deferred_issue_execution" || isWellFormedExecutionWait(parseObject(wake.payload).executionWait))
    && parseObject(wake.payload).queuedCommentInterrupt == null
    && personStopWakeCarries(wake.payload, input.issueId, input.messageId));
  return held.length ? { stoppedRunId: lastTurn.id, wakeIds: held.map(wake => wake.id),
    stoppedByUserId: typeof stop.cancelledByUserId === "string" && stop.cancelledByUserId ? stop.cancelledByUserId : null,
    stopBoundaryAt: userStopBoundaryAt(lastTurn) } : null;
}

/** adopt-marker-port (RFL F1): this run is the FIRST turn after a person's Stop when the latest person Stop
 * acceptance (run-control's server-owned run.stop.accepted row, kind person_stop, by a user) on this issue and
 * agent names a run before this one, and no run of this agent on the issue between that stopped run and this one
 * started a provider turn. Its input then says so once (PAPERCLIP_PERSON_STOPPED_PREVIOUS_TURN_NOTE), as Claude
 * Code's '[Request interrupted by user]' does. A run in between that ENDED (failed / cancelled / timed out) without
 * starting a provider turn never showed the marker, so the first run that does start a turn carries it. A later
 * turn, an Interrupt, an agent's or the system's cancel never match. */
export async function readPersonStoppedPreviousTurn(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string; runCreatedAt: Date;
}): Promise<boolean> {
  const { stopAcceptanceEventSql } = await import("./heartbeat-run-events.js");
  const onIssue = or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`);
  const [stop] = await db.select({ runId: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt, resultJson: heartbeatRuns.resultJson,
    payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, heartbeatRunEvents.runId),
      eq(heartbeatRuns.companyId, heartbeatRunEvents.companyId)))
    .where(and(eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), onIssue,
      stopAcceptanceEventSql(), sql`${heartbeatRunEvents.payload}->>'kind' = 'person_stop'`))
    .orderBy(desc(heartbeatRunEvents.createdAt), desc(heartbeatRunEvents.id)).limit(1);
  if (!stop || stop.runId === input.runId) return false;
  const accepted = parseObject(stop.payload);
  if (accepted.schema !== "paperclip.stop-acceptance.v1" || accepted.issueId !== input.issueId
    || typeof accepted.userId !== "string" || !accepted.userId
    || parseObject(stop.resultJson).queuedCommentInterruptQueueId) return false;
  if (stop.createdAt.getTime() > input.runCreatedAt.getTime()) return false;
  const between = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), onIssue,
    sql`${heartbeatRuns.id} <> ${input.runId}`, sql`${heartbeatRuns.id} <> ${stop.runId}`,
    sql`${heartbeatRuns.createdAt} >= ${stop.createdAt.toISOString()}::timestamptz`,
    sql`${heartbeatRuns.createdAt} <= ${input.runCreatedAt.toISOString()}::timestamptz`));
  for (const run of between) {
    // Only an ENDED-unsuccessful run that never started a provider TURN leaves the marker for the next one; a run
    // that succeeded, is still live, or started (or may have started) a turn consumed (or may yet consume) it.
    if (!MARKER_PASSING_RUN_STATUSES.includes(run.status)) return false;
    if (await startedProviderTurnForStopMarker(db, { companyId: input.companyId, runId: run.id })) return false;
  }
  return true;
}

/** A run between the stopped run and this one that ended in these states, without starting a provider turn,
 * never showed the provider the Stop marker. */
const MARKER_PASSING_RUN_STATUSES: readonly string[] = ["failed", "cancelled", "timed_out"];

/** adopt-marker2 (rf4-bppd F4.1): the Stop marker's OWN 'consumed' test. The marker is shown to the provider only
 * inside a turn's input, so a run in between consumed it only when it started a provider TURN: a turn / item / tool /
 * semantic tool / run result event, a tool call, an accepted or finalized result, or a session checkpoint with an
 * active (or settled) turn. Readiness alone (harness.ready, session.started, session.resumed) is NOT a turn.
 * Unreadable rows count as a started turn (fail closed: the marker is never shown twice). */
async function startedProviderTurnForStopMarker(db: Db, input: { companyId: string; runId: string }): Promise<boolean> {
  const { companyId, runId } = input;
  const result = await db.execute(sql`select
    exists (select 1 from heartbeat_run_events event where event.company_id = ${companyId} and event.run_id = ${runId}
      and event.event_type ~ '^(turn|item|tool|semantic_tool|run[.]result)[.]') as "turnEvent",
    exists (select 1 from tool_invocations invocation where invocation.company_id = ${companyId}
      and invocation.run_id = ${runId}) as "toolInvocation",
    exists (select 1 from native_run_results result where result.company_id = ${companyId}
      and result.run_id = ${runId}) as "acceptedResult",
    exists (select 1 from native_run_finalizations coordinator where coordinator.run_id = ${runId}
      and coordinator.result_id is not null) as "finalizedResult",
    exists (select 1 from heartbeat_runs run where run.company_id = ${companyId} and run.id = ${runId}
      and (run.runner_profile_json->'sessionCheckpoint'->>'activeTurnId' is not null
        or (jsonb_typeof(run.runner_profile_json->'sessionCheckpoint'->'terminalTurns') = 'array'
          and jsonb_array_length(run.runner_profile_json->'sessionCheckpoint'->'terminalTurns') > 0))) as "checkpointTurn"`);
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return true;
  return [row.turnEvent, row.toolInvocation, row.acceptedResult, row.finalizedResult, row.checkpointTurn]
    .some(value => value !== false);
}

/** The Stop's OWN board hold: the release wrote it for the very run the person
 * stopped (the acknowledgement landed after the release). Any other hold (a
 * real failure, or a person Stop of a different run) is not this. */
export function isPersonStopOwnHold(hold: { cause: string | null; evidence: unknown } | null | undefined, stop: PersonStopHold | null): boolean {
  return Boolean(hold && stop && hold.cause === PERSON_STOP_OWN_HOLD_CAUSE && parseObject(hold.evidence).runId === stop.stoppedRunId);
}
