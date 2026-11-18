import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { answeredPersonMessageSql } from "../person-message-answer.js";
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
import { HELD_PREDECESSOR_NOTICE } from "../native-runtime/held-predecessor-notice-text.js";
import { readUnsupersededHeldConversationNotice } from "../native-runtime/pi-session-recovery-notice.js";
import { conversationTurnAnswered } from "../native-runtime/native-governance.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";
import { keyValueRow } from "./notice-format.js";
import { freshContinuationChain, freshContinuationDescendsFrom } from "../fresh-continuation-chain.js";
import { nativeStartupNeverConnectedExhausted } from "../continuation-cause.js";
import { isFreshThreadRefusal } from "../native-runtime/runner-reconciliation-refusal.js";
import { isNativeContinuationRefusal } from "../native-continuation-refusal.js";

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

/** Earlier owed messages settled per task per pass; discovery keeps flagging the task until none is left. */
const EARLIER_OWED_PER_PASS = 20;

export const UNANSWERED_MESSAGE_NO_REPLY_CODE = "no_reply";
export const UNANSWERED_MESSAGE_NO_RUN_CODE = "no_run";
export const UNANSWERED_MESSAGE_UNCLASSIFIED_CODE = "unclassified_failure";
/** While the run that carries the message is queued and has not started, the
 * turn header says "Waiting to start" (Paperclip's useWaitingToStart, #21447;
 * DESIGN.md: a queued turn's hold is named once, in the turn header), so B'
 * posts no note of its own. A carrying run that still has not started by
 * T0 + this bound gets ONE no-run note, which its answer supersedes. */
export const PENDING_WAIT_START_BOUND_MS = 10 * 60_000;
/** The non-failure marker row of a waiting-kind note (no "Failure code" row).
 * A legacy "waiting to start" note (Waiting code waiting_to_start) still
 * carries it and is replaced in place by the no-run text at the bound. */
const WAITING_ROW_LABEL = "Waiting code";
const WAITING_ROW_JSON = JSON.stringify([{ rows: [{ label: WAITING_ROW_LABEL }] }]);
/** The agent that answers the conversation is paused (or held) and will not
 * run until it is resumed. Not a failure: a waiting-kind note. */
export const UNANSWERED_MESSAGE_AGENT_PAUSED_CODE = "agent_paused";
/** The run that carried the message was cut off and a recovery RESTORED the task: its continuation is saved as a
 * durable deferred wake (reason issue_recovery_action_restored, no run yet, no named execution wait), which starts by
 * itself in a fresh run that carries the cut-off run's input (execution-recovery-resolution.ts wake(), its context from
 * readContinuationCommentInput). Not a failure: a waiting-kind note, never "send it again". */
export const UNANSWERED_MESSAGE_RECOVERING_CODE = "recovering";
export const UNANSWERED_MESSAGE_RECOVERING_TEXT =
  "The run answering your message was cut off. Paperclip is recovering it and will continue by itself; your message is saved.";
const RECOVERY_CONTINUATION_WAKE_REASON = "issue_recovery_action_restored";
const WAITING_KIND_CODES = new Set(["agent_paused", UNANSWERED_MESSAGE_RECOVERING_CODE]);
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
 * SQL: message m is ANSWERED, by the one shared rule (person-message-answer.ts):
 * a reply after m from a run that SUCCEEDED and whose OWN input names m, via
 * any carrying key; or m is imported history. A reply from a failed, cancelled,
 * timed-out or interrupted run, a reply to a LATER message, a progress comment
 * and an agent comment with no run never answer m.
 */
function answeredSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  // The ONE shared definition (person-message-answer.ts), so B's notice and the continuation carry never
  // disagree on a message (RFL 20:22Z: run-less agent comments never answer; org 20:29Z: imported history).
  return answeredPersonMessageSql(m);
}
/** The key of a notice's still-owed member list: one notice covers one owed GROUP (the person messages one failed
 * or reply-less run carried in its own input, or one no-run batch settled in the same pass). Its authorizationReason
 * names the latest still-owed member; a group of one has no list. */
export const UNANSWERED_MESSAGE_GROUP_KEY = "unansweredMessageIds";
/** SQL: notice row n (alias) covers message id: its key names it, or its still-owed member list does. */
const noticeCoversSql = (n: string, id: SQL) => sql`(substr(${sql.raw(n)}.metadata->>'authorizationReason',
    strpos(${sql.raw(n)}.metadata->>'authorizationReason', ':') + 1) = ${id}::text
  or coalesce(${sql.raw(n)}.metadata->${sql.raw(`'${UNANSWERED_MESSAGE_GROUP_KEY}'`)}, '[]'::jsonb) ? ${id}::text)`;
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
          and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}) and ${noticeCoversSql("n", sql.raw("m.id"))}
          and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or exists (select 1 from ${issueComments} n
      join ${issueComments} m on m.company_id = n.company_id and m.issue_id = n.issue_id and ${noticeCoversSql("n", sql.raw("m.id"))}
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and ${answeredSql(rawMessage("m"))}))`;
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
        and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or (${issueComments.authorType} = 'system' and ${issueComments.deletedAt} is null
      and starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and exists (select 1 from ${issueComments} m
        where m.company_id = ${issueComments.companyId} and m.issue_id = ${issueComments.issueId}
          and ${noticeCoversSql(`"issue_comments"`, sql.raw("m.id"))}
          and ${answeredSql(rawMessage("m"))})))`;
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
  if (input.issueCreatedAtGte && issue.createdAt < input.issueCreatedAtGte) return [{ kind: "out_of_scope" }];

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
        and ${noticeCoversSql("n", sql.raw("m.id"))} and ${answeredSql(rawMessage("m"))})
      and not exists (select 1 from ${issueComments} m where m.company_id = n.company_id and m.issue_id = n.issue_id
        and ${noticeCoversSql("n", sql.raw("m.id"))} and not ${answeredSql(rawMessage("m"))})`);
    // A group notice with an answered member and a still-owed one STAYS and stays true: it names only the still-owed.
    await tx.execute(sql`update ${issueComments} n set updated_at = ${now.toISOString()}::timestamptz,
      metadata = n.metadata || (select jsonb_build_object(${UNANSWERED_MESSAGE_GROUP_KEY}::text, jsonb_agg(m.id::text order by m.created_at, m.id),
          'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}::text || (array_agg(m.id::text order by m.created_at desc, m.id desc))[1])
        from ${issueComments} m where m.company_id = n.company_id and m.issue_id = n.issue_id
          and ${noticeCoversSql("n", sql.raw("m.id"))} and not ${answeredSql(rawMessage("m"))})
    where n.company_id = ${issue.companyId} and n.issue_id = ${issue.id} and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX}) and n.metadata ? ${UNANSWERED_MESSAGE_GROUP_KEY}::text
      and exists (select 1 from ${issueComments} m where m.company_id = n.company_id and m.issue_id = n.issue_id
        and ${noticeCoversSql("n", sql.raw("m.id"))} and ${answeredSql(rawMessage("m"))})`);
  });

  const earlierOwed = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id), eq(issueComments.authorType, "user"),
    unansweredPersonMessageCommentCondition(),
    sql`${issueComments.id} <> (select l.id from ${issueComments} l where l.company_id = ${issue.companyId} and l.issue_id = ${issue.id}
      and l.author_type = 'user' and l.deleted_at is null order by l.created_at desc, l.id desc limit 1)`))
    .orderBy(issueComments.createdAt, issueComments.id).limit(EARLIER_OWED_PER_PASS);
  // Decide every owed message, then ONE notice per owed GROUP: the members share the run that carried them (or
  // have no run, this pass), the code and the standing note to replace. Never two notices for one message.
  const outcomes: UnansweredMessageOutcome[] = [];
  const groups = new Map<string, Array<{ index: number; messageId: string | undefined; decision: NoticeDecision }>>();
  for (const messageId of [...earlierOwed.map(row => row.id), undefined]) {
    const decision = await decideUnansweredMessage(db, issue, now, input.nativeBlockedRepairApplies, messageId);
    if (decision.kind === "notice") {
      groups.set(groupKey(decision), [...(groups.get(groupKey(decision)) ?? []), { index: outcomes.length, messageId, decision }]);
      outcomes.push({ kind: "noticed_before" });
    } else outcomes.push(await recordPendingDecision(db, issue, decision));
  }
  for (const members of [...groups.values()].reverse()) { // the latest message's group first
    const outcome = await writeGroupNotice(db, issue, now, input.nativeBlockedRepairApplies, members);
    for (const member of members) outcomes[member.index] = outcome;
  }
  return outcomes;
}

const groupKey = (decision: NoticeDecision) => `${decision.group}|${decision.code}|${decision.upgradeCommentId ?? ""}`;

/** A decision that writes no notice: record a first deferral (T0) when it asks for it. */
async function recordPendingDecision(db: Db, issue: DecisionIssue, decision: Exclude<Decision, NoticeDecision>): Promise<UnansweredMessageOutcome> {
  if (decision.kind === "pending") {
    if (decision.recordDeferral) {
      await appendHeartbeatRunEvent(db, { companyId: issue.companyId, runId: decision.recordDeferral.runId,
        agentId: decision.recordDeferral.agentId, eventType: NATIVE_REPAIR_DEFERRAL_EVENT, stream: "system", level: "info",
        message: "The unanswered-message notice waits for the native blocked-request repair to publish.",
        payload: { messageId: decision.recordDeferral.messageId, boundMs: NATIVE_REPAIR_PUBLISH_BOUND_MS } });
    }
    if (decision.recordWait) {
      await logActivity(db, { companyId: issue.companyId, actorType: "system", actorId: "recovery",
        action: PENDING_WAIT_ACTION, entityType: "issue", entityId: issue.id, issueId: issue.id,
        details: { messageId: decision.recordWait.messageId, runId: decision.recordWait.runId, boundMs: PENDING_WAIT_BOUND_MS } });
    }
    return { kind: "pending", recheckAt: decision.recheckAt };
  }
  return decision;
}

/** One owed group: write its ONE notice under the fence, keyed to its latest member that is still to be noticed. */
async function writeGroupNotice(db: Db, issue: DecisionIssue, now: Date, nativeBlockedRepairApplies: NativeBlockedRepairApplies | undefined,
  members: Array<{ messageId: string | undefined; decision: NoticeDecision }>): Promise<UnansweredMessageOutcome> {
  const commentId = await db.transaction(async tx => {
    // The issue fence that comment writers, the executor's held-notice writer
    // and execution admission take. The SAME predicate is evaluated again
    // under it: an answer (prose or the turn's own card), a held notice, a
    // newer message, a run or a wake that committed while this sweep waited
    // means no notice.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    const kept: NoticeDecision[] = [];
    for (const { messageId, decision } of members) {
      const again = await decideUnansweredMessage(tx as unknown as Db, issue, now, nativeBlockedRepairApplies, messageId);
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
type Decision = Exclude<UnansweredMessageOutcome, { kind: "noticed" | "pending" }>
  | { kind: "pending"; recheckAt: number; recordDeferral?: { runId: string; agentId: string; messageId: string };
      recordWait?: { messageId: string; runId: string | null } }
  | NoticeDecision;
type NoticeDecision = { kind: "notice"; reason: string; code: string; notice: ReturnType<typeof buildStrandedRecoveryEscalationNotice>;
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
  nativeBlockedRepairApplies?: NativeBlockedRepairApplies, messageId?: string): Promise<Decision> {
  if (issue.hiddenAt || !issue.assigneeAgentId || issue.assigneeUserId
    || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) return { kind: "out_of_scope" };
  const agentId = issue.assigneeAgentId;

  const [message] = await q.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments).where(and(
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
    noticeCoversSql(`"issue_comments"`, sql`${message.id}`))).limit(1);
  // A standing WAITING note is still an open obligation: it must stay true.
  if (noticed && !noticed.waiting) return { kind: "noticed_before" };
  const upgrading = noticed?.waiting ? noticed.id : null;
  const standingWaitingCode = noticed?.waiting ? noticed.waitingCode : null;

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
  const bounded = async (recheckAt: number): Promise<Decision | null> => {
    if (waitT0 === undefined) {
      const [wait] = await q.select({ at: sql<Date>`min(${activityLog.createdAt})` }).from(activityLog).where(and(
        eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id),
        eq(activityLog.action, PENDING_WAIT_ACTION), sql`${activityLog.details}->>'messageId' = ${message.id}`,
        sql`coalesce(${activityLog.details}->>'runId', '') = ${messageRun?.id ?? ""}`));
      waitT0 = wait?.at ? new Date(wait.at).getTime() : null;
    }
    const bound = (waitT0 ?? now.getTime()) + PENDING_WAIT_BOUND_MS;
    if (bound <= now.getTime()) return null;
    return { kind: "pending", recheckAt: Math.min(recheckAt, bound),
      ...(waitT0 === null ? { recordWait: { messageId: message.id, runId: messageRun?.id ?? null } } : {}) };
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
  // the person silent. When the run that waits carries the message, the turn
  // header already says it is waiting to start (useWaitingToStart): no note
  // until PENDING_WAIT_START_BOUND_MS, then the no-run note.
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
    lifecycleHolds: agents.lifecycleHolds, pauseReason: agents.pauseReason }).from(agents).where(and(eq(agents.companyId, issue.companyId), eq(agents.id, agentId)));
  const agentPaused = Boolean(agentRow && (agentRow.status === "paused" || ["paused", "pausing"].includes(agentRow.lifecycleState)
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
  if (liveRuns.length && !agentPaused) {
    const wait = await bounded(now.getTime() + 30_000);
    if (wait) return wait;
    waitingToStart = liveRuns.some(candidate => runCarriesMessage(candidate.contextSnapshot, message.id));
  }

  // A board-owned hold means nothing moves by itself: queued wakes behind it
  // do not count as a further attempt.
  const [boardHold] = await q.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.ownerType, "board")))
    .orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  // The message's own run was cut off and a recovery restored it: the deferred continuation wake waits to start by
  // itself and will carry that run's input. The person sees ONE true recovering line after the short grace, anchored
  // on durable facts (the run's end, the wake's creation), so a first sweep that comes late still says it at once.
  const recovering = !boardHold && !agentPaused && !liveRuns.length && run && TERMINAL.includes(run.status) && run.status !== "succeeded"
    ? await recoveringContinuationWake(q, issue, agentId, [...new Set([run.id, messageRun?.id ?? run.id])]) : null;
  if (recovering && run) {
    const due = Math.max(recovering.createdAt.getTime(), (run.finishedAt ?? run.updatedAt).getTime()) + PENDING_WAIT_BOUND_MS;
    if (due > now.getTime()) return { kind: "pending", recheckAt: due };
    if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_RECOVERING_CODE) {
      return { kind: "pending", recheckAt: now.getTime() + 60_000 };
    }
  } else if (!boardHold && !agentPaused) {
    const wakes = await q.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    if (wakes.some(wake => wakeCarriesIssue(wake.payload, issue.id))) {
      const wait = await bounded(now.getTime() + 30_000);
      if (wait) return wait;
    }
  }

  let code: string;
  if (agentPaused) {
    code = UNANSWERED_MESSAGE_AGENT_PAUSED_CODE;
  } else if (recovering) {
    code = UNANSWERED_MESSAGE_RECOVERING_CODE;
  } else if (waitingToStart) {
    // The turn header says "Waiting to start" until T0 + PENDING_WAIT_START_BOUND_MS;
    // after that the carrying run has not started (a dead claim, a stuck
    // queue): one no-run note.
    const startDeadline = (waitT0 ?? now.getTime()) + PENDING_WAIT_START_BOUND_MS;
    if (startDeadline > now.getTime()) return { kind: "pending", recheckAt: startDeadline };
    code = UNANSWERED_MESSAGE_NO_RUN_CODE;
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
  const recoveringNote = code === UNANSWERED_MESSAGE_RECOVERING_CODE;
  const pausedName = agentRow?.name?.trim() || "This agent";
  const waiting = WAITING_KIND_CODES.has(code);
  // The ONE bound: the message's automatic lineage used its K=2 fresh
  // continuations and the last one failed. Nothing further starts by itself.
  const boundReached = Boolean(!paused && !waiting && run && TERMINAL.includes(run.status) && run.status !== "succeeded"
    && (await freshContinuationChain(q as Db, { companyId: issue.companyId, issueId: issue.id, runId: run.id })).attempts
      >= FRESH_CONTINUATION_BOUND);
  const body = paused ? agentPausedText(pausedName)
    : recoveringNote ? UNANSWERED_MESSAGE_RECOVERING_TEXT
    : boundReached ? UNANSWERED_MESSAGE_BOUND_REACHED_TEXT
    : code === UNANSWERED_MESSAGE_NO_REPLY_CODE ? UNANSWERED_MESSAGE_NO_REPLY_TEXT
    : code === UNANSWERED_MESSAGE_NO_RUN_CODE ? UNANSWERED_MESSAGE_NO_RUN_TEXT
      : held ? HELD_PREDECESSOR_NOTICE : UNANSWERED_MESSAGE_TEXT;
  const notice = buildStrandedRecoveryEscalationNotice({
    seed: {
      title: paused ? `${pausedName} is paused` : recoveringNote ? "Recovering the run for your message" : "Your message wasn't answered",
      body,
      tone: "warning",
      nextAction: paused ? `Ask a board user or ${pausedName}'s manager to resume ${pausedName}.`
        : recoveringNote ? "Nothing to do: Paperclip continues by itself."
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
  return { kind: "notice", reason, code, notice, group: messageRun?.id ?? UNANSWERED_MESSAGE_NO_RUN_CODE, ...(upgrading ? { upgradeCommentId: upgrading } : {}) };
}


/** The durable deferred continuation wake that a RESTORED recovery of the message's own run saved: reason
 * issue_recovery_action_restored, no run, no named execution wait (a named wait, such as a budget, does not start by
 * itself), and its recovery action restored THIS issue from one of the given runs. */
async function recoveringContinuationWake(q: Db, issue: DecisionIssue, agentId: string, runIds: string[]) {
  const [wake] = await q.select({ createdAt: agentWakeupRequests.createdAt }).from(agentWakeupRequests)
    .innerJoin(issueRecoveryActions, and(eq(issueRecoveryActions.companyId, agentWakeupRequests.companyId),
      sql`${issueRecoveryActions.id}::text = ${agentWakeupRequests.payload}->>'recoveryActionId'`))
    .where(and(eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.reason, RECOVERY_CONTINUATION_WAKE_REASON),
      isNull(agentWakeupRequests.runId), sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
      sql`not coalesce(${agentWakeupRequests.payload} ? 'executionWait', false)`,
      eq(issueRecoveryActions.sourceIssueId, issue.id), eq(issueRecoveryActions.outcome, "restored"),
      sql`${issueRecoveryActions.evidence}->>'runId' in (${sql.join(runIds.map(id => sql`${id}`), sql`, `)})`))
    .orderBy(desc(agentWakeupRequests.createdAt)).limit(1);
  return wake ?? null;
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
    input.issueCreatedAtGte ? sql`${issues.createdAt} >= ${input.issueCreatedAtGte.toISOString()}::timestamptz` : undefined,
    unansweredPersonMessageCondition(issues.id, issues.companyId),
  )).limit(200);
  const result = { noticed: 0, pending: 0 };
  const notices = new Set<string>(); // one notice covers a whole owed group: count it once
  for (const candidate of candidates) {
    for (const outcome of await settleOwedPersonMessages(db, { companyId: candidate.companyId, issueId: candidate.id, now: input.now,
      nativeBlockedRepairApplies: input.nativeBlockedRepairApplies })) {
      if (outcome.kind === "noticed" && !notices.has(outcome.commentId)) { notices.add(outcome.commentId); result.noticed += 1; }
      if (outcome.kind === "pending") {
        result.pending += 1;
        input.onDeferredDeadline?.(outcome.recheckAt);
      }
    }
  }
  return result;
}
