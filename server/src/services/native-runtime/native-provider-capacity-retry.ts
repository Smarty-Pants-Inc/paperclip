import { notifyIssueAttentionRetentionWork } from "../retention-work-notifications.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { accountingForScheduledRetry, executionFailureRetryCount } from "../execution-recovery-attempt.js";
import { readContinuationCommentInput } from "../continuation-comment-input.js";
import { NATIVE_PROVIDER_CAPACITY_MAX_RETRIES, NATIVE_PROVIDER_OVERLOADED_CODE, NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";
import { NATIVE_TOOL_RECEIPT_LIMIT_CODE, NATIVE_TOOL_RECEIPT_LIMIT_CONTINUATION_DELAY_MS, NATIVE_TOOL_RECEIPT_LIMIT_HINT,
  NATIVE_TOOL_RECEIPT_LIMIT_MAX_CONTINUATIONS, NATIVE_TOOL_RECEIPT_LIMIT_MESSAGE, nativeRunHasStopRequest } from "./native-tool-receipt-limit.js";
import { NATIVE_ENVIRONMENT_BLOCKER_CODE, NATIVE_ENVIRONMENT_BLOCKER_HINT, NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES, NATIVE_ENVIRONMENT_BLOCKER_MESSAGE,
  NATIVE_ENVIRONMENT_BLOCKER_RETRY_DELAY_MS } from "./native-environment-blocker.js";
import { NativeStatusRaceError } from "./status-decision-committer.js";

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

export async function materializeNativeToolReceiptLimitContinuation(input: NativeRetryTarget) {
  return materializeNativeFreshSessionRetry(input, {
    reason: NATIVE_TOOL_RECEIPT_LIMIT_CODE,
    maxRetries: NATIVE_TOOL_RECEIPT_LIMIT_MAX_CONTINUATIONS,
    delayMs: () => NATIVE_TOOL_RECEIPT_LIMIT_CONTINUATION_DELAY_MS,
    message: NATIVE_TOOL_RECEIPT_LIMIT_MESSAGE,
    idempotencyPrefix: "native-tool-receipt-limit",
    exhaustedError: "native_tool_receipt_limit_continuation_exhausted",
    refuseStopped: true,
    context: run => ({
      livenessContinuationSourceRunId: run.id,
      livenessContinuationReason: NATIVE_TOOL_RECEIPT_LIMIT_CODE,
      livenessContinuationInstruction: NATIVE_TOOL_RECEIPT_LIMIT_HINT,
    }),
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
  // The origin run's own still-pending person input (the ONE carry policy:
  // not ANSWERED, not sender-stopped). bb/tamin6 5cddd3d1 :82-103, by line.
  const carried = await readContinuationCommentInput(input.tx, {
    companyId: input.companyId, issueId: input.issueId, runId: run.id,
  });
  const commentIds = Array.isArray(carried.wakeCommentIds) ? carried.wakeCommentIds : [];
  const interactionIds = Array.isArray(carried.interactionIds) ? carried.interactionIds : [];
  const predecessorContext = { ...run.contextSnapshot };
  // These lanes follow a provider turn.failed terminal, not a never-started
  // bootstrap retry (which keeps the same run and its undelivered input).
  // Keep the origin's own still-pending input for ANSWERED attribution only:
  // no wake comments, card responses or first-turn receipt may replay it.
  // The new turn has ordinary task authority; history comes from retryOfRunId.
  for (const key of [
    "explicitUserContinuation", "wakeCommentId", "wakeCommentIds", "commentId",
    "commentIds", "latestCommentId", "resumeIntent", "followUpRequested",
    "commentContinuation", "firstTurnQueuedInput", "queuedCommentSourceWakeIds",
    "interactionId", "interactionIds", "interactionStatus",
    // The origin's own attribution lists are rebuilt from the carry below, never copied stale (the origin's
    // conversationReplyBoundaryCommentId, a chat turn boundary, stays as bb/tamin6 leaves it).
    "attributionCommentIds", "attributionInteractionIds",
    "paperclipWake", "paperclipWakeComment", "paperclipTaskMarkdown", "paperclipTaskMarkdownCompact",
    "paperclipTaskMarkdownAssignment", "paperclipTaskMarkdownAssignmentCompact", "paperclipTurnContext",
  ]) delete predecessorContext[key];
  const contextSnapshot = {
    ...predecessorContext,
    ...(commentIds.length ? { attributionCommentIds: commentIds } : {}),
    ...(interactionIds.length ? { attributionInteractionIds: interactionIds } : {}),
    issueId: input.issueId,
    taskId: input.issueId,
    forceFreshSession: true,
    retryOfRunId: run.id,
    retryReason: lane.reason,
    wakeReason: lane.reason,
    scheduledRetryAttempt: attempt,
    scheduledRetryAt: dueAt.toISOString(),
    executionRetryAccounting: accountingForScheduledRetry(run, lane.reason, attempt),
    ...lane.context?.(run),
  };
  await notifyIssueAttentionRetentionWork(input.tx, { companyId: input.companyId, issueId: input.issueId, runId: run.id });
  await notifyScheduledRetryDispatch(input.tx, { companyId: run.companyId, runId: run.id });
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
