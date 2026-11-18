import { sql, type SQL } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, issues } from "@paperclipai/db";

/** The import's per-task arrival record: one activity row per issue a company import creates (issues.importIssues). */
export const ISSUE_IMPORTED_ACTION = "issue.imported";
/** The import routes' audit row, written after a committed import (routes/companies.ts). */
export const COMPANY_IMPORTED_ACTION = "company.imported";

/** ANSWERED, the ONE rule: a person message M is answered only by a published reply that comes after M from a run
 * that SUCCEEDED and whose OWN input names M, or M is imported history. Recovery input selection
 * (continuation-comment-input.ts) and the unanswered-person-message notice both call this; there is no second copy,
 * so the carry and the notice never disagree on a message.
 * Never an answer:
 * - a reply from a cancelled, failed, timed-out, interrupted or still-running run (run status alone is not one either:
 *   a succeeded run with no reply answers nothing);
 * - a reply to a LATER message: the replying run's own input must name M itself (never a later input, history or ancestry);
 * - a progress comment: one the run posted through report_progress, by that run's own tool receipt
 *   (the server's rule for "not the final answer", findHeartbeatRunCompletionComment);
 * - a reply dated at or before M;
 * - provider acceptance/delivery alone;
 * - a run-less agent comment (RFL 20:22Z): the Muse external agent's task.comment and agent chat messages outside a
 *   run post them.
 * Imported history: a PERSON comment marked origin='import' at insertion, regardless of its source timestamp.
 *   For legacy unmarked comments only, use the issue's import arrival record (issue.imported), or, for imports
 *   made before that record existed, the company's FIRST company.imported row on a company_import issue.
 *   With neither provenance nor an arrival record, nothing is history.
 */
export function answeredPersonMessageSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  return sql`(exists (select 1 from ${issueComments} a
    join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and r.status = 'succeeded'
      and exists (select 1 from ${issueComments} b
        where b.id = ${m.id} and b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and (r.context_snapshot->>'wakeCommentId' = b.id::text or r.context_snapshot->>'commentId' = b.id::text
            or r.context_snapshot->>'conversationReplyBoundaryCommentId' = b.id::text
            or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? b.id::text
            or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? b.id::text))
      and not exists (select 1 from jsonb_each(case when jsonb_typeof(r.result_json->'semanticToolReceipts') = 'object'
          then r.result_json->'semanticToolReceipts' else '{}'::jsonb end) receipt
        where receipt.value->>'operationId' = 'report_progress' and receipt.value->'result'->>'commentId' = a.id::text))
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
