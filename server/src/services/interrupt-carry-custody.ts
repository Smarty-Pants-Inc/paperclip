import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, type Db } from "@paperclipai/db";
import { answeredPersonMessageIds } from "./person-message-answer.js";

/**
 * ONE successor per Interrupt (adopt-one-successor, 390 take 11:16-11:20Z).
 *
 * The Interrupt press moves the cut turn's steers out of that run's
 * `steeredCommentIds` (readUnreadSteeredForInterrupt -> resultJson.
 * interruptCarriedSteeredCommentIds; or the run-end restore ->
 * restoredSteeredCommentIds) into the ONE carry wake's wakeCommentIds. A default
 * steer never had a `conversation-comment:` receipt, so once it leaves
 * `steeredCommentIds` the conversation outbox saw it as never sent and made a
 * second wake for it (41b2b1e4). Custody is the fact that a wake took the
 * message or a run recorded handing it on; the outbox never sends such a message again.
 *
 * SQL: comment `id` (uuid SQL) of `issueId` is already in the custody of a wake or a run's carry record.
 */
export function commentCarriedSql(companyId: string, issueId: string, id: SQL): SQL {
  return sql`(exists (select 1 from ${agentWakeupRequests} held where held.company_id = ${companyId}::uuid
      and held.payload->>'issueId' = ${issueId}::text
      and coalesce(held.payload->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? (${id})::text)
    or exists (select 1 from ${heartbeatRuns} cut where cut.company_id = ${companyId}::uuid
      and (cut.native_issue_id = ${issueId}::uuid or cut.context_snapshot->>'issueId' = ${issueId}::text)
      and (coalesce(cut.result_json->'interruptCarriedSteeredCommentIds', '[]'::jsonb) ? (${id})::text
        or coalesce(cut.result_json->'restoredSteeredCommentIds', '[]'::jsonb) ? (${id})::text
        or coalesce(cut.result_json->'stopRestoredSteeredCommentIds', '[]'::jsonb) ? (${id})::text)))`;
}

/** The coalesce reason the queue already uses for messages another wake sends. */
export const SENT_WITH_OTHER_QUEUED_MESSAGES = "Sent with the chat's other queued messages";

/**
 * Dispatch re-filter: of `commentIds`, the ones a new person-comment wake must
 * NOT carry again: answered (the ONE answeredPersonMessageIds), recorded as
 * carried by an Interrupt (interruptCarriedSteeredCommentIds), held by another
 * pending wake (the Interrupt carry first of all), or carried by a live run.
 */
export async function commentIdsCarriedElsewhere(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; commentIds: string[]; idempotencyKey?: string | null },
): Promise<Set<string>> {
  const ids = [...new Set(input.commentIds.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))];
  if (!ids.length) return new Set();
  const out = await answeredPersonMessageIds(db, { companyId: input.companyId, issueId: input.issueId, commentIds: ids });
  const issueRun = sql`(${heartbeatRuns.nativeIssueId} = ${input.issueId}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId})`;
  const runs = await db.select({ status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot,
    resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), issueRun,
    sql`(${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')
      or ${heartbeatRuns.resultJson} ? 'interruptCarriedSteeredCommentIds')`));
  const wakes = await db.select({ payload: agentWakeupRequests.payload, idempotencyKey: agentWakeupRequests.idempotencyKey })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId),
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]), sql`${agentWakeupRequests.runId} is null`,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`));
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  const held = new Set<string>([
    ...runs.flatMap(({ status, contextSnapshot, resultJson }) => {
      const context = (contextSnapshot ?? {}) as Record<string, unknown>;
      return [...strings((resultJson ?? {} as Record<string, unknown>).interruptCarriedSteeredCommentIds),
        ...(["queued", "running", "scheduled_retry"].includes(status)
          ? [...strings(context.wakeCommentIds), ...strings([context.wakeCommentId, context.commentId])] : [])];
    }),
    ...wakes.filter(wake => !input.idempotencyKey || wake.idempotencyKey !== input.idempotencyKey).flatMap(({ payload }) =>
      strings(((payload ?? {}) as Record<string, any>)._paperclipWakeContext?.wakeCommentIds)),
  ]);
  for (const id of ids) if (held.has(id)) out.add(id);
  return out;
}
