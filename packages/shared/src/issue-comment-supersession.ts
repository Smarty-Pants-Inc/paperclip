/**
 * The ONE definition of a CURRENT comment notice (B' never-delete, org 09:18Z;
 * RFL 11:43Z). A note is never deleted; once a comment (supersededBy) or a card
 * (supersededByInteractionId) superseded it, it is history. Every reader uses
 * this rule: UI projections import these functions, and server SQL readers
 * derive their predicate from ISSUE_COMMENT_SUPERSESSION_KEYS with the same
 * semantics (a marker counts only as a non-empty string).
 */
export const ISSUE_COMMENT_SUPERSESSION_KEYS = ["supersededBy", "supersededByInteractionId"] as const;

export type IssueCommentSupersessionKey = (typeof ISSUE_COMMENT_SUPERSESSION_KEYS)[number];

/** True when the comment's metadata carries a supersession marker: it is history, not current. */
export function isSupersededNotice(metadata: unknown): boolean {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  return ISSUE_COMMENT_SUPERSESSION_KEYS.some(key => typeof record[key] === "string" && (record[key] as string).length > 0);
}

/** True when nothing superseded the note: it is a CURRENT notice. */
export function isCurrentNotice(metadata: unknown): boolean {
  return !isSupersededNotice(metadata);
}
