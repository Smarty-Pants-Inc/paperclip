import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { issueComments, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromRunContext } from "./issue-queued-comment-queue.js";
import { answeredPersonMessageIds } from "./person-message-answer.js";

/**
 * A person's Interrupt ("Interrupt the active turn and send queued messages")
 * cuts the live turn before it answers. That turn's own person messages are
 * then still unanswered, so they go to the successor FIRST, ahead of the held
 * ones. Returns those message ids in their original order: person-authored,
 * not deleted, non-empty, not already held, and not answered as the ONE answer
 * function decides (answeredPersonMessageIds / answeredPersonMessageSql): a
 * turn that already answered with an AGENT reply is not answered twice, while
 * a system notice attributed to the run is no answer and never drops the input.
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
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, ids), eq(issueComments.authorType, "user"),
    isNull(issueComments.createdByRunId), isNull(issueComments.deletedAt),
    sql`nullif(trim(${issueComments.body}), '') is not null`,
  ));
  const answered = await answeredPersonMessageIds(db, { companyId: input.companyId, issueId: input.issueId,
    commentIds: rows.map(row => row.id) });
  const found = new Set(rows.map(row => row.id).filter(id => !answered.has(id)));
  return ids.filter(id => found.has(id));
}

/**
 * An Interrupt queue is a saved click, not proof its messages are still owed.
 * Another wake can carry and answer them first (Paul's SMA-4, 11-19: MSG2 was
 * answered by 55499099 while its Interrupt queue 47003c5d stayed saved, then
 * woke 668feb70 on MSG2 a second time). Returns the ids already answered, as
 * the ONE answer function decides (answeredPersonMessageSql via
 * answeredPersonMessageIds, person-message-answer.ts); no partial copy of it.
 * Its failed-carrier clause (L1b) keeps a message whose own carrier failed
 * owed. A fully answered saved Interrupt is cancelled as delivered
 * (QUEUED_MESSAGES_DELIVERED_REASON, run-control resumeSavedComments).
 */
export async function answeredCarriedCommentIds(
  db: Db,
  input: { companyId: string; issueId: string; commentIds: string[] },
): Promise<Set<string>> {
  return answeredPersonMessageIds(db, input);
}
