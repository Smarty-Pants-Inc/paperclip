import { and, eq, isNull, sql } from "drizzle-orm";
import { issueComments, type Db } from "@paperclipai/db";

type Tx = Pick<Db, "update">;

/** authorizationReason prefixes of the removed per-message notes (the deleted
 * unanswered-person-message sweep). Upgraded data still holds these rows; no
 * writer creates them any more. The person message id follows the prefix. */
export const LEGACY_MESSAGE_NOTE_PREFIXES = ["unanswered_message:", "retrying_message:"] as const;

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** The person messages a run was woken for, from its context snapshot. */
export function runWakeMessageIds(contextSnapshot: unknown): string[] {
  const context = contextSnapshot && typeof contextSnapshot === "object" ? contextSnapshot as Record<string, unknown> : {};
  const ids = [context.wakeCommentId, context.commentId,
    ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : [])];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && uuid.test(id)))];
}

/**
 * A new current incident for a person's message (a fresh continuation that
 * will run it again, or a redelivered turn) contradicts an older note that told
 * the person to send that same message again. Retire those notes for exactly
 * these messages: the row, its body and its key stay as history (supersession,
 * never deletion); readers hide it and the card is the one current
 * instruction. Idempotent: an already retired or deleted note is left alone.
 */
export async function retireSupersededMessageNotes(tx: Tx, input: {
  companyId: string; issueId: string; messageIds: string[];
  incident: { kind: "fresh_continuation" | "conversation_redelivery" | "answered"; id: string; at: Date };
}): Promise<number> {
  const messageIds = input.messageIds.filter(id => uuid.test(id));
  if (!messageIds.length) return 0;
  const reasons = LEGACY_MESSAGE_NOTE_PREFIXES.flatMap(prefix => messageIds.map(id => `${prefix}${id}`));
  const marker = { kind: input.incident.kind, id: input.incident.id, at: input.incident.at.toISOString() };
  const retired = await tx.update(issueComments).set({
    metadata: sql`jsonb_set(coalesce(${issueComments.metadata}, '{}'::jsonb), '{supersededByIncident}', ${JSON.stringify(marker)}::jsonb)`,
  }).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    sql`${issueComments.metadata}->>'authorizationReason' = any(${sql.param(reasons)}::text[])`,
    sql`${issueComments.metadata}->>'supersededByCommentId' is null`,
    sql`${issueComments.metadata}->'supersededByIncident' is null`,
  )).returning({ id: issueComments.id });
  return retired.length;
}

/**
 * An agent's answer on the task supersedes the old "send it again" /
 * "retrying" notes of every person message it answers: the messages written
 * before it (the same rule the conversation outbox uses: any agent reply after
 * a message is its turn's answer). Supersession, never deletion: the row, body
 * and key stay as history, `supersededByIncident` points at the answer, and
 * readers hide the note. Idempotent. Called by the one comment write helper
 * for agent-authored comments (D074/D175).
 */
export async function retireAnsweredMessageNotes(tx: Tx, input: {
  companyId: string; issueId: string; answerCommentId: string; answeredAt: Date;
}): Promise<number> {
  const marker = { kind: "answered", id: input.answerCommentId, at: input.answeredAt.toISOString() };
  const reason = sql`${issueComments.metadata}->>'authorizationReason'`;
  const retired = await tx.update(issueComments).set({
    metadata: sql`jsonb_set(coalesce(${issueComments.metadata}, '{}'::jsonb), '{supersededByIncident}', ${JSON.stringify(marker)}::jsonb)`,
  }).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    sql`(${reason} like 'unanswered\_message:%' or ${reason} like 'retrying\_message:%')`,
    sql`${issueComments.metadata}->>'supersededByCommentId' is null`,
    sql`${issueComments.metadata}->'supersededByIncident' is null`,
    sql`exists (select 1 from issue_comments message where message.company_id = ${input.companyId}::uuid
      and message.issue_id = ${input.issueId}::uuid and message.author_agent_id is null and message.author_user_id is not null
      and message.id::text = split_part(${reason}, ':', 2) and message.created_at <= ${input.answeredAt.toISOString()}::timestamptz)`,
  )).returning({ id: issueComments.id });
  return retired.length;
}
