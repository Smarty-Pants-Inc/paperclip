import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { carriedInLiveRunSql, completedPersonMessageAnswerSql } from "./person-message-answer.js";
import { senderStoppedWhileAnswering } from "./recovery/person-stopped-message.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function interactionIds(value: unknown): string[] {
  const context = record(value);
  return [...new Set([context.interactionId, ...(Array.isArray(context.interactionIds) ? context.interactionIds : [])]
    .filter((id): id is string => typeof id === "string" && UUID.test(id)))];
}

/** Discovery only. The whole Stop decision belongs to senderStoppedWhileAnswering. */
function carriesInputSql(id: SQL): SQL {
  return sql`(${heartbeatRuns.contextSnapshot}->>'wakeCommentId' = ${id}::text
    or ${heartbeatRuns.contextSnapshot}->>'commentId' = ${id}::text
    or coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${id}::text
    or coalesce(${heartbeatRuns.contextSnapshot}->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${id}::text
    or ${heartbeatRuns.contextSnapshot}->>'interactionId' = ${id}::text
    or coalesce(${heartbeatRuns.contextSnapshot}->'interactionIds', '[]'::jsonb) ? ${id}::text)`;
}

type CarryInput = { companyId: string; issueId: string; agentId: string; contextSnapshot: unknown;
  /** The source run's agent and id: another LIVE run of that agent owning a card answer blocks a second carry. */
  liveOwner?: { agentId: string; runId: string } };

/** rf5 A3: the person's own Stop of the run that had STARTED answering this input. */
function senderStoppedCheck(db: Pick<Db, "select">, input: CarryInput) {
  const issueRun = or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`);
  return async (message: { id: string; authorUserId: string | null }) => {
    if (!message.authorUserId) return false;
    const [carrier] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), issueRun,
        ...(input.liveOwner ? [eq(heartbeatRuns.agentId, input.liveOwner.agentId)] : []),
        carriesInputSql(sql`${message.id}::uuid`)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    // The shared stop helper only reads select; keep the carry's existing narrow DB contract.
    return senderStoppedWhileAnswering(db as Db, input.companyId, carrier, message);
  };
}

/** THE continuation seam every successor seed uses (wake-queue port, first-turn
 * input, readContinuationCommentInput): the predecessor's still-pending person
 * input. A person's resolution of a question the predecessor's agent asked on
 * this task IS that input, so it comes first (answer-first, 4c1eea8e): the
 * successor seeds from the answer, never the asking turn's comment.
 * `agentId` is the predecessor run's agent, from trusted run state. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: CarryInput): Promise<Record<string, unknown>> {
  const answered = await pendingContinuationInteractionInput(db, input);
  // An interaction-respond wake also names the asking turn's origin comment;
  // carrying it makes the successor's contract re-request that turn and cuts its
  // fresh history before the answer (upstream's seed carries no comment ids at all).
  if (answered.interactionIds) return answered;
  return pendingPersonCommentInput(db, input);
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
    // Only still-pending input: carry unless ANSWERED. A message a completed run's final answer answered (attributed
    // through that run's own pending input) is never re-presented, or every continuation re-answers it (org 19:48Z).
    // A failed run's progress reply is DELIVERED only: the message is still carried (RFL F1, 21:28Z).
    sql`not ${completedPersonMessageAnswerSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const commentIds: string[] = [];
  for (const row of rows) if (!await senderStopped(row)) commentIds.push(row.id);
  if (commentIds.length === 0) return {};
  return { ...carried, firstTurnQueuedInput: null, wakeCommentIds: commentIds,
    wakeCommentId: commentIds.at(-1), commentId: commentIds.at(-1) };
}

/** The predecessor's interaction references, only those a person resolved for a
 * question that agent asked on this task. They are candidates: the successor's
 * runtime selection revalidates them through the existing materializer
 * (materializeNativeInteractionResponses), so the person's answer is its input. */
export async function pendingContinuationInteractionInput(db: Pick<Db, "select">, input: CarryInput): Promise<Record<string, unknown>> {
  const candidates = interactionIds(input.contextSnapshot);
  if (candidates.length === 0) return {};
  const senderStopped = senderStoppedCheck(db, input);
  const rows = await db.select({ id: issueThreadInteractions.id, authorUserId: issueThreadInteractions.resolvedByUserId })
    .from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.id, candidates), eq(issueThreadInteractions.createdByAgentId, input.agentId),
    isNotNull(issueThreadInteractions.resolvedByUserId), isNull(issueThreadInteractions.resolvedByAgentId),
    isNotNull(issueThreadInteractions.resolvedAt), inArray(issueThreadInteractions.status, ["answered", "accepted", "rejected"]),
    // rf5 A2: only still-pending card answers: carry unless ANSWERED (a completed run's final answer attributed through
    // that run's OWN interactionId(s)), so a card answer is never re-presented once answered.
    sql`not ${completedPersonMessageAnswerSql({ id: sql`${issueThreadInteractions.id}`,
      companyId: sql`${issueThreadInteractions.companyId}`, issueId: sql`${issueThreadInteractions.issueId}`,
      createdAt: sql`${issueThreadInteractions.resolvedAt}` })}`,
    ...(input.liveOwner ? [sql`not ${carriedInLiveRunSql({ id: sql`${issueThreadInteractions.id}`,
      companyId: sql`${issueThreadInteractions.companyId}`, issueId: sql`${issueThreadInteractions.issueId}`,
      agentId: sql`${input.liveOwner.agentId}::uuid`, excludeRunId: sql`${input.liveOwner.runId}::uuid` })}`,
      // The shared live-owner predicate covers comment fields. Card fields are direct pending input too;
      // use the same company/task/agent/status/excluded-source fence for them.
      sql`not exists (select 1 from ${heartbeatRuns} live_card
        where live_card.company_id = ${input.companyId}::uuid and live_card.agent_id = ${input.liveOwner.agentId}::uuid
          and live_card.id <> ${input.liveOwner.runId}::uuid and live_card.status in ('queued', 'running', 'scheduled_retry')
          and (live_card.issue_id = ${input.issueId}::uuid or live_card.native_issue_id = ${input.issueId}::uuid
            or live_card.context_snapshot->>'issueId' = ${input.issueId})
          and (live_card.context_snapshot->>'interactionId' = ${issueThreadInteractions.id}::text
            or coalesce(live_card.context_snapshot->'interactionIds', '[]'::jsonb) ? ${issueThreadInteractions.id}::text))`] : []),
  )).orderBy(asc(issueThreadInteractions.resolvedAt), asc(issueThreadInteractions.id));
  const ids: string[] = [];
  for (const row of rows) if (!await senderStopped(row)) ids.push(row.id);
  return ids.length ? { interactionIds: ids, interactionId: ids.at(-1) } : {};
}

/** For fresh recovery seeds whose caller keeps only a predecessor id. */
export async function readContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string | null | undefined;
}): Promise<Record<string, unknown>> {
  if (!input.runId || !UUID.test(input.runId)) return {};
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot, agentId: heartbeatRuns.agentId,
    wakeupRequestId: heartbeatRuns.wakeupRequestId }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  if (!source) return {};
  // rf5 A2: a card answer the source run received through its respond wake (the wake payload or its
  // _paperclipWakeContext) is the run's own pending input too, as its contextSnapshot interactionId(s) are.
  let contextSnapshot = record(source.contextSnapshot);
  if (source.wakeupRequestId) {
    const [wake] = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, source.agentId),
      eq(agentWakeupRequests.id, source.wakeupRequestId))).limit(1);
    const payload = record(wake?.payload);
    contextSnapshot = { ...contextSnapshot, interactionIds: [...new Set([
      ...interactionIds(contextSnapshot), ...interactionIds(payload), ...interactionIds(payload._paperclipWakeContext),
    ])] };
  }
  // A person's answer to the predecessor's question is pending input exactly as
  // a pending comment is: an automatic successor that drops it re-asks (RFL 09:35Z).
  return pendingContinuationCommentInput(db, { companyId: input.companyId, issueId: input.issueId,
    agentId: source.agentId, contextSnapshot, liveOwner: { agentId: source.agentId, runId: input.runId } });
}
