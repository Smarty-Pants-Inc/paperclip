import type { IssueComment } from "@paperclipai/shared";

/** The server's per-message card key (unanswered-person-message.ts UNANSWERED_MESSAGE_REASON_PREFIX). */
const PER_MESSAGE_CARD_PREFIX = "unanswered_message:";

/**
 * The runs whose owed messages each stand as their own live card on the thread (one card per owed message, each
 * quoting it and offering its own action). For such a run the cards ARE the failure's surface: the task-status
 * line gives way to them instead of repeating a generic failure with a second Retry (ExecutionBlockerNotice).
 */
export function perMessageCardRunIds(comments: readonly IssueComment[] | null | undefined): string[] {
  const ids = new Set<string>();
  for (const comment of comments ?? []) {
    if (comment.authorType !== "system" || comment.deletedAt) continue;
    const metadata = (comment.metadata ?? {}) as { authorizationReason?: unknown; sourceRunId?: unknown };
    if (typeof metadata.authorizationReason !== "string" || !metadata.authorizationReason.startsWith(PER_MESSAGE_CARD_PREFIX)) continue;
    if (typeof metadata.sourceRunId === "string" && metadata.sourceRunId) ids.add(metadata.sourceRunId);
  }
  return [...ids];
}
