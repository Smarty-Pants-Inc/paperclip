import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { freshContinuationSourceChainSql } from "./fresh-continuation-chain.js";
import { wellFormedExecutionWaitSql } from "./deferred-execution-wait.js";

/** The import's per-task arrival record: one activity row per issue a company import creates (issues.importIssues). */
export const ISSUE_IMPORTED_ACTION = "issue.imported";
/** The import routes' audit row, written after a committed import (routes/companies.ts). */
export const COMPANY_IMPORTED_ACTION = "company.imported";

type PersonMessageSql = { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL };
type DeferredWakeSql = { companyId: SQL; agentId: SQL; issueId: SQL; requestedAt: SQL; payload: SQL };

/** A later turn moved the thread on only when it STARTED after the boundary,
 * succeeded, and published a live agent reply on this issue. Reply time alone
 * cannot discard input that arrived while that turn was already running. */
export function conversationMovedOnSql(m: Pick<PersonMessageSql, "companyId" | "issueId" | "createdAt">, commentId?: SQL): SQL {
  return sql`exists (select 1 from ${heartbeatRuns} moved_on
    where moved_on.company_id = ${m.companyId}
      and (moved_on.native_issue_id = ${m.issueId} or moved_on.context_snapshot->>'issueId' = ${m.issueId}::text)
      and moved_on.status = 'succeeded' and moved_on.started_at > ${m.createdAt}
      and exists (select 1 from ${issueComments} moved_reply where moved_reply.company_id = moved_on.company_id
        and moved_reply.issue_id = ${m.issueId} and moved_reply.created_by_run_id = moved_on.id
        and moved_reply.author_type = 'agent' and moved_reply.deleted_at is null)
      ${commentId ? sql`and not exists (select 1 from ${heartbeatRuns} later_carrier
        where later_carrier.company_id = moved_on.company_id and later_carrier.started_at >= moved_on.started_at
          and ${carriesCommentSql("later_carrier", commentId, false)})` : sql``})`;
}

/** A Stop's held input outlives the next typed turn. The release saves the
 * exact stopped-run id on its surviving receipt, NOT a latest-run inference.
 * Older saved execution waits can name the Stop's own board recovery hold.
 * Neither an Interrupt nor a generic execution wait grants this exception. */
export function deferredWakeIsStaleSql(w: DeferredWakeSql): SQL {
  const personStopHold = sql`(${w.payload}->'queuedCommentInterrupt' is null and exists (
    select 1 from ${heartbeatRuns} stopped
    where stopped.company_id = ${w.companyId} and stopped.agent_id = ${w.agentId}
      and (stopped.native_issue_id = ${w.issueId} or stopped.context_snapshot->>'issueId' = ${w.issueId}::text)
      and stopped.status = 'cancelled' and stopped.result_json->>'cancelledByActorType' = 'user'
      and stopped.result_json->>'queuedCommentInterruptQueueId' is null
      and (stopped.id::text = ${w.payload}->'personStopHold'->>'runId'
        or exists (select 1 from ${issueRecoveryActions} stop_hold
          where stop_hold.company_id = ${w.companyId} and stop_hold.source_issue_id = ${w.issueId}
            and stop_hold.id::text = ${w.payload}->'executionWait'->>'recoveryActionId'
            and stop_hold.cause = 'native_continuation_requires_reconciliation'
            and stop_hold.evidence->>'runId' = stopped.id::text))))`;
  return sql`(not ${personStopHold} and ${conversationMovedOnSql({
    companyId: w.companyId, issueId: w.issueId, createdAt: w.requestedAt,
  })})`;
}

function carriesCommentSql(alias: string, commentId: SQL, requireSteeredText: boolean): SQL {
  const context = sql`${sql.identifier(alias)}.context_snapshot`;
  const steeredText = requireSteeredText
    ? sql`(not coalesce(${context}->'steeredCommentIds', '[]'::jsonb) ? ${commentId}::text
      or coalesce(${context}->'answeredSteeredCommentIds', '[]'::jsonb) ? ${commentId}::text)`
    : sql`true`;
  return sql`(${steeredText}
    and (${context}->>'wakeCommentId' = ${commentId}::text or ${context}->>'commentId' = ${commentId}::text
    or ${context}->>'conversationReplyBoundaryCommentId' = ${commentId}::text
    or coalesce(${context}->'wakeCommentIds', '[]'::jsonb) ? ${commentId}::text
    or coalesce(${context}->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${commentId}::text))`;
}

/** A reply/card can belong to a later run without copying the original input
 * ids. Follow durable continuation and answered-interaction edges, never mere
 * session identity or a later run's timestamp. UNION makes cycles terminate. */
function chainCarriesCommentSql(alias: string, commentId: SQL, m: PersonMessageSql, requireSteeredText = true): SQL {
  return sql`(${carriesCommentSql(alias, commentId, requireSteeredText)} or exists (
    ${freshContinuationSourceChainSql({ companyId: m.companyId, issueId: m.issueId,
      runId: sql`${sql.identifier(alias)}.id` }, true)}
    select 1 from source_chain input
      join ${heartbeatRuns} carrying on carrying.id = input.id and carrying.company_id = ${m.companyId}
      where ${carriesCommentSql("carrying", commentId, requireSteeredText)}))`;
}

// A presented card and either kind of reply remain an answer to the input
// carried by its source run. Administrative invalidation alone does not prove
// delivery; cancelled cards need evidence of a human skip/withdraw/cancel reply.
const PERSON_MESSAGE_ANSWER_CARD_STATUSES = ["pending", "answered", "accepted", "rejected"] as const;

/** A person message is answered by a published agent reply attributed to it or to a later person input,
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
  // Failed-carrier exception (L1b, SMA-4 11-19 06:15:44Z d2840901): a message
  // whose OWN carrying run FAILED without a reply was never seen through by the
  // agent, so a reply to a LATER message does not answer it. It stays owed
  // until a run that carries it (its re-delivery) answers, or its card stands.
  // Reached clause (RFL 08:41Z): a reply to a LATER message answers m ONLY if m
  // REACHED the agent: m was in some run's input (any carried key, including
  // wakeCommentIds and context.commentId) of a run that STARTED (started_at, set
  // at claim; a run cancelled before start never reached the model). A STEERED m counts as reached only
  // when its text went into a model request (requireSteeredText = true: it is in
  // answeredSteeredCommentIds); Pi's read alone is not enough (RFL). A message
  // held and never carried stays owed (carried next, or a true card). Imported
  // history is answered by its own arm below, never by this one.
  return sql`(exists (select 1 from ${heartbeatRuns} streamed
      where streamed.company_id = ${m.companyId}
        and (streamed.native_issue_id = ${m.issueId} or streamed.context_snapshot->>'issueId' = ${m.issueId}::text)
        and coalesce(streamed.context_snapshot->'steeredCommentIds', '[]'::jsonb) ? ${m.id}::text
        and coalesce(streamed.context_snapshot->'answeredSteeredCommentIds', '[]'::jsonb) ? ${m.id}::text)
    or exists (select 1 from ${issueComments} a
    join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and exists (select 1 from ${issueComments} b
        where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and (b.id = ${m.id} or (b.created_at > ${m.createdAt}
            -- A steer can overtake an earlier queued message: it answers only itself.
            and not coalesce(r.context_snapshot->'steeredCommentIds', '[]'::jsonb) ? b.id::text
            and not ${failedCarrierSql(m)}
            -- Reached clause (RFL 08:41Z): ...and only if m REACHED the agent (see the comment above),
            -- by a run that STARTED its turn: the claim sets started_at; a run cancelled before
            -- start (still null) never put m before a model, so m stays owed.
            and exists (select 1 from ${heartbeatRuns} rc
              where rc.company_id = ${m.companyId} and rc.started_at is not null
                and ${carriesCommentSql("rc", m.id, true)})))
          and ${chainCarriesCommentSql("r", sql`b.id`, m)}))
    or exists (select 1 from ${issueThreadInteractions} q
      join ${heartbeatRuns} r on r.id = q.source_run_id and r.company_id = q.company_id
      where q.company_id = ${m.companyId} and q.issue_id = ${m.issueId}
        and q.created_by_agent_id = r.agent_id
        and (q.status in (${sql.join(PERSON_MESSAGE_ANSWER_CARD_STATUSES.map(status => sql`${status}`), sql`, `)})
          or (q.status = 'cancelled' and q.resolved_by_user_id is not null
            and (q.result->>'outcome' in ('skipped', 'withdrawn') or q.result->>'cancelled' = 'true')))
        and q.created_at > ${m.createdAt}
        -- Preserve c3's explicit interaction-answer contract (PV2 card-answer):
        -- a published card is already a response to its own carried input.
        -- Only the generic reply arm needs the new streamed-text guard.
        and ${chainCarriesCommentSql("r", m.id, m, false)})
    or ${importedPersonHistorySql(m)})`;
}

/**
 * adopt-held-floor3: the ONE 'still owed' floor, read by BOTH the conversation outbox
 * (agent-conversations.ts undeliveredConversationComments: no wake below it) and the per-message
 * sweep (recovery/unanswered-person-message.ts: no card below it), so one never re-sends what the
 * other cards. Message m is owed only while the conversation has NOT moved on past it:
 * - answeredPersonMessageSql does not call it answered;
 * - NO succeeded run on its issue that STARTED (started_at, never reply time: M queued during T,
 *   T replies, a pause cancels M's wake ⇒ M still owed) after m was saved and posted an agent reply
 *   in the thread (SMA-4 11-19 13:53Z: three 11-17 messages answered by later turns, re-sent at boot);
 * - it is not behind the chat's latest /new boundary (issues.conversation_boundary_comment_id).
 */
/**
 * neworg-floor-custody: m is in LIVE custody (never floor-skipped): a wake that still holds it
 * (queued / claimed, or non-stale deferred: a durable person-Stop hold included)
 * or a run carrying it that has not finished. Its owner delivers it; stale deferred
 * receipts cannot hide messages from the floor.
 */
function liveMessageCustodySql(m: PersonMessageSql): SQL {
  return sql`(exists (select 1 from ${agentWakeupRequests} live_wake
      where live_wake.company_id = ${m.companyId}
        and (live_wake.status in ('queued', 'claimed')
          or ((live_wake.status = 'deferred_issue_execution'
            -- rf-4 C-V: a 'deferred' wake with a saved wait can still hold input.
            or (live_wake.status = 'deferred' and ${wellFormedExecutionWaitSql(sql.raw("live_wake.payload"))}))
            and not ${deferredWakeIsStaleSql({ companyId: sql`live_wake.company_id`, agentId: sql`live_wake.agent_id`,
              issueId: m.issueId, requestedAt: sql`live_wake.requested_at`, payload: sql`live_wake.payload` })}))
        and (live_wake.idempotency_key = 'conversation-comment:' || ${m.id}::text
          or live_wake.payload->>'commentId' = ${m.id}::text
          or live_wake.payload->'_paperclipWakeContext'->>'wakeCommentId' = ${m.id}::text
          or coalesce(live_wake.payload->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text))
    or exists (select 1 from ${heartbeatRuns} live_run
      where live_run.company_id = ${m.companyId} and live_run.status in ('queued', 'running')
        and ${carriesCommentSql("live_run", m.id, false)}))`;
}

/**
 * RFL 15:46Z amendment: a wake's fields count only after a run claimed it.
 * A saved/deferred/cancelled-unclaimed receipt never handed its text to an agent.
 * Run-side fields are unchanged. Never-carried messages keep their one true card.
 */
function everCarriedSql(m: PersonMessageSql): SQL {
  return sql`(exists (select 1 from ${agentWakeupRequests} any_wake
      where any_wake.company_id = ${m.companyId}
        and (any_wake.status in ('claimed', 'completed') or any_wake.run_id is not null
          or exists (select 1 from ${heartbeatRuns} claimed_run where claimed_run.company_id = any_wake.company_id
            and claimed_run.wakeup_request_id = any_wake.id))
        and (any_wake.idempotency_key = 'conversation-comment:' || ${m.id}::text
          or any_wake.payload->>'commentId' = ${m.id}::text
          or any_wake.payload->'_paperclipWakeContext'->>'wakeCommentId' = ${m.id}::text
          or any_wake.payload->'_paperclipWakeContext'->>'commentId' = ${m.id}::text
          or coalesce(any_wake.payload->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text
          or coalesce(any_wake.payload->'commentIds', '[]'::jsonb) ? ${m.id}::text))
    or exists (select 1 from ${heartbeatRuns} any_run
      where any_run.company_id = ${m.companyId} and (${carriesCommentSql("any_run", m.id, false)}
        -- rf-4 F2: every carry field (steered, carried, restored, Stop-restored, Interrupt-carried, acknowledged steers).
        or coalesce(any_run.context_snapshot->'steeredCommentIds', '[]'::jsonb) ? ${m.id}::text
        or coalesce(any_run.context_snapshot->'carriedSteeredCommentIds', '[]'::jsonb) ? ${m.id}::text
        or coalesce(any_run.result_json->'restoredSteeredCommentIds', '[]'::jsonb) ? ${m.id}::text
        or coalesce(any_run.result_json->'stopRestoredSteeredCommentIds', '[]'::jsonb) ? ${m.id}::text
        or coalesce(any_run.result_json->'interruptCarriedSteeredCommentIds', '[]'::jsonb) ? ${m.id}::text
        or (jsonb_typeof(any_run.result_json->'queuedSteeringAcknowledgements') = 'object'
          and any_run.result_json->'queuedSteeringAcknowledgements' ? ${m.id}::text))))`;
}

export function personMessageOwedSql(m: PersonMessageSql): SQL {
  return sql`(not ${answeredPersonMessageSql(m)}
    and (${liveMessageCustodySql(m)} or not ${everCarriedSql(m)}
      -- A carrier at/after the move-on turn still owns m (Stop-held README,
      -- then '9 + 10', then README's carrier); its own failure still cards.
      or not ${conversationMovedOnSql(m, m.id)})
    and not exists (select 1 from ${issues} reset_issue
      join ${issueComments} reset_boundary on reset_boundary.id = reset_issue.conversation_boundary_comment_id
        and reset_boundary.company_id = reset_issue.company_id and reset_boundary.issue_id = reset_issue.id
      where reset_issue.id = ${m.issueId} and reset_issue.company_id = ${m.companyId}
        and (${m.createdAt}, ${m.id}) < (reset_boundary.created_at, reset_boundary.id)))`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids among `commentIds` that answeredPersonMessageSql says are answered.
 * The ONE reader for callers holding ids (the Interrupt route's carry of the
 * interrupted turn's input, a saved Interrupt's resume): an AGENT reply (never
 * a system notice) by a run carrying the message (any carried key, including
 * context.commentId) or a later person input, a card on its chain, or imported
 * history; a failed carrier never counts (L1b). Never a second partial predicate.
 */
export async function answeredPersonMessageIds(
  db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; commentIds: string[] },
): Promise<Set<string>> {
  const ids = [...new Set(input.commentIds.filter(id => UUID.test(id)))];
  if (!ids.length) return new Set();
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, ids),
    answeredPersonMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }),
  ));
  return new Set(rows.map(row => row.id));
}

/** SQL: a run that carried message m FAILED and posted no reply of its own. */
function failedCarrierSql(m: PersonMessageSql): SQL {
  return sql`exists (select 1 from ${heartbeatRuns} fc
    where fc.company_id = ${m.companyId} and ${failedCarrierRunSql("fc", m)})`;
}

/** SQL over the heartbeat_runs row `alias`: that run carried message m (any carried key), FAILED, and posted no
 * agent reply of its own: the ONE failed-carrier notion (L1b). failedCarrierSql above and the unanswered-message
 * sweep's older selection (G1: an owed message carried only by failed runs still gets its one card) both read it. */
export function failedCarrierRunSql(alias: string, m: Pick<PersonMessageSql, "id">): SQL {
  const run = sql.identifier(alias);
  return sql`(${run}.status = 'failed' and ${carriesCommentSql(alias, m.id, false)}
      and not exists (select 1 from ${issueComments} fr where fr.company_id = ${run}.company_id
        and fr.created_by_run_id = ${run}.id and fr.author_type = 'agent' and fr.deleted_at is null))`;
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
