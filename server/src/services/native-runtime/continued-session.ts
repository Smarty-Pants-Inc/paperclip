import { normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";

export function resolveSessionContinuity(provider: unknown, setting: unknown) {
  return setting === "continuous" || setting === "paperclip" ? setting : provider === "pi_rpc" ? "continuous" : "paperclip";
}

/** Keep continuous Pi turns open unless the task configuration explicitly overrides the hold. */
export function withPiOpenTurnDefault(provider: unknown, setting: unknown, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (provider !== "pi_rpc" || resolveSessionContinuity(provider, setting) !== "continuous" ||
      environment.PAPERCLIP_PI_OPEN_TURN_MS !== undefined) return environment;
  return { ...environment, PAPERCLIP_PI_OPEN_TURN_MS: "600000" };
}

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
  const messages = [...(wake?.executionContinuation?.messages ?? wake?.executionContinuation?.resumeDelta?.messages ?? []), ...(wake?.comments ?? [])];
  const fullBodies = !!wake && wake.commentIds.every(id => wake.comments.some(comment => comment.id === id && typeof comment.fullBody === "string"));
  return { continue: retained, promptOnly: retained && mode === "continuous" && !hasAttachments && !input.taskChanged && !!wake && ["issue_commented", "issue_reopened_via_comment", "issue_continuation_needed"].includes(wake.reason ?? "") &&
    (fullBodies || (!raw.truncated && !raw.fallbackFetchNeeded && !wake.comments.some(comment => comment.bodyTruncated))) &&
    (!wake.executionContinuation?.resumeDelta || wake.executionContinuation.resumeDelta.baseRunId === input.previousRunId) &&
    // The agent's own previous replies are already in its session; they never block the person's prompt.
    !wake.executionContinuation?.resumeDelta?.messages.some(message => !wake.commentIds.includes(message.id) && !(message.authorType === "agent" && message.authorId === input.agentId)) &&
    !wake.childIssueSummaries.length && !wake.executionContinuation?.humanResponses?.length && !wake.unresolvedBlockerIssueIds.length &&
    !wake.interactionId && !wake.questionResponse && !wake.externalChatQuestionResponse && !wake.recovery &&
    !wake.executionStage && !wake.taskWatchdog && !wake.livenessContinuation && !wake.dispositionRepair &&
    !wake.documentReviewContext && !wake.planReviewContext && !(wake.annotationDeltas?.length) && !raw.mcpAppContext && !raw.chatCompletionUpdates && !raw.extraContext &&
    !wake.agentMessage && !wake.skillTest && wake.commentIds.length > 0 &&
    wake.commentIds.every(id => messages.find(message => message.id === id)?.authorType === "user") };
}
