import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import type { environmentRuntimeService } from "../environment-runtime.js";
import { admittedNativeResourceDisposition } from "../native-runtime/native-failed-workspace-recovery.js";
import { readNativeWorkspaceSyncReference, resumeNativeWorkspaceSync } from "../native-runtime/native-workspace-sync.js";
import { nativeWorkspaceExportPendingForLease } from "../native-runtime/native-workspace-finalization-state.js";
import { tryLockNativeWorkspaceFinalization } from "../native-runtime/native-workspace-finalization-ownership.js";
import { finishCancelledWarmWorkspaceExport, hasCleanStoppedSessionClose, type CancelledWarmExportOutcome } from "./cancelled-warm-workspace-export.js";
import { PERSON_STOP_BOUND_KEY, PERSON_STOP_PROBE_TIMEOUT_MS, PERSON_STOP_WITHOUT_FILES_LINE, readPersonStopBoundDecision, personStopExportBoundAt,
  type PersonStopBoundDecision } from "./person-stop-export-bound.js";
export { PERSON_STOP_EXPORT_BOUND_MS, PERSON_STOP_WITHOUT_FILES_LINE, personStopExportBoundAt, personStopKeptBoxForSuccessor,
  readPersonStopBoundDecision } from "./person-stop-export-bound.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  try {
    return await Promise.race([work, new Promise<"timed_out">(resolve => { timer = setTimeout(() => resolve("timed_out"), ms); timer.unref?.(); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/**
 * At the bound (rf-4 22:53Z, binding ORDER), decide by line:
 * - the kept box is REACHABLE (its target resolves, and a no-op command runs on
 *   it within PERSON_STOP_PROBE_TIMEOUT_MS) AND the stopped turn's tools are
 *   proven gone (NSE clean-close proof, hasCleanStoppedSessionClose) ->
 *   `same_box`: the successor resumes THIS box, where the edit is;
 * - otherwise -> `without_files`: the message runs once without the files, with
 *   PERSON_STOP_WITHOUT_FILES_LINE; the box stays kept (lease active, deferral
 *   still retrying the export; never stopped or destroyed here).
 * Returns null before the bound (keep holding). Records the decision on the
 * lease (durable; the queue hold reads it) and, for without_files, ONE line.
 */
export async function decidePersonStopExportAtBound(input: {
  db: Db;
  environmentRuntime: ReturnType<typeof environmentRuntimeService>;
  run: typeof heartbeatRuns.$inferSelect;
  now?: number;
  probeTimeoutMs?: number;
}): Promise<(PersonStopBoundDecision & { decidedNow?: true }) | null> {
  const { db, environmentRuntime, run } = input;
  const prepared = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (run.runtimeMode !== "native" || run.status !== "cancelled" || !hasAcknowledgedNativeRunStopRequest(run)
    || prepared?.state !== "prepared") return null;
  const [lease] = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
    eq(environmentLeases.id, prepared.leaseId), eq(environmentLeases.status, "active"))).limit(1);
  if (!lease || !lease.provider || lease.provider === "local" || lease.providerLeaseId !== prepared.providerLeaseId) return null;
  const existing = readPersonStopBoundDecision(lease.metadata);
  if (existing) return existing;
  const boundAt = personStopExportBoundAt(lease.metadata);
  if (boundAt === null || (input.now ?? Date.now()) < boundAt) return null;
  let reason = "box_reachable_tools_stopped";
  if (!hasCleanStoppedSessionClose(run)) reason = "tools_not_proven_stopped";
  else {
    const [environment] = lease.environmentId ? await db.select().from(environments)
      .where(eq(environments.id, lease.environmentId)).limit(1) : [];
    const probe = async () => {
      if (!environment) return "box_unreachable_target";
      const target = await resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: "paperclip_runner",
        environment, leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as never, environmentRuntime })
        .catch(() => null);
      if (!target || target.kind !== "remote" || !("runner" in target) || !target.runner) return "box_unreachable_target";
      const result = await target.runner.execute({ command: "true", args: [], cwd: target.remoteCwd, timeoutMs: input.probeTimeoutMs ?? PERSON_STOP_PROBE_TIMEOUT_MS })
        .catch(() => null);
      return result && result.exitCode === 0 && !result.timedOut ? "box_reachable_tools_stopped" : "box_unreachable_probe";
    };
    const probed = await withTimeout(probe(), input.probeTimeoutMs ?? PERSON_STOP_PROBE_TIMEOUT_MS);
    reason = probed === "timed_out" ? "box_unreachable_probe" : probed;
  }
  const decision: PersonStopBoundDecision = { schema: "paperclip.person-stop-export-bound.v1",
    decision: reason === "box_reachable_tools_stopped" ? "same_box" : "without_files", reason,
    runId: run.id, providerLeaseId: lease.providerLeaseId!, decidedAt: new Date(input.now ?? Date.now()).toISOString() };
  // adopt-stopu-compose6 (c), never-OK: the decision is recorded ONLY under the
  // run's workspace-finalization lock (the same advisory key every export of
  // this run holds for its whole copyback: withNativeWorkspaceFinalizationOwnership).
  // An export still in flight -> no decision now (keep holding; it finalizes or
  // times out within its own bound, and the next retry decides). Every LATER
  // export reads this decision under the same lock and, for without_files,
  // saves the old files aside instead of over the successor's host workspace
  // (native-workspace-sync.ts resumeNativeWorkspaceSync).
  const recorded = await db.transaction(async tx => {
    if (!await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: run.companyId, runId: run.id })) return null;
    return tx.update(environmentLeases).set({ metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb)
      || ${JSON.stringify({ [PERSON_STOP_BOUND_KEY]: decision })}::jsonb` })
      .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.status, "active"),
        sql`not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ? ${PERSON_STOP_BOUND_KEY})`)).returning({ id: environmentLeases.id });
  });
  if (recorded === null) return null;
  if (recorded.length === 0) {
    const [again] = await db.select({ metadata: environmentLeases.metadata }).from(environmentLeases).where(eq(environmentLeases.id, lease.id));
    return readPersonStopBoundDecision(again?.metadata);
  }
  if (decision.decision === "without_files") {
    // ONE true line in the chat (rf-4 22:30Z + RFL 22:31Z): no 'restored'
    // claim, the box/lease unchanged (kept, not destroyed).
    const line = PERSON_STOP_WITHOUT_FILES_LINE;
    await appendHeartbeatRunEvent(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
      eventType: "workspace_export_bound_reached", stream: "system", level: "warn", message: line,
      payload: { decision: decision.decision, reason } }).catch(() => undefined);
    await appendHeartbeatRunEvent(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
      eventType: "provider.notice.recorded", stream: "system", level: "warn", message: line,
      payload: { prpEvent: { schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceKind: "control_plane",
        runId: run.id, eventType: "provider.notice.recorded", emittedAt: new Date().toISOString(),
        payload: { schema: "paperclip.provider.notice.v1", severity: "warning", category: "person_stop_runs_without_files",
          summary: line, message: line } } } }).catch(() => undefined);
  }
  return { ...decision, decidedNow: true };
}

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
  // One resolution of the box serves the process-gone proof and the export.
  let resolved: ReturnType<typeof resolveEnvironmentExecutionTarget> | null = null;
  const resolveBox = (signal?: AbortSignal) => {
    if (!environment) return Promise.reject(new Error("person_stop_export_environment_missing"));
    resolved ??= resolveEnvironmentExecutionTarget({ db, companyId: run.companyId, adapterType: "paperclip_runner",
      environment, leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as never, environmentRuntime, signal });
    return resolved;
  };
  return await finishCancelledWarmWorkspaceExport({ db, runId: run.id, companyId: run.companyId,
    timeoutMs: input.timeoutMs, settledBy: "terminal_cancelled_run",
    stoppedTurnBox: async signal => {
      const target = await resolveBox(signal);
      return target && target.kind === "remote" && "runner" in target && target.runner
        ? { runner: target.runner, remoteCwd: target.remoteCwd } : null;
    },
    nativeWorkspaceSync: { reference, restoreWorkspace: async (assertOwnership, options) => {
      const target = await resolveBox(options?.signal);
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
    // adopt-stopu-compose4: at the bound the hold ends (rf-4 22:53Z); the
    // decision is durable on the lease.
    if (readPersonStopBoundDecision(lease.metadata)) continue;
    if (await nativeWorkspaceExportPendingForLease(db, lease, { destructive: false })) return run.id;
  }
  return null;
}
