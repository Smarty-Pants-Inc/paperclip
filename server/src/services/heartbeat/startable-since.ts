import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/**
 * RFL 01:00Z ruling (a): a hold that held a queued run has cleared, so stamp
 * heartbeat_runs.startable_since on the runs it was holding. The card's person
 * start bound counts from the LATER of enqueue and this stamp; the dispatcher
 * still decides every start under its own locks. Idempotent: the latest clear
 * wins and an earlier clear never moves the stamp back. Agent-level holds
 * (setup, pause, budget pause, external setup) scope by agent; task-level
 * holds (native session cleanup) by task. The sandbox cleanup hold's writer is
 * the lease trigger in migration 0496.
 */
export async function stampQueuedRunsStartable(db: Pick<Db, "update">,
  scope: { companyId: string; agentId?: string; issueIds?: string[] }, at: Date = new Date()): Promise<void> {
  if (!scope.agentId && !scope.issueIds?.length) return;
  await db.update(heartbeatRuns)
    .set({ startableSince: sql`greatest(coalesce(${heartbeatRuns.startableSince}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)` })
    .where(and(eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.status, "queued"), isNull(heartbeatRuns.startedAt),
      scope.agentId ? eq(heartbeatRuns.agentId, scope.agentId) : undefined,
      scope.issueIds?.length ? inArray(heartbeatRuns.issueId, scope.issueIds) : undefined));
}
