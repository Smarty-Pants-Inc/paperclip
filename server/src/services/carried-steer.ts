import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { withSteeredCommentDisplay, type SteeredCommentDisplay } from "./conversation-steering.js";

export { PAPERCLIP_RECEIVED_MID_TASK_LABEL } from "@paperclipai/adapter-utils/server-utils";

/**
 * A carried steer: a person's message steered into a running turn that the turn
 * did not answer, so its run end put it back in the queue (wake-queue release,
 * restoreUnansweredSteersAtRunEnd: resultJson.restoredSteeredCommentIds; a
 * person's Stop under S10 C1: resultJson.stopRestoredSteeredCommentIds). The
 * next turn's input marks it 'received mid-task'; an ordinary queued message is
 * never in these lists. Returns the given ids that some OTHER run of this issue
 * restored, with the run that restored each one.
 */
export async function carriedSteerRestorers(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; commentIds: readonly string[]; currentRunId?: string | null;
}): Promise<Map<string, string>> {
  const wanted = new Set(input.commentIds);
  if (wanted.size === 0) return new Map();
  const rows = await db.select({ id: heartbeatRuns.id, resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
    input.currentRunId ? ne(heartbeatRuns.id, input.currentRunId) : undefined,
    sql`(${heartbeatRuns.resultJson} ? 'restoredSteeredCommentIds' or ${heartbeatRuns.resultJson} ? 'stopRestoredSteeredCommentIds')`,
  ));
  const restorers = new Map<string, string>();
  for (const row of rows) {
    const result = (row.resultJson ?? {}) as Record<string, unknown>;
    for (const key of ["restoredSteeredCommentIds", "stopRestoredSteeredCommentIds"] as const) {
      const ids = Array.isArray(result[key]) ? result[key] as unknown[] : [];
      for (const id of ids) if (typeof id === "string" && wanted.has(id) && !restorers.has(id)) restorers.set(id, row.id);
    }
  }
  return restorers;
}

type CarriedSteerDisplay = Omit<SteeredCommentDisplay, "steeringStatus"> & {
  steeringStatus: "accepted" | "carried" | "delivered" | null;
  carriedIntoRunId: string | null;
};
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** The release/admission handoff has its own custody, not an everlasting RPC
 * acceptance. A carried comment is ordinary PERSON input in the successor;
 * only that Pi's initial userMessage proves delivery, never admission itself.
 * Keep the live steering writer/reader unchanged: this projects its run-end
 * handoff on the same two public comment reads (POST receipt and thread GET).
 */
export async function withCarriedSteerDisplay<T extends { id: string; issueId: string; companyId: string }>(
  db: Db, comments: T[],
): Promise<Array<T & CarriedSteerDisplay>> {
  const displayed = await withSteeredCommentDisplay(db, comments);
  if (!comments.length) return [];
  const first = comments[0]!;
  const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
    context: heartbeatRuns.contextSnapshot, result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, first.companyId),
    or(eq(heartbeatRuns.nativeIssueId, first.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${first.issueId}`),
    sql`(${heartbeatRuns.contextSnapshot} ? 'carriedSteeredCommentIds'
      or ${heartbeatRuns.resultJson} ? 'queuedSteeringAcknowledgements'
      or ${heartbeatRuns.resultJson} ? 'restoredSteeredCommentIds'
      or ${heartbeatRuns.resultJson} ? 'stopRestoredSteeredCommentIds')`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  const carriers = runs.filter(run => ids(run.context?.carriedSteeredCommentIds).length);
  const reads = carriers.length ? await db.select({ runId: heartbeatRunEvents.runId, seq: heartbeatRunEvents.seq })
    .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, first.companyId),
      inArray(heartbeatRunEvents.runId, carriers.map(run => run.id)), isNotNull(heartbeatRunEvents.sourceEventId),
      eq(heartbeatRunEvents.eventType, "item.started"),
      sql`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind' = 'userMessage'`,
    )).orderBy(asc(heartbeatRunEvents.seq)) : [];
  // A comment a LIVE wake still holds (the run-end restore's conversation-comment wake, a deferred
  // batch, a person-Stop hold) is waiting to be answered, not lost: never caption it 'run_ended_before_read'
  // (gate 7, RFL frames: a person who believed that caption re-sent and got two answers).
  const liveWakes = await db.select({ key: agentWakeupRequests.idempotencyKey, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, first.companyId),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${first.issueId}`,
      sql`${agentWakeupRequests.status} in ('queued', 'deferred_issue_execution', 'claimed', 'deferred')`));
  const heldByLiveWake = new Set<string>();
  for (const wake of liveWakes) {
    const payload = object(wake.payload), context = object(payload._paperclipWakeContext);
    if (wake.key?.startsWith("conversation-comment:")) heldByLiveWake.add(wake.key.slice("conversation-comment:".length));
    for (const id of [payload.commentId, context.commentId, context.wakeCommentId, ...ids(context.wakeCommentIds)])
      if (typeof id === "string") heldByLiveWake.add(id);
  }
  return displayed.map<T & CarriedSteerDisplay>(comment => {
    const carrier = carriers.find(run => ids(run.context?.carriedSteeredCommentIds).includes(comment.id) &&
      ![...ids(run.result?.restoredSteeredCommentIds), ...ids(run.result?.stopRestoredSteeredCommentIds)].includes(comment.id));
    const read = carrier && reads.find(event => event.runId === carrier.id);
    if (carrier && (read || ["queued", "running", "scheduled_retry"].includes(carrier.status))) {
      return { ...comment, steeringStatus: read ? "delivered" : "carried", carriedIntoRunId: carrier.id,
        steeringDeliveryEventSeq: read ? Number(read.seq) : null,
        deliveryOutcome: "ordinary", steeringUnavailableReason: null };
    }
    const ended = runs.find(run => ids(run.context?.steeredCommentIds).includes(comment.id) ||
      ids(run.result?.restoredSteeredCommentIds).includes(comment.id) || ids(run.result?.stopRestoredSteeredCommentIds).includes(comment.id) ||
      ["pending", "acknowledged"].includes(String(object(object(run.result?.queuedSteeringAcknowledgements)[comment.id]).status)));
    const restored = ended && [...ids(ended.result?.restoredSteeredCommentIds), ...ids(ended.result?.stopRestoredSteeredCommentIds)].includes(comment.id);
    if (ended && (restored || (!["queued", "running", "scheduled_retry"].includes(ended.status) && comment.steeringStatus !== "delivered"))) {
      if (heldByLiveWake.has(comment.id)) {
        return { ...comment, steeringStatus: null, carriedIntoRunId: null, steeringDeliveryEventSeq: null,
          deliveryOutcome: "queued", steeringUnavailableReason: null };
      }
      return { ...comment, steeringStatus: null, carriedIntoRunId: null, steeringDeliveryEventSeq: null,
        deliveryOutcome: "ordinary", steeringUnavailableReason: "run_ended_before_read" };
    }
    return { ...comment, carriedIntoRunId: null };
  });
}

export async function carriedSteerCommentIds(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; commentIds: readonly string[]; currentRunId?: string | null;
}): Promise<Set<string>> {
  return new Set((await carriedSteerRestorers(db, input)).keys());
}
