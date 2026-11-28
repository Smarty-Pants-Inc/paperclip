import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { environmentService, toEnvironmentLease } from "./environments.js";
import { environmentRuntimeService, reusableSandboxLeaseIsResumeCandidate } from "./environment-runtime.js";
import { legacyShutdownWorkspaceResourceProtected } from "./legacy-shutdown-workspace-settlement.js";
import { nativeWorkspaceExportPendingForResource } from "./native-runtime/native-workspace-finalization-state.js";
import { logActivity } from "./activity-log.js";

export type SandboxPrewarmResult =
  | { outcome: "skipped"; reason: string }
  | { outcome: "resumed" | "failed"; ms: number };

type Attempt = { startedAt: number; inFlight: boolean };
// One test-server process; no durable claims, timers, retries, or idle scans.
const attempts = new WeakMap<Db, Map<string, Attempt>>();
const COOLDOWN_MS = 60_000;
const RESUME_TIMEOUT_MS = 60_000;

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
  environmentRuntime?: Pick<ReturnType<typeof environmentRuntimeService>, "resumeRunLease">;
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
      if (!lease.environmentId) continue;
      const environment = await environments.getById(lease.environmentId);
      if (!environment || environment.driver !== "sandbox") continue;
      // A message may have arrived while selecting the retained lease.
      if (await issueHasLiveRun()) return { outcome: "skipped", reason: "live_run" };
      const runtime = input.environmentRuntime ?? environmentRuntimeService(input.db);
      const resumed = await runtime.resumeRunLease({ environment, lease, timeoutMs: RESUME_TIMEOUT_MS,
        ...(typeof lease.metadata?.remoteCwd === "string" ? { requestedCwd: lease.metadata.remoteCwd } : {}),
      });
      if (!resumed || resumed.providerLeaseId !== lease.providerLeaseId || resumed.metadata?.expired === true) {
        return { outcome: "failed", ms: Date.now() - startedAt };
      }
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
  }
}
