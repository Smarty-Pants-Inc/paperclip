import { notifyAttentionRetentionWork } from "../retention-work-notifications.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { accountingForScheduledRetry, executionFailureRetryCount } from "../execution-recovery-attempt.js";
import { NATIVE_PROVIDER_CAPACITY_MAX_RETRIES, NATIVE_PROVIDER_OVERLOADED_CODE, NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";
// Fork: upstream imports nativeRunHasStopRequest from native-tool-receipt-limit.ts
// (#21913), which this fork does not carry yet. See native-run-stop-request.ts.
import { nativeRunHasStopRequest } from "./native-run-stop-request.js";
import { NATIVE_ENVIRONMENT_BLOCKER_CODE, NATIVE_ENVIRONMENT_BLOCKER_HINT, NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES, NATIVE_ENVIRONMENT_BLOCKER_MESSAGE,
  NATIVE_ENVIRONMENT_BLOCKER_RETRY_DELAY_MS } from "./native-environment-blocker.js";
import { NativeStatusRaceError } from "./status-decision-committer.js";
import { NATIVE_MID_STREAM_CUT_CODE, NATIVE_MID_STREAM_CUT_MESSAGE, nativeMidStreamCutStartsFresh, readNativeMidStreamCut } from "./native-mid-stream-cut.js";

type NativeRetryTarget = {
  tx: Db;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
};

type NativeRetryLane = {
  reason: string;
  maxRetries: number;
  delayMs: (attempt: number) => number;
  message: string;
  idempotencyPrefix: string;
  exhaustedError: string;
  context?: (run: typeof heartbeatRuns.$inferSelect) => Record<string, unknown>;
  refuseStopped?: boolean;
  /** The retry resumes the failed run's provider session instead of starting a fresh one. */
  resumeSession?: boolean;
  dropContext?: string[];
};

/** Called under the finalizer's issue/coordinator locks, in the status-effect transaction. */
export async function materializeNativeProviderCapacityRetry(input: NativeRetryTarget) {
  return materializeNativeFreshSessionRetry(input, {
    reason: NATIVE_PROVIDER_OVERLOADED_CODE,
    maxRetries: NATIVE_PROVIDER_CAPACITY_MAX_RETRIES,
    delayMs: attempt => 60_000 * 2 ** (attempt - 1),
    message: NATIVE_PROVIDER_OVERLOADED_MESSAGE,
    idempotencyPrefix: "native-capacity",
    exhaustedError: "native_capacity_retry_exhausted",
  });
}

export async function materializeNativeEnvironmentBlockerRetry(input: NativeRetryTarget) {
  return materializeNativeFreshSessionRetry(input, {
    reason: NATIVE_ENVIRONMENT_BLOCKER_CODE,
    maxRetries: NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES,
    delayMs: attempt => NATIVE_ENVIRONMENT_BLOCKER_RETRY_DELAY_MS * 2 ** (attempt - 1),
    message: NATIVE_ENVIRONMENT_BLOCKER_MESSAGE,
    idempotencyPrefix: "native-environment-blocker",
    exhaustedError: "native_environment_blocker_retry_exhausted",
    refuseStopped: true,
    context: run => ({
      livenessContinuationSourceRunId: run.id,
      livenessContinuationReason: NATIVE_ENVIRONMENT_BLOCKER_CODE,
      livenessContinuationInstruction: NATIVE_ENVIRONMENT_BLOCKER_HINT,
    }),
  });
}

/**
 * dl famlong-u1: the ONE recovery successor of a turn the provider cut
 * mid-stream. A cap stop with no answer text starts a new process on the SAME
 * conversation; the cut turn is not sent. The thinking-cap recovery level,
 * 'high', applies to exactly that run (see isThinkingCapStopRecoveryRun).
 * An EOF or other provider error, and a cap
 * stop that had started its answer, resume the session. A second cut is
 * bounded by the arbiter (failedTurnContinuationUsed), not by this lane.
 */
export async function materializeNativeMidStreamCutRetry(input: NativeRetryTarget) {
  const cut = await readNativeMidStreamCut(input.tx, { companyId: input.companyId, runId: input.runId });
  return materializeNativeFreshSessionRetry(input, {
    reason: NATIVE_MID_STREAM_CUT_CODE,
    maxRetries: Number.MAX_SAFE_INTEGER,
    delayMs: () => 0,
    message: NATIVE_MID_STREAM_CUT_MESSAGE,
    idempotencyPrefix: "native-mid-stream-cut",
    exhaustedError: "native_mid_stream_cut_retry_exhausted",
    refuseStopped: true,
    resumeSession: !nativeMidStreamCutStartsFresh(cut),
    dropContext: ["nativeStatusWakeIntentId", "statusDecisionSource", "source"],
    context: run => ({
      previousRunId: run.id,
      source: NATIVE_MID_STREAM_CUT_CODE,
      nativeMidStreamCut: cut,
      livenessContinuationSourceRunId: run.id,
      livenessContinuationReason: NATIVE_MID_STREAM_CUT_CODE,
    }),
  });
}

async function materializeNativeFreshSessionRetry(input: NativeRetryTarget, lane: NativeRetryLane) {
  const [run] = await input.tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.nativeIssueId, input.issueId),
  )).for("update");
  if (!run || run.runtimeMode !== "native") throw new Error("native_capacity_retry_run_binding_mismatch");
  if (lane.refuseStopped && nativeRunHasStopRequest(run.resultJson)) throw new NativeStatusRaceError();
  // Share the predecessor claim with every other failure-retry lane.
  const [existing] = await input.tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.retryOfRunId, run.id),
  )).limit(1);
  if (existing) return existing.id;
  const attempt = executionFailureRetryCount(run) + 1;
  if (attempt > lane.maxRetries) throw new Error(lane.exhaustedError);
  const now = new Date();
  const dueAt = new Date(now.getTime() + lane.delayMs(attempt));
  const retryId = randomUUID();
  const predecessorContext = { ...run.contextSnapshot };
  // Resume receipts and delivered wake input belong to the failed run. The
  // new turn has ordinary task authority; history comes from retryOfRunId.
  // Match the consumed-input boundary used by native safe replacements.
  for (const key of [
    "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
    "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
    "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
    "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
    // A resumed recovery is not the generic status wake and not a fresh start.
    ...(lane.resumeSession ? ["forceFreshSession"] : []), ...(lane.dropContext ?? []),
  ]) delete predecessorContext[key];
  const contextSnapshot = {
    ...predecessorContext,
    issueId: input.issueId,
    taskId: input.issueId,
    ...(lane.resumeSession ? {} : { forceFreshSession: true }),
    retryOfRunId: run.id,
    retryReason: lane.reason,
    wakeReason: lane.reason,
    scheduledRetryAttempt: attempt,
    scheduledRetryAt: dueAt.toISOString(),
    executionRetryAccounting: accountingForScheduledRetry(run, lane.reason, attempt),
    ...lane.context?.(run),
  };
  await notifyAttentionRetentionWork(input.tx, { companyId: input.companyId });
  await notifyScheduledRetryDispatch(input.tx, { companyId: run.companyId });
  const [wake] = await input.tx.insert(agentWakeupRequests).values({
    companyId: run.companyId, agentId: run.agentId, source: "automation", triggerDetail: "system",
    reason: lane.reason, status: "queued", runId: retryId,
    idempotencyKey: `${lane.idempotencyPrefix}:${run.companyId}:${run.id}`,
    requestedByActorType: "system", requestedByActorId: "native_finalizer",
    payload: contextSnapshot,
  }).returning({ id: agentWakeupRequests.id });
  await input.tx.insert(heartbeatRuns).values({
    id: retryId, companyId: run.companyId, agentId: run.agentId,
    invocationSource: "automation", triggerDetail: "system", status: "scheduled_retry",
    responsibleUserId: run.responsibleUserId, wakeupRequestId: wake.id,
    retryOfRunId: run.id, scheduledRetryReason: lane.reason,
    scheduledRetryAttempt: attempt, scheduledRetryAt: dueAt,
    error: lane.message, errorCode: lane.reason,
    contextSnapshot,
  });
  return retryId;
}
