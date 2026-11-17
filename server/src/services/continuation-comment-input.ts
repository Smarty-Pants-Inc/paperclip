import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { carriedInLiveRunSql, completedPersonMessageAnswerSql } from "./person-message-answer.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rebind the parent's wake comments and first-turn input ids, not its receipt. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; contextSnapshot: unknown;
  /** The source run's agent and id: another LIVE run of that agent owning the input blocks a second carry. */
  liveOwner?: { agentId: string; runId: string };
}): Promise<Record<string, unknown>> {
  const carried = carryContinuationCommentInput(input.contextSnapshot);
  const candidates = (carried.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  if (candidates.length === 0) return {};
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), isNull(issueComments.deletedAt),
    // Only still-pending input: a comment ANSWERED (a COMPLETED run's final answer, RFL 21:28Z) by a run that carried it as pending
    // input is never re-presented, or every continuation re-answers it (the re-wake loop, org 19:48Z). A reply
    // to a later input alone does not settle it (R-ONCE, RFL 18:19Z): it rides into the next run's input.
    sql`not ${completedPersonMessageAnswerSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
    // Carried in a LIVE run's pending input blocks a second promotion (RFL 19:4xZ); it is not an answer. The
    // source run itself never blocks its own input.
    ...(input.liveOwner ? [sql`not ${carriedInLiveRunSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, agentId: sql`${input.liveOwner.agentId}::uuid`,
      excludeRunId: sql`${input.liveOwner.runId}::uuid` })}`] : []),
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
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot, agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  return source ? pendingContinuationCommentInput(db, { companyId: input.companyId, issueId: input.issueId,
    contextSnapshot: source.contextSnapshot, liveOwner: { agentId: source.agentId, runId: input.runId } }) : {};
}
