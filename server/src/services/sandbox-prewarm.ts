import { and, desc, eq, gte, inArray, ne, or, sql } from "drizzle-orm";
import type { Environment } from "@paperclipai/shared";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { environmentService, toEnvironmentLease } from "./environments.js";
import { environmentRuntimeService, reusableSandboxLeaseIsResumeCandidate } from "./environment-runtime.js";
import { legacyShutdownWorkspaceResourceProtected } from "./legacy-shutdown-workspace-settlement.js";
import { nativeWorkspaceExportPendingForResource } from "./native-runtime/native-workspace-finalization-state.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { currentControllerProcess } from "./controller-process-identity.js";
import { prepareUnconfirmedSourceSandboxStop, SANDBOX_ALLOCATION_HOLDER_STATUSES, settleStopOnlyCleanup } from "./sandbox-stop-and-retain.js";

export type SandboxPrewarmResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "resumed" | "failed"; ms: number };

type Attempt = { startedAt: number; inFlight: boolean };
// One server process; cooldown history only. No recurring idle scans.
const attempts = new WeakMap<Db, Map<string, Attempt>>();
const COOLDOWN_MS = 60_000;
const RESUME_TIMEOUT_MS = 60_000;

type PrewarmLease = {
  companyId: string; issueId: string; leaseId: string;
  inFlight: Promise<void>; resuming: boolean; runStarted: boolean;
  generation: number; timer?: ReturnType<typeof setTimeout>;
  idleStop?: Promise<void>; unsubscribe?: () => void;
};
// Only outstanding speculative work is indexed here; cooldown history stays DB-local above.
const prewarmedLeases = new Map<string, PrewarmLease>();

function forgetPrewarm(state: PrewarmLease) {
  state.unsubscribe?.();
  state.unsubscribe = undefined;
  if (prewarmedLeases.get(state.leaseId) === state) prewarmedLeases.delete(state.leaseId);
}

function runClaimedPrewarm(state: PrewarmLease) {
  state.runStarted = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.unsubscribe?.();
  state.unsubscribe = undefined;
  if (!state.resuming && !state.idleStop) forgetPrewarm(state);
}

/** Run admission cancels speculative idle work and waits before its own resume.
 * A timeout fails closed: it is not permission to race a still-settling provider.
 * Also waits for an idle stop that already dispatched, so stop cannot follow resume. */
export async function awaitPrewarmInFlight(leaseIdOrIssueId: string, timeoutMs = RESUME_TIMEOUT_MS): Promise<void> {
  const states = [...prewarmedLeases.values()].filter(state =>
    state.leaseId === leaseIdOrIssueId || state.issueId === leaseIdOrIssueId);
  if (!states.length) return;
  for (const state of states) runClaimedPrewarm(state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(states.flatMap(state => [state.inFlight, ...(state.idleStop ? [state.idleStop] : [])])),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox prewarm is still in flight")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function prewarmIdleMs() {
  const value = Number(process.env.PAPERCLIP_SANDBOX_PREWARM_IDLE_MS);
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : 300_000;
}

function issueRunScope(companyId: string, issueId: string) {
  return and(eq(heartbeatRuns.companyId, companyId),
    or(eq(heartbeatRuns.issueId, issueId), eq(heartbeatRuns.nativeIssueId, issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId}`));
}

async function issueHasRunSince(db: Db, companyId: string, issueId: string, since: number) {
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    issueRunScope(companyId, issueId), or(
      inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"]),
      gte(heartbeatRuns.createdAt, new Date(since)), gte(heartbeatRuns.startedAt, new Date(since)),
    ),
  )).limit(1);
  return Boolean(run);
}

function observeRunStart(db: Db, state: PrewarmLease) {
  return subscribeCompanyLiveEvents(state.companyId, event => {
    if (event.type !== "heartbeat.run.queued" && !(event.type === "heartbeat.run.status"
      && ["queued", "scheduled_retry", "running"].includes(String(event.payload.status)))) return;
    if (typeof event.payload.issueId === "string") {
      if (event.payload.issueId === state.issueId) runClaimedPrewarm(state);
      return;
    }
    // Queued events and older status producers may carry only the run id.
    if (typeof event.payload.runId !== "string") return;
    void db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, event.payload.runId), issueRunScope(state.companyId, state.issueId),
    )).limit(1).then(rows => { if (rows.length) runClaimedPrewarm(state); }).catch(() => {});
  });
}

function scheduleIdleStop(input: {
  db: Db; state: PrewarmLease; since: number;
  environment: Environment;
  lease: ReturnType<typeof toEnvironmentLease>;
  runtime: Pick<ReturnType<typeof environmentRuntimeService>, "retryPendingSandboxTeardown">;
}) {
  const { db, state, environment, lease, runtime } = input;
  if (state.runStarted) return;
  if (state.timer) clearTimeout(state.timer);
  const generation = ++state.generation;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    state.idleStop = (async () => {
      // A repeated hint can still be resuming this lease at the old deadline.
      // A successful repeat replaces the deadline; a failed one keeps this stop.
      await state.inFlight;
      if (generation !== state.generation || state.runStarted) return;
      let outcome = "skipped";
      try {
        const controller = await currentControllerProcess();
        const pending = await db.transaction(async tx => {
          const store = tx as unknown as Db;
          const [fresh] = await tx.select().from(environmentLeases).where(and(
            eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, state.companyId),
            eq(environmentLeases.issueId, state.issueId),
          )).for("update");
          if (!fresh || !["released", "retained"].includes(fresh.status)
            || fresh.leasePolicy !== "reuse_by_environment" || fresh.heartbeatRunId !== lease.heartbeatRunId
            || fresh.provider !== lease.provider || fresh.providerLeaseId !== lease.providerLeaseId
            || state.runStarted || await issueHasRunSince(store, state.companyId, state.issueId, input.since)
            || await nativeWorkspaceExportPendingForResource(store, toEnvironmentLease(fresh), null)
            || await legacyShutdownWorkspaceResourceProtected(store, fresh)) return null;
          const [holder] = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
            ne(environmentLeases.id, fresh.id), eq(environmentLeases.provider, fresh.provider!),
            eq(environmentLeases.providerLeaseId, fresh.providerLeaseId!),
            inArray(environmentLeases.status, [...SANDBOX_ALLOCATION_HOLDER_STATUSES]),
          )).limit(1);
          if (holder || state.runStarted) return null;
          // Existing durable stop-only road, never ordinary release/destroy.
          const prepared = await prepareUnconfirmedSourceSandboxStop(store, fresh);
          if (!prepared) return null;
          const attemptId = String(prepared.metadata!.pendingCleanupAttemptId);
          const [claimed] = await tx.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} ||
            ${JSON.stringify({ pendingCleanupInFlight: true, pendingCleanupLeaseExpiresAtMs: Date.now() + 15 * 60_000,
              pendingCleanupController: { ...controller, attemptId } })}::jsonb`,
          }).where(eq(environmentLeases.id, prepared.id)).returning();
          return claimed ?? null;
        });
        if (pending) {
          const attemptId = String(pending.metadata!.pendingCleanupAttemptId);
          let settled;
          try {
            const receipt = await runtime.retryPendingSandboxTeardown({ environment, lease: toEnvironmentLease(pending) });
            settled = await settleStopOnlyCleanup(db, pending, { attemptId, receipt });
          } catch {
            // The existing sweep owns any failed stop-only retry, still never destruction.
            await settleStopOnlyCleanup(db, pending, { attemptId });
          }
          outcome = (settled?.metadata?.remoteExecutionTermination as { state?: string } | undefined)?.state === "stopped"
            ? "stopped" : "failed";
        }
      } catch { outcome = "failed"; }
      logger.info({ issueId: state.issueId, leaseId: state.leaseId, outcome }, "sandbox prewarm idle stop");
    })().finally(() => {
      state.idleStop = undefined;
      if (!state.timer && !state.resuming) forgetPrewarm(state);
    });
  }, prewarmIdleMs());
  state.timer.unref();
}

export function sandboxPrewarmEnabled(): boolean {
  return process.env.PAPERCLIP_SANDBOX_PREWARM === "true";
}

/** Best-effort readiness only. Never acquire a lease, transfer ownership, or start a run. */
export async function prewarmIssueSandbox(input: {
  db: Db;
  companyId: string;
  issueId: string;
  agentId: string;
  actor: { actorType: "user"; actorId: string };
  // Routes supply the existing runtime, with its verified plugin worker manager.
  environmentRuntime?: Pick<ReturnType<typeof environmentRuntimeService>, "resumeRunLease" | "retryPendingSandboxTeardown">;
}): Promise<SandboxPrewarmResult> {
  if (!sandboxPrewarmEnabled()) return { outcome: "skipped", reason: "disabled" };
  const startedAt = Date.now();
  let byIssue = attempts.get(input.db);
  if (!byIssue) attempts.set(input.db, byIssue = new Map());
  const key = `${input.companyId}:${input.issueId}`;
  const previous = byIssue.get(key);
  if (previous?.inFlight) return { outcome: "skipped", reason: "in_flight" };
  if (previous && startedAt - previous.startedAt < COOLDOWN_MS) return { outcome: "skipped", reason: "cooldown" };
  for (const [id, attempt] of byIssue) {
    if (!attempt.inFlight && startedAt - attempt.startedAt >= COOLDOWN_MS) byIssue.delete(id);
  }
  const attempt = { startedAt, inFlight: true };
  byIssue.set(key, attempt);

  let prewarmLease: PrewarmLease | undefined;
  let finishResume: (() => void) | undefined;
  const issueHasLiveRun = async () => {
    const [run] = await input.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      inArray(heartbeatRuns.status, ["queued", "scheduled_retry", "running"]),
      or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
        sql`${heartbeatRuns.contextSnapshot}->>'taskId' = ${input.issueId}`),
    )).limit(1);
    return Boolean(run);
  };

  try {
    if (await issueHasLiveRun()) return { outcome: "skipped", reason: "live_run" };
    // Same newest-first order as environmentService.listLeases at run start.
    // Scope SQL first: even workspace-backed leases must belong to this exact task.
    const rows = await input.db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.issueId, input.issueId),
      sql`${environmentLeases.metadata}->>'agentId' = ${input.agentId}`,
    )).orderBy(desc(environmentLeases.lastUsedAt), desc(environmentLeases.createdAt));
    const environments = environmentService(input.db);
    for (const row of rows) {
      const lease = toEnvironmentLease(row);
      if (!reusableSandboxLeaseIsResumeCandidate({ lease, heartbeatRunId: null,
        executionWorkspaceId: lease.executionWorkspaceId, issueId: input.issueId, agentId: input.agentId })) continue;
      // The same resource-recovery fences as run-start selection, without its cleanup side effects.
      if (await nativeWorkspaceExportPendingForResource(input.db, lease, null)
        || await legacyShutdownWorkspaceResourceProtected(input.db, lease)) continue;
      // The stop-only road requires the historical run identity; ad-hoc leases cannot be prewarmed safely.
      if (!lease.environmentId || !lease.heartbeatRunId || !lease.provider || !lease.providerLeaseId) continue;
      const environment = await environments.getById(lease.environmentId);
      if (!environment || environment.driver !== "sandbox") continue;
      // A message may have arrived while selecting the retained lease.
      if (await issueHasLiveRun()) return { outcome: "skipped", reason: "live_run" };
      const runtime = input.environmentRuntime ?? environmentRuntimeService(input.db);
      const existing = prewarmedLeases.get(lease.id);
      if (existing?.idleStop) return { outcome: "skipped", reason: "in_flight" };
      const inFlight = new Promise<void>(resolve => { finishResume = resolve; });
      prewarmLease = existing ?? { companyId: input.companyId, issueId: input.issueId, leaseId: lease.id,
        inFlight, resuming: true, runStarted: false, generation: 0 };
      prewarmLease.inFlight = inFlight;
      prewarmLease.resuming = true;
      prewarmLease.unsubscribe ??= observeRunStart(input.db, prewarmLease);
      prewarmedLeases.set(lease.id, prewarmLease);
      const resumed = await runtime.resumeRunLease({ environment, lease, timeoutMs: RESUME_TIMEOUT_MS,
        ...(typeof lease.metadata?.remoteCwd === "string" ? { requestedCwd: lease.metadata.remoteCwd } : {}),
      });
      if (!resumed || resumed.providerLeaseId !== lease.providerLeaseId || resumed.metadata?.expired === true) {
        return { outcome: "failed", ms: Date.now() - startedAt };
      }
      scheduleIdleStop({ db: input.db, state: prewarmLease, since: startedAt, environment, lease, runtime });
      await logActivity(input.db, { companyId: input.companyId, ...input.actor,
        action: "environment.sandbox_prewarmed", entityType: "environment_lease", entityId: lease.id,
        issueId: input.issueId, agentId: input.agentId, details: { environmentId: environment.id } });
      return { outcome: "resumed", ms: Date.now() - startedAt };
    }
    return { outcome: "skipped", reason: "no_reusable_lease" };
  } catch {
    // Prewarming is optional. Run admission remains the authority for reporting failures and recovery.
    return { outcome: "failed", ms: Date.now() - startedAt };
  } finally {
    attempt.inFlight = false;
    finishResume?.();
    if (prewarmLease) {
      prewarmLease.resuming = false;
      if (!prewarmLease.timer && !prewarmLease.idleStop) forgetPrewarm(prewarmLease);
    }
  }
}
