import { isPaperclipExternalChatContractTurn, normalizePaperclipWakePayload, PAPERCLIP_EARLIER_READ_COMMENT_NOTE } from "@paperclipai/adapter-utils/server-utils";
import type { CaseExecutionContext, projectCaseContinuation } from "../case-context.js";
import { caseInstructionAlreadyRepresented } from "../case-context.js";
import { nativeStatusRetryPrompt } from "./continued-session.js";

/** Independent work intent: an empty delta must still produce a model turn.
 * Shared by automatic delta routing and the empty-system-wake guard. */
export const NATIVE_AUTOMATIC_CONTINUATION_REASONS: readonly string[] = [
  "issue_continuation_needed", "issue_status_changed", "issue_assigned", "issue_blockers_resolved",
  "retry_failed_run", "heartbeat_timer", "issue_monitor_due", "issue_blocker_stalled",
];

export const NATIVE_UNCLAIMED_CONTINUATION_INSTRUCTION = "You are continuing the same conversation. The previous task turn ended without an accepted completion report. Do NOT repeat commands, scripts, or other work already done in this task, or re-answer consumed messages. If the work is complete, file your result against the current contract now. Otherwise finish only what remains, then file your result.";

export function nativeReplyInstruction(receipt: { id: string; receivedAt: string }): string {
  return `Reply to the comment you received at ${receipt.receivedAt} (id ${receipt.id}).`;
}

/** Read only the structured envelope or our fixed legacy unclaimed framing. */
export function readNativeContinuationEvents(prompt: unknown): Record<string, unknown> | null {
  if (typeof prompt !== "string") return null;
  const text = prompt.startsWith(`${NATIVE_UNCLAIMED_CONTINUATION_INSTRUCTION}\n\n`)
    ? prompt.slice(NATIVE_UNCLAIMED_CONTINUATION_INSTRUCTION.length + 2) : prompt;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

/** Inherited receipt metadata is not proof this turn requested an answer. */
export function nativeCommentSubmitted(input: {
  prompt: unknown;
  message: { id: string; updatedAt: string; body: string };
  receipt?: { id: string; updatedAt: string; receivedAt: string };
  bootstrap: boolean;
}): boolean {
  const { prompt, message, receipt } = input;
  const instruction = receipt?.id === message.id && receipt.updatedAt === message.updatedAt ? nativeReplyInstruction(receipt) : null;
  if (typeof prompt !== "string") return input.bootstrap && !!message.body.trim();
  const events = readNativeContinuationEvents(prompt);
  if (events) return (Array.isArray(events.messages) && events.messages.some(value => {
    const sent = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return sent.id === message.id && sent.updatedAt === message.updatedAt && sent.body === message.body && !!message.body.trim();
  })) || !!(instruction && Array.isArray(events.replyInstructions) && events.replyInstructions.includes(instruction));
  // Plain prompt-only input is a sequence of whole message/instruction blocks.
  return !!message.body.trim() && (`\n\n${prompt}\n\n`).includes(`\n\n${message.body}\n\n`) ||
    !!(instruction && prompt.split("\n\n").includes(instruction));
}

/** Only new, authorized events belong in an already retained provider conversation.
 * Full bootstrap input is kept separately for an actual provider resume failure.
 */
export function buildNativeContinuationPrompt(input: {
  wakePayload: unknown;
  promptOnly?: boolean;
  /** The constructor verified the previous input belongs to this retained session. */
  retainedSession?: boolean;
  previousRunId: string;
  agentId?: string;
  issue: { title: string; description: string | null };
  previousIssue: { title: string; description: string | null };
  /** The constructor opts complete plain-text chat batches into the resume protocol. */
  allowExternalChat?: boolean;
  caseContext?: CaseExecutionContext | null;
  workflowCase?: ReturnType<typeof projectCaseContinuation>;
  previousGitHubReviewConfigurationKeys?: readonly string[];
}): string | null {
  const wake = normalizePaperclipWakePayload(input.wakePayload);
  const rawWake = input.wakePayload && typeof input.wakePayload === "object"
    ? input.wakePayload as Record<string, unknown> : {};
  // Reopen/resume is independent work even when its named comment already
  // has a reply. Both roads retain the specialized bootstrap framing.
  const unclaimedTask = wake?.reason === "issue_continuation_needed" && rawWake.nativeTaskUnclaimed === true;
  const automaticWake = input.retainedSession === true &&
    NATIVE_AUTOMATIC_CONTINUATION_REASONS.includes(wake?.reason ?? "") &&
    !rawWake.nativeStatusRetry;
  if ((["issue_reopened_via_comment", "issue_continuation_needed"].includes(wake?.reason ?? "") && !unclaimedTask && !automaticWake) ||
      rawWake.resumeIntent || rawWake.followUpRequested === true || rawWake.reopenedFrom) return null;
  const continuation = wake?.executionContinuation;
  const delta = continuation?.resumeDelta ?? (automaticWake ? {
    baseRunId: input.previousRunId,
    messages: continuation?.messages.filter(message => wake!.commentIds.includes(message.id)) ?? [],
    receivedComments: undefined,
  } : undefined);
  const receipts = new Map((delta?.receivedComments ?? []).filter(receipt => {
    const message = continuation?.messages.find(message => message.id === receipt.id);
    return !message || message.updatedAt === receipt.updatedAt;
  }).map(receipt => [receipt.id, receipt]));
  const stopped = new Set([...receipts.values()].filter(receipt => receipt.stopped).map(receipt => receipt.id));
  // An empty delta alone does not prove that a named person's input was seen.
  // Restore only unseen named input, never bodies backed by provider receipts.
  if (wake?.comments.some(comment => comment.authorType === "user" && !comment.id)) return null;
  // Wake IDs are not an exhaustive list of owed input. A prompt-only turn
  // must also account for every person's message carried by the delta.
  const namedCommentIds = [...new Set([...(wake?.commentIds ?? []),
    ...(delta?.messages.filter(message => message.authorType === "user").map(message => message.id) ?? []),
  ])].filter(id => !stopped.has(id));
  // Merely carrying full history does not request replies to that history.
  // A new person wake may also pick up an ACK'd steer or a failed reply request;
  // a system wake cannot manufacture an instruction-only turn for either.
  const replyInstructions = namedCommentIds.length ? [...receipts.values()]
    .filter(receipt => !receipt.answered && !receipt.stopped && !receipt.replyRequested &&
      (namedCommentIds.includes(receipt.id) || receipt.replyOwed))
    .map(nativeReplyInstruction) : [];
  const unseenNamed = namedCommentIds.filter(id => !receipts.has(id));
  const messages = (delta?.messages ?? []).filter(message => !receipts.has(message.id) &&
    !(message.authorType === "agent" && message.authorId === input.agentId) && !message.freshSessionMarker);
  for (const id of unseenNamed) {
    if (messages.some(message => message.id === id)) continue;
    const message = continuation?.messages.find(message => message.id === id);
    if (message) { messages.push(message); continue; }
    const comment = wake?.comments.find(comment => comment.id === id);
    if (comment) messages.push({ id, authorType: comment.authorType ?? "unknown", authorId: comment.authorId,
      body: comment.fullBody ?? comment.body, createdAt: comment.createdAt ?? "", updatedAt: comment.createdAt ?? "",
      deleted: false, sourceTrust: null });
  }
  if (input.promptOnly && wake && !unclaimedTask && !automaticWake) {
    const retryPrompt = nativeStatusRetryPrompt(input.wakePayload, input.previousRunId);
    if (retryPrompt) {
      // The failed run's own history is already present, but person messages
      // arriving since its coverage cursor have not been read by that turn.
      const unseen = wake.executionContinuation?.resumeDelta?.messages.filter(message => message.authorType === "user") ?? [];
      return [retryPrompt, ...unseen.map(message => message.body)].join("\n\n");
    }
    if (delta && delta.baseRunId !== input.previousRunId) return null;
    const bodies = unseenNamed.map(id => wake.comments.find(comment => comment.id === id)?.fullBody ??
      messages.find(message => message.id === id)?.body);
    // Missing input is not nothing-new; keep the specialized bootstrap framing.
    if (bodies.some(body => typeof body !== "string" || !body.trim())) return null;
    return [...bodies, ...replyInstructions].join("\n\n");
  }
  if (!wake || !delta || delta.baseRunId !== input.previousRunId) return null;
  if (input.caseContext && !input.workflowCase) return null;
  // A stalled dependency is a bounded triage wake, never permission to do its work.
  // Missing current stall context must keep the specialized bootstrap.
  if (wake.reason === "issue_blocker_stalled" && !wake.blockerStall) return null;
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
    (!['issue_commented', 'issue_children_completed'].includes(wake.reason ?? '') && !caseHandoff && !unclaimedTask && !automaticWake &&
      !(externalChat && wake.reason === "External chat message received")) ||
    wake.fallbackFetchNeeded || wake.truncated || wake.recovery || continuation?.interruptedRunId ||
    (wake.externalChatExecutionBound && !externalChat) || wake.externalChatQuestionResponse ||
    wake.taskWatchdog || wake.livenessContinuation || wake.activeTreeHold ||
    wake.skillTest || wake.executionStage || wake.agentMessage ||
    wake.documentReviewContext || wake.planReviewContext || wake.annotationDeltas.length > 0 ||
    (automaticWake && (hasAttachmentContext || wake.interactionId || wake.questionResponse || wake.dispositionRepair))
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
      : messages.filter(message => !input.workflowCase || !caseInstructionAlreadyRepresented(input.caseContext, message)),
    ...(replyInstructions.length ? { replyInstructions } : {}),
    ...(input.workflowCase ? { workflowCase: input.workflowCase } : {}),
    ...(humanResponses.length ? { humanResponses } : {}),
    ...(Object.keys(taskChanges).length ? { taskChanges } : {}),
    ...(wake.childIssueSummaries.length ? { childResults: wake.childIssueSummaries } : {}),
    ...(wake.childIssueSummaryTruncated ? { childResultsTruncated: true } : {}),
    ...(wake.unresolvedBlockerIssueIds.length ? { unresolvedBlockerIssueIds: wake.unresolvedBlockerIssueIds } : {}),
    ...(automaticWake && wake.blockerStall ? {
      blockerStall: wake.blockerStall,
      instruction: "Continue by triaging the stalled dependency, then stop: reassign its existing task, escalate to the board with the needed recovery action, or block this task with a reason. Do not redo the dependency's assigned work or treat blocker-dependent deliverables as unblocked; do not wait silently.",
    } : {}),
    // Server-rendered "App context (untrusted)" from the task's MCP Apps widgets:
    // a resumed turn sees the current selection as well as the new comment.
    ...(typeof rawWake.mcpAppContext === "string" && rawWake.mcpAppContext.trim() ? { appContext: rawWake.mcpAppContext.trim() } : {}),
  };
  const earlierRead = wake.comments.filter((comment) => comment.readByEarlierTurn && comment.id
    && events.messages.some((message) => message.id === comment.id)).map((comment) => comment.id!);
  if (earlierRead.length > 0) Object.assign(events, { readByEarlierTurn: { messageIds: earlierRead, note: PAPERCLIP_EARLIER_READ_COMMENT_NOTE } });
  if (unclaimedTask) {
    // Verified automatic input stays JSON for selected-turn byte attribution.
    if (automaticWake) return JSON.stringify({ instruction: NATIVE_UNCLAIMED_CONTINUATION_INSTRUCTION, ...events });
    return [NATIVE_UNCLAIMED_CONTINUATION_INSTRUCTION,
      ...(events.messages.length || Object.keys(events).length > 1 ? [JSON.stringify(events)] : []),
    ].join("\n\n");
  }
  // Child completion is independent work intent. Its producer does not
  // guarantee summaries; keep the pass-1 bootstrap if there is no delta.
  if (wake.reason === "issue_children_completed" && events.messages.length === 0 &&
      Object.keys(events).every(key => key === "messages" || key === "replyInstructions")) return null;
  // Missing named input must never masquerade as an empty system wake.
  if (unseenNamed.some(id => !messages.some(message => message.id === id))) return null;
  // Keep the event envelope parseable by the selected-turn byte guard.
  if (automaticWake) return JSON.stringify({
    resume: `Conversation resumed: ${wake.reason!.replaceAll("_", " ")}. Status: ${wake.issue?.status ?? "unknown"}. Continue the task from the recorded progress; do not repeat completed work.`,
    ...events,
  });
  return JSON.stringify(events);
}
