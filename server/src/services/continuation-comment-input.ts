import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueThreadInteractions, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { answeredPersonMessageSql, carriedInLiveRunSql } from "./person-message-answer.js";
import { personStoppedCarrierSql } from "./recovery/person-stopped-message.js";

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
  const answered = await pendingContinuationInteractionInput(db, input);
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
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, candidates), isNull(issueComments.deletedAt),
    or(inArray(issueComments.id, directIds), eq(issueComments.authorType, "user")),
    // Keep answer attribution in the shared predicate. A live pending owner is
    // a separate duplicate-carry fence, not proof the person was answered.
    sql`not ${answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`,
    sql`not ${carriedInLiveRunSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, agentId: sql`${input.agentId}`,
      excludeRunId: input.runId && UUID.test(input.runId) ? sql`${input.runId}` : undefined })}`,
    // Stop means stop: reuse recovery's sender-stop exclusion, never rebuild it.
    sql`not ${personStoppedCarrierSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, authorUserId: sql`${issueComments.authorUserId}` })}`,
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
    or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  if (!source) return {};
  // A person's answer to the predecessor's question is pending input exactly as
  // a pending comment is: an automatic successor that drops it re-asks (RFL 09:35Z).
  return pendingContinuationCommentInput(db, { companyId: input.companyId, issueId: input.issueId,
    agentId: source.agentId, runId: input.runId, contextSnapshot: source.contextSnapshot });
}
