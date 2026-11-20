import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { activityLog, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issueThreadInteractions, issues, nativeRunFinalizations, nativeRunResults, type Db } from "@paperclipai/db";
import { freshContinuationSourceChainSql } from "./fresh-continuation-chain.js";
import { wellFormedExecutionWaitSql } from "./deferred-execution-wait.js";

/** The import's per-task arrival record: one activity row per issue a company import creates (issues.importIssues). */
export const ISSUE_IMPORTED_ACTION = "issue.imported";
/** The import routes' audit row, written after a committed import (routes/companies.ts). */
export const COMPANY_IMPORTED_ACTION = "company.imported";

type PersonMessageSql = { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL };
type DeferredWakeSql = { companyId: SQL; agentId: SQL; issueId: SQL; requestedAt: SQL; payload: SQL };

/** RULE-ANSWERED-MEANS-ANSWERED-1119 Half 2: admission age, never an answered/owed definition. */
export const PERSON_MESSAGE_SEND_WINDOW_MS = 24 * 60 * 60_000;
export function personMessageWithinSendWindowSql(createdAt: SQL, now: SQL = sql`now()`): SQL {
  return sql`${createdAt} > ${now} - ${PERSON_MESSAGE_SEND_WINDOW_MS} * interval '1 millisecond'`;
}

/** Persisted ids at every automatic send boundary, including legacy carry keys.
 * The server clock, not a wake's requestedAt or a client's timestamp, decides. */
export async function expiredPersonMessageIds(db: Pick<Db, "select">,
  input: { companyId: string; issueId: string; contextSnapshot: unknown }, now?: Date): Promise<string[]> {
  const context = (input.contextSnapshot ?? {}) as Record<string, unknown>;
  const first = (context.firstTurnQueuedInput ?? {}) as Record<string, unknown>;
  const ids = [...new Set([context.commentId, context.wakeCommentId, context.conversationReplyBoundaryCommentId,
    ...[context.wakeCommentIds, context.steeredCommentIds, context.carriedSteeredCommentIds, first.commentIds]
      .flatMap(value => Array.isArray(value) ? value : [])]
    .filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  if (!ids.length) {
    // An automatic successor can name its source without copying input keys.
    // Read the existing durable continuation chain rather than losing the age
    // fence when a retry seed is sparse. A fresh person's own input wins above.
    const sourceIds = [context.retryOfRunId, context.previousRunId].filter((id): id is string => typeof id === "string" && UUID.test(id));
    if (!sourceIds.length) return [];
    const sources = await db.select({ context: heartbeatRuns.contextSnapshot, result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      sql`(${sql.join(sourceIds.map(runId => sql`${heartbeatRuns.id} in (${freshContinuationSourceChainSql({
        companyId: input.companyId, issueId: input.issueId, runId,
      })} select id from source_chain)`), sql` or `)})`,
      sql`(${heartbeatRuns.nativeIssueId} = ${input.issueId}::uuid or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId})`,
    ));
    // The shared chain reader bounds ancestry at a new person's independent
    // input and terminates cycles; do not invent a second lineage definition.
    const sourceMessageIds = sources.flatMap(source => {
      const c = source.context ?? {}, f = (c.firstTurnQueuedInput ?? {}) as Record<string, unknown>;
      const r = source.result ?? {};
      return [c.commentId, c.wakeCommentId, c.conversationReplyBoundaryCommentId,
        ...[c.wakeCommentIds, c.steeredCommentIds, c.carriedSteeredCommentIds, f.commentIds,
          r.restoredSteeredCommentIds, r.stopRestoredSteeredCommentIds, r.interruptCarriedSteeredCommentIds]
          .flatMap(v => Array.isArray(v) ? v : [])];
    }).filter((id): id is string => typeof id === "string" && UUID.test(id));
    ids.push(...new Set(sourceMessageIds));
    if (!ids.length) return [];
  }
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorType, "user"), sql`${issueComments.deletedAt} is null`, inArray(issueComments.id, ids),
    sql`not (${personMessageWithinSendWindowSql(sql`${issueComments.createdAt}`, now ? sql`${now.toISOString()}::timestamptz` : sql`now()`)})`,
  ));
  return rows.map(row => row.id);
}

/** RFL 17:07Z: a deferred receipt ages only when a succeeded replying turn
 * actually claimed a newer PERSON input. Starting later is not evidence: a
 * queued successor may start after messages that are still waiting behind it.
 * Keep the per-message floor's separate carried-message rule above intact. */
export function newerPersonInputAnsweredSql(w: Pick<DeferredWakeSql, "companyId" | "issueId" | "requestedAt">,
  stillCarried?: SQL): SQL {
  // rf-5 Q2: 'answered' is THE one function (answeredPersonMessageSql), never a second predicate.
  // The person moved past w when a person message created after it was ANSWERED; a carrier of the
  // held input that started at or after that newer message still owns it (the Stop-held README).
  return sql`exists (select 1 from ${issueComments} newer_person
    where newer_person.company_id = ${w.companyId} and newer_person.issue_id = ${w.issueId}
      and newer_person.author_type = 'user' and newer_person.deleted_at is null
      and newer_person.created_at > ${w.requestedAt}
      and ${answeredPersonMessageSql({ id: sql`newer_person.id`, companyId: sql`newer_person.company_id`,
        issueId: sql`newer_person.issue_id`, createdAt: sql`newer_person.created_at` })}
      ${stillCarried ? sql`and not exists (select 1 from ${heartbeatRuns} later_carrier
        where later_carrier.company_id = newer_person.company_id and later_carrier.started_at >= newer_person.created_at
          and ${carriesCommentSql("later_carrier", stillCarried, false)})` : sql``})`;
}

/** A Stop's held input outlives the next typed turn. The release saves the
 * exact stopped-run id on its surviving receipt, NOT a latest-run inference.
 * Older saved execution waits can name the Stop's own board recovery hold.
 * Neither an Interrupt nor a generic execution wait grants this exception. */
export function deferredWakeIsStaleSql(w: DeferredWakeSql): SQL {
  // Age retires SEND custody, not the person's obligation. Use persisted PERSON
  // input, never requestedAt/updatedAt; a touched receipt cannot rejuvenate it.
  // A mixed queue keeps its fresh input, which promotion filters independently.
  const heldPerson = (alias: string) => {
    const p = sql.identifier(alias);
    return sql`${p}.company_id = ${w.companyId} and ${p}.issue_id = ${w.issueId}
      and ${p}.author_type = 'user' and ${p}.deleted_at is null
      and (${p}.id::text = ${w.payload}->>'commentId'
        or ${p}.id::text = ${w.payload}->'_paperclipWakeContext'->>'commentId'
        or ${p}.id::text = ${w.payload}->'_paperclipWakeContext'->>'wakeCommentId'
        or coalesce(${w.payload}->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? ${p}.id::text)`;
  };
  const expiredPersonInput = sql`(exists (select 1 from ${issueComments} old_input where ${heldPerson("old_input")}
      and not (${personMessageWithinSendWindowSql(sql`old_input.created_at`)}))
    and not exists (select 1 from ${issueComments} fresh_input where ${heldPerson("fresh_input")}
      and ${personMessageWithinSendWindowSql(sql`fresh_input.created_at`)}))`;
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
  return sql`(${expiredPersonInput} or (not ${personStopHold} and ${newerPersonInputAnsweredSql(w)}))`;
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
    or coalesce(${context}->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${commentId}::text
    or coalesce(${context}->'steeredCommentIds', '[]'::jsonb) ? ${commentId}::text))`;
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

/** The accepted result's own published reply (D3): identity, hash and finalization agree. */
const ACCEPTED_RESULT_PUBLISHED_SQL = sql`(r.result_json#>>'{presentationDecision,commentId}' = a.id::text
  and exists (select 1 from ${nativeRunResults} accepted
    where accepted.run_id = r.id and accepted.company_id = r.company_id and accepted.issue_id = a.issue_id
      and accepted.schema_status = 'accepted'
      and coalesce(r.result_json#>>'{nativeCommittedChatResponse,resultId}', accepted.id::text) = accepted.id::text
      and coalesce(r.result_json#>>'{nativeCommittedChatResponse,canonicalSha256}', accepted.canonical_sha256) = accepted.canonical_sha256
      and not exists (select 1 from ${nativeRunFinalizations} committed where committed.run_id = r.id
        and committed.company_id = r.company_id and committed.result_id is not null and committed.result_id <> accepted.id)))`;

/** A person message is answered by a published non-progress reply from a succeeded run (or its accepted result published),
 * an agent-posted pending card addressed to this input after its carry, or imported history with a posted reply.
 * A person's response to the card is new input, not the agent's reply: without a posted reply the original remains owed.
 * Shared by recovery input selection (continuation-comment-input.ts) and the
 * unanswered-person-message notice, so the carry and the notice never disagree on a message.
 * - Provider acceptance/delivery alone is NOT an answer.
 * - A run-less agent comment NEVER answers (RFL 20:22Z): the Muse external agent's task.comment and agent chat
 *   messages outside a run post them.
 * - Imported history requires an imported AGENT reply posted after the person input.
 *   Provenance is a PERSON comment marked origin='import' at insertion, regardless of its source timestamp.
 *   For legacy unmarked comments only, use the issue's import arrival record (issue.imported), or, for imports
 *   made before that record existed, the company's FIRST company.imported row on a company_import issue.
 *   With neither provenance nor an arrival record, nothing is history.
 */
export function answeredPersonMessageSql(m: PersonMessageSql): SQL {
  // RFL by-purpose ruling: a later person's input reaching the agent never
  // answers m. Every non-imported reply follows m's own durable carry chain.
  // A pending agent card must name this input and be posted after its carry;
  // a person's answer to a card is new input, not an agent's posted answer.
  // Half 1: a run-log acknowledgement is not a posted answer. All prose, including
  // steers, goes through this ONE published-reply arm and its success/progress gates.
  return sql`(exists (select 1 from ${issueComments} a
    join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and (r.status = 'succeeded' or ${ACCEPTED_RESULT_PUBLISHED_SQL})
      and a.created_at >= coalesce(r.started_at, r.created_at)
      and (not coalesce(r.context_snapshot->'steeredCommentIds', '[]'::jsonb) ? ${m.id}::text
        or a.created_at >= coalesce((r.context_snapshot->'steeredDeliveredAts'->>${m.id}::text)::timestamptz, ${m.createdAt}))
      and not exists (select 1 from jsonb_each(case when jsonb_typeof(r.result_json->'semanticToolReceipts') = 'object'
          then r.result_json->'semanticToolReceipts' else '{}'::jsonb end) receipt
        where receipt.value->>'operationId' = 'report_progress' and receipt.value->'result'->>'commentId' = a.id::text)
      -- A reply to a later person's input never answers this message merely
      -- because an earlier run reached it. Follow this message's own carry.
      and ${chainCarriesCommentSql("r", m.id, m)})
    or exists (select 1 from ${issueThreadInteractions} q
      join ${heartbeatRuns} r on r.id = q.source_run_id and r.company_id = q.company_id
      where q.company_id = ${m.companyId} and q.issue_id = ${m.issueId}
        and q.created_by_agent_id = r.agent_id
        and q.created_by_user_id is null and q.status = 'pending'
        and q.resolved_by_user_id is null
        and coalesce(q.origin_comment_ids, '[]'::jsonb) ? ${m.id}::text
        and q.created_at > ${m.createdAt}
        and q.created_at >= coalesce(r.started_at, r.created_at)
        and (not coalesce(r.context_snapshot->'steeredCommentIds', '[]'::jsonb) ? ${m.id}::text
          or q.created_at >= (r.context_snapshot->'steeredDeliveredAts'->>${m.id}::text)::timestamptz)
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
      -- The person moved past m only when a succeeded replying turn CLAIMED a newer person message (the
      -- stale rule's evidence, RFL 17:07Z); a turn that only revived work or answered a system wake does not
      -- (gate 7 888e5d1d, 11-19: '9 + 10' silently unanswered under the start clock).
      or not ${newerPersonInputAnsweredSql({ companyId: m.companyId, issueId: m.issueId, requestedAt: m.createdAt }, m.id)})
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
 * a system notice) by a run carrying the message, its addressed pending agent
 * card after carry, or imported history with a posted reply. Never a second
 * partial predicate.
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
    and exists (select 1 from ${issueComments} imported_reply
      where imported_reply.company_id = ${m.companyId} and imported_reply.issue_id = ${m.issueId}
        and imported_reply.author_type = 'agent' and imported_reply.deleted_at is null
        and imported_reply.origin = 'import' and imported_reply.created_at > ${m.createdAt})
    and case when p.origin = 'import' then true else ${m.createdAt} < coalesce(
      (select min(l.created_at) from ${activityLog} l where l.company_id = ${m.companyId}
        and l.action = ${ISSUE_IMPORTED_ACTION} and l.entity_type = 'issue' and l.entity_id = ${m.issueId}::text),
      (select min(c.created_at) from ${activityLog} c where c.company_id = ${m.companyId} and c.action = ${COMPANY_IMPORTED_ACTION}
        and c.entity_type = 'company' and c.entity_id = ${m.companyId}::text
        and exists (select 1 from ${issues} i where i.id = ${m.issueId} and i.company_id = ${m.companyId}
          and i.origin_kind = 'company_import'))) end)`;
}
