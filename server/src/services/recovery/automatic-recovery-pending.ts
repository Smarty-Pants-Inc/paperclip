import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { NATIVE_NO_REPLAY_HOLD_CAUSE } from "../workspace-recovery-fallback-discovery.js";

/**
 * ONE shared answer to "is the system's own AUTOMATIC recovery for this run
 * still on its way?" Every writer of person-facing resend advice for a run
 * (the unanswered-message sweep; the native held-predecessor writer) calls it
 * and posts no "send it again" while it is true. Durable rows only, never time:
 * the callers keep their own bounds.
 *
 * The automatic path, by line:
 * - A native run that fails with `native_continuation_requires_reconciliation`
 *   gets a no-replay hold (legacy-execution-recovery.ts:227-265: fingerprint
 *   `native-workspace:<run>`, status resolved, outcome blocked, ownerType
 *   board, `automaticRecovery {policy preserve_without_replay_v1, replay
 *   blocked}`). The hold row is written AFTER the run's terminal status, so a
 *   writer can see the failed run before any hold exists (case a).
 * - Saved-work recovery then works on that hold (`evidence.systemRecovery`,
 *   system-recovery-state.ts:56 states scheduled/running/awaiting_evidence).
 * - The fresh-continuation fallback owns such holds (fresh-continuation-
 *   fallback.ts:298-318 isHumanGate / isOwnedReconciliationHold) and turns
 *   them into outcome restored, ownerType system, `freshContinuation`,
 *   `continuationDelivery: pending` (:933-957), keeping the hold's resolvedAt.
 * - The continuation is delivered as an `issue_recovery_action_restored` wake
 *   with `payload.recoveryActionId` (execution-recovery-resolution.ts:566-584),
 *   which marks `continuationDelivery: delivered, continuationRunId`.
 *
 * TRUE while any of:
 * (a) the run failed (run row, or its native finalization coordinator) with a
 *     code the system always reconciles automatically
 *     and no recovery action for the run exists yet, or one is still active
 *     and not board/person owned, or its no-replay hold is still waiting for
 *     saved-work recovery or the fresh continuation (not a human gate, not
 *     exhausted, not checked as person-owned);
 * (b) a system recovery action for the run is resolved restored with its
 *     continuation delivery pending (or not written yet), or delivered to a
 *     run that has not started yet;
 * (c) a restored/continuation wake for the run's action is queued or deferred.
 * FALSE when reconciliation concluded without continuing (blocked by a person
 * gate, cancelled, delivery invalidated, saved-work recovery exhausted, the
 * fallback found it person-owned) or the restored run already ended: the
 * callers then post their one true notice. Board-owned active/escalated
 * actions are manual: false, today's behaviour.
 */
export const AUTO_RECONCILED_FAILURE_CODES: readonly string[] = [NATIVE_NO_REPLAY_HOLD_CAUSE];

const SAVED_WORK_IN_FLIGHT = ["scheduled", "running", "awaiting_evidence"];
const FALLBACK_CHECK_DEAD = ["person_owned", "not_applicable", "dependency_wait"];
const UNFINISHED_RUN = ["failed", "timed_out", "interrupted", "cancelled"];
const NOT_STARTED_RUN = ["queued", "scheduled_retry"];
const PENDING_WAKE = ["queued", "deferred", "deferred_issue_execution"];
const FRESH_CONTINUATION_ACTOR = "fresh-continuation";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type Action = Pick<typeof issueRecoveryActions.$inferSelect,
  "id" | "status" | "outcome" | "ownerType" | "ownerUserId" | "cause" | "evidence">;

/** A decision a person made or still owes on the hold: never automatic. */
function personGate(action: Action): boolean {
  const reconciliation = object(action.evidence.executionReconciliation);
  return Boolean(action.ownerUserId || action.evidence.ownerGoneAttestation || action.evidence.explicitUserContinuation
    || (action.evidence.executionReconciliation && reconciliation.actorId !== FRESH_CONTINUATION_ACTOR));
}

export async function automaticRecoveryPending(db: Db,
  input: { companyId: string; issueId: string; runId: string }): Promise<boolean> {
  const [run] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId)));
  if (!run) return false;
  const actions: Action[] = await db.select({ id: issueRecoveryActions.id, status: issueRecoveryActions.status,
    outcome: issueRecoveryActions.outcome, ownerType: issueRecoveryActions.ownerType, ownerUserId: issueRecoveryActions.ownerUserId,
    cause: issueRecoveryActions.cause, evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    or(sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${run.id}`,
      sql`${issueRecoveryActions.evidence}->'freshContinuation'->>'sourceRunId' = ${run.id}`)));
  // The run row, or its native finalization coordinator, which records the
  // failure code before the run row is terminal (native-safe-replacement.ts:122-126):
  // the held writer runs inside the failing run, before its terminal write.
  const [coordinator] = await db.select({ failureCode: nativeRunFinalizations.failureCode }).from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.runId, run.id)));
  const autoReconciled = (UNFINISHED_RUN.includes(run.status) && AUTO_RECONCILED_FAILURE_CODES.includes(run.errorCode ?? ""))
    || AUTO_RECONCILED_FAILURE_CODES.includes(coordinator?.failureCode ?? "");

  // (a) the failure is reconciled automatically and its hold is not written yet.
  if (autoReconciled && actions.length === 0) return true;

  // (c) a continuation wake for one of the run's actions is queued or deferred.
  if (actions.length) {
    const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId), inArray(agentWakeupRequests.status, PENDING_WAKE),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
      inArray(sql`${agentWakeupRequests.payload}->>'recoveryActionId'`, actions.map(action => action.id)))).limit(1);
    if (wake) return true;
  }

  for (const action of actions) {
    if (personGate(action)) continue;
    const evidence = action.evidence;
    const fresh = object(evidence.freshContinuation);
    const delivery = String(evidence.continuationDelivery ?? "");
    // (b) the automatic continuation is decided and not yet started.
    if (fresh.sourceRunId === run.id || (action.status === "resolved" && action.outcome === "restored" && action.ownerType === "system")) {
      // Pending, or (for an automatically reconciled failure) the restore is
      // decided and its delivery not written yet.
      if (delivery === "pending" || (autoReconciled && delivery === "" && evidence.continuationRunId === undefined)) return true;
      if (delivery === "delivered" && typeof evidence.continuationRunId === "string") {
        const [successor] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, evidence.continuationRunId)));
        if (successor && NOT_STARTED_RUN.includes(successor.status)) return true;
      }
      continue;
    }
    if (!autoReconciled) continue;
    // (a) reconciliation of an automatically reconciled failure has not concluded.
    if (["active", "escalated"].includes(action.status)) {
      if (action.ownerType !== "board") return true;
      continue;
    }
    const savedWork = object(evidence.systemRecovery);
    if (SAVED_WORK_IN_FLIGHT.includes(String(savedWork.state))) return true;
    const noReplay = object(evidence.automaticRecovery);
    if (action.status === "resolved" && action.outcome === "blocked" && noReplay.runId === run.id
      && noReplay.policy === "preserve_without_replay_v1" && noReplay.replay === "blocked"
      && savedWork.state !== "exhausted"
      && !FALLBACK_CHECK_DEAD.includes(String(object(evidence.freshContinuationCheck).kind))) return true;
  }
  return false;
}
