import { readProcessStartedAt } from "./hot-restart.js";
import { readLeaseReleaseDeferral } from "./environment-lease-release-deferral.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { hasAcknowledgedNativeRunStopRequest, hasAcknowledgedNativeStopIntent } from "./acknowledged-native-stop.js";
import { hasStopOnlyCleanup } from "./sandbox-stop-and-retain.js";

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return (await agentExecutionStopBlocker(db, agentIds)) === null;
}

/** skipRemoteProviderProof (pause): never wait on the sandbox service. Remote
 * leases and their termination receipt are left to the lease sweep; local
 * process, local lease and native owner proof are still checked here. */
export async function agentExecutionStopBlocker(db: Db, agentIds: string[],
  { skipRemoteProviderProof = false } = {}): Promise<string | null> {
  if (!agentIds.length) return null;
  const condition = inArray(heartbeatRuns.agentId, agentIds);
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(condition);
  return executionStopBlocker(db, condition, or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  )!, undefined, true, skipRemoteProviderProof);
}

/** Task recovery uses read-only Stop proof, scoped to its owners rather than
 * unrelated runs of the assignee. The caller holds task/run locks: coordinator
 * writes here would invert native reacquisition's coordinator -> run order.
 * Expired coordinator settlement remains the agent lifecycle owner's duty. */
export async function runExecutionsHaveStopped(db: Db, companyId: string, runIds: string[]) {
  const ids = [...new Set(runIds)];
  if (!ids.length) return true;
  return (await executionStopBlocker(db, and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, ids))!,
    and(eq(environmentLeases.companyId, companyId), inArray(environmentLeases.heartbeatRunId, ids))!, ids.length, false)) === null;
}

type Run = typeof heartbeatRuns.$inferSelect;
type Lease = typeof environmentLeases.$inferSelect;
type Coordinator = typeof nativeRunFinalizations.$inferSelect;
/** A person's Stop on a keep_running warm box hands the box off warm; no
 * termination receipt is ever written. Only the executor's settled-turn proof
 * (native-session-executor retainCancelledSession: cancellation cleanup done,
 * idle snapshot, no pending runtime requests, instruction checkpoint) proves
 * that handoff. Its sole durable form is this receipt, issued atomically with
 * the coordinator's native_retry_cancelled settlement and bound to its
 * controller boot/generation. A cancel ack or policy label is not this proof;
 * a missing/mismatched receipt or a stop_and_retain lease keeps the blocker. */
function provedWarmTurnHandoff(run: Run, runLeases: Lease[], coordinator: Coordinator | undefined): boolean {
  const value = run.runnerProfileJson?.nativeRetainedIdleCheckpoint;
  const receipt = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return run.status === "cancelled" && run.runtimeMode === "native" && hasAcknowledgedNativeStopIntent(run)
    && receipt.schema === "paperclip.native-retained-idle-checkpoint.v1"
    && receipt.companyId === run.companyId && receipt.runId === run.id && receipt.issueId === run.nativeIssueId
    && typeof receipt.sessionId === "string" && receipt.sessionId === run.nativeSessionId
    && !!coordinator && coordinator.runId === run.id && coordinator.phase === "terminal_failure"
    && coordinator.failureCode === "native_retry_cancelled" && !coordinator.leaseOwner && !coordinator.resultId
    && receipt.bootId === coordinator.controllerBootId && receipt.generation === coordinator.controllerGeneration
    && runLeases.length > 0 && runLeases.every(lease => !!lease.provider && lease.provider !== "local"
      && lease.status === "active" && lease.leasePolicy === "reuse_by_environment" && !lease.releasedAt
      && !lease.cleanupStatus && lease.metadata?.pendingCleanupInFlight !== true
      && !readLeaseReleaseDeferral(lease.metadata) && !hasStopOnlyCleanup(lease));
}

/** adopt-stoppending-card: a person's acknowledged Stop of a warm (keep_running)
 * turn keeps the box ON PURPOSE, handed off for the next message
 * (nativeStopWorkspaceOutcome 'handoff', the same handedOffWarmLease predicate
 * as the Send's gate). For task-scoped recovery that is an intentional keep, not
 * unconfirmed execution: the successor's own admission still waits for the
 * runner-exit proof. The hand-off's existing bounds stay in force: unproven ->
 * stop-and-retain intent -> its receipt within handedOffWarmStopReceiptBound;
 * past that bound (or any other lease state) the blocker, and so ONE card, returns. */
type HandOff = typeof import("./native-runtime/handed-off-warm-lease.js");
function keptWarmTurnHandoff(run: Run, runLeases: Lease[],
  { handedOffWarmLease, handedOffWarmStopWithinReceiptBound }: HandOff): boolean {
  return run.status === "cancelled" && run.runtimeMode === "native" && hasAcknowledgedNativeRunStopRequest(run)
    && runLeases.some(lease => handedOffWarmLease(run, lease) || handedOffWarmStopWithinReceiptBound(run, lease))
    && runLeases.every(lease => !lease.provider || lease.provider === "local"
      // A local lease (the host workspace) must itself be released; only the remote box is kept.
      ? (!!lease.releasedAt || (lease.status === "retained" && lease.cleanupStatus === "success"))
        && lease.status !== "pending_cleanup" && lease.cleanupStatus !== "failed"
      : hasRemoteTerminationReceipt(lease) || handedOffWarmLease(run, lease) || handedOffWarmStopWithinReceiptBound(run, lease));
}

async function executionStopBlocker(db: Db, condition: SQL, leaseCondition: SQL,
  expectedRunCount?: number, settleCoordinators = true, skipRemoteProviderProof = false): Promise<string | null> {
  const runs = await db.select().from(heartbeatRuns).where(condition);
  // A missing or cross-company binding cannot establish execution Stop.
  if (expectedRunCount !== undefined && runs.length !== expectedRunCount) return "run_binding_unproven";
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(condition);
  const allLeases = await db.select().from(environmentLeases).where(leaseCondition);
  // Task-scoped proof only (never whole-agent lifecycle Stop): a proved warm
  // handoff's still-active warm lease is the retained box, not live execution.
  const coordinatorRows = settleCoordinators ? [] : await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runs.map(run => run.id)));
  // Lazy, as acknowledged-native-stop does: a static import closes a module cycle.
  const handOff = settleCoordinators ? null : await import("./native-runtime/handed-off-warm-lease.js");
  const handedOff = new Set(!handOff ? [] : runs.filter(run => provedWarmTurnHandoff(run,
    allLeases.filter(lease => lease.heartbeatRunId === run.id),
    coordinatorRows.find(row => row.runId === run.id))
    || keptWarmTurnHandoff(run, allLeases.filter(lease => lease.heartbeatRunId === run.id), handOff)).map(run => run.id));
  const leases = allLeases.filter(lease => !lease.heartbeatRunId || !handedOff.has(lease.heartbeatRunId));
  const proofLeases = leases.filter(lease => !skipRemoteProviderProof || !lease.provider || lease.provider === "local");
  const deferred = proofLeases.find(lease => lease.status === "active" && readLeaseReleaseDeferral(lease.metadata));
  if (deferred) return `environment_lease_release_deferred:${readLeaseReleaseDeferral(deferred.metadata)!.reason}`;
  if (proofLeases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return "environment_lease_unreleased";
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return "native_finalization_owned";
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return "native_controller_alive";
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return "run_not_terminal";
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return "run_controller_lease_held";
    if (handedOff.has(run.id)) continue;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !skipRemoteProviderProof && !runLeases.every(hasRemoteTerminationReceipt)) return "remote_stop_unconfirmed";
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return "run_process_alive";
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return "native_stop_unproven";
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return "legacy_stop_unproven";
  }
  // Task/run-lock callers only read proof. They must never wait for a
  // coordinator write while a native owner waits for their run lock.
  if (!settleCoordinators) return null;
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        sql`date_trunc('milliseconds', ${nativeRunFinalizations.leaseExpiresAt}) = ${coordinator.leaseExpiresAt!.toISOString()}::timestamptz`,
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return "native_finalization_release_raced";
  }
  return null;
}
