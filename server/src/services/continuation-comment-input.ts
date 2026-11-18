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

/** Rebind the parent's pending comments AND card answers, never its receipt. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; contextSnapshot: unknown;
  /** The source run's agent and id: another LIVE run of that agent owning the input blocks a second carry. */
  liveOwner?: { agentId: string; runId: string };
}): Promise<Record<string, unknown>> {
  const carried = carryContinuationCommentInput(input.contextSnapshot);
  const candidates = (carried.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  const cardCandidates = interactionIds(input.contextSnapshot);
  if (candidates.length === 0 && cardCandidates.length === 0) return {};
  const issueRun = or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`);
  const senderStopped = async (message: { id: string; authorUserId: string | null }) => {
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
  const rows = candidates.length ? await db.select({ id: issueComments.id, authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
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
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id)) : [];
  const commentIds: string[] = [];
  for (const row of rows) if (!await senderStopped(row)) commentIds.push(row.id);

  const cards = cardCandidates.length ? await db.select({ id: issueThreadInteractions.id,
    authorUserId: issueThreadInteractions.resolvedByUserId }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.id, cardCandidates), isNotNull(issueThreadInteractions.resolvedByUserId),
    isNotNull(issueThreadInteractions.resolvedAt), inArray(issueThreadInteractions.status, ["answered", "accepted", "rejected"]),
    sql`not ${completedPersonMessageAnswerSql({ id: sql`${issueThreadInteractions.id}`,
      companyId: sql`${issueThreadInteractions.companyId}`, issueId: sql`${issueThreadInteractions.issueId}`,
      createdAt: sql`${issueThreadInteractions.resolvedAt}` })}`,
    ...(input.liveOwner ? [sql`not ${carriedInLiveRunSql({ id: sql`${issueThreadInteractions.id}`,
      companyId: sql`${issueThreadInteractions.companyId}`, issueId: sql`${issueThreadInteractions.issueId}`,
      agentId: sql`${input.liveOwner.agentId}::uuid`, excludeRunId: sql`${input.liveOwner.runId}::uuid` })}`,
      // The shared live-owner predicate at this revision covers comment fields. Card fields are direct
      // pending input too; use the same company/task/agent/status/excluded-source fence for them.
      sql`not exists (select 1 from ${heartbeatRuns} live_card
        where live_card.company_id = ${input.companyId}::uuid and live_card.agent_id = ${input.liveOwner.agentId}::uuid
          and live_card.id <> ${input.liveOwner.runId}::uuid and live_card.status in ('queued', 'running', 'scheduled_retry')
          and (live_card.issue_id = ${input.issueId}::uuid or live_card.native_issue_id = ${input.issueId}::uuid
            or live_card.context_snapshot->>'issueId' = ${input.issueId})
          and (live_card.context_snapshot->>'interactionId' = ${issueThreadInteractions.id}::text
            or coalesce(live_card.context_snapshot->'interactionIds', '[]'::jsonb) ? ${issueThreadInteractions.id}::text))`] : []),
  )).orderBy(asc(issueThreadInteractions.resolvedAt), asc(issueThreadInteractions.id)) : [];
  const pendingInteractionIds: string[] = [];
  for (const card of cards) if (!await senderStopped(card)) pendingInteractionIds.push(card.id);
  return {
    ...(commentIds.length ? { ...carried, firstTurnQueuedInput: null, wakeCommentIds: commentIds,
      wakeCommentId: commentIds.at(-1), commentId: commentIds.at(-1) } : {}),
    ...(pendingInteractionIds.length ? { interactionIds: pendingInteractionIds } : {}),
  };
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
  return pendingContinuationCommentInput(db, { companyId: input.companyId, issueId: input.issueId,
    contextSnapshot, liveOwner: { agentId: source.agentId, runId: input.runId } });
}
