import { and, eq, gt, inArray } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-retired-backup-source.js";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);

/**
 * Smarty seam (aws1, 2026-11-28). A run that reuses a held runner gets its own lease row for the
 * same sandbox, but a save stamps only the row of the run that launched the runner. The restore
 * roads read the sandbox's TIP row (the one with no reusableLeaseSuccessor), so a held, reused
 * conversation could not come back after a box loss, an environment edit or a move.
 *
 * Returns the tip row that should carry the same stamp, or null when it must not:
 * - it is the row already stamped, or not exactly one tip exists;
 * - it belongs to another company, sandbox or execution workspace;
 * - its run is still live (only a settled tip may name this copy);
 * - provider work for the session was recorded after the copy completed (the copy would rewind it).
 */
export async function nativeBackupTipLease(db: Db, input: {
  stampedLeaseId: string; companyId: string; providerLeaseId: string; executionWorkspaceId: string | null;
  normalizedSessionId: string; completedAt: string; currentRunId: string;
}): Promise<typeof environmentLeases.$inferSelect | null> {
  const rows = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.providerLeaseId, input.providerLeaseId)));
  const tips = rows.filter(row => !Object.hasOwn(row.metadata ?? {}, "reusableLeaseSuccessor"));
  if (tips.length !== 1) return null;
  const tip = tips[0]!;
  if (tip.id === input.stampedLeaseId || tip.companyId !== input.companyId || tip.providerLeaseId !== input.providerLeaseId
    || !input.executionWorkspaceId || tip.executionWorkspaceId !== input.executionWorkspaceId) return null;
  if (tip.heartbeatRunId && tip.heartbeatRunId !== input.currentRunId) {
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, tip.heartbeatRunId))).limit(1);
    if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return null;
  }
  const completedAt = new Date(input.completedAt);
  if (!Number.isFinite(completedAt.getTime())) return null;
  const later = await db.select({ runId: heartbeatRunEvents.runId }).from(heartbeatRunEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
    .where(and(
      eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.nativeSessionId, input.normalizedSessionId),
      inArray(heartbeatRunEvents.eventType, [...NATIVE_PROVIDER_DURABLE_EVENT_TYPES]),
      gt(heartbeatRunEvents.createdAt, completedAt),
    )).limit(1);
  return later.length ? null : tip;
}
