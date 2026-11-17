import { sql, type SQL } from "drizzle-orm";
import { activityLog, heartbeatRunEvents, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issues } from "@paperclipai/db";
import { freshContinuationSourceChainSql } from "./fresh-continuation-chain.js";
import { FRESH_CONTINUATIONS_PER_CHAIN } from "./fresh-continuation-fallback.js";

/** The import's per-task arrival record: one activity row per issue a company import creates (issues.importIssues). */
export const ISSUE_IMPORTED_ACTION = "issue.imported";
/** The import routes' audit row, written after a committed import (routes/companies.ts). */
export const COMPANY_IMPORTED_ACTION = "company.imported";

type PersonMessageSql = { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL };

/** A wait for a further attempt stays true only this long from its fixed
 * durable start (a failed run's end, a card's answer time): past it, ONE true
 * notice. Shared by the unanswered-message sweep and the card-answer duty. */
export const PENDING_WAIT_START_BOUND_MS = 10 * 60_000;

// A person input is a typed message (a comment id) or a person's answer to an
// agent's card (the interaction id): its answer-resume run carries it as
// context.interactionId (routes/issues.ts wake contexts). Ids never collide.
// R-ONCE (RFL 18:19Z): this is the run's PENDING input. A message steered into
// the run is pending input too: the steer route records the provider's
// acknowledgement on the run (result_json.queuedSteeringAcknowledgements,
// routes/issues.ts) and the run log (a validated steering_acknowledgement item
// '...:steer:<id>', which a restart restores: unread-steered-messages.ts).
// Transcript history is never pending input.
function carriesCommentSql(alias: string, commentId: SQL): SQL {
  const run = sql.identifier(alias);
  const context = sql`${run}.context_snapshot`;
  return sql`(${context}->>'wakeCommentId' = ${commentId}::text or ${context}->>'commentId' = ${commentId}::text
    or ${context}->>'conversationReplyBoundaryCommentId' = ${commentId}::text
    or ${context}->>'interactionId' = ${commentId}::text
    or coalesce(${context}->'wakeCommentIds', '[]'::jsonb) ? ${commentId}::text
    or coalesce(${context}->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${commentId}::text
    or (jsonb_typeof(${run}.result_json->'queuedSteeringAcknowledgements') = 'object'
      and ${run}.result_json->'queuedSteeringAcknowledgements' ? ${commentId}::text)
    or exists (select 1 from ${heartbeatRunEvents} steer where steer.company_id = ${run}.company_id
      and steer.run_id = ${run}.id and steer.source_event_id is not null and steer.event_type = 'item.completed'
      and steer.payload->'prpEvent'->'payload'->>'kind' = 'steering_acknowledgement'
      and steer.payload->'prpEvent'->>'itemId' like '%:steer:' || ${commentId}::text))`;
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

/** A person message is answered by a published agent reply from a run whose chain had THAT message as its
 * pending input (R-ONCE, RFL 18:19Z: a reply to a later input answers M only when its run carried M too;
 * transcript history never counts), an open or resolved interaction card on its run chain, or imported history. Answering the card is new input;
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
  return sql`(exists (select 1 from ${issueComments} a
    join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and (exists (select 1 from ${issueComments} b
        where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and b.id = ${m.id}
          and ${chainCarriesCommentSql("r", sql`b.id`, m)})
        -- A card answer is an input with no comment row: its own chain carries it. Its rule is unchanged by
        -- R-ONCE: a reply to a later person input still settles it (owedCardAnswerSql owes none after one).
        or (not exists (select 1 from ${issueComments} own where own.id::text = ${m.id}::text)
          and (${chainCarriesCommentSql("r", m.id, m)}
            or exists (select 1 from ${issueComments} b
              where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
                and b.created_at > ${m.createdAt}
                and ${chainCarriesCommentSql("r", sql`b.id`, m)})))))
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

/** Whether ALL person inputs carried by a run's durable chain are answered.
 * No input is not proof of an answer. Transcript history never enters this
 * set, and an unanswered sibling input keeps Retry available. */
export function runPersonInputAnsweredSql(input: { companyId: SQL; issueId: SQL; runId: SQL }): SQL<boolean> {
  const carries = (id: SQL) => sql`exists (select 1 from source_chain link
    join ${heartbeatRuns} carrying on carrying.id = link.id and carrying.company_id = ${input.companyId}
    where ${carriesCommentSql("carrying", id)})`;
  return sql<boolean>`(${freshContinuationSourceChainSql(input, true)}, carried_person_input as (
    select m.id, m.company_id, m.issue_id, m.created_at from ${issueComments} m
      where m.company_id = ${input.companyId} and m.issue_id = ${input.issueId}
        and m.author_type = 'user' and m.deleted_at is null and ${carries(sql`m.id`)}
    union all
    select q.id, q.company_id, q.issue_id, q.resolved_at from ${issueThreadInteractions} q
      where q.company_id = ${input.companyId} and q.issue_id = ${input.issueId}
        and q.resolved_by_user_id is not null and q.resolved_at is not null
        and q.status in ('answered', 'accepted', 'rejected') and ${carries(sql`q.id`)}
    ) select coalesce(bool_and(${answeredPersonMessageSql({ id: sql`pending.id`, companyId: sql`pending.company_id`,
      issueId: sql`pending.issue_id`, createdAt: sql`pending.created_at` })}), false) from carried_person_input pending)`;
}

/** Card statuses a person's own answer leaves; administrative ends (withdraw,
 * cancel, expiry) are not an answer and create no duty. */
const CARD_ANSWER_STATUSES = ["answered", "accepted", "rejected"] as const;

/** SQL over an issue_thread_interactions alias: a person's answer to an
 * agent's card that started an answer-resume run and that no agent answered
 * yet (a reply or a new card on that run's chain, after the answer). The SAME
 * rule as a typed message (answeredPersonMessageSql), keyed by the card id and
 * its answer time. It is an owed person input like a typed message.
 * A response delivery still pending or delivering is a further attempt only
 * within PENDING_WAIT_START_BOUND_MS of the answer (resolvedAt): a dead
 * delivery worker never leaves the answer silent. It is never one once the
 * answer's chain ENDED because automatic recovery stopped
 * (automaticRecoveryStoppedOnCardChainSql). */
export function unansweredCardAnswerSql(alias: string, now: Date = new Date()): SQL {
  const q = sql.identifier(alias);
  const deliveryCutoff = new Date(now.getTime() - PENDING_WAIT_START_BOUND_MS).toISOString();
  return sql`(${q}.resolved_by_user_id is not null and ${q}.resolved_at is not null
    and ${q}.status in (${sql.join(CARD_ANSWER_STATUSES.map(status => sql`${status}`), sql`, `)})
    and exists (select 1 from ${heartbeatRuns} resume where resume.company_id = ${q}.company_id
      and (resume.native_issue_id = ${q}.issue_id or resume.context_snapshot->>'issueId' = ${q}.issue_id::text)
      and resume.context_snapshot->>'interactionId' = ${q}.id::text)
    -- An answer still being delivered to the agent is a pending attempt, not a
    -- silent one, until the bound from its answer time.
    and (${q}.resolved_at <= ${deliveryCutoff}::timestamptz or ${automaticRecoveryStoppedOnCardChainSql(alias)}
      or not exists (select 1 from ${issueQuestionResponseDeliveries} delivery
      where delivery.company_id = ${q}.company_id and delivery.interaction_id = ${q}.id
        and delivery.status in ('pending', 'delivering')))
    and not ${answeredPersonMessageSql({ id: sql`${q}.id`, companyId: sql`${q}.company_id`,
      issueId: sql`${q}.issue_id`, createdAt: sql`${q}.resolved_at` })})`;
}

/** SQL over an issue_thread_interactions alias: the card answer's chain ENDED
 * because AUTOMATIC RECOVERY STOPPED (rf5 20:09Z). A run on the answer's
 * chain (its answer-resume run or an automatic successor of it) has its hold
 * resolved "blocked" with no replay (execution-recovery-resolution.ts:903-962,
 * automaticRecovery.replay blocked, nextAction "Automatic recovery
 * stopped...") and that run's chain already used FRESH_CONTINUATIONS_PER_CHAIN
 * fresh continuations, so the fallback never continues it
 * (continueFreshInTransaction: not_applicable, fresh_continuation_chain_exhausted).
 * Nothing further runs by itself: the chain ended, not still running. */
export function automaticRecoveryStoppedOnCardChainSql(alias: string): SQL {
  const q = sql.identifier(alias);
  const chainInput = { companyId: sql`${q}.company_id`, issueId: sql`${q}.issue_id`, runId: sql`ended.id` };
  return sql`exists (select 1 from issue_recovery_actions stop
    join ${heartbeatRuns} ended on ended.company_id = stop.company_id
      and ended.id::text = stop.evidence#>>'{automaticRecovery,runId}'
    where stop.company_id = ${q}.company_id and stop.source_issue_id = ${q}.issue_id
      and stop.status = 'resolved' and stop.outcome = 'blocked'
      and stop.evidence#>>'{automaticRecovery,replay}' = 'blocked'
      and ended.status in ('failed', 'timed_out', 'interrupted', 'cancelled')
      and exists (${freshContinuationSourceChainSql(chainInput)}
        select 1 from source_chain link join ${heartbeatRuns} resume on resume.id = link.id and resume.company_id = ${q}.company_id
        where resume.context_snapshot->>'interactionId' = ${q}.id::text
          and (select count(*) from issue_recovery_actions attempt where attempt.company_id = ${q}.company_id
            and attempt.source_issue_id = ${q}.issue_id
            and attempt.evidence#>>'{freshContinuation,sourceRunId}' in (select id::text from source_chain))
            >= ${FRESH_CONTINUATIONS_PER_CHAIN}))`;
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
