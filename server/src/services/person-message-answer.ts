import { sql, type SQL } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { freshContinuationSourceChainSql } from "./fresh-continuation-chain.js";

/** The import's per-task arrival record: one activity row per issue a company import creates (issues.importIssues). */
export const ISSUE_IMPORTED_ACTION = "issue.imported";
/** The import routes' audit row, written after a committed import (routes/companies.ts). */
export const COMPANY_IMPORTED_ACTION = "company.imported";

type PersonMessageSql = { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL };

function carriesCommentSql(alias: string, commentId: SQL): SQL {
  const context = sql`${sql.identifier(alias)}.context_snapshot`;
  return sql`(${context}->>'wakeCommentId' = ${commentId}::text or ${context}->>'commentId' = ${commentId}::text
    or ${context}->>'conversationReplyBoundaryCommentId' = ${commentId}::text
    or coalesce(${context}->'wakeCommentIds', '[]'::jsonb) ? ${commentId}::text
    or coalesce(${context}->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${commentId}::text)`;
}

/** A reply/card can belong to a later run without copying the original input
 * ids. Follow durable continuation and answered-interaction edges, never mere
 * session identity or a later run's timestamp. UNION makes cycles terminate. */
function chainCarriesCommentSql(alias: string, commentId: SQL, m: PersonMessageSql): SQL {
  return sql`(${carriesCommentSql(alias, commentId)} or exists (
    ${freshContinuationSourceChainSql({ companyId: m.companyId, issueId: m.issueId,
      runId: sql`${sql.identifier(alias)}.id` }, true)}
    select 1 from source_chain input
      join ${heartbeatRuns} carrying on carrying.id = input.id and carrying.company_id = ${m.companyId}
      where ${carriesCommentSql("carrying", commentId)}))`;
}

// A presented card and either kind of reply remain an answer to the input
// carried by its source run. Administrative invalidation alone does not prove
// delivery; cancelled cards need evidence of a human skip/withdraw/cancel reply.
const PERSON_MESSAGE_ANSWER_CARD_STATUSES = ["pending", "answered", "accepted", "rejected"] as const;

/** DELIVERED (legacy name): a person message was carried or partly answered by a published agent reply attributed to it or to a later person input,
 * an open or resolved interaction card on its run chain, or imported history. Answering the card is new input;
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
export function answeredPersonMessageSql(m: PersonMessageSql): SQL {
  return sql`(${personMessageReplySql(m, false)}
    or exists (select 1 from ${issueThreadInteractions} q
      join ${heartbeatRuns} r on r.id = q.source_run_id and r.company_id = q.company_id
      where q.company_id = ${m.companyId} and q.issue_id = ${m.issueId}
        and q.created_by_agent_id = r.agent_id
        and (q.status in (${sql.join(PERSON_MESSAGE_ANSWER_CARD_STATUSES.map(status => sql`${status}`), sql`, `)})
          or (q.status = 'cancelled' and q.resolved_by_user_id is not null
            and (q.result->>'outcome' in ('skipped', 'withdrawn') or q.result->>'cancelled' = 'true')))
        and q.created_at > ${m.createdAt}
        -- A card answers only inputs carried on its chain, never queued inputs by time.
        and ${chainCarriesCommentSql("r", m.id, m)})
    or ${importedPersonHistorySql(m)})`;
}

/** ANSWERED: a completed run's published final reply to this message.
 * A cut/failed/running run's partial reply, a card, or imported history proves
 * DELIVERED only. Keep recovery input selection and notices on the legacy
 * predicate above; only duplicate retry/continuation fences use this one.
 * `succeeded` is the persisted completed-run status. When publication recorded
 * a final comment receipt, only that comment counts (not earlier progress).
 */
export function completedPersonMessageAnswerSql(m: PersonMessageSql): SQL {
  return personMessageReplySql(m, true);
}

// Both definitions share the run attribution and durable comment-chain match.
// DELIVERED additionally allows a reply to later input; ANSWERED requires this
// exact input and successful completion, not merely evidence that it was read.
function personMessageReplySql(m: PersonMessageSql, completed: boolean): SQL {
  return sql`exists (select 1 from ${issueComments} a
    join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      ${completed ? sql`and r.status = 'succeeded'
        and coalesce(r.result_json#>>'{presentationDecision,commentId}', a.id::text) = a.id::text` : sql``}
      and exists (select 1 from ${issueComments} b
        where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and ${completed ? sql`b.id = ${m.id}` : sql`(b.id = ${m.id} or b.created_at > ${m.createdAt})`}
          and ${chainCarriesCommentSql("r", sql`b.id`, m)}))`;
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
