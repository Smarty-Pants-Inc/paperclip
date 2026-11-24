import { normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";

export function decideNativeContinuation(input: {
  provider?: unknown; sessionContinuity?: unknown; hasSession: boolean;
  resetRequired?: boolean; wakeReset?: boolean; wakePayload?: unknown; taskChanged?: boolean; previousRunId?: string;
}): { continue: boolean; promptOnly: boolean } {
  const mode = input.sessionContinuity === "continuous" || input.sessionContinuity === "paperclip"
    ? input.sessionContinuity : input.provider === "pi_rpc" ? "continuous" : "paperclip";
  const retained = input.hasSession && !input.resetRequired && (mode === "continuous" || !input.wakeReset);
  const wake = normalizePaperclipWakePayload(input.wakePayload);
  const raw = input.wakePayload && typeof input.wakePayload === "object" ? input.wakePayload as Record<string, unknown> : {};
  const hasAttachments = (raw.attachmentOmissions != null && (!Array.isArray(raw.attachmentOmissions) || raw.attachmentOmissions.length > 0)) ||
    (Array.isArray(raw.comments) && raw.comments.some(comment => comment && typeof comment === "object" &&
      comment.attachments != null && (!Array.isArray(comment.attachments) || comment.attachments.length > 0)));
  const messages = [...(wake?.executionContinuation?.messages ?? wake?.executionContinuation?.resumeDelta?.messages ?? []), ...(wake?.comments ?? [])];
  return { continue: retained, promptOnly: retained && mode === "continuous" && !hasAttachments && !input.taskChanged && !!wake && wake.reason === "issue_commented" &&
    !raw.truncated && !raw.fallbackFetchNeeded && !wake.comments.some(comment => comment.bodyTruncated) &&
    (!wake.executionContinuation?.resumeDelta || wake.executionContinuation.resumeDelta.baseRunId === input.previousRunId) &&
    !wake.executionContinuation?.resumeDelta?.messages.some(message => !wake.commentIds.includes(message.id)) &&
    !wake.childIssueSummaries.length && !wake.executionContinuation?.humanResponses?.length && !wake.unresolvedBlockerIssueIds.length &&
    !wake.interactionId && !wake.questionResponse && !wake.externalChatQuestionResponse && !wake.recovery &&
    !wake.executionStage && !wake.taskWatchdog && !wake.livenessContinuation && !wake.dispositionRepair &&
    !wake.documentReviewContext && !wake.planReviewContext && !(wake.annotationDeltas?.length) && !raw.mcpAppContext && !raw.chatCompletionUpdates &&
    !wake.agentMessage && !wake.skillTest && wake.commentIds.length > 0 &&
    wake.commentIds.every(id => messages.find(message => message.id === id)?.authorType === "user") };
}
