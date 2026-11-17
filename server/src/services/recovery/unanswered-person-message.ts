import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { answeredPersonMessageSql, PENDING_WAIT_START_BOUND_MS, unansweredCardAnswerSql } from "../person-message-answer.js";
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
import { readUnsupersededHeldConversationNotice } from "../native-runtime/pi-session-recovery-notice.js";
import { conversationTurnAnswered } from "../native-runtime/native-governance.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";
import { noticeMetadataReferencesRecoveryAction } from "./successful-run-handoff.js";
import { keyValueRow } from "./notice-format.js";
import { freshContinuationChain, freshContinuationDescendsFrom } from "../fresh-continuation-chain.js";
import { nativeStartupNeverConnectedExhausted } from "../continuation-cause.js";
import { isFreshThreadRefusal } from "../native-runtime/runner-reconciliation-refusal.js";
import { isNativeContinuationRefusal } from "../native-continuation-refusal.js";
import { personHeldChatMessageSql, personStoppedCarrierSql, runStartedAnswering, stoppedBySender } from "./person-stopped-message.js";
import { automaticRecoveryPending } from "./automatic-recovery-pending.js";
import { AGENT_PAUSE_STOP_REASON } from "../governance-pause-stop.js";

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
export const UNANSWERED_MESSAGE_REASON_PREFIX = "unanswered_message:";
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

export const UNANSWERED_MESSAGE_NO_REPLY_CODE = "no_reply";
export const UNANSWERED_MESSAGE_NO_RUN_CODE = "no_run";
export const UNANSWERED_MESSAGE_UNCLASSIFIED_CODE = "unclassified_failure";
/** The run that carries the message is queued or scheduled and has not started. */
export const UNANSWERED_MESSAGE_WAITING_CODE = "waiting_to_start";
/** A waiting note stays true only this long: if the carrying run still has not
 * started by T0 + this bound, the SAME note becomes the failure text. For the
 * system's own automatic recovery the bound runs from the failed run's END. */
export { PENDING_WAIT_START_BOUND_MS };
/** The non-failure marker row of a waiting note (no "Failure code" row). */
const WAITING_ROW_LABEL = "Waiting code";
const WAITING_ROW_JSON = JSON.stringify([{ rows: [{ label: WAITING_ROW_LABEL }] }]);
/** The agent that answers the conversation is paused (or held) and will not
 * run until it is resumed. Not a failure: a waiting-kind note. */
export const UNANSWERED_MESSAGE_AGENT_PAUSED_CODE = "agent_paused";
/** A resumed agent's own pause stopped this message's run or wake, not a failure. */
const PAUSE_STOPPED_CODE = "agent_pause_stopped";
/** Setup completes by itself; a stalled setup gets one factual waiting note. */
export const UNANSWERED_MESSAGE_AGENT_SETUP_CODE = "agent_setup";
export const SETUP_WAIT_BOUND_MS = 10 * 60_000;
/** The system's own automatic recovery of the message's run is on its way
 * (automaticRecoveryPending): a waiting-kind note, never resend advice. */
export const UNANSWERED_MESSAGE_RECOVERING_CODE = "automatic_recovery_pending";
export const UNANSWERED_MESSAGE_RECOVERING_TEXT =
  "The run answering your message was cut off. Paperclip is recovering it and will continue by itself; your message is saved.";
const WAITING_KIND_CODES = new Set(["waiting_to_start", "agent_paused", UNANSWERED_MESSAGE_AGENT_SETUP_CODE,
  UNANSWERED_MESSAGE_RECOVERING_CODE]);
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
export const UNANSWERED_CARD_ANSWER_TEXT =
  "Your answer wasn't acted on: the run that picked it up failed. Retry is safe; if it fails again, assign this agent a new task.";
export const UNANSWERED_MESSAGE_NO_RUN_TEXT =
  "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
export const UNANSWERED_MESSAGE_WAITING_TEXT =
  "Your message is waiting for the agent to be free; it will start by itself.";
export const UNANSWERED_MESSAGE_NO_REPLY_TEXT =
  "This run finished without a reply to your message. Sending it again is safe.";
/** The ONE bound (follow-Paperclip B-2, RFL 05:51Z): the fork's K=2 fresh-continuation chain cap. */
export const FRESH_CONTINUATION_BOUND = 2;
export const UNANSWERED_MESSAGE_BOUND_REACHED_TEXT = "Paperclip tried to continue this task twice from its saved work, "
  + "and both attempts failed. Your message and the saved work are kept. Send a new message to try again.";

// Codes the notice metadata may name. A run's error is reduced to its leading
// code token; anything not listed is unclassified_failure, never raw text.
const SHOWN_CODES = new Set([
  "adapter_failed", "cancelled", "timeout", "timed_out", "interrupted", "process_lost", "setup_failed",
  "native_controller_recovery_missing_evidence", "native_controller_recovery_dependency_unavailable",
  "native_controller_recovery_unsupported", "native_controller_recovery_wait_authority_changed",
  "native_controller_recovery_metadata_too_large", "native_session_cleanup_quarantined",
  "runner_process_termination_unconfirmed", "native_runner_warm_attachment_runner_exited",
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
 * SQL: an agent answer ATTRIBUTED to message m, the Paperclip way: a reply
 * written by a run on the chain carrying m or a later person input. Fresh
 * continuations and answered-interaction resumes need not copy comment ids.
 * A run-less comment, shared session or unrelated later run is not an answer.
 */
function answeredSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  // The ONE shared definition (person-message-answer.ts), so B's notice and the continuation carry never
  // disagree on a message (RFL 20:22Z: run-less agent comments never answer; org 20:29Z: imported history).
  return answeredPersonMessageSql(m);
}
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
        or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text
        or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${m.id}::text))
    or exists (select 1 from ${agentWakeupRequests} w where w.company_id = ${m.companyId} and w.updated_at > ${since}::timestamptz
      and (w.payload->>'commentId' = ${m.id}::text
        or w.payload->'_paperclipWakeContext'->>'wakeCommentId' = ${m.id}::text
        or coalesce(w.payload->'_paperclipWakeContext'->'wakeCommentIds', '[]'::jsonb) ? ${m.id}::text)))`;
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
          and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || m.id::text
          and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or ${owedCardAnswerSql(sql`${companyId}`, sql`${issueId}`, since)}
    or exists (select 1 from ${issueComments} n
      join ${issueComments} m on m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and (${answeredSql(rawMessage("m"))} or ${personStoppedNoticeSql("m")} or ${personHeldChatMessageSql(rawMessage("m"))}))
    or exists (select 1 from ${issueComments} n
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and ${cardAnswerNoticeAnsweredSql(sql`n.company_id`, sql`n.issue_id`, sql`n.metadata->>'authorizationReason'`)}))`;
}

/** SQL: the message m (a typed message) has a standing notice that its sender's own
 * Stop or Interrupt may supersede (decideUnansweredMessage decides by line). */
function personStoppedNoticeSql(alias: string): SQL {
  return sql`(${sql.raw(`${alias}.author_type`)} = 'user' and ${personStoppedCarrierSql({ ...rawMessage(alias),
    authorUserId: sql.raw(`${alias}.author_user_id`) })})`;
}

/** SQL: the task has a person's card answer (unansweredCardAnswerSql) in the
 * lookback, given after every typed message, that has no failure notice yet. */
function owedCardAnswerSql(companyId: SQL, issueId: SQL, since: string): SQL {
  return sql`exists (select 1 from ${issueThreadInteractions} ca
    where ca.company_id = ${companyId} and ca.issue_id = ${issueId} and ca.resolved_at > ${since}::timestamptz
      and not exists (select 1 from ${issueComments} later where later.company_id = ca.company_id
        and later.issue_id = ca.issue_id and later.author_type = 'user' and later.deleted_at is null
        and later.created_at > ca.resolved_at)
      and ${unansweredCardAnswerSql("ca", new Date())}
      and not exists (select 1 from ${issueComments} n where n.company_id = ca.company_id and n.issue_id = ca.issue_id
        and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || ca.id::text
        and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))`;
}

/** SQL: a notice keyed by a card answer whose answer an agent has since given. */
function cardAnswerNoticeAnsweredSql(companyId: SQL, issueId: SQL, reason: SQL): SQL {
  return sql`(starts_with(${reason}, ${UNANSWERED_MESSAGE_REASON_PREFIX}) and exists (select 1 from ${issueThreadInteractions} ca
    where ca.company_id = ${companyId} and ca.issue_id = ${issueId} and ca.resolved_at is not null
      and ca.id::text = substr(${reason}, ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
      and ${answeredPersonMessageSql({ id: sql`ca.id`, companyId: sql`ca.company_id`, issueId: sql`ca.issue_id`,
        createdAt: sql`ca.resolved_at` })}))`;
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
        and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || ${issueComments.id}::text
        and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or (${issueComments.authorType} = 'user' and ${issueComments.deletedAt} is null
      and ${owedCardAnswerSql(sql`${issueComments.companyId}`, sql`${issueComments.issueId}`, since)})
    or (${issueComments.authorType} = 'system' and ${issueComments.deletedAt} is null
      and starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and (exists (select 1 from ${issueComments} m
        where m.company_id = ${issueComments.companyId} and m.issue_id = ${issueComments.issueId}
          and m.id::text = substr(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
          and (${answeredSql(rawMessage("m"))} or ${personStoppedNoticeSql("m")} or ${personHeldChatMessageSql(rawMessage("m"))}))
        or ${cardAnswerNoticeAnsweredSql(sql`${issueComments.companyId}`, sql`${issueComments.issueId}`,
          sql`${issueComments.metadata}->>'authorizationReason'`)})))`;
}

export type UnansweredMessageOutcome =
  | { kind: "none" | "answered" | "noticed_before" | "explained" | "out_of_scope" | "person_stopped" | "person_held" }
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
    // A card answer's answer-resume run (person-message-answer.ts carriesCommentSql).
    context.interactionId,
  ];
  return ids.includes(messageId);
}

function wakeCarriesMessage(payload: unknown, messageId: string): boolean {
  const value = (payload ?? {}) as Record<string, unknown>;
  const nested = (value._paperclipWakeContext ?? {}) as Record<string, unknown>;
  return [...queuedCommentIdsFromWakePayload(value), value.commentId, nested.wakeCommentId,
    ...(Array.isArray(nested.wakeCommentIds) ? nested.wakeCommentIds : [])].includes(messageId);
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
  const now = input.now ?? new Date();
  const [issue] = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status, hiddenAt: issues.hiddenAt,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt,
  }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue) return { kind: "none" };
  if (input.issueCreatedAtGte && issue.createdAt < input.issueCreatedAtGte) return { kind: "out_of_scope" };

  // An answer or the person-stopped held list supersedes that message's
  // notice (and its retrying line), including notices for older held messages.
  // Written under the same issue fence, in the same order (issue row, then its
  // comments) as the notice writers.
  const [liveNotice] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    or(sql`starts_with(${reasonOf(issueComments.metadata)}, ${UNANSWERED_MESSAGE_REASON_PREFIX})`,
      sql`starts_with(${reasonOf(issueComments.metadata)}, ${RETRYING_MESSAGE_REASON_PREFIX})`))).limit(1);
  if (liveNotice) await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    await tx.execute(sql`update ${issueComments} n set deleted_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
    where n.company_id = ${issue.companyId} and n.issue_id = ${issue.id} and n.author_type = 'system' and n.deleted_at is null
      and (starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
        or starts_with(n.metadata->>'authorizationReason', ${RETRYING_MESSAGE_REASON_PREFIX}))
      and (exists (select 1 from ${issueComments} m where m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', strpos(n.metadata->>'authorizationReason', ':') + 1)
        and (${answeredSql(rawMessage("m"))} or ${personHeldChatMessageSql(rawMessage("m"))}))
        or ${cardAnswerNoticeAnsweredSql(sql`n.company_id`, sql`n.issue_id`, sql`n.metadata->>'authorizationReason'`)})`);
  });

  const decision = await decideUnansweredMessage(db, issue, now, input.nativeBlockedRepairApplies);
  if (decision.kind === "person_stopped") {
    // The sender stopped the run that was answering this message: a standing
    // notice for it is superseded, under the same issue fence and predicate.
    if (decision.noticeId) await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
      const fenced = await decideUnansweredMessage(tx as unknown as Db, issue, now, input.nativeBlockedRepairApplies);
      if (fenced.kind !== "person_stopped" || fenced.noticeId !== decision.noticeId) return;
      await tx.update(issueComments).set({ deletedAt: now, updatedAt: now }).where(and(
        eq(issueComments.id, decision.noticeId!), eq(issueComments.companyId, issue.companyId),
        eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
    });
    return { kind: "person_stopped" };
  }
  if ((decision.kind === "pending" || decision.kind === "notice") && decision.recordWait) {
    await logActivity(db, { companyId: issue.companyId, actorType: "system", actorId: "recovery",
      action: PENDING_WAIT_ACTION, entityType: "issue", entityId: issue.id, issueId: issue.id,
      details: { boundMs: PENDING_WAIT_BOUND_MS, ...decision.recordWait } });
  }
  if (decision.kind === "pending") {
    if (decision.recordDeferral) {
      await appendHeartbeatRunEvent(db, { companyId: issue.companyId, runId: decision.recordDeferral.runId,
        agentId: decision.recordDeferral.agentId, eventType: NATIVE_REPAIR_DEFERRAL_EVENT, stream: "system", level: "info",
        message: "The unanswered-message notice waits for the native blocked-request repair to publish.",
        payload: { messageId: decision.recordDeferral.messageId, boundMs: NATIVE_REPAIR_PUBLISH_BOUND_MS } });
    }
    return { kind: "pending", recheckAt: decision.recheckAt };
  }
  if (decision.kind !== "notice") return decision;
  const commentId = await db.transaction(async tx => {
    // The issue fence that comment writers, the executor's held-notice writer
    // and execution admission take. The SAME predicate is evaluated again
    // under it: an answer (prose or the turn's own card), a held notice, a
    // newer message, a run or a wake that committed while this sweep waited
    // means no notice.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    const fenced = await decideUnansweredMessage(tx as unknown as Db, issue, now, input.nativeBlockedRepairApplies);
    if (fenced.kind !== "notice" || fenced.reason !== decision.reason
      || fenced.upgradeCommentId !== decision.upgradeCommentId) return null;
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
  return commentId ? { kind: "noticed", code: decision.code, commentId } : { kind: "noticed_before" };
}

type DecisionIssue = { id: string; companyId: string; status: string; hiddenAt: Date | null;
  assigneeAgentId: string | null; assigneeUserId: string | null };
type WaitRecord = { messageId: string; runId: string | null; waitKind?: "setup"; startedAt?: string; boundMs?: number };
type Decision = { kind: "none" | "answered" | "noticed_before" | "explained" | "out_of_scope" | "person_held" }
  | { kind: "person_stopped"; noticeId: string | null }
  | { kind: "pending"; recheckAt: number; recordDeferral?: { runId: string; agentId: string; messageId: string };
      recordWait?: WaitRecord }
  | { kind: "notice"; reason: string; code: string; notice: ReturnType<typeof buildStrandedRecoveryEscalationNotice>;
      recordWait?: WaitRecord;
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
  nativeBlockedRepairApplies?: NativeBlockedRepairApplies): Promise<Decision> {
  if (issue.hiddenAt || !issue.assigneeAgentId || issue.assigneeUserId
    || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) return { kind: "out_of_scope" };
  const agentId = issue.assigneeAgentId;

  const [latestMessage] = await q.select({ id: issueComments.id, createdAt: issueComments.createdAt,
    authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  // No age cut here: discovery (inScopeSql) decides which messages are in
  // scope, so an open obligation is never dropped silently by age.
  if (!latestMessage) return { kind: "none" };
  let message: { id: string; createdAt: Date; authorUserId?: string | null } = latestMessage;
  const [answer] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.id, message.id), answeredSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` }))).limit(1);
  // The person's card answer after that message is their latest input, with
  // the same duty (org 15:22Z option A): the same rule keyed by the card id and
  // its answer time (unansweredCardAnswerSql), on the answer-resume chain.
  let cardAnswer = false;
  if (answer) {
    const [owed] = await q.select({ id: issueThreadInteractions.id, createdAt: sql<Date>`${issueThreadInteractions.resolvedAt}` })
      .from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, issue.companyId),
        eq(issueThreadInteractions.issueId, issue.id), gt(issueThreadInteractions.resolvedAt, latestMessage.createdAt),
        unansweredCardAnswerSql("issue_thread_interactions", now)))
      .orderBy(desc(issueThreadInteractions.resolvedAt)).limit(1);
    if (owed) {
      message = { id: owed.id, createdAt: new Date(owed.createdAt) };
      cardAnswer = true;
    } else {
      // R-ONCE (RFL 18:19Z): a reply to a later input does not settle an earlier message its run never had
      // as pending input. The owed earlier message (in discovery's scope, one without a notice first) decides.
      const row = { id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` };
      const [earlier] = await q.select({ id: issueComments.id, createdAt: issueComments.createdAt,
        authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
        eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
        eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
        inScopeSql(row, new Date(now.getTime() - UNANSWERED_MESSAGE_LOOKBACK_MS).toISOString()),
        sql`not ${answeredSql(row)}`))
        .orderBy(sql`exists (select 1 from ${issueComments} n where n.company_id = ${issueComments.companyId}
          and n.issue_id = ${issueComments.issueId}
          and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || ${issueComments.id}::text
          and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false))`,
          desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
      if (!earlier) return { kind: "answered" };
      message = earlier;
    }
  }
  const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${message.id}`;
  const [noticed] = await q.select({ id: issueComments.id,
    waiting: sql<boolean>`coalesce(${issueComments.metadata}->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)`,
    waitingCode: sql<string | null>`(select r->>'value' from jsonb_array_elements(coalesce(${issueComments.metadata}->'sections', '[]'::jsonb)) sec,
      jsonb_array_elements(coalesce(sec->'rows', '[]'::jsonb)) r where r->>'label' = ${WAITING_ROW_LABEL} limit 1)` })
    .from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    sql`${reasonOf(issueComments.metadata)} = ${reason}`)).limit(1);
  // A message in the person's stopped chat list awaits Send, not recovery or
  // a resend. Read the durable queue state again under the issue fence before
  // any notice write. A clock, a cancelled carrier or a generic deferred wake
  // alone must never silence ordinary queued-message duties.
  if (!cardAnswer) {
    const [held] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, issue.companyId), eq(issueComments.id, message.id),
      personHeldChatMessageSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}` })));
    if (held) return { kind: "person_held" };
  }
  const issueRun = or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`);
  // The SENDER stopped (Stop or Interrupt) the run that had STARTED answering
  // this message: they ended it on purpose, so "send it again" would redo the
  // stopped work. Only this agent's NEWEST run on the task counts (a later
  // attempt, live or failed, decides by its own rules), only a typed message
  // that was that run's own input which the model read and began to answer
  // (an unread steer or a message queued behind it keeps its notice), and
  // only the sender's own stop (person-stopped-message.ts). A standing notice
  // for the message is superseded.
  if (!cardAnswer && message.authorUserId) {
    const [newest] = await q.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
      resultJson: heartbeatRuns.resultJson, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    if (newest && stoppedBySender(newest, message.authorUserId) && await runStartedAnswering(q, {
      companyId: issue.companyId, runId: newest.id, messageId: message.id, contextSnapshot: newest.contextSnapshot })) {
      return { kind: "person_stopped", noticeId: noticed?.id ?? null };
    }
  }
  // A standing WAITING note is still an open obligation: it must stay true.
  if (noticed && !noticed.waiting) return { kind: "noticed_before" };
  const upgrading = noticed?.waiting ? noticed.id : null;
  const standingWaitingCode = noticed?.waiting ? noticed.waitingCode ?? UNANSWERED_MESSAGE_WAITING_CODE : null;

  // The run this message started (the latest run that carries it), if any.
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
  // Paperclip's per-turn response rule (doc/execution-semantics.md:2649-2658,
  // native-governance.ts conversationTurnAnswered): only a pending question or
  // confirmation card that the message's OWN run created stands in for its
  // reply. A card from an earlier turn or one the board addressed to someone
  // else, and any approval, can hold the task but do not answer the message.
  if (messageRun && !(await conversationTurnAnswered({ db: q, companyId: issue.companyId, issueId: issue.id, runId: messageRun.id }))) {
    return { kind: "answered" };
  }

  // A failed fresh continuation that descends from the message's run is the
  // run the person's message ended on: the automatic lineage, typed or not,
  // ends there (fork-lead a6342a4d4, fresh-continuation-chain.ts).
  const latest = runs[0];
  const run = messageRun && latest && latest.id !== messageRun.id
    && ["failed", "timed_out", "interrupted", "cancelled"].includes(latest.status)
    && await freshContinuationDescendsFrom(q, { companyId: issue.companyId, issueId: issue.id,
      runId: latest.id, ancestorRunId: messageRun.id }) ? latest : messageRun;
  // A card answer's duty is its answer-resume chain ending with every run
  // failed. A chain that ended otherwise is outside this rule.
  if (cardAnswer && run && run.status === "succeeded") return { kind: "answered" };

  // Every wait for a further attempt is BOUNDED, except a turn in progress:
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
  // `deadline`: a fixed durable end that caps this wait (the failed run's end
  // + PENDING_WAIT_START_BOUND_MS for the system's own automatic recovery).
  // Past it, never start or continue a wait.
  const bounded = async (recheckAt: number, setup = false, deadline: number | null = null): Promise<Decision | null> => {
    if (deadline !== null && deadline <= now.getTime()) return null;
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
    const bound = Math.min(setup ? message.createdAt.getTime() + SETUP_WAIT_BOUND_MS : (waitT0 ?? now.getTime()) + PENDING_WAIT_BOUND_MS,
      deadline ?? Number.POSITIVE_INFINITY);
    if (bound <= now.getTime()) return null;
    return { kind: "pending", recheckAt: Math.min(recheckAt, bound),
      ...(waitT0 === null ? { recordWait: setupWaitRecord ?? { messageId: message.id, runId: messageRun?.id ?? null } } : {}) };
  };

  // Only a turn IN PROGRESS keeps an unbounded wait (a quiet healthy turn is
  // never noticed): a run that is RUNNING on this task, carrying the message
  // or not (a person's message that arrives during a long turn waits for that
  // turn to end, when its deferred wake is promoted). A hung running run is
  // still caught by Paperclip's silent active-run watchdog
  // (modules/active-run-watchdog/application/use-cases.ts:332
  // scanSilentActiveRuns; doc/execution-semantics.md §12). A QUEUED or
  // scheduled run, carrying the message or not, is bounded: one that is never
  // claimed (the agent's slots are full, or its claim is refused) must not keep
  // the person silent. When the run that waits carries the message, the note
  // says it is waiting to start, not that it failed.
  const live = runs.filter(candidate => LIVE.includes(candidate.status));
  const [otherLive] = live.length ? [] : await q.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun,
    inArray(heartbeatRuns.status, LIVE))).limit(1);
  const liveRuns = otherLive ? [...live, otherLive] : live;
  if (liveRuns.some(candidate => candidate.status === "running")) {
    return { kind: "pending", recheckAt: now.getTime() + 30_000 };
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
  if (agentPaused) {
    const due = message.createdAt.getTime() + UNANSWERED_MESSAGE_SETTLE_MS;
    if (due > now.getTime()) return { kind: "pending", recheckAt: due };
    if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_AGENT_PAUSED_CODE) {
      return { kind: "pending", recheckAt: now.getTime() + 5 * 60_000 };
    }
  }
  let waitingToStart = false;
  let continuationWaiting = false;
  if (liveRuns.length && !agentPaused && !settingUp) {
    const wait = await bounded(now.getTime() + 30_000);
    if (wait) return wait;
    for (const candidate of liveRuns) {
      // A queued successor (including an output-cap continuation) is still
      // this message's attempt even when its context no longer copies m.
      // Keep the ordinary start bound, but a proven successor is waiting
      // work, not a reason to resend its predecessor's input.
      const descendant = Boolean(messageRun && candidate.id !== messageRun.id
        && await freshContinuationDescendsFrom(q, { companyId: issue.companyId, issueId: issue.id,
          runId: candidate.id, ancestorRunId: messageRun.id, includeAnswerLineage: true }));
      if (runCarriesMessage(candidate.contextSnapshot, message.id) || descendant) waitingToStart = true;
      if (descendant) { continuationWaiting = true; break; }
    }
  }

  // A board-owned hold means nothing moves by itself: queued wakes behind it
  // do not count as a further attempt.
  const [activeRecovery] = await q.select({ id: issueRecoveryActions.id, nextAction: issueRecoveryActions.nextAction,
    ownerType: issueRecoveryActions.ownerType, wakePolicy: issueRecoveryActions.wakePolicy }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    inArray(issueRecoveryActions.status, ["active", "escalated"])))
    .orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  const boardHold = activeRecovery?.ownerType === "board" ? activeRecovery : null;
  // The system's own automatic recovery of the message's failed run
  // (automaticRecoveryPending) is bounded from that run's END: its finishedAt,
  // or its coordinator's terminal failure when that came earlier. Never from
  // the first sweep, so a late first sweep cannot start a new wait.
  let recoveryDeadline: number | null | undefined;
  const automaticRecoveryDeadline = async (): Promise<number | null> => {
    if (recoveryDeadline !== undefined) return recoveryDeadline;
    recoveryDeadline = null;
    if (run && TERMINAL.includes(run.status) && run.status !== "succeeded"
      && await automaticRecoveryPending(q, { companyId: issue.companyId, issueId: issue.id, runId: run.id })) {
      // The shared predicate scopes automatic recovery to THIS run. An older
      // predecessor's board stop must not veto it, but a real stop on this run
      // still wins, even when another action has pending restored delivery.
      const [runBoardHold] = await q.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
        eq(issueRecoveryActions.ownerType, "board"), inArray(issueRecoveryActions.status, ["active", "escalated"]),
        or(sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
          sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${run.id}`,
          sql`${issueRecoveryActions.evidence}->'freshContinuation'->>'sourceRunId' = ${run.id}`,
          sql`${run.id} = any(string_to_array(${issueRecoveryActions.fingerprint}, ':'))`))).limit(1);
      if (runBoardHold) return recoveryDeadline;
      const [terminal] = await q.select({ at: nativeRunFinalizations.updatedAt }).from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, issue.companyId), eq(nativeRunFinalizations.runId, run.id),
        eq(nativeRunFinalizations.phase, "terminal_failure"), isNotNull(nativeRunFinalizations.failureCode)));
      const end = Math.min((run.finishedAt ?? run.updatedAt).getTime(), terminal?.at?.getTime() ?? Number.POSITIVE_INFINITY);
      recoveryDeadline = end + PENDING_WAIT_START_BOUND_MS;
    }
    return recoveryDeadline;
  };
  // Read the no-run terminal evidence before pending wakes so a NEW carrying
  // queued wake can supersede it, without an older queue masking a later stop.
  const terminalWakes = !run && !agentPaused && !settingUp ? await q.select({ payload: agentWakeupRequests.payload,
    status: agentWakeupRequests.status, error: agentWakeupRequests.error, runId: agentWakeupRequests.runId,
    updatedAt: agentWakeupRequests.updatedAt }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
    inArray(agentWakeupRequests.status, ["failed", "cancelled"]), gt(agentWakeupRequests.updatedAt, message.createdAt)))
    .orderBy(desc(agentWakeupRequests.updatedAt), desc(agentWakeupRequests.createdAt)) : [];
  // Only THIS issue and message's own wake is evidence; the latest terminal
  // attempt wins over an older pause cancellation.
  const ownWakes = terminalWakes.filter(wake => wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id));
  const latestWake = ownWakes[0];
  if (!boardHold && !agentPaused && !settingUp) {
    const wakes = await q.select({ payload: agentWakeupRequests.payload, status: agentWakeupRequests.status,
      createdAt: agentWakeupRequests.createdAt })
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
    const issueWakes = wakes.filter(wake => wake.status !== "deferred" && wakeCarriesIssue(wake.payload, issue.id));
    if (pendingExecutionWait || issueWakes.length) {
      // Only the restored wakes of the run's own automatic recovery: that
      // recovery's run-end deadline caps the wait.
      const recoveryWakesOnly = !pendingExecutionWait
        && issueWakes.every(wake => typeof ((wake.payload ?? {}) as Record<string, unknown>).recoveryActionId === "string");
      const wait = await bounded(now.getTime() + 30_000, false, recoveryWakesOnly ? await automaticRecoveryDeadline() : null);
      if (wait) return wait;
      // After the short pending grace, use the existing waiting note and its
      // start bound below instead of telling the person to duplicate input.
      if (pendingExecutionWait || (!run && wakes.some(wake => wake.status === "queued"
        && wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id)
        && (!latestWake || wake.createdAt > latestWake.updatedAt)))) waitingToStart = true;
    }
  }

  let code: string;
  let recovering = false;
  if (settingUp) {
    code = UNANSWERED_MESSAGE_AGENT_SETUP_CODE;
  } else if (agentPaused) {
    code = UNANSWERED_MESSAGE_AGENT_PAUSED_CODE;
  } else if (waitingToStart) {
    // The ordinary carrying-run start bound is unchanged. A known queued
    // continuation keeps the waiting note until it starts or terminates;
    // asking for duplicate input while it remains pending is false.
    const startDeadline = (waitT0 ?? now.getTime()) + PENDING_WAIT_START_BOUND_MS;
    if (continuationWaiting || startDeadline > now.getTime()) {
      if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_WAITING_CODE) {
        return { kind: "pending", recheckAt: continuationWaiting ? now.getTime() + 30_000 : startDeadline };
      }
      code = UNANSWERED_MESSAGE_WAITING_CODE;
    } else {
      code = UNANSWERED_MESSAGE_NO_RUN_CODE;
    }
  } else if (!run) {
    // Paperclip records a deferred or coalesced wake that could not start as
    // FAILED: that is the trigger. The grace covers a wake that threw before
    // any wake row existed (the comment route logs and returns 201).
    const wakeFailed = ownWakes.some(wake => wake.status === "failed");
    const due = message.createdAt.getTime() + UNANSWERED_MESSAGE_NO_RUN_GRACE_MS;
    if (!wakeFailed && due > now.getTime()) return { kind: "pending", recheckAt: due };
    // The lifecycle driver's pausing stop cancels unbound queued/deferred wakes
    // with the pause-specific error, preserving their reason and message payload
    // (heartbeat/run-control.ts cancelPendingWakeupsForAgentsInternal). Resume
    // does not replay them. Do not apply this while setup, a hold or live work
    // takes precedence above, or to a stopped/terminating agent.
    code = agentRow?.lifecycleState === "ready" && latestWake?.status === "cancelled" && latestWake.runId === null
      && latestWake.error === AGENT_PAUSE_STOP_REASON ? PAUSE_STOPPED_CODE : UNANSWERED_MESSAGE_NO_RUN_CODE;
  } else {
    if (!TERMINAL.includes(run.status)) return { kind: "pending", recheckAt: now.getTime() + 30_000 };
    const due = (run.finishedAt ?? run.updatedAt).getTime() + UNANSWERED_MESSAGE_SETTLE_MS;
    if (due > now.getTime()) return { kind: "pending", recheckAt: due };
    // The system's own automatic recovery of this run is on its way: no
    // resend advice. The same short grace, then the true waiting note, and
    // the existing start bound: past it, today's notice below.
    // Its bound runs from the failed run's END (automaticRecoveryDeadline).
    const startDeadline = await automaticRecoveryDeadline();
    if (startDeadline !== null) {
      const wait = await bounded(now.getTime() + 30_000, false, startDeadline);
      if (wait) return wait;
      if (startDeadline > now.getTime()) {
        if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_RECOVERING_CODE) {
          return { kind: "pending", recheckAt: startDeadline };
        }
        recovering = true;
      }
    }
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
    // An intentional pause cancellation is not an unanswered failed attempt.
    // Resume does not replay operator-stopped work: give the true manual remedy.
    code = recovering ? UNANSWERED_MESSAGE_RECOVERING_CODE
      : run.status === "cancelled" && run.errorCode === "agent_paused" ? PAUSE_STOPPED_CODE
      : run.status === "succeeded" ? UNANSWERED_MESSAGE_NO_REPLY_CODE : unansweredMessageCode(run);
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
  const held = (isNativeContinuationRefusal(run) || HELD_CODES.has(code)) && !(run && isFreshThreadRefusal(run));
  const paused = code === UNANSWERED_MESSAGE_AGENT_PAUSED_CODE;
  const pauseStopped = code === PAUSE_STOPPED_CODE;
  const pausedName = agentRow?.name?.trim() || "This agent";
  const waiting = WAITING_KIND_CODES.has(code);
  // The ONE bound: the message's automatic lineage used its K=2 fresh
  // continuations and the last one failed. Nothing further starts by itself.
  const boundReached = Boolean(!paused && !pauseStopped && !waiting && run && TERMINAL.includes(run.status) && run.status !== "succeeded"
    && (await freshContinuationChain(q as Db, { companyId: issue.companyId, issueId: issue.id, runId: run.id })).attempts
      >= FRESH_CONTINUATION_BOUND);
  // Server-local HH:MM: the instance's time zone, not an assumed UTC zone.
  const since = `${String(message.createdAt.getHours()).padStart(2, "0")}:${String(message.createdAt.getMinutes()).padStart(2, "0")}`;
  const body = settingUp ? `${pausedName} is still being set up (since ${since}). Your message is saved and will be answered as soon as it's ready.`
    : paused ? agentPausedText(pausedName)
    : pauseStopped ? `${pausedName} was paused before it answered your message. Send it again to continue.`
    : code === UNANSWERED_MESSAGE_RECOVERING_CODE ? UNANSWERED_MESSAGE_RECOVERING_TEXT
    : waiting ? UNANSWERED_MESSAGE_WAITING_TEXT
    : cardAnswer ? UNANSWERED_CARD_ANSWER_TEXT
    : boundReached ? UNANSWERED_MESSAGE_BOUND_REACHED_TEXT
    : code === UNANSWERED_MESSAGE_NO_REPLY_CODE ? UNANSWERED_MESSAGE_NO_REPLY_TEXT
    : code === UNANSWERED_MESSAGE_NO_RUN_CODE ? UNANSWERED_MESSAGE_NO_RUN_TEXT
      : held ? HELD_PREDECESSOR_NOTICE : UNANSWERED_MESSAGE_TEXT;
  const notice = buildStrandedRecoveryEscalationNotice({
    seed: {
      title: settingUp ? `${pausedName} is still being set up` : paused ? `${pausedName} is paused`
        : pauseStopped ? `${pausedName} was paused before it answered`
        : code === UNANSWERED_MESSAGE_RECOVERING_CODE ? "Paperclip is recovering this run"
        : waiting ? "Your message is waiting to start"
        : cardAnswer ? "Your answer wasn't acted on" : "Your message wasn't answered",
      body,
      tone: paused ? "warning" : waiting ? "info" : "warning",
      nextAction: settingUp ? "No action is needed; your message is saved."
        : paused ? `Ask a board user or ${pausedName}'s manager to resume ${pausedName}.`
        : pauseStopped ? "Send it again to continue."
        : waiting ? "No action is needed; it will start by itself."
        : cardAnswer ? "Retry; if it fails again, assign this agent a new task."
        : held || boundReached ? "Send a new message to try again." : "Send the message again; if it fails again, assign this agent a new task.",
    },
    recoveryActionId: boardHold?.id ?? null,
    recoveryOwner: null,
    recoveryResponsibility: "user",
    sourceRun: run && !waiting ? { id: run.id, agentId: run.agentId, status: run.status, errorCode: pauseStopped ? null : code } : null,
    // A waiting note is not a failure: no "Failure code" row, a marker row instead.
    failureCode: waiting || pauseStopped ? undefined : run ? undefined : code,
  });
  if (waiting) notice.metadata.sections.push({ title: "Status", rows: [keyValueRow(WAITING_ROW_LABEL, code)] });
  return { kind: "notice", reason, code, notice, ...(setupWaitRecord ? { recordWait: setupWaitRecord } : {}),
    ...(upgrading ? { upgradeCommentId: upgrading } : {}) };
}


/** One task the recovery worker already flagged (its batched page query found
 * a person's message to settle): no candidate lookup of its own. */
export async function settleUnansweredPersonMessagesForTask(
  db: Db,
  input: { companyId: string; issueId: string; issueCreatedAtGte?: Date | null; onDeferredDeadline?: (at: number) => void; now?: Date;
    nativeBlockedRepairApplies?: NativeBlockedRepairApplies },
): Promise<{ noticed: number; pending: number }> {
  const outcome = await settleUnansweredPersonMessage(db, input);
  if (outcome.kind === "pending") input.onDeferredDeadline?.(outcome.recheckAt);
  return { noticed: outcome.kind === "noticed" ? 1 : 0, pending: outcome.kind === "pending" ? 1 : 0 };
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
    input.issueCreatedAtGte ? sql`${issues.createdAt} >= ${input.issueCreatedAtGte.toISOString()}::timestamptz` : undefined,
    unansweredPersonMessageCondition(issues.id, issues.companyId),
  )).limit(200);
  const result = { noticed: 0, pending: 0 };
  for (const candidate of candidates) {
    const outcome = await settleUnansweredPersonMessage(db, { companyId: candidate.companyId, issueId: candidate.id, now: input.now,
      nativeBlockedRepairApplies: input.nativeBlockedRepairApplies });
    if (outcome.kind === "noticed") result.noticed += 1;
    if (outcome.kind === "pending") {
      result.pending += 1;
      input.onDeferredDeadline?.(outcome.recheckAt);
    }
  }
  return result;
}
