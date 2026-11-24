import { resolveSessionContinuity } from "./native-runtime/continued-session.js";

export function isFinishedTaskConversationComment(input: {
  issueStatus: string;
  actorType: string;
  actorRunId?: string | null;
  resumeRequested?: boolean;
  agent: { adapterType: string; adapterConfig: unknown } | null;
}) {
  const config = input.agent?.adapterConfig as Record<string, unknown> | null;
  return (input.issueStatus === "done" || input.issueStatus === "in_review") &&
    input.actorType === "user" && !input.actorRunId && !input.resumeRequested &&
    input.agent?.adapterType === "paperclip_runner" && config?.provider === "pi_rpc" &&
    resolveSessionContinuity(config.provider, config.sessionContinuity) === "continuous";
}

export function shouldWakeAssigneeForIssueComment(input: {
  selfComment: boolean;
  resumeRequested: boolean;
  commentCreatedByRunId?: string | null;
  issueAtCommentStart: {
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  };
  reopened: boolean;
  finishedTaskConversation?: boolean;
  currentStatus: string | null | undefined;
}) {
  const sourceRunId = input.commentCreatedByRunId;
  const commentIsFromCurrentIssueRun = Boolean(
    sourceRunId &&
    (sourceRunId === input.issueAtCommentStart.checkoutRunId ||
      sourceRunId === input.issueAtCommentStart.executionRunId),
  );
  if (
    input.selfComment &&
    (!input.resumeRequested || commentIsFromCurrentIssueRun)
  ) {
    return false;
  }
  return (
    input.reopened ||
    (input.finishedTaskConversation === true && input.currentStatus === "done") ||
    (input.currentStatus !== "done" && input.currentStatus !== "cancelled")
  );
}
