import { and, eq, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import type { ProviderResourceDisposition } from "./environment-runtime.js";
import { providerResourceDispositionForTerminalRun } from "./runner-environment-lifecycle.js";

const retentionKeys = ["warmFailureStreak", "warmFailureRunId", "warmRetentionReasonCode"] as const;
const failureLimitReason = "warm_retention_failure_limit";

/** Provider metadata cannot supply the server's allocation health accounting.
 * Only the locked, same-allocation predecessor may transfer it to a new owner.
 */
export function inheritWarmRetentionMetadata(previous: Record<string, unknown> | null | undefined,
  metadata: Record<string, unknown> | null | undefined) {
  const result = { ...metadata };
  for (const key of retentionKeys) {
    delete result[key];
    if (Object.hasOwn(previous ?? {}, key)) result[key] = previous![key];
  }
  return result;
}

/** Count each settled turn once, durably, before any provider stop/retention.
 * Both normal teardown and recovered native settlement use this runtime fence.
 * Never hold database locks across provider I/O.
 */
export async function settleWarmRetention(db: Db, lease: typeof environmentLeases.$inferSelect,
  desired: ProviderResourceDisposition | undefined) {
  if (lease.leasePolicy !== "reuse_by_environment" || !lease.heartbeatRunId) return { lease, disposition: desired };
  return db.transaction(async tx => {
    // Run -> lease matches terminalization's ownership lock order.
    const [run] = await tx.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
      providerWorkStarted: sql<unknown>`${heartbeatRuns.resultJson}#>'{executionRecovery,providerWorkStarted}'` })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, lease.heartbeatRunId!),
        eq(heartbeatRuns.companyId, lease.companyId))).for("update");
    if (!run || !["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status)) {
      return { lease, disposition: desired };
    }
    const [current] = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.id, lease.id),
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.heartbeatRunId, lease.heartbeatRunId!))).for("update");
    if (!current || !["active", "pending_cleanup"].includes(current.status)) return null;
    let disposition = providerResourceDispositionForTerminalRun(desired, run.status, run.errorCode, run.providerWorkStarted);
    // Safety stops and explicit stop/destroy choices never become warm retention.
    if (run.status !== "succeeded" && disposition !== "keep_running") return { lease: current, disposition };
    const metadata = { ...current.metadata };
    if (run.status === "succeeded" || metadata.warmFailureRunId !== lease.heartbeatRunId) {
      const prior = typeof metadata.warmFailureStreak === "number" && Number.isSafeInteger(metadata.warmFailureStreak)
        && metadata.warmFailureStreak >= 0 ? metadata.warmFailureStreak : 0;
      metadata.warmFailureStreak = run.status === "succeeded" ? 0 : Math.min(prior + 1, Number.MAX_SAFE_INTEGER);
      metadata.warmFailureRunId = lease.heartbeatRunId;
      delete metadata.warmRetentionReasonCode;
    }
    if (run.status !== "succeeded" && typeof metadata.warmFailureStreak === "number" && metadata.warmFailureStreak >= 2) {
      disposition = "stop_and_retain";
      metadata.warmRetentionReasonCode = failureLimitReason;
      await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
        || ${JSON.stringify({ warmRetentionReasonCode: failureLimitReason })}::jsonb` })
        .where(and(eq(heartbeatRuns.id, lease.heartbeatRunId!), eq(heartbeatRuns.companyId, lease.companyId)));
    }
    const [updated] = await tx.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, current.id)).returning();
    return { lease: updated!, disposition };
  });
}
