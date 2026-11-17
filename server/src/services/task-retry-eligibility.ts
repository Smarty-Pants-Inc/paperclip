import { and, desc, eq, inArray, isNull, not, or, sql } from "drizzle-orm";
import { WORKSPACE_RESTORE_AGENT_STOP_WAIT_TEXT, WORKSPACE_RESTORE_COPYBACK_STOP_WAIT_TEXT,
  WORKSPACE_RESTORE_PERSON_BOUND_MS } from "@paperclipai/shared";
import { agents, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { carryContinuationCommentInput } from "../modules/wake-queue/domain/continuation-comment-input.js";
import { answeredPersonMessageSql } from "./person-message-answer.js";
import { executionBlockerPredicate, NEW_TASK_CONTINUE_ACTION, restoreHoldPredicate, restoreHoldReleasedForCurrentOwnerPredicate,
  withoutUnavailableRetry } from "./execution-blocker.js";
import { RECOVERING_SAVED_WORK_NEXT_ACTION, WORKSPACE_RESTORE_PENDING_KEY, workspaceRestoreHoldNextAction } from "./legacy-execution-recovery.js";
import { exhaustedStopWait, readSystemRecovery } from "./system-recovery-state.js";
import { hasRequiredWorkspaceRecovery } from "./workspace-restore-recovery-state.js";
import {
  AGENT_PAUSED_ACTION, AGENT_PAUSED_RETRY_MESSAGE, AUTOMATIC_RECOVERY_MESSAGE, HELD_CONDITION, HELD_PREDECESSOR_NOTICE,
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
  /** fam-retry3 (RFL 20:33Z): every person message Retry's source run carried
   * already has an answer (person-message-answer.ts answeredPersonMessageSql,
   * the predicate the unanswered-person-message notice and the continuation
   * carry use): a Retry would only answer it again. */
  personMessageAnswered?: boolean;
  /** The assignee (or its project / company) is paused: only Resume continues. */
  agentPaused?: boolean;
  /** Paperclip is continuing this conversation by itself (a recovery successor is pending). */
  automaticRecovery?: boolean;
  /** task-retry-stop-gate: the previous run's Stop is unproven. */
  stopGate?: "waiting" | "expired" | null;
  /** A standing held-conversation notice, or the latest run's own prior-owner refusal. */
  heldConversation?: boolean;
  /** restore-card7 (rf-3 15:30Z (3)): the source run's restore hold is exhausted
   * on an unconfirmed stop (system-recovery-state.ts exhaustedStopWait). Retry
   * cannot release it; the stop must be proven first. An agent stop whose every
   * re-arm is spent is NOT this fact (exhaustedStopWait's carve-out): it keeps
   * its Retry. */
  restoreStopWait?: "copyback_stop_unconfirmed" | "agent_stop_unconfirmed" | null;
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
  /** fam-retry2 (upstream's restore-hold semantics): "held" = Retry is accepted
   * once and held behind the restore hold; it runs through upstream's
   * restore-held admission when the files are back (no immediate wake). */
  admission?: "held" | "preserve";
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
  // fam-retry5 (RFL SUPERSEDE-PAUSED-RETRY-UPSTREAM-1117, upstream
  // workspace-recovery-warm-handoff.test.ts "wakes physical preservation from
  // HTTP Retry ... without replaying the provider"): a paused agent's Retry is
  // ACCEPTED for file preservation only ("preserve"). Upstream admits it
  // (task-retry.ts admission, workspace recovery preserves the files) and its
  // heartbeat defers the wake while the agent is not invokable, so no provider
  // turn and no run row. The card still offers no Retry: paused + Resume only.
  if (facts.agentPaused)
    return { ...decision("resume", "agent_paused", AGENT_PAUSED_RETRY_MESSAGE, AGENT_PAUSED_ACTION), admission: "preserve" };
  // fam-retry3: the message is answered above; a Retry is a no-op that says so.
  // A paused agent still wins (R6 G) on every surface: its Retry preserves files
  // and runs no turn either.
  if (facts.personMessageAnswered)
    return decision("message", PERSON_MESSAGE_ANSWERED_REASON, PERSON_MESSAGE_ANSWERED_MESSAGE, null);
  if (facts.automaticRecovery) return decision("wait", "automatic_recovery", AUTOMATIC_RECOVERY_MESSAGE, null);
  if (facts.stopGate === "waiting") return decision("wait", "execution_settling", RETRY_STOP_WAIT_MESSAGE, RETRY_STOP_WAIT_ACTION);
  if (facts.stopGate === "expired")
    return decision("new_task", "execution_stop_unproven", RETRY_STOP_UNPROVEN_MESSAGE, RETRY_STOP_UNPROVEN_ACTION);
  // restore-card7's exhausted stop wait: a wait, not a failure, in card7's shared
  // words (the card's exhaustedSystemRecoveryAction and the chat's
  // workspaceRestoreStopWaitText read the same constants). Before the restore
  // hold: it is that hold's own state, and Retry cannot release it.
  if (facts.restoreStopWait) {
    const text = restoreStopWaitText(facts.restoreStopWait);
    return decision("wait", RESTORE_STOP_WAIT_REASON, text, text);
  }
  // Restore hold: the words are legacy-execution-recovery.ts's (restore-card),
  // never a second mapping here. fam-retry2 (upstream wins): while Paperclip can
  // still put the files back, Retry is ACCEPTED and HELD (the hold's words: "your
  // message is kept and runs when it's back"); only a failed restore refuses.
  if (facts.restoreHold) {
    const text = workspaceRestoreHoldNextAction(facts.restoreHold);
    // fam-retry3 ITEM B: a restore_failed hold whose files Paperclip's workspace
    // recovery owns holds an ACCEPTED Retry; restore-card's "could not be put
    // back... Create a new task" would be false there. It says the recovering
    // words (the same constant a pending hold says); a failed restore with no
    // recovery keeps restore-card's words and the new-task refusal.
    const heldText = hasRequiredWorkspaceRecovery(facts.restoreHold) ? RECOVERING_SAVED_WORK_NEXT_ACTION : text;
    return restoreHoldHoldsRetry(facts.restoreHold)
      ? { ...decision("wait", "workspace_repair_required", heldText, heldText), canRetry: true, admission: "held" }
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
export async function readRetryAuthorityFacts(db: Db, input: { companyId: string; issueId: string; sourceRunId?: string | null }) {
  const { readUnsupersededHeldConversationNotice } = await import("./native-runtime/pi-session-recovery-notice.js");
  const [[assignee], notice, refusals, restoreStopWait, personMessageAnswered] = await Promise.all([
    db.select({ status: agents.status }).from(issues).innerJoin(agents, and(eq(agents.companyId, issues.companyId),
      eq(agents.id, issues.assigneeAgentId))).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).limit(1),
    readUnsupersededHeldConversationNotice(db, { companyId: input.companyId, issueId: input.issueId }),
    heldTaskRetryRefusals(db, input.companyId, [input.issueId]),
    readRestoreStopWait(db, input),
    readPersonMessageAnswered(db, input),
  ]);
  return { agentPaused: assignee?.status === "paused", heldConversation: Boolean(notice),
    heldRefusal: refusals.get(input.issueId) ?? null, restoreStopWait, personMessageAnswered } satisfies RetryAuthorityFacts;
}

export const PERSON_MESSAGE_ANSWERED_REASON = "person_message_already_answered";
export const PERSON_MESSAGE_ANSWERED_MESSAGE = "Already answered above.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** fam-retry3: the personMessageAnswered fact. Retry's source run (the given
 * run, else the task's latest run, as readRestoreStopWait reads it) carried
 * person messages (carryContinuationCommentInput, the continuation seam), and
 * every one of them is answered by the ONE shared predicate
 * (answeredPersonMessageSql). A run that carried no person message, or a
 * message with no published answer (a cancelled or partial run posted
 * nothing), keeps its Retry. */
async function readPersonMessageAnswered(db: Db, input: { companyId: string; issueId: string; sourceRunId?: string | null }) {
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), input.sourceRunId ? eq(heartbeatRuns.id, input.sourceRunId) : or(
      eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`)))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  const carried = ((carryContinuationCommentInput(source?.contextSnapshot).wakeCommentIds as string[] | undefined) ?? [])
    .filter(id => UUID.test(id));
  if (!carried.length) return false;
  const rows = await db.select({ id: issueComments.id, answered: sql<boolean>`${answeredPersonMessageSql({ id: sql`${issueComments.id}`,
    companyId: sql`${issueComments.companyId}`, issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}` })}` })
    .from(issueComments).where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
      inArray(issueComments.id, carried), eq(issueComments.authorType, "user"), isNull(issueComments.deletedAt)));
  return rows.length > 0 && rows.every(row => row.answered === true);
}

/** fam-retry2: a restore hold behind which upstream accepts and holds a Retry
 * (task-retry.ts admission records it deferred and binds it to the hold's
 * systemRecovery; heartbeat admission defers it on the execution blocker until
 * the files are back): the files are owed (pending marker), Paperclip's
 * workspace recovery owns them (hasRequiredWorkspaceRecovery: admission adopts
 * a systemRecovery for it), or a native export awaits reconciliation (no restore
 * failure recorded). A FAILED restore is the rest: a recorded restore failure
 * with no recovery that can put the files back (restoreHoldPredicate's
 * restore_unsafe_archive arm without a recovery record). */
export function restoreHoldHoldsRetry(evidence: Record<string, unknown>) {
  return evidence[WORKSPACE_RESTORE_PENDING_KEY] === true || hasRequiredWorkspaceRecovery(evidence)
    || typeof evidence.workspaceRestoreFailure !== "string";
}

export const RESTORE_STOP_WAIT_REASON = "workspace_restore_stop_wait";
function restoreStopWaitText(code: "copyback_stop_unconfirmed" | "agent_stop_unconfirmed") {
  return code === "copyback_stop_unconfirmed" ? WORKSPACE_RESTORE_COPYBACK_STOP_WAIT_TEXT : WORKSPACE_RESTORE_AGENT_STOP_WAIT_TEXT;
}
/** The restoreStopWait fact of one hold's evidence (card7's exhaustedStopWait,
 * carve-out included). restore-card8 item 5 (rf-3 J5): an owed hold's wait ends
 * at the person bound (WORKSPACE_RESTORE_PERSON_BOUND_MS after the hold was
 * written, the run projection's rule): the card and chat then read it as
 * delayed and this authority offers Retry. */
export function restoreStopWaitFact(evidence: Record<string, unknown> | null | undefined, holdWrittenAt?: Date | null,
  now = Date.now()) {
  if (evidence?.[WORKSPACE_RESTORE_PENDING_KEY] === true && holdWrittenAt
    && holdWrittenAt.getTime() + WORKSPACE_RESTORE_PERSON_BOUND_MS <= now) return null;
  return exhaustedStopWait(readSystemRecovery(evidence), evidence);
}
/** The restoreStopWait fact for a task: the same rows restore-card7's admission
 * check read (task-retry.ts, deleted there): any recovery action of this task
 * whose source run is the task's latest run (Retry's source), while that run is
 * not queued, running or a scheduled retry. The exhausted state pre-exists any
 * Retry: admission's adoption only adds a 'scheduled' systemRecovery to a row
 * that has none (system-recovery.ts adoptSystemRecovery / createSystemRecovery). */
async function readRestoreStopWait(db: Db, input: { companyId: string; issueId: string }) {
  const [latest] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), or(eq(heartbeatRuns.issueId, input.issueId),
      eq(heartbeatRuns.nativeIssueId, input.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`)))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  if (!latest || ["queued", "running", "scheduled_retry"].includes(latest.status)) return null;
  const records = await db.select({ evidence: issueRecoveryActions.evidence, createdAt: issueRecoveryActions.createdAt })
    .from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    sql`${issueRecoveryActions.evidence}->>'runId' = ${latest.id}`));
  for (const record of records) {
    const code = restoreStopWaitFact(record.evidence, record.createdAt);
    if (code) return code;
  }
  return null;
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
 * - (agent_paused is accepted for preservation only since fam-retry5, not refused.)
 * A refusal that admission itself records (previous_execution_unverified,
 * cleanup_quarantined, the fence reasons, ...) is answered by upstream #21497's
 * taskRetryRefusal on the Retry route after admission, not here.
 */
// retry-fold6 (rf-3 FAIL 1/2): the card's other two refusals are refused here too,
// with the same facts the card reads:
// - workspace_repair_required: a restore hold the execution blocker withholds
//   Retry for (the card's own check); its words are restore-card's.
// - execution_stop_unproven: the Retry's source Stop expired unproven (the
//   Stop gate); a waiting Stop is not refused (admission defers it visibly).
// - workspace_restore_stop_wait (restore-card7): the hold waits on an unconfirmed
//   stop; a repeat refuses too (the fact does not depend on the click).
// - person_message_already_answered (fam-retry3): the source run's person message
//   has an answer above; a Retry, a repeat included, runs nothing.
// fam-retry5: agent_paused is NOT refused here any more (upstream accepts it for
// preservation only; see decideRetryAuthority's "preserve" admission).
const REFUSED_BEFORE_ADMISSION: ReadonlySet<string> = new Set(["workspace_repair_required", "execution_stop_unproven",
  RESTORE_STOP_WAIT_REASON, PERSON_MESSAGE_ANSWERED_REASON]);
// fam-retry2: a restore hold Paperclip can still release is an accept-held
// outcome (canRetry, admission "held"), not a refusal, for a new click and for
// an idempotent repeat alike (the repeat returns the same held acceptance; no
// second wake). A failed restore, a pause, an expired Stop and card7's
// exhausted stop wait still refuse, a repeat included.
export async function readRetryAdmissionAuthority(db: Db, input: { companyId: string; issueId: string;
  sourceRunId?: string | null }): Promise<RetryAuthority> {
  const [{ getExecutionBlocker }, { readRetryStopGate }] = await Promise.all([import("./execution-blocker.js"), import("./task-retry-stop-gate.js")]);
  const hold = await readRestoreHoldEvidence(db, input);
  const restoreHold = hold && (await getExecutionBlocker(db, input.companyId, input.issueId))?.canRetry === false ? hold : null;
  const gate = input.sourceRunId
    ? (await readRetryStopGate(db, { companyId: input.companyId, issueId: input.issueId, sourceRunId: input.sourceRunId }))?.state : null;
  return decideRetryAuthority({ ...await readRetryAuthorityFacts(db, { companyId: input.companyId, issueId: input.issueId,
    sourceRunId: input.sourceRunId }), restoreHold,
    stopGate: gate === "expired" ? "expired" : null, retrySource: true });
}
export function retryRefusedBeforeAdmissionReason(reason: string) { return REFUSED_BEFORE_ADMISSION.has(reason); }
export async function retryRefusedBeforeAdmission(db: Db, input: { companyId: string; issueId: string;
  sourceRunId?: string | null }): Promise<RetryAuthority | null> {
  const authority = await readRetryAdmissionAuthority(db, input);
  return !authority.canRetry && REFUSED_BEFORE_ADMISSION.has(authority.reason) ? authority : null;
}
/** fam-retry2: the accept-held outcome of the one authority, or null. */
export async function retryHeldBehindRestore(db: Db, input: { companyId: string; issueId: string; sourceRunId?: string | null }) {
  const authority = await readRetryAdmissionAuthority(db, input);
  return authority.admission === "held" ? authority : null;
}

/** retry-fold6 (rf-3 FAIL 3): a held conversation's note states the held
 * condition and then the one authority's instruction at post time (Retry's
 * words, or Resume for a paused agent), never a fixed "Press Retry". */
export function heldConversationNoticeText(authority: Pick<RetryAuthority, "nextAction">) {
  return `${HELD_CONDITION} ${authority.nextAction ?? HELD_RETRY_ACTION}`;
}
export async function readHeldConversationNoticeText(db: Db, input: { companyId: string; issueId: string }) {
  return heldConversationNoticeText(decideRetryAuthority({ ...await readRetryAuthorityFacts(db, input),
    heldConversation: true, retrySource: true }));
}
