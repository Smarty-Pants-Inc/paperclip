/**
 * A waiting message's mode (Paul NOTE 6, smarty-dev#20992): Steer joins the
 * running turn at its next step, Queue waits for the turn boundary. The mode
 * lives in the comment's metadata (`deliveryIntent`), so it survives a reload
 * and a second tab without a schema change. Every server path that could send
 * a message into a running turn re-reads it here.
 *
 * Agent Chat keeps the order rule of the steer route: a `/new` reset, and every
 * message behind one, waits for the turn boundary. Steer and a one-message
 * Interrupt never cross it.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, issueComments, type Db } from "@paperclipai/db";
import type { IssueQueuedCommentEntry } from "@paperclipai/shared";
import { conflict, forbidden } from "../errors.js";
import { isConversationReset } from "./agent-conversations.js";
import {
  queuedCommentIdsFromWakePayload,
  queuedCommentQueueRevision,
  withQueuedCommentIdsInWakePayload,
} from "./issue-queued-comment-queue.js";

export const DELIVERY_INTENTS = ["steer", "queue"] as const;
export type DeliveryIntent = (typeof DELIVERY_INTENTS)[number];

type Executor = Pick<Db, "select" | "update" | "insert">;
type IssueFacts = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  conversationAgentId?: string | null;
  conversationUserId?: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>) : null;
}

/** The mode stored on the comment, or null when none was chosen. */
export function storedDeliveryIntent(metadata: unknown): DeliveryIntent | null {
  const intent = record(metadata)?.deliveryIntent;
  return intent === "steer" || intent === "queue" ? intent : null;
}

/** A `/new` always waits for the turn boundary; otherwise Steer is the default. */
export function resolvedDeliveryIntent(comment: { body: string; metadata?: unknown }): DeliveryIntent {
  if (isConversationReset(comment.body)) return "queue";
  return storedDeliveryIntent(comment.metadata) ?? "steer";
}

/** As `buildQueuedCommentQueueSnapshot` shows it: mode-only metadata is not presentation metadata. */
function queueEntryComment<T extends { metadata?: unknown }>(comment: T): T {
  const metadata = record(comment.metadata);
  if (!metadata || Array.isArray(metadata.sections)) return comment;
  return { ...comment, metadata: null };
}

export async function storeDeliveryIntent(
  executor: Pick<Db, "update">,
  input: { companyId: string; issueId: string; commentId: string; intent: DeliveryIntent },
) {
  await executor.update(issueComments).set({
    metadata: sql`jsonb_set(coalesce(${issueComments.metadata}, '{}'::jsonb), '{deliveryIntent}', to_jsonb(${input.intent}::text))`,
  }).where(and(
    eq(issueComments.id, input.commentId),
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
  ));
}

/** Pending wakes of one issue in delivery order, with their message ids. */
async function pendingQueuedWakes(executor: Pick<Db, "select">, issue: IssueFacts) {
  if (!issue.assigneeAgentId) return [];
  const rows = await executor.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, issue.companyId),
    eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
    sql`${agentWakeupRequests.payload}->'issueId' = to_jsonb(${issue.id}::text)`,
    inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.createdAt));
  return rows.flatMap((wake) => {
    const payload = record(wake.payload);
    const ids = queuedCommentIdsFromWakePayload(wake.payload);
    return ids.length && !payload?.interactionId ? [{ wake, ids }] : [];
  });
}

async function liveComments(executor: Pick<Db, "select">, issue: IssueFacts, ids: string[]) {
  if (!ids.length) return new Map<string, typeof issueComments.$inferSelect>();
  const rows = await executor.select().from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    inArray(issueComments.id, ids),
  ));
  return new Map(rows.filter((row) => !row.deletedAt).map((row) => [row.id, row]));
}

/**
 * Agent Chat: every waiting message, in order, from the queue's head wake to
 * the last one. The read shows one wake's queue; a `/new` keeps its own wake,
 * so without this the list would stop at the first reset.
 */
export async function chatQueueTail(
  executor: Pick<Db, "select">,
  input: {
    issue: IssueFacts;
    headQueueId: string | null;
    headEntries: IssueQueuedCommentEntry[];
    actorType: "agent" | "user";
    actorId: string;
  },
): Promise<IssueQueuedCommentEntry[]> {
  if (!input.issue.conversationAgentId || !input.headQueueId) return input.headEntries;
  const wakes = await pendingQueuedWakes(executor, input.issue);
  const headIndex = wakes.findIndex((candidate) => candidate.wake.id === input.headQueueId);
  if (headIndex < 0) return input.headEntries;
  const later = wakes.slice(headIndex + 1);
  const comments = await liveComments(executor, input.issue, later.flatMap((wake) => wake.ids));
  let behindReset = input.headEntries.some((entry) => isConversationReset(entry.comment.body));
  const entries = input.headEntries.map((entry, index) => {
    const atOrBehind = input.headEntries.slice(0, index + 1).some((earlier) => isConversationReset(earlier.comment.body));
    return { ...entry, behindReset: atOrBehind };
  });
  for (const { wake, ids } of later) {
    const wakeComments = ids.flatMap((id) => comments.get(id) ?? []);
    const revision = queuedCommentQueueRevision({ queueId: wake.id, comments: wakeComments });
    for (const comment of wakeComments) {
      if (isConversationReset(comment.body)) behindReset = true;
      entries.push({
        comment: queueEntryComment(comment) as unknown as IssueQueuedCommentEntry["comment"],
        position: entries.length,
        canEdit: input.actorType === "user" && comment.authorUserId === input.actorId,
        canDiscard: input.actorType === "user" && (comment.authorUserId === input.actorId || Boolean(comment.authorAgentId)),
        deliveryIntent: resolvedDeliveryIntent(comment),
        behindReset,
        queueId: wake.id,
        queueRevision: revision,
      });
    }
  }
  return entries;
}

/** 409 when Agent Chat order puts this message at or behind a `/new`. */
async function assertAheadOfReset(executor: Pick<Db, "select">, issue: IssueFacts, commentId: string) {
  if (!issue.conversationAgentId) return;
  const ids = (await pendingQueuedWakes(executor, issue)).flatMap((wake) => wake.ids);
  const index = ids.indexOf(commentId);
  const comments = await liveComments(executor, issue, ids.slice(0, Math.max(index + 1, 0)));
  if (comments.get(commentId) && isConversationReset(comments.get(commentId)!.body)) {
    throw conflict("/new starts a new conversation at a turn boundary. It cannot be sent into the current turn.", {
      code: "conversation_reset_requires_turn_boundary",
    });
  }
  if (ids.slice(0, Math.max(index, 0)).some((id) => {
    const comment = comments.get(id);
    return comment ? isConversationReset(comment.body) : false;
  })) {
    throw conflict("Behind /new: sending it now would put it into the current conversation.", {
      code: "conversation_behind_reset",
    });
  }
}

/**
 * The owner changes a waiting message's mode. Only the conversation's owner
 * (on a task, the message's author) may; the message must still be waiting.
 */
export async function changeQueuedCommentDeliveryIntent(
  executor: Executor,
  input: { issue: IssueFacts; actorUserId: string; commentId: string; intent: DeliveryIntent },
) {
  const [comment] = await executor.select().from(issueComments).where(and(
    eq(issueComments.id, input.commentId),
    eq(issueComments.companyId, input.issue.companyId),
    eq(issueComments.issueId, input.issue.id),
  ));
  const owner = input.issue.conversationAgentId ? input.issue.conversationUserId : comment?.authorUserId;
  if (!owner || owner !== input.actorUserId) {
    throw forbidden("Only the conversation owner can change how a waiting message is sent");
  }
  const pending = (await pendingQueuedWakes(executor, input.issue)).some((wake) => wake.ids.includes(input.commentId));
  if (!comment || comment.deletedAt || !pending) {
    throw conflict("The message is no longer waiting", { code: "queued_comment_not_pending" });
  }
  if (input.intent === "steer") await assertAheadOfReset(executor, input.issue, input.commentId);
  await storeDeliveryIntent(executor, {
    companyId: input.issue.companyId, issueId: input.issue.id, commentId: input.commentId, intent: input.intent,
  });
}

/** The steer route re-reads the STORED mode: a Queue set in another tab wins. */
export async function assertStoredIntentAllowsSteer(
  executor: Pick<Db, "select">,
  input: { companyId: string; issueId: string; commentId: string },
) {
  const [comment] = await executor.select({ metadata: issueComments.metadata }).from(issueComments).where(and(
    eq(issueComments.id, input.commentId),
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
  ));
  if (storedDeliveryIntent(comment?.metadata) === "queue") {
    throw conflict("This message is set to Queue. It will be sent after this turn.", {
      code: "queued_comment_intent_queue",
    });
  }
}

/**
 * Interrupt now, for one message: it goes first and the rest of its queue
 * stays queued, in order, as the next wake. Never across a `/new`.
 * Returns the wake payload the interrupt should carry.
 */
export async function sendQueuedCommentFirst(
  executor: Executor,
  input: {
    issue: IssueFacts;
    wake: typeof agentWakeupRequests.$inferSelect;
    commentId: string;
  },
): Promise<Record<string, unknown>> {
  await assertAheadOfReset(executor, input.issue, input.commentId);
  const ids = queuedCommentIdsFromWakePayload(input.wake.payload);
  if (!ids.includes(input.commentId)) {
    throw conflict("The message is no longer waiting", { code: "queued_comment_not_pending" });
  }
  const rest = ids.filter((id) => id !== input.commentId);
  const payload = withQueuedCommentIdsInWakePayload(input.wake.payload, [input.commentId]);
  if (rest.length === 0) return payload;
  const { id: _id, idempotencyKey: _key, ...wake } = input.wake;
  void _id; void _key;
  const now = new Date();
  await executor.update(agentWakeupRequests).set({ payload, updatedAt: now })
    .where(eq(agentWakeupRequests.id, input.wake.id));
  await executor.insert(agentWakeupRequests).values({
    ...wake,
    payload: withQueuedCommentIdsInWakePayload(input.wake.payload, rest),
    coalescedCount: Math.max(0, rest.length - 1),
    requestedAt: new Date(input.wake.requestedAt.getTime() + 1),
    createdAt: now,
    updatedAt: now,
  });
  return payload;
}
