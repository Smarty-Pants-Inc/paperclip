import { isPaperclipExternalChatContractTurn, normalizePaperclipWakePayload, PAPERCLIP_EARLIER_READ_COMMENT_NOTE } from "@paperclipai/adapter-utils/server-utils";
import type { CaseExecutionContext, projectCaseContinuation } from "../case-context.js";
import { caseInstructionAlreadyRepresented } from "../case-context.js";
import { isDeepStrictEqual } from "node:util";

// Only agent-visible task fields, never checkout/run bookkeeping or timestamps.
// This snapshot is saved in the server's redacted paperclipIssue context, not
// the Runner protocol. Older turns without it safely receive the full prompt.
const taskStringFields = ["identifier", "title", "description", "workMode", "status", "priority",
  "assigneeAgentId", "assigneeUserId", "parentId", "projectId", "goalId", "conversationAgentId",
  "reviewPolicy", "responsibleUserId", "billingCode"] as const;
export type NativeTaskSnapshot = Record<typeof taskStringFields[number], string | null> & {
  titleNeedsGeneration: boolean;
  executionPolicy: Record<string, unknown> | null;
};
export function readNativeTaskSnapshot(value: unknown): NativeTaskSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!["title", "workMode", "status", "priority"].every(key => typeof row[key] === "string") ||
    !taskStringFields.every(key => Object.hasOwn(row, key) && (row[key] === null || typeof row[key] === "string")) ||
    typeof row.titleNeedsGeneration !== "boolean" || !Object.hasOwn(row, "executionPolicy") ||
    (row.executionPolicy !== null && (typeof row.executionPolicy !== "object" || Array.isArray(row.executionPolicy)))) return null;
  return Object.fromEntries([...taskStringFields, "titleNeedsGeneration", "executionPolicy"].map(key => [key, row[key]])) as NativeTaskSnapshot;
}
export function nativeTaskChanges(current: unknown, previous: unknown) {
  const row = readNativeTaskSnapshot(current);
  const before = readNativeTaskSnapshot(previous);
  if (!row || !before) return null;
  return Object.fromEntries((Object.keys(row) as (keyof NativeTaskSnapshot)[])
    .filter(key => !isDeepStrictEqual(row[key], before[key]))
    .map(key => [key, { old: before[key], new: row[key] }]));
}
const taskValue = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);

// Every admitted key is either represented below or routed through its full
// specialized framing. Future wake fields must not silently become 'no news'.
const wakeMeaningFields = ["reviewDecision", "notificationReason", "retryCause", "retrySummary", "unblockAction", "monitor"] as const;
const compactWakeKeys = new Set([
  "reason", "executionContinuation", "issue", "commentIds", "latestCommentId", "comments", "commentWindow",
  "requestedCount", "includedCount", "missingCount", "truncated", "fallbackFetchNeeded", "attachmentOmissions",
  "githubReviewConfigurations", "chatCompletionUpdates", "externalChatProvider", "externalChatExecutionBound",
  "externalChatQuestionResponse", "recovery", "agentMessage", "childIssueSummaries", "childIssueSummaryTruncated",
  "blockerStall", "dispositionRepair", "livenessContinuation", "interactionKind", "interactionStatus", "interactionId",
  "sourceRunId", "externalInteractionContinuation", "checkboxSelection", "questionResponse", "checkedOutByHarness",
  "simplifiedEnglishInteractions", "dependencyBlockedInteraction", "treeHoldInteraction", "activeTreeHold",
  "unresolvedBlockerIssueIds", "unresolvedBlockerSummaries", "executionStage", "taskWatchdog", "skillTest",
  "continuationSummary", "annotationDeltas", "planReviewContext", "documentReviewContext", "executionWorkspace",
  "mcpAppContext", "extraContext", ...wakeMeaningFields,
]);

/** Only new, authorized events belong in an already retained provider conversation.
 * Full bootstrap input is kept separately for an actual provider resume failure.
 */
export function buildNativeContinuationPrompt(input: {
  wakePayload: unknown;
  previousWakePayload?: unknown;
  promptOnly?: boolean;
  continuousPi?: boolean;
  taskSnapshot?: NativeTaskSnapshot | null;
  previousTaskSnapshot?: NativeTaskSnapshot | null;
  /** Authoritative accepted result for this exact preceding input, not just a saved checkpoint. */
  previousTurnDelivered?: boolean;
  previousRunId: string;
  issue: { title: string; description: string | null };
  previousIssue: { title: string; description: string | null };
  /** The constructor opts complete plain-text chat batches into the resume protocol. */
  allowExternalChat?: boolean;
  caseContext?: CaseExecutionContext | null;
  workflowCase?: ReturnType<typeof projectCaseContinuation>;
  previousGitHubReviewConfigurationKeys?: readonly string[];
}): string | null {
  const wake = normalizePaperclipWakePayload(input.wakePayload);
  const previousWake = normalizePaperclipWakePayload(input.previousWakePayload);
  const wakeReasonChanged = !previousWake || wake?.reason !== previousWake.reason;
  const changes = input.continuousPi ? nativeTaskChanges(input.taskSnapshot, input.previousTaskSnapshot) : null;
  // A title/description-only legacy snapshot cannot prove that nothing changed.
  if (input.continuousPi && !changes) return null;
  const changeLines = Object.entries(changes ?? {}).map(([key, value]) => `${key}: ${taskValue(value.old)} -> ${taskValue(value.new)}`);
  const continuation = wake?.executionContinuation;
  const delta = continuation?.resumeDelta;
  if (!wake || (delta && delta.baseRunId !== input.previousRunId)) return null;
  if (input.caseContext && !input.workflowCase) return null;
  const rawWake = input.wakePayload && typeof input.wakePayload === "object"
    ? input.wakePayload as Record<string, unknown> : {};
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
  if (input.continuousPi && (input.previousTurnDelivered !== true ||
    Object.keys(rawWake).some(key => !compactWakeKeys.has(key)))) return null;
  // These guards precede BOTH compact forms. In particular, complete comment
  // bodies never override a truncated envelope, an interrupted turn or a hold.
  if (wake.fallbackFetchNeeded || wake.truncated || wake.comments.some(comment => comment.bodyTruncated) ||
    wake.recovery || continuation?.interruptedRunId || wake.externalChatQuestionResponse ||
    wake.taskWatchdog || wake.livenessContinuation || wake.activeTreeHold || wake.skillTest ||
    wake.executionStage || wake.agentMessage || wake.documentReviewContext || wake.planReviewContext ||
    wake.annotationDeltas.length > 0 || rawWake.chatCompletionUpdates ||
    (input.continuousPi && (hasAttachmentContext || wake.unresolvedBlockerIssueIds.length > 0 ||
      wake.unresolvedBlockerSummaries.length > 0 || rawWake.mcpAppContext || rawWake.extraContext ||
      wake.dispositionRepair || wake.blockerStall || wake.continuationSummary || wake.dependencyBlockedInteraction ||
      wake.treeHoldInteraction || wake.checkboxSelection || wake.questionResponse || wake.executionWorkspace ||
      wake.externalInteractionContinuation || wake.interactionKind || wake.interactionStatus || wake.sourceRunId ||
      wake.simplifiedEnglishInteractions || wake.issue?.descriptionTruncated || wake.missingCount > 0))) return null;
  const previousRawWake = input.previousWakePayload && typeof input.previousWakePayload === "object"
    ? input.previousWakePayload as Record<string, unknown> : {};
  const meaningLines = input.continuousPi ? wakeMeaningFields.filter(key => Object.hasOwn(rawWake, key) || Object.hasOwn(previousRawWake, key))
    .map(key => `${key}: ${taskValue(rawWake[key] ?? null)}`) : [];
  // Removing the last blocker is news too, even if status is unchanged.
  if (input.continuousPi && previousWake?.unresolvedBlockerIssueIds.length && !wake.unresolvedBlockerIssueIds.length)
    meaningLines.push("unresolvedBlockerIssueIds: []");
  const state = input.taskSnapshot;
  const header = [`Wake reason: ${wake.reason ?? "unspecified"}`,
    ...(input.continuousPi && state ? [`status: ${state.status}; assigneeAgentId: ${state.assigneeAgentId}; assigneeUserId: ${state.assigneeUserId}; priority: ${state.priority}`] : []),
    ...changeLines, ...meaningLines];
  const externalChat = !!delta && input.allowExternalChat === true &&
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
  if ((wake.externalChatProvider && !externalChat) || (wake.externalChatExecutionBound && !externalChat) ||
    (!input.continuousPi && !['issue_commented', 'issue_children_completed'].includes(wake.reason ?? '') && !caseHandoff &&
      !(externalChat && wake.reason === "External chat message received"))) return null;
  if (input.promptOnly && !externalChat && !input.caseContext && !wake.interactionId &&
    !continuation?.humanResponses?.length && !wake.childIssueSummaries.length && !wake.childIssueSummaryTruncated &&
    !wake.githubReviewConfigurations.some(config => !input.previousGitHubReviewConfigurationKeys?.includes(config.key))) {
    const messages = delta?.messages ?? [...(continuation?.messages ?? []), ...wake.comments];
    const commentIds = wake.commentIds.filter(id => !delta || messages.some(message => message.id === id));
    const text = commentIds.map(id => wake.comments.find(comment => comment.id === id)?.fullBody ?? messages.find(message => message.id === id)?.body ?? "").join("\n\n");
    if (!text && changeLines.length === 0 && meaningLines.length === 0 && !wakeReasonChanged) return "Continue the task; nothing new arrived since your last turn.";
    return [...header, ...(text ? [text] : [])].join("\n\n");
  }
  if (!delta) return null;
  const taskChanges = changes ?? Object.fromEntries(
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
    // Pi's header already names all old -> new values; do not duplicate them.
    ...(!input.continuousPi && Object.keys(taskChanges).length ? { taskChanges } : {}),
    ...(wake.childIssueSummaries.length ? { childResults: wake.childIssueSummaries } : {}),
    ...(wake.childIssueSummaryTruncated ? { childResultsTruncated: true } : {}),
    ...(wake.unresolvedBlockerIssueIds.length ? { unresolvedBlockerIssueIds: wake.unresolvedBlockerIssueIds } : {}),
    // Server-rendered "App context (untrusted)" from the task's MCP Apps widgets:
    // a resumed turn sees the current selection as well as the new comment.
    ...(typeof rawWake.mcpAppContext === "string" && rawWake.mcpAppContext.trim() ? { appContext: rawWake.mcpAppContext.trim() } : {}),
  };
  const earlierRead = wake.comments.filter((comment) => comment.readByEarlierTurn && comment.id
    && events.messages.some((message) => message.id === comment.id)).map((comment) => comment.id!);
  if (earlierRead.length > 0) Object.assign(events, { readByEarlierTurn: { messageIds: earlierRead, note: PAPERCLIP_EARLIER_READ_COMMENT_NOTE } });
  const hasEvents = Object.entries(events).some(([key, value]) => key !== "messages" || (Array.isArray(value) && value.length > 0));
  if (!hasEvents && meaningLines.length === 0 && changeLines.length === 0 && (!input.continuousPi || !wakeReasonChanged))
    return input.continuousPi ? "Continue the task; nothing new arrived since your last turn." : null;
  const body = JSON.stringify(events);
  return input.continuousPi
    ? [...header, ...(hasEvents ? [body] : [])].join("\n\n")
    : body;
}
