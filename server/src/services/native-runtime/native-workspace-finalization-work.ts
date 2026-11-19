import { and, asc, desc, eq, gt, ne, notExists, sql } from "drizzle-orm";
import { MAX_SANDBOX_SYNC_TIMEOUT_MS } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, workspaceOperations, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { logger } from "../../middleware/logger.js";
import { onNativeWorkspaceFinalizationRelease, type NativeWorkspaceFinalizationScope } from "../native-workspace-finalization-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../remote-workspace-transport.js";
import { measureRunPhase, withRunWorkspaceFinalizationTiming } from "../execution-preparation-timing.js";
import { nativeRunnerOwnershipNotHeldCondition } from "./native-runner-ownership.js";
import { attemptNativeWorkspaceFinalization, recordNativeWorkspaceFinalizationFailure } from "./native-workspace-finalizer.js";

type Entry = { id: string; companyId: string; issueId: string; agentId: string; dueAt: number };
type AttemptInput = Parameters<typeof attemptNativeWorkspaceFinalization>[0];


const OWNERSHIP_RECHECK_MS = 30_000;
/**
 * The copy-out no-progress bound (Ruling P, smarty-dev#21235). An accepted
 * result whose copy-out starts no attempt for this long after acceptance, or
 * after its last attempt, ends through the finalizer's one terminal write with
 * its files set aside and kept (NATIVE_WORKSPACE_SYNC_OUT_STALLED).
 */
export const COPYOUT_NO_ATTEMPT_BOUND_MS = 60_000;
/**
 * A running attempt is never cut inside the time today's own timeouts give it:
 * the helper install and the capture are one sandbox command each, and the
 * archive transfer is capped at MAX_SANDBOX_SYNC_TIMEOUT_MS
 * (remote-workspace-transport.ts transferArchive). A copy-out reports nothing
 * while it runs (one result per sandbox command, no byte counter on the
 * transfer), so its progress cannot be observed; past this time it counts as
 * an attempt that ended, and the no-attempt bound applies.
 */
export const COPYOUT_ATTEMPT_TIMEOUT_MS = MAX_SANDBOX_SYNC_TIMEOUT_MS + 2 * WORKSPACE_COMMAND_TIMEOUT_MS;
const COPYOUT_STALLED = { stderrExcerpt: "workspace_sync_out_stalled" } as const;

export function nativeWorkspaceFinalizationWork(db: Db, options: {
  environmentRuntime?: AttemptInput["environmentRuntime"];
  pluginWorkerManager?: AttemptInput["pluginWorkerManager"];
  attempt?: typeof attemptNativeWorkspaceFinalization;
  /** Tests shorten the bound or move its clock; production uses the constants. */
  copyOutBound?: { noAttemptMs?: number; attemptTimeoutMs?: number; now?: () => number };
  onWorkspaceSettled(input: { runId: string; companyId: string; agentId: string; succeeded: boolean }): Promise<void>;
}) {
  function candidates(scope?: NativeWorkspaceFinalizationScope, after?: string) {
    return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: nativeRunFinalizations.issueId, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
      leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
      updatedAt: nativeRunFinalizations.updatedAt, acceptedAt: nativeRunResults.createdAt,
      // The bound ends a run only behind an epoch fence (fenceSourceWorkspace), which needs this reference.
      fenceable: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson} #>> '{remoteWorkspace,state}' = 'prepared', false)`,
    }).from(nativeRunFinalizations)
      .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
        eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
      .innerJoin(issues, and(eq(issues.id, nativeRunFinalizations.issueId), eq(issues.companyId, nativeRunFinalizations.companyId)))
      .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, nativeRunFinalizations.runId), eq(nativeRunResults.companyId, nativeRunFinalizations.companyId),
        eq(nativeRunResults.issueId, nativeRunFinalizations.issueId), eq(nativeRunResults.schemaStatus, "accepted")))
      .where(and(eq(heartbeatRuns.runtimeMode, "native"), nativeRunnerOwnershipNotHeldCondition(),
        ne(nativeRunFinalizations.phase, "terminal_failure"),
        notExists(db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
          eq(workspaceOperations.companyId, nativeRunFinalizations.companyId),
          eq(workspaceOperations.heartbeatRunId, nativeRunFinalizations.runId), eq(workspaceOperations.issueId, nativeRunFinalizations.issueId),
          eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"),
        ))),
        scope ? eq(nativeRunFinalizations.companyId, scope.companyId) : undefined,
        scope?.issueId ? eq(nativeRunFinalizations.issueId, scope.issueId) : undefined,
        scope?.runId ? eq(nativeRunFinalizations.runId, scope.runId) : undefined,
        after ? gt(nativeRunFinalizations.runId, after) : undefined,
      )).orderBy(asc(nativeRunFinalizations.runId)).limit(100);
  }
  function entry(row: Awaited<ReturnType<typeof candidates>>[number]): Entry {
    // Work without a saved retry is due now. Order it by when it became pending,
    // so copy-backs interrupted by a later restart cannot starve older retries.
    // The database clock may lead this process slightly; never defer such work.
    const pendingSince = Math.min(row.updatedAt.getTime(), Date.now());
    return { id: row.id, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId,
      dueAt: Math.max(row.nextAttemptAt?.getTime() ?? pendingSince,
        row.leaseOwner ? row.leaseExpiresAt?.getTime() ?? 0 : 0) };
  }
  async function load(scope?: NativeWorkspaceFinalizationScope, signal?: AbortSignal, canRun = () => true): Promise<Entry[]> {
    const entries: Entry[] = [];
    let after: string | undefined;
    while (!signal?.aborted && canRun()) {
      const rows = await candidates(scope, after);
      entries.push(...rows.map(entry));
      if (rows.length < 100) return entries;
      after = rows[rows.length - 1].id;
    }
    throw new Error("Native workspace finalization discovery stopped");
  }
  const noAttemptMs = options.copyOutBound?.noAttemptMs ?? COPYOUT_NO_ATTEMPT_BOUND_MS;
  const attemptTimeoutMs = options.copyOutBound?.attemptTimeoutMs ?? COPYOUT_ATTEMPT_TIMEOUT_MS;
  const now = options.copyOutBound?.now ?? Date.now;
  type Candidate = Awaited<ReturnType<typeof candidates>>[number];
  /** When the bound fires: no attempt started for the bound after acceptance, a
   * retry request or the last attempt. An unfinished attempt ends at its timeout. */
  async function copyOutStallAt(row: Candidate) {
    const [last] = await db.select({ startedAt: workspaceOperations.startedAt, finishedAt: workspaceOperations.finishedAt })
      .from(workspaceOperations).where(and(eq(workspaceOperations.companyId, row.companyId),
        eq(workspaceOperations.heartbeatRunId, row.id), eq(workspaceOperations.issueId, row.issueId),
        eq(workspaceOperations.phase, "workspace_finalize"))).orderBy(desc(workspaceOperations.startedAt)).limit(1);
    const attemptEnded = last ? last.finishedAt?.getTime() ?? last.startedAt.getTime() + attemptTimeoutMs : 0;
    return Math.max(row.acceptedAt.getTime(), row.updatedAt.getTime(), attemptEnded) + noAttemptMs;
  }
  /** Ends the run with its files set aside and kept. False when the finalizer
   * refused: a run whose files cannot be fenced stays exactly as it was. */
  async function endStalled(row: Candidate) {
    const failure = await recordNativeWorkspaceFinalizationFailure(db, row.id, COPYOUT_STALLED);
    if (failure.phase !== "terminal_failure") return false;
    logger.warn({ runId: row.id, failureCode: failure.failureCode }, "native workspace copy-out made no progress; the run ended with its files kept");
    await options.onWorkspaceSettled({ runId: row.id, companyId: row.companyId, agentId: row.agentId, succeeded: false });
    return true;
  }
  function check(current: Entry, signal?: AbortSignal): Promise<Entry | null> {
    return withRunWorkspaceFinalizationTiming(current.id, () => checkWithinTrace(current, signal));
  }
  async function checkWithinTrace(current: Entry, signal?: AbortSignal): Promise<Entry | null> {
    if (signal?.aborted) throw new Error("Native workspace finalization stopped");
    const scope = { companyId: current.companyId, runId: current.id };
    const [row] = await candidates(scope);
    if (!row) return null;
    const due = entry(row);
    if (due.dueAt > Date.now()) return due;
    if (signal?.aborted) throw new Error("Native workspace finalization stopped");
    const running = measureRunPhase("execution.workspace_finalize", () => (options.attempt ?? attemptNativeWorkspaceFinalization)({
      db, runId: current.id, environmentRuntime: options.environmentRuntime, pluginWorkerManager: options.pluginWorkerManager,
    }));
    // This worker serializes a task's checks, so an attempt that never returns
    // would also hold back the check that could end it. Stop waiting for it here.
    let overrun: ReturnType<typeof setTimeout> | undefined;
    let outcome = await (!row.fenceable ? running : Promise.race([running, new Promise<{ kind: "overrun" }>(resolve => {
      overrun = setTimeout(() => resolve({ kind: "overrun" }), attemptTimeoutMs + noAttemptMs);
    })]).finally(() => clearTimeout(overrun)));
    if (outcome.kind === "overrun") {
      if (await endStalled(row)) {
        // Its epoch is fenced, so whatever it returns later cannot publish.
        void running.catch(error => logger.warn({ runId: current.id, error }, "overrun native workspace finalization attempt failed"));
        return null;
      }
      outcome = await running;
    }
    if (outcome.kind === "retry") return { ...due, dueAt: outcome.retryAt.getTime() };
    if (outcome.kind === "waiting") {
      // A run without a fenceable epoch keeps the schedule it had before the bound.
      const stallAt = row.fenceable ? await copyOutStallAt(row) : Number.POSITIVE_INFINITY;
      const stalled = stallAt <= now();
      if (stalled && await endStalled(row)) return null;
      // A pending stop proof rechecks on its own; the board action stays visible meanwhile.
      if (outcome.reason === "busy" || outcome.reason === "platform_stop_pending" || outcome.reason === "local_stop_pending") {
        return { ...due, dueAt: Date.now() + (stalled ? OWNERSHIP_RECHECK_MS : Math.min(OWNERSHIP_RECHECK_MS, stallAt - now())) };
      }
      if (outcome.reason !== "owner_active") {
        logger.info({ runId: current.id, reason: outcome.reason }, "native workspace finalization paused until the run is notified again");
      }
      // Revisited at its bound, and as before after a restart or a release notification.
      return stalled || !row.fenceable ? null : { ...due, dueAt: Date.now() + (stallAt - now()) };
    }
    if (outcome.kind === "inactive" || (outcome.kind === "completed" && outcome.operation.status === "succeeded")) return null;
    const failure = await recordNativeWorkspaceFinalizationFailure(db, current.id, outcome.operation);
    if (failure.phase === "terminal_failure") {
      await options.onWorkspaceSettled({ runId: row.id, companyId: row.companyId, agentId: row.agentId, succeeded: false });
      return null;
    }
    const [remaining] = await candidates(scope);
    return remaining ? entry(remaining) : null;
  }
  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean,
    canRecover: () => Promise<boolean> = async () => true) {
    const worker = registerScopedDeadlineWork(coordinator, {
      queue: DELIVERY_QUEUES.nativeWorkspaceFinalization,
      // A slow sandbox export can take many minutes. Independent tasks proceed
      // in parallel; runs that share a task keep their copy-backs serialized.
      // Retries saved while another copy-back is still exporting are admitted
      // on schedule instead of waiting for that export to finish.
      concurrentChecks: { limit: 4, key: (item: Entry) => `issue:${item.companyId}:${item.issueId}`, admitDueWhileActive: true },
      decodeScope: (hint: string): NativeWorkspaceFinalizationScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
      matches: (item: Entry, scope?: NativeWorkspaceFinalizationScope) => !scope || item.companyId === scope.companyId
        && (!scope.issueId || item.issueId === scope.issueId) && (!scope.runId || item.id === scope.runId),
      load: async (scope, signal) => await canRecover() ? load(scope, signal, canRun) : [],
      check: async (item, signal) => {
        if (!canRun()) throw new Error("Native workspace finalization paused");
        if (!await canRecover()) return null;
        return check(item, signal);
      },
    }, canRun);
    const stop = onNativeWorkspaceFinalizationRelease(db, scope => worker.invalidate(JSON.stringify(scope)));
    return { ...worker, stop };
  }
  return { load, check, register };
}
