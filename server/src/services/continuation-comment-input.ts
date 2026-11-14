import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rebind the parent's wake comments and first-turn input ids, not its receipt. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const carried = carryContinuationCommentInput(input.contextSnapshot);
  const candidates = (carried.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  if (candidates.length === 0) return {};
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), isNull(issueComments.deletedAt),
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const commentIds = rows.map(row => row.id);
  if (commentIds.length === 0) return {};
  return { ...carried, firstTurnQueuedInput: null, wakeCommentIds: commentIds,
    wakeCommentId: commentIds.at(-1), commentId: commentIds.at(-1) };
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
