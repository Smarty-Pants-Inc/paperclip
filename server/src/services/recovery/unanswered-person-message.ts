import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
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
import { HELD_PREDECESSOR_NOTICE } from "../native-runtime/held-predecessor-notice-text.js";
import { readUnsupersededHeldConversationNotice } from "../native-runtime/pi-session-recovery-notice.js";
import { conversationTurnAnswered } from "../native-runtime/native-governance.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";
import { keyValueRow } from "./notice-format.js";
import { freshContinuationDescendsFrom } from "../fresh-continuation-chain.js";
import { isNativeContinuationRefusal } from "../native-continuation-refusal.js";
import { activeIssueInteractionCondition } from "../issue-question-context.js";

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
export const UNANSWERED_MESSAGE_HELD_REPLY_CODE = "held_reply";
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
const WAITING_KIND_CODES = new Set(["waiting_to_start", "agent_paused"]);
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
  "runner_ingress_acquisition_failed", "runner_ingress_access_rejected", "runner_task_admission_rejected",
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
 * written by a run whose input carried m or a later person message (the native
 * conversation finalizer's reply boundary, agent-conversations.ts:406-437:
 * messages after a run's boundary stay actionable), via any carrying key. An
 * agent comment with no run counts by time. A later reply to ANOTHER message
 * never answers m.
 */
function answeredSql(m: { id: SQL; companyId: SQL; issueId: SQL; createdAt: SQL }): SQL {
  return sql`exists (select 1 from ${issueComments} a
    left join ${heartbeatRuns} r on r.id = a.created_by_run_id and r.company_id = a.company_id
    where a.company_id = ${m.companyId} and a.issue_id = ${m.issueId} and a.author_type = 'agent' and a.deleted_at is null
      and a.created_at > ${m.createdAt}
      and (a.created_by_run_id is null or exists (select 1 from ${issueComments} b
        where b.company_id = a.company_id and b.issue_id = a.issue_id and b.author_type = 'user'
          and (b.id = ${m.id} or b.created_at > ${m.createdAt})
          and (r.context_snapshot->>'wakeCommentId' = b.id::text or r.context_snapshot->>'commentId' = b.id::text
            or r.context_snapshot->>'conversationReplyBoundaryCommentId' = b.id::text
            or coalesce(r.context_snapshot->'wakeCommentIds', '[]'::jsonb) ? b.id::text
            or coalesce(r.context_snapshot->'firstTurnQueuedInput'->'commentIds', '[]'::jsonb) ? b.id::text))))`;
}
const rawMessage = (alias: string) => ({ id: sql.raw(`${alias}.id`), companyId: sql.raw(`${alias}.company_id`),
  issueId: sql.raw(`${alias}.issue_id`), createdAt: sql.raw(`${alias}.created_at`) });

type HeldReplyCard = { id: string; title: string | null; summary: string | null; payload: unknown };
const HELD_REPLY_METADATA_SECTION = "Held reply";
const HELD_REPLY_METADATA_LABEL = "Held reply record";

type HeldReplyMetadata = {
  version: 1;
  sourceRunId: string;
  cardId: string | null;
  cardName: string | null;
  relatedCardName?: string | null;
  cardRole?: "active_hold" | "continuation_reference" | null;
  continuationCardIds: string[];
  state: "waiting_for_card" | "generic" | "card_answered_no_reply" | "superseded";
  superseded?: boolean;
  supersededAt?: string;
  supersededByCommentId?: string;
  supersededByRunId?: string;
};

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** A governed wait is still an answer when Paperclip deliberately kept its
 * accepted prose in run activity rather than publishing it to the thread. */
function isHeldReplyRun(run: { status: string; resultJson: unknown }): boolean {
  if (run.status !== "succeeded") return false;
  const result = objectRecord(run.resultJson);
  const presentation = objectRecord(result.presentationDecision);
  const nativeResult = objectRecord(result.nativeResult);
  const reasonCodes = Array.isArray(presentation.reasonCodes) ? presentation.reasonCodes : [];
  const yielded = reasonCodes.includes("yielded_control_plane_wait")
    || reasonCodes.includes("board_response_wait_superseded")
    || result.finalizationReasonCode === "board_response_wait_superseded";
  return presentation.commentAction === "none" && yielded
    && typeof nativeResult.summary === "string" && nativeResult.summary.trim().length > 0;
}

function firstQuestionPrompt(payload: unknown): string | null {
  const questions = objectRecord(payload).questions;
  const prompt = Array.isArray(questions) ? objectRecord(questions[0]).prompt : null;
  return typeof prompt === "string" && prompt.trim() ? prompt.trim() : null;
}

function heldReplyCardName(card: HeldReplyCard): string | null {
  const title = card.title?.trim();
  // When an ordinary question has no title, its first prompt is its visible name.
  const name = title || firstQuestionPrompt(card.payload) || card.summary?.trim() || null;
  // Keep the structured metadata row (and its JSON card references) bounded.
  return name?.slice(0, 160) ?? null;
}

function readHeldReplyMetadata(value: unknown): HeldReplyMetadata | null {
  const sections = objectRecord(value).sections;
  if (!Array.isArray(sections)) return null;
  const row = sections.flatMap(section => Array.isArray(objectRecord(section).rows)
    ? objectRecord(section).rows as unknown[] : [])
    .map(objectRecord).find(candidate => candidate.label === HELD_REPLY_METADATA_LABEL);
  if (typeof row?.value !== "string") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.value); } catch { return null; }
  const held = objectRecord(parsed);
  if (held.version !== 1 || typeof held.sourceRunId !== "string") return null;
  return {
    version: 1,
    sourceRunId: held.sourceRunId,
    cardId: typeof held.cardId === "string" ? held.cardId : null,
    cardName: typeof held.cardName === "string" ? held.cardName : null,
    relatedCardName: typeof held.relatedCardName === "string" ? held.relatedCardName : null,
    cardRole: held.cardRole === "active_hold" || held.cardRole === "continuation_reference" ? held.cardRole : null,
    continuationCardIds: Array.isArray(held.continuationCardIds)
      ? held.continuationCardIds.filter((id): id is string => typeof id === "string") : [],
    state: held.state === "superseded" || held.state === "card_answered_no_reply" || held.state === "waiting_for_card"
      ? held.state : "generic",
    ...(held.superseded === true ? { superseded: true } : {}),
    ...(typeof held.supersededAt === "string" ? { supersededAt: held.supersededAt } : {}),
    ...(typeof held.supersededByCommentId === "string" ? { supersededByCommentId: held.supersededByCommentId } : {}),
    ...(typeof held.supersededByRunId === "string" ? { supersededByRunId: held.supersededByRunId } : {}),
  };
}

function withHeldReplyMetadata(metadata: unknown, held: HeldReplyMetadata): Record<string, unknown> {
  const base = objectRecord(metadata);
  const sections = Array.isArray(base.sections) ? [...base.sections] : [];
  const sectionIndex = sections.findIndex(section => objectRecord(section).title === HELD_REPLY_METADATA_SECTION);
  const row = keyValueRow(HELD_REPLY_METADATA_LABEL, JSON.stringify(held));
  if (sectionIndex >= 0) {
    const section = objectRecord(sections[sectionIndex]);
    const rows = Array.isArray(section.rows) ? section.rows as unknown[] : [];
    sections[sectionIndex] = { ...section, rows: [...rows.filter(value => objectRecord(value).label !== HELD_REPLY_METADATA_LABEL), row] };
  } else {
    sections.push({ title: HELD_REPLY_METADATA_SECTION, rows: [row] });
  }
  return { ...base, sections };
}

function heldReplyMetadataSql(metadata: SQL | AnyPgColumn): SQL {
  return sql`exists (select 1 from jsonb_array_elements(coalesce(${metadata}->'sections', '[]'::jsonb)) held_section,
    jsonb_array_elements(coalesce(held_section->'rows', '[]'::jsonb)) held_row
    where held_section->>'title' = ${HELD_REPLY_METADATA_SECTION}
      and held_row->>'label' = ${HELD_REPLY_METADATA_LABEL})`;
}

function heldReplyOutstandingSql(metadata: SQL | AnyPgColumn): SQL {
  return sql`exists (select 1 from jsonb_array_elements(coalesce(${metadata}->'sections', '[]'::jsonb)) held_section,
    jsonb_array_elements(coalesce(held_section->'rows', '[]'::jsonb)) held_row
    where held_section->>'title' = ${HELD_REPLY_METADATA_SECTION}
      and held_row->>'label' = ${HELD_REPLY_METADATA_LABEL}
      and coalesce(held_row->>'value', '') not like '%\"superseded\":true%')`;
}

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
    or exists (select 1 from ${issueComments} n
      join ${issueComments} m on m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
        and n.author_type = 'system' and n.deleted_at is null
        and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
        and ${heldReplyOutstandingSql(sql.raw("n.metadata"))})
    or exists (select 1 from ${issueComments} n
      join ${issueComments} m on m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and not ${heldReplyMetadataSql(sql.raw("n.metadata"))}
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
        and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || ${issueComments.id}::text
        and not coalesce(n.metadata->'sections' @> ${WAITING_ROW_JSON}::jsonb, false)))
    or (${issueComments.authorType} = 'system' and ${issueComments.deletedAt} is null
      and starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and ${heldReplyOutstandingSql(issueComments.metadata)})
    or (${issueComments.authorType} = 'system' and ${issueComments.deletedAt} is null
      and starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and not ${heldReplyMetadataSql(issueComments.metadata)}
      and exists (select 1 from ${issueComments} m
        where m.company_id = ${issueComments.companyId} and m.issue_id = ${issueComments.issueId}
          and m.id::text = substr(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
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

function heldReplyBody(agentName: string, cardName: string | null, relatedCardName: string | null, hasActiveCard: boolean): string {
  if (cardName) {
    return `${agentName} answered while the card "${cardName}" was pending, but Paperclip kept that reply in the run's activity instead of this chat. The card is still pending.`;
  }
  if (hasActiveCard) {
    return `${agentName} answered, but Paperclip kept that reply in the run's activity instead of this chat. An active card has no title or question prompt to name it.`;
  }
  if (relatedCardName) {
    return `${agentName} answered, but Paperclip kept that reply in the run's activity instead of this chat. The earlier card "${relatedCardName}" is historical and is not being named as the cause of the hold.`;
  }
  return `${agentName} answered, but Paperclip kept that reply in the run's activity instead of this chat. No active question card explains the hold.`;
}

async function reconcileHeldReplyNotes(db: Db, issue: DecisionIssue, now: Date): Promise<void> {
  const [candidate] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    heldReplyOutstandingSql(issueComments.metadata),
  )).limit(1);
  if (!candidate) return;
  await db.transaction(async tx => {
    // Follow the comment writers' issue-first lock order. A card answer, a
    // continuation reply, and this history update therefore settle serially.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    const notes = await tx.select({ id: issueComments.id, metadata: issueComments.metadata,
      presentation: issueComments.presentation, body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments).where(and(
        eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
        eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
        sql`starts_with(${reasonOf(issueComments.metadata)}, ${UNANSWERED_MESSAGE_REASON_PREFIX})`,
        heldReplyOutstandingSql(issueComments.metadata),
      ));

    for (const note of notes) {
      const held = readHeldReplyMetadata(note.metadata);
      if (!held || held.superseded) continue;
      const candidateIds = [...new Set([held.cardId, ...held.continuationCardIds].filter((id): id is string => Boolean(id)))];
      const answeredCards = candidateIds.length
        ? await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
            eq(issueThreadInteractions.status, "answered"), inArray(issueThreadInteractions.id, candidateIds)))
        : [];
      let published: { id: string; runId: string | null } | undefined;
      if (answeredCards.length) {
        [published] = await tx.select({ id: issueComments.id, runId: issueComments.createdByRunId })
          .from(issueComments).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, issueComments.createdByRunId))
          .where(and(
            eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
            eq(issueComments.authorType, "agent"), isNull(issueComments.deletedAt),
            gt(issueComments.createdAt, note.createdAt),
            inArray(sql<string>`${heartbeatRuns.contextSnapshot}->>'interactionId'`, answeredCards.map(card => card.id)),
          )).orderBy(issueComments.createdAt).limit(1);
      }

      if (published) {
        const nextHeld: HeldReplyMetadata = {
          ...held, state: "superseded", superseded: true, supersededAt: now.toISOString(),
          supersededByCommentId: published.id, supersededByRunId: published.runId ?? undefined,
        };
        const metadata = withHeldReplyMetadata(note.metadata, nextHeld) as never;
        const body = `Earlier: ${note.body} The card was answered and a later reply was posted in this chat.`;
        const presentation = note.presentation ? { ...note.presentation, title: "A later reply was posted" } : note.presentation;
        await tx.update(issueComments).set({ body, presentation, metadata, updatedAt: now })
          .where(and(eq(issueComments.id, note.id), isNull(issueComments.deletedAt)));
        continue;
      }

      if (answeredCards.length && held.state !== "card_answered_no_reply") {
        const [run] = await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, held.sourceRunId), eq(heartbeatRuns.companyId, issue.companyId))).limit(1);
        const [agent] = run ? await tx.select({ name: agents.name }).from(agents)
          .where(and(eq(agents.id, run.agentId), eq(agents.companyId, issue.companyId))).limit(1) : [];
        const agentName = agent?.name?.trim() || "The agent";
        const body = held.cardName
          ? `Earlier: ${agentName} answered while the card "${held.cardName}" was pending, but Paperclip kept that reply in the run's activity instead of this chat. The card has been answered; no continuation reply is visible in this chat.`
          : `Earlier: ${agentName} answered, but Paperclip kept that reply in the run's activity instead of this chat. A question card has been answered; no continuation reply is visible in this chat.`;
        const nextHeld: HeldReplyMetadata = { ...held, state: "card_answered_no_reply" };
        const metadata = withHeldReplyMetadata(note.metadata, nextHeld) as never;
        const presentation = note.presentation ? { ...note.presentation, title: "No continuation reply is visible" } : note.presentation;
        await tx.update(issueComments).set({ body, presentation, metadata, updatedAt: now })
          .where(and(eq(issueComments.id, note.id), isNull(issueComments.deletedAt)));
      } else if (!candidateIds.length) {
        // A generic held note has no card transition to follow. If its own run
        // later becomes visibly published, preserve the note as history too.
        const [publishedSourceReply] = await tx.select({ id: issueComments.id })
          .from(issueComments).where(and(
            eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
            eq(issueComments.authorType, "agent"), eq(issueComments.createdByRunId, held.sourceRunId),
            isNull(issueComments.deletedAt), gt(issueComments.createdAt, note.createdAt),
          )).orderBy(issueComments.createdAt).limit(1);
        if (publishedSourceReply) {
          const nextHeld: HeldReplyMetadata = {
            ...held, state: "superseded", superseded: true, supersededAt: now.toISOString(),
            supersededByCommentId: publishedSourceReply.id, supersededByRunId: held.sourceRunId,
          };
          const metadata = withHeldReplyMetadata(note.metadata, nextHeld) as never;
          const body = `Earlier: ${note.body} The held reply was later posted in this chat.`;
          const presentation = note.presentation ? { ...note.presentation, title: "The held reply was posted" } : note.presentation;
          await tx.update(issueComments).set({ body, presentation, metadata, updatedAt: now })
            .where(and(eq(issueComments.id, note.id), isNull(issueComments.deletedAt)));
        }
      }
    }
  });
}

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

  await reconcileHeldReplyNotes(db, issue, now);

  // An answer to a message supersedes that message's notice (and its
  // retrying line): the relation is message -> answer, not the notice's time.
  // Written under the same issue fence, in the same order (issue row, then its
  // comments) as the notice writers.
  const [liveNotice] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    sql`not ${heldReplyMetadataSql(issueComments.metadata)}`,
    or(sql`starts_with(${reasonOf(issueComments.metadata)}, ${UNANSWERED_MESSAGE_REASON_PREFIX})`,
      sql`starts_with(${reasonOf(issueComments.metadata)}, ${RETRYING_MESSAGE_REASON_PREFIX})`))).limit(1);
  if (liveNotice) await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    await tx.execute(sql`update ${issueComments} n set deleted_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
    where n.company_id = ${issue.companyId} and n.issue_id = ${issue.id} and n.author_type = 'system' and n.deleted_at is null
      and (starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
        or starts_with(n.metadata->>'authorizationReason', ${RETRYING_MESSAGE_REASON_PREFIX}))
      and not ${heldReplyMetadataSql(sql.raw("n.metadata"))}
      and exists (select 1 from ${issueComments} m where m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', strpos(n.metadata->>'authorizationReason', ':') + 1)
        and ${answeredSql(rawMessage("m"))})`);
  });

  const decision = await decideUnansweredMessage(db, issue, now, input.nativeBlockedRepairApplies);
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
type Decision = Exclude<UnansweredMessageOutcome, { kind: "noticed" | "pending" }>
  | { kind: "pending"; recheckAt: number; recordDeferral?: { runId: string; agentId: string; messageId: string };
      recordWait?: { messageId: string; runId: string | null } }
  | { kind: "notice"; reason: string; code: string; notice: ReturnType<typeof buildStrandedRecoveryEscalationNotice>;
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

  const [message] = await q.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt)))
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
    sql`${reasonOf(issueComments.metadata)} = ${reason}`)).limit(1);
  // A standing WAITING note is still an open obligation: it must stay true.
  if (noticed && !noticed.waiting) return { kind: "noticed_before" };
  const upgrading = noticed?.waiting ? noticed.id : null;
  const standingWaitingCode = noticed?.waiting ? noticed.waitingCode ?? UNANSWERED_MESSAGE_WAITING_CODE : null;

  // The run this message started (the latest run that carries it), if any.
  const issueRun = or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`);
  const runs = await q.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, error: heartbeatRuns.error,
    errorCode: heartbeatRuns.errorCode, resultJson: heartbeatRuns.resultJson,
    contextSnapshot: heartbeatRuns.contextSnapshot, finishedAt: heartbeatRuns.finishedAt,
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
    lifecycleHolds: agents.lifecycleHolds }).from(agents).where(and(eq(agents.companyId, issue.companyId), eq(agents.id, agentId)));
  const agentPaused = Boolean(agentRow && (agentRow.status === "paused" || ["paused", "pausing"].includes(agentRow.lifecycleState)
    || (agentRow.lifecycleHolds ?? []).length > 0));
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
  if (!boardHold && !agentPaused) {
    const wakes = await q.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    if (wakes.some(wake => wakeCarriesIssue(wake.payload, issue.id))) {
      const wait = await bounded(now.getTime() + 30_000);
      if (wait) return wait;
    }
  }

  // A refused fresh continuation that descends from the message's run is the
  // run the person's message ended on: its refusal is the explanation
  // (fork-lead a6342a4d4, fresh-continuation-chain.ts).
  const latest = runs[0];
  const run = messageRun && latest && latest.id !== messageRun.id && isNativeContinuationRefusal(latest)
    && await freshContinuationDescendsFrom(q, { companyId: issue.companyId, issueId: issue.id,
      runId: latest.id, ancestorRunId: messageRun.id }) ? latest : messageRun;

  const heldReplyRun = Boolean(run && isHeldReplyRun(run));
  let code: string;
  if (agentPaused && !heldReplyRun) {
    code = UNANSWERED_MESSAGE_AGENT_PAUSED_CODE;
  } else if (waitingToStart && !heldReplyRun) {
    // Still true only until T0 + PENDING_WAIT_START_BOUND_MS; after that the
    // carrying run has not started (a dead claim, a stuck queue): failure text.
    const startDeadline = (waitT0 ?? now.getTime()) + PENDING_WAIT_START_BOUND_MS;
    if (startDeadline > now.getTime()) {
      if (upgrading && standingWaitingCode === UNANSWERED_MESSAGE_WAITING_CODE) return { kind: "pending", recheckAt: startDeadline };
      code = UNANSWERED_MESSAGE_WAITING_CODE;
    } else {
      code = UNANSWERED_MESSAGE_NO_RUN_CODE;
    }
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
    const [coordinator] = await q.select({ phase: nativeRunFinalizations.phase, nextAttemptAt: nativeRunFinalizations.nextAttemptAt })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, issue.companyId), eq(nativeRunFinalizations.runId, run.id)));
    if (coordinator && !boardHold) {
      if (NATIVE_PENDING_PHASES.includes(coordinator.phase)) {
        const wait = await bounded(now.getTime() + 30_000);
        if (wait) return wait;
      } else if (coordinator.phase === "retryable_failure"
        && (!coordinator.nextAttemptAt || coordinator.nextAttemptAt.getTime() + OVERDUE_NATIVE_RETRY_MS > now.getTime())) {
        const wait = await bounded(Math.max(now.getTime() + 30_000, (coordinator.nextAttemptAt?.getTime() ?? 0) + OVERDUE_NATIVE_RETRY_MS));
        if (wait) return wait;
      }
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
    if (run.status === "succeeded" && !heldReplyRun && nativeBlockedRepairApplies) {
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
    code = heldReplyRun ? UNANSWERED_MESSAGE_HELD_REPLY_CODE
      : run.status === "succeeded" ? UNANSWERED_MESSAGE_NO_REPLY_CODE : unansweredMessageCode(run);
  }

  let heldReplyCard: HeldReplyCard | null = null;
  let continuationCardIds: string[] = [];
  let relatedCardName: string | null = null;
  if (heldReplyRun && run) {
    const [activeCard] = await q.select({ id: issueThreadInteractions.id, title: issueThreadInteractions.title,
      summary: issueThreadInteractions.summary, payload: issueThreadInteractions.payload })
      .from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.status, "pending"), activeIssueInteractionCondition({ runId: run.id }),
      )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(1);
    heldReplyCard = activeCard ?? null;
    // Ordinary questions can be historical for the hold predicate after a
    // newer person message. Keep their IDs only as possible continuation links:
    // they are never named as the cause unless the upstream predicate selected
    // them above, but question-response-delivery can still wake from one.
    const continuationCards = await q.select({ id: issueThreadInteractions.id, title: issueThreadInteractions.title,
      summary: issueThreadInteractions.summary, payload: issueThreadInteractions.payload }).from(issueThreadInteractions).where(and(
        eq(issueThreadInteractions.companyId, issue.companyId), eq(issueThreadInteractions.issueId, issue.id),
        eq(issueThreadInteractions.kind, "ask_user_questions"), eq(issueThreadInteractions.status, "pending"),
        isNull(issueThreadInteractions.dismissedAt), sql`${issueThreadInteractions.sourceRunId} is distinct from ${run.id}`,
        sql`${issueThreadInteractions.createdAt} <= ${run.createdAt.toISOString()}::timestamptz`,
      )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(20);
    continuationCardIds = continuationCards.map(card => card.id);
    if (!heldReplyCard && continuationCards.length === 1) relatedCardName = heldReplyCardName(continuationCards[0]!);
  }

  // Already explained: the executor's held notice for this conversation, or a
  // person-facing recovery notice posted after the message.
  if (await readUnsupersededHeldConversationNotice(q, { companyId: issue.companyId, issueId: issue.id })) return { kind: "explained" };
  const [explained] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt), gt(issueComments.createdAt, message.createdAt),
    sql`${issueComments.presentation}->>'kind' = 'system_notice'`,
    sql`${issueComments.presentation}->>'tone' in ('danger', 'warning')`,
    sql`coalesce(${issueComments.metadata}->>'recoveryResponsibility', 'user') <> 'system'`,
    sql`not starts_with(coalesce(${issueComments.metadata}->>'authorizationReason', ''), ${UNANSWERED_MESSAGE_REASON_PREFIX})`)).limit(1);
  if (explained) return { kind: "explained" };

  const held = isNativeContinuationRefusal(run) || HELD_CODES.has(code);
  const paused = code === UNANSWERED_MESSAGE_AGENT_PAUSED_CODE;
  const pausedName = agentRow?.name?.trim() || "This agent";
  const waiting = WAITING_KIND_CODES.has(code);
  const heldReply = heldReplyRun && run ? {
    version: 1 as const, sourceRunId: run.id,
    // A sole prior question card is retained only as a continuation link; it
    // is not named as the cause unless activeIssueInteractionCondition chose it.
    cardId: heldReplyCard?.id ?? (continuationCardIds.length === 1 ? continuationCardIds[0]! : null),
    cardName: heldReplyCard ? heldReplyCardName(heldReplyCard) : null,
    relatedCardName,
    cardRole: heldReplyCard ? "active_hold" as const : continuationCardIds.length === 1 ? "continuation_reference" as const : null,
    continuationCardIds: [...new Set([heldReplyCard?.id, ...continuationCardIds].filter((id): id is string => Boolean(id)))],
    state: heldReplyCard ? "waiting_for_card" as const : "generic" as const,
  } : null;
  const heldName = agentRow?.name?.trim() || "The agent";
  const body = heldReply ? heldReplyBody(heldName, heldReply.cardName, heldReply.relatedCardName ?? null, Boolean(heldReplyCard))
    : paused ? agentPausedText(pausedName) : waiting ? UNANSWERED_MESSAGE_WAITING_TEXT
    : code === UNANSWERED_MESSAGE_NO_REPLY_CODE ? UNANSWERED_MESSAGE_NO_REPLY_TEXT
    : code === UNANSWERED_MESSAGE_NO_RUN_CODE ? UNANSWERED_MESSAGE_NO_RUN_TEXT
      : held ? HELD_PREDECESSOR_NOTICE : UNANSWERED_MESSAGE_TEXT;
  const notice = buildStrandedRecoveryEscalationNotice({
    seed: {
      title: heldReply ? "The reply is held in run activity" : paused ? `${pausedName} is paused`
        : waiting ? "Your message is waiting to start" : held ? "This conversation can't continue" : "Your message wasn't answered",
      body,
      tone: heldReply || waiting ? "info" : paused ? "warning" : "warning",
      nextAction: heldReply ? "Open the source run to read the held reply."
        : paused ? `Ask a board user or ${pausedName}'s manager to resume ${pausedName}.`
        : waiting ? "No action is needed; it will start by itself."
        : held ? "Assign this agent a new task to continue." : "Send the message again; if it fails again, assign this agent a new task.",
    },
    recoveryActionId: boardHold?.id ?? null,
    recoveryOwner: null,
    recoveryResponsibility: "user",
    sourceRun: run && !waiting ? { id: run.id, agentId: run.agentId, status: run.status, errorCode: heldReply ? undefined : code } : null,
    // A waiting note is not a failure: no "Failure code" row, a marker row instead.
    failureCode: waiting ? undefined : run ? undefined : code,
  });
  if (waiting) notice.metadata.sections.push({ title: "Status", rows: [keyValueRow(WAITING_ROW_LABEL, code)] });
  if (heldReply) notice.metadata = withHeldReplyMetadata(notice.metadata, heldReply) as never;
  return { kind: "notice", reason, code, notice, ...(upgrading ? { upgradeCommentId: upgrading } : {}) };
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
