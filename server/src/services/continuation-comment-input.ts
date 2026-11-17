import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { completedPersonMessageAnswerSql } from "./person-message-answer.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** THE continuation seam every successor seed uses (wake-queue port, first-turn
 * input, readContinuationCommentInput): the predecessor's still-pending person
 * input. A person's resolution of a question the predecessor's agent asked on
 * this task IS that input, so it comes first (answer-first, 4c1eea8e): the
 * successor seeds from the answer, never the asking turn's comment.
 * `agentId` is the predecessor run's agent, from trusted run state. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const answered = await pendingContinuationInteractionInput(db, input);
  // An interaction-respond wake also names the asking turn's origin comment;
  // carrying it makes the successor's contract re-request that turn and cuts its
  // fresh history before the answer (upstream's seed carries no comment ids at all).
  if (answered.interactionIds) return answered;
  return pendingPersonCommentInput(db, input);
}

/** Rebind the parent's wake comments and first-turn input ids, not its receipt. */
async function pendingPersonCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const carried = carryContinuationCommentInput(input.contextSnapshot);
  const candidates = (carried.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  if (candidates.length === 0) return {};
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), isNull(issueComments.deletedAt),
    // Only still-pending input: carry unless ANSWERED. A message a completed run's final answer answered (attributed
    // through that run's own pending input) is never re-presented, or every continuation re-answers it (org 19:48Z).
    // A failed run's progress reply is DELIVERED only: the message is still carried (RFL F1, 21:28Z).
    sql`not ${completedPersonMessageAnswerSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const commentIds = rows.map(row => row.id);
  if (commentIds.length === 0) return {};
  return { ...carried, firstTurnQueuedInput: null, wakeCommentIds: commentIds,
    wakeCommentId: commentIds.at(-1), commentId: commentIds.at(-1) };
}

/** The predecessor's interaction references, only those a person resolved for a
 * question that agent asked on this task. They are candidates: the successor's
 * runtime selection revalidates them through the existing materializer
 * (materializeNativeInteractionResponses), so the person's answer is its input. */
export async function pendingContinuationInteractionInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const context = input.contextSnapshot && typeof input.contextSnapshot === "object" && !Array.isArray(input.contextSnapshot)
    ? input.contextSnapshot as Record<string, unknown> : {};
  const candidates = [...new Set([context.interactionId, ...(Array.isArray(context.interactionIds) ? context.interactionIds : [])]
    .filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (candidates.length === 0) return {};
  const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.id, candidates), eq(issueThreadInteractions.createdByAgentId, input.agentId),
    sql`${issueThreadInteractions.resolvedByUserId} is not null`, isNull(issueThreadInteractions.resolvedByAgentId),
    inArray(issueThreadInteractions.status, ["answered", "accepted", "rejected"]),
  )).orderBy(asc(issueThreadInteractions.resolvedAt), asc(issueThreadInteractions.id));
  const interactionIds = rows.map(row => row.id);
  return interactionIds.length ? { interactionIds, interactionId: interactionIds.at(-1) } : {};
}

/** For fresh recovery seeds whose caller keeps only a predecessor id. */
export async function readContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string | null | undefined;
}): Promise<Record<string, unknown>> {
  if (!input.runId || !UUID.test(input.runId)) return {};
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  if (!source) return {};
  // A person's answer to the predecessor's question is pending input exactly as
  // a pending comment is: an automatic successor that drops it re-asks (RFL 09:35Z).
  return pendingContinuationCommentInput(db, { companyId: input.companyId, issueId: input.issueId,
    agentId: source.agentId, contextSnapshot: source.contextSnapshot });
}
