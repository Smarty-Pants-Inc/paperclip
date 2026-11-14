import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
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

/**
 * Prevent a duplicate answer only when every carried id was answered by a
 * different run after this continuation was seeded. This is not a no-input
 * publication policy: old continuations and interim parent notes still publish.
 */
export async function continuationInputAnsweredByOtherRun(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string; createdAt: Date; contextSnapshot: unknown;
}): Promise<boolean> {
  const context = input.contextSnapshot && typeof input.contextSnapshot === "object"
    ? input.contextSnapshot as Record<string, unknown> : {};
  if (context.commentContinuation !== true) return false;
  const value = context.wakeCommentIds;
  const ids = Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && UUID.test(id)))] : [];
  if (ids.length === 0) return false;
  for (const id of ids) {
    const [answer] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "agent"), isNull(issueComments.deletedAt),
      gt(issueComments.createdAt, input.createdAt),
      sql`${issueComments.createdByRunId} is not null and ${issueComments.createdByRunId} <> ${input.runId}`,
      sql`exists (select 1 from ${heartbeatRuns} answering_run where answering_run.id = ${issueComments.createdByRunId}
        and answering_run.company_id = ${input.companyId} and (
          answering_run.context_snapshot->>'wakeCommentId' = ${id}
          or answering_run.context_snapshot->>'commentId' = ${id}
          or coalesce(answering_run.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${id}
          or coalesce(answering_run.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${id}
        ))`,
    )).limit(1);
    if (!answer) return false;
  }
  return true;
}
