import { sql, type SQL } from "drizzle-orm";
import { issueComments, type Db } from "@paperclipai/db";

export function personCommentOriginSql(alias: string): SQL {
  const message = sql.identifier(alias);
  return sql`(${message}.author_type = 'user' and ${message}.author_user_id is not null
    and ${message}.created_by_run_id is null and ${message}.deleted_at is null
    and (${message}.metadata#>>'{inputOrigin,kind}' = 'human_session'
      and ${message}.metadata#>>'{inputOrigin,userId}' = ${message}.author_user_id
      or exists (select 1 from chat_message_links relay
        where relay.company_id = ${message}.company_id and relay.comment_id = ${message}.id
          and relay.direction = 'inbound' and relay.delivery_id is not null)))`;
}

export async function capturePersonInputOrigin(db: Db, input: {
  companyId: string; issueId: string; runId: string; actorType?: string | null; actorId?: string | null; commentIds: string[];
}): Promise<void> {
  if (input.actorType !== "user" || !input.actorId || !input.commentIds.length) return;
  await db.execute(sql`update ${issueComments} message set metadata =
    coalesce(message.metadata, '{"version":1,"sections":[]}'::jsonb) || jsonb_build_object('inputOrigin',
      case when message.metadata#>>'{inputOrigin,kind}' = 'human_session'
        then message.metadata->'inputOrigin'
        else jsonb_build_object('kind', 'human_relay', 'userId', message.author_user_id) end
      || jsonb_build_object('admittedRunId', ${input.runId}::text))
    where message.company_id = ${input.companyId} and message.issue_id = ${input.issueId}
      and message.id::text in (${sql.join(input.commentIds.map(id => sql`${id}`), sql`, `)})
      and message.author_user_id = ${input.actorId} and ${personCommentOriginSql("message")}
      and message.metadata#>>'{inputOrigin,admittedRunId}' is null
      and not exists (select 1 from heartbeat_runs consumed
        where consumed.company_id = message.company_id and consumed.id::text <> ${input.runId}
          and (consumed.issue_id = message.issue_id or consumed.native_issue_id = message.issue_id
            or consumed.context_snapshot->>'issueId' = message.issue_id::text)
          and not (consumed.status = 'cancelled' and consumed.started_at is null)
          and (consumed.context_snapshot->>'wakeCommentId' = message.id::text
            or consumed.context_snapshot->>'commentId' = message.id::text
            or coalesce(consumed.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? message.id::text
            or coalesce(consumed.context_snapshot#>'{firstTurnQueuedInput,commentIds}', '[]'::jsonb) ? message.id::text))`);
}
