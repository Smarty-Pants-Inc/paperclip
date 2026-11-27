import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, chatConversations, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { queuedCommentIdsFromRunContext, queuedCommentIdsFromWakePayload, withQueuedCommentIdsInRunContext } from "./issue-queued-comment-queue.js";
import { FRESH_CONTINUATION_SCHEMA, settleCoalescedFreshContinuationHolds } from "./fresh-continuation-fallback.js";
import { readTaskRetryIntent } from "./task-retry.js";

const LIVE_CONTINUATION_STATUSES = ["queued", "running"];

function retrySourceRunId(payload: unknown): string | null {
  const taskRetry = (payload as { taskRetry?: { sourceRunId?: unknown } } | null)?.taskRetry;
  return typeof taskRetry?.sourceRunId === "string" ? taskRetry.sourceRunId : null;
}

/** One company-scoped chat rule for SQL readers and admission. Unknown = chat. */
export function isChatTaskSql(companyId: string, issueId: string) {
  return sql<boolean>`coalesce((select (candidate.conversation_agent_id is not null
      or coalesce(candidate.origin_kind = 'chat_channel', false)
      or exists (select 1 from ${chatConversations} chat
        where chat.company_id = candidate.company_id and chat.issue_id = candidate.id))
    from ${issues} candidate where candidate.company_id = ${companyId} and candidate.id = ${issueId}), true)`;
}

/** A person's chat (Agent Chat or a connected chat); unknown counts as a chat. */
export async function isChatTask(tx: Pick<Db, "select">, companyId: string, issueId: string) {
  const [issue] = await tx.select({ chat: isChatTaskSql(companyId, issueId) })
    .from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1);
  return issue?.chat ?? true;
}

/** A person's Retry starts a new session when the source session cannot resume; the hold discloses this choice, including for chats. */
export async function retryStartsFresh(tx: Pick<Db, "select">, input: {
  companyId: string; issueId: string; sourceRunId: string; expectedStartsNewSession?: boolean;
}) {
  const { readRetryConsequence, retryChoiceAllowsFresh } = await import("./run-retry-presentation.js");
  const retry = await readRetryConsequence(tx as Db, input.companyId, input.sourceRunId);
  return retryChoiceAllowsFresh(retry, input.expectedStartsNewSession);
}

/** A Retry is not a new question. Carry the source's still-owed question into
 * the replacement's submitted input, so the existing final-reply publisher
 * writes its exact questionCommentIds receipt. Never borrow a later question
 * or one from another task, assignee, person or conversation generation.
 * Caller holds the issue lock and already authenticated the positive marker. */
export async function personRetryOwedQuestionIds(tx: Db, input: {
  companyId: string; issueId: string; agentId: string; sourceRunId: string; userId: string;
}): Promise<string[]> {
  const [source] = await tx.select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt,
    context: sql<Record<string, unknown>>`jsonb_build_object('wakeCommentId', ${heartbeatRuns.contextSnapshot}->'wakeCommentId', 'wakeCommentIds', ${heartbeatRuns.contextSnapshot}->'wakeCommentIds', 'firstTurnQueuedInput', ${heartbeatRuns.contextSnapshot}->'firstTurnQueuedInput', 'conversationSessionGeneration', ${heartbeatRuns.contextSnapshot}->'conversationSessionGeneration')`,
    generation: issues.conversationSessionGeneration,
  }).from(heartbeatRuns).innerJoin(issues, and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
    eq(issues.assigneeAgentId, input.agentId), eq(issues.conversationUserId, input.userId))).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId), eq(heartbeatRuns.agentId, input.agentId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.issueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).limit(1);
  if (!source || (source.context.conversationSessionGeneration != null && source.context.conversationSessionGeneration !== source.generation)) return [];
  const { readFirstTurnQueuedInputReceipt } = await import("./native-runtime/first-turn-queued-input.js");
  const sealed = readFirstTurnQueuedInputReceipt({ id: source.id, contextSnapshot: source.context });
  const ids = new Set([...queuedCommentIdsFromRunContext(source.context),
    ...(typeof source.context.wakeCommentId === "string" ? [source.context.wakeCommentId] : []), ...(sealed?.commentIds ?? [])]);
  const owed = (await (await import("./conversation-owed-input.js")).conversationOwedInputs(tx, input.companyId, [input.issueId])).get(input.issueId);
  // Historical Retry/recovery wakes already lost their source question IDs.
  // The current owed question can still be submitted by this person's Retry
  // when it predates that source attempt; never claim a later queued message.
  return owed && (ids.has(owed.commentId) || owed.createdAt <= source.createdAt) ? [owed.commentId] : [];
}

export async function foldWaitingRetriesIntoContinuation(tx: Db, input: {
  companyId: string; issueId: string; runId: string; sourceRunId: string | null;
}) {
  if (!input.sourceRunId) return;
  const [continuation] = await tx.select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId, context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!continuation || !LIVE_CONTINUATION_STATUSES.includes(continuation.status)) return;
  const waiting = await tx.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.requestedByActorType, "user"),
    isNull(agentWakeupRequests.runId), sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`)).for("update");
  const retries = waiting.filter(wake => queuedCommentIdsFromWakePayload(wake.payload).length === 0
    && retrySourceRunId(wake.payload) === input.sourceRunId).map(wake => wake.id);
  if (!retries.length) return;
  // A person's folded Retry starts a new session; carry that to the continuation that answers it.
  const personRetry = waiting.map(wake => ({ wake, retry: readTaskRetryIntent(wake.payload) }))
    .filter(({ wake, retry }) => retries.includes(wake.id) && retry && !retry.initiatedBy && retry.personRetry?.userId === retry.actorId)
    .sort((a, b) => Number(b.retry?.personRetry?.expectedStartsNewSession === true) - Number(a.retry?.personRetry?.expectedStartsNewSession === true))[0]?.retry?.personRetry;
  if (personRetry && await retryStartsFresh(tx, { ...input, sourceRunId: input.sourceRunId, expectedStartsNewSession: personRetry.expectedStartsNewSession })) {
    const questionIds = await personRetryOwedQuestionIds(tx, { ...input, agentId: continuation.agentId,
      sourceRunId: input.sourceRunId, userId: personRetry.userId });
    const baseContext = { ...continuation.context, explicitFreshSession: true };
    const context = questionIds.length ? withQueuedCommentIdsInRunContext(baseContext,
      [...new Set([...queuedCommentIdsFromRunContext(continuation.context),
        ...(typeof continuation.context?.wakeCommentId === "string" ? [continuation.context.wakeCommentId] : []), ...questionIds])]) : baseContext;
    await tx.update(heartbeatRuns).set({ contextSnapshot: context })
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.status, "queued")));
  }
  const now = new Date();
  await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: input.runId, finishedAt: now, updatedAt: now,
    payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({ coalescedIntoFreshContinuationRun: input.runId })}::jsonb` })
    .where(and(eq(agentWakeupRequests.companyId, input.companyId), inArray(agentWakeupRequests.id, retries),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
}

export async function foldWaitingRetriesIntoRecordedContinuation(tx: Db, input: {
  companyId: string; issueId: string; runId: string; recoveryActionId: string | null; sourceRunId: string | null;
}) {
  if (!input.recoveryActionId || !input.sourceRunId) return;
  const [record] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    sql`${issueRecoveryActions.id}::text = ${input.recoveryActionId}`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,sourceRunId}' = ${input.sourceRunId}`)).limit(1);
  if (record) await foldWaitingRetriesIntoContinuation(tx, input);
}

export type UndeliveredContinuation = { recoveryActionId: string; sourceRunId: string; isolation: string | null; personRetry?: boolean };

/** Caller holds the task row lock. The task's recorded continuation that no run took yet: a run admitted now is that continuation. */
export async function undeliveredContinuation(tx: Db, input: { companyId: string; issueId: string }): Promise<UndeliveredContinuation | null> {
  const [record] = await tx.select({ id: issueRecoveryActions.id, evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    eq(issueRecoveryActions.status, "resolved"),
    sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`,
    sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,schema}' = ${FRESH_CONTINUATION_SCHEMA}`))
    .orderBy(desc(sql`${issueRecoveryActions.evidence}#>>'{freshContinuation,recordedAt}'`)).limit(1).for("update");
  if (!record) return null;
  const fresh = record.evidence.freshContinuation as { recordedAt?: unknown; isolation?: unknown; personRetry?: { userId?: unknown } } | undefined;
  const sourceRunId = (record.evidence.executionReconciliation as { runId?: unknown } | undefined)?.runId;
  if (typeof sourceRunId !== "string" || typeof fresh?.recordedAt !== "string") return null;
  const [intervening] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), sql`${heartbeatRuns.id}::text <> ${sourceRunId}`,
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.issueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}::text`),
    sql`${heartbeatRuns.createdAt} >= ${fresh.recordedAt}::timestamptz`)).limit(1);
  if (intervening) return null;
  return { recoveryActionId: record.id, sourceRunId, isolation: typeof fresh.isolation === "string" ? fresh.isolation : null,
    personRetry: typeof fresh.personRetry?.userId === "string" && fresh.personRetry.userId.length > 0 };
}

export function undeliveredContinuationContext(continuation: UndeliveredContinuation, context: Record<string, unknown>) {
  return { recoveryActionId: continuation.recoveryActionId, retryOfRunId: continuation.sourceRunId, forceFreshSession: true,
    ...(continuation.personRetry ? { explicitFreshSession: true } : {}),
    ...(typeof context.previousRunId === "string" ? {} : { previousRunId: continuation.sourceRunId }),
    ...(continuation.isolation === "fresh_isolated_workspace" ? { freshContinuationIsolation: continuation.recoveryActionId } : {}) };
}

/** In the admitting transaction: the new run is the recorded continuation, so the delivery pass finds nothing left to start. */
export async function deliverContinuationAsRun(tx: Db, input: { companyId: string; issueId: string; runId: string;
  continuation: UndeliveredContinuation }) {
  const { continuation } = input;
  await tx.update(heartbeatRuns).set({ retryOfRunId: continuation.sourceRunId })
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  await tx.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({
    continuationDelivery: "delivered", continuationRunId: input.runId, continuationDeliveredByPersonRun: true })}::jsonb` })
    .where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, continuation.recoveryActionId),
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'pending'`));
  await settleCoalescedFreshContinuationHolds(tx, { companyId: input.companyId, primaryId: continuation.recoveryActionId,
    delivery: "delivered", continuationRunId: input.runId });
  await foldWaitingRetriesIntoContinuation(tx, { companyId: input.companyId, issueId: input.issueId, runId: input.runId,
    sourceRunId: continuation.sourceRunId });
}
