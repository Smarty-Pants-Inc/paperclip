import { sql, type SQL } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";

/** The import's per-task arrival record: one activity row per issue a company import creates (issues.importIssues). */
export const ISSUE_IMPORTED_ACTION = "issue.imported";
/** The import routes' audit row, written after a committed import (routes/companies.ts). */
export const COMPANY_IMPORTED_ACTION = "company.imported";

/** A person message is answered by a published agent reply attributed to it or to a later person input,
 * its carrying run's open or answered interaction card, or imported history. Answering the card is new input;
 * it never makes the original message unanswered again. Shared by recovery input selection (continuation-comment-input.ts) and the
 * unanswered-person-message notice, so the carry and the notice never disagree on a message.
 * - Provider acceptance/delivery alone is NOT an answer.
 * - A run-less agent comment NEVER answers (RFL 20:22Z): the Muse external agent's task.comment and agent chat
 *   messages outside a run post them.
 * - Imported history: a PERSON comment marked origin='import' at insertion, regardless of its source timestamp.
 *   For legacy unmarked comments only, use the issue's import arrival record (issue.imported), or, for imports
 *   made before that record existed, the company's FIRST company.imported row on a company_import issue.
 *   With neither provenance nor an arrival record, nothing is history.
 */
export function answeredPersonMessageSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  return sql`(exists (select 1 from ${issueComments} a
    join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and exists (select 1 from ${issueComments} b
        where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and (b.id = ${m.id} or b.created_at > ${m.createdAt})
          and (r.context_snapshot->>'wakeCommentId' = b.id::text or r.context_snapshot->>'commentId' = b.id::text
            or r.context_snapshot->>'conversationReplyBoundaryCommentId' = b.id::text
            or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? b.id::text
            or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? b.id::text)))
    or exists (select 1 from ${issueThreadInteractions} q
      join ${heartbeatRuns} r on r.id = q.source_run_id and r.company_id = q.company_id
      where q.company_id = ${m.companyId} and q.issue_id = ${m.issueId}
        and q.created_by_agent_id = r.agent_id and q.status in ('pending', 'answered')
        and q.created_at > ${m.createdAt}
        -- A card answers the inputs its run actually carried, never earlier queued inputs by time.
        and (r.context_snapshot->>'wakeCommentId' = ${m.id}::text or r.context_snapshot->>'commentId' = ${m.id}::text
          or r.context_snapshot->>'conversationReplyBoundaryCommentId' = ${m.id}::text
          or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text
          or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${m.id}::text))
    or ${importedPersonHistorySql(m)})`;
}

/** SQL: message m is a PERSON comment that arrived by a company import (see answeredPersonMessageSql). */
export function importedPersonHistorySql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  return sql`exists (select 1 from ${issueComments} p where p.id = ${m.id} and p.author_type = 'user'
    and case when p.origin = 'import' then true else ${m.createdAt} < coalesce(
      (select min(l.created_at) from ${activityLog} l where l.company_id = ${m.companyId}
        and l.action = ${ISSUE_IMPORTED_ACTION} and l.entity_type = 'issue' and l.entity_id = ${m.issueId}::text),
      (select min(c.created_at) from ${activityLog} c where c.company_id = ${m.companyId} and c.action = ${COMPANY_IMPORTED_ACTION}
        and c.entity_type = 'company' and c.entity_id = ${m.companyId}::text
        and exists (select 1 from ${issues} i where i.id = ${m.issueId} and i.company_id = ${m.companyId}
          and i.origin_kind = 'company_import'))) end)`;
}
