import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, issueComments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { answeredPersonMessageSql } from "../person-message-answer.js";
import { readSteeredMessageAnswers } from "./steered-message-answers.js";
import { unreadSteeredMessageIds } from "../../vendor/paperclip-runner/index.js";
import { queuedInteractionSteeringBody } from "../queued-interaction-response.js";
import { filterRunMessageInteractionDelivery } from "../agent-interaction-delivery.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/** Interrupt adopts unread PERSON steers in the caller's transaction.
 * Lock order is the release's issues row FOR UPDATE -> heartbeat_runs row FOR UPDATE.
 * The caller must put these ids into its successor input before committing.
 */
export async function readUnreadSteeredForInterrupt(
  tx: Db | Transaction,
  input: { issueId: string; runId: string },
): Promise<string[]> {
  const [issue] = await tx.select({ companyId: issues.companyId }).from(issues)
    .where(eq(issues.id, input.issueId)).for("update");
  if (!issue) return [];
  const [run] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, input.runId),
    or(eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`),
  )).for("update");
  if (!run) return [];
  const context = run.contextSnapshot ?? {}, result = run.resultJson ?? {};
  const scope = { ...input, companyId: issue.companyId };
  const unread = await readUnreadSteeredMessages(tx as Db, scope);
  const evidence = await readSteeredMessageAnswers(tx as Db, scope);
  const accounted = new Set([...strings(result.interruptCarriedSteeredCommentIds),
    ...strings(result.restoredSteeredCommentIds), ...strings(result.stopRestoredSteeredCommentIds),
    ...evidence.delivered]);
  // Include reserved steers whose acknowledgement is still in the ordered ingestion
  // suffix. Custody was recorded before RPC; absence of an ack is not permission to lose it.
  const order = [...new Set([...strings(context.steeredCommentIds), ...unread.map(message => message.id)])]
    .filter(id => !accounted.has(id) && /^[0-9a-f-]{36}$/i.test(id));
  if (!order.length) return [];
  const candidates = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, order), sql`${issueComments.deletedAt} is null`,
    sql`${issueComments.authorUserId} is not null`, sql`${issueComments.authorAgentId} is null`,
    sql`not (${answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })})`,
  ));
  const live = new Set(candidates.map(comment => comment.id));
  const ids = order.filter(id => live.has(id));
  if (!ids.length) return [];
  const without = (value: unknown) => strings(value).filter(id => !ids.includes(id));
  await tx.update(heartbeatRuns).set({ contextSnapshot: { ...context,
    wakeCommentIds: without(context.wakeCommentIds), steeredCommentIds: without(context.steeredCommentIds),
    ...(ids.includes(String(context.wakeCommentId)) ? { wakeCommentId: null } : {}),
    ...(ids.includes(String(context.commentId)) ? { commentId: null } : {}),
  }, resultJson: { ...result, interruptCarriedSteeredCommentIds: [...strings(result.interruptCarriedSteeredCommentIds), ...ids] },
  }).where(and(eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, input.runId)));
  return ids;
}

const kind = sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->'payload'->>'kind'`;

/**
 * Steered messages a restart lost before the model read them, oldest first.
 * The run log is the durable record of both facts: the provider's steering
 * acknowledgement and the userMessage item or completed turn that shows the
 * model read it. Only events the native transport validated count.
 */
export async function readUnreadSteeredMessages(
  db: Db,
  input: { companyId: string; runId: string; issueId: string },
): Promise<Array<{ id: string; text: string }>> {
  const rows = await db
    .select({
      eventType: heartbeatRunEvents.eventType,
      turnId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId'`,
      itemId: sql<string | null>`${heartbeatRunEvents.payload}->'prpEvent'->>'itemId'`,
      kind,
    })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.companyId, input.companyId),
      eq(heartbeatRunEvents.runId, input.runId),
      isNotNull(heartbeatRunEvents.sourceEventId),
      or(
        eq(heartbeatRunEvents.eventType, "turn.completed"),
        and(eq(heartbeatRunEvents.eventType, "item.completed"), sql`${kind} = 'steering_acknowledgement'`),
        and(eq(heartbeatRunEvents.eventType, "item.started"), sql`${kind} = 'userMessage'`),
      ),
    ))
    .orderBy(asc(heartbeatRunEvents.seq));
  const ids = unreadSteeredMessageIds(rows);
  if (ids.length === 0) return [];
  const uuids = ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (uuids.length === 0) return [];
  const allowedIds = await filterRunMessageInteractionDelivery(db, { ...input, commentIds: uuids });
  const texts = new Map<string, string>();
  const comments = await db
    .select({ id: issueComments.id, body: issueComments.body })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId),
      inArray(issueComments.id, uuids),
    ));
  for (const comment of comments) texts.set(comment.id, comment.body);
  const remaining = uuids.filter((id) => !texts.has(id));
  if (remaining.length > 0) {
    // A steered interaction response uses the interaction id.
    const interactions = await db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        inArray(issueThreadInteractions.id, remaining),
      ));
    for (const interaction of interactions) texts.set(interaction.id, queuedInteractionSteeringBody(interaction));
  }
  return ids.flatMap((id) => {
    if (!allowedIds.has(id)) return [];
    const text = texts.get(id);
    return text === undefined ? [] : [{ id, text }];
  });
}
