import { sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issues,
  nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";

/** The import's per-task arrival record: one activity row per issue a company import creates (issues.importIssues). */
export const ISSUE_IMPORTED_ACTION = "issue.imported";
/** The import routes' audit row, written after a committed import (routes/companies.ts). */
export const COMPANY_IMPORTED_ACTION = "company.imported";

/** SQL: run r's OWN input names person input `id` (a typed message's comment id, or a card answer's interaction id).
 * attributionCommentIds / attributionInteractionIds: the typed messages and the card answers a native-status
 * continuation (schedule_retry) carries from the run it continues, for this attribution only
 * (status-decision-committer.ts nativeContinuationAttributionContext). */
const ownInputNamesSql = (id: SQL) => sql`(r.context_snapshot->>'wakeCommentId' = ${id}::text or r.context_snapshot->>'commentId' = ${id}::text
  or r.context_snapshot->>'conversationReplyBoundaryCommentId' = ${id}::text
  or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${id}::text
  or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${id}::text
  or coalesce(r.context_snapshot->'attributionCommentIds', '[]'::jsonb) ? ${id}::text
  or r.context_snapshot->>'interactionId' = ${id}::text
  or coalesce(r.context_snapshot->'interactionIds', '[]'::jsonb) ? ${id}::text
  or coalesce(r.context_snapshot->'attributionInteractionIds', '[]'::jsonb) ? ${id}::text)`;

/** SQL: the SENDER of person input `id`, by actor id: the typed message's author, or (a card answer, whose id is
 * the card's) the person who answered that card. */
const inputSenderSql = (id: SQL) => sql`coalesce((select sender_m.author_user_id from ${issueComments} sender_m where sender_m.id = ${id}),
  (select sender_q.resolved_by_user_id from ${issueThreadInteractions} sender_q where sender_q.id = ${id}))`;

/** SQL over card q, for person input `id`: the person can still answer it, or has answered it (rulings 2, 3), or the
 * input's SENDER closed it themselves (ruling (b), tightened: a skip, a withdrawal or a cancel counts only when
 * resolved_by_user_id is the sender's own actor id; another user's skip leaves the sender's message owed). The ONE copy. */
const answerableCardSql = (id: SQL) => sql`(q.status = 'pending' or (q.resolved_by_user_id is not null and (q.status in ('answered', 'accepted', 'rejected')
  or (q.status = 'cancelled' and q.resolved_by_user_id = ${inputSenderSql(id)}
    and (q.result->>'outcome' in ('skipped', 'withdrawn') or q.result->>'cancelled' = 'true')))))`;

/** SQL over reply comment a and its run r: the run's ACCEPTED result, PUBLISHED ONCE (RFL 23:13Z, record
 * SUPERSEDE-ANSWERED-ACCEPTED-PUBLISHED-1118). Comment a is THE comment the run's presentation decision recorded
 * (result_json.presentationDecision.commentId: recordRunPresentationDecision, heartbeat/run-completion.ts; the
 * committed-response writers, native-runtime/native-run-finalizer.ts), and the run has an accepted result row
 * (native_run_results, schema_status 'accepted': id = the result id, canonical_sha256) that is the one its
 * finalization committed (native_run_finalizations.result_id) and, where the publication recorded its own
 * (resultId, canonicalSha256) (result_json.nativeCommittedChatResponse), the one that record names. */
const ACCEPTED_RESULT_PUBLISHED_SQL = sql`(r.result_json#>>'{presentationDecision,commentId}' = a.id::text
  and exists (select 1 from ${nativeRunResults} accepted
    where accepted.run_id = r.id and accepted.company_id = r.company_id and accepted.issue_id = a.issue_id
      and accepted.schema_status = 'accepted'
      and coalesce(r.result_json#>>'{nativeCommittedChatResponse,resultId}', accepted.id::text) = accepted.id::text
      and coalesce(r.result_json#>>'{nativeCommittedChatResponse,canonicalSha256}', accepted.canonical_sha256) = accepted.canonical_sha256
      and not exists (select 1 from ${nativeRunFinalizations} committed where committed.run_id = r.id
        and committed.company_id = r.company_id and committed.result_id is not null and committed.result_id <> accepted.id)))`;

/** ANSWERED, the ONE rule: a person message M is answered only by a published reply that comes after M from a run
 * that SUCCEEDED and whose OWN input names M, by that run's ACCEPTED result published once whatever the run's later
 * status (above), by an ANSWERABLE card (below), or M is imported history.
 * An ANSWERABLE card (RFL rulings 2, 3): a question or confirmation card the agent posted after M from a run whose
 * OWN input names M counts as M's response while the person can still answer it or has answered it (pending; or
 * answered, accepted or rejected by a person; or cancelled by M's SENDER's own skip, withdrawal or cancel, by actor
 * id), whatever that run's later status. A card that EXPIRED unanswered, failed, or was cancelled by the system, the
 * agent or ANOTHER user no longer counts: the visible next step is gone, so M is owed again.
 * A person's ANSWER to a card is person input too (the carry's interactionIds): m.id is then the card's id and
 * m.createdAt its answer time; it has no comment row, and the run that answers it names it as interactionId(s). Recovery input selection
 * (continuation-comment-input.ts) and the unanswered-person-message notice both call this; there is no second copy,
 * so the carry and the notice never disagree on a message.
 * Never an answer:
 * - a reply from a cancelled, failed, timed-out, interrupted or still-running run that is not its accepted result's
 *   one published comment: partial text, an error line, a comment with no accepted result behind it (run status
 *   alone is not an answer either: a succeeded run with no reply answers nothing);
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
      and (r.status = 'succeeded' or ${ACCEPTED_RESULT_PUBLISHED_SQL})
      and ${ownInputNamesSql(m.id)}
      and (exists (select 1 from ${issueComments} b
        where b.id = ${m.id} and b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user')
        or not exists (select 1 from ${issueComments} own where own.id = ${m.id}))
      and not exists (select 1 from jsonb_each(case when jsonb_typeof(r.result_json->'semanticToolReceipts') = 'object'
          then r.result_json->'semanticToolReceipts' else '{}'::jsonb end) receipt
        where receipt.value->>'operationId' = 'report_progress' and receipt.value->'result'->>'commentId' = a.id::text))
    or exists (select 1 from ${issueThreadInteractions} q
      join ${heartbeatRuns} r on r.id = q.source_run_id and r.company_id = q.company_id
      where q.company_id = ${m.companyId} and q.issue_id = ${m.issueId} and q.created_by_agent_id = r.agent_id
        and q.created_at > ${m.createdAt}
        and ${answerableCardSql(m.id)}
        and ${ownInputNamesSql(m.id)})
    or ${importedPersonHistorySql(m)})`;
}

/** The unanswered-message notice's key prefix (metadata.authorizationReason = prefix + the latest still-owed input)
 * and the key of a group notice's still-owed member list. Defined here, beside the one function; the sweep
 * (recovery/unanswered-person-message.ts) re-exports them. */
export const UNANSWERED_MESSAGE_REASON_PREFIX = "unanswered_message:";
export const UNANSWERED_MESSAGE_GROUP_KEY = "unansweredMessageIds";

/** A FAILED run, for the membership below: it ended without completing (failed, timed out or interrupted), or it
 * was CANCELLED by anything but a person (rf-3 01:03Z: cancelledByActorType is not "user": the budget fan-out, a
 * system or recovery cancel, a managing agent's stop). No path answers the messages of such a run (the sweep owes
 * them a notice like a failed run's), so they are owed the same way. A run a PERSON stopped (the Stop and Interrupt
 * routes record cancelledByActorType "user", routes/agents.ts:7581-7584) is a Stop, a succeeded run is not a
 * failure, a live run has not ended. */
export const FAILED_RUN_STATUSES = ["failed", "timed_out", "interrupted"] as const;
/** SQL over run alias r: the run is a FAILED run (above). The ONE copy for the membership. */
const failedRunSql = () => sql`(r.status in (${sql.join(FAILED_RUN_STATUSES.map(status => sql`${status}`), sql`, `)})
  or (r.status = 'cancelled' and coalesce(r.result_json->>'cancelledByActorType', '') <> 'user'))`;
/** The membership's fixed order: oldest message first, the message id as the tie-break. */
export const FAILED_OWN_PERSON_MESSAGE_ORDER = "message created_at asc, message id asc" as const;
const MEMBERSHIP_PAGE_SIZE = 200;

export type FailedOwnPersonMessageMember = {
  /** "message": a typed person message (messageId = its comment id, createdAt = when it was sent).
   * "card_answer": a person's ANSWER to an agent's card (rf-3 01:03Z (2): the same input owed to a failed run):
   * messageId = the card's id, createdAt = the answer time (resolved_at), authorUserId = who answered. It is keyed
   * exactly as the one function, the carry (interactionIds) and the card-answer notice key it. */
  kind: "message" | "card_answer";
  messageId: string; createdAt: Date; authorUserId: string | null;
  /** The newest FAILED run of this task whose OWN input names the message, and how many such runs there are. */
  failedRunId: string; failedRunCount: number;
  /** By the ONE function (answeredPersonMessageSql), at read time. */
  answered: boolean;
  /** The live unanswered-message notice that covers the message, if any; groupMessageIds is that notice's
   * still-owed member list (metadata.unansweredMessageIds) when it is a GROUP notice, else null. */
  noticeId: string | null; groupMessageIds: string[] | null;
};
export type FailedOwnPersonMessageMembership = {
  members: FailedOwnPersonMessageMember[];
  order: typeof FAILED_OWN_PERSON_MESSAGE_ORDER;
  /** true: `members` is the task's WHOLE membership (after `after`, when given). false only when the caller's own
   * `limit` cut it; `next` then continues it. Never cut silently. */
  exhausted: boolean;
  next: { createdAt: string; messageId: string } | null;
};

/** One page of the membership, in order, strictly after the cursor. The steps, by index (explain: the plan is
 * asserted on a seeded database in person-message-answer.membership.test.ts):
 * 1. the task's FAILED runs, one index scan per arm: heartbeat_runs_company_ctx_issue_created_idx (company_id,
 *    context_snapshot->>'issueId') and an index led by (company_id, native_issue_id)
 *    (heartbeat_runs_company_native_issue_contract_id_uq in the plan);
 * 2. the ids their own input names, as CANDIDATES only; the task's live person messages are read by
 *    issue_comments_company_issue_created_at_idx (company_id, issue_id) and joined to them, and the run (read by
 *    heartbeat_runs_pkey) must name the message in its OWN input by the one copy (ownInputNamesSql): the candidate
 *    list never decides membership;
 * 3. answered: the one function, per member (issue_comments_company_issue_created_at_idx, heartbeat_runs_pkey,
 *    native_run_results_company_issue_run_id_uq, native_run_finalizations_pkey, issue_thread_interactions by
 *    (company_id, issue_id), activity_log_company_entity_created_idx, issues_company_origin_idx);
 * 4. the task's live unanswered-message notices: issue_comments_company_issue_created_at_idx, one scan.
 * No step scans a table sequentially, so no index was added.
 * The member list has two arms: the task's person messages, and (second arm) a person's ANSWER to an agent's card
 * that a failed run's OWN input names (the card-answer duty's shape, unansweredCardAnswerSql: answered, accepted or
 * rejected by a person; never a withdrawal or an expiry), read by issue_thread_interactions' primary key. */
function failedOwnPersonMessagePageSql(input: { companyId: string; issueId: string; limit: number;
  after?: { createdAt: string; messageId: string } | null }): SQL {
  const message = { id: sql.raw("m.id"), companyId: sql.raw("m.company_id"), issueId: sql.raw("m.issue_id"), createdAt: sql.raw("m.created_at") };
  return sql`with failed_run as materialized (
      select r.id, r.created_at, r.context_snapshot from ${heartbeatRuns} r
        where r.company_id = ${input.companyId}::uuid and r.context_snapshot->>'issueId' = ${input.issueId}::text and ${failedRunSql()}
      union
      select r.id, r.created_at, r.context_snapshot from ${heartbeatRuns} r
        where r.company_id = ${input.companyId}::uuid and r.native_issue_id = ${input.issueId}::uuid and ${failedRunSql()}
    ), candidate as materialized (
      select distinct named.id::uuid as message_id, f.id as run_id, f.created_at as run_created_at from failed_run f
      cross join lateral (
        select f.context_snapshot->>'wakeCommentId' as id union all select f.context_snapshot->>'commentId'
        union all select f.context_snapshot->>'conversationReplyBoundaryCommentId'
        union all select jsonb_array_elements_text(case when jsonb_typeof(f.context_snapshot->'wakeCommentIds') = 'array'
          then f.context_snapshot->'wakeCommentIds' else '[]'::jsonb end)
        union all select jsonb_array_elements_text(case when jsonb_typeof(f.context_snapshot->'attributionCommentIds') = 'array'
          then f.context_snapshot->'attributionCommentIds' else '[]'::jsonb end)
        union all select jsonb_array_elements_text(case when jsonb_typeof(f.context_snapshot->'firstTurnQueuedInput'->'commentIds') = 'array'
          then f.context_snapshot->'firstTurnQueuedInput'->'commentIds' else '[]'::jsonb end)
        union all select f.context_snapshot->>'interactionId'
        union all select jsonb_array_elements_text(case when jsonb_typeof(f.context_snapshot->'interactionIds') = 'array'
          then f.context_snapshot->'interactionIds' else '[]'::jsonb end)
        union all select jsonb_array_elements_text(case when jsonb_typeof(f.context_snapshot->'attributionInteractionIds') = 'array'
          then f.context_snapshot->'attributionInteractionIds' else '[]'::jsonb end)) named
      where named.id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ), member as (
      select u.* from (
        select m.id, m.company_id, m.issue_id, m.created_at, m.author_user_id, 'message'::text as kind,
          (array_agg(c.run_id order by c.run_created_at desc, c.run_id desc))[1] as failed_run_id, count(*)::int as failed_run_count
        from candidate c
        join ${issueComments} m on m.id = c.message_id
        join ${heartbeatRuns} r on r.id = c.run_id and r.company_id = m.company_id
        where m.company_id = ${input.companyId}::uuid and m.issue_id = ${input.issueId}::uuid and m.author_type = 'user' and m.deleted_at is null
          and ${ownInputNamesSql(sql.raw("m.id"))}
        group by m.id, m.company_id, m.issue_id, m.created_at, m.author_user_id
        union all
        select q.id, q.company_id, q.issue_id, q.resolved_at as created_at, q.resolved_by_user_id as author_user_id, 'card_answer'::text as kind,
          (array_agg(c.run_id order by c.run_created_at desc, c.run_id desc))[1] as failed_run_id, count(*)::int as failed_run_count
        from candidate c
        join ${issueThreadInteractions} q on q.id = c.message_id
        join ${heartbeatRuns} r on r.id = c.run_id and r.company_id = q.company_id
        where q.company_id = ${input.companyId}::uuid and q.issue_id = ${input.issueId}::uuid and q.created_by_agent_id is not null
          and q.resolved_by_user_id is not null and q.resolved_at is not null and q.status in ('answered', 'accepted', 'rejected')
          and ${ownInputNamesSql(sql.raw("q.id"))}
        group by q.id, q.company_id, q.issue_id, q.resolved_at, q.resolved_by_user_id
      ) u
      ${input.after ? sql`where (u.created_at, u.id) > (${input.after.createdAt}::timestamptz, ${input.after.messageId}::uuid)` : sql``}
      order by u.created_at, u.id limit ${input.limit}
    ), notice as materialized (
      select n.id, n.created_at, n.metadata from ${issueComments} n
      where n.company_id = ${input.companyId}::uuid and n.issue_id = ${input.issueId}::uuid and n.author_type = 'system' and n.deleted_at is null
        and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
    )
    select m.kind as kind, m.id as "messageId", to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt",
      m.author_user_id as "authorUserId", m.failed_run_id as "failedRunId", m.failed_run_count as "failedRunCount",
      ${answeredPersonMessageSql(message)} as answered, covering.id as "noticeId", covering.group_ids as "groupMessageIds"
    from member m
    left join lateral (select n.id, case when jsonb_typeof(n.metadata->${UNANSWERED_MESSAGE_GROUP_KEY}::text) = 'array'
        then n.metadata->${UNANSWERED_MESSAGE_GROUP_KEY}::text end as group_ids from notice n
      where substr(n.metadata->>'authorizationReason', strpos(n.metadata->>'authorizationReason', ':') + 1) = m.id::text
        or coalesce(n.metadata->${UNANSWERED_MESSAGE_GROUP_KEY}::text, '[]'::jsonb) ? m.id::text
      order by n.created_at desc, n.id desc limit 1) covering on true
    order by m.created_at, m.id`;
}

/** The MEMBERSHIP of a task's failed-run person messages (rf-3 r3d item 1): every live person message of this
 * task and company, and every person's ANSWER to an agent's card (rf-3 01:03Z (2); `kind`), that a FAILED run of
 * the task (FAILED_RUN_STATUSES, or cancelled by anything but a person) names in its OWN input (ownInputNamesSql,
 * the one copy; never history, ancestry or a later input), each with its newest such run, whether it is ANSWERED (only through
 * answeredPersonMessageSql) and the group it is noticed in (read from the notice's metadata.unansweredMessageIds
 * where a group notice exists; never re-derived).
 * COMPLETE: with no `limit` the read pages (keyset on the order, MEMBERSHIP_PAGE_SIZE at a time) until the task
 * has no further member and says so (`exhausted: true`); it never stops at a page or a fixed count. With a
 * `limit` it returns at most that many, `exhausted: false` and `next` when more remain.
 * ORDER: FAILED_OWN_PERSON_MESSAGE_ORDER, stated in the result. SCOPE: one company and one task; a run or a
 * comment of another company or task is never read into it, even when a run's input names it. */
export async function readTaskFailedOwnPersonMessageMembership(db: Pick<Db, "execute">, input: { companyId: string; issueId: string;
  limit?: number; after?: { createdAt: string; messageId: string } | null }): Promise<FailedOwnPersonMessageMembership> {
  const members: FailedOwnPersonMessageMember[] = [];
  let after = input.after ?? null;
  for (;;) {
    const want = input.limit === undefined ? MEMBERSHIP_PAGE_SIZE : Math.min(MEMBERSHIP_PAGE_SIZE, input.limit - members.length);
    const rows = [...await db.execute(failedOwnPersonMessagePageSql({ companyId: input.companyId, issueId: input.issueId,
      limit: want + 1, after }))] as unknown as Array<Omit<FailedOwnPersonMessageMember, "createdAt"> & { createdAt: string }>;
    const page = rows.slice(0, want);
    for (const row of page) members.push({ ...row, createdAt: new Date(row.createdAt) });
    const last = page.at(-1);
    const more = rows.length > want;
    const next = more && last ? { createdAt: last.createdAt, messageId: last.messageId } : null;
    if (!more) return { members, order: FAILED_OWN_PERSON_MESSAGE_ORDER, exhausted: true, next: null };
    if (input.limit !== undefined && members.length >= input.limit) return { members, order: FAILED_OWN_PERSON_MESSAGE_ORDER, exhausted: false, next };
    after = next;
  }
}
/** The page's SQL, for the plan row only (EXPLAIN on a seeded database). */
export const failedOwnPersonMessagePageSqlForExplain = failedOwnPersonMessagePageSql;

/** SQL: a card that WAS message m's response (the same card arm as answeredPersonMessageSql: posted after m by the
 * agent from a run whose OWN input names m) ENDED unanswerable (expired, failed, cancelled by the system or the
 * agent) at or after `since`. Ruling 3: m is owed again from then. The sweep reads it so a notice that was retired
 * while the card stood does not count as m's notice any more (am5 gap 17). */
export function messageCardEndedSinceSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }, since: SQL): SQL {
  return sql`exists (select 1 from ${issueThreadInteractions} q
    join ${heartbeatRuns} r on r.id = q.source_run_id and r.company_id = q.company_id
    where q.company_id = ${m.companyId} and q.issue_id = ${m.issueId} and q.created_by_agent_id = r.agent_id
      and q.created_at > ${m.createdAt} and not ${answerableCardSql(m.id)}
      and coalesce(q.resolved_at, q.updated_at) >= ${since}
      and ${ownInputNamesSql(m.id)})`;
}

/** A person's card answer whose delivery to the agent is still pending is a further attempt only this long after
 * the answer (resolved_at): a dead delivery worker never leaves the answer silent. */
export const CARD_ANSWER_DELIVERY_BOUND_MS = 10 * 60_000;

/** SQL over an issue_thread_interactions alias: the CARD-ANSWER DUTY (RFL ruling 4; ported from bb/tamin6
 * person-message-answer.ts:170-187). A person's ANSWER to an agent's card (answered, accepted or rejected by a
 * person; a withdrawal, a cancel or an expiry is no answer and owes nothing) is person input the next run owes,
 * like a typed message: it is owed when a run took it as its OWN input (the answer-resume run's interactionId, a
 * carry's interactionIds) or its delivery to the agent is still waiting for a run, and the ONE function
 * (answeredPersonMessageSql, keyed by the card id and its answer time; no second reply rule) does not say it is
 * answered. An answer still being delivered is a pending attempt, not a silent one, until
 * CARD_ANSWER_DELIVERY_BOUND_MS from the answer time. */
export function unansweredCardAnswerSql(alias: string, now: Date = new Date()): SQL {
  const q = sql.identifier(alias);
  const deliveryCutoff = new Date(now.getTime() - CARD_ANSWER_DELIVERY_BOUND_MS).toISOString();
  return sql`(${q}.resolved_by_user_id is not null and ${q}.resolved_at is not null
    and ${q}.status in ('answered', 'accepted', 'rejected')
    and (exists (select 1 from ${heartbeatRuns} r where r.company_id = ${q}.company_id
        and (r.native_issue_id = ${q}.issue_id or r.context_snapshot->>'issueId' = ${q}.issue_id::text)
        and ${ownInputNamesSql(sql`${q}.id`)})
      or exists (select 1 from ${issueQuestionResponseDeliveries} waiting where waiting.company_id = ${q}.company_id
        and waiting.interaction_id = ${q}.id and waiting.status in ('pending', 'delivering', 'fallback_queued')))
    and (${q}.resolved_at <= ${deliveryCutoff}::timestamptz
      or not exists (select 1 from ${issueQuestionResponseDeliveries} delivery where delivery.company_id = ${q}.company_id
        and delivery.interaction_id = ${q}.id and delivery.status in ('pending', 'delivering')))
    and not ${answeredPersonMessageSql({ id: sql`${q}.id`, companyId: sql`${q}.company_id`,
      issueId: sql`${q}.issue_id`, createdAt: sql`${q}.resolved_at` })})`;
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
