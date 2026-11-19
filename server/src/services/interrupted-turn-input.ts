import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromRunContext } from "./issue-queued-comment-queue.js";

/**
 * A person's Interrupt ("Interrupt the active turn and send queued messages")
 * cuts the live turn before it answers. That turn's own person messages are
 * then still unanswered, so they go to the successor FIRST, ahead of the held
 * ones. Returns those message ids in their original order: person-authored,
 * not deleted, non-empty, not already held, and only while the interrupted
 * turn has saved no reply of its own (a turn that already answered is not
 * answered twice).
 */
export async function interruptedTurnUnansweredCommentIds(
  db: Db,
  input: { companyId: string; issueId: string; run: { id: string; contextSnapshot: unknown }; held: string[] },
): Promise<string[]> {
  const context = (input.run.contextSnapshot ?? {}) as Record<string, unknown>;
  const ids = [...new Set([
    ...queuedCommentIdsFromRunContext(context),
    ...(typeof context.wakeCommentId === "string" ? [context.wakeCommentId] : []),
  ])].filter(id => !input.held.includes(id));
  if (!ids.length) return [];
  const [reply] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.createdByRunId, input.run.id), isNull(issueComments.deletedAt),
  )).limit(1);
  if (reply) return [];
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, ids), eq(issueComments.authorType, "user"),
    isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
    sql`nullif(trim(${issueComments.body}), '') is not null`,
  ));
  const found = new Set(rows.map(row => row.id));
  return ids.filter(id => found.has(id));
}

/**
 * An Interrupt queue is a saved click, not proof its messages are still owed.
 * Another wake can carry and answer them first (Paul's SMA-4, 11-19: MSG2 was
 * answered by 55499099 while its Interrupt queue 47003c5d stayed saved, then
 * woke 668feb70 on MSG2 a second time). Returns the ids that a run CARRYING
 * that exact message already answered with a reply of its own (the
 * carried-message clause of answeredPersonMessageSql, person-message-answer.ts,
 * without its later-input widening, which would drop a message that never
 * reached the agent). The release drain makes the same check
 * (wake-queue getQueuedCommentLiveness -> QUEUED_MESSAGES_DELIVERED_REASON).
 */
export async function answeredCarriedCommentIds(
  db: Db,
  input: { companyId: string; issueId: string; commentIds: string[] },
): Promise<Set<string>> {
  if (!input.commentIds.length) return new Set();
  const replies = await db.select({ runId: issueComments.createdByRunId }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "agent"), isNull(issueComments.deletedAt), isNotNull(issueComments.createdByRunId),
  ));
  const runIds = [...new Set(replies.map(reply => reply.runId!))];
  if (!runIds.length) return new Set();
  const runs = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, runIds),
  ));
  const carried = new Set<string>();
  for (const run of runs) {
    const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
    const firstTurn = (context.firstTurnQueuedInput ?? {}) as Record<string, unknown>;
    for (const id of [context.wakeCommentId, ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
      ...(Array.isArray(firstTurn.commentIds) ? firstTurn.commentIds : [])]) if (typeof id === "string") carried.add(id);
  }
  return new Set(input.commentIds.filter(id => carried.has(id)));
}
