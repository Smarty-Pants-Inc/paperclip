import { and, eq, inArray } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import type { environmentRuntimeService } from "../environment-runtime.js";
import { admittedNativeResourceDisposition } from "../native-runtime/native-failed-workspace-recovery.js";
import { readNativeWorkspaceSyncReference, resumeNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { nativeWorkspaceExportPendingForLease } from "../native-runtime/native-workspace-finalization-state.js";
import { finishCancelledWarmWorkspaceExport, type CancelledWarmExportOutcome } from "./cancelled-warm-workspace-export.js";

/**
 * adopt-stopu-xpaths: the ONE release-site guard for a person's Stop.
 *
 * Every path that ends a person-stopped warm (keep_running) native turn
 * releases its lease through run-control's releaseEnvironmentLeasesForRun. If
 * the run's workspace descriptor is still `prepared` there (the in-run
 * cancel-finalize export at runtime-execution.ts did not run, did not finish,
 * or the Stop surfaced as another error class / a crash), the files exist only
 * on the box: a stop_and_retain release would leave the box excluded by the
 * reuse filter (nativeWorkspaceExportPendingForResource) and a successor would
 * take a spare without the edit. So, before that release and outside any DB
 * transaction, run the same bounded export (finishCancelledWarmWorkspaceExport,
 * one aggregate bound CANCELLED_WARM_EXPORT_TIMEOUT_MS) from the still-running
 * box, resolved from durable rows only (as the row-20 crash path did).
 *
 * Returns `not_applicable` when the guard does not apply (not a person's Stop,
 * not keep_running, descriptor not prepared, no active remote lease).
 */
export async function exportPersonStoppedWarmWorkspaceBeforeRelease(input: {
  db: Db;
  environmentRuntime: ReturnType<typeof environmentRuntimeService>;
  run: typeof heartbeatRuns.$inferSelect;
  timeoutMs?: number;
}): Promise<CancelledWarmExportOutcome> {
  const { db, environmentRuntime, run } = input;
  const prepared = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (run.runtimeMode !== "native" || run.status !== "cancelled" || !hasAcknowledgedNativeRunStopRequest(run)
    || admittedNativeResourceDisposition(run.runnerProfileJson) !== "keep_running"
    || prepared?.state !== "prepared") return { outcome: "not_applicable" };
  const [lease] = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    eq(environmentLeases.id, prepared.leaseId), inArray(environmentLeases.status, ["active"]))).limit(1);
  if (!lease || !lease.provider || lease.provider === "local" || lease.providerLeaseId !== prepared.providerLeaseId)
    return { outcome: "not_applicable" };
  const [environment] = lease.environmentId ? await db.select().from(environments)
    .where(eq(environments.id, lease.environmentId)).limit(1) : [];
  const reference = { state: prepared.state as string };
  return await finishCancelledWarmWorkspaceExport({ db, runId: run.id, companyId: run.companyId,
    timeoutMs: input.timeoutMs,
    nativeWorkspaceSync: { reference, restoreWorkspace: async (assertOwnership, options) => {
      if (!environment) throw new Error("person_stop_export_environment_missing");
      const target = await resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: "paperclip_runner",
        environment, leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as never, environmentRuntime, signal: options?.signal });
      if (!target || !await resumeNativeWorkspaceSync({ db, runId: run.id, target, assertOwnership, signal: options?.signal }))
        throw new Error("person_stop_export_target_unavailable");
      const [after] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id));
      reference.state = readNativeWorkspaceSyncReference(after?.profile?.nativeWorkspaceSync)?.state ?? "none";
    } } });
}

/**
 * adopt-stopu-xpaths (F10): the durable admission hold for the receipt-vs-export
 * window. While a person-stopped native run of this agent and task still holds
 * an unreleased remote lease whose box has the only copy of the turn's edit
 * (descriptor `prepared`: nativeWorkspaceExportPendingForLease), a queued
 * message or Send for the task is kept queued. The in-process gates
 * (queue.ts predecessor_settling_in_process, the runner's session cleanup gate)
 * vanish when the executor exits after a deferred release or on a controller
 * restart; this hold is read from durable rows only. It clears when the
 * release-site guard has finalized the export and released the lease.
 */
export async function personStopExportPendingHoldsAdmission(db: Db,
  input: { companyId: string; agentId: string; issueId: string }): Promise<string | null> {
  const rows = await db.select({ run: heartbeatRuns, lease: environmentLeases }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId),
      eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .where(and(eq(environmentLeases.companyId, input.companyId), inArray(environmentLeases.status, ["active", "pending_cleanup"]),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "cancelled"),
      eq(heartbeatRuns.nativeIssueId, input.issueId))).limit(5);
  for (const { run, lease } of rows) {
    if (!lease.provider || lease.provider === "local" || !hasAcknowledgedNativeRunStopRequest(run)) continue;
    if (await nativeWorkspaceExportPendingForLease(db, lease, { destructive: false })) return run.id;
  }
  return null;
}
