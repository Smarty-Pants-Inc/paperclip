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
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};


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
/**
 * The person-wait cap (RFL x1 + PERSON_WAIT_CAP). While a person's message is
 * parked behind the run (a `deferred_issue_execution` wake a user requested for
 * this task), the run ends no later than this long after the parking or the
 * acceptance, whichever is later, and at the first attempt that times out. It
 * ends as the no-attempt bound ends it: the same cause, its files set aside and
 * kept. With nobody parked nothing here applies.
 */
export const PERSON_WAIT_CAP_MS = 300_000;
/** A copy-out attempt that ended on a timeout (remote-workspace-transport.ts
 * RemoteWorkspaceOperationTimeoutError, or the provider's `transport_timeout`;
 * the archive transfer's own is the size-scaled one in transferArchive). */
const ATTEMPT_TIMED_OUT = /remote_workspace_operation_timed_out|transport_timeout/;
const COPYOUT_STALLED = { stderrExcerpt: "workspace_sync_out_stalled" } as const;

export function nativeWorkspaceFinalizationWork(db: Db, options: {
  environmentRuntime?: AttemptInput["environmentRuntime"];
  pluginWorkerManager?: AttemptInput["pluginWorkerManager"];
  attempt?: typeof attemptNativeWorkspaceFinalization;
  /** Tests shorten the bound or move its clock; production uses the constants. */
  copyOutBound?: { noAttemptMs?: number; attemptTimeoutMs?: number; personWaitCapMs?: number; now?: () => number };
  onWorkspaceSettled(input: { runId: string; companyId: string; agentId: string; succeeded: boolean;
    skipEnvironmentSettlement?: boolean }): Promise<void>;
}) {
  function candidates(scope?: NativeWorkspaceFinalizationScope, after?: string) {
    return db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      issueId: nativeRunFinalizations.issueId, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
      leaseOwner: nativeRunFinalizations.leaseOwner, leaseExpiresAt: nativeRunFinalizations.leaseExpiresAt,
      updatedAt: nativeRunFinalizations.updatedAt, acceptedAt: nativeRunResults.createdAt,
      // The bound ends a run only behind an epoch fence (fenceSourceWorkspace), which needs this reference.
      fenceable: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson} #>> '{remoteWorkspace,state}' = 'prepared', false)
        or coalesce(${heartbeatRuns.runnerProfileJson} #>> '{nativeWorkspaceSync,state}' = 'prepared', false)`,
      // A classic sync run has no epoch: it is ended only by the person-wait cap, behind the classic isolation
      // (isolateClassicSourceWorkspace). With nobody parked it keeps the schedule it had before the bound.
      classic: sql<boolean>`coalesce(${heartbeatRuns.runnerProfileJson} #>> '{remoteWorkspace,state}' = 'prepared', false) is not true`,
      // When the first person's message still parked behind this task was parked (epoch ms), or null.
      parkedAt: sql<number | null>`(select (extract(epoch from min(parked.requested_at)) * 1000)::float8
        from agent_wakeup_requests parked where parked.company_id = ${nativeRunFinalizations.companyId}
          and parked.status = 'deferred_issue_execution' and parked.run_id is null and parked.requested_by_actor_type = 'user'
          and parked.payload->>'issueId' = ${nativeRunFinalizations.issueId}::text)`,
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
    return withinPersonWait(row, { id: row.id, companyId: row.companyId, issueId: row.issueId, agentId: row.agentId,
      dueAt: Math.max(row.nextAttemptAt?.getTime() ?? pendingSince,
        row.leaseOwner ? row.leaseExpiresAt?.getTime() ?? 0 : 0) });
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
  const personWaitCapMs = options.copyOutBound?.personWaitCapMs ?? PERSON_WAIT_CAP_MS;
  const now = options.copyOutBound?.now ?? Date.now;
  type Candidate = Awaited<ReturnType<typeof candidates>>[number];
  /** When the person-wait cap ends this run; null while nobody is parked behind it. */
  function personWaitEndsAt(row: Candidate) {
    return !row.fenceable || row.parkedAt === null ? null
      : Math.max(Number(row.parkedAt), row.acceptedAt.getTime()) + personWaitCapMs;
  }
  /** A fenceable run is checked again no later than its cap. With nobody parked
   * that is one cap from now: a message parked after this cannot be due sooner. */
  function withinPersonWait(row: Candidate, item: Entry): Entry {
    if (!row.fenceable) return item;
    const endsAt = personWaitEndsAt(row);
    // A cap the finalizer refused to act on is rechecked like a pending stop.
    const wait = endsAt === null ? personWaitCapMs : endsAt > now() ? endsAt - now() : OWNERSHIP_RECHECK_MS;
    return { ...item, dueAt: Math.min(item.dueAt, Date.now() + wait) };
  }
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
    if (failure.phase !== "terminal_failure") {
      logger.warn({ runId: row.id, phase: failure.phase }, "native workspace copy-out bound refused: this run's files cannot be fenced or isolated (a root the task does not own, or a save that already succeeded)");
      return false;
    }
    logger.warn({ runId: row.id, failureCode: failure.failureCode }, "native workspace copy-out made no progress; the run ended");
    // A classic run's release never waits for its box (the settlement worker the terminal write notified owns
    // it). A fenced epoch settles here, as before.
    await options.onWorkspaceSettled({ runId: row.id, companyId: row.companyId, agentId: row.agentId, succeeded: false,
      ...(row.classic ? { skipEnvironmentSettlement: true } : {}) });
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
    // The person-wait cap ends the run whatever it waits for: a retry delay too.
    const waitEnded = (personWaitEndsAt(row) ?? Number.POSITIVE_INFINITY) <= now();
    if (waitEnded && await endStalled(row)) return null;
    const due = entry(row);
    if (due.dueAt > Date.now()) return due;
    if (signal?.aborted) throw new Error("Native workspace finalization stopped");
    const running = measureRunPhase("execution.workspace_finalize", () => (options.attempt ?? attemptNativeWorkspaceFinalization)({
      db, runId: current.id, environmentRuntime: options.environmentRuntime, pluginWorkerManager: options.pluginWorkerManager,
    }));
    // This worker serializes a task's checks, so an attempt that never returns
    // would also hold back the check that could end it. Stop waiting for it here.
    // With nobody parked it has its timeout and then the no-attempt bound; with a
    // person's message parked, its timeout once or the person-wait cap, the sooner.
    const attemptStartedAt = now();
    let outcome: Awaited<typeof running> | { kind: "overrun" } | undefined;
    for (let latest: Candidate | undefined = row; !outcome;) {
      const waitEndsAt = latest && personWaitEndsAt(latest);
      const endsAt = !latest ? Number.POSITIVE_INFINITY
        : waitEndsAt == null ? row.classic ? Number.POSITIVE_INFINITY : attemptStartedAt + attemptTimeoutMs + noAttemptMs
        : Math.min(attemptStartedAt + attemptTimeoutMs, waitEndsAt);
      if (!row.fenceable || !latest) outcome = await running;
      else if (endsAt <= now()) outcome = { kind: "overrun" };
      else {
        let tick: ReturnType<typeof setTimeout> | undefined;
        const raced = await Promise.race([running, new Promise<"tick">(resolve => {
          // Nobody parked yet: look again within one cap, the soonest a later parking can be due.
          tick = setTimeout(() => resolve("tick"), Math.min(endsAt - now(), waitEndsAt == null ? personWaitCapMs : endsAt - now()));
        })]).finally(() => clearTimeout(tick));
        if (raced === "tick") [latest] = await candidates(scope);
        else outcome = raced;
      }
    }
    if (outcome.kind === "overrun") {
      if (await endStalled(row)) {
        // Its epoch is fenced, so whatever it returns later cannot publish.
        void running.catch(error => logger.warn({ runId: current.id, error }, "overrun native workspace finalization attempt failed"));
        return null;
      }
      // Refused (a root that cannot be isolated, or a save that already succeeded): never wait on the hung
      // attempt for ever. Look again as for a pending stop; the attempt settles on its own.
      void running.catch(error => logger.warn({ runId: current.id, error }, "overrun native workspace finalization attempt failed"));
      return { ...due, dueAt: Date.now() + OWNERSHIP_RECHECK_MS };
    }
    if (outcome.kind === "retry") return withinPersonWait(row, { ...due, dueAt: outcome.retryAt.getTime() });
    if (outcome.kind === "waiting") {
      // A run without a fenceable epoch keeps the schedule it had before the bound.
      const stallAt = row.fenceable ? Math.min(row.classic ? Number.POSITIVE_INFINITY : await copyOutStallAt(row),
        personWaitEndsAt(row) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
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
      // A refused bound keeps its deadline armed (an active owner would otherwise drop it for ever).
      return !row.fenceable ? null : stalled ? { ...due, dueAt: Date.now() + OWNERSHIP_RECHECK_MS }
        : withinPersonWait(row, { ...due, dueAt: Date.now() + (stallAt - now()) });
    }
    if (outcome.kind === "inactive" || (outcome.kind === "completed" && outcome.operation.status === "succeeded")) return null;
    // x1 while a person's message is parked: the first attempt that timed out ends the run; no retry holds them.
    const failed = "metadata" in outcome.operation ? record(outcome.operation.metadata) : {};
    if (ATTEMPT_TIMED_OUT.test(String(record(failed.workspaceSync).cause ?? ""))) {
      const [parked] = await candidates(scope);
      if (parked && personWaitEndsAt(parked) !== null && await endStalled(parked)) return null;
    }
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
