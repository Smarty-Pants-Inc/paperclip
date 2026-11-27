import { PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS } from "@paperclipai/adapter-utils";
import { and, asc, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY } from "./reusable-sandbox-kept-marker.js";
import { prepareSupersededWarmSandboxStop } from "./sandbox-stop-and-retain.js";
import { logger } from "../middleware/logger.js";
import { nativeWorkspaceExportPendingForLease } from "./native-runtime/native-workspace-finalization-state.js";
import { allowLegacyShutdownWorkspaceCleanup } from "./legacy-shutdown-workspace-settlement.js";
import { DEFERRED_WAKE_CONTEXT_KEY } from "../lib/queued-comment-context.js";

/**
 * Warm sandbox expiry.
 *
 * A warm run ends with its reusable lease `retained` and its sandbox still
 * running, so the next turn on the same task starts warm. Once the run's warm
 * window has passed, nothing needs that sandbox running: the warm runner has
 * already gone idle. Before this, only the provider's own idle auto-stop ever
 * stopped it, and any provider activity (or a provider with no auto-stop) kept
 * it running, and billing, indefinitely.
 *
 * The warm window is the run's resolved runner idle timeout
 * (`resolveWarmRunnerIdleTimeoutMsForRun`). Acquisition saves it on the lease; the window starts when
 * the run releases the lease (`lastUsedAt`). A lease saved before the window was
 * recorded uses the longest window a run can configure, so it is never stopped
 * early.
 *
 * Due sandboxes are stopped through the existing stop-only contract
 * (`prepareSupersededWarmSandboxStop`): the lease moves to `pending_cleanup`
 * with a stop-and-retain intent, the environment cleanup sweep asks the
 * provider to stop the exact sandbox, and the confirmed stop releases the lease
 * as stopped and kept, which the next run on the task resumes. Nothing here
 * calls a provider or lists provider resources: only this instance's own lease
 * rows are judged, so another company's or environment's sandbox is never
 * touched.
 *
 * The environment cleanup worker wakes at `nextWarmSandboxStopAt` (and on every
 * lease release, and at boot), so an idle instance schedules one deadline and
 * never scans.
 */

/** Lease metadata key holding the run's warm window (ms), saved at acquisition. */
export const WARM_SANDBOX_IDLE_TIMEOUT_KEY = "warmSandboxIdleTimeoutMs";

/** Marker on the stop-and-retain intent: the warm window ended. */
export const WARM_WINDOW_EXPIRED_KEY = "warmWindowExpired";

export const WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS = 2 * 60_000;

const STOP_PAGE_SIZE = 25;

function positiveWindowSql(value: ReturnType<typeof sql>) {
  return sql`case when jsonb_typeof(${value}) = 'number' and (${value})::numeric > 0
    then (${value})::numeric end`;
}

/** Epoch ms when the lease's warm window ends. */
export function warmWindowEndsAtSql() {
  const window = sql`least(coalesce(
    ${positiveWindowSql(sql`${environmentLeases.metadata}->${WARM_SANDBOX_IDLE_TIMEOUT_KEY}`)},
    ${PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS}), ${PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS})`;
  return sql`(extract(epoch from ${environmentLeases.lastUsedAt}) * 1000 + ${window} + ${WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS})`;
}

/**
 * A retained warm sandbox that only its own ended run references. Anything
 * still using the sandbox holds it: a live run's lease on the same sandbox, a
 * run on the task that is starting now (it may be resuming this sandbox before
 * its lease is written), or an operation already in progress on the lease.
 * Superseded and replaced leases belong to the retained-orphan settle.
 * Plugin Runner task leases (`driver: "plugin"`) are excluded: their cleanup
 * releases through the plugin rather than the verified stop-only contract, so
 * it cannot promise to keep the task's files.
 */
export function warmSandboxExpiryCandidateCondition() {
  return and(
    eq(environmentLeases.status, "retained"),
    eq(environmentLeases.leasePolicy, "reuse_by_environment"),
    sql`coalesce(${environmentLeases.metadata}->>'driver', '') <> 'plugin'`,
    sql`${environmentLeases.heartbeatRunId} is not null`,
    sql`${environmentLeases.provider} is not null and ${environmentLeases.provider} <> 'local'`,
    sql`${environmentLeases.providerLeaseId} is not null`,
    sql`not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ?| array['nativeWorkspaceExportResume',
      'sandboxStopAndRetain', 'workspaceRestoreRecovery', 'workspaceRecoveryCleanup', 'runnerTaskSourceConsumer',
      'portableTaskSuccessor', 'reusableLeaseSuccessor', 'reusableSandboxLeaseSuperseded',
      ${REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY}])`,
    sql`coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') <> 'true'`,
    sql`coalesce(${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,state}', '') <> 'pending'`,
    sql`not exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
      and run.status not in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))`,
    sql`not exists (select 1 from environment_leases other where other.id <> ${environmentLeases.id}
      and other.provider = ${environmentLeases.provider} and other.provider_lease_id = ${environmentLeases.providerLeaseId}
      and other.status in ('active', 'retained', 'pending_cleanup'))`,
    sql`not exists (select 1 from heartbeat_runs other where other.company_id = ${environmentLeases.companyId}
      and other.id <> ${environmentLeases.heartbeatRunId} and other.status = 'running'
      and ${environmentLeases.issueId} is not null
      and (other.issue_id = ${environmentLeases.issueId} or other.native_issue_id = ${environmentLeases.issueId}))`,
  );
}

/** The terminal task and its workspace must both have committed. This also
 * fences a successor that is queued but has not acquired a lease yet. */
function terminalNativeTaskCondition() {
  return and(warmSandboxExpiryCandidateCondition(),
    sql`exists (select 1 from issues task where task.company_id = ${environmentLeases.companyId}
      and task.id = ${environmentLeases.issueId} and task.conversation_agent_id is null
      and task.status in ('done', 'cancelled'))`,
    sql`exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
      and run.company_id = ${environmentLeases.companyId} and run.runtime_mode = 'native'
      and run.native_issue_id = ${environmentLeases.issueId})`,
    sql`(select operation.status from workspace_operations operation
      where operation.company_id = ${environmentLeases.companyId}
        and operation.heartbeat_run_id = ${environmentLeases.heartbeatRunId}
        and operation.issue_id = ${environmentLeases.issueId} and operation.phase = 'workspace_finalize'
      order by operation.created_at desc limit 1) = 'succeeded'`,
    sql`not exists (select 1 from heartbeat_runs other where other.company_id = ${environmentLeases.companyId}
      and other.status in ('queued', 'scheduled_retry', 'running')
      and (other.issue_id = ${environmentLeases.issueId} or other.native_issue_id = ${environmentLeases.issueId}
        or (${environmentLeases.executionWorkspaceId} is not null and (
          other.context_snapshot->>'executionWorkspaceId' = ${environmentLeases.executionWorkspaceId}::text
          or exists (select 1 from issues sharing where sharing.company_id = ${environmentLeases.companyId}
            and sharing.execution_workspace_id = ${environmentLeases.executionWorkspaceId}
            and (sharing.id = other.issue_id or sharing.id = other.native_issue_id))))))`,
    // A person wake may still be outside heartbeat_runs. Repeat these fences
    // in the very UPDATE that creates the stop intent, not just before close.
    sql`not exists (select 1 from agent_wakeup_requests wake
      where wake.company_id = ${environmentLeases.companyId}
        and wake.status in ('queued', 'deferred_issue_execution')
        and (wake.payload->>'issueId' = ${environmentLeases.issueId}::text
          or wake.payload->>'taskId' = ${environmentLeases.issueId}::text
          or wake.payload->${DEFERRED_WAKE_CONTEXT_KEY}->>'issueId' = ${environmentLeases.issueId}::text
          or wake.payload->${DEFERRED_WAKE_CONTEXT_KEY}->>'taskId' = ${environmentLeases.issueId}::text))`,
    // Cover input committed even before its wake has been persisted. A comment
    // that predates the triggering run is already part of that run's input.
    sql`not exists (select 1 from issue_comments comment
      where comment.company_id = ${environmentLeases.companyId} and comment.issue_id = ${environmentLeases.issueId}
        and (comment.author_type = 'user' or comment.author_user_id is not null or comment.on_behalf_of_user_id is not null)
        and comment.created_at > (select run.created_at from heartbeat_runs run
          where run.id = ${environmentLeases.heartbeatRunId} and run.company_id = ${environmentLeases.companyId}))`,
  );
}

/** Expire a terminal native task's warm window now. Called after status commit
 * and again after lease release (either boundary may arrive first). The ordinary
 * expiry's stop-only intent and cleanup worker own provider I/O and retries.
 * A failed checkpoint never authorizes a stop; the original idle deadline stays. */
export async function stopTerminalNativeTaskWarmSandboxes(db: Db, input: {
  companyId: string; issueId: string; runId: string;
}): Promise<{ stopping: number }> {
  let stopping = 0;
  try {
    const condition = and(terminalNativeTaskCondition(), eq(environmentLeases.companyId, input.companyId),
      eq(environmentLeases.issueId, input.issueId), eq(environmentLeases.heartbeatRunId, input.runId));
    const leases = await db.select().from(environmentLeases).where(condition);
    for (const lease of leases) {
      if (!lease.environmentId) continue;
      if (await nativeWorkspaceExportPendingForLease(db, lease)
        || !await allowLegacyShutdownWorkspaceCleanup(db, lease)) continue;
      const { closeWarmNativeSessionsForEnvironment } = await import("./native-runtime/native-session-executor.js");
      const closeStartedAt = Date.now();
      const previousStamp = lease.metadata?.nativeHarnessBackup as Record<string, unknown> | undefined;
      const closed = await closeWarmNativeSessionsForEnvironment({ db, companyId: input.companyId,
        runId: input.runId, environmentId: lease.environmentId, providerLeaseId: lease.providerLeaseId!,
        reason: "terminal native task warm window ended", requireCheckpoint: true });
      if (closed.busy || closed.failed || closed.closed === 0) {
        // A per-turn backup alone does not prove a remote warm owner has
        // suspended. Never stop an allocation we did not checkpoint here.
        logger.warn({ ...input, leaseId: lease.id, closed }, "terminal native task owner was not checkpointed; keeping normal idle expiry");
        continue;
      }
      // Closing publishes a new backup on this exact lease. Re-read it rather
      // than accidentally compare-and-swapping the pre-checkpoint metadata.
      const [checkpointed] = await db.select().from(environmentLeases)
        .where(and(condition, eq(environmentLeases.id, lease.id)));
      if (!checkpointed || await nativeWorkspaceExportPendingForLease(db, checkpointed)
        || !await allowLegacyShutdownWorkspaceCleanup(db, checkpointed)) continue;
      const { verifyRecoverableNativeHarnessBackup } = await import("./native-runtime/native-harness-backup-storage.js");
      const [owner] = await db.select({ sessionId: heartbeatRuns.nativeSessionId, runnerId: heartbeatRuns.runnerInstanceId })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
      const stamp = checkpointed.metadata?.nativeHarnessBackup as Record<string, unknown> | undefined;
      const completedAt = typeof stamp?.completedAt === "string" ? Date.parse(stamp.completedAt) : NaN;
      // Matching owner identities alone can describe an earlier capture. This
      // close must have published a new, completed backup before we may stop.
      if (!owner || stamp?.normalizedSessionId !== owner.sessionId || stamp?.runnerInstanceId !== owner.runnerId
        || !Number.isFinite(completedAt) || completedAt < closeStartedAt || completedAt > Date.now()
        || stamp?.manifestSha256 === previousStamp?.manifestSha256
        || !await verifyRecoverableNativeHarnessBackup({ db, companyId: input.companyId,
        stamp: checkpointed.metadata?.nativeHarnessBackup, providerLeaseId: checkpointed.providerLeaseId! })) {
        logger.warn({ ...input, leaseId: lease.id }, "terminal native task has no recoverable owner checkpoint; keeping normal idle expiry");
        continue;
      }
      const prepared = await prepareSupersededWarmSandboxStop(db, checkpointed, {
        [WARM_WINDOW_EXPIRED_KEY]: true, warmWindowEndedAt: new Date().toISOString(), terminalNativeTask: true,
      }, condition);
      if (prepared) stopping++;
    }
  } catch (err) {
    logger.warn({ err, ...input }, "terminal native task warm expiry failed; normal idle expiry remains responsible");
  }
  return { stopping };
}

/** When the next retained warm sandbox's window ends, or null when none waits. */
export async function nextWarmSandboxStopAt(db: Db): Promise<number | null> {
  const [row] = await db.select({ next: sql<string | null>`min(${warmWindowEndsAtSql()})` })
    .from(environmentLeases).where(warmSandboxExpiryCandidateCondition());
  return row?.next == null ? null : Number(row.next);
}

/**
 * Hand every retained warm sandbox whose window has ended to the stop-only
 * cleanup. Returns how many were handed over; the cleanup sweep that follows
 * dispatches their stops at once.
 */
export async function stopWarmSandboxesPastWindow(db: Db, now = new Date()): Promise<{ stopping: number }> {
  const ends = warmWindowEndsAtSql();
  const due = await db.select({ lease: environmentLeases, endsAt: sql<string>`${ends}` }).from(environmentLeases)
    .where(and(warmSandboxExpiryCandidateCondition(), sql`${ends} <= ${now.getTime()}`))
    .orderBy(asc(environmentLeases.lastUsedAt)).limit(STOP_PAGE_SIZE);
  let stopping = 0;
  for (const { lease, endsAt } of due) {
    // The stop intent is a compare-and-swap on the exact retained row, so a run
    // that reacquired the sandbox since this read keeps it.
    const prepared = await prepareSupersededWarmSandboxStop(db, lease, {
      [WARM_WINDOW_EXPIRED_KEY]: true, warmWindowEndedAt: new Date(Number(endsAt)).toISOString(),
    });
    if (prepared) stopping++;
  }
  return { stopping };
}

export async function stopWarmSandboxesPastWindowWhenDue(db: Db, now = new Date()): Promise<{ stopping: number }> {
  const next = await nextWarmSandboxStopAt(db);
  if (next === null || next > now.getTime()) return { stopping: 0 };
  return await stopWarmSandboxesPastWindow(db, now);
}

/** Lease metadata that records the run's warm window, or nothing for a run
 * that keeps no warm runner on the sandbox. */
export function warmSandboxWindowMetadata(warmRunnerIdleTimeoutMs: number | undefined): Record<string, number> {
  return warmRunnerIdleTimeoutMs !== undefined && Number.isSafeInteger(warmRunnerIdleTimeoutMs) && warmRunnerIdleTimeoutMs > 0
    ? { [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: warmRunnerIdleTimeoutMs } : {};
}
