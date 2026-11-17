import { readProcessStartedAt } from "./hot-restart.js";
import { readLeaseReleaseDeferral } from "./environment-lease-release-deferral.js";
import { runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[]) {
  return (await agentExecutionStopBlocker(db, agentIds)) === null;
}

export async function agentExecutionStopBlocker(db: Db, agentIds: string[]): Promise<string | null> {
  if (!agentIds.length) return null;
  const condition = inArray(heartbeatRuns.agentId, agentIds);
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(condition);
  return executionStopBlocker(db, condition, or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  )!);
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

async function executionStopBlocker(db: Db, condition: SQL, leaseCondition: SQL,
  expectedRunCount?: number, settleCoordinators = true): Promise<string | null> {
  const runs = await db.select().from(heartbeatRuns).where(condition);
  // A missing or cross-company binding cannot establish execution Stop.
  if (expectedRunCount !== undefined && runs.length !== expectedRunCount) return "run_binding_unproven";
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(condition);
  const leases = await db.select().from(environmentLeases).where(leaseCondition);
  const deferred = leases.find(lease => lease.status === "active" && readLeaseReleaseDeferral(lease.metadata));
  if (deferred) return `environment_lease_release_deferred:${readLeaseReleaseDeferral(deferred.metadata)!.reason}`;
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return "environment_lease_unreleased";
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
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if (run.status === "cancelled" && !runLeases.every(hasRemoteTerminationReceipt)) return "remote_stop_unconfirmed";
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
