import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { nativeManualAdmissionHoldsExecution } from "../native-runtime/native-runner-ownership.js";
import { hasRecoveredCleanupStopReceipt } from "../remote-execution-termination.js";

/** Admission alone may leave a certified old allocation's custody work pending.
 * Keep the shared pending reader truthful for projection and cleanup owners.
 * This is the shared cleanup test with only that allocation-specific exclusion;
 * manual holds, workspace ownership, other leases and finalizations still gate. */
async function hasPendingPredecessorCleanup(db: Db, companyId: string, runId: string): Promise<boolean> {
  if (!await hasPendingRunCleanup(db, companyId, runId)) return false;
  if (await nativeManualAdmissionHoldsExecution(db, { companyId, runId })) return true;
  const recoveredStopped = (await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
    sql`${environmentLeases.metadata}->'workspaceRecoveryCleanup' is not null`,
  ))).filter(hasRecoveredCleanupStopReceipt).map(lease => lease.id);
  const [state] = await db.execute<{ pending: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM ${heartbeatRuns}
    WHERE ${heartbeatRuns.companyId} = ${companyId} AND ${heartbeatRuns.id} = ${runId} AND (
    ${heartbeatRuns.runnerProfileJson}->>'nativeWorkspaceFinalizationOwner' IS NOT NULL
    OR EXISTS (SELECT 1 FROM ${environmentLeases}
      WHERE ${environmentLeases.companyId} = ${companyId} AND ${environmentLeases.heartbeatRunId} = ${runId}
        ${recoveredStopped.length ? sql`AND ${environmentLeases.id}::text NOT IN (${sql.join(recoveredStopped.map(id => sql`${id}`), sql`, `)})` : sql``}
        -- Custody of the fenced OLD allocation is not execution on the fresh box.
        AND NOT COALESCE(
          ${heartbeatRuns.status} = 'failed'
          AND ${heartbeatRuns.resultJson}#>>'{predecessorRetirementFallback,version}' = '1'
          AND ${heartbeatRuns.resultJson}#>'{predecessorRetirementFallback,providerWorkStarted}' = 'false'::jsonb
          AND jsonb_typeof(${heartbeatRuns.resultJson}#>'{predecessorRetirementFallback,replacedProviderLeaseIds}') = 'array'
          AND (${heartbeatRuns.resultJson}#>'{predecessorRetirementFallback,replacedProviderLeaseIds}') ? ${environmentLeases.providerLeaseId}
          AND ${environmentLeases.metadata}#>>'{replaceBeforeReuse,schema}' = 'paperclip.replace-before-reuse.v1'
          AND ${environmentLeases.metadata}#>>'{replaceBeforeReuse,runId}' = ${runId}
          AND ${environmentLeases.metadata}#>'{orphanedRunLeaseRecovery,nativeCustodyUnverified}' = 'true'::jsonb
          AND ${environmentLeases.metadata}#>>'{orphanedRunLeaseRecovery,runId}' = ${runId}, false)
        AND (( ${environmentLeases.releasedAt} IS NULL AND NOT COALESCE(
            ${environmentLeases.status} = 'retained' AND ${environmentLeases.leasePolicy} = 'reuse_by_environment'
              AND ${environmentLeases.cleanupStatus} = 'success', false))
          OR ${environmentLeases.status} IN ('active', 'pending_cleanup') OR ${environmentLeases.cleanupStatus} = 'failed'
          OR COALESCE(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') <> 'false'
          OR (${heartbeatRuns.runtimeMode} = 'native' AND NOT COALESCE(
            (${environmentLeases.status} IN ('released', 'expired', 'failed')
              AND ${environmentLeases.releasedAt} IS NOT NULL AND (${environmentLeases.cleanupStatus} = 'success'
                OR (${environmentLeases.cleanupStatus} IS NULL AND (
                  (${environmentLeases.provider} = 'local' AND ${environmentLeases.providerLeaseId} IS NULL)
                  OR (${environmentLeases.provider} = 'ssh' AND ${environmentLeases.metadata}->>'driver' = 'ssh'
                    AND ${environmentLeases.providerLeaseId} LIKE 'ssh://%')))))
            OR (${environmentLeases.status} = 'retained' AND ${environmentLeases.leasePolicy} = 'reuse_by_environment'
              AND ${environmentLeases.cleanupStatus} = 'success'), false))))))
    OR EXISTS (SELECT 1 FROM ${nativeRunFinalizations}
      WHERE ${nativeRunFinalizations.companyId} = ${companyId} AND ${nativeRunFinalizations.runId} = ${runId}
        AND (${nativeRunFinalizations.leaseOwner} IS NOT NULL
          OR ${nativeRunFinalizations.phase} NOT IN ('committed', 'applied', 'terminal_failure'))) AS pending`);
  return state?.pending === true;
}
import { isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";

export type QueuedRunPredecessorHold = {
  reason: "predecessor_still_executing" | "predecessor_cleanup_pending";
  predecessorRunId: string;
};

/** The issue execution claim's ownership test (heartbeat/queue.ts claimQueuedRun). */
export function queuedRunOwnsIssue(assigneeAgentId: string | null | undefined, runAgentId: string, wakeReason: unknown) {
  return assigneeAgentId === runAgentId && wakeReason !== "source_scoped_recovery_action";
}

/** The ONE predecessor decision of the issue execution claim: is this queued
 * run held by a predecessor (its task's execution owner, or the run it
 * retries) that is still executing or whose cleanup is unsettled? The claim
 * (heartbeat/queue.ts) declines with the returned reason; the task card
 * (task-interruption-presentation.ts) names the same hold. */
export async function queuedRunPredecessorHold(db: Db, input: {
  run: { id: string; companyId: string; agentId: string; retryOfRunId: string | null; scheduledRetryReason: string | null };
  issueId: string | null;
  ownsIssue: boolean;
  executionRunId: string | null | undefined;
  isTerminal?: (status: string | null | undefined) => boolean;
  isLive?: (runId: string) => boolean;
}): Promise<QueuedRunPredecessorHold | null> {
  const { run, issueId, ownsIssue } = input;
  const isTerminal = input.isTerminal ?? isHeartbeatRunTerminalStatus;
  const isLive = input.isLive ?? (() => false);
  const executionOwnerId = run.scheduledRetryReason === "native_provider_overloaded"
    ? run.retryOfRunId : ownsIssue ? input.executionRunId : null;
  for (const previousRunId of new Set([executionOwnerId, ownsIssue ? run.retryOfRunId : null])) {
    if (!previousRunId || previousRunId === run.id) continue;
    const [previous] = await db.select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
      supersededByFreshContinuation: sql<boolean>`${heartbeatRuns.resultJson} ? 'freshContinuationSupersededAt'`,
      contextIssueId: sql<unknown>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
    })
      .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, previousRunId),
        eq(heartbeatRuns.companyId, run.companyId),
      ));
    if (previousRunId !== executionOwnerId && (previous?.agentId !== run.agentId ||
        (previous.nativeIssueId ?? previous.issueId ?? previous.contextIssueId) !== issueId)) continue;
    // A terminal result can precede workspace/lease cleanup on this or
    // another controller. Local absence alone is not a release receipt.
    if (!isTerminal(previous?.status) ||
        isLive(previousRunId)) {
      return { reason: "predecessor_still_executing", predecessorRunId: previousRunId };
    }
    // A fresh continuation replaced the predecessor: its writes are revoked
    // and it shares no workspace with this run (a fenced remote epoch or a
    // new isolated workspace), so its cleanup continues without holding it.
    if (!previous?.supersededByFreshContinuation && await hasPendingPredecessorCleanup(db, run.companyId, previousRunId)) {
      return { reason: "predecessor_cleanup_pending", predecessorRunId: previousRunId };
    }
  }
  return null;
}
