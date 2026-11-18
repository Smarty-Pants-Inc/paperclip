import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import { deferredWorkIntentWait, promoteDeferredWorkIntents, saveUndeliveredUserComments } from "./work-intent-outbox.js";

/**
 * Durable comment-wake intent (S004). A person's comment and the intent to
 * wake its assignee commit in ONE transaction, so a wake that fails after the
 * 201 cannot lose the message.
 *
 * The intent is a marker row in `agent_wakeup_requests` with its own status,
 * which no admission, drain or queue reader selects. Its life:
 * - the comment's own wake succeeds (or the route decides not to wake): the
 *   marker is deleted, so nothing is ever repeated;
 * - the wake throws: the marker becomes the work-intent outbox's existing
 *   saved receipt (`deferred_issue_execution`, `executionWait: wake_lost`),
 *   which the existing release drain delivers once through normal admission,
 *   per comment (a deleted or already-delivered comment is never sent);
 * - the process dies first: the marker stays as the durable record and the
 *   unanswered-person-message reconciler (USER_COMMENT_WITHOUT_WAKE) remains
 *   the backstop.
 * The idempotency key is the comment id, so one comment has one intent.
 */
export const COMMENT_WAKE_PENDING_STATUS = "comment_wake_pending";

export function commentWakeIntentKey(commentId: string) {
  return `comment-wake-pending:${commentId}`;
}

/** Call inside the comment's insert transaction. */
export async function recordCommentWakeIntent(tx: Db, input: {
  companyId: string; issueId: string; agentId: string; commentId: string; requestedByActorId: string | null;
}) {
  await tx.insert(agentWakeupRequests).values({
    companyId: input.companyId, agentId: input.agentId, source: "automation", triggerDetail: "system",
    reason: "issue_commented", status: COMMENT_WAKE_PENDING_STATUS, requestedByActorType: "user",
    requestedByActorId: input.requestedByActorId, idempotencyKey: commentWakeIntentKey(input.commentId),
    // Neither `payload.issueId` nor the comment id in the payload: readers of
    // task wakes and comment queues must never take the marker for a wake.
    payload: { pendingCommentWake: { taskId: input.issueId } },
  });
}

/** The comment's wake was issued (or not owed): drop the intent. */
export async function settleCommentWakeIntent(db: Db, input: { companyId: string; commentId: string }) {
  await db.delete(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.status, COMMENT_WAKE_PENDING_STATUS),
    eq(agentWakeupRequests.idempotencyKey, commentWakeIntentKey(input.commentId)),
  ));
}

/**
 * The comment's wake failed: hand the intent to the outbox's existing saved
 * receipt and promote it, then drop the marker. Returns the receipt id, or
 * null when nothing is owed (comment deleted, delivered, task reassigned).
 * On a further failure the marker is kept for the reconciler backstop.
 */
export async function retryCommentWakeIntent(db: Db, input: {
  companyId: string; issueId: string; agentId: string; commentId: string;
}): Promise<string | null> {
  const [intent] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.status, COMMENT_WAKE_PENDING_STATUS),
    eq(agentWakeupRequests.idempotencyKey, commentWakeIntentKey(input.commentId)),
  ));
  // Already settled or handed over: exactly once.
  if (!intent) return null;
  const saved = await saveUndeliveredUserComments(db, {
    companyId: input.companyId, issueId: input.issueId, agentId: input.agentId, commentIds: [input.commentId],
    allowedStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked", "done"],
    executionWait: deferredWorkIntentWait("wake_lost", "This message's wake was lost; it is sent now."),
    reopenAgentClosedDone: true,
  });
  if (saved) {
    await db.transaction(tx => promoteDeferredWorkIntents(tx, {
      companyId: input.companyId, trigger: "reconciler_backstop", issueId: input.issueId,
    }));
  }
  await settleCommentWakeIntent(db, input);
  return saved;
}
