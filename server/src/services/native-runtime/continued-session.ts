import { normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";
import { currentRunFailureText } from "./native-exact-resume-failure.js";

/**
 * A failed run whose own session can never be resumed: a person's Retry of it starts fresh.
 * A lost resume state has its own error code; the retained-binding refusal is a plain server
 * error finalized under a generic code, so the run's current failure text must be exactly it.
 */
export function sessionCannotContinue(run: { error?: string | null; errorCode?: string | null; resultJson?: unknown } | undefined) {
  return run?.errorCode === "held_box_lost" || run?.errorCode === "native_provider_state_incompatible"
    || currentRunFailureText(run)?.trim() === "native_controller_recovery_missing_evidence:retained_sandbox_binding";
}

/** Only the failed run's current refusal, never an earlier failure in a chained error. */
export function isWarmRecoveryRefusal(run: { status: string; error?: string | null; errorCode?: string | null; resultJson?: unknown } | undefined) {
  if (run?.status !== "failed" || run.errorCode === "held_box_lost") return false;
  if (sessionCannotContinue(run)) return true;
  const failure = (currentRunFailureText(run) ?? run.errorCode ?? "").trim();
  return /^(?:runner_state_identity_mismatch:\s*)?(?:remote_warm_session_not_idle|current_run_not_admitted|prior_owner_terminal_state_indeterminate)(?:$|[;:\s])/.test(failure)
    || failure.startsWith("native_controller_recovery_unsupported:");
}

export function resolveSessionContinuity(provider: unknown, setting: unknown) {
  return setting === "continuous" || setting === "paperclip" ? setting : provider === "pi_rpc" ? "continuous" : "paperclip";
}

/** Keep continuous Pi turns open unless the task configuration explicitly overrides the hold. */
export function withPiOpenTurnDefault(provider: unknown, setting: unknown, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (provider !== "pi_rpc" || resolveSessionContinuity(provider, setting) !== "continuous" ||
      environment.PAPERCLIP_PI_OPEN_TURN_MS !== undefined) return environment;
  return { ...environment, PAPERCLIP_PI_OPEN_TURN_MS: "600000" };
}

/** The page-only marker a fresh native session writes (paperclip-control-plane-port.ts). */
export const NATIVE_FRESH_SESSION_MARKER = "New session · Earlier messages and files are still available.";

/** Server-authored schedule_retry context, bound to the failed turn already in this conversation. */
export function nativeStatusRetryPrompt(wakePayload: unknown, previousRunId?: string): string | null {
  const wake = normalizePaperclipWakePayload(wakePayload);
  const raw = wakePayload && typeof wakePayload === "object" ? wakePayload as Record<string, unknown> : {};
  const retry = raw.nativeStatusRetry && typeof raw.nativeStatusRetry === "object"
    ? raw.nativeStatusRetry as Record<string, unknown> : {};
  // A saved provider session can predate its first task submission. Only the
  // source turn's completed agent message or turn completion proves retained
  // context, not streamed/replayed text. Selected-state coverage is checked
  // again by the managed backend after harness preparation.
  // Queued wakes from older releases have no proof and retain the full task.
  if (wake?.reason !== "issue_status_changed" || retry.cause !== "native_run_failed" || !previousRunId ||
    retry.sourceRunId !== previousRunId || retry.turnSubmitted !== true || retry.sourceTurnCompleted !== true ||
    typeof retry.sourceTurnId !== "string" || !retry.sourceTurnId.trim() ||
    typeof retry.summary !== "string" || !retry.summary.trim() || !wake.issue?.status) return null;
  return `The previous native run failed. This is the automatic retry.\nFailure reason (diagnostic): ${JSON.stringify(retry.summary)}\nStatus: ${wake.issue.status}\nContinue from the recorded progress. Check unfinished actions before repeating them.`;
}

export function decideNativeContinuation(input: {
  provider?: unknown; sessionContinuity?: unknown; hasSession: boolean;
  resetRequired?: boolean; wakeReset?: boolean; wakePayload?: unknown; taskChanged?: boolean; previousRunId?: string; agentId?: string;
}): { continue: boolean; promptOnly: boolean } {
  const mode = resolveSessionContinuity(input.provider, input.sessionContinuity);
  const retained = input.hasSession && !input.resetRequired && (mode === "continuous" || !input.wakeReset);
  const wake = normalizePaperclipWakePayload(input.wakePayload);
  const raw = input.wakePayload && typeof input.wakePayload === "object" ? input.wakePayload as Record<string, unknown> : {};
  const retryContext = raw.nativeStatusRetry && typeof raw.nativeStatusRetry === "object"
    ? raw.nativeStatusRetry as Record<string, unknown> : {};
  const hasAttachments = retryContext.hasUnseenAttachments === true || (raw.attachmentOmissions != null && (!Array.isArray(raw.attachmentOmissions) || raw.attachmentOmissions.length > 0)) ||
    (Array.isArray(raw.comments) && raw.comments.some(comment => comment && typeof comment === "object" &&
      comment.attachments != null && (!Array.isArray(comment.attachments) || comment.attachments.length > 0)));
  const messages = [...(wake?.executionContinuation?.messages ?? wake?.executionContinuation?.resumeDelta?.messages ?? []), ...(wake?.comments ?? [])];
  const fullBodies = !!wake && wake.commentIds.every(id => wake.comments.some(comment => comment.id === id && typeof comment.fullBody === "string"));
  const retry = input.provider === "pi_rpc" && !!nativeStatusRetryPrompt(input.wakePayload, input.previousRunId) &&
    !!wake?.executionContinuation?.resumeDelta && !wake.commentIds.length && !wake.comments.length && !raw.truncated && !raw.fallbackFetchNeeded;
  return { continue: retained, promptOnly: retained && mode === "continuous" && !hasAttachments && !input.taskChanged && !!wake &&
    (retry || ["issue_commented", "issue_reopened_via_comment", "issue_continuation_needed"].includes(wake.reason ?? "")) &&
    (fullBodies || (!raw.truncated && !raw.fallbackFetchNeeded && !wake.comments.some(comment => comment.bodyTruncated))) &&
    (!wake.executionContinuation?.resumeDelta || wake.executionContinuation.resumeDelta.baseRunId === input.previousRunId) &&
    // The agent's own previous replies are already in its session, and the page's fresh-session
    // marker is not input; neither blocks the person's prompt.
    !wake.executionContinuation?.resumeDelta?.messages.some(message => !wake.commentIds.includes(message.id) &&
      !(retry && message.authorType === "user") && !(message.authorType === "agent" && message.authorId === input.agentId) &&
      !(message.authorType === "system" && !message.authorId && message.freshSessionMarker === true && message.body === NATIVE_FRESH_SESSION_MARKER)) &&
    !wake.childIssueSummaries.length && !wake.executionContinuation?.humanResponses?.length && !wake.unresolvedBlockerIssueIds.length &&
    !wake.interactionId && !wake.questionResponse && !wake.externalChatQuestionResponse && !wake.recovery &&
    !wake.executionStage && !wake.taskWatchdog && !wake.livenessContinuation && !wake.dispositionRepair &&
    !wake.documentReviewContext && !wake.planReviewContext && !(wake.annotationDeltas?.length) && !raw.mcpAppContext && !raw.chatCompletionUpdates && !raw.extraContext &&
    !wake.agentMessage && !wake.skillTest && (retry || (wake.commentIds.length > 0 &&
    wake.commentIds.every(id => messages.find(message => message.id === id)?.authorType === "user"))) };
}
