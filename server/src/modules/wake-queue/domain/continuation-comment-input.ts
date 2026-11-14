function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
}

/** Candidate comment ids only. Persistence removes deleted and out-of-scope comments.
 * Never copy a first-turn receipt: its run id and delivery claim belong to the parent.
 */
export function carryContinuationCommentInput(value: unknown): Record<string, unknown> {
  const context = record(value);
  const firstTurn = record(context.firstTurnQueuedInput);
  const commentIds = [...new Set([
    ...ids(context.wakeCommentIds), ...ids([context.wakeCommentId, context.commentId]), ...ids(firstTurn.commentIds),
  ])];
  if (commentIds.length === 0) return {};
  return {
    commentContinuation: true,
    wakeCommentIds: commentIds,
    wakeCommentId: commentIds.at(-1)!,
    commentId: commentIds.at(-1)!,
    queuedCommentSourceWakeIds: [...new Set([...ids(context.queuedCommentSourceWakeIds), ...ids(firstTurn.wakeupRequestIds)])],
  };
}
