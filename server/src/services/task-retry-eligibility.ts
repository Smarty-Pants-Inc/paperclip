import { and, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { executionBlockerPredicate, NEW_TASK_CONTINUE_ACTION, restoreHoldPredicate, restoreHoldReleasedForCurrentOwnerPredicate,
  withoutUnavailableRetry } from "./execution-blocker.js";
import { WORKSPACE_RESTORE_PENDING_KEY, workspaceRestoreHoldNextAction } from "./legacy-execution-recovery.js";
import {
  AGENT_PAUSED_ACTION, AGENT_PAUSED_RETRY_MESSAGE, AUTOMATIC_RECOVERY_MESSAGE, HELD_PREDECESSOR_NOTICE,
  HELD_NEW_TASK_MESSAGE, HELD_RECOVERED_NEW_TASK_MESSAGE, HELD_RECOVERED_WORK_MESSAGE, HELD_RETRY_ACTION, NEW_TASK_ACTION, NO_SAVED_WORK_NEW_TASK_MESSAGE, NO_SAVED_WORK_RETRY_ACTION, NO_SAVED_WORK_RETRY_MESSAGE,
  RECOVERED_WORK_CONTINUE_MESSAGE, RECOVERED_WORK_MESSAGE, RECOVERED_WORK_RETRY_ACTION, RECOVERED_WORK_RETRY_MESSAGE,
  RETRY_STOP_UNPROVEN_ACTION, RETRY_STOP_UNPROVEN_MESSAGE, RETRY_STOP_WAIT_ACTION, RETRY_STOP_WAIT_MESSAGE, SEND_MESSAGE_ACTION,
  STOPPED_TASK_NEW_TASK_MESSAGE, STOPPED_TASK_RETRY_ACTION, STOPPED_TASK_RETRY_MESSAGE,
} from "./native-runtime/held-predecessor-notice-text.js";

const REFUSALS_A_CLICK_CANNOT_CHANGE: ReadonlySet<string> = new Set([
  "cancelled_by_operator", "retry_source_changed", "workspace_owner_stop_required", "previous_execution_unverified",
  "execution_stop_unproven",
  // The Runner's prior-owner fence is NOT here (follow-Paperclip Cut B R8, PV2):
  // a held Retry rotates onto a fresh thread with the conversation's history.
]);

function HELD_FENCE_REFUSALS() {
  return ["prior_owner_scope_mismatch", "prior_owner_terminal_state_indeterminate", "prior_owner_still_active",
    "legacy_prior_owner_scope_mismatch", "legacy_prior_owner_terminal_state_indeterminate"];
}
const HELD_REFUSALS: ReadonlySet<string> = new Set(HELD_FENCE_REFUSALS());

export function heldRetryOffersRetry(reason: string | null | undefined, cleanupSettling = false): boolean {
  if (!reason) return true;
  return !REFUSALS_A_CLICK_CANNOT_CHANGE.has(reason) && (reason !== "cleanup_quarantined" || !cleanupSettling);
}

export async function heldTaskRetryRefusals(db: Pick<Db, "selectDistinctOn">, companyId: string, issueIds: string[]): Promise<Map<string, string>> {
  if (!issueIds.length) return new Map();
  const issueId = sql<string>`${agentWakeupRequests.payload}->>'issueId'`;
  const rows = await db.selectDistinctOn([issueId], { issueId, sourceRunId: sql<string | null>`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}'`,
    reason: sql<string | null>`${agentWakeupRequests.payload}#>>'{executionWait,reason}'`,
    latestRunId: sql<string | null>`(select latest.id::text from ${heartbeatRuns} latest
      where latest.company_id = ${companyId} and (latest.issue_id::text = ${agentWakeupRequests.payload}->>'issueId'
        or latest.native_issue_id::text = ${agentWakeupRequests.payload}->>'issueId'
        or latest.context_snapshot->>'issueId' = ${agentWakeupRequests.payload}->>'issueId')
      order by latest.created_at desc, latest.id desc limit 1)` })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId),
      eq(agentWakeupRequests.reason, "task_retry"), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      isNull(agentWakeupRequests.runId), inArray(issueId, issueIds),
      sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}' is not null`))
    .orderBy(issueId, desc(agentWakeupRequests.requestedAt));
  return new Map(rows.flatMap(row => row.reason && row.sourceRunId && row.sourceRunId === row.latestRunId
    ? [[row.issueId, row.reason] as const] : []));
}

export type RetryUserAction = "retry" | "message" | "resume" | "new_task" | "wait";

/** Facts about a task's current stop / hold / pause state. Every surface that
 * offers Retry or tells a person what to do next reads them through
 * decideRetryAuthority, so the button and the words cannot disagree. */
export type RetryAuthorityFacts = {
  /** The assignee (or its project / company) is paused: only Resume continues. */
  agentPaused?: boolean;
  /** Paperclip is continuing this conversation by itself (a recovery successor is pending). */
  automaticRecovery?: boolean;
  /** task-retry-stop-gate: the previous run's Stop is unproven. */
  stopGate?: "waiting" | "expired" | null;
  /** A standing held-conversation notice, or the latest run's own prior-owner refusal. */
  heldConversation?: boolean;
  /** An active restore hold's evidence (legacy-execution-recovery.ts owns its words). */
  restoreHold?: Record<string, unknown> | null;
  /** The latest deferred Retry's recorded refusal reason. */
  heldRefusal?: string | null;
  /** Task Retry's own source check (canRetryStoppedRun, same assignee, task open) passes. */
  retrySource?: boolean;
  /** The source run's saved work is recovered (workspace-recovery receipt). */
  savedWork?: "recovered" | null;
  /** The coordinator proved nothing was saved before the run stopped. */
  stoppedBeforeWork?: boolean;
  runStatus?: string | null;
  /** The decision is the settlement note of an intentional Stop (stop-pending). */
  stopKind?: "person" | "manager" | null;
};

export type RetryAuthority = {
  canRetry: boolean;
  userAction: RetryUserAction;
  /** The card's text; null keeps the surface's own neutral text (no instruction to contradict). */
  cardText: string | null;
  /** The transcript note's text: always the card's. */
  transcriptNotice: string | null;
  /** The one instruction (an exact substring of cardText). */
  nextAction: string | null;
  reason: string;
};

function decision(userAction: RetryUserAction, reason: string, text: string | null, nextAction: string | null): RetryAuthority {
  return { canRetry: userAction === "retry", userAction, cardText: text, transcriptNotice: text, nextAction, reason };
}

/**
 * THE Retry authority (retry fold). One decision returns whether Retry is
 * offered or accepted, the card text, the transcript note and the next action
 * TOGETHER. The card (task-interruption-presentation.ts, execution-blocker.ts,
 * workspace-recovery-receipt.ts), the transcript (stop-pending.ts,
 * unanswered-person-message.ts) and the Retry API (task-retry.ts) all read it.
 * Order is precedence: a paused agent, then an automatic recovery, then an
 * unproven REQUESTED Stop, then a restore hold, then Retry's own source check.
 * A held conversation never withholds Retry (follow-Paperclip Cut B R8): it only
 * chooses the words, which name Retry's real effect (a fresh run with history).
 */
export function decideRetryAuthority(facts: RetryAuthorityFacts): RetryAuthority {
  if (facts.agentPaused) return decision("resume", "agent_paused", AGENT_PAUSED_RETRY_MESSAGE, AGENT_PAUSED_ACTION);
  if (facts.automaticRecovery) return decision("wait", "automatic_recovery", AUTOMATIC_RECOVERY_MESSAGE, null);
  if (facts.stopGate === "waiting") return decision("wait", "execution_settling", RETRY_STOP_WAIT_MESSAGE, RETRY_STOP_WAIT_ACTION);
  if (facts.stopGate === "expired")
    return decision("new_task", "execution_stop_unproven", RETRY_STOP_UNPROVEN_MESSAGE, RETRY_STOP_UNPROVEN_ACTION);
  // Restore hold: the words are legacy-execution-recovery.ts's (restore-card),
  // never a second mapping here. Files owed: wait while they are recovered.
  if (facts.restoreHold) {
    const text = workspaceRestoreHoldNextAction(facts.restoreHold);
    return facts.restoreHold[WORKSPACE_RESTORE_PENDING_KEY] === true
      ? decision("wait", "workspace_repair_required", text, text)
      : decision("new_task", "workspace_repair_required", withoutUnavailableRetry(text, false), NEW_TASK_CONTINUE_ACTION);
  }
  const recovered = facts.savedWork === "recovered";
  const held = facts.heldConversation || HELD_REFUSALS.has(facts.heldRefusal ?? "");
  if (facts.heldRefusal && !held && !heldRetryOffersRetry(facts.heldRefusal))
    return decision(["cancelled_by_operator", "retry_source_changed"].includes(facts.heldRefusal) ? "message" : "new_task",
      facts.heldRefusal, null, null);
  if (facts.retrySource) {
    if (facts.stoppedBeforeWork) return decision("retry", "retry", NO_SAVED_WORK_RETRY_MESSAGE, NO_SAVED_WORK_RETRY_ACTION);
    if (facts.stopKind) return decision("retry", "retry", STOPPED_TASK_RETRY_MESSAGE, STOPPED_TASK_RETRY_ACTION);
    if (held) return decision("retry", "retry", recovered ? HELD_RECOVERED_WORK_MESSAGE : HELD_PREDECESSOR_NOTICE, HELD_RETRY_ACTION);
    if (recovered) return decision("retry", "retry", RECOVERED_WORK_RETRY_MESSAGE, RECOVERED_WORK_RETRY_ACTION);
    return decision("retry", "retry", null, null);
  }
  // Retry refused for its own reason on a run that is not Retry's source (a
  // stopped, not failed, run): the held thread's one action is a new task. A
  // failed run's transcript keeps its status-only words (upstream's projection).
  if (held && facts.runStatus !== "failed" && facts.runStatus !== "timed_out") return decision("new_task", "conversation_held", facts.stoppedBeforeWork ? NO_SAVED_WORK_NEW_TASK_MESSAGE
    : facts.stopKind ? STOPPED_TASK_NEW_TASK_MESSAGE : recovered ? HELD_RECOVERED_NEW_TASK_MESSAGE : HELD_NEW_TASK_MESSAGE, NEW_TASK_ACTION);
  if (facts.stoppedBeforeWork) return decision("new_task", "retry_unavailable", NO_SAVED_WORK_NEW_TASK_MESSAGE, NEW_TASK_ACTION);
  if (facts.stopKind) return decision("new_task", "retry_unavailable", STOPPED_TASK_NEW_TASK_MESSAGE, NEW_TASK_ACTION);
  if (recovered) return facts.runStatus === "failed" || facts.runStatus === "timed_out"
    ? decision("message", "retry_unavailable", RECOVERED_WORK_MESSAGE, null)
    : decision("message", "retry_unavailable", RECOVERED_WORK_CONTINUE_MESSAGE, SEND_MESSAGE_ACTION);
  return decision("message", "retry_unavailable", null, null);
}

/** Facts every DB-backed surface shares: the assignee's pause, a standing held
 * notice, and the deferred Retry's refusal. One read per task; callers add
 * what only they know. A run's own refusal text is not authority (follow-
 * Paperclip Cut B R4): the executor's durable HELD notice is. */
export async function readRetryAuthorityFacts(db: Db, input: { companyId: string; issueId: string }) {
  const { readUnsupersededHeldConversationNotice } = await import("./native-runtime/pi-session-recovery-notice.js");
  const [[assignee], notice, refusals] = await Promise.all([
    db.select({ status: agents.status }).from(issues).innerJoin(agents, and(eq(agents.companyId, issues.companyId),
      eq(agents.id, issues.assigneeAgentId))).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).limit(1),
    readUnsupersededHeldConversationNotice(db, { companyId: input.companyId, issueId: input.issueId }),
    heldTaskRetryRefusals(db, input.companyId, [input.issueId]),
  ]);
  return { agentPaused: assignee?.status === "paused", heldConversation: Boolean(notice),
    heldRefusal: refusals.get(input.issueId) ?? null } satisfies RetryAuthorityFacts;
}

/** The task's active restore hold evidence (the hold the execution blocker
 * reads), for the authority's restoreHold fact; null when there is none. */
export async function readRestoreHoldEvidence(db: Db, input: { companyId: string; issueId: string }) {
  const [hold] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    executionBlockerPredicate(), not(restoreHoldReleasedForCurrentOwnerPredicate()), restoreHoldPredicate())).limit(1);
  return hold?.evidence ?? null;
}

/**
 * Retry fold (judge R8, rf-3 A/B): the decisions a Retry is refused for before
 * anything is saved, on every Retry path (task Retry API and chat Retry):
 * (A held conversation is not refused: PV2's judged rule, Retry rotates it onto
 * a fresh thread with its history; card, API and chat accept it alike.)
 * - agent_paused: the card says "Resume this agent"; a Retry runs nothing.
 * A refusal that admission itself records (previous_execution_unverified,
 * cleanup_quarantined, the fence reasons, ...) is answered by upstream #21497's
 * taskRetryRefusal on the Retry route after admission, not here.
 */
const REFUSED_BEFORE_ADMISSION: ReadonlySet<string> = new Set(["agent_paused"]);
export async function retryRefusedBeforeAdmission(db: Db, input: { companyId: string; issueId: string }): Promise<RetryAuthority | null> {
  const authority = decideRetryAuthority({ ...await readRetryAuthorityFacts(db, input), retrySource: true });
  return !authority.canRetry && REFUSED_BEFORE_ADMISSION.has(authority.reason) ? authority : null;
}
