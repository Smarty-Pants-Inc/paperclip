import { and, eq, inArray, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { notifyDeferredWakesForIssue } from "../deferred-execution-notifications.js";
import { nativeRunHasNoProviderWork } from "../native-runtime/native-session-resume.js";
import { isBorrowedReusableSandboxLease } from "../sandbox-creation-operations.js";

/** The preparation owner calls this only after its dispatch gate unwound and
 * lease cleanup finished. Close only this run's conservative unwind hold, not
 * another run's reconciliation and never a hold backed by provider work. */
export async function settlePreDispatchStopRecovery(db: Db, companyId: string, runId: string): Promise<number> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.status, "cancelled"), eq(heartbeatRuns.errorCode, "cancelled"),
      eq(heartbeatRuns.runtimeMode, "native"),
      sql`${heartbeatRuns.resultJson}->>'preDispatchCancellationSettledAt' is not null`,
    )).for("update");
    const cancellation = run?.resultJson?.cancellation as { initiator?: { type?: string } } | undefined;
    if (!run?.nativeIssueId || (run.resultJson?.cancelledByActorType !== "user" && cancellation?.initiator?.type !== "user") ||
      !await nativeRunHasNoProviderWork(tx, { companyId, agentId: run.agentId, issueId: run.nativeIssueId }, runId)) return 0;
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
    )).for("update");
    if (leases.some(lease => !lease.releasedAt || !["released", "expired"].includes(lease.status) ||
      lease.cleanupStatus === "failed" || lease.metadata?.pendingCleanupInFlight === true)) return 0;
    const remote = leases.filter(lease => lease.provider !== "local");
    if (!remote.length) return 0;
    for (const lease of remote) {
      if (lease.status !== "released" || lease.cleanupStatus !== "success" ||
        !await isBorrowedReusableSandboxLease(tx, lease)) return 0;
    }
    const actions = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, run.nativeIssueId),
      eq(issueRecoveryActions.cause, "native_continuation_requires_reconciliation"),
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}`,
    )).for("update");
    let settled = 0;
    for (const action of actions) {
      const resolved = await issueRecoveryActionService(tx).resolveActiveForIssue({ companyId,
        sourceIssueId: run.nativeIssueId, actionId: action.id, cause: "native_continuation_requires_reconciliation",
        status: "resolved", outcome: "cancelled", resolutionNote: "stopped before dispatch" }, tx);
      if (resolved) settled++;
    }
    // EVENT: the last reconciliation gate cleared; wake each parked message in
    // this same transaction, through the existing deferred-receipt event door.
    if (settled) await notifyDeferredWakesForIssue(tx, { companyId, issueId: run.nativeIssueId });
    return settled;
  });
}
