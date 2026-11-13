import { and, desc, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  type Db,
} from "@paperclipai/db";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { issueService } from "../issues.js";
import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import { HELD_PREDECESSOR_NOTICE } from "../native-runtime/held-predecessor-notice-text.js";
import { readUnsupersededHeldConversationNotice } from "../native-runtime/pi-session-recovery-notice.js";
import { conversationTurnAnswered } from "../native-runtime/native-governance.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";

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
/** After the run ends, retries and recovery are scheduled; let them land first. */
export const UNANSWERED_MESSAGE_SETTLE_MS = 15_000;
/** A saved message that no run took (its wake failed or is held). */
export const UNANSWERED_MESSAGE_NO_RUN_GRACE_MS = 120_000;
/** A native same-run retry that is this late is not going to start by itself. */
const OVERDUE_NATIVE_RETRY_MS = 5 * 60_000;

export const UNANSWERED_MESSAGE_NO_REPLY_CODE = "no_reply";
export const UNANSWERED_MESSAGE_NO_RUN_CODE = "no_run";
export const UNANSWERED_MESSAGE_UNCLASSIFIED_CODE = "unclassified_failure";

export const UNANSWERED_MESSAGE_TEXT =
  "Your message wasn't answered. Sending it again is safe; if it fails again, assign this agent a new task.";
export const UNANSWERED_MESSAGE_NO_RUN_TEXT =
  "Your message is saved, but no run started for it. Sending it again is safe; if it fails again, assign this agent a new task.";
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
 * SQL: this issue row has a person's message within the lookback that no agent
 * answered and that has no notice yet, or an unanswered-message notice that a
 * later agent comment answered. The stranded sweep visits such tasks in every
 * open status, including blocked.
 */
export function unansweredPersonMessageCondition(issueId: AnyPgColumn, companyId: AnyPgColumn): SQL {
  const since = new Date(Date.now() - UNANSWERED_MESSAGE_LOOKBACK_MS).toISOString();
  return sql`(exists (select 1 from ${issueComments} m
      where m.company_id = ${companyId} and m.issue_id = ${issueId} and m.author_type = 'user'
        and m.deleted_at is null and m.created_at > ${since}::timestamptz
        and not exists (select 1 from ${issueComments} a where a.company_id = m.company_id and a.issue_id = m.issue_id
          and a.author_type = 'agent' and a.deleted_at is null and a.created_at > m.created_at)
        and not exists (select 1 from ${issueComments} n where n.company_id = m.company_id and n.issue_id = m.issue_id
          and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || m.id::text))
    or exists (select 1 from ${issueComments} n
      join ${issueComments} m on m.company_id = n.company_id and m.issue_id = n.issue_id
        and m.id::text = substr(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1})
      where n.company_id = ${companyId} and n.issue_id = ${issueId}
      and n.author_type = 'system' and n.deleted_at is null
      and starts_with(n.metadata->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and exists (select 1 from ${issueComments} a where a.company_id = n.company_id and a.issue_id = n.issue_id
        and a.author_type = 'agent' and a.deleted_at is null and a.created_at > m.created_at)))`;
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
      and ${issueComments.createdAt} > ${since}::timestamptz
      and not exists (select 1 from ${issueComments} a where a.company_id = ${issueComments.companyId}
        and a.issue_id = ${issueComments.issueId} and a.author_type = 'agent' and a.deleted_at is null
        and a.created_at > ${issueComments.createdAt})
      and not exists (select 1 from ${issueComments} n where n.company_id = ${issueComments.companyId}
        and n.issue_id = ${issueComments.issueId}
        and n.metadata->>'authorizationReason' = ${UNANSWERED_MESSAGE_REASON_PREFIX} || ${issueComments.id}::text))
    or (${issueComments.authorType} = 'system' and ${issueComments.deletedAt} is null
      and starts_with(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX})
      and exists (select 1 from ${issueComments} m join ${issueComments} a on a.company_id = m.company_id
          and a.issue_id = m.issue_id and a.author_type = 'agent' and a.deleted_at is null and a.created_at > m.created_at
        where m.company_id = ${issueComments.companyId} and m.issue_id = ${issueComments.issueId}
          and m.id::text = substr(${issueComments.metadata}->>'authorizationReason', ${UNANSWERED_MESSAGE_REASON_PREFIX.length + 1}))))`;
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
export async function settleUnansweredPersonMessage(
  db: Db,
  input: { companyId: string; issueId: string; now?: Date; issueCreatedAtGte?: Date | null },
): Promise<UnansweredMessageOutcome> {
  const now = input.now ?? new Date();
  const [issue] = await db.select({
    id: issues.id, companyId: issues.companyId, status: issues.status, hiddenAt: issues.hiddenAt,
    assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt,
  }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue) return { kind: "none" };
  if (input.issueCreatedAtGte && issue.createdAt < input.issueCreatedAtGte) return { kind: "out_of_scope" };

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
        and exists (select 1 from ${issueComments} a where a.company_id = n.company_id and a.issue_id = n.issue_id
          and a.author_type = 'agent' and a.deleted_at is null and a.created_at > m.created_at))`);
  });

  const decision = await decideUnansweredMessage(db, issue, now);
  if (decision.kind !== "notice") return decision;
  const commentId = await db.transaction(async tx => {
    // The issue fence that comment writers, the executor's held-notice writer
    // and execution admission take. The SAME predicate is evaluated again
    // under it: an answer (prose or the turn's own card), a held notice, a
    // newer message, a run or a wake that committed while this sweep waited
    // means no notice.
    await tx.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("no key update");
    const fenced = await decideUnansweredMessage(tx as unknown as Db, issue, now);
    if (fenced.kind !== "notice" || fenced.reason !== decision.reason) return null;
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
type Decision = Exclude<UnansweredMessageOutcome, { kind: "noticed" }>
  | { kind: "notice"; reason: string; code: string; notice: ReturnType<typeof buildStrandedRecoveryEscalationNotice> };

/** The one predicate: run outside the fence to skip the lock in the common
 * case, and again unchanged inside it before writing. Reads only. */
async function decideUnansweredMessage(q: Db, issue: DecisionIssue, now: Date): Promise<Decision> {
  if (issue.hiddenAt || !issue.assigneeAgentId || issue.assigneeUserId
    || !["todo", "in_progress", "in_review", "blocked"].includes(issue.status)) return { kind: "out_of_scope" };
  const agentId = issue.assigneeAgentId;

  const [message] = await q.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt)))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  if (!message || message.createdAt.getTime() < now.getTime() - UNANSWERED_MESSAGE_LOOKBACK_MS) return { kind: "none" };
  const [answer] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "agent"), isNull(issueComments.deletedAt), gt(issueComments.createdAt, message.createdAt))).limit(1);
  if (answer) return { kind: "answered" };
  const reason = `${UNANSWERED_MESSAGE_REASON_PREFIX}${message.id}`;
  const [noticed] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    sql`${reasonOf(issueComments.metadata)} = ${reason}`)).limit(1);
  if (noticed) return { kind: "noticed_before" };

  // Something will still answer it by itself: a live or scheduled run.
  const issueRun = or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`);
  const [liveRun] = await q.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun,
    inArray(heartbeatRuns.status, LIVE))).limit(1);
  if (liveRun) return { kind: "pending", recheckAt: now.getTime() + 30_000 };

  // A board-owned hold means nothing moves by itself: queued wakes behind it
  // do not count as a further attempt.
  const [boardHold] = await q.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, issue.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
    inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.ownerType, "board")))
    .orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  if (!boardHold) {
    const wakes = await q.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, agentId),
      inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution"])));
    if (wakes.some(wake => wakeCarriesIssue(wake.payload, issue.id))) return { kind: "pending", recheckAt: now.getTime() + 30_000 };
  }

  // The run this message started, else the latest run after it.
  const runs = await q.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, error: heartbeatRuns.error,
    errorCode: heartbeatRuns.errorCode, contextSnapshot: heartbeatRuns.contextSnapshot, finishedAt: heartbeatRuns.finishedAt,
    updatedAt: heartbeatRuns.updatedAt, createdAt: heartbeatRuns.createdAt, issueCommentStatus: heartbeatRuns.issueCommentStatus,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.agentId, agentId), issueRun,
    gt(heartbeatRuns.createdAt, new Date(message.createdAt.getTime() - 60 * 60_000))))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(20);
  // Only a run that carries THIS message is evidence about it. An unrelated
  // run (a timer, or the continuation that replaced a cancelled deferred wake
  // with no comment ids) is not: the message's own wake path decides.
  const run = runs.find(candidate => runCarriesMessage(candidate.contextSnapshot, message.id)) ?? null;
  // Paperclip's per-turn response rule (doc/execution-semantics.md:2649-2658,
  // native-governance.ts conversationTurnAnswered): only a pending question or
  // confirmation card that the message's OWN run created stands in for its
  // reply. A card from an earlier turn or one the board addressed to someone
  // else, and any approval, can hold the task but do not answer the message.
  if (run && !(await conversationTurnAnswered({ db: q, companyId: issue.companyId, issueId: issue.id, runId: run.id }))) {
    return { kind: "answered" };
  }

  let code: string;
  if (!run) {
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
    if (run.issueCommentStatus === "retry_queued") return { kind: "pending", recheckAt: now.getTime() + 30_000 };
    const [coordinator] = await q.select({ phase: nativeRunFinalizations.phase, nextAttemptAt: nativeRunFinalizations.nextAttemptAt })
      .from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, issue.companyId), eq(nativeRunFinalizations.runId, run.id)));
    if (coordinator && !boardHold) {
      if (NATIVE_PENDING_PHASES.includes(coordinator.phase)) return { kind: "pending", recheckAt: now.getTime() + 30_000 };
      if (coordinator.phase === "retryable_failure"
        && (!coordinator.nextAttemptAt || coordinator.nextAttemptAt.getTime() + OVERDUE_NATIVE_RETRY_MS > now.getTime())) {
        return { kind: "pending", recheckAt: Math.max(now.getTime() + 30_000, (coordinator.nextAttemptAt?.getTime() ?? 0) + OVERDUE_NATIVE_RETRY_MS) };
      }
    }
    if (run.status === "succeeded") {
      // An accepted native result that declared a blocker or asked for
      // attention is the agent's answer: it named whose move it is
      // (upstream's waiting reason "assignee_declared_block").
      // (the stored envelope is { result, terminal }, recovery/service.ts:1572).
      const [accepted] = await q.select({ resultJson: nativeRunResults.resultJson }).from(nativeRunResults).where(and(
        eq(nativeRunResults.companyId, issue.companyId), eq(nativeRunResults.runId, run.id),
        eq(nativeRunResults.schemaStatus, "accepted"))).limit(1);
      const envelope = (accepted?.resultJson ?? {}) as Record<string, unknown>;
      const result = (envelope.result && typeof envelope.result === "object" ? envelope.result : envelope) as Record<string, unknown>;
      if (result.blocker || result.reportedWorkDisposition === "blocked"
        || (Array.isArray(result.attentionRequests) && result.attentionRequests.length > 0)) return { kind: "answered" };
    }
    code = run.status === "succeeded" ? UNANSWERED_MESSAGE_NO_REPLY_CODE : unansweredMessageCode(run);
  }

  // Already explained: the executor's held notice for this conversation, or a
  // person-facing recovery notice posted after the message.
  if (await readUnsupersededHeldConversationNotice(q, { companyId: issue.companyId, issueId: issue.id })) return { kind: "explained" };
  const [explained] = await q.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, issue.companyId), eq(issueComments.issueId, issue.id),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt), gt(issueComments.createdAt, message.createdAt),
    sql`${issueComments.presentation}->>'kind' = 'system_notice'`,
    sql`${issueComments.presentation}->>'tone' in ('danger', 'warning')`,
    sql`coalesce(${issueComments.metadata}->>'recoveryResponsibility', 'user') <> 'system'`)).limit(1);
  if (explained) return { kind: "explained" };

  const held = HELD_CODES.has(code);
  const body = code === UNANSWERED_MESSAGE_NO_REPLY_CODE ? UNANSWERED_MESSAGE_NO_REPLY_TEXT
    : code === UNANSWERED_MESSAGE_NO_RUN_CODE ? UNANSWERED_MESSAGE_NO_RUN_TEXT
      : held ? HELD_PREDECESSOR_NOTICE : UNANSWERED_MESSAGE_TEXT;
  const notice = buildStrandedRecoveryEscalationNotice({
    seed: {
      title: held ? "This conversation can't continue" : "Your message wasn't answered",
      body,
      tone: "warning",
      nextAction: held ? "Assign this agent a new task to continue." : "Send the message again; if it fails again, assign this agent a new task.",
    },
    recoveryActionId: boardHold?.id ?? null,
    recoveryOwner: null,
    recoveryResponsibility: "user",
    sourceRun: run ? { id: run.id, agentId: run.agentId, status: run.status, errorCode: code } : null,
    failureCode: run ? undefined : code,
  });
  return { kind: "notice", reason, code, notice };
}


/** One task the recovery worker already flagged (its batched page query found
 * a person's message to settle): no candidate lookup of its own. */
export async function settleUnansweredPersonMessagesForTask(
  db: Db,
  input: { companyId: string; issueId: string; issueCreatedAtGte?: Date | null; onDeferredDeadline?: (at: number) => void; now?: Date },
): Promise<{ noticed: number; pending: number }> {
  const outcome = await settleUnansweredPersonMessage(db, input);
  if (outcome.kind === "pending") input.onDeferredDeadline?.(outcome.recheckAt);
  return { noticed: outcome.kind === "noticed" ? 1 : 0, pending: outcome.kind === "pending" ? 1 : 0 };
}

/** The sweep's pass outside the worker (startup, a direct call): every task in
 * scope with a person's message to settle, found with one candidate query. */
export async function settleUnansweredPersonMessages(
  db: Db,
  input: { companyId?: string; issueId?: string; issueCreatedAtGte?: Date | null; onDeferredDeadline?: (at: number) => void; now?: Date },
): Promise<{ noticed: number; pending: number }> {
  const candidates = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues).where(and(
    input.companyId ? eq(issues.companyId, input.companyId) : undefined,
    input.issueId ? eq(issues.id, input.issueId) : undefined,
    input.issueCreatedAtGte ? sql`${issues.createdAt} >= ${input.issueCreatedAtGte.toISOString()}::timestamptz` : undefined,
    unansweredPersonMessageCondition(issues.id, issues.companyId),
  )).limit(200);
  const result = { noticed: 0, pending: 0 };
  for (const candidate of candidates) {
    const outcome = await settleUnansweredPersonMessage(db, { companyId: candidate.companyId, issueId: candidate.id, now: input.now });
    if (outcome.kind === "noticed") result.noticed += 1;
    if (outcome.kind === "pending") {
      result.pending += 1;
      input.onDeferredDeadline?.(outcome.recheckAt);
    }
  }
  return result;
}
