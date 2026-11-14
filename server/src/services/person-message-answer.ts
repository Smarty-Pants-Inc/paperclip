import { sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueComments } from "@paperclipai/db";

/** A published agent reply attributed to this message or a later person input.
 * Shared by recovery input selection and the unanswered-person-message notice.
 * Provider acceptance/delivery alone is NOT an answer.
 */
export function answeredPersonMessageSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  return sql`exists (select 1 from ${issueComments} a
    left join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and (a.created_by_run_id is null or exists (select 1 from ${issueComments} b
        where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and (b.id = ${m.id} or b.created_at > ${m.createdAt})
          and (r.context_snapshot->>'wakeCommentId' = b.id::text or r.context_snapshot->>'commentId' = b.id::text
            or r.context_snapshot->>'conversationReplyBoundaryCommentId' = b.id::text
            or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? b.id::text
            or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? b.id::text))))`;
}
