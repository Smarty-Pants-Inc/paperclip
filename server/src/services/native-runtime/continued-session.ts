import { normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";
import { currentRunFailureText } from "./native-exact-resume-failure.js";

/**
 * A failed run whose own session can never be resumed: a person's Retry of it starts fresh.
 * A lost resume state has its own error code; the retained-binding refusal is a plain server
 * error finalized under a generic code, so the run's current failure text must be exactly it.
 */
export function sessionCannotContinue(run: { error?: string | null; errorCode?: string | null; resultJson?: unknown } | undefined) {
  return run?.errorCode === "native_provider_state_incompatible"
    || currentRunFailureText(run)?.trim() === "native_controller_recovery_missing_evidence:retained_sandbox_binding";
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

export function decideNativeContinuation(input: {
  provider?: unknown; sessionContinuity?: unknown; hasSession: boolean;
  resetRequired?: boolean; wakeReset?: boolean; wakePayload?: unknown; taskChanged?: boolean; previousRunId?: string; agentId?: string;
}): { continue: boolean; promptOnly: boolean } {
  const mode = resolveSessionContinuity(input.provider, input.sessionContinuity);
  const retained = input.hasSession && !input.resetRequired && (mode === "continuous" || !input.wakeReset);
  const wake = normalizePaperclipWakePayload(input.wakePayload);
  const raw = input.wakePayload && typeof input.wakePayload === "object" ? input.wakePayload as Record<string, unknown> : {};
  const hasAttachments = (raw.attachmentOmissions != null && (!Array.isArray(raw.attachmentOmissions) || raw.attachmentOmissions.length > 0)) ||
    (Array.isArray(raw.comments) && raw.comments.some(comment => comment && typeof comment === "object" &&
      comment.attachments != null && (!Array.isArray(comment.attachments) || comment.attachments.length > 0)));
  const delta = wake?.executionContinuation?.resumeDelta;
  const messages = delta?.messages ?? [...(wake?.executionContinuation?.messages ?? []), ...(wake?.comments ?? [])];
  // A matching delta is authoritative: stale wake comment IDs are not new input.
  const commentIds = wake?.commentIds.filter(id => !delta || messages.some(message => message.id === id)) ?? [];
  const fullBodies = !!wake && commentIds.every(id => wake.comments.some(comment => comment.id === id && typeof comment.fullBody === "string"));
  return { continue: retained, promptOnly: retained && input.provider === "pi_rpc" && mode === "continuous" && !hasAttachments && !input.taskChanged && !!wake &&
    (fullBodies || (!raw.truncated && !raw.fallbackFetchNeeded && !wake.comments.some(comment => comment.bodyTruncated))) &&
    (!wake.executionContinuation?.resumeDelta || wake.executionContinuation.resumeDelta.baseRunId === input.previousRunId) &&
    // The agent's own previous replies are already in its session, and the page's fresh-session
    // marker is not input; neither blocks the person's prompt.
    !delta?.messages.some(message => !commentIds.includes(message.id) && !(message.authorType === "agent" && message.authorId === input.agentId) &&
      !(message.authorType === "system" && !message.authorId && message.freshSessionMarker === true && message.body === NATIVE_FRESH_SESSION_MARKER)) &&
    !wake.childIssueSummaries.length && !wake.executionContinuation?.humanResponses?.length && !wake.unresolvedBlockerIssueIds.length &&
    !wake.interactionId && !wake.questionResponse && !wake.externalChatQuestionResponse && !wake.recovery &&
    !wake.executionStage && !wake.taskWatchdog && !wake.livenessContinuation && !wake.dispositionRepair &&
    !wake.documentReviewContext && !wake.planReviewContext && !(wake.annotationDeltas?.length) && !raw.mcpAppContext && !raw.chatCompletionUpdates && !raw.extraContext &&
    !wake.agentMessage && !wake.skillTest && (commentIds.length > 0 || !!delta) &&
    commentIds.every(id => messages.find(message => message.id === id)?.authorType === "user") };
}
