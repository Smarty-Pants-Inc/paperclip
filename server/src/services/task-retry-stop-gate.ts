import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { STOP_PENDING_SCHEMA } from "./recovery/stop-pending.js";
import { executionBlockerPredicate, restoreHoldReleasedForCurrentOwnerPredicate } from "./execution-blocker.js";

/**
 * One predicate for a person's task Retry while the previous run's Stop is
 * unproven (a stop-pending record, or a stopped run that still holds the task).
 * Admission defers the Retry visibly while it waits (`waiting`); after the
 * bound the Retry is retired with one instruction, the API refuses another
 * Retry and the card offers none (`expired`). Nothing is rotated or replayed:
 * the task's saved work, runs and traces stay as they are.
 */
export const RETRY_STOP_PROOF_BOUND_MS = 5 * 60_000;
export const RETRY_STOP_WAIT_REASON = "execution_settling";
export const RETRY_STOP_UNPROVEN_REASON = "execution_stop_unproven";
export const RETRY_STOP_WAIT_MESSAGE = "Retry is waiting for the previous execution to stop. Your message is saved.";
export const RETRY_STOP_UNPROVEN_MESSAGE = "Paperclip could not confirm that the previous run stopped, so Retry can't continue this conversation. "
  + "To continue, assign this agent a new task.";
const RETIRED_NOTE_REASON = "retry_stop_unproven:";

export type RetryStopGate = { state: "waiting" | "expired"; since: Date; cause: "stop_pending" | "source_settling" | "retired" };

export async function readRetryStopGate(db: Db, input: {
  companyId: string; issueId: string; sourceRunId: string; requestedAt?: Date | null; now?: number;
}): Promise<RetryStopGate | null> {
  const now = input.now ?? Date.now();
  const state = (since: Date): RetryStopGate["state"] => now - since.getTime() >= RETRY_STOP_PROOF_BOUND_MS ? "expired" : "waiting";
  // With a hold, Retry goes through the full admission, which applies its own
  // Stop proofs (coordinator, termination receipts) and, when it starts, a
  // failure leaves that hold to the automatic follow-up. This gate covers only
  // the case where no hold exists and admission's refusal would be swallowed.
  const [hold] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    executionBlockerPredicate(), sql`not ${restoreHoldReleasedForCurrentOwnerPredicate()}`)).limit(1);
  if (hold) return null;
  // A Retry already retired for this exact source keeps the same answer.
  const [retired] = await db.select({ finishedAt: agentWakeupRequests.finishedAt }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.status, "failed"),
    eq(agentWakeupRequests.error, RETRY_STOP_UNPROVEN_REASON),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    sql`${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}' = ${input.sourceRunId}`)).limit(1);
  if (retired) return { state: "expired", since: retired.finishedAt ?? new Date(now), cause: "retired" };
  const [pending] = await db.select({ evidence: issueRecoveryActions.evidence, createdAt: issueRecoveryActions.createdAt })
    .from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      inArray(issueRecoveryActions.status, ["active", "escalated"]),
      or(eq(issueRecoveryActions.cause, "execution_stop_pending"),
        sql`${issueRecoveryActions.evidence}#>>'{stopPending,schema}' = ${STOP_PENDING_SCHEMA}`)))
    .orderBy(desc(issueRecoveryActions.updatedAt)).limit(1);
  if (pending) {
    const checkedAt = Date.parse(String((pending.evidence.stopPending as { checkedAt?: unknown } | undefined)?.checkedAt ?? ""));
    const since = new Date(Number.isFinite(checkedAt) ? checkedAt : pending.createdAt.getTime());
    return { state: state(since), since, cause: "stop_pending" };
  }
  // A stopped native run that still holds the task has not settled: its hold
  // (or its absence) is not known yet, so a Retry cannot be judged.
  const [source] = await db.select({ finishedAt: heartbeatRuns.finishedAt, runtimeMode: heartbeatRuns.runtimeMode,
    executionRunId: issues.executionRunId }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.companyId, heartbeatRuns.companyId), eq(issues.id, input.issueId)))
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId))).limit(1);
  if (source?.runtimeMode === "native" && source.finishedAt && source.executionRunId === input.sourceRunId) {
    const since = input.requestedAt ?? source.finishedAt;
    return { state: state(since), since, cause: "source_settling" };
  }
  return null;
}

/** Retire a waiting Retry past the bound: the wake ends, and the transcript
 * says the same one instruction as the card, once. */
export async function retireUnprovenStopRetry(db: Db, input: { companyId: string; issueId: string; requestId: string; agentId: string; sourceRunId: string }) {
  const now = new Date();
  await db.update(agentWakeupRequests).set({ status: "failed", error: RETRY_STOP_UNPROVEN_REASON, finishedAt: now, updatedAt: now })
    .where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.requestId),
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]), sql`${agentWakeupRequests.runId} is null`));
  const reason = `${RETIRED_NOTE_REASON}${input.requestId}`;
  const [said] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    sql`${issueComments.metadata}->>'authorizationReason' = ${reason}`)).limit(1);
  if (said) return;
  const { issueService } = await import("./issues.js");
  await issueService(db).addComment(input.issueId, RETRY_STOP_UNPROVEN_MESSAGE, {}, { authorType: "system", presentation: {
    kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: true,
  }, metadata: { version: 1, authorizationReason: reason,
    sections: [{ rows: [{ type: "run_link", runId: input.sourceRunId, agentId: input.agentId, title: "Stopped run" }] }] } }, db);
}
