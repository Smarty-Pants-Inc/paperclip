function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.trim().length > 0) : [];
}

/** Candidate comment ids only. Persistence removes deleted and out-of-scope comments.
 * Never copy a first-turn receipt: its run id and delivery claim belong to the parent.
 * The attribution fields (attributionCommentIds, conversationReplyBoundaryCommentId) are candidates too: a
 * native-status continuation names the person message it continues ONLY there (status-decision-committer.ts
 * nativeContinuationAttributionContext), so a continuation of that continuation would otherwise drop the message
 * (RULING-1119 01:23Z: a producer that continues M's turn without M is a producer gap). The caller decides how the
 * candidates are named in the successor; the native-status producer keeps them attribution-only.
 */
export function carryContinuationCommentInput(value: unknown): Record<string, unknown> {
  const context = record(value);
  const firstTurn = record(context.firstTurnQueuedInput);
  const commentIds = [...new Set([
    ...ids(context.attributionCommentIds), ...ids([context.conversationReplyBoundaryCommentId]),
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

/** Candidate card (interaction) ids a run's own input names: the prompt fields and the attribution-only field a
 * native-status continuation carries them in. Persistence keeps only a person's still-pending answers. */
export function carryContinuationInteractionCandidates(value: unknown): string[] {
  const context = record(value);
  return [...new Set([...ids([context.interactionId]), ...ids(context.interactionIds), ...ids(context.attributionInteractionIds)])];
}
