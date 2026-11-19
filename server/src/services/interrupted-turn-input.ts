import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { issueComments, type Db } from "@paperclipai/db";
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
