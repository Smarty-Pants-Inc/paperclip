import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { QUEUED_SEND_AFTER_STOP_KEY, recordedUserStop, userStopBoundaryAt } from "./run-cancellation.js";

type HeldWake = {
  id: string;
  companyId: string;
  agentId?: string;
  requestedAt?: Date | string | null;
  requestedByActorType?: string | null;
  payload?: Record<string, unknown> | null;
};

/** A person's Stop of this agent's run on the task: not a Send's interrupt. */
export function isPersonStop(run: Pick<typeof heartbeatRuns.$inferSelect, "status" | "resultJson">) {
  const result = (run.resultJson ?? {}) as Record<string, unknown>;
  if (result.queuedCommentInterruptQueueId) return false;
  return Boolean(recordedUserStop(run)) || (run.status === "cancelled" && result.cancelledByActorType === "user");
}

/**
 * adopt-stopu-card6: Stop means stop. A person's messages saved before that
 * person's Stop are admitted ONLY by Send (the queue's interrupt receipt) or
 * deleted. No release drain, stranded pass or late stop receipt carries them,
 * whether or not a new message's successor ran (or finished) in between.
 * Returns the stopped run that holds this saved wake, or null.
 */
export async function personStopHoldsSavedWake(db: Db, saved: HeldWake, issueId: string): Promise<string | null> {
  // Projections (the queue view) may carry only part of the row: read it.
  const [wake] = saved.agentId && saved.requestedAt instanceof Date && saved.requestedByActorType !== undefined
    ? [{ ...saved, agentId: saved.agentId, requestedAt: saved.requestedAt }]
    : await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId, agentId: agentWakeupRequests.agentId,
      requestedAt: agentWakeupRequests.requestedAt, requestedByActorType: agentWakeupRequests.requestedByActorType,
      payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, saved.companyId), eq(agentWakeupRequests.id, saved.id)));
  if (!wake || wake.requestedByActorType !== "user") return null;
  const payload = (wake.payload ?? {}) as Record<string, unknown>;
  // The person's Send (or its dispatch fallback) is the only admission.
  if (payload.queuedCommentInterrupt != null || payload[QUEUED_SEND_AFTER_STOP_KEY] != null) return null;
  const stopped = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
    finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, wake.companyId), eq(heartbeatRuns.agentId, wake.agentId),
    inArray(heartbeatRuns.status, ["cancelled", "failed"]),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
    sql`${heartbeatRuns.finishedAt} >= ${wake.requestedAt.toISOString()}::timestamptz`,
    sql`${heartbeatRuns.resultJson}->>'queuedCommentInterruptQueueId' is null`,
  )).orderBy(desc(heartbeatRuns.finishedAt)).limit(20);
  for (const run of stopped) {
    if (!isPersonStop(run)) continue;
    const boundary = userStopBoundaryAt(run);
    if (boundary && wake.requestedAt.getTime() <= boundary.getTime()) return run.id;
  }
  return null;
}
