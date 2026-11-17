import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { carriedInLiveRunSql, completedPersonMessageAnswerSql } from "./person-message-answer.js";
import { runOwnInputIds, senderStoppedWhileAnswering } from "./recovery/person-stopped-message.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** THE continuation seam every successor seed uses (wake-queue port, first-turn
 * input, readContinuationCommentInput): the predecessor's still-pending person
 * input. A person's resolution of a question the predecessor's agent asked on
 * this task IS that input, so it comes first (answer-first, 4c1eea8e): the
 * successor seeds from the answer, never the asking turn's comment.
 * `agentId` is the predecessor run's agent, from trusted run state. */
export async function pendingContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; runId?: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const { carry: answered, liveOwned } = await interactionCarry(db, input);
  // A live run already carries this answer-resume input: it owns the whole input, so this seed carries
  // neither the card again nor the asking turn's comment (the person's answer superseded that turn).
  if (liveOwned) return {};
  // An interaction-respond wake also names the asking turn's origin comment;
  // carrying it makes the successor's contract re-request that turn and cuts its
  // fresh history before the answer (upstream's seed carries no comment ids at all).
  if (answered.interactionIds) return answered;
  return pendingPersonCommentInput(db, input);
}

async function continuationChainContexts(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; runId?: string;
}): Promise<Array<Record<string, unknown> | null>> {
  if (!input.runId || !UUID.test(input.runId)) return [];
  const context = heartbeatRuns.contextSnapshot;
  const rows = await db.select({
    wakeCommentIds: sql<unknown>`${context}->'wakeCommentIds'`,
    wakeCommentId: sql<unknown>`${context}->'wakeCommentId'`,
    commentId: sql<unknown>`${context}->'commentId'`,
    queuedCommentSourceWakeIds: sql<unknown>`${context}->'queuedCommentSourceWakeIds'`,
    firstTurnQueuedInput: sql<unknown>`jsonb_build_object('commentIds', ${context}#>'{firstTurnQueuedInput,commentIds}',
      'wakeupRequestIds', ${context}#>'{firstTurnQueuedInput,wakeupRequestIds}')`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
    sql`${heartbeatRuns.id} in (with recursive input_chain as (
      select source.id, source.retry_of_run_id, source.context_snapshot->>'previousRunId' as previous_run_id,
        source.context_snapshot->>'retryOfRunId' as context_retry_id, source.native_session_id, source.created_at,
        coalesce(source.context_snapshot->'conversationSessionGeneration', '0'::jsonb) as generation
      from heartbeat_runs source
      where source.company_id = ${input.companyId} and source.agent_id = ${input.agentId} and source.id = ${input.runId}
        and (source.issue_id = ${input.issueId} or source.native_issue_id = ${input.issueId}
          or source.context_snapshot->>'issueId' = ${input.issueId})
      union
      select parent.id, parent.retry_of_run_id, parent.context_snapshot->>'previousRunId',
        parent.context_snapshot->>'retryOfRunId', parent.native_session_id, parent.created_at,
        coalesce(parent.context_snapshot->'conversationSessionGeneration', '0'::jsonb)
      from input_chain child join heartbeat_runs parent on parent.company_id = ${input.companyId}
        and parent.agent_id = ${input.agentId}
        and (parent.issue_id = ${input.issueId} or parent.native_issue_id = ${input.issueId}
          or parent.context_snapshot->>'issueId' = ${input.issueId})
        and coalesce(parent.context_snapshot->'conversationSessionGeneration', '0'::jsonb) = child.generation
        and (parent.id = child.retry_of_run_id
          or parent.id::text = lower(child.previous_run_id)
          or parent.id::text = lower(child.context_retry_id)
          or (child.native_session_id is not null and parent.native_session_id = child.native_session_id
            and (parent.created_at, parent.id) < (child.created_at, child.id)))
    ) select id from input_chain)`,
  ));
  return rows;
}

type PendingInputSql = { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL };
type CarryRun = { companyId: string; issueId: string; agentId: string; runId?: string };

/** The ONE still-pending policy for a carry candidate (a typed comment id or a card's interaction id):
 * not ANSWERED (a COMPLETED run's final answer, attributed only through that run's OWN pending input,
 * person-message-answer.ts) and not carried in another LIVE run's pending input (liveOwnedSql), then not
 * senderStoppedWhileAnswering (notSenderStopped). Collecting candidates walks the continuation chain;
 * attributing an answer never does (RFL F2). */
function notAnsweredSql(m: PendingInputSql): SQL {
  return sql`not ${completedPersonMessageAnswerSql(m)}`;
}

/** Another LIVE run of this agent owns the input: it blocks a second promotion; it is NOT an answer. The
 * run being seeded from never blocks its own input. carriedInLiveRunSql reads typed ids only, so a live
 * run's interactionId/interactionIds is the same fence for a card (a queued successor owns a card it carries). */
function liveOwnedSql(input: CarryRun, m: PendingInputSql): SQL {
  const excludeRunId = input.runId && UUID.test(input.runId) ? sql`${input.runId}::uuid` : undefined;
  return sql`(${carriedInLiveRunSql({ id: m.id, companyId: m.companyId, issueId: m.issueId,
      agentId: sql`${input.agentId}::uuid`, excludeRunId })}
    or exists (select 1 from ${heartbeatRuns} card_owner
      where card_owner.company_id = ${m.companyId} and card_owner.agent_id = ${input.agentId}::uuid
        and (card_owner.issue_id = ${m.issueId} or card_owner.native_issue_id = ${m.issueId}
          or card_owner.context_snapshot->>'issueId' = ${m.issueId}::text)
        and card_owner.status in ('queued', 'running', 'scheduled_retry')
        ${excludeRunId ? sql`and card_owner.id <> ${excludeRunId}` : sql``}
        and (card_owner.context_snapshot->>'interactionId' = ${m.id}::text
          or coalesce(card_owner.context_snapshot->'interactionIds', '[]'::jsonb) ? ${m.id}::text)))`;
}

/** Stop means stop, through recovery's WHOLE exclusion (senderStoppedWhileAnswering: the sender stopped
 * the run AND it had started answering), judged on the newest run of this agent that carried the input,
 * as the sweep judges it. Never the discovery half alone (RFL F5). */
async function notSenderStopped(db: Pick<Db, "select">, input: { companyId: string; issueId: string; agentId: string },
  candidates: Array<{ id: string; authorUserId: string | null }>): Promise<string[]> {
  const stoppable = candidates.filter(candidate => candidate.authorUserId);
  const carriers = stoppable.length ? await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
      or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`)))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(50) : [];
  const kept: string[] = [];
  for (const candidate of candidates) {
    const carrier = candidate.authorUserId ? carriers.find(run => carriesInput(run.contextSnapshot, candidate.id)) : undefined;
    // runStartedAnswering reads only db.select.
    if (await senderStoppedWhileAnswering(db as unknown as Db, input.companyId, carrier, candidate)) continue;
    kept.push(candidate.id);
  }
  return kept;
}

function carriesInput(contextSnapshot: unknown, id: string): boolean {
  const context = contextSnapshot && typeof contextSnapshot === "object" && !Array.isArray(contextSnapshot)
    ? contextSnapshot as Record<string, unknown> : {};
  return runOwnInputIds(context).includes(id) || context.interactionId === id
    || (Array.isArray(context.interactionIds) && context.interactionIds.includes(id));
}

/** Rebind the parent's wake comments and first-turn input ids, not its receipt. */
async function pendingPersonCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; runId?: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  const direct = carryContinuationCommentInput(input.contextSnapshot);
  const directIds = (direct.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  const chain = (await continuationChainContexts(db, input)).map(carryContinuationCommentInput);
  const carried = carryContinuationCommentInput({
    wakeCommentIds: [...directIds, ...chain.flatMap(context => (context.wakeCommentIds as string[] | undefined) ?? [])],
    queuedCommentSourceWakeIds: [direct, ...chain].flatMap(context => (context.queuedCommentSourceWakeIds as string[] | undefined) ?? []),
  });
  const candidates = (carried.wakeCommentIds as string[] | undefined)?.filter(id => UUID.test(id)) ?? [];
  if (candidates.length === 0) return {};
  const typed = { id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
    issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` };
  const rows = await db.select({ id: issueComments.id, authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), isNull(issueComments.deletedAt),
    or(inArray(issueComments.id, directIds), eq(issueComments.authorType, "user")),
    // The ONE carry policy (RFL F3/F5, 22:41Z), the same for typed comments and card answers:
    // !ANSWERED && !carriedInLiveRun here, !senderStoppedWhileAnswering below.
    notAnsweredSql(typed), sql`not ${liveOwnedSql(input, typed)}`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const commentIds = await notSenderStopped(db, input,
    rows.map(row => ({ id: row.id, authorUserId: row.authorUserId })));
  if (commentIds.length === 0) return {};
  return { ...carried, firstTurnQueuedInput: null, wakeCommentIds: commentIds,
    wakeCommentId: commentIds.at(-1), commentId: commentIds.at(-1) };
}

/** The predecessor's interaction references, only those a person resolved for a
 * question that agent asked on this task. They are candidates: the successor's
 * runtime selection revalidates them through the existing materializer
 * (materializeNativeInteractionResponses), so the person's answer is its input. */
export async function pendingContinuationInteractionInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; runId?: string; contextSnapshot: unknown;
}): Promise<Record<string, unknown>> {
  return (await interactionCarry(db, input)).carry;
}

async function interactionCarry(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; runId?: string; contextSnapshot: unknown;
}): Promise<{ carry: Record<string, unknown>; liveOwned: boolean }> {
  const context = input.contextSnapshot && typeof input.contextSnapshot === "object" && !Array.isArray(input.contextSnapshot)
    ? input.contextSnapshot as Record<string, unknown> : {};
  const candidates = [...new Set([context.interactionId, ...(Array.isArray(context.interactionIds) ? context.interactionIds : [])]
    .filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (candidates.length === 0) return { carry: {}, liveOwned: false };
  const card = { id: sql`${issueThreadInteractions.id}`, companyId: sql`${issueThreadInteractions.companyId}`,
    issueId: sql`${issueThreadInteractions.issueId}`, createdAt: sql`${issueThreadInteractions.resolvedAt}` };
  const rows = await db.select({ id: issueThreadInteractions.id, resolvedByUserId: issueThreadInteractions.resolvedByUserId,
    liveOwned: sql<boolean>`${liveOwnedSql(input, card)}` })
    .from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.id, candidates), eq(issueThreadInteractions.createdByAgentId, input.agentId),
    sql`${issueThreadInteractions.resolvedByUserId} is not null`, isNull(issueThreadInteractions.resolvedByAgentId),
    inArray(issueThreadInteractions.status, ["answered", "accepted", "rejected"]),
    // The SAME whole policy as typed comments (RFL F3): no predecessor-status rule of its own. The card is
    // keyed by its id and its answer time, as unansweredCardAnswerSql reads it.
    notAnsweredSql(card),
  )).orderBy(asc(issueThreadInteractions.resolvedAt), asc(issueThreadInteractions.id));
  // The carry WRITES these ids into the successor's own pending input (interactionIds/interactionId): that is
  // what attributes the successor's answer to the card (person-message-answer.ts carriesCommentSql, RFL F2).
  const interactionIds = await notSenderStopped(db, input,
    rows.filter(row => !row.liveOwned).map(row => ({ id: row.id, authorUserId: row.resolvedByUserId })));
  return { carry: interactionIds.length ? { interactionIds, interactionId: interactionIds.at(-1) } : {},
    liveOwned: interactionIds.length === 0 && rows.some(row => row.liveOwned) };
}

/** For fresh recovery seeds whose caller keeps only a predecessor id. */
export async function readContinuationCommentInput(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string | null | undefined;
}): Promise<Record<string, unknown>> {
  if (!input.runId || !UUID.test(input.runId)) return {};
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  if (!source) return {};
  // A person's answer to the predecessor's question is pending input exactly as
  // a pending comment is: an automatic successor that drops it re-asks (RFL 09:35Z).
  return pendingContinuationCommentInput(db, { companyId: input.companyId, issueId: input.issueId,
    agentId: source.agentId, runId: input.runId, contextSnapshot: source.contextSnapshot });
}
