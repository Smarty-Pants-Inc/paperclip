import { and, eq, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints, toolInvocations, type Db } from "@paperclipai/db";
import { hasNativeExecutionStartEvidence } from "./native-restart-recovery.js";
import { hasNativePreDispatchFailureRecord } from "../heartbeat/run-failure-cause.js";
/** Durable run events that prove a provider session did work in a run. */
export const NATIVE_PROVIDER_DURABLE_EVENT_TYPES = new Set([
  "harness.ready", "session.started", "session.resumed", "session.updated",
  "turn.started", "provider.event", "provider.rpc_result",
]);

/** No recorded provider work across every runner instance, never just the latest
 * runner. This is NOT proof that no process spawned or that a runner is gone.
 * A read failure or any provider event, tool call, or result denies the proof. */
export async function provesNoNativeRunProviderWork(db: Pick<Db, "execute">, input: {
  companyId: string; runId: string; signal?: AbortSignal;
}): Promise<boolean> {
  input.signal?.throwIfAborted();
  const { companyId, runId } = input;
  const providerEvents = sql.join([...NATIVE_PROVIDER_DURABLE_EVENT_TYPES].map(value => sql`${value}`), sql`, `);
  const result = await db.execute(sql`select
    exists (select 1 from ${heartbeatRunEvents} event where event.company_id = ${companyId} and event.run_id = ${runId}
      and (event.source_event_id is not null or event.source_instance_id is not null
        or event.event_type in (${providerEvents})
        or event.event_type ~ '^(turn|item|tool|semantic_tool|run[.]result)[.]')) as "providerEvent",
    exists (select 1 from ${toolInvocations} invocation where invocation.company_id = ${companyId}
      and invocation.run_id = ${runId}) as "toolInvocation",
    exists (select 1 from ${nativeRunResults} result where result.company_id = ${companyId}
      and result.run_id = ${runId}) as "acceptedResult",
    exists (select 1 from ${nativeRunFinalizations} coordinator where coordinator.run_id = ${runId}
      and coordinator.result_id is not null) as "finalizedResult"`);
  input.signal?.throwIfAborted();
  const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows ?? []) as Array<Record<string, unknown>>;
  const row = rows[0];
  return Boolean(row && row.providerEvent === false && row.toolInvocation === false
    && row.acceptedResult === false && row.finalizedResult === false);
}

type ProofDb = Pick<Db, "select" | "execute">;
type Predecessor = typeof heartbeatRuns.$inferSelect;

/** ONE failed-predecessor gate, shared by resume selection and legacy identity
 * walk-back: it proves no execution ever started (P2) or a pre-dispatch
 * receipt. A claim (attempt/generation > 0) is not execution evidence. A
 * failed predecessor that may have started stays a barrier; Paperclip's
 * retire-or-replace-the-box path governs a resumed box, not a liveness probe.
 * Existing caller fences still apply; unknown/missing evidence stays held. */
export async function canBypassFailedNativePredecessor(db: ProofDb, input: {
  companyId: string; runId: string;
}): Promise<boolean> {
  const [row] = await db.select({ run: heartbeatRuns, owner: nativeRunFinalizations })
    .from(heartbeatRuns).leftJoin(nativeRunFinalizations, and(
      eq(nativeRunFinalizations.runId, heartbeatRuns.id)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!row || row.run.runtimeMode !== "native" || row.run.status !== "failed" || !row.run.finishedAt
    || (row.owner && (row.owner.companyId !== row.run.companyId || row.owner.issueId !== row.run.nativeIssueId))) return false;
  // A controller-owned pre-dispatch receipt speaks about THIS attempt, not
  // every previous successful turn in the conversation. Keep its real source.
  if (hasNativePreDispatchFailureRecord(row.run.resultJson)) {
    return preDispatchWithoutAllocationOrExecution(db, row.run, row.owner);
  }
  if (!row.owner || row.owner.phase !== "terminal_failure" || row.owner.leaseOwner !== null || row.owner.leaseExpiresAt !== null) return false;
  return terminalCompleteWithoutExecutionStart(db, row.run);
}

/** The failure owner records this only when its dispatch gate was explicitly
 * never entered (run-completion.ts). A terminal run fences later admission, so
 * unlike legacy P2 this does not infer a negative from a closed telemetry log.
 * Old rows without the receipt keep P2's stricter carried-session checks.
 * Any contradictory allocation, claim, start, checkpoint, result or provider
 * event wins over the receipt. HTTP status and missing snapshot are irrelevant. */
async function preDispatchWithoutAllocationOrExecution(db: ProofDb, run: Predecessor,
  owner: typeof nativeRunFinalizations.$inferSelect | null): Promise<boolean> {
  if (!hasNativePreDispatchFailureRecord(run.resultJson) || !run.nativeIssueId || run.sessionIdAfter !== null) return false;
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const profile = object(run.runnerProfileJson);
  if (profile.nativeControllerRecovery != null) return false;
  if (profile.sessionCheckpoint != null) {
    // Selection can rebind an idle source snapshot before dispatch. That is
    // not a new runner snapshot, but a cursor/result/active turn would be.
    const checkpoint = object(profile.sessionCheckpoint), identity = object(checkpoint.identity);
    const recovery = object(run.resultJson?.executionRecovery);
    const noProcess = run.processPid === null && run.processGroupId === null && run.processStartedAt === null;
    const bootstrap = noProcess && recovery.kind === "bootstrap" && recovery.providerWorkStarted === false;
    const idle = checkpoint.activeTurnId === null
      && Array.isArray(checkpoint.pendingRuntimeRequests) && checkpoint.pendingRuntimeRequests.length === 0
      && Array.isArray(checkpoint.terminalTurns) && checkpoint.terminalTurns.length === 0
      && checkpoint.terminal === null && checkpoint.semanticResult === null && object(checkpoint.goal).status !== "active";
    if (identity.runId !== run.id || identity.companyId !== run.companyId || identity.agentId !== run.agentId
      || identity.issueId !== run.nativeIssueId || identity.sessionId !== run.nativeSessionId
      || checkpoint.cursor !== null || !idle || (!bootstrap && checkpoint.driverKind !== "pi_rpc")) return false;
  }
  if (owner && (!["observed", "terminal_failure"].includes(owner.phase) || owner.attempt !== 0
    || owner.controllerBootId !== null || owner.controllerPid !== null || owner.leaseOwner !== null
    || owner.leaseExpiresAt !== null || owner.resultId !== null)) return false;
  const [evidence] = await db.select({
    allocation: sql<boolean>`exists (select 1 from ${environmentLeases} lease
      where lease.company_id = ${run.companyId} and lease.heartbeat_run_id = ${run.id}
        and lease.provider_lease_id is not null)`,
    checkpoint: sql<boolean>`exists (select 1 from ${nativeRunnerCheckpoints} checkpoint
      where checkpoint.company_id = ${run.companyId} and checkpoint.run_id = ${run.id})`,
    launched: sql<boolean>`exists (select 1 from ${heartbeatRunEvents} event
      where event.company_id = ${run.companyId} and event.run_id = ${run.id} and event.event_type = 'native.process_started')`,
    inheritedProcess: sql<boolean>`exists (select 1 from ${heartbeatRuns} prior
      join ${nativeRunFinalizations} finalization on finalization.company_id = prior.company_id and finalization.run_id = prior.id
      join ${heartbeatRuns} current on current.id = ${run.id} and current.company_id = prior.company_id
      where prior.id::text = ${run.runnerProfileJson?.inheritedProcessIdentityRunId ?? null}
        and prior.id <> ${run.id} and prior.company_id = ${run.companyId} and prior.agent_id = ${run.agentId}
        and prior.native_issue_id = ${run.nativeIssueId} and prior.native_session_id = ${run.nativeSessionId}
        and prior.created_at < (select created_at from ${heartbeatRuns} where id = ${run.id} and company_id = ${run.companyId})
        and prior.status = 'succeeded' and finalization.phase = 'committed' and finalization.result_id is not null
        and prior.process_pid is not distinct from current.process_pid
        and prior.process_group_id is not distinct from current.process_group_id
        and prior.process_started_at is not distinct from current.process_started_at)`,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  if (!evidence || evidence.allocation || evidence.checkpoint || evidence.launched) return false;
  if ((run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null) && !evidence.inheritedProcess) return false;
  if (await hasNativeExecutionStartEvidence(db, run)) return false;
  return provesNoNativeRunProviderWork(db, { companyId: run.companyId, runId: run.id });
}

async function terminalCompleteWithoutExecutionStart(db: ProofDb, run: Predecessor): Promise<boolean> {
  // Absence of start telemetry cannot contradict a persisted process identity.
  if (!run.nativeSessionId || run.processPid !== null || run.processGroupId !== null || run.processStartedAt !== null) return false;
  const [evidence] = await db.select({
    measured: sql<boolean>`exists (select 1 from ${heartbeatRunEvents} event where event.company_id = ${run.companyId}
      and event.run_id = ${run.id} and event.event_type = 'lifecycle' and event.message = 'task.run.measured'
      and event.source_event_id is null and event.source_instance_id is null)`,
    checkpoint: sql<boolean>`exists (select 1 from ${nativeRunnerCheckpoints} checkpoint
      where checkpoint.company_id = ${run.companyId} and checkpoint.run_id = ${run.id})`,
    result: sql<boolean>`exists (select 1 from ${nativeRunResults} result
      where result.company_id = ${run.companyId} and result.run_id = ${run.id})`,
    finalizedResult: nativeRunFinalizations.resultId,
  }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id)));
  if (!evidence?.measured || evidence.checkpoint || evidence.result || evidence.finalizedResult !== null) return false;
  // P2 invariant: native-session-executor's onSessionAdmission AWAITS
  // appendHeartbeatRunEvent(PROCESS_START_REQUESTED), and executeNativeSession
  // (packages/paperclip-runner/src/native-session-runtime.ts) AWAITS that
  // admission before ANY attach/open/spawn. task.run.measured closes the log;
  // absence in a truncated log is NOT proof. Do not filter controller generation:
  // an earlier run carried into this native session can own the same process.
  if (await hasNativeExecutionStartEvidence(db, run)) return false;
  const carriedRuns = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
    processStartedAt: heartbeatRuns.processStartedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), ne(heartbeatRuns.id, run.id),
    eq(heartbeatRuns.nativeIssueId, run.nativeIssueId!), eq(heartbeatRuns.nativeSessionId, run.nativeSessionId),
    // Compare in Postgres: a JS Date truncates microseconds and can exclude the
    // predecessor's own row (or an earlier carried run in that millisecond).
    sql`${heartbeatRuns.createdAt} <= (select created_at from ${heartbeatRuns} where id = ${run.id} and company_id = ${run.companyId})`));
  for (const carried of carriedRuns) {
    if (carried.processPid !== null || carried.processGroupId !== null || carried.processStartedAt !== null
      || await hasNativeExecutionStartEvidence(db, carried)) return false;
  }
  return await provesNoNativeRunProviderWork(db, { companyId: run.companyId, runId: run.id });
}
