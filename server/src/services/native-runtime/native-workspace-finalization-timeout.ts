import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { recordNativeFinalizationFailure } from "./native-run-finalizer.js";

// Retry deadlines are 30 seconds apart. Ten minutes gives an interrupted retry
// twenty ordinary recovery opportunities without timing out a live copy-back:
// the terminal writer rechecks both the lease and physical owner receipt.
export const NATIVE_WORKSPACE_FINALIZATION_OVERDUE_MS = 10 * 60_000;
// A boot repair is not permission to resurrect yesterday's conversation.
export const NATIVE_WORKSPACE_FINALIZATION_HISTORICAL_MS = 24 * 60 * 60_000;
export const NATIVE_WORKSPACE_FINALIZATION_SWEEP_MS = 30_000;

/** Boot and active-run recovery share this durable deadline, not a process timer.
 * Never cancel or steal an exporter: a live lease/owner or successful barrier
 * wins even if it appeared after discovery (rechecked by the terminal writer).
 */
export async function expireOverdueNativeWorkspaceFinalizations(db: Db, scope: {
  companyId?: string; runId?: string; now?: Date; onDeferredDeadline?: (at: number) => void;
  onExpired?: (input: { runId: string; companyId: string; agentId: string; succeeded: boolean }) => Promise<void>;
} = {}) {
  const now = scope.now ?? new Date();
  const rows = await db.select({ runId: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId, dueAt: nativeRunFinalizations.nextAttemptAt })
    .from(nativeRunFinalizations)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, nativeRunFinalizations.runId),
      eq(heartbeatRuns.companyId, nativeRunFinalizations.companyId)))
    .innerJoin(nativeRunResults, and(eq(nativeRunResults.id, nativeRunFinalizations.resultId),
      eq(nativeRunResults.runId, heartbeatRuns.id), eq(nativeRunResults.companyId, heartbeatRuns.companyId),
      eq(nativeRunResults.issueId, nativeRunFinalizations.issueId), eq(nativeRunResults.schemaStatus, "accepted")))
    .where(and(eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"),
      eq(nativeRunFinalizations.phase, "retryable_failure"), isNotNull(nativeRunFinalizations.nextAttemptAt),
      or(isNull(nativeRunFinalizations.leaseOwner), isNull(nativeRunFinalizations.leaseExpiresAt), lte(nativeRunFinalizations.leaseExpiresAt, now)),
      sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceFinalizationOwner' is null`,
      scope.companyId ? eq(heartbeatRuns.companyId, scope.companyId) : undefined,
      scope.runId ? eq(heartbeatRuns.id, scope.runId) : undefined));
  for (const row of rows) {
    const deadline = row.dueAt!.getTime() + NATIVE_WORKSPACE_FINALIZATION_OVERDUE_MS;
    if (deadline > now.getTime()) {
      scope.onDeferredDeadline?.(Math.min(deadline, now.getTime() + NATIVE_WORKSPACE_FINALIZATION_SWEEP_MS));
      continue;
    }
    const outcome = await recordNativeFinalizationFailure({ db, runId: row.runId,
      error: new Error("native_workspace_sync_out_retry_exhausted"),
      failureScope: "workspace", permanent: true, projectRunStatus: true,
      workspaceRetryTimeout: { overdueBefore: new Date(now.getTime() - NATIVE_WORKSPACE_FINALIZATION_OVERDUE_MS),
        historical: now.getTime() - row.dueAt!.getTime() >= NATIVE_WORKSPACE_FINALIZATION_HISTORICAL_MS },
    });
    if (outcome.phase === "terminal_failure") await scope.onExpired?.({
      runId: row.runId, companyId: row.companyId, agentId: row.agentId, succeeded: false,
    });
  }
}
