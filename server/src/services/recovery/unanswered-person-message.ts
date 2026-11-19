import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { answeredPersonMessageSql, messageCardEndedSinceSql, unansweredCardAnswerSql, UNANSWERED_MESSAGE_GROUP_KEY,
  UNANSWERED_MESSAGE_REASON_PREFIX } from "../person-message-answer.js";
export { UNANSWERED_MESSAGE_GROUP_KEY, UNANSWERED_MESSAGE_REASON_PREFIX };
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { issueService } from "../issues.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { logActivity } from "../activity-log.js";
import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import { isWellFormedExecutionWait, wellFormedExecutionWaitSql } from "../deferred-execution-wait.js";
import { HELD_PREDECESSOR_NOTICE } from "../native-runtime/held-predecessor-notice-text.js";
import { PROVIDER_POLICY_REFUSAL_CODE, PROVIDER_POLICY_REFUSAL_MESSAGE } from "../native-runtime/native-provider-failure.js";
import { readUnsupersededHeldConversationNotice } from "../native-runtime/pi-session-recovery-notice.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";
import { noticeMetadataReferencesRecoveryAction } from "./successful-run-handoff.js";
import { keyValueRow } from "./notice-format.js";
import { freshContinuationChain, freshContinuationDescendsFrom } from "../fresh-continuation-chain.js";
import { nativeStartupNeverConnectedExhausted } from "../continuation-cause.js";
import { isFreshThreadRefusal } from "../native-runtime/runner-reconciliation-refusal.js";
import { isNativeContinuationRefusal, isRecoverableNativeSupervisionFailure } from "../native-continuation-refusal.js";
import { REMOTE_RUNNER_SUPERVISION_EXHAUSTED, REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION } from "../native-runtime/remote-runner-recovery-diagnostics.js";
import { cardAnswerGivenBeforeStop, senderStoppedWhileAnswering, stoppedBySender } from "./person-stopped-message.js";

/**
 * The person's last message on an agent-owned task is a valid wait only when
 * the agent ANSWERED it, or when a visible notice tells the person that it was
 * not answered and what they can do (the conversation clause, in upstream's
 * meaning: assigned-work-invariant.ts counts a conversation as someone else's
 * move). When the run the message started ends with no answer and nothing
 * will try again by itself (no live run, no scheduled retry, no queued wake,
 * no native retry pending), the stranded-work sweep posts exactly one notice
 * for that message, built by the stranded-recovery escalation builder. The
 * person-facing text is plain words; the allowlisted failure code is in the
 * notice metadata (Run evidence), never in the text. A later answer
 * supersedes the notice.
 *
 * Smarty fork, TEMPORARY until upstream #21135/#21139 (fresh-continuation
 * fallback and assigned-work invariant) are merged down and their
 * conversation clause covers it.
 */
/** A transient-retry line for the same message (heartbeat retries) is superseded the same way. */
const RETRYING_MESSAGE_REASON_PREFIX = "retrying_message:";
export const UNANSWERED_MESSAGE_LOOKBACK_MS = 24 * 60 * 60_000;
/** The native blocked-request repair publishes on the sweep pass after its run
 * ends. Deferring to it is bounded by this fixed time after the run's durable
 * finish (D4 visibility); after it, this step posts the message's notice. */
export const NATIVE_REPAIR_PUBLISH_BOUND_MS = 2 * 60_000;
/** After the run ends, retries and recovery are scheduled; let them land first. */
export const UNANSWERED_MESSAGE_SETTLE_MS = 15_000;
/** A saved message that no run took (its wake failed or is held). */
export const UNANSWERED_MESSAGE_NO_RUN_GRACE_MS = 120_000;
/** A native same-run retry that is this late is not going to start by itself. */
const OVERDUE_NATIVE_RETRY_MS = 5 * 60_000;

/** Earlier owed messages settled per task per pass; discovery keeps flagging the task until none is left. */
const EARLIER_OWED_PER_PASS = 20;

export const UNANSWERED_MESSAGE_NO_REPLY_CODE = "no_reply";
export const UNANSWERED_MESSAGE_NO_RUN_CODE = "no_run";
export const UNANSWERED_MESSAGE_UNCLASSIFIED_CODE = "unclassified_failure";
/** The non-failure marker row of a waiting-kind note (no "Failure code" row).
 * A legacy "waiting to start" note (Waiting code waiting_to_start) still
 * carries it and is replaced in place by the no-run text at the bound. */
const WAITING_ROW_LABEL = "Waiting code";
const WAITING_ROW_JSON = JSON.stringify([{ rows: [{ label: WAITING_ROW_LABEL }] }]);
/** The agent that answers the conversation is paused (or held) and will not
 * run until it is resumed. Not a failure: a waiting-kind note. */
export const UNANSWERED_MESSAGE_AGENT_PAUSED_CODE = "agent_paused";
/** Setup completes by itself; a stalled setup gets one factual waiting note. */
export const UNANSWERED_MESSAGE_AGENT_SETUP_CODE = "agent_setup";
// Preserve the sweep's existing start bound as the one shared ten-minute value.
export { PENDING_WAIT_START_BOUND_MS } from "../deferred-execution-wait.js";
import { PENDING_WAIT_START_BOUND_MS } from "../deferred-execution-wait.js";
export const SETUP_WAIT_BOUND_MS = PENDING_WAIT_START_BOUND_MS;
const WAITING_KIND_CODES = new Set(["agent_paused", UNANSWERED_MESSAGE_AGENT_SETUP_CODE]);
/** Paperclip's pause model: POST /agents/:id/resume is allowed for a board user
 * or an agent that manages the paused agent (routes/agents.ts:6017-6023 ->
 * assertCanManageAgentLifecycle :2613-2623 -> agent-subtree-management.ts:34-39
 * assertAgentLifecycleAuthority / assertCanManageSubordinateAgent). */
export function agentPausedText(name: string) {
  return `${name} is paused. Your message is saved, and it will run when ${name} is resumed. `
    + `A board user or ${name}'s manager can resume ${name}.`;
}

export const UNANSWERED_MESSAGE_TEXT =
  "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.";
export const UNANSWERED_MESSAGE_NO_RUN_TEXT =
  "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
export const UNANSWERED_MESSAGE_NO_REPLY_TEXT =
  "This run finished without a reply to your message. Sending it again is safe.";
/** The CARD-ANSWER DUTY's words (RFL ruling 4): the same three outcomes as for a typed message, with "your answer"
 * in place of "your message". The failed-run line is bb/tamin6's (5cddd3d1 unanswered-person-message.ts:111-112). */
export const UNANSWERED_CARD_ANSWER_TEXT =
  "Your answer wasn't acted on: the run that picked it up failed. Retry is safe; if it fails again, assign this agent a new task.";
export const UNANSWERED_CARD_ANSWER_NO_RUN_TEXT =
  "Your answer is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
export const UNANSWERED_CARD_ANSWER_NO_REPLY_TEXT =
  "This run finished without a reply to your answer. Sending it again is safe.";
/** The ONE bound (follow-Paperclip B-2, RFL 05:51Z): the fork's K=2 fresh-continuation chain cap. */
export const FRESH_CONTINUATION_BOUND = 2;
export const UNANSWERED_MESSAGE_BOUND_REACHED_TEXT = "Paperclip tried to continue this task twice from its saved work, "
  + "and both attempts failed. Your message and the saved work are kept. Send a new message to try again.";

// Codes the notice metadata may name. A run's error is reduced to its leading
// code token; anything not listed is unclassified_failure, never raw text.
const SHOWN_CODES = new Set([
  PROVIDER_POLICY_REFUSAL_CODE,
  "adapter_failed", "cancelled", "timeout", "timed_out", "interrupted", "process_lost", "setup_failed",
  "native_controller_recovery_missing_evidence", "native_controller_recovery_dependency_unavailable",
  "native_controller_recovery_unsupported", "native_controller_recovery_wait_authority_changed",
  "native_controller_recovery_metadata_too_large", "native_session_cleanup_quarantined",
  "runner_process_termination_unconfirmed", REMOTE_RUNNER_SUPERVISION_EXHAUSTED, "native_runner_warm_attachment_runner_exited",
  "runner_state_identity_mismatch", "runner_harness_state_mismatch", "runner_state_directory_unsafe", "runner_state_too_large",
  "runner_durable_identity_too_large", "recovery_state_too_large", "unsafe_recovery_state",
  "native_runner_checkpoint_missing", "native_runner_checkpoint_binding_mismatch", "native_runner_checkpoint_invalid",
  "native_runner_checkpoint_projection_held", "native_runner_checkpoint_missing_after_sandbox_retirement",
  "native_runner_checkpoint_missing_after_suspension", "native_sandbox_cold_resume_unproven", "native_runner_reuse_unavailable",
  "native_session_supervisor_checkpoint_mismatch", "native_session_supervisor_checkpoint_too_large",
  "native_session_released_owner_scope_mismatch", "native_session_released_source_mismatch",
  "native_session_released_detach_unavailable", "native_runner_warm_transition_recovery_unproven",
  "native_runner_staged_attachment_binding_mismatch", "native_runner_staged_attachment_recovery_unproven",
  "native_runner_staged_attachment_source_unsettled", "native_runner_staged_attachment_source_retiring",
  "native_runner_staged_attachment_profile_unsupported", "native_plugin_recovery_lease_mismatch",
  "native_crash_inventory_unproven", "native_controller_migration_tool_contract_missing",
  "native_session_supervisor_busy", "native_session_lease_lost", "native_session_startup_owner_missing",
  "native_session_renewal_owner_missing", "native_restart_startup_not_ready", "native_attachment_admission_changed",
  "native_execution_binding_changed", "native_restart_recovery_claim_changed", "native_replacement_lineage_invalid",
  "native_finalization_coordinator_missing", "native_session_retry_exhausted", "native_session_interrupted",
  "native_continuation_requires_reconciliation",
  "native_workspace_required", "pi_conversation_identity_missing", "native_state_file_changed",
  "native_tool_authority_epoch_revoked", "native_usage_run_binding_mismatch", "native_recovery_usage_source_unproven",
  "native_instruction_preparation_configuration_changed", "native_instruction_materialization_not_claimed",
  "native_instruction_preparation_copy_changed", "native_instruction_materialization_handoff_unavailable",
  "native_instruction_materialization_handoff_mismatch", "paperclip_runner_provider_unsupported",
  "paperclip_runner_antigravity_candidate_ineligible", "paperclip_runner_kimi_candidate_ineligible",
  "dot_cloud_requires_managed_runner", "muse_cloud_requires_managed_runner",
  "native_session_checkpoint_binding_mismatch", "native_session_attach_binding_mismatch",
  "native_governed_wait_checkpoint_mismatch", "native_governed_wait_replay_mismatch", "native_governed_wait_trigger_unproven",
  "native_governed_wait_turn_mismatch", "native_event_replay_conflict", "native_session_recovery_failed",
  "native_recovery_replay_did_not_advance", "native_disposition_recovery_checkpoint_conflict",
  "native_execution_startup_expired", "native_runtime_context_unsupported", "native_session_multi_run_unavailable",
  "native_session_goal_unavailable", "native_session_goal_not_found", "native_context_compaction_unavailable",
  "native_execution_ownership_unverified", "native_controller_detached_for_restart", "native_provider_terminal_failed",
  "native_provider_model_rejected", "native_provider_approval_required", "native_provider_usage_limit",
  "native_provider_runtime_missing", "native_permission_declined", "native_runner_process_exited",
  "runner_ingress_acquisition_failed", "runner_ingress_access_rejected", "runner_ingress_startup_failed", "runner_task_admission_rejected",
  "runner_remote_provider_artifact_incompatible", "runner_remote_provider_verification_unavailable",
  "provider_process_exited", "provider_initialize_timeout", "provider_request_timeout", "provider_transport_failed",
  "provider_session_open_rejected", "provider_session_open_timeout",
]);

// Refusals a new message meets the same way: the held text, not "send it again".
const HELD_CODES = new Set([
  "runner_state_identity_mismatch", "native_controller_recovery_missing_evidence",
  "native_controller_recovery_dependency_unavailable", "native_controller_recovery_unsupported",
  "native_session_cleanup_quarantined", "runner_process_termination_unconfirmed",
  "native_runner_warm_attachment_runner_exited", "native_runner_checkpoint_missing", "native_runner_checkpoint_binding_mismatch",
  "native_runner_checkpoint_invalid", "native_runner_checkpoint_missing_after_sandbox_retirement",
  "native_runner_checkpoint_missing_after_suspension", "native_sandbox_cold_resume_unproven",
  "native_session_supervisor_checkpoint_mismatch", "native_runner_warm_transition_recovery_unproven",
  "native_runner_staged_attachment_binding_mismatch", "native_runner_staged_attachment_recovery_unproven",
  "native_event_replay_conflict", "native_execution_ownership_unverified", "runner_state_directory_unsafe",
  "runner_state_too_large", "runner_durable_identity_too_large", "recovery_state_too_large",
  "native_session_supervisor_checkpoint_too_large", "pi_conversation_identity_missing",
]);

const GENERIC_RUN_CODES = new Set(["adapter_failed", "setup_failed"]);
const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const LIVE = ["queued", "running", "scheduled_retry"];
const NATIVE_PENDING_PHASES = ["result_persisted", "ready_for_assessment", "arbitrating", "workspace_pending"];

/** The code for a run: the error's leading code token when it is a shown
 * code, else a specific errorCode, else the generic run code. */
export function unansweredMessageCode(run: { status: string; error: string | null; errorCode: string | null }): string {
  // Old releases saved the supervision outcome in either field, sometimes
  // behind Notification's wrapper. Keep its named remedy at this consumer.
  if ([run.error, run.errorCode].some(value => typeof value === "string" && isRecoverableNativeSupervisionFailure(value))) {
    return REMOTE_RUNNER_SUPERVISION_EXHAUSTED;
  }
  const token = /^(?:Error:\s*)?([a-z][a-z0-9_]{2,100})(?=$|[:;\s])/.exec(run.error?.trim() ?? "")?.[1];
  if (token && SHOWN_CODES.has(token)) return token;
  if (run.errorCode && !GENERIC_RUN_CODES.has(run.errorCode)) {
    return SHOWN_CODES.has(run.errorCode) ? run.errorCode : UNANSWERED_MESSAGE_UNCLASSIFIED_CODE;
  }
  if (run.status === "cancelled") return "cancelled";
  if (run.status === "timed_out") return "timed_out";
  if (run.status === "interrupted") return "interrupted";
  if (token) return UNANSWERED_MESSAGE_UNCLASSIFIED_CODE;
  return run.errorCode && SHOWN_CODES.has(run.errorCode) ? run.errorCode : UNANSWERED_MESSAGE_UNCLASSIFIED_CODE;
}

const reasonOf = (column: AnyPgColumn) => sql<string>`${column}->>'authorizationReason'`;

/**
 * SQL: message m is ANSWERED, by the one shared rule (person-message-answer.ts):
 * a reply after m from a run that SUCCEEDED and whose OWN input names m, via
 * any carrying key; or an ANSWERABLE card that run posted for m (RFL rulings 2, 3);
 * or m is imported history. A reply from a failed, cancelled,
 * timed-out or interrupted run, a reply to a LATER message, a progress comment
 * and an agent comment with no run never answer m.
 */
function answeredSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  // The ONE shared definition (person-message-answer.ts), so B's notice and the continuation carry never
  // disagree on a message (RFL 20:22Z: run-less agent comments never answer; org 20:29Z: imported history).
  return answeredPersonMessageSql(m);
}
// UNANSWERED_MESSAGE_GROUP_KEY (defined beside the one function, person-message-answer.ts) is the key of a notice's
// still-owed member list: one notice covers one owed GROUP (the person messages one failed or reply-less run carried
// in its own input, or one no-run batch settled in the same pass). Its authorizationReason names the latest
// still-owed member; a group of one has no list.
/** SQL: notice row n (alias) covers message id: its key names it, or its still-owed member list does. */
const noticeCoversSql = (n: string, id: SQL) => sql`(substr(${sql.raw(n)}.metadata->>'authorizationReason',
    strpos(${sql.raw(n)}.metadata->>'authorizationReason', ':') + 1) = ${id}::text
  or coalesce(${sql.raw(n)}.metadata->${sql.raw(`'${UNANSWERED_MESSAGE_GROUP_KEY}'`)}, '[]'::jsonb) ? ${id}::text)`;
/** SQL: notice row n (alias) still stands as message m's notice (NOTICE_REOWED_AFTER_CARD, am5 gap 17): it is live,
 * or it was retired and m has not been owed AGAIN since by a card that stopped being answerable (ruling 3). A notice
 * retired while a card answered m must not keep m silent after that card expired. */
const noticeStandsSql = (n: string, m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }) =>
  sql`(${sql.raw(n)}.deleted_at is null or not ${messageCardEndedSinceSql(m, sql`${sql.raw(n)}.deleted_at`)})`;
const rawMessage = (alias: string) => ({ id: sql.raw(`${alias}.id`), companyId: sql.raw(`${alias}.company_id`),
  issueId: sql.raw(`${alias}.issue_id`), createdAt: sql.raw(`${alias}.created_at`) });

/**
 * SQL: message m is still in scope. It is within the lookback, or its own
 * obligation saw durable activity within it: a run that carries it finished,
 * or a wake for it changed. An obligation that is still open never ages out
 * silently because the message itself is old.
 */
function inScopeSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }, since: string): SQL {
  return sql`(${m.createdAt} > ${since}::timestamptz
    or exists (select 1 from ${heartbeatRuns} r where r.company_id = ${m.companyId} and r.native_issue_id = ${m.issueId}
      and coalesce(r.finished_at, r.updated_at) > ${since}::timestamptz
      and (r.context_snapshot->>'wakeCommentId' = ${m.id}::text or r.context_snapshot->>'commentId' = ${m.id}::text
        or r.context_snapshot->>'conversationReplyBoundaryCommentId' = ${m.id}::text
        or coalesce(r.context_snapshot->'attributionCommentIds', '[]'::jsonb) ? ${m.id}::text
        or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text
        or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${m.id}::text))
    or exists (select 1 from ${agentWakeupRequests} w where w.company_id = ${m.companyId} and w.updated_at > ${since}::timestamptz
      and (w.payload->>'commentId' = ${m.id}::text
        or w.payload->'_paperclipWakeContext'->>'wakeCommentId' = ${m.id}::text
        or coalesce(w.payload->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text)))`;
}

/** SQL over an issue_thread_interactions alias: a person's card answer the task OWES (unansweredCardAnswerSql, the
 * one function with the card answer as the input), given after every typed message: a newer typed message is the
 * owed input instead (as on bb/tamin6 unanswered-person-message.ts:310-321). */
function owedCardAnswerSql(alias: string, now: Date): SQL {
  const ca = sql.raw(alias);
  return sql`(${unansweredCardAnswerSql(alias, now)}
    and not exists (select 1 from ${issueComments} later where later.company_id = ${ca}.company_id
      and later.issue_id = ${ca}.issue_id and later.author_type = 'user' and later.deleted_at is null
      and later.created_at > ${ca}.resolved_at))`;
}
/** SQL over an issue_thread_interactions alias: an owed card answer in the lookback that has no notice yet. */
function unnoticedOwedCardAnswerSql(alias: string, now: Date): SQL {
  const ca = sql.raw(alias);
  const since = new Date(now.getTime() - UNANSWERED_MESSAGE_LOOKBACK_MS).toISOString();
  return sql`(${ca}.resolved_at > ${since}::timestamptz and ${owedCardAnswerSql(alias, now)}
    and not exists (select 1 from ${issueComments} n where n.company_id = ${ca}.company_id and n.issue_id = ${ca}.issue_id
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}) and ${noticeCoversSql("n", sql`${ca}.id`)}
      and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))`;
}
/** SQL: notice row n (alias) covers a person's card answer that the one function now says is answered. */
function noticeCoversAnsweredCardSql(n: string): SQL {
  return sql`exists (select 1 from ${issueThreadInteractions} ca where ca.company_id = ${sql.raw(n)}.company_id
    and ca.issue_id = ${sql.raw(n)}.issue_id and ca.resolved_at is not null and ${noticeCoversSql(n, sql.raw("ca.id"))}
    and ${answeredSql({ id: sql.raw("ca.id"), companyId: sql.raw("ca.company_id"), issueId: sql.raw("ca.issue_id"),
      createdAt: sql.raw("ca.resolved_at") })})`;
}
/** SQL: notice row n (alias) is a CARD-ANSWER notice: its key (authorizationReason, after the prefix) names a card
 * of this task. The sweep never puts a card answer and a typed message in one notice (decideUnansweredMessage
 * keys a card answer's group `card_answer:<run>`, a message's `<run>`), so the key's family is the notice's family. */
function noticeKeyIsCardSql(n: string): SQL {
  const notice = sql.raw(n);
  return sql`exists (select 1 from ${issueThreadInteractions} key_card where key_card.company_id = ${notice}.company_id
    and key_card.issue_id = ${notice}.issue_id
    and key_card.id::text = substr(${notice}.metadata->>'authorizationReason', strpos(${notice}.metadata->>'authorizationReason', ':') + 1))`;
}
/** SQL (a derived table): EVERY person input notice row n (alias) covers, each with the one function's verdict.
 * ONE family per notice, the one its key names (noticeKeyIsCardSql): a message notice's members are the typed
 * messages (comments) its key or member list names, a card-answer notice's members are the card answers (the
 * card's id, at its answer time). Retirement and the group shrink read it for every notice family (failed run, no
 * run, no reply, waiting note, card answer), so an answer of a card-answer group is a member like a message of a
 * message group: never retired or dropped with another's answer. There is NO mixed typed+card membership (rf-5
 * merged8 F1, cut in merged9): no producer writes such a notice, and an id of the other family in a notice's list
 * is not a member. */
function noticeInputsSql(n: string): SQL {
  const notice = sql.raw(n);
  return sql`(select m.id, m.created_at as input_at, ${answeredSql(rawMessage("m"))} as answered from ${issueComments} m
      where m.company_id = ${notice}.company_id and m.issue_id = ${notice}.issue_id and ${noticeCoversSql(n, sql.raw("m.id"))}
        and not ${noticeKeyIsCardSql(n)}
    union all
    select ca.id, ca.resolved_at as input_at, ${answeredSql({ id: sql.raw("ca.id"), companyId: sql.raw("ca.company_id"),
        issueId: sql.raw("ca.issue_id"), createdAt: sql.raw("ca.resolved_at") })} as answered from ${issueThreadInteractions} ca
      where ca.company_id = ${notice}.company_id and ca.issue_id = ${notice}.issue_id and ca.resolved_at is not null
        and ${noticeCoversSql(n, sql.raw("ca.id"))} and ${noticeKeyIsCardSql(n)})`;
}
/** SQL over issue_thread_interactions rows (the outer table): an owed card answer with no notice yet. The recovery
 * worker reads it with one batched query per page, beside unansweredPersonMessageCommentCondition's (work.ts). */
export function owedCardAnswerInteractionCondition(now: Date = new Date()): SQL {
  return unnoticedOwedCardAnswerSql("issue_thread_interactions", now);
}

/**
 * SQL: this issue row has a person's message within the lookback that no agent
 * answered and that has no notice yet, or an unanswered-message notice that a
 * later agent comment answered. The stranded sweep visits such tasks in every
 * open status, including blocked.
 */
export function unansweredPersonMessageCondition(issueId: AnyPgColumn, companyId: AnyPgColumn): SQL {
  const since = new Date(Date.now() - UNANSWERED_MESSAGE_LOOKBACK_MS).toISOString();
  return sql`(exists (select 1 from ${issueComments} m
      where m.company_id = ${companyId} and m.issue_id = ${issueId} and m.author_type = 'user'
        and m.deleted_at is null and ${inScopeSql(rawMessage("m"), since)}
        and not ${answeredSql(rawMessage("m"))}
        and not exists (select 1 from ${issueComments} n where n.company_id = m.company_id and n.issue_id = m.issue_id
          and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}) and ${noticeCoversSql("n", sql.raw("m.id"))}
          and ${noticeStandsSql("n", rawMessage("m"))}
          and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or exists (select 1 from ${issueComments} n
      join ${issueComments} m on m.company_id = n.company_id and m.issue_id = n.issue_id and ${noticeCoversSql("n", sql.raw("m.id"))}
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and ${answeredSql(rawMessage("m"))})
    or exists (select 1 from ${issueThreadInteractions} owed_card where owed_card.company_id = ${companyId}
      and owed_card.issue_id = ${issueId} and ${unnoticedOwedCardAnswerSql("owed_card", new Date())})
    or exists (select 1 from ${issueComments} n where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and ${noticeCoversAnsweredCardSql("n")}))`;
}

/** SQL: this issue row has a LIVE unanswered-message notice (any family) with an input the one function now says is
 * answered: the notice is due to RETIRE (every input answered) or, a group notice, to SHRINK to its still-owed
 * members. It holds on ANY task status: the recovery worker's page query also loads a task that is done or
 * cancelled while this is true, so the notice never stays false on a finished task (RETIRE_ON_ANY_STATUS, P9-60).
 * After the worker's pass it is false again (retired, or no answered member left), so the task is not reloaded. */
export function answeredNoticeToRetireCondition(issueId: AnyPgColumn, companyId: AnyPgColumn): SQL {
  return sql`exists (select 1 from ${issueComments} n where n.company_id = ${companyId} and n.issue_id = ${issueId}
    and n.author_type = 'system' and n.deleted_at is null
    and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
    and exists (select 1 from ${noticeInputsSql("n")} covered where covered.answered))`;
}

/**
 * SQL over issue_comments rows (the outer table): a person's message within the
 * lookback that no agent answered and that has no notice yet, or a live
 * unanswered-message notice whose message an agent has since answered. The
 * recovery worker runs ONE batched query with it per page of visited tasks.
 */
export function unansweredPersonMessageCommentCondition(): SQL {
  const since = new Date(Date.now() - UNANSWERED_MESSAGE_LOOKBACK_MS).toISOString();
  return sql`((${issueComments.authorType} = 'user' and ${issueComments.deletedAt} is null
      and ${inScopeSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }, since)}
      and not ${answeredSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}
      and not exists (select 1 from ${issueComments} n where n.company_id = ${issueComments.companyId}
        and n.issue_id = ${issueComments.issueId}
        and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}) and ${noticeCoversSql("n", sql`${issueComments.id}`)}
        and ${noticeStandsSql("n", { id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
          issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}
        and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or (${issueComments.authorType} = 'system' and ${issueComments.deletedAt} is null
      and starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and (exists (select 1 from ${issueComments} m
        where m.company_id = ${issueComments.companyId} and m.issue_id = ${issueComments.issueId}
          and ${noticeCoversSql(`"issue_comments"`, sql.raw("m.id"))}
          and ${answeredSql(rawMessage("m"))})
        or ${noticeCoversAnsweredCardSql(`"issue_comments"`)})))`;
}

export type UnansweredMessageOutcome =
  | { kind: "none" | "answered" | "noticed_before" | "explained" | "out_of_scope" | "person_stopped" }
  | { kind: "pending"; recheckAt: number }
  | { kind: "noticed"; code: string; commentId: string };

function runCarriesMessage(contextSnapshot: unknown, messageId: string): boolean {
  const context = (contextSnapshot ?? {}) as Record<string, unknown>;
  // A comment that arrived while the run prepared is delivered as its first-turn
  // input (first-turn-queued-input.ts; queued-comment-delivery.ts:21-60): that
  // run carries it, and its deferred wake is cancelled as delivered.
  const firstTurn = (context.firstTurnQueuedInput ?? {}) as Record<string, unknown>;
  const ids = [
    ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
    ...(Array.isArray(firstTurn.commentIds) ? firstTurn.commentIds : []),
    context.wakeCommentId, context.commentId, context.conversationReplyBoundaryCommentId,
    // The native-status continuation's attribution-only typed ids (status-decision-committer.ts).
    ...(Array.isArray(context.attributionCommentIds) ? context.attributionCommentIds : []),
    // A person's card answer is the run's own input too: the answer-resume run's interactionId, a carry's interactionIds.
    context.interactionId, ...(Array.isArray(context.interactionIds) ? context.interactionIds : []),
    ...(Array.isArray(context.attributionInteractionIds) ? context.attributionInteractionIds : []),
  ];
  return ids.includes(messageId);
}

function wakeCarriesMessage(payload: unknown, messageId: string): boolean {
  const value = (payload ?? {}) as Record<string, unknown>;
  const nested = (value._paperclipWakeContext ?? {}) as Record<string, unknown>;
  return [...queuedCommentIdsFromWakePayload(value), value.commentId, nested.wakeCommentId,
    ...(Array.isArray(nested.wakeCommentIds) ? nested.wakeCommentIds : [])].includes(messageId);
}

/** The wake the real answer route leaves for a person's card answer (routes/issues.ts respond ->
 * question-response delivery's wake fallback): its payload and wake context name the card as interactionId. */
function wakeCarriesCardAnswer(payload: unknown, cardId: string): boolean {
  const value = (payload ?? {}) as Record<string, unknown>;
  const nested = (value._paperclipWakeContext ?? {}) as Record<string, unknown>;
  return [value.interactionId, nested.interactionId,
    ...(Array.isArray(nested.interactionIds) ? nested.interactionIds : [])].includes(cardId);
}

function wakeCarriesIssue(payload: unknown, issueId: string): boolean {
  const value = (payload ?? {}) as Record<string, unknown>;
  const nested = (value._paperclipWakeContext ?? {}) as Record<string, unknown>;
  return value.issueId === issueId || nested.issueId === issueId || value.taskId === issueId;
}

/** One task: answer, supersede or notice its person's last message. Idempotent. */
/** The recovery service's own native blocked-request repair check (it publishes
 * the run's unblock request itself when it applies). */
export type NativeBlockedRepairApplies = (input: { companyId: string; issueId: string; runId: string }, database: Db) => Promise<boolean>;

export async function settleUnansweredPersonMessage(
  db: Db,
  input: { companyId: string; issueId: string; now?: Date; issueCreatedAtGte?: Date | null;
    nativeBlockedRepairApplies?: NativeBlockedRepairApplies },
): Promise<UnansweredMessageOutcome> {
  // One outcome for the task: the latest message's, unless only an earlier owed message was noticed or still waits.
  const outcomes = await settleOwedPersonMessages(db, input);
  const last = outcomes[outcomes.length - 1];
  return last.kind === "noticed" ? last : outcomes.find(outcome => outcome.kind === "noticed")
    ?? outcomes.filter((outcome): outcome is { kind: "pending"; recheckAt: number } => outcome.kind === "pending")
      .sort((a, b) => a.recheckAt - b.recheckAt)[0] ?? last;
}

/** Retire every live notice whose inputs are ALL answered; shrink a group notice with an answered member and a
 * still-owed one to the still-owed (it STAYS and stays true). No task-status or cutoff condition. */
async function retireAnsweredNotices(db: Db, issue: { id: string; companyId: string }, now: Date): Promise<void> {
  const [liveNotice] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    or(sql`starts_with(${reasonOf(issueComments.metadata)}, ${UNANSWERED_MESSAGE_REASON_PREFIX})`,
      sql`starts_with(${reasonOf(issueComments.metadata)}, ${RETRYING_MESSAGE_REASON_PREFIX})`))).limit(1);
  if (!liveNotice) return;
  await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    await tx.execute(sql`update ${issueComments} n set deleted_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
    where n.company_id = ${issue.companyId} and n.issue_id = ${issue.id} and n.author_type = 'system' and n.deleted_at is null
      and (starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
        or starts_with(n.metadata->>'authorizationReason', ${RETRYING_MESSAGE_REASON_PREFIX}))
      and exists (select 1 from ${noticeInputsSql("n")} covered where covered.answered)
      and not exists (select 1 from ${noticeInputsSql("n")} covered where not covered.answered)`);
    // A group notice with an answered member and a still-owed one STAYS and stays true: it names only the still-owed.
    await tx.execute(sql`update ${issueComments} n set updated_at = ${now.toISOString()}::timestamptz,
      metadata = n.metadata || (select jsonb_build_object(${UNANSWERED_MESSAGE_GROUP_KEY}::text, jsonb_agg(covered.id::text order by covered.input_at, covered.id),
          'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}::text || (array_agg(covered.id::text order by covered.input_at desc, covered.id desc))[1])
        from ${noticeInputsSql("n")} covered where not covered.answered)
    where n.company_id = ${issue.companyId} and n.issue_id = ${issue.id} and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}) and n.metadata ? ${UNANSWERED_MESSAGE_GROUP_KEY}::text
      and exists (select 1 from ${noticeInputsSql("n")} covered where covered.answered)
      and exists (select 1 from ${noticeInputsSql("n")} covered where not covered.answered)`);
  });
}

/** The task's owed set, one entry per message (the joint rule): every earlier person message discovery flags
 * (unansweredPersonMessageCommentCondition: in scope, unanswered by the one function, no notice yet), oldest
 * first, then the latest message LAST. Each gets its own decision; each owed GROUP gets ONE notice. */
async function settleOwedPersonMessages(
  db: Db,
  input: { companyId: string; issueId: string; now?: Date; issueCreatedAtGte?: Date | null;
    nativeBlockedRepairApplies?: NativeBlockedRepairApplies },
): Promise<UnansweredMessageOutcome[]> {
  const now = input.now ?? new Date();
  const [issue] = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status, hiddenAt: issues.hiddenAt,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt,
  }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue) return [{ kind: "none" }];
  // An answer to an input supersedes that input's notice (and its retrying line): the relation is input -> answer,
  // not the notice's time. RETIRE_ON_ANY_STATUS: this runs FIRST, on every task status (done and cancelled too) and
  // before the worktree execution cutoff below, which decides only what may be NOTICED: a notice that is already
  // on the thread must never stay false. Every family retires here: the inputs are the notice's messages AND card
  // answers (noticeInputsSql). Written under the same issue fence, in the same order (issue row, then its
  // comments) as the notice writers.
  await retireAnsweredNotices(db, issue, now);
  if (input.issueCreatedAtGte && issue.createdAt < input.issueCreatedAtGte) return [{ kind: "out_of_scope" }];
  // Nothing is noticed on a finished task (decideUnansweredMessage): the retirement above was its whole step.
  if (["done", "cancelled"].includes(issue.status)) return [{ kind: "out_of_scope" }];

  const earlierOwed = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id), eq(issueComments.authorType, "user"),
    unansweredPersonMessageCommentCondition(),
    sql`${issueComments.id} <> (select l.id from ${issueComments} l where l.company_id = ${issue.companyId} and l.issue_id = ${issue.id}
      and l.author_type = 'user' and l.deleted_at is null order by l.created_at desc, l.id desc limit 1)`))
    .orderBy(issueComments.createdAt, issueComments.id).limit(EARLIER_OWED_PER_PASS);
  // Decide every owed message, then ONE notice per owed GROUP: the members share the run that carried them (or
  // have no run, this pass), the code and the standing note to replace. Never two notices for one message.
  const outcomes: UnansweredMessageOutcome[] = [];
  // The CARD-ANSWER DUTY (RFL ruling 4): a person's answer to a card is owed input too, decided by the SAME
  // decision after the task's latest typed message (it is owed only when it is the person's newest input).
  const owedCardAnswers = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
    owedCardAnswerInteractionCondition(now))).orderBy(issueThreadInteractions.resolvedAt, issueThreadInteractions.id).limit(5);
  const groups = new Map<string, Array<{ index: number; messageId: string | undefined; cardAnswerId?: string; decision: NoticeDecision }>>();
  for (const owed of [...earlierOwed.map(row => ({ messageId: row.id as string | undefined, cardAnswerId: undefined as string | undefined })),
    { messageId: undefined, cardAnswerId: undefined }, ...owedCardAnswers.map(row => ({ messageId: undefined, cardAnswerId: row.id }))]) {
    const { messageId, cardAnswerId } = owed;
    const decision = await decideUnansweredMessage(db, issue, now, input.nativeBlockedRepairApplies, messageId, cardAnswerId);
    if ((decision.kind === "pending" || decision.kind === "notice") && decision.recordWait) {
      await logActivity(db, { companyId: issue.companyId, actorType: "system", actorId: "recovery",
        action: PENDING_WAIT_ACTION, entityType: "issue", entityId: issue.id, issueId: issue.id,
        details: { boundMs: PENDING_WAIT_BOUND_MS, ...decision.recordWait } });
    }
    if (decision.kind === "notice") {
      groups.set(groupKey(decision), [...(groups.get(groupKey(decision)) ?? []), { index: outcomes.length, messageId, cardAnswerId, decision }]);
      outcomes.push({ kind: "noticed_before" });
    } else outcomes.push(await recordPendingDecision(db, issue, decision, now, input.nativeBlockedRepairApplies));
  }
  for (const members of [...groups.values()].reverse()) { // the latest message's group first
    const outcome = await writeGroupNotice(db, issue, now, input.nativeBlockedRepairApplies, members);
    for (const member of members) outcomes[member.index] = outcome;
  }
  return outcomes;
}

const groupKey = (decision: NoticeDecision) => `${decision.group}|${decision.code}|${decision.upgradeCommentId ?? ""}`;

/** A decision that writes no notice: record a first deferral (T0) when it asks for it. */
async function recordPendingDecision(db: Db, issue: DecisionIssue, decision: Exclude<Decision, NoticeDecision>, now: Date,
  nativeBlockedRepairApplies?: NativeBlockedRepairApplies): Promise<UnansweredMessageOutcome> {
  if (decision.kind === "pending") {
    if (decision.recordDeferral) {
      await appendHeartbeatRunEvent(db, { companyId: issue.companyId, runId: decision.recordDeferral.runId,
        agentId: decision.recordDeferral.agentId, eventType: NATIVE_REPAIR_DEFERRAL_EVENT, stream: "system", level: "info",
        message: "The unanswered-message notice waits for the native blocked-request repair to publish.",
        payload: { messageId: decision.recordDeferral.messageId, boundMs: NATIVE_REPAIR_PUBLISH_BOUND_MS } });
    }
    return { kind: "pending", recheckAt: decision.recheckAt };
  }
  if (decision.kind === "person_stopped") {
    // The sender's own Stop is the one note (ruling 8): a standing notice stops covering this message, under the
    // same issue fence and predicate. It retires when it covered only this message; else it keeps the others.
    if (decision.noticeId) await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
      const fenced = await decideUnansweredMessage(tx as unknown as Db, issue, now, nativeBlockedRepairApplies,
        decision.cardAnswerId ? undefined : decision.messageId, decision.cardAnswerId);
      if (fenced.kind !== "person_stopped" || fenced.noticeId !== decision.noticeId) return;
      const [notice] = await tx.select({ metadata: issueComments.metadata }).from(issueComments).where(and(
        eq(issueComments.id, decision.noticeId!), eq(issueComments.companyId, issue.companyId),
        eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
      if (!notice) return;
      const metadata = (notice.metadata ?? {}) as Record<string, unknown>;
      const listed = metadata[UNANSWERED_MESSAGE_GROUP_KEY];
      const others = (Array.isArray(listed) ? listed as string[] : []).filter(id => id !== decision.messageId);
      await tx.update(issueComments).set(others.length ? { updatedAt: now, metadata: { ...metadata,
        [UNANSWERED_MESSAGE_GROUP_KEY]: others, authorizationReason: `${UNANSWERED_MESSAGE_REASON_PREFIX}${others[others.length - 1]}` } as never }
        : { deletedAt: now, updatedAt: now }).where(eq(issueComments.id, decision.noticeId!));
    });
    return { kind: "person_stopped" };
  }
  return decision;
}

/** One owed group: write its ONE notice under the fence, keyed to its latest member that is still to be noticed. */
async function writeGroupNotice(db: Db, issue: DecisionIssue, now: Date, nativeBlockedRepairApplies: NativeBlockedRepairApplies | undefined,
  members: Array<{ messageId: string | undefined; cardAnswerId?: string; decision: NoticeDecision }>): Promise<UnansweredMessageOutcome> {
  const commentId = await db.transaction(async tx => {
    // The issue fence that comment writers, the executor's held-notice writer
    // and execution admission take. The SAME predicate is evaluated again
    // under it: an answer (prose or the turn's own card), a held notice, a
    // newer message, a run or a wake that committed while this sweep waited
    // means no notice.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    const kept: NoticeDecision[] = [];
    for (const { messageId, cardAnswerId, decision } of members) {
      const again = await decideUnansweredMessage(tx as unknown as Db, issue, now, nativeBlockedRepairApplies, messageId, cardAnswerId);
      if (again.kind === "notice" && again.reason === decision.reason && groupKey(again) === groupKey(decision)) kept.push(again);
    }
    // Members are oldest first, the task's latest message last: the notice is keyed to the latest one kept.
    const fenced = kept[kept.length - 1];
    if (!fenced) return null;
    if (kept.length > 1) Object.assign(fenced.notice.metadata, {
      [UNANSWERED_MESSAGE_GROUP_KEY]: kept.map(member => member.reason.slice(UNANSWERED_MESSAGE_REASON_PREFIX.length)) });
    if (fenced.upgradeCommentId) {
      // The SAME note (same key) becomes the failure text: still one note.
      const [updated] = await tx.update(issueComments).set({ body: fenced.notice.body, presentation: fenced.notice.presentation,
        metadata: { ...fenced.notice.metadata, authorizationReason: fenced.reason }, updatedAt: now })
        .where(and(eq(issueComments.id, fenced.upgradeCommentId), eq(issueComments.companyId, issue.companyId),
          isNull(issueComments.deletedAt))).returning({ id: issueComments.id });
      return updated?.id ?? null;
    }
    const comment = await issueService(tx as unknown as Db).addComment(issue.id, fenced.notice.body, {}, {
      authorType: "system",
      presentation: fenced.notice.presentation,
      metadata: { ...fenced.notice.metadata, authorizationReason: fenced.reason },
    }, tx);
    return comment?.id ?? null;
  });
  return commentId ? { kind: "noticed", code: members[0].decision.code, commentId } : { kind: "noticed_before" };
}

type DecisionIssue = { id: string; companyId: string; status: string; hiddenAt: Date | null;
  assigneeAgentId: string | null; assigneeUserId: string | null };
type WaitRecord = { messageId: string; runId: string | null; waitKind?: "setup"; startedAt?: string; boundMs?: number };
type Decision = { kind: "none" | "answered" | "noticed_before" | "explained" | "out_of_scope" }
  /** The sender stopped the run that was answering this message; noticeId is its standing notice, if any. */
  | { kind: "person_stopped"; messageId: string; noticeId: string | null; cardAnswerId?: string }
  | { kind: "pending"; recheckAt: number; recordDeferral?: { runId: string; agentId: string; messageId: string };
      recordWait?: WaitRecord }
  | NoticeDecision;
type NoticeDecision = { kind: "notice"; reason: string; code: string; notice: ReturnType<typeof buildStrandedRecoveryEscalationNotice>;
  recordWait?: WaitRecord;
  /** The owed group: the run that carried the message in its own input, or "no_run". */
  group: string;
  /** Set when this replaces the message's standing waiting note. */
  upgradeCommentId?: string };

/** The run event that records, once and durably, when this step first deferred
 * a person message's notice to the native blocked-request repair (T0). */
export const NATIVE_REPAIR_DEFERRAL_EVENT = "unanswered_message.native_repair_deferral";

/** The activity that records, once and durably, when this step first deferred
 * a person message's notice to a further attempt that is not a running turn
 * (a queued wake, a queued or scheduled run, a pending native finalization or
 * retry, a queued missing-comment retry): T0, keyed by the message and the run
 * that carries it (none, or its latest). The wait may have no run, so this
 * lives in the activity log rather than in a run's events. */
export const PENDING_WAIT_ACTION = "issue.unanswered_message_wait";
export const PENDING_WAIT_BOUND_MS = 2 * 60_000;

/** The one predicate: run outside the fence to skip the lock in the common
 * case, and again unchanged inside it before writing. Reads only. */
async function decideUnansweredMessage(q: Db, issue: DecisionIssue, now: Date,
  nativeBlockedRepairApplies?: NativeBlockedRepairApplies, messageId?: string, cardAnswerId?: string): Promise<Decision> {
  if (issue.hiddenAt || !issue.assigneeAgentId || issue.assigneeUserId
    || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) return { kind: "out_of_scope" };
  const agentId = issue.assigneeAgentId;

  // The owed input: a typed message, or (cardAnswerId) the person's ANSWER to a card, keyed by the card id and its
  // answer time and read by the same owed rule (owedCardAnswerSql: the one function with the answer as the input).
  const cardAnswer = Boolean(cardAnswerId);
  const [cardAnswerRow] = cardAnswerId ? await q.select({ id: issueThreadInteractions.id, createdAt: issueThreadInteractions.resolvedAt,
    authorUserId: issueThreadInteractions.resolvedByUserId }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
    eq(issueThreadInteractions.id, cardAnswerId), owedCardAnswerSql("issue_thread_interactions", now))).limit(1) : [];
  if (cardAnswerId && !cardAnswerRow?.createdAt) return { kind: "answered" };
  const [message] = cardAnswerRow?.createdAt ? [{ ...cardAnswerRow, createdAt: cardAnswerRow.createdAt }]
    : await q.select({ id: issueComments.id, createdAt: issueComments.createdAt,
    authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt), messageId ? eq(issueComments.id, messageId) : undefined))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  // No age cut here: discovery (inScopeSql) decides which messages are in
  // scope, so an open obligation is never dropped silently by age.
  if (!message) return { kind: "none" };
  const [answer] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.id, message.id), answeredSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }))).limit(1);
  if (answer) return { kind: "answered" };
  const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${message.id}`;
  const [noticed] = await q.select({ id: issueComments.id,
    waiting: sql<boolean>`coalesce(${issueComments.metadata}->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)`,
    waitingCode: sql<string | null>`(select r->>'value' from jsonb_array_elements(coalesce(${issueComments.metadata}->'sections', '[]'::jsonb)) sec,
      jsonb_array_elements(coalesce(sec->'rows', '[]'::jsonb)) r where r->>'label' = ${WAITING_ROW_LABEL} limit 1)` })
    .from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    sql`starts_with(${reasonOf(issueComments.metadata)}, ${UNANSWERED_MESSAGE_REASON_PREFIX})`,
    noticeCoversSql(`"issue_comments"`, sql`${message.id}`),
    // A notice retired while a card answered the message does not stand once that card ended (NOTICE_REOWED_AFTER_CARD).
    cardAnswer ? undefined : noticeStandsSql(`"issue_comments"`, { id: sql`${message.id}::uuid`, companyId: sql`${issue.companyId}::uuid`,
      issueId: sql`${issue.id}::uuid`, createdAt: sql`${message.createdAt.toISOString()}::timestamptz` })))
    .orderBy(sql`${issueComments.deletedAt} is not null`).limit(1);

  // The run this message started (the latest run that carries it), if any.
  const issueRun = or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`);
  const runs = await q.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, error: heartbeatRuns.error,
    errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot, finishedAt: heartbeatRuns.finishedAt,
    updatedAt: heartbeatRuns.updatedAt, createdAt: heartbeatRuns.createdAt, issueCommentStatus: heartbeatRuns.issueCommentStatus,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun,
    gt(heartbeatRuns.createdAt, new Date(message.createdAt.getTime() - 60 * 60_000))))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(20);
  // Only a run that carries THIS message is evidence about it. An unrelated
  // run (a timer, or the continuation that replaced a cancelled deferred wake
  // with no comment ids) is not: the message's own wake path decides.
  const messageRun = runs.find(candidate => runCarriesMessage(candidate.contextSnapshot, message.id)) ?? null;
  // The SENDER'S OWN Stop (RFL ruling 8): the newest run that carries this message was stopped (or interrupted) by
  // the message's sender after it had started answering it. The person's own Stop line is the one note: the
  // message is not owed a notice, and a standing one stops covering it. A stop by anyone else (another user, an
  // agent, the system, a pause, a timeout) or of a run that had not read the message keeps the message owed. The
  // ONE rule (person-stopped-message.ts senderStoppedWhileAnswering), read by this decision and the carry.
  // A person's CARD ANSWER is their input the same way (RFL 22:22Z, am6 gap 19): its sender is the person who
  // answered the card, and the carry already reads the rule for it (continuation-comment-input.ts).
  const personStopped = { kind: "person_stopped" as const, messageId: message.id, noticeId: noticed?.id ?? null,
    ...(cardAnswerId ? { cardAnswerId } : {}) };
  if (await senderStoppedWhileAnswering(q, issue.companyId, messageRun, message)) return personStopped;
  // A standing WAITING note is still an open obligation: it must stay true.
  if (noticed && !noticed.waiting) return { kind: "noticed_before" };
  const upgrading = noticed?.waiting ? noticed.id : null;
  const standingWaitingCode = noticed?.waiting ? noticed.waitingCode : null;
  // A failed fresh continuation that descends from the message's run is the
  // run the person's message ended on: the automatic lineage, typed or not,
  // ends there (fork-lead a6342a4d4, fresh-continuation-chain.ts).
  const latest = runs[0];
  const run = messageRun && latest && latest.id !== messageRun.id
    && ["failed", "timed_out", "interrupted", "cancelled"].includes(latest.status)
    && await freshContinuationDescendsFrom(q, { companyId: issue.companyId, issueId: issue.id,
      runId: latest.id, ancestorRunId: messageRun.id }) ? latest : messageRun;

  // Unrepresented further attempts are BOUNDED. A live turn's header and a
  // stored executionWait already name their wait; neither gets a second note:
  // T0 is recorded ONCE (durably, PENDING_WAIT_ACTION, keyed by the message
  // and its carrying run, messageRun; a refused successor below never
  // restarts it) the first time this step defers to such an attempt,
  // and the wait ends at T0 + PENDING_WAIT_BOUND_MS. An attempt that never
  // starts (a re-wake that is never claimed, a finalization stuck in a pending
  // phase, a retry with no next attempt, a missing-comment retry that never
  // runs) then no longer keeps the message silent: the decision continues and
  // the fenced writer posts the one notice; a later answer supersedes it.
  let waitT0: number | null | undefined;
  let setupWaitRecord: WaitRecord | undefined;
  const bounded = async (recheckAt: number, setup = false): Promise<Decision | null> => {
    if (waitT0 === undefined) {
      const [wait] = await q.select({ at: sql<Date>`min(${activityLog.createdAt})` }).from(activityLog).where(and(
        eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id),
        eq(activityLog.action, PENDING_WAIT_ACTION), sql`${activityLog.details}->>'messageId' = ${message.id}`,
        sql`coalesce(${activityLog.details}->>'runId', '') = ${messageRun?.id ?? ""}`,
        sql`coalesce(${activityLog.details}->>'waitKind', 'attempt') = ${setup ? "setup" : "attempt"}`));
      waitT0 = wait?.at ? new Date(wait.at).getTime() : null;
    }
    // Setup's clock starts with the saved message, never the first sweep.
    // Keep its record separate so it cannot consume a later retry's bound.
    if (setup && waitT0 === null) setupWaitRecord = { messageId: message.id, runId: messageRun?.id ?? null,
      waitKind: "setup", startedAt: message.createdAt.toISOString(), boundMs: SETUP_WAIT_BOUND_MS };
    const bound = setup ? message.createdAt.getTime() + SETUP_WAIT_BOUND_MS : (waitT0 ?? now.getTime()) + PENDING_WAIT_BOUND_MS;
    if (bound <= now.getTime()) return null;
    return { kind: "pending", recheckAt: Math.min(recheckAt, bound),
      ...(waitT0 === null ? { recordWait: setupWaitRecord ?? { messageId: message.id, runId: messageRun?.id ?? null } } : {}) };
  };

  // A running turn remains quiet; its watchdog owns a hung execution. A
  // queued run carrying M (including a proven output-cap successor) already
  // has upstream's runner-turn header: "Waiting for <agent>" or "Waiting to
  // start". SUPERSEDE-WAITNOTE-UPSTREAM-HEADER-1119: no second note, including
  // beyond the former ten-minute boundary and while the agent is paused.
  const live = runs.filter(candidate => LIVE.includes(candidate.status));
  const [otherLive] = live.length ? [] : await q.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun,
    inArray(heartbeatRuns.status, LIVE))).limit(1);
  const liveRuns = otherLive ? [...live, otherLive] : live;
  if (liveRuns.some(candidate => candidate.status === "running")) {
    return { kind: "pending", recheckAt: now.getTime() + 30_000 };
  }
  for (const candidate of liveRuns) {
    if (runCarriesMessage(candidate.contextSnapshot, message.id) || (messageRun && candidate.id !== messageRun.id
      && await freshContinuationDescendsFrom(q, { companyId: issue.companyId, issueId: issue.id,
        runId: candidate.id, ancestorRunId: messageRun.id, includeAnswerLineage: true }))) {
      return { kind: "pending", recheckAt: now.getTime() + 30_000 };
    }
  }
  // The agent is paused (Paperclip's lifecycle: status paused, lifecycle state
  // paused/pausing, or a lifecycle hold such as "manual"): nothing runs until
  // it is resumed, so "sending it again" would do nothing. The note says it is
  // paused and who can resume it; it stays a waiting-kind note, so after the
  // resume the saved message's own run decides (its answer supersedes it).
  const [agentRow] = await q.select({ name: agents.name, status: agents.status, lifecycleState: agents.lifecycleState,
    lifecycleHolds: agents.lifecycleHolds, pauseReason: agents.pauseReason, lifecycleError: agents.lifecycleError })
    .from(agents).where(and(eq(agents.companyId, issue.companyId), eq(agents.id, agentId)));
  // Setup uses the compatibility status "paused", but completes by itself.
  // Its saved message remains an obligation: use the existing sweep deadline
  // and bound, never a second wake. After ten minutes, one true setup note
  // stands until readiness or error. Explicit holds/pauses/errors keep their path.
  let settingUp = false;
  if (agentRow?.status === "paused" && ["preparing", "verifying"].includes(agentRow.lifecycleState)
    && (agentRow.pauseReason == null || agentRow.pauseReason === "setup")
    && (agentRow.lifecycleHolds ?? []).length === 0 && !agentRow.lifecycleError) {
    const wait = await bounded(now.getTime() + 30_000, true);
    if (wait) return wait;
    if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_AGENT_SETUP_CODE) {
      return { kind: "pending", recheckAt: now.getTime() + 30_000 };
    }
    settingUp = true;
  }
  const agentPaused = Boolean(!settingUp && agentRow && (agentRow.status === "paused" || ["paused", "pausing"].includes(agentRow.lifecycleState)
    || (agentRow.lifecycleHolds ?? []).length > 0));
  // Import intentionally parks automations until activation. It lost neither
  // the message nor an attempt: do not annotate every carried-over open task.
  // Resume's existing eligibility notification rechecks the saved work.
  if (agentPaused && agentRow?.pauseReason === "import" && (agentRow.lifecycleHolds ?? []).every(hold => hold === "import")) {
    return { kind: "none" };
  }
  if (liveRuns.length && !agentPaused && !settingUp) {
    const wait = await bounded(now.getTime() + 30_000);
    if (wait) return wait;
  }

  // A board-owned hold means queued wakes alone are not a further attempt.
  // A stored executionWait still owns this message's one visible wait line.
  const [activeRecovery] = await q.select({ id: issueRecoveryActions.id, nextAction: issueRecoveryActions.nextAction,
    ownerType: issueRecoveryActions.ownerType, wakePolicy: issueRecoveryActions.wakePolicy,
    evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    inArray(issueRecoveryActions.status, ["active", "escalated"])))
    .orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  const boardHold = activeRecovery?.ownerType === "board" ? activeRecovery : null;
  // STOP_HOLD_YIELDS_TO_SENDER_STOP (review-fleet-5 20:34Z): a person's real Stop (routes/agents.ts
  // POST /heartbeat-runs/:runId/cancel) leaves the cancelled run AND a board-owned hold on it (active_run_watchdog,
  // cause native_continuation_requires_reconciliation or legacy_execution_requires_reconciliation, evidence.runId).
  // That hold must not turn the sender's own Stop into a "no run started" line: a message of the SAME sender whose
  // own wake still waits in line behind the run they stopped is kept for their Send, by their own Stop. The Stop
  // line is the one note (ruling 8). A hold from any other stop, or a message with no waiting wake, decides below.
  // A card answer held the same way (the person answered the card, and its own wake waits in line behind the run
  // they stopped) is kept for them by their own Stop too: never "Your answer is saved, but no run started for it".
  if (boardHold && !agentPaused && !messageRun && message.authorUserId) {
    const heldRunId = (boardHold.evidence as Record<string, unknown> | null)?.runId;
    const [heldRun] = typeof heldRunId === "string" ? await q.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
      resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, heldRunId), eq(heartbeatRuns.agentId, agentId))) : [];
    // RFL-2: an answer given AFTER the Stop is not held by it (person-stopped-message.ts cardAnswerGivenBeforeStop).
    if (heldRun && stoppedBySender(heldRun, message.authorUserId)
      && (!cardAnswer || cardAnswerGivenBeforeStop(message.createdAt, heldRun))) {
      const waiting = await q.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
        inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
      if (waiting.some(wake => wakeCarriesIssue(wake.payload, issue.id)
        && (cardAnswer ? wakeCarriesCardAnswer(wake.payload, message.id) : wakeCarriesMessage(wake.payload, message.id)))) return personStopped;
    }
  }
  if (!settingUp) {
    const wakes = await q.select({ payload: agentWakeupRequests.payload, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
        or(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          and(eq(agentWakeupRequests.status, "deferred"), wellFormedExecutionWaitSql(agentWakeupRequests.payload)))));
    // Admission has saved a real further attempt for THIS message, not a
    // failed start. Coalesced receipts alone are not live; missing/malformed
    // waits retain the ordinary no-run/failure decision.
    const pendingExecutionWait = wakes.some(wake => ["deferred", "deferred_issue_execution"].includes(wake.status)
      && isWellFormedExecutionWait(wake.payload?.executionWait)
      && wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id));
    // tB2 523dfe75:613-623 predicate only; do not port its waiting note.
    // This message's deferred receipt already has one visible panel line.
    if (pendingExecutionWait) return { kind: "pending", recheckAt: now.getTime() + 30_000 };
    if (!boardHold && !agentPaused && wakes.some(wake => wake.status !== "deferred" && wakeCarriesIssue(wake.payload, issue.id))) {
      const wait = await bounded(now.getTime() + 30_000);
      if (wait) return wait;
    }
  }
  if (agentPaused) {
    const due = message.createdAt.getTime() + UNANSWERED_MESSAGE_SETTLE_MS;
    if (due > now.getTime()) return { kind: "pending", recheckAt: due };
    if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_AGENT_PAUSED_CODE) {
      return { kind: "pending", recheckAt: now.getTime() + 5 * 60_000 };
    }
  }

  let code: string;
  if (settingUp) {
    code = UNANSWERED_MESSAGE_AGENT_SETUP_CODE;
  } else if (agentPaused) {
    code = UNANSWERED_MESSAGE_AGENT_PAUSED_CODE;
  } else if (!run) {
    // Paperclip records a deferred or coalesced wake that could not start as
    // FAILED: that is the trigger. The grace covers a wake that threw before
    // any wake row existed (the comment route logs and returns 201).
    const failedWakes = await q.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
      eq(agentWakeupRequests.status, "failed"), gt(agentWakeupRequests.updatedAt, message.createdAt)));
    // Only THIS message's own wake (Paperclip's queued-comment attribution) is
    // evidence; an unrelated failed wake on the issue is not.
    const wakeFailed = failedWakes.some(wake => wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id));
    const due = message.createdAt.getTime() + UNANSWERED_MESSAGE_NO_RUN_GRACE_MS;
    if (!wakeFailed && due > now.getTime()) return { kind: "pending", recheckAt: due };
    code = UNANSWERED_MESSAGE_NO_RUN_CODE;
  } else {
    if (!TERMINAL.includes(run.status)) return { kind: "pending", recheckAt: now.getTime() + 30_000 };
    const due = (run.finishedAt ?? run.updatedAt).getTime() + UNANSWERED_MESSAGE_SETTLE_MS;
    if (due > now.getTime()) return { kind: "pending", recheckAt: due };
    if (run.issueCommentStatus === "retry_queued") {
      const wait = await bounded(now.getTime() + 30_000);
      if (wait) return wait;
    }
    const [coordinator] = await q.select({ phase: nativeRunFinalizations.phase, nextAttemptAt: nativeRunFinalizations.nextAttemptAt,
      failureCode: nativeRunFinalizations.failureCode, failureDetail: nativeRunFinalizations.failureDetail })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, issue.companyId), eq(nativeRunFinalizations.runId, run.id)));
    if (coordinator && !boardHold) {
      if (NATIVE_PENDING_PHASES.includes(coordinator.phase)) {
        const wait = await bounded(now.getTime() + 30_000);
        if (wait) return wait;
      } else if (coordinator.phase === "retryable_failure"
        && (!coordinator.nextAttemptAt || coordinator.nextAttemptAt.getTime() + OVERDUE_NATIVE_RETRY_MS > now.getTime())) {
        // A first start whose Runner never connected retries on the same run
        // (at most 3 attempts, jittered ~30 s then ~60 s apart, plus each
        // attempt's own startup wait), which can outlast the 120 s bound. Its
        // scheduled retry is a real further attempt: wait for it; after
        // exhaustion the fresh continuation's note explains the message.
        if (run.errorCode === "runner_ingress_startup_failed" && coordinator.nextAttemptAt) {
          return { kind: "pending", recheckAt: Math.max(now.getTime() + 30_000, coordinator.nextAttemptAt.getTime()) };
        }
        const wait = await bounded(Math.max(now.getTime() + 30_000, (coordinator.nextAttemptAt?.getTime() ?? 0) + OVERDUE_NATIVE_RETRY_MS));
        if (wait) return wait;
      }
    }
    // A first start whose Runner never connected spent its same-run retries,
    // but the task continues by itself in a fresh run whose one note explains
    // the message (r104c). The board-owned hold here is that run's own
    // exhaustion record, which the disposition worker settles into the
    // continuation. That is a further attempt: wait for it, bounded like
    // every other.
    if (nativeStartupNeverConnectedExhausted(coordinator)) {
      const wait = await bounded(now.getTime() + 30_000);
      if (wait) return wait;
    }
    // A declared blocker or attention request answers the person only when its
    // words were PUBLISHED for this message (a reply attributed above, or the
    // run's own card). An accepted result whose text never reached the thread
    // (25-SILENT-BLOCK) is unanswered, unless the recovery's native
    // blocked-request repair applies: that path publishes the unblock request
    // as its own visible notice on this sweep's next pass, so it owns the
    // disposition (and its notice then explains the message).
    // The deferral is BOUNDED by a fixed durable time: T0, recorded ONCE as a
    // run event the first time this step defers this message to the repair,
    // + NATIVE_REPAIR_PUBLISH_BOUND_MS (D4). If a guard of the repair (an
    // edited carried message, a newer status decision, a board-owned hold)
    // keeps it from publishing, this step posts the notice after that bound.
    if (run.status === "succeeded" && nativeBlockedRepairApplies) {
      const [deferral] = await q.select({ at: sql<Date>`min(${heartbeatRunEvents.createdAt})` }).from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, issue.companyId), eq(heartbeatRunEvents.runId, run.id),
        eq(heartbeatRunEvents.eventType, NATIVE_REPAIR_DEFERRAL_EVENT),
        sql`${heartbeatRunEvents.payload}->>'messageId' = ${message.id}`));
      const t0 = deferral?.at ? new Date(deferral.at).getTime() : null;
      const bound = (t0 ?? now.getTime()) + NATIVE_REPAIR_PUBLISH_BOUND_MS;
      if (bound > now.getTime()
        && await nativeBlockedRepairApplies({ companyId: issue.companyId, issueId: issue.id, runId: run.id }, q)) {
        return { kind: "pending", recheckAt: bound,
          ...(t0 === null ? { recordDeferral: { runId: run.id, agentId: run.agentId, messageId: message.id } } : {}) };
      }
    }
    code = run.status === "succeeded" ? UNANSWERED_MESSAGE_NO_REPLY_CODE : unansweredMessageCode(run);
  }

  // A recovery notice attached to this message's failed run already gives
  // the Retry remedy, even when classified as system-owned recovery. Do not
  // contradict it with "send the message again". A hold alone, a deleted
  // notice, an older run's notice, or an automatic continuation is not enough.
  // Prefer the existing structured manual Retry policy. Older recovery
  // records have only nextAction prose: Retry can follow setup instructions
  // ("restore access, then press Retry"), but a negated remedy cannot cover it.
  // This decision is re-read unchanged under the issue fence before writing.
  const retryRemedy = activeRecovery?.wakePolicy?.type === "manual_retry"
    || (activeRecovery && /\bretry\b/i.test(activeRecovery.nextAction)
      && !/\b(?:do\s+not\s+retry|automatic\s+retr(?:y|ies)\s+(?:(?:is|are)\s+)?stopped|retry\s+is\s+not\s+available)\b/i.test(activeRecovery.nextAction));
  if (run && activeRecovery && retryRemedy) {
    const recoveryNotices = await q.select({ metadata: issueComments.metadata }).from(issueComments).where(and(
      eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt), gt(issueComments.createdAt, message.createdAt),
      sql`${issueComments.presentation}->>'kind' = 'system_notice'`,
      sql`${issueComments.metadata}->>'sourceRunId' = ${run.id}`));
    if (recoveryNotices.some(notice => noticeMetadataReferencesRecoveryAction(notice.metadata, activeRecovery.id))) {
      return { kind: "explained" };
    }
  }

  // Already explained: the executor's held notice for this conversation, or a
  // person-facing recovery notice, posted after the message. An older held
  // notice never silences a newer message.
  const heldNotice = await readUnsupersededHeldConversationNotice(q, { companyId: issue.companyId, issueId: issue.id });
  if (heldNotice && heldNotice.createdAt > message.createdAt) return { kind: "explained" };
  const [explained] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt), gt(issueComments.createdAt, message.createdAt),
    sql`${issueComments.presentation}->>'kind' = 'system_notice'`,
    sql`${issueComments.presentation}->>'tone' in ('danger', 'warning')`,
    sql`coalesce(${issueComments.metadata}->>'recoveryResponsibility', 'user') <> 'system'`,
    sql`not starts_with(coalesce(${issueComments.metadata}->>'authorizationReason', ''), ${UNANSWERED_MESSAGE_REASON_PREFIX})`)).limit(1);
  if (explained) return { kind: "explained" };

  // A fresh-thread refusal is continued by the fresh-continuation fallback on
  // its own (#20925): never the held-conversation "send a new message" note,
  // as isNativeContinuationRefusal already decides for its own patterns.
  const policyRefused = code === PROVIDER_POLICY_REFUSAL_CODE;
  const held = (isNativeContinuationRefusal(run) || HELD_CODES.has(code)) && !(run && isFreshThreadRefusal(run));
  const supervisionUnconfirmed = code === REMOTE_RUNNER_SUPERVISION_EXHAUSTED && !held;
  const paused = code === UNANSWERED_MESSAGE_AGENT_PAUSED_CODE;
  const pausedName = agentRow?.name?.trim() || "This agent";
  const waiting = WAITING_KIND_CODES.has(code);
  // The ONE bound: the message's automatic lineage used its K=2 fresh
  // continuations and the last one failed. Nothing further starts by itself.
  const boundReached = Boolean(!paused && !waiting && run && TERMINAL.includes(run.status) && run.status !== "succeeded"
    && (await freshContinuationChain(q as Db, { companyId: issue.companyId, issueId: issue.id, runId: run.id })).attempts
      >= FRESH_CONTINUATION_BOUND);
  // Server-local HH:MM: the instance's time zone, not an assumed UTC zone.
  const since = `${String(message.createdAt.getHours()).padStart(2, "0")}:${String(message.createdAt.getMinutes()).padStart(2, "0")}`;
  const body = policyRefused ? PROVIDER_POLICY_REFUSAL_MESSAGE
    : supervisionUnconfirmed ? REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION
    : settingUp ? `${pausedName} is still being set up (since ${since}). Your message is saved and will be answered as soon as it's ready.`
    : paused ? agentPausedText(pausedName)
    // The card-answer duty's words follow the run's REAL outcome (rulings 1, 4; bb/tamin6 :1105-1107).
    : cardAnswer ? !run || code === UNANSWERED_MESSAGE_NO_RUN_CODE ? UNANSWERED_CARD_ANSWER_NO_RUN_TEXT
      : ["failed", "timed_out", "interrupted"].includes(run.status) ? UNANSWERED_CARD_ANSWER_TEXT
        : UNANSWERED_CARD_ANSWER_NO_REPLY_TEXT
    : boundReached ? UNANSWERED_MESSAGE_BOUND_REACHED_TEXT
    : code === UNANSWERED_MESSAGE_NO_REPLY_CODE ? UNANSWERED_MESSAGE_NO_REPLY_TEXT
    : code === UNANSWERED_MESSAGE_NO_RUN_CODE ? UNANSWERED_MESSAGE_NO_RUN_TEXT
      : held ? HELD_PREDECESSOR_NOTICE : UNANSWERED_MESSAGE_TEXT;
  const notice = buildStrandedRecoveryEscalationNotice({
    seed: {
      title: policyRefused ? "The provider refused this request"
        : supervisionUnconfirmed ? "Your message wasn't answered"
        : settingUp ? `${pausedName} is still being set up` : paused ? `${pausedName} is paused`
        : cardAnswer ? "Your answer wasn't acted on" : "Your message wasn't answered",
      body,
      tone: !policyRefused && !supervisionUnconfirmed && settingUp ? "info" : "warning",
      nextAction: policyRefused ? "Automatic retry is disabled for this request."
        : supervisionUnconfirmed ? "Retry or send a new message to continue through fenced recovery."
        : settingUp ? "No action is needed; your message is saved."
        : paused ? `Ask a board user or ${pausedName}'s manager to resume ${pausedName}.`
        : cardAnswer ? "Retry; if it fails again, assign this agent a new task."
        : held || boundReached ? "Send a new message to try again." : "Send the message again; if it fails again, assign this agent a new task.",
    },
    recoveryActionId: boardHold?.id ?? null,
    recoveryOwner: null,
    recoveryResponsibility: "user",
    sourceRun: run && !waiting ? { id: run.id, agentId: run.agentId, status: run.status, errorCode: code } : null,
    // A waiting-kind note is not a failure: no "Failure code" row, a marker row instead.
    failureCode: waiting ? undefined : run ? undefined : code,
  });
  if (waiting) notice.metadata.sections.push({ title: "Status", rows: [keyValueRow(WAITING_ROW_LABEL, code)] });
  // A card answer's notice is its own group: its words are the answer's, never shared with a typed message.
  return { kind: "notice", reason, code, notice,
    group: `${cardAnswer ? "card_answer:" : ""}${messageRun?.id ?? UNANSWERED_MESSAGE_NO_RUN_CODE}`,
    ...(setupWaitRecord ? { recordWait: setupWaitRecord } : {}), ...(upgrading ? { upgradeCommentId: upgrading } : {}) };
}


/** One task the recovery worker already flagged (its batched page query found
 * a person's message to settle): no candidate lookup of its own. */
export async function settleUnansweredPersonMessagesForTask(
  db: Db,
  input: { companyId: string; issueId: string; issueCreatedAtGte?: Date | null; onDeferredDeadline?: (at: number) => void; now?: Date;
    nativeBlockedRepairApplies?: NativeBlockedRepairApplies },
): Promise<{ noticed: number; pending: number }> {
  const result = { noticed: 0, pending: 0 };
  const notices = new Set<string>(); // one notice covers a whole owed group: count it once
  for (const outcome of await settleOwedPersonMessages(db, input)) {
    if (outcome.kind === "noticed" && !notices.has(outcome.commentId)) { notices.add(outcome.commentId); result.noticed += 1; }
    if (outcome.kind === "pending") {
      result.pending += 1;
      input.onDeferredDeadline?.(outcome.recheckAt);
    }
  }
  return result;
}

/** The sweep's pass outside the worker (startup, a direct call): every task in
 * scope with a person's message to settle, found with one candidate query. */
export async function settleUnansweredPersonMessages(
  db: Db,
  input: { companyId?: string; issueId?: string; issueCreatedAtGte?: Date | null; onDeferredDeadline?: (at: number) => void; now?: Date;
    nativeBlockedRepairApplies?: NativeBlockedRepairApplies },
): Promise<{ noticed: number; pending: number }> {
  const candidates = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
    input.companyId ? eq(issues.companyId, input.companyId) : undefined,
    input.issueId ? eq(issues.id, input.issueId) : undefined,
    // The execution cutoff decides what may be NOTICED; a notice due to retire is settled on any task (old, done).
    or(and(input.issueCreatedAtGte ? sql`${issues.createdAt} >= ${input.issueCreatedAtGte.toISOString()}::timestamptz` : undefined,
      unansweredPersonMessageCondition(issues.id, issues.companyId)), answeredNoticeToRetireCondition(issues.id, issues.companyId)),
  )).limit(200);
  const result = { noticed: 0, pending: 0 };
  const notices = new Set<string>(); // one notice covers a whole owed group: count it once
  for (const candidate of candidates) {
    for (const outcome of await settleOwedPersonMessages(db, { companyId: candidate.companyId, issueId: candidate.id, now: input.now,
      issueCreatedAtGte: input.issueCreatedAtGte, nativeBlockedRepairApplies: input.nativeBlockedRepairApplies })) {
      if (outcome.kind === "noticed" && !notices.has(outcome.commentId)) { notices.add(outcome.commentId); result.noticed += 1; }
      if (outcome.kind === "pending") {
        result.pending += 1;
        input.onDeferredDeadline?.(outcome.recheckAt);
      }
    }
  }
  return result;
}
