import { and, eq, sql } from "drizzle-orm";
import { agentWakeupRequests, issueRecoveryActions, statusDecisionEffects, statusDecisions, type Db, type heartbeatRuns } from "@paperclipai/db";
import { NATIVE_RUN_FAILED_RETRY_CAUSE } from "./status-arbiter.js";
import { NATIVE_MID_STREAM_CUT_CODE } from "./native-mid-stream-cut.js";
import { readFailedTurnStreamedAnswer, type CompletedFinalAgentMessageCandidate } from "../heartbeat-run-summary.js";

type ContinuationRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "contextSnapshot" | "wakeupRequestId">
  & Partial<Pick<typeof heartbeatRuns.$inferSelect, "retryOfRunId" | "scheduledRetryReason">>;
const UUID = /^[0-9a-f-]{36}$/i;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export const NATIVE_FAILED_TURN_CONTINUATION_EXHAUSTED_NOTE =
  "The run stopped before the answer finished, and one automatic retry stopped too. Press Retry to try again.";

/**
 * The arbiter spent the generic failed turn's one continuation. Use its applied
 * decision, not an error string or copied retry context, as publication authority.
 * Like the cut lane's exhausted candidate, this becomes an attributed completion
 * reply: replay is idempotent and the unanswered sweep sees the lineage answered.
 * The same board-owned blocker keeps the existing failed-run Retry control.
 */
export async function readExhaustedNativeFailedTurnCandidate(
  db: Pick<Db, "select">, input: { companyId: string; runId: string },
  rows: readonly { seq: number; payload: unknown }[],
): Promise<(CompletedFinalAgentMessageCandidate & { reasonCode: string }) | null> {
  const terminal = [...rows].sort((a, b) => b.seq - a.seq).find(row =>
    /^turn\.(completed|failed|cancelled|interrupted)$/u.test(String(record(record(row.payload).prpEvent).eventType)));
  if (!terminal) return null;
  const event = record(record(terminal.payload).prpEvent);
  if (event.eventType !== "turn.failed") return null;
  const [decision] = await db.select({ reasonCode: statusDecisions.reasonCode }).from(statusDecisions).where(and(
    eq(statusDecisions.companyId, input.companyId),
    eq(statusDecisions.runId, input.runId),
    eq(statusDecisions.applicationState, "applied"),
    eq(statusDecisions.reasonCode, "native_run_failed_continuation_exhausted"),
  )).limit(1);
  if (!decision) return null;
  const prefix = readFailedTurnStreamedAnswer(rows)?.text;
  const note = NATIVE_FAILED_TURN_CONTINUATION_EXHAUSTED_NOTE;
  return { seq: terminal.seq, sourceEventId: typeof event.sourceEventId === "string" ? event.sourceEventId : null,
    channel: "final", text: prefix ? `${prefix}${prefix.endsWith("\n") ? "" : "\n"}\n— ${note}` : note,
    reasonCode: decision.reasonCode };
}

/**
 * True when this run was dispatched from the committer's `schedule_retry` wake
 * for an earlier failed turn. The intent id is set by the native-status wake
 * dispatcher, and the intent row itself proves the retry cause, so provider
 * output or a copied context cannot claim or hide the used continuation.
 */
export async function isFailedTurnContinuationRun(
  db: Pick<Db, "select">,
  run: ContinuationRun,
  issueId: string,
): Promise<boolean> {
  const intentId = run.contextSnapshot?.nativeStatusWakeIntentId;
  if (typeof intentId !== "string" || !UUID.test(intentId) || !run.wakeupRequestId)
    return isReconciledFailedTurnContinuationRun(db, run, issueId);
  // The run's own dispatch receipt must be the one the dispatcher created for
  // this intent, so a copied intent id on another run proves nothing.
  const [dispatch] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.runId, run.id),
    eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${intentId}`),
  )).limit(1);
  if (!dispatch) return false;
  const [intent] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.id, intentId),
    eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    sql`${agentWakeupRequests.payload}->>'retryCause' = ${NATIVE_RUN_FAILED_RETRY_CAUSE}`,
  )).limit(1);
  return Boolean(intent);
}

/**
 * The same one continuation, reached by retry LINEAGE instead of the intent
 * id. When the retry wake could not start a run (the agent's slot was busy, or
 * the failed run continues from saved work), the successor is started by
 * `deliverReconciledExecutions`: it carries no `nativeStatusWakeIntentId`, only
 * `retryOfRunId` = the failed run it continues. It is the used continuation
 * when that origin's own applied decision scheduled the generic retry.
 *
 * Every link is a row the server wrote: the run's `retryOfRunId` column, its
 * execution-recovery dispatch receipt, the recovery action that names both the
 * origin and this run, and the origin's status decision. A mid-stream cut
 * successor is counted by its own lane (`isNativeMidStreamCutRecoveryRun`) and
 * an origin whose decision scheduled that lane is not counted here.
 */
async function isReconciledFailedTurnContinuationRun(db: Pick<Db, "select">, run: ContinuationRun, issueId: string): Promise<boolean> {
  const originRunId = run.retryOfRunId;
  const actionId = run.contextSnapshot?.recoveryActionId;
  if (!originRunId || !run.wakeupRequestId || run.scheduledRetryReason === NATIVE_MID_STREAM_CUT_CODE) return false;
  if (typeof actionId !== "string" || !UUID.test(actionId)) return false;
  // The run's own dispatch receipt is the one reconciliation delivery wrote for this recovery action.
  const [dispatch] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.runId, run.id),
    eq(agentWakeupRequests.requestedByActorType, "system"),
    eq(agentWakeupRequests.requestedByActorId, "execution-recovery"),
    eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${actionId}`),
  )).limit(1);
  if (!dispatch) return false;
  // The recovery action reconciled the origin run and was delivered as this run.
  const [action] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, run.companyId),
    eq(issueRecoveryActions.sourceIssueId, issueId),
    sql`${issueRecoveryActions.id}::text = ${actionId}`,
    sql`${issueRecoveryActions.evidence}#>>'{executionReconciliation,runId}' = ${originRunId}`,
    sql`${issueRecoveryActions.evidence}->>'continuationRunId' = ${run.id}`,
  )).limit(1);
  if (!action) return false;
  // The origin failed, and its applied decision scheduled the generic failed-turn retry.
  const [origin] = await db.select({ id: statusDecisions.id }).from(statusDecisions)
    .innerJoin(statusDecisionEffects, and(
      eq(statusDecisionEffects.decisionId, statusDecisions.id),
      eq(statusDecisionEffects.companyId, run.companyId),
      eq(statusDecisionEffects.issueId, issueId),
      eq(statusDecisionEffects.effectKind, "schedule_retry"),
      sql`${statusDecisionEffects.payload}->>'cause' = ${NATIVE_RUN_FAILED_RETRY_CAUSE}`,
    ))
    .where(and(
      eq(statusDecisions.companyId, run.companyId),
      eq(statusDecisions.issueId, issueId),
      eq(statusDecisions.runId, originRunId),
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.reasonCode, "run_failed_partial_evidence_preserved"),
    )).limit(1);
  return Boolean(origin);
}
