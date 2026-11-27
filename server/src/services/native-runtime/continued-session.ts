import { normalizePaperclipWakePayload } from "@paperclipai/adapter-utils/server-utils";
import { currentRunFailureText } from "./native-exact-resume-failure.js";
import { HttpError } from "../../errors.js";

/**
 * A failed run whose own session can never be resumed: a person's Retry of it starts fresh.
 * A lost resume state has its own error code; the retained-binding refusal is a plain server
 * error finalized under a generic code, so the run's current failure text must be exactly it.
 */
export function sessionCannotContinue(run: { error?: string | null; errorCode?: string | null; resultJson?: unknown } | undefined) {
  return ["saved_session_unavailable", "native_provider_side_effect_pending", "native_provider_state_incompatible"].includes(run?.errorCode ?? "")
    || currentRunFailureText(run)?.trim() === "native_controller_recovery_missing_evidence:retained_sandbox_binding";
}

export type RetryReasonCode = "saved_session_unavailable" | "side_effect_pending" | "session_cannot_continue" | "configuration_reset" | "credential_changed";
export type RetryConsequence = { retryStartsNewSession: boolean; retryReasonCode?: RetryReasonCode; retryReason?: string; retryDisclosure?: string };
export type RetrySelectorFacts = {
  adapterType: string; config: Record<string, unknown>; chat: boolean;
  run: { errorCode?: string | null; error?: string | null; resultJson?: unknown };
  requiresIsolatedWorkspace?: boolean; savedSessionExpected?: boolean; checkpointAvailable?: boolean;
  credentialCompatible?: boolean; hardResetCategories?: string[];
};
export function agentRetryStartsNewSession(config: Record<string, unknown> | null | undefined) {
  return resolveSessionContinuity(config?.provider, config?.sessionContinuity) !== "continuous";
}

/** Shared wording for the early offer and actual dispatch refusal. The early
 * selector is only a prediction; actual reset/rebind decisions must revalidate. */
export function classifyRetryConsequence(facts: RetrySelectorFacts): RetryConsequence {
  const detail = facts.run.resultJson && typeof facts.run.resultJson === "object" ? facts.run.resultJson as Record<string, unknown> : {};
  const target = facts.chat ? "chat" : "task";
  const replay = ["process", "http", "webhook"].includes(facts.adapterType);
  let retryReasonCode: RetryReasonCode | undefined;
  let retryReason: string | undefined;
  if (facts.run.errorCode === "native_provider_side_effect_pending" || detail.retryReasonCode === "side_effect_pending") {
    retryReasonCode = "side_effect_pending";
    retryReason = "The last action may or may not have run. Check it before you continue.";
  } else if (facts.credentialCompatible === false || detail.retryReasonCode === "credential_changed") {
    retryReasonCode = "credential_changed"; retryReason = "The credential for the saved session changed.";
  } else if (facts.hardResetCategories?.length || detail.retryReasonCode === "configuration_reset") {
    retryReasonCode = "configuration_reset";
    retryReason = typeof detail.retryReason === "string" ? detail.retryReason : `The saved session requires a configuration reset: ${facts.hardResetCategories?.join(", ") || "saved configuration changed"}.`;
  } else if (facts.run.errorCode === "saved_session_unavailable" || (facts.savedSessionExpected && facts.checkpointAvailable === false)) {
    retryReasonCode = "saved_session_unavailable"; retryReason = "The saved session could not be continued.";
  } else if (sessionCannotContinue(facts.run) || facts.requiresIsolatedWorkspace) {
    retryReasonCode = "session_cannot_continue";
    retryReason = facts.requiresIsolatedWorkspace ? "The earlier run's stop could not be confirmed." : "The earlier session cannot be resumed.";
  }
  const retryStartsNewSession = !replay && Boolean(retryReasonCode || facts.requiresIsolatedWorkspace || agentRetryStartsNewSession(facts.config));
  const retryDisclosure = replay ? `Retry runs the configured ${facts.adapterType === "process" ? "process" : "webhook"} action again. Check its earlier effects before retrying.`
    : retryReasonCode === "side_effect_pending" ? "Start a new session anyway: it will be told the last action's outcome is unknown."
    : facts.requiresIsolatedWorkspace ? `Retry starts a new session for this ${target}. It copies readable current files at your press into a new, separate workspace; the earlier directory stays with the earlier run. If its box cannot be read, the last saved work is used instead: the earlier run may still be running and could change files. Its permission to write to this ${target} is revoked.`
    : `Retry starts a new session for this ${target}. It receives the earlier messages and available files as context, not the agent's tool steps; the old session is not resumed.`;
  return { retryStartsNewSession, ...(retryReasonCode ? { retryReasonCode, retryReason } : {}), ...(retryStartsNewSession || replay ? { retryDisclosure } : {}) };
}

/** HTTP callers receive the contract's 409; asynchronous dispatch persists the
 * same conflict as a permanent saved-session refusal, never an automatic retry. */
export class RetryExpectationChangedError extends HttpError {
  readonly code = "saved_session_unavailable";
  constructor(readonly retry: RetryConsequence) { super(409, "retry_expectation_changed", { retry }); }
  get resultJson() { return { ...this.retry, retryExpectationChanged: true }; }
}
export function assertDispatchedRetryConsequence(expected: unknown, actual: RetryConsequence) {
  if (typeof expected === "boolean" && expected !== actual.retryStartsNewSession) throw new RetryExpectationChangedError(actual);
}
export function refuseSavedSessionContinuation(context: Record<string, unknown>, reasonCode: RetryReasonCode = "saved_session_unavailable", reason = "The saved session could not be continued."): never {
  const actual = classifyRetryConsequence({ adapterType: "paperclip_runner", config: { provider: "pi_rpc" }, chat: context.retryIsChat === true,
    run: { errorCode: "saved_session_unavailable", resultJson: { retryReasonCode: reasonCode, retryReason: reason } } });
  assertDispatchedRetryConsequence(context.retryExpectedStartsNewSession, actual);
  throw new SavedSessionUnavailableError(reasonCode, reason);
}

/** A pre-dispatch refusal, not a provider failure and never an automatic fork. */
export class SavedSessionUnavailableError extends Error {
  readonly code = "saved_session_unavailable";
  constructor(readonly retryReasonCode: RetryReasonCode = "saved_session_unavailable", readonly retryReason = "The saved session could not be continued.") {
    super(`saved_session_unavailable: ${retryReason}`);
    this.name = "SavedSessionUnavailableError";
  }
  get resultJson() { return { retryReasonCode: this.retryReasonCode, retryReason: this.retryReason }; }
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
  const messages = [...(wake?.executionContinuation?.messages ?? wake?.executionContinuation?.resumeDelta?.messages ?? []), ...(wake?.comments ?? [])];
  const fullBodies = !!wake && wake.commentIds.every(id => wake.comments.some(comment => comment.id === id && typeof comment.fullBody === "string"));
  return { continue: retained, promptOnly: retained && mode === "continuous" && !hasAttachments && !input.taskChanged && !!wake && ["issue_commented", "issue_reopened_via_comment", "issue_continuation_needed"].includes(wake.reason ?? "") &&
    (fullBodies || (!raw.truncated && !raw.fallbackFetchNeeded && !wake.comments.some(comment => comment.bodyTruncated))) &&
    (!wake.executionContinuation?.resumeDelta || wake.executionContinuation.resumeDelta.baseRunId === input.previousRunId) &&
    // The agent's own previous replies are already in its session, and the page's fresh-session
    // marker is not input; neither blocks the person's prompt.
    !wake.executionContinuation?.resumeDelta?.messages.some(message => !wake.commentIds.includes(message.id) && !(message.authorType === "agent" && message.authorId === input.agentId) &&
      !(message.authorType === "system" && !message.authorId && message.freshSessionMarker === true && message.body === NATIVE_FRESH_SESSION_MARKER)) &&
    !wake.childIssueSummaries.length && !wake.executionContinuation?.humanResponses?.length && !wake.unresolvedBlockerIssueIds.length &&
    !wake.interactionId && !wake.questionResponse && !wake.externalChatQuestionResponse && !wake.recovery &&
    !wake.executionStage && !wake.taskWatchdog && !wake.livenessContinuation && !wake.dispositionRepair &&
    !wake.documentReviewContext && !wake.planReviewContext && !(wake.annotationDeltas?.length) && !raw.mcpAppContext && !raw.chatCompletionUpdates && !raw.extraContext &&
    !wake.agentMessage && !wake.skillTest && wake.commentIds.length > 0 &&
    wake.commentIds.every(id => messages.find(message => message.id === id)?.authorType === "user") };
}
