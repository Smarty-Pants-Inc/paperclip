import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { answeredPersonMessageSql, deferredWakeIsStaleSql, failedCarrierRunSql, personMessageOwedSql } from "../person-message-answer.js";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
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
import { conversationTurnAnswered } from "../native-runtime/native-governance.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";
import { noticeMetadataReferencesRecoveryAction } from "./successful-run-handoff.js";
import { keyValueRow } from "./notice-format.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { freshContinuationChain, freshContinuationDescendsFrom } from "../fresh-continuation-chain.js";
import { nativeStartupNeverConnectedExhausted } from "../continuation-cause.js";
import { isFreshThreadRefusal } from "../native-runtime/runner-reconciliation-refusal.js";
import { isNativeContinuationRefusal, isRecoverableNativeSupervisionFailure } from "../native-continuation-refusal.js";
import { REMOTE_RUNNER_SUPERVISION_EXHAUSTED, REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION } from "../native-runtime/remote-runner-recovery-diagnostics.js";
import { AGENT_LIFECYCLE_STOP_REASON } from "../governance-pause-stop.js";

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
 * started by T0 + this bound, the SAME note becomes the failure text. */
export const PENDING_WAIT_START_BOUND_MS = 10 * 60_000;
/** The non-failure marker row of a waiting note (no "Failure code" row). */
const WAITING_ROW_LABEL = "Waiting code";
const WAITING_ROW_JSON = JSON.stringify([{ rows: [{ label: WAITING_ROW_LABEL }] }]);
/** The agent that answers the conversation is paused (or held) and will not
 * run until it is resumed. Not a failure: a waiting-kind note. */
export const UNANSWERED_MESSAGE_AGENT_PAUSED_CODE = "agent_paused";
/** A resumed agent's own pause cancelled this message's unbound wake, not a failure.
 * Started runs retain final5c3's existing started-run notice policy. */
const PAUSE_STOPPED_CODE = "agent_pause_stopped";
/** Setup completes by itself; a stalled setup gets one factual waiting note. */
export const UNANSWERED_MESSAGE_AGENT_SETUP_CODE = "agent_setup";
export const SETUP_WAIT_BOUND_MS = 10 * 60_000;
/** A run whose OWN input carries the message is RUNNING: the agent is working
 * on it (the note a Resume's stale paused note becomes). Waiting-kind, so the
 * answer supersedes it; never left standing over a run that has ended. */
export const UNANSWERED_MESSAGE_WORKING_CODE = "working_on_message";
/** The working note's wording, in ONE place (RFL's wording record changes it here). */
export const UNANSWERED_MESSAGE_WORKING_TEXT = (name: string) => `${name} is working on your message.`;
export const UNANSWERED_MESSAGE_WORKING_TITLE = (name: string) => `${name} is working on it`;
/** RFL record SUPERSEDE-BPRIME3-NOTICE-WORDING-1118: after a run STARTED, 'safe' is unproven. */
export const UNANSWERED_MESSAGE_STARTED_FAILED_TEXT = "Your message wasn't answered. "
  + "Check the task's recent history before trying again; the run may have taken actions.";
export const UNANSWERED_MESSAGE_STARTED_NO_REPLY_TEXT = "This run finished without a reply to your message. "
  + "Check the task's recent history before trying again; the run may have taken actions.";
const UNANSWERED_MESSAGE_STARTED_NEXT_ACTION = "Check the task's recent history before trying again.";
const WAITING_KIND_CODES = new Set(["waiting_to_start", "agent_paused", UNANSWERED_MESSAGE_AGENT_SETUP_CODE,
  UNANSWERED_MESSAGE_WORKING_CODE]);
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
export const UNANSWERED_MESSAGE_WAITING_TEXT =
  "Your message is waiting for the agent to be free; it will start by itself.";
export const UNANSWERED_MESSAGE_NO_REPLY_TEXT =
  "This run finished without a reply to your message. Sending it again is safe.";
/** A carried steer (a person's message steered mid-task, restored at its run end because that turn did not answer
 * it, then carried into the next turn) whose carrying turn ended failed or cancelled without answering it. */
export const UNANSWERED_CARRIED_STEER_FAILED_TEXT =
  "Your message (received mid-task) wasn't answered because the run failed. Sending it again is safe.";
export const UNANSWERED_CARRIED_STEER_STOPPED_TEXT =
  "Your message (received mid-task) wasn't answered because the run was stopped. Sending it again is safe.";
const CARRIED_STEER_FAILED_ENDS = ["failed", "cancelled", "timed_out", "interrupted"];
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
/**
 * SQL: message m's card is retired (each card retires on its OWN message):
 * m was answered (the ONE answered predicate), m was deleted, or the person
 * sent it again: a later message by the same person, saved after the card,
 * with the SAME text, that the ONE answered predicate says is answered. No
 * second 'answered' definition: the resend's answer is read through
 * answeredSql. A different later message never retires it (L1b).
 */
function noticeRetiredSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }, deletedAt: SQL, noticeCreatedAt: SQL): SQL {
  return sql`(${deletedAt} is not null or ${answeredSql(m)}
    or exists (select 1 from ${issueComments} again where again.company_id = ${m.companyId} and again.issue_id = ${m.issueId}
      and again.author_type = 'user' and again.deleted_at is null and again.id <> ${m.id}
      and exists (select 1 from ${issueComments} src where src.id = ${m.id}
        and src.author_user_id is not distinct from again.author_user_id and btrim(src.body) = btrim(again.body))
      and again.created_at > ${noticeCreatedAt}
      and ${answeredSql(rawMessage("again"))}))`;
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
        and ${personMessageOwedSql(rawMessage("m"))}
        and not exists (select 1 from ${issueComments} n where n.company_id = m.company_id and n.issue_id = m.issue_id
          and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || m.id::text
          and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or exists (select 1 from ${issueComments} n
      join ${issueComments} m on m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and ${noticeRetiredSql(rawMessage("m"), sql.raw("m.deleted_at"), sql.raw("n.created_at"))}))`;
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
      and ${personMessageOwedSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}
      and not exists (select 1 from ${issueComments} n where n.company_id = ${issueComments.companyId}
        and n.issue_id = ${issueComments.issueId}
        and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || ${issueComments.id}::text
        and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or (${issueComments.authorType} = 'system' and ${issueComments.deletedAt} is null
      and starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and exists (select 1 from ${issueComments} m
        where m.company_id = ${issueComments.companyId} and m.issue_id = ${issueComments.issueId}
          and m.id::text = substr(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
          and ${noticeRetiredSql(rawMessage("m"), sql.raw("m.deleted_at"), sql`${issueComments.createdAt}`)})))`;
}

export type UnansweredMessageOutcome =
  | { kind: "none" | "answered" | "noticed_before" | "explained" | "out_of_scope" }
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

/** A stale deferred receipt cannot postpone its never-carried message's true
 * card. Queued receipts keep their existing waiting semantics. */
function nonStaleWakeCondition(issueId: string): SQL {
  return sql`(${agentWakeupRequests.status} not in ('deferred', 'deferred_issue_execution') or not ${deferredWakeIsStaleSql({
    companyId: sql`${agentWakeupRequests.companyId}`, agentId: sql`${agentWakeupRequests.agentId}`,
    issueId: sql`${issueId}::uuid`, requestedAt: sql`${agentWakeupRequests.requestedAt}`, payload: sql`${agentWakeupRequests.payload}`,
  })})`;
}

/** One task, or one named message whose wake just settled. Idempotent. */
/** The recovery service's own native blocked-request repair check (it publishes
 * the run's unblock request itself when it applies). */
export type NativeBlockedRepairApplies = (input: { companyId: string; issueId: string; runId: string }, database: Db) => Promise<boolean>;

export async function settleUnansweredPersonMessage(
  db: Db,
  input: { companyId: string; issueId: string; settleMessageId?: string; now?: Date; issueCreatedAtGte?: Date | null;
    nativeBlockedRepairApplies?: NativeBlockedRepairApplies; olderOutcomes?: UnansweredMessageOutcome[] },
): Promise<UnansweredMessageOutcome> {
  const now = input.now ?? new Date();
  const [issue] = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status, hiddenAt: issues.hiddenAt,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt,
  }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue) return { kind: "none" };
  if (input.issueCreatedAtGte && issue.createdAt < input.issueCreatedAtGte) return { kind: "out_of_scope" };
  // Event-driven receipt settlement uses the SAME per-message decision/writer
  // as the sweep, without its discovery age/page limits or unrelated messages.
  if (input.settleMessageId) return (await settleOneMessage(db, issue, now, input.nativeBlockedRepairApplies, input.settleMessageId)).outcome;

  // An answer to a message supersedes that message's notice (and its
  // retrying line): the relation is message -> answer, not the notice's time.
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
      and exists (select 1 from ${issueComments} m where m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', strpos(n.metadata->>'authorizationReason', ':') + 1)
        and ${noticeRetiredSql(rawMessage("m"), sql.raw("m.deleted_at"), sql.raw("n.created_at"))})`);
  });

  // The AGREED order (adopt-lead + rf-4, 10:09Z), one card per message:
  // (a) cut A's carried steers FIRST: a carried steer whose carrying turn failed or was stopped gets its own ONE
  //     notice (same key, same fence), also when a later message is the latest one;
  // (b) then the NEWEST message (its outcome kinds unchanged; it sees (a)'s notice by its key);
  // (c) then each OLDER message the ONE answered predicate says is owed (RFL 09:03Z), newest first, at most
  //     OWED_OLDER_MESSAGES_PER_SWEEP per task per pass. The older selection SKIPS every message (a) just noticed,
  //     by the notice key, so a carried steer never gets a second card from (c).
  const carried = await settleCarriedSteerNotices(db, issue, now);
  const newest = await settleOneMessage(db, issue, now, input.nativeBlockedRepairApplies, null);
  const older: UnansweredMessageOutcome[] = [];
  if (newest.outcome.kind !== "out_of_scope" && newest.outcome.kind !== "none" && newest.messageId) {
    for (const id of await owedOlderMessageIds(db, issue, newest.messageId, carried.noticedReasons)) {
      older.push((await settleOneMessage(db, issue, now, input.nativeBlockedRepairApplies, id)).outcome);
    }
  }
  // Returned: the newest's 'noticed' wins; else (a)'s noticed; else, when the newest or (a) is pending, pending at
  // the MIN over the newest, the carried and the older pending; else the newest's own outcome (its contract
  // unchanged). Every older outcome, noticed or pending, goes to input.olderOutcomes: the sweep counts each card
  // and registers each deadline from there, so an older card is never returned in place of the newest's outcome.
  const pendingAt = [newest.outcome, ...older].flatMap(each => each.kind === "pending" ? [each.recheckAt] : [])
    .concat(carried.recheckAt !== null ? [carried.recheckAt] : []);
  const returned: UnansweredMessageOutcome = newest.outcome.kind === "noticed" ? newest.outcome
    : carried.noticed
      ?? (newest.outcome.kind === "pending" || carried.recheckAt !== null
        ? { kind: "pending", recheckAt: Math.min(...pendingAt) } : newest.outcome);
  input.olderOutcomes?.push(...older);
  return returned;
}

/** The per-sweep bound on OLDER owed messages settled for one task in one pass. */
export const OWED_OLDER_MESSAGES_PER_SWEEP = 20;

/** The older person messages on this task that the ONE answered predicate says
 * are owed, in discovery scope, with no final (non-waiting) card yet, and that
 * never REACHED the agent (no run's input lists them: the reached clause's
 * case) or whose ONLY carriers FAILED without a reply (failedCarrierRunSql,
 * the answered rule's own L1b notion; G1: a steered message whose run failed
 * stays owed and is told once). An older message a run carried otherwise (live,
 * succeeded, stopped, or a failed run that replied) keeps today's newest-only reading.
 * `skipReasons`: the notice keys this pass's carried-steer step (a) just noticed; those messages are skipped. */
async function owedOlderMessageIds(db: Db, issue: DecisionIssue, newestId: string, skipReasons: string[]): Promise<string[]> {
  const rows = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    sql`${issueComments.id} <> ${newestId}`, unansweredPersonMessageCommentCondition(),
    skipReasons.length > 0 ? notInArray(sql`${UNANSWERED_MESSAGE_REASON_PREFIX} || ${issueComments.id}::text`, skipReasons) : undefined,
    sql`not exists (select 1 from ${heartbeatRuns} r where r.company_id = ${issueComments.companyId}
      and (r.context_snapshot->>'wakeCommentId' = ${issueComments.id}::text or r.context_snapshot->>'commentId' = ${issueComments.id}::text
        or r.context_snapshot->>'conversationReplyBoundaryCommentId' = ${issueComments.id}::text
        or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? ${issueComments.id}::text
        or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? ${issueComments.id}::text)
      and not ${failedCarrierRunSql("r", { id: sql`${issueComments.id}` })})`,
    // One card per failed carrier's batch (interrupt-lostdouble L1/L1b): a failed run that carried m AND a LATER
    // message still owed is told by that later message's card (the newest's, or its own older pick), never twice.
    sql`not exists (select 1 from ${heartbeatRuns} fb where fb.company_id = ${issueComments.companyId}
      and ${failedCarrierRunSql("fb", { id: sql`${issueComments.id}` })}
      and exists (select 1 from ${issueComments} later where later.company_id = ${issueComments.companyId}
        and later.issue_id = ${issueComments.issueId} and later.author_type = 'user' and later.deleted_at is null
        and later.created_at > ${issueComments.createdAt}
        and ${failedCarrierRunSql("fb", { id: sql.raw("later.id") })}
        and not ${answeredPersonMessageSql(rawMessage("later"))}))`,
    eq(issueComments.authorType, "user")))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(OWED_OLDER_MESSAGES_PER_SWEEP);
  return rows.map(row => row.id);
}

async function settleOneMessage(db: Db, issue: DecisionIssue, now: Date,
  nativeBlockedRepairApplies: NativeBlockedRepairApplies | undefined, messageId: string | null,
): Promise<{ outcome: UnansweredMessageOutcome; messageId: string | null }> {
  const input = { nativeBlockedRepairApplies };
  const decided = { messageId: messageId as string | null };
  const decision = await decideUnansweredMessage(db, issue, now, input.nativeBlockedRepairApplies, messageId, decided);
  const done = (outcome: UnansweredMessageOutcome) => ({ outcome, messageId: decided.messageId });
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
    return done({ kind: "pending", recheckAt: decision.recheckAt });
  }
  if (decision.kind !== "notice") return done(decision);
  const commentId = await db.transaction(async tx => {
    // The issue fence that comment writers, the executor's held-notice writer
    // and execution admission take. The SAME predicate is evaluated again
    // under it: an answer (prose or the turn's own card), a held notice, a
    // newer message, a run or a wake that committed while this sweep waited
    // means no notice.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    // The newest message is re-read as the newest (a newer message that
    // committed meanwhile means no card here); an older owed one by its id.
    const fenced = await decideUnansweredMessage(tx as unknown as Db, issue, now, input.nativeBlockedRepairApplies, messageId);
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
  return done(commentId ? { kind: "noticed", code: decision.code, commentId } : { kind: "noticed_before" });
}

type CarriedSteerNotice = { reason: string; code: string; upgradeCommentId: string | null;
  notice: ReturnType<typeof buildStrandedRecoveryEscalationNotice> };

/**
 * Carried steers (restoreUnansweredSteersAtRunEnd: resultJson.restoredSteeredCommentIds; S10 C1:
 * stopRestoredSteeredCommentIds) that the turn carrying them ended FAILED or cancelled without answering, with
 * nothing further that will deliver them (no live run carrying it, no waiting wake holding it). Each gets ONE
 * notice under its message's own key (unanswered_message:<id>); never a silent answered-mark, never twice. Reads only.
 */
async function decideCarriedSteerNotices(q: Db, issue: DecisionIssue, now: Date):
  Promise<{ notices: CarriedSteerNotice[]; recheckAt: number | null }> {
  const none = { notices: [], recheckAt: null };
  if (issue.hiddenAt || !issue.assigneeAgentId || issue.assigneeUserId
    || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) return none;
  const agentId = issue.assigneeAgentId;
  const since = new Date(now.getTime() - UNANSWERED_MESSAGE_LOOKBACK_MS);
  const issueRun = or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`);
  const restorers = await q.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun,
    sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) > ${since.toISOString()}::timestamptz`,
    sql`(${heartbeatRuns.resultJson} ? 'restoredSteeredCommentIds' or ${heartbeatRuns.resultJson} ? 'stopRestoredSteeredCommentIds')`));
  const restoredIds = (result: unknown) => {
    const value = (result ?? {}) as Record<string, unknown>;
    return [value.restoredSteeredCommentIds, value.stopRestoredSteeredCommentIds]
      .flatMap((ids) => Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  };
  const ids = [...new Set(restorers.flatMap((row) => restoredIds(row.resultJson)))]
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (ids.length === 0) return none;
  const messages = await q.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id), inArray(issueComments.id, ids),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
    // neworg-floor-custody (rf-4 C1): the same ONE floor as the outbox and decideMessage; a restored steer
    // the chat moved on past gets no card, one still in custody or carried after the move-on run keeps it.
    personMessageOwedSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })));
  if (messages.length === 0) return none;
  const runs = await q.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
    error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson,
    contextSnapshot: heartbeatRuns.contextSnapshot, finishedAt: heartbeatRuns.finishedAt, updatedAt: heartbeatRuns.updatedAt,
    createdAt: heartbeatRuns.createdAt, issueCommentStatus: heartbeatRuns.issueCommentStatus }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun,
    sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt}) > ${since.toISOString()}::timestamptz`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(50);
  const wakes = await q.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
    inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
    nonStaleWakeCondition(issue.id),
    // A wake already promoted into a run is that run's: the run's own end decides.
    isNull(agentWakeupRequests.runId)));
  const notices: CarriedSteerNotice[] = [];
  let recheckAt: number | null = null;
  for (const message of messages) {
    // The turn that carried it after its restore: never the run that restored it (that run no longer carries it).
    const carriers = runs.filter((run) => runCarriesMessage(run.contextSnapshot, message.id)
      && !restoredIds(run.resultJson).includes(message.id));
    const carrying = carriers[0];
    if (!carrying || carriers.some((run) => LIVE.includes(run.status))) continue;
    if (!CARRIED_STEER_FAILED_ENDS.includes(carrying.status)) continue;
    if (wakes.some((wake) => wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id))) continue;
    const code = unansweredMessageCode(carrying);
    // A held conversation has its own notice ("send a new message"), never "sending it again is safe".
    if (HELD_CODES.has(code) || isNativeContinuationRefusal(carrying)) continue;
    const due = (carrying.finishedAt ?? carrying.updatedAt).getTime() + UNANSWERED_MESSAGE_SETTLE_MS;
    if (due > now.getTime()) { recheckAt = Math.min(recheckAt ?? due, due); continue; }
    // A same-run retry or a pending native finalization is a further attempt that still carries it: not yet.
    const [coordinator] = await q.select({ phase: nativeRunFinalizations.phase, nextAttemptAt: nativeRunFinalizations.nextAttemptAt })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, issue.companyId),
        eq(nativeRunFinalizations.runId, carrying.id)));
    if (carrying.issueCommentStatus === "retry_queued" || (coordinator && (NATIVE_PENDING_PHASES.includes(coordinator.phase)
      || (coordinator.phase === "retryable_failure"
        && (!coordinator.nextAttemptAt || coordinator.nextAttemptAt.getTime() + OVERDUE_NATIVE_RETRY_MS > now.getTime()))))) {
      const later = now.getTime() + 30_000;
      recheckAt = Math.min(recheckAt ?? later, later);
      continue;
    }
    const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${message.id}`;
    const [noticed] = await q.select({ id: issueComments.id,
      waiting: sql<boolean>`coalesce(${issueComments.metadata}->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)` })
      .from(issueComments).where(and(eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
        sql`${reasonOf(issueComments.metadata)} = ${reason}`)).limit(1);
    if (noticed && !noticed.waiting) continue;
    const stopped = carrying.status === "cancelled";
    notices.push({ reason, code, upgradeCommentId: noticed?.id ?? null, notice: buildStrandedRecoveryEscalationNotice({
      seed: { title: "Your message wasn't answered", tone: "warning",
        body: stopped ? UNANSWERED_CARRIED_STEER_STOPPED_TEXT : UNANSWERED_CARRIED_STEER_FAILED_TEXT,
        nextAction: "Send the message again; if it fails again, assign this agent a new task." },
      recoveryActionId: null, recoveryOwner: null, recoveryResponsibility: "user",
      sourceRun: { id: carrying.id, agentId: carrying.agentId, status: carrying.status, errorCode: code },
    }) });
  }
  return { notices, recheckAt };
}

/** Posts the carried-steer notices; each is decided again unchanged under the issue fence before it is written. */
async function settleCarriedSteerNotices(db: Db, issue: DecisionIssue, now: Date):
  Promise<{ noticed: UnansweredMessageOutcome | null; noticedReasons: string[]; recheckAt: number | null }> {
  const decided = await decideCarriedSteerNotices(db, issue, now);
  let noticed: UnansweredMessageOutcome | null = null;
  const noticedReasons: string[] = [];
  for (const candidate of decided.notices) {
    const commentId = await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues)
        .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
      const fenced = (await decideCarriedSteerNotices(tx as unknown as Db, issue, now)).notices
        .find((entry) => entry.reason === candidate.reason && entry.upgradeCommentId === candidate.upgradeCommentId);
      if (!fenced) return null;
      if (fenced.upgradeCommentId) {
        // The message's standing waiting note becomes this text: still one note.
        const [updated] = await tx.update(issueComments).set({ body: fenced.notice.body, presentation: fenced.notice.presentation,
          metadata: { ...fenced.notice.metadata, authorizationReason: fenced.reason }, updatedAt: now })
          .where(and(eq(issueComments.id, fenced.upgradeCommentId), eq(issueComments.companyId, issue.companyId),
            isNull(issueComments.deletedAt))).returning({ id: issueComments.id });
        return updated?.id ?? null;
      }
      const comment = await issueService(tx as unknown as Db).addComment(issue.id, fenced.notice.body, {}, {
        authorType: "system", presentation: fenced.notice.presentation,
        metadata: { ...fenced.notice.metadata, authorizationReason: fenced.reason },
      }, tx);
      return comment?.id ?? null;
    });
    if (commentId) {
      noticed ??= { kind: "noticed", code: candidate.code, commentId };
      noticedReasons.push(candidate.reason);
    }
  }
  return { noticed, noticedReasons, recheckAt: decided.recheckAt };
}

type DecisionIssue = { id: string; companyId: string; status: string; hiddenAt: Date | null;
  assigneeAgentId: string | null; assigneeUserId: string | null };
type WaitRecord = { messageId: string; runId: string | null; waitKind?: "setup"; startedAt?: string; boundMs?: number };
type Decision = Exclude<UnansweredMessageOutcome, { kind: "noticed" | "pending" }>
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
 * case, and again unchanged inside it before writing. Reads only.
 * A standing '<agent> is paused' note is true only while the agent is paused:
 * once it is not, the SAME sweep replaces it in place with the one waiting
 * note wherever the decision would otherwise only wait (a running or queued
 * turn, a resume in progress, a grace), never leaving it standing. A
 * decision that writes (an answer, a failure text, a setup note) supersedes
 * it in place as before. */
async function decideUnansweredMessage(q: Db, issue: DecisionIssue, now: Date,
  nativeBlockedRepairApplies?: NativeBlockedRepairApplies, messageId: string | null = null,
  decided?: { messageId: string | null }): Promise<Decision> {
  const standing: { replacePaused?: (pending: Extract<Decision, { kind: "pending" }>) => Decision } = {};
  const decision = await decideMessage(q, issue, now, nativeBlockedRepairApplies, standing, messageId, decided);
  return decision.kind === "pending" && standing.replacePaused ? standing.replacePaused(decision) : decision;
}

async function decideMessage(q: Db, issue: DecisionIssue, now: Date,
  nativeBlockedRepairApplies: NativeBlockedRepairApplies | undefined,
  standing: { replacePaused?: (pending: Extract<Decision, { kind: "pending" }>) => Decision },
  messageId: string | null = null, decided?: { messageId: string | null }): Promise<Decision> {
  if (issue.hiddenAt || !issue.assigneeAgentId || issue.assigneeUserId
    || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) return { kind: "out_of_scope" };
  const agentId = issue.assigneeAgentId;

  const [message] = await q.select({ id: issueComments.id, createdAt: issueComments.createdAt,
    body: issueComments.body, authorUserId: issueComments.authorUserId }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt),
    // The message this decision is for: a named owed message, else the newest.
    messageId ? eq(issueComments.id, messageId) : undefined))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  if (decided && message) decided.messageId = message.id;
  // No age cut here: discovery (inScopeSql) decides which messages are in
  // scope, so an open obligation is never dropped silently by age.
  if (!message) return { kind: "none" };
  const [answer] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    // adopt-held-floor3: the ONE floor shared with the outbox; below it (answered, moved on past, behind /new) no card.
    eq(issueComments.id, message.id), sql`not ${personMessageOwedSql({ id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
      issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}`)).limit(1);
  if (answer) return { kind: "answered" };
  const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${message.id}`;
  const [noticed] = await q.select({ id: issueComments.id,
    waiting: sql<boolean>`coalesce(${issueComments.metadata}->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)`,
    waitingCode: sql<string | null>`(select r->>'value' from jsonb_array_elements(coalesce(${issueComments.metadata}->'sections', '[]'::jsonb)) sec,
      jsonb_array_elements(coalesce(sec->'rows', '[]'::jsonb)) r where r->>'label' = ${WAITING_ROW_LABEL} limit 1)` })
    .from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    sql`${reasonOf(issueComments.metadata)} = ${reason}`)).limit(1);
  // A standing WAITING note is still an open obligation: it must stay true.
  if (noticed && !noticed.waiting) return { kind: "noticed_before" };
  const upgrading = noticed?.waiting ? noticed.id : null;
  const standingWaitingCode = noticed?.waiting ? noticed.waitingCode ?? UNANSWERED_MESSAGE_WAITING_CODE : null;

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
  // Stop means stop: the message's own sender stopped this task's latest turn
  // (the chat bar's own reading, routes/issues.ts buildQueuedCommentQueue)
  // after this message was saved (ruling (b): the SENDER's Stop only; another
  // person's Stop leaves the sender's card). The stopped message and any
  // message held by that Stop are the sender's to send again; a newer run (a
  // typed message, the held batch) is newer than the Stop and ends this, so
  // its failure still shows.
  const stop = (latest?.resultJson ?? {}) as Record<string, unknown>;
  if (latest?.status === "cancelled" && stop.cancelledByActorType === "user" && !stop.queuedCommentInterruptQueueId
    && typeof stop.cancelledByUserId === "string" && !!message.authorUserId && stop.cancelledByUserId === message.authorUserId
    && message.createdAt <= (latest.finishedAt ?? latest.updatedAt)) return { kind: "explained" };
  const run = messageRun && latest && latest.id !== messageRun.id
    && ["failed", "timed_out", "interrupted", "cancelled"].includes(latest.status)
    && await freshContinuationDescendsFrom(q, { companyId: issue.companyId, issueId: issue.id,
      runId: latest.id, ancestorRunId: messageRun.id }) ? latest : messageRun;

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
  // The agent is paused only while a pause a person can act on holds NOW
  // (Paperclip's lifecycle, modules/agent-lifecycle/adapters/postgres.ts):
  // a lifecycle HOLD (the pause route adds its reason, :197; Resume removes
  // it, :198; budget and company_paused are holds too, :272-289), or, in a
  // paused-like state, an explicit pauseReason with no hold or a lifecycle
  // error. 'resuming' is never paused: Resume (or 'complete' with no hold,
  // :206) moved it there and it ends in ready by itself (domain/policy.ts).
  // Nothing runs while paused, so "sending it again" would do nothing: the
  // note says it is paused and who can resume it (a waiting-kind note).
  const [agentRow] = await q.select({ name: agents.name, status: agents.status, lifecycleState: agents.lifecycleState,
    lifecycleHolds: agents.lifecycleHolds, pauseReason: agents.pauseReason, lifecycleError: agents.lifecycleError })
    .from(agents).where(and(eq(agents.companyId, issue.companyId), eq(agents.id, agentId)));
  const holds = agentRow?.lifecycleHolds ?? [];
  const setupShape = Boolean(agentRow?.status === "paused" && ["preparing", "verifying"].includes(agentRow.lifecycleState)
    && (agentRow.pauseReason == null || agentRow.pauseReason === "setup") && holds.length === 0 && !agentRow.lifecycleError);
  const resuming = agentRow?.lifecycleState === "resuming";
  const pausedLike = Boolean(agentRow && (agentRow.status === "paused" || ["paused", "pausing"].includes(agentRow.lifecycleState)));
  const agentPaused = Boolean(!setupShape && !resuming && agentRow && (holds.length > 0
    || (pausedLike && (agentRow.pauseReason != null || Boolean(agentRow.lifecycleError)))));
  // A paused-like state that no pause holds ('resuming'; 'pausing'/'paused'
  // with no hold, reason or error: an environment handoff,
  // adapters/configuration.ts:48, or a Resume during 'pausing') ends by
  // itself: its saved message waits, bounded.
  const lifecycleTransit = Boolean(!setupShape && !agentPaused && (resuming || pausedLike));
  // The standing paused note stops being true the moment the agent is not
  // paused: whatever this sweep would only wait for, the SAME note becomes
  // the one waiting note now (upgrade in place; its answer supersedes it).
  // Working ONLY while a run whose OWN input carries the message is RUNNING
  // (not queued, claimed or scheduled_retry, nor another message's or
  // another task's run): then the agent is answering it, not waiting.
  const working = liveRuns.some(candidate => candidate.status === "running"
    && runCarriesMessage(candidate.contextSnapshot, message.id));
  // A standing working note stops being true the moment that run is no longer
  // running: whatever this sweep would only wait for, the SAME note becomes
  // the waiting note (a further attempt carries it) or, once its run ended
  // and settled, RFL's started-run text. Never left over an ended run.
  const standingWorking = !agentPaused && !working && upgrading && standingWaitingCode === UNANSWERED_MESSAGE_WORKING_CODE;
  // A standing waiting-to-start note stops being true the moment that same
  // own run is RUNNING: the SAME note becomes the working note (whichever
  // path wrote it: a Resume, or a queued start that took a while).
  const standingWaitingStarted = !agentPaused && working && upgrading && standingWaitingCode === UNANSWERED_MESSAGE_WAITING_CODE;
  if (standingWorking || standingWaitingStarted
    || (!agentPaused && upgrading && standingWaitingCode === UNANSWERED_MESSAGE_AGENT_PAUSED_CODE)) {
    standing.replacePaused = pending => {
      const ended = run && TERMINAL.includes(run.status) ? run : null;
      if (standingWorking && ended && !liveRuns.some(candidate => runCarriesMessage(candidate.contextSnapshot, message.id))) {
        const due = (ended.finishedAt ?? ended.updatedAt).getTime() + UNANSWERED_MESSAGE_SETTLE_MS;
        if (due > now.getTime()) return { kind: "pending", recheckAt: Math.min(pending.recheckAt, due) };
        const code = ended.status === "succeeded" ? UNANSWERED_MESSAGE_NO_REPLY_CODE : unansweredMessageCode(ended);
        const notice = buildStrandedRecoveryEscalationNotice({
          seed: { title: "Your message wasn't answered", tone: "warning", nextAction: UNANSWERED_MESSAGE_STARTED_NEXT_ACTION,
            body: ended.status === "succeeded" ? UNANSWERED_MESSAGE_STARTED_NO_REPLY_TEXT : UNANSWERED_MESSAGE_STARTED_FAILED_TEXT },
          recoveryActionId: null, recoveryOwner: null, recoveryResponsibility: "user",
          sourceRun: { id: ended.id, agentId: ended.agentId, status: ended.status, errorCode: code }, failureCode: undefined,
        });
        return { kind: "notice", reason, code, notice, upgradeCommentId: upgrading };
      }
      if (working) {
        const name = agentRow?.name?.trim() || "This agent";
        const notice = buildStrandedRecoveryEscalationNotice({
          seed: { title: UNANSWERED_MESSAGE_WORKING_TITLE(name), body: UNANSWERED_MESSAGE_WORKING_TEXT(name), tone: "info" },
          recoveryActionId: null, recoveryOwner: null, recoveryResponsibility: "user", sourceRun: null, failureCode: undefined,
        });
        // No next action: nothing for the person to do while it works.
        notice.metadata.sections = notice.metadata.sections
          .map(section => ({ ...section, rows: section.rows.filter(row => row.label !== "Next action") }))
          .filter(section => section.rows.length > 0);
        notice.metadata.sections.push({ title: "Status", rows: [keyValueRow(WAITING_ROW_LABEL, UNANSWERED_MESSAGE_WORKING_CODE)] });
        return { kind: "notice", reason, code: UNANSWERED_MESSAGE_WORKING_CODE, notice, upgradeCommentId: upgrading };
      }
      const notice = buildStrandedRecoveryEscalationNotice({
        seed: { title: "Your message is waiting to start", body: UNANSWERED_MESSAGE_WAITING_TEXT, tone: "info",
          nextAction: "No action is needed; it will start by itself." },
        recoveryActionId: null, recoveryOwner: null, recoveryResponsibility: "user", sourceRun: null, failureCode: undefined,
      });
      notice.metadata.sections.push({ title: "Status", rows: [keyValueRow(WAITING_ROW_LABEL, UNANSWERED_MESSAGE_WAITING_CODE)] });
      return { kind: "notice", reason, code: UNANSWERED_MESSAGE_WAITING_CODE, notice, upgradeCommentId: upgrading,
        ...(pending.recordWait ? { recordWait: pending.recordWait } : {}) };
    };
  }
  if (liveRuns.some(candidate => candidate.status === "running")) {
    return { kind: "pending", recheckAt: now.getTime() + 30_000 };
  }
  // Setup uses the compatibility status "paused", but completes by itself.
  // Its saved message remains an obligation: use the existing sweep deadline
  // and bound, never a second wake. After ten minutes, one true setup note
  // stands until readiness or error. Explicit holds/pauses/errors keep their path.
  let settingUp = false;
  if (setupShape) {
    const wait = await bounded(now.getTime() + 30_000, true);
    if (wait) return wait;
    if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_AGENT_SETUP_CODE) {
      return { kind: "pending", recheckAt: now.getTime() + 30_000 };
    }
    settingUp = true;
  }
  // Import intentionally parks automations until activation. It lost neither
  // the message nor an attempt: do not annotate every carried-over open task.
  // Resume's existing eligibility notification rechecks the saved work.
  if (agentPaused && agentRow?.pauseReason === "import" && (agentRow.lifecycleHolds ?? []).every(hold => hold === "import")) {
    return { kind: "none" };
  }
  if (agentPaused) {
    const due = message.createdAt.getTime() + UNANSWERED_MESSAGE_SETTLE_MS;
    if (due > now.getTime()) return { kind: "pending", recheckAt: due };
    // The standing recheck stays 5 min: a Resume does not wait for it. The
    // resume transition's own effect (notifyPausedNoteResume) hands each of
    // the agent's tasks with this note to the sweep's per-issue entry now.
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

  if (lifecycleTransit && !waitingToStart) {
    const wait = await bounded(now.getTime() + 30_000);
    if (wait) return wait;
    waitingToStart = true;
  }

  // A board-owned hold means nothing moves by itself: queued wakes behind it
  // do not count as a further attempt.
  const [activeRecovery] = await q.select({ id: issueRecoveryActions.id, nextAction: issueRecoveryActions.nextAction,
    ownerType: issueRecoveryActions.ownerType, wakePolicy: issueRecoveryActions.wakePolicy }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    inArray(issueRecoveryActions.status, ["active", "escalated"])))
    .orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  const boardHold = activeRecovery?.ownerType === "board" ? activeRecovery : null;
  if (!boardHold && !agentPaused && !settingUp) {
    const wakes = await q.select({ payload: agentWakeupRequests.payload, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
        nonStaleWakeCondition(issue.id),
        or(inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"]),
          and(eq(agentWakeupRequests.status, "deferred"), wellFormedExecutionWaitSql(agentWakeupRequests.payload)))));
    // Admission has saved a real further attempt for THIS message, not a
    // failed start. Coalesced receipts alone are not live; missing/malformed
    // waits retain the ordinary no-run/failure decision.
    const pendingExecutionWait = wakes.some(wake => ["deferred", "deferred_issue_execution"].includes(wake.status)
      && isWellFormedExecutionWait(wake.payload?.executionWait)
      && wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id));
    if (pendingExecutionWait || wakes.some(wake => wake.status !== "deferred" && wakeCarriesIssue(wake.payload, issue.id))) {
      const wait = await bounded(now.getTime() + 30_000);
      if (wait) return wait;
      // After the short pending grace, use the existing waiting note and its
      // start bound below instead of telling the person to duplicate input.
      if (pendingExecutionWait) waitingToStart = true;
    }
  }

  let code: string;
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
    // A failed wake or an explicitly moved-on cancellation is settled no-run
    // evidence for THIS message. Also read pause cancellations to explain a
    // resumed agent's unbound wake without calling the pause a failure.
    const terminalWakes = await q.select({ payload: agentWakeupRequests.payload, status: agentWakeupRequests.status,
      error: agentWakeupRequests.error, runId: agentWakeupRequests.runId }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
      inArray(agentWakeupRequests.status, ["failed", "cancelled"]), gt(agentWakeupRequests.updatedAt, message.createdAt)))
      .orderBy(desc(agentWakeupRequests.updatedAt), desc(agentWakeupRequests.createdAt));
    // Only THIS message's own wake (Paperclip's queued-comment attribution) is
    // evidence; a later terminal attempt wins over an older pause cancellation.
    const ownWakes = terminalWakes.filter(wake => wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id));
    const wakeFailed = ownWakes.some(wake => wake.status === "failed"
      || (wake.status === "cancelled" && wake.error === "The conversation moved on"));
    const due = message.createdAt.getTime() + UNANSWERED_MESSAGE_NO_RUN_GRACE_MS;
    if (!wakeFailed && due > now.getTime()) return { kind: "pending", recheckAt: due };
    // The lifecycle driver's pausing stop cancels unbound queued/deferred wakes
    // with this exact error, preserving their reason and message payload
    // (heartbeat/run-control.ts cancelPendingWakeupsForAgentsInternal). Resume
    // does not replay them. Do not apply this while setup, a hold or live work
    // takes precedence above, or to a stopped/terminating agent.
    const latestWake = ownWakes[0];
    code = agentRow?.lifecycleState === "ready" && latestWake?.status === "cancelled" && latestWake.runId === null
      && latestWake.error === AGENT_LIFECYCLE_STOP_REASON ? PAUSE_STOPPED_CODE : UNANSWERED_MESSAGE_NO_RUN_CODE;
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
  const pauseStopped = code === PAUSE_STOPPED_CODE;
  const pausedName = agentRow?.name?.trim() || "This agent";
  const waiting = WAITING_KIND_CODES.has(code);
  // A standing working note whose run ended without answering: the run
  // STARTED, so the SAME note gets RFL's started-run text (never 'safe').
  const workingEnded = Boolean(standingWaitingCode === UNANSWERED_MESSAGE_WORKING_CODE && !waiting
    && run && TERMINAL.includes(run.status));
  // The ONE bound: the message's automatic lineage used its K=2 fresh
  // continuations and the last one failed. Nothing further starts by itself.
  const boundReached = Boolean(!paused && !waiting && run && TERMINAL.includes(run.status) && run.status !== "succeeded"
    && (await freshContinuationChain(q as Db, { companyId: issue.companyId, issueId: issue.id, runId: run.id })).attempts
      >= FRESH_CONTINUATION_BOUND);
  // Server-local HH:MM: the instance's time zone, not an assumed UTC zone.
  const since = `${String(message.createdAt.getHours()).padStart(2, "0")}:${String(message.createdAt.getMinutes()).padStart(2, "0")}`;
  // A never-claimed stale receipt gets its existing ONE no-run card, but
  // names the saved message. Ordinary no-run notices keep their wording.
  const staleReceipts = code === UNANSWERED_MESSAGE_NO_RUN_CODE ? await q.select({ payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, issue.companyId),
      inArray(agentWakeupRequests.status, ["deferred", "deferred_issue_execution", "cancelled"]),
      deferredWakeIsStaleSql({ companyId: sql`${agentWakeupRequests.companyId}`, agentId: sql`${agentWakeupRequests.agentId}`,
        issueId: sql`${issue.id}::uuid`, requestedAt: sql`${agentWakeupRequests.requestedAt}`, payload: sql`${agentWakeupRequests.payload}` }))) : [];
  const namedNoRun = staleReceipts.some(wake => wakeCarriesIssue(wake.payload, issue.id) && wakeCarriesMessage(wake.payload, message.id))
    ? `Your message is saved: "${message.body}". It was not answered because no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.`
    : UNANSWERED_MESSAGE_NO_RUN_TEXT;
  const body = policyRefused ? PROVIDER_POLICY_REFUSAL_MESSAGE : settingUp ? `${pausedName} is still being set up (since ${since}). Your message is saved and will be answered as soon as it's ready.`
    : paused ? agentPausedText(pausedName) : waiting ? UNANSWERED_MESSAGE_WAITING_TEXT
    : pauseStopped ? `${pausedName} was paused before it answered your message. Send it again to continue.`
    : supervisionUnconfirmed ? REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION
    : boundReached ? UNANSWERED_MESSAGE_BOUND_REACHED_TEXT
    : code === UNANSWERED_MESSAGE_NO_REPLY_CODE ? (workingEnded ? UNANSWERED_MESSAGE_STARTED_NO_REPLY_TEXT : UNANSWERED_MESSAGE_NO_REPLY_TEXT)
    : code === UNANSWERED_MESSAGE_NO_RUN_CODE ? namedNoRun
      : held ? HELD_PREDECESSOR_NOTICE : workingEnded ? UNANSWERED_MESSAGE_STARTED_FAILED_TEXT : UNANSWERED_MESSAGE_TEXT;
  const notice = buildStrandedRecoveryEscalationNotice({
    seed: {
      title: policyRefused ? "The provider refused this request" : settingUp ? `${pausedName} is still being set up` : paused ? `${pausedName} is paused` : waiting ? "Your message is waiting to start"
        : pauseStopped ? `${pausedName} was paused before it answered` : "Your message wasn't answered",
      body,
      tone: paused ? "warning" : waiting ? "info" : "warning",
      nextAction: policyRefused ? "Automatic retry is disabled for this request."
        : settingUp ? "No action is needed; your message is saved."
        : paused ? `Ask a board user or ${pausedName}'s manager to resume ${pausedName}.`
        : waiting ? "No action is needed; it will start by itself."
        : pauseStopped ? "Send it again to continue."
        : supervisionUnconfirmed ? "Retry or send a new message to continue through fenced recovery."
        : held || boundReached ? "Send a new message to try again."
        : workingEnded ? UNANSWERED_MESSAGE_STARTED_NEXT_ACTION : "Send the message again; if it fails again, assign this agent a new task.",
    },
    recoveryActionId: boardHold?.id ?? null,
    recoveryOwner: null,
    recoveryResponsibility: "user",
    sourceRun: run && !waiting ? { id: run.id, agentId: run.agentId, status: run.status, errorCode: code } : null,
    // A waiting note is not a failure: no "Failure code" row, a marker row instead.
    failureCode: waiting || pauseStopped ? undefined : run ? undefined : code,
  });
  if (waiting) notice.metadata.sections.push({ title: "Status", rows: [keyValueRow(WAITING_ROW_LABEL, code)] });
  return { kind: "notice", reason, code, notice, ...(setupWaitRecord ? { recordWait: setupWaitRecord } : {}),
    ...(upgrading ? { upgradeCommentId: upgrading } : {}) };
}


/** Resume (paused -> resuming) is an event: every open task of this agent whose
 * person's message carries a standing '<agent> is paused' note is handed to the
 * stranded sweep's per-issue entry (settleUnansweredPersonMessagesForTask) at
 * commit, so the SAME note is upgraded now, not at the 5-min recheck. Called
 * in the lifecycle transaction (services/agent-lifecycle.ts recordStatus). */
export async function notifyPausedNoteResume(tx: Db, scope: { companyId: string; agentId: string }): Promise<void> {
  const pausedRow = JSON.stringify([{ rows: [{ label: WAITING_ROW_LABEL, value: UNANSWERED_MESSAGE_AGENT_PAUSED_CODE }] }]);
  const rows = await tx.selectDistinct({ id: issues.id }).from(issues)
    .innerJoin(issueComments, and(eq(issueComments.companyId, issues.companyId), eq(issueComments.issueId, issues.id)))
    .where(and(eq(issues.companyId, scope.companyId), eq(issues.assigneeAgentId, scope.agentId), isNull(issues.hiddenAt),
      inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
      sql`starts_with(${reasonOf(issueComments.metadata)}, ${UNANSWERED_MESSAGE_REASON_PREFIX})`,
      sql`coalesce(${issueComments.metadata}->'sections' @> ${pausedRow}::jsonb, false)`)).limit(200);
  for (const row of rows) {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAssignments, JSON.stringify({ companyId: scope.companyId, issueId: row.id }));
  }
}

/** One task the recovery worker already flagged (its batched page query found
 * a person's message to settle): no candidate lookup of its own. */
export async function settleUnansweredPersonMessagesForTask(
  db: Db,
  input: { companyId: string; issueId: string; issueCreatedAtGte?: Date | null; onDeferredDeadline?: (at: number) => void; now?: Date;
    nativeBlockedRepairApplies?: NativeBlockedRepairApplies },
): Promise<{ noticed: number; pending: number }> {
  const olderOutcomes: UnansweredMessageOutcome[] = [];
  const outcomes = [await settleUnansweredPersonMessage(db, { ...input, olderOutcomes }), ...olderOutcomes];
  const result = { noticed: 0, pending: 0 };
  for (const outcome of outcomes) {
    if (outcome.kind === "noticed") result.noticed += 1;
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
    input.issueCreatedAtGte ? sql`${issues.createdAt} >= ${input.issueCreatedAtGte.toISOString()}::timestamptz` : undefined,
    unansweredPersonMessageCondition(issues.id, issues.companyId),
  )).limit(200);
  const result = { noticed: 0, pending: 0 };
  for (const candidate of candidates) {
    const olderOutcomes: UnansweredMessageOutcome[] = [];
    const outcome = await settleUnansweredPersonMessage(db, { companyId: candidate.companyId, issueId: candidate.id, now: input.now,
      nativeBlockedRepairApplies: input.nativeBlockedRepairApplies, olderOutcomes });
    for (const each of [outcome, ...olderOutcomes]) {
      if (each.kind === "noticed") result.noticed += 1;
      if (each.kind === "pending") {
        result.pending += 1;
        input.onDeferredDeadline?.(each.recheckAt);
      }
    }
  }
  return result;
}
