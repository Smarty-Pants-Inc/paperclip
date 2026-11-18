import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueRecoveryActions, statusDecisions, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../../modules/wake-queue/domain/continuation-comment-input.js";
import { completedPersonMessageAnswerSql } from "../person-message-answer.js";
import { freshContinuationSourceChainSql } from "../fresh-continuation-chain.js";

export type NativeStatusSuccessorSkipReason = "person_message_already_answered" | "failed_run_has_successor";

/** The generic arbiter retry is a fallback, not a second owner of recovery.
 * Use durable source/answer edges, never a later timestamp or session identity.
 * This is DB-only so admission can repeat it under the existing issue lock. */
export async function nativeStatusSuccessorState(db: Db, input: {
  companyId: string; issueId: string; reason: string;
  payload: Record<string, unknown>; originRunId?: string;
}): Promise<{ failedRunId: string | null; skipReason: NativeStatusSuccessorSkipReason | null }> {
  const eligible = { failedRunId: null, skipReason: null };
  // These are fallback execution effects, not notifications/owner routing.
  // All boundaries (enqueue, admission, dispatch and promotion) share this
  // scope, so a successor can never swallow notify_owner or bind_blocker.
  if (input.reason !== "issue_status_changed" ||
      (typeof input.payload.retryCause !== "string" && typeof input.payload.continuationKind !== "string")) return eligible;
  const decisionId = input.payload.nativeDecisionId;
  const runId = input.originRunId ?? (typeof decisionId === "string"
    ? (await db.select({ runId: statusDecisions.runId }).from(statusDecisions).where(and(
        sql`${statusDecisions.id}::text = ${decisionId}`, eq(statusDecisions.companyId, input.companyId),
        eq(statusDecisions.issueId, input.issueId),
      )).limit(1))[0]?.runId : undefined);
  if (!runId) return eligible;
  const [source] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, context: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId),
      or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
    )).limit(1);
  // During finalization the failed result can precede the heartbeat status write.
  if (!source || (!["failed", "timed_out"].includes(source.status) && typeof input.payload.retryCause !== "string")) return eligible;

  const chain = await db.execute<{ context: Record<string, unknown> }>(sql`${freshContinuationSourceChainSql({
    companyId: input.companyId, issueId: input.issueId, runId,
  }, true)} select r.context_snapshot as context from source_chain c
    join heartbeat_runs r on r.id = c.id and r.company_id = ${input.companyId}`);
  const ids = [...new Set([source.context, ...chain.map(row => row.context)].flatMap(context => {
    const carried = carryContinuationCommentInput(context);
    return [...(carried.wakeCommentIds as string[] | undefined ?? []),
      ...(typeof context?.conversationReplyBoundaryCommentId === "string" ? [context.conversationReplyBoundaryCommentId] : [])];
  }))].filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (ids.length) {
    const messages = await db.select({ answered: sql<boolean>`${completedPersonMessageAnswerSql({ id: sql`${issueComments.id}`,
      companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}` })
      .from(issueComments).where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt), inArray(issueComments.id, ids)));
    if (messages.length && messages.every(message => message.answered))
      return { failedRunId: runId, skipReason: "person_message_already_answered" };
  }

  const [successor] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    or(eq(heartbeatRuns.retryOfRunId, runId),
      sql`${heartbeatRuns.contextSnapshot}->>'retryOfRunId' = ${runId}`,
      and(sql`${heartbeatRuns.contextSnapshot}->>'previousRunId' = ${runId}`,
        or(sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = 'issue_recovery_action_restored'`,
          sql`${heartbeatRuns.contextSnapshot}->>'source' = 'execution.reconciled'`)),
      sql`exists (select 1 from ${issueRecoveryActions} action
        where action.company_id = ${input.companyId} and action.source_issue_id = ${input.issueId}
          and action.evidence#>>'{executionReconciliation,runId}' = ${runId}
          and action.evidence->>'continuationRunId' = ${heartbeatRuns.id}::text)`),
  )).limit(1);
  return { failedRunId: runId, skipReason: successor ? "failed_run_has_successor" : null };
}
