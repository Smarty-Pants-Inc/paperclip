function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
}

/** Candidates only. The persistence boundary removes answered/deleted/foreign comments.
 * Never copy a first-turn receipt: its run id and delivery claim belong to the parent.
 */
export function carryContinuationCommentInput(value: unknown): Record<string, unknown> {
  const context = record(value);
  const firstTurn = record(context.firstTurnQueuedInput);
  const commentIds = [...new Set([
    ...ids(context.wakeCommentIds), ...ids([context.wakeCommentId, context.commentId]), ...ids(firstTurn.commentIds),
  ])];
  if (commentIds.length === 0 && context.commentContinuation !== true) return {};
  return {
    commentContinuation: true,
    wakeCommentIds: commentIds,
    wakeCommentId: commentIds.at(-1) ?? null,
    commentId: commentIds.at(-1) ?? null,
    queuedCommentSourceWakeIds: [...new Set([...ids(context.queuedCommentSourceWakeIds), ...ids(firstTurn.wakeupRequestIds)])],
  };
}
