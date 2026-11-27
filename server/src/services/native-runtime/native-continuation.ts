import { savedAutomaticWakesText, withoutDuplicateSavedWakeContext } from "./saved-automatic-wakes.js";
import { isPaperclipExternalChatContractTurn, normalizePaperclipWakePayload, PAPERCLIP_EARLIER_READ_COMMENT_NOTE } from "@paperclipai/adapter-utils/server-utils";
import type { CaseExecutionContext, projectCaseContinuation } from "../case-context.js";
import { caseInstructionAlreadyRepresented } from "../case-context.js";
import { nativeStatusRetryPrompt } from "./continued-session.js";

/** Only new, authorized events belong in an already retained provider conversation.
 * Full bootstrap input is kept separately for an actual provider resume failure.
 */
export function buildNativeContinuationPrompt(input: {
  wakePayload: unknown;
  promptOnly?: boolean;
  savedEventsByReference?: boolean;
  savedEventsReaderAvailable?: boolean;
  savedEventsInlineLimit?: number;
  previousRunId: string;
  issue: { title: string; description: string | null };
  previousIssue: { title: string; description: string | null };
  /** The constructor opts complete plain-text chat batches into the resume protocol. */
  allowExternalChat?: boolean;
  caseContext?: CaseExecutionContext | null;
  workflowCase?: ReturnType<typeof projectCaseContinuation>;
  previousGitHubReviewConfigurationKeys?: readonly string[];
}): string | null {
  const wake = normalizePaperclipWakePayload(withoutDuplicateSavedWakeContext(input.wakePayload));
  const rawWake = input.wakePayload && typeof input.wakePayload === "object"
    ? input.wakePayload as Record<string, unknown> : {};
  const savedEvents = Array.isArray(rawWake.nativeInputRefusalWakes) ? rawWake.nativeInputRefusalWakes : [];
  const savedEventsText = savedAutomaticWakesText(input.wakePayload, input.savedEventsByReference, input.savedEventsReaderAvailable, input.savedEventsInlineLimit);
  if (input.promptOnly && wake) {
    const retryPrompt = nativeStatusRetryPrompt(input.wakePayload, input.previousRunId);
    if (retryPrompt) {
      // The failed run's own history is already present, but person messages
      // arriving since its coverage cursor have not been read by that turn.
      const unseen = wake.executionContinuation?.resumeDelta?.messages.filter(message => message.authorType === "user") ?? [];
      return [retryPrompt, ...unseen.map(message => message.body), savedEventsText].filter(Boolean).join("\n\n");
    }
    const messages = [...(wake.executionContinuation?.messages ?? wake.executionContinuation?.resumeDelta?.messages ?? []), ...wake.comments];
    return [...wake.commentIds.map(id => wake.comments.find(comment => comment.id === id)?.fullBody ?? messages.find(message => message.id === id)!.body), savedEventsText].filter(Boolean).join("\n\n");
  }
  const continuation = wake?.executionContinuation;
  const delta = continuation?.resumeDelta;
  if (!wake || !delta || delta.baseRunId !== input.previousRunId) return null;
  if (input.caseContext && !input.workflowCase) return null;
  const unclaimedTask = wake.reason === "issue_continuation_needed" && rawWake.nativeTaskUnclaimed === true;
  // Attachment descriptors are intentionally omitted by the generic normalizer.
  // Retain the complete bootstrap framing whenever current input needs them or
  // an omission notice. The compact path never guesses an unavailable file.
  const hasAttachmentContext =
    (rawWake.attachmentOmissions != null &&
      (!Array.isArray(rawWake.attachmentOmissions) || rawWake.attachmentOmissions.length > 0)) ||
    (Array.isArray(rawWake.comments) && rawWake.comments.some((comment) =>
      comment && typeof comment === "object" &&
      (comment as Record<string, unknown>).attachments != null &&
      (!Array.isArray((comment as Record<string, unknown>).attachments) ||
        ((comment as Record<string, unknown>).attachments as unknown[]).length > 0)));
  const externalChat = input.allowExternalChat === true &&
    (wake.externalChatProvider === "slack" || wake.externalChatProvider === "github") &&
    isPaperclipExternalChatContractTurn(input.wakePayload) &&
    !hasAttachmentContext && wake.commentIds.length > 0 &&
    wake.latestCommentId === wake.commentIds.at(-1) &&
    new Set(wake.commentIds).size === wake.commentIds.length &&
    wake.commentIds.every((id) => {
      const comments = wake.comments.filter((entry) => entry.id === id);
      const messages = delta.messages.filter((entry) => entry.id === id);
      return comments.length === 1 && messages.length === 1 &&
        messages[0]!.body === comments[0]!.body &&
        messages[0]!.authorType === comments[0]!.authorType &&
        messages[0]!.authorId === comments[0]!.authorId;
    });
  const caseHandoff = wake.reason === "case_handoff" && !!input.workflowCase && !!input.caseContext?.incomingHandoff;
  // Other provider, attachment, question, approval, and recovery paths keep
  // their specialized framing. A matching prior run still gates every delta.
  if (rawWake.chatCompletionUpdates || (wake.externalChatProvider && !externalChat) ||
    (!['issue_commented', 'issue_children_completed'].includes(wake.reason ?? '') && !caseHandoff && !unclaimedTask &&
      !(externalChat && wake.reason === "External chat message received")) ||
    wake.fallbackFetchNeeded || wake.truncated || wake.recovery || continuation?.interruptedRunId ||
    (wake.externalChatExecutionBound && !externalChat) || wake.externalChatQuestionResponse ||
    wake.taskWatchdog || wake.livenessContinuation || wake.activeTreeHold ||
    wake.skillTest || wake.executionStage || wake.agentMessage ||
    wake.documentReviewContext || wake.planReviewContext || wake.annotationDeltas.length > 0
  ) return null;
  const taskChanges = Object.fromEntries(
    (["title", "description"] as const)
      .filter((key) => input.issue[key] !== input.previousIssue[key])
      .map((key) => [key, input.issue[key]]),
  );
  const humanResponses = (continuation?.humanResponses ?? []).filter((answer) => answer.id === wake.interactionId);
  // Do not substitute an unverified interaction outcome for an authorized answer.
  if (wake.interactionId && humanResponses.length === 0) return null;
  const events = {
    ...(wake.githubReviewConfigurations.some((config) => !input.previousGitHubReviewConfigurationKeys?.includes(config.key))
      ? { reviewConfigurations: wake.githubReviewConfigurations.filter((config) => !input.previousGitHubReviewConfigurationKeys?.includes(config.key)) }
      : {}),
    // Only the current authenticated chat delivery belongs to this turn.
    // The generic delta can also include edited historical comments or an old
    // agent response; neither becomes a new provider instruction.
    messages: externalChat
      ? wake.commentIds.map((id) => delta.messages.find((message) => message.id === id)!)
      : delta.messages.filter(message => !input.workflowCase || !caseInstructionAlreadyRepresented(input.caseContext, message)),
    ...(input.workflowCase ? { workflowCase: input.workflowCase } : {}),
    ...(humanResponses.length ? { humanResponses } : {}),
    ...(Object.keys(taskChanges).length ? { taskChanges } : {}),
    ...(wake.childIssueSummaries.length ? { childResults: wake.childIssueSummaries } : {}),
    ...(savedEvents.length ? { savedAutomaticWakeEvents: savedEventsText } : {}),
    ...(wake.childIssueSummaryTruncated ? { childResultsTruncated: true } : {}),
    ...(wake.unresolvedBlockerIssueIds.length ? { unresolvedBlockerIssueIds: wake.unresolvedBlockerIssueIds } : {}),
    // Server-rendered "App context (untrusted)" from the task's MCP Apps widgets:
    // a resumed turn sees the current selection as well as the new comment.
    ...(typeof rawWake.mcpAppContext === "string" && rawWake.mcpAppContext.trim() ? { appContext: rawWake.mcpAppContext.trim() } : {}),
  };
  const earlierRead = wake.comments.filter((comment) => comment.readByEarlierTurn && comment.id
    && events.messages.some((message) => message.id === comment.id)).map((comment) => comment.id!);
  if (earlierRead.length > 0) Object.assign(events, { readByEarlierTurn: { messageIds: earlierRead, note: PAPERCLIP_EARLIER_READ_COMMENT_NOTE } });
  if (unclaimedTask) return [
    "You are continuing the same conversation. The previous task turn ended without an accepted completion report. Do NOT repeat commands, scripts, or other work already done in this task, or re-answer consumed messages. If the work is complete, file your result against the current contract now. Otherwise finish only what remains, then file your result.",
    ...(events.messages.length || Object.keys(events).length > 1 ? [JSON.stringify(events)] : []),
  ].join("\n\n");
  if (!events.messages.length && !humanResponses.length && !wake.childIssueSummaries.length && !savedEvents.length && !Object.keys(taskChanges).length && !input.workflowCase) return null;
  return JSON.stringify(events);
}
