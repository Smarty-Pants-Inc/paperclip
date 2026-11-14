import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { answeredPersonMessageSql } from "./person-message-answer.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rebind the parent's still-unanswered person input, not its rendered prompt or
 * delivery receipt. Delivered to a failed provider is not the same as answered.
 */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const carried = carryContinuationCommentInput(input.contextSnapshot);
  if (carried.commentContinuation !== true) return {};
  const candidates = (carried.wakeCommentIds as string[]).filter(id => UUID.test(id));
  const rows = candidates.length === 0 ? [] : await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
    sql`not ${answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const commentIds = rows.map(row => row.id);
  return { ...carried, firstTurnQueuedInput: null, wakeCommentIds: commentIds, wakeCommentId: commentIds.at(-1) ?? null, commentId: commentIds.at(-1) ?? null };
}

/** For fresh recovery seeds whose caller keeps only a predecessor id. */
export async function readContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string | null | undefined;
}): Promise<Record<string, unknown>> {
  if (!input.runId || !UUID.test(input.runId)) return {};
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  return source ? pendingContinuationCommentInput(db, { ...input, contextSnapshot: source.contextSnapshot }) : {};
}

/** Compatibility for already-queued continuations created before input carry.
 * Ordinary task work (no comment-woken parent) must never be suppressed.
 */
export async function commentContinuationHasNoPendingInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; retryOfRunId?: string | null; contextSnapshot: Record<string, unknown> | null;
}): Promise<boolean> {
  const context = input.contextSnapshot ?? {};
  const parentId = input.retryOfRunId ?? context.retryOfRunId ?? context.previousRunId;
  if (context.commentContinuation !== true && typeof parentId !== "string") return false;
  const parent = typeof parentId === "string" ? await readContinuationCommentInput(db, { ...input, runId: parentId }) : {};
  const current = await pendingContinuationCommentInput(db, { ...input, contextSnapshot: context });
  if (context.commentContinuation !== true && parent.commentContinuation !== true) return false;
  // The reply must be bound to input THIS run received; an unread parent id is
  // not permission to publish a recycled answer on its behalf.
  return !Array.isArray(current.wakeCommentIds) || current.wakeCommentIds.length === 0;
}
