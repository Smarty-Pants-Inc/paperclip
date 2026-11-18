import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { answeredPersonMessageSql } from "./person-message-answer.js";
import { runOwnInputIds, senderStoppedWhileAnswering } from "./recovery/person-stopped-message.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CarryInput = { companyId: string; issueId: string; contextSnapshot: unknown };

/** The sender's own Stop (RFL ruling 8): an input whose newest carrying run its sender stopped after the run had
 * started answering it is not carried again. The ONE rule: senderStoppedWhileAnswering (person-stopped-message.ts). */
function senderStoppedCheck(db: Pick<Db, "select">, input: CarryInput) {
  let runs: Array<{ id: string; status: string; errorCode: string | null; contextSnapshot: unknown }> | undefined;
  return async (message: { id: string; authorUserId: string | null }) => {
    if (!message.authorUserId) return false;
    runs ??= await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
      contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(50);
    // Newest first: the newest run that carries the input as its own decides; only a cancelled one can be a Stop.
    const carrier = runs.find(run => runOwnInputIds(run.contextSnapshot).includes(message.id));
    if (carrier?.status !== "cancelled") return false;
    const [stopped] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, carrier.id)));
    return senderStoppedWhileAnswering(db, input.companyId, { ...carrier, resultJson: stopped?.resultJson ?? null }, message);
  };
}

/** The predecessor's still-pending person input: its typed messages and the person's answers to its cards. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: CarryInput): Promise<Record<string, unknown>> {
  return { ...await pendingPersonCommentInput(db, input), ...await pendingContinuationInteractionInput(db, input) };
}

/** The predecessor's interaction references, only those a PERSON resolved for a card an agent asked on this task
 * (answered, accepted or rejected) that is not ANSWERED yet (the one rule, keyed by the card id and its answer
 * time) and whose run the sender did not stop while it was answering. The successor's runtime selection
 * revalidates them (runtime-selection.ts materializeNativeInteractionResponses reads context.interactionIds). */
async function pendingContinuationInteractionInput(db: Pick<Db, "select">, input: CarryInput): Promise<Record<string, unknown>> {
  const context = (input.contextSnapshot && typeof input.contextSnapshot === "object" ? input.contextSnapshot : {}) as Record<string, unknown>;
  const candidates = [...new Set([context.interactionId, ...(Array.isArray(context.interactionIds) ? context.interactionIds : [])]
    .filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (candidates.length === 0) return {};
  const senderStopped = senderStoppedCheck(db, input);
  const rows = await db.select({ id: issueThreadInteractions.id, authorUserId: issueThreadInteractions.resolvedByUserId })
    .from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.id, candidates), isNotNull(issueThreadInteractions.createdByAgentId),
    isNotNull(issueThreadInteractions.resolvedByUserId), isNull(issueThreadInteractions.resolvedByAgentId),
    isNotNull(issueThreadInteractions.resolvedAt), inArray(issueThreadInteractions.status, ["answered", "accepted", "rejected"]),
    sql`not ${answeredPersonMessageSql({ id: sql`${issueThreadInteractions.id}`, companyId: sql`${issueThreadInteractions.companyId}`,
      issueId: sql`${issueThreadInteractions.issueId}`, createdAt: sql`${issueThreadInteractions.resolvedAt}` })}`,
  )).orderBy(asc(issueThreadInteractions.resolvedAt), asc(issueThreadInteractions.id));
  const ids: string[] = [];
  for (const row of rows) if (!await senderStopped(row)) ids.push(row.id);
  return ids.length ? { interactionIds: ids, interactionId: ids.at(-1) } : {};
}

/** Rebind the parent's wake comments and first-turn input ids, not its receipt. */
async function pendingPersonCommentInput(db: Pick<Db, "select">, input: CarryInput): Promise<Record<string, unknown>> {
  const carried = carryContinuationCommentInput(input.contextSnapshot);
  const candidates = (carried.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  if (candidates.length === 0) return {};
  const senderStopped = senderStoppedCheck(db, input);
  const rows = await db.select({ id: issueComments.id, authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), isNull(issueComments.deletedAt),
    // Only still-pending input: a comment that is ANSWERED (a reply after it from a run that SUCCEEDED and whose own
    // input names it; person-message-answer.ts, the one rule) is never re-presented, or every continuation
    // re-answers it (the re-wake loop, org 19:48Z). A failed run's reply, or a reply to a later message, leaves it owed.
    sql`not ${answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const commentIds: string[] = [];
  for (const row of rows) if (!await senderStopped(row)) commentIds.push(row.id);
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
