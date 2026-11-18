import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { runExecutionsHaveStopped } from "../agent-execution-stop.js";
import { logActivity, type ActivityPublication } from "../activity-log.js";
import { notifyIssueRecovery } from "../issue-recovery-notifications.js";
import { notifyNativeRecoveryNotices } from "../native-recovery-notice-notifications.js";
import { PROVIDER_POLICY_REFUSAL_CODE } from "../native-runtime/native-provider-failure.js";

const STOP_PENDING_CODE = "execution_stop_pending";
export const STOP_PENDING_SCHEMA = "paperclip.task-stop-pending.v1";
const STOP_PENDING_ACTION = "Stop pending (execution_stop_pending): Paperclip cannot confirm that the previous execution stopped. " +
  "Recovery retained this task's claims and escalated the failed inspection to the board. " +
  "Inspect the bound runs and use the owning agent's Stop/cleanup controls. If its Stop work is parked, inspect its evidence before using the agent's Retry. " +
  "The task stays held until Stop is proved; starting a replacement or waiting longer is not proof.";

/** A Stop's receipt can land seconds after the run finishes; the 30 s sweep must not flash a card first. */
export const TASK_STOP_PENDING_SETTLE_MS = 60_000;
/** A run nobody stopped whose environment is still held this long is stuck, not settling. */
export const TASK_ENVIRONMENT_UNRELEASED_LATE_MS = 15 * 60_000;
const ENVIRONMENT_UNRELEASED_CODE = "execution_environment_unreleased";
export const ENVIRONMENT_UNRELEASED_TEXT = "The previous run's environment hasn't been released, so this task can't start yet.";
// The board's Force release (POST /issues/:id/admin/force-release, routes/issues.ts) clears the
// task's checkout and execution claims unconditionally, so it is a next step that really works.
const ENVIRONMENT_UNRELEASED_ACTION = `${ENVIRONMENT_UNRELEASED_TEXT} ` +
  "Check the environment with its provider, then a board user can use Force release on this task so it can start.";

type TaskBinding = { companyId: string; issueId: string; runIds: string[] };
type StopPending = {
  schema: typeof STOP_PENDING_SCHEMA;
  code: typeof STOP_PENDING_CODE;
  owner: string;
  runIds: string[];
  escalation: "board";
  automaticAttemptsExhausted: true;
  attemptCount: 1;
  maxAttempts: 1;
  checkedAt: string;
  standalone: boolean;
  previousNextAction: string | null;
  /** Option (b): no person Stop; the environment stayed unreleased past the late bound. */
  environmentUnreleased?: true;
};
/** Recorded requests, not a terminal status or a paused assignee, establish intent. */
export function hasRecordedStopRequest(run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">): boolean {
  const result = run.resultJson ?? {};
  return run.errorCode === "operator_interrupted" ||
    ["executionCancellation", "startupCancellation", "nativeCancellation", "cancellation",
      "operatorInterrupted", "cancelledByActorType", "cancelledByUserId", "interruptedByActorType",
      "queuedCommentInterruptQueueId", "pauseRequested", "stopRequested", "interruptRequested"]
      .some(key => result[key] != null && result[key] !== false);
}

/** C1 guard 1 keys only on the user actor that the person Stop route (POST /heartbeat-runs/:id/cancel,
 * routes/agents.ts) and the person Interrupt (operatorInterruptCancelOptions, routes/issues.ts) write.
 * System, reassignment, manager (cancelledByActorType "agent") and Done (terminalizationStopConfirmed)
 * cancels are not a person Stop. */
export function hasPersonStopRequest(run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson">): boolean {
  const result = run.resultJson ?? {};
  return result.cancelledByActorType === "user" && result.terminalizationStopConfirmed !== true;
}
/** The person Stop's request time: the 60 s clock for a Stopped run that has no finishedAt. */
function personStopRequestedAt(run: typeof heartbeatRuns.$inferSelect): number {
  const result = run.resultJson ?? {};
  const read = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>) : {};
  const times = [read(result.executionCancellation).requestedAt, read(result.cancellation).recordedAt,
    read(result.startupCancellation).requestedAt].map(value => typeof value === "string" ? Date.parse(value) : NaN)
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : (run.updatedAt ?? run.createdAt).getTime();
}
function pendingAction(pending: Pick<StopPending, "environmentUnreleased"> | null | undefined) {
  return pending?.environmentUnreleased ? ENVIRONMENT_UNRELEASED_ACTION : STOP_PENDING_ACTION;
}

/** An answer can retire a no-request diagnostic, never prove execution Stop. */
async function laterSuccessfulTaskRun(tx: Db, input: TaskBinding, options: { afterPersonStop?: boolean } = {}) {
  if (!input.runIds.length) return null;
  const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue || issue.status === "cancelled" || issue.cancelledAt) return null;
  const runs = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, input.runIds)));
  if (runs.length !== input.runIds.length || (!options.afterPersonStop && runs.some(hasRecordedStopRequest))) return null;
  // Compare in PostgreSQL: JS Date truncates microseconds and could otherwise
  // misclassify the named succeeded run itself as a later answer.
  const sourceTime = tx.select({ at: sql<Date>`max(${heartbeatRuns.createdAt})` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, input.runIds)));
  return (await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.status, "succeeded"),
    notInArray(heartbeatRuns.id, input.runIds), sql`${heartbeatRuns.createdAt} > (${sourceTime})`,
    sql`coalesce(${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text,
      ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1))[0] ?? null;
}

/** Ordinary task progress is not evidence that this retained executor stopped. */
export function hasTaskStopPending(action: { evidence: Record<string, unknown> }): boolean {
  const value = action.evidence.stopPending;
  return Boolean(value && typeof value === "object" && "schema" in value && value.schema === STOP_PENDING_SCHEMA);
}
/** Keep the protected Stop instruction in the ordinary card's nextAction.
 * Read-model copy (for example an exhausted workspace) remains secondary, not
 * a replacement for this independent obligation. Do not duplicate saved copy. */
export function withTaskStopPendingInstruction(action: { evidence: Record<string, unknown> }, nextAction: string): string {
  if (!hasTaskStopPending(action)) return nextAction;
  const instruction = pendingAction(action.evidence.stopPending as StopPending);
  if (nextAction.includes(instruction)) return nextAction;
  return `${instruction}\n\n${nextAction}`;
}
function stopPending(action: typeof issueRecoveryActions.$inferSelect): StopPending | null {
  const value = action.evidence.stopPending;
  return value && typeof value === "object" && "schema" in value && value.schema === STOP_PENDING_SCHEMA
    ? value as StopPending : null;
}
async function activeAction(tx: Db, input: TaskBinding): Promise<typeof issueRecoveryActions.$inferSelect | undefined> {
  return (await tx.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).for("update"))[0];
}
/** Re-check the diagnostic's named owners, not just the task's current binding.
 * Caller holds the task lock. Take run locks before recovery-action locks. */
export async function recheckTaskStopPending(tx: Db, input: { companyId: string; issueId: string }, publications: ActivityPublication[]) {
  const actions = await tx.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  ));
  const pending = actions.map(stopPending).find(value => value !== null);
  if (!pending?.runIds.length) return;
  const runIds = [...new Set(pending.runIds)].sort();
  await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, runIds),
  )).orderBy(asc(heartbeatRuns.id)).for("update");
  const binding = { ...input, runIds };
  if (await runExecutionsHaveStopped(tx, input.companyId, runIds)) {
    await clearTaskStopPending(tx, binding, publications);
    return;
  }
  const answer = await laterSuccessfulTaskRun(tx, binding);
  if (answer) await clearTaskStopPending(tx, { ...binding, answeredByRunId: answer.id }, publications);
}

async function notify(tx: Db, input: TaskBinding) {
  await notifyIssueRecovery(tx, { companyId: input.companyId });
  await notifyNativeRecoveryNotices(tx, { companyId: input.companyId, issueId: input.issueId });
}

/** Caller holds the task and bound-run locks. One failed read-only inspection
 * immediately escalates, rather than inventing an unowned automatic Stop loop.
 * The existing recovery-action projection is durable even for an unassigned
 * task or a historical run without issue context. No task workflow state changes. */
export async function recordTaskStopPending(tx: Db, input: TaskBinding & { source: string }, publications: ActivityPublication[]) {
  const boundRunIds = [...new Set(input.runIds)].sort();
  const boundRuns = boundRunIds.length ? await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, boundRunIds),
  )) : [];
  // C1 guard 1: the 'Stop pending' card says a person's Stop is unproven, so it
  // needs a person Stop recorded by the Stop/Interrupt routes' user actor.
  const stoppedRuns = boundRuns.filter(hasPersonStopRequest);
  const now0 = Date.now();
  let environmentUnreleased: true | undefined;
  if (!stoppedRuns.length) {
    // Option (b): nobody stopped it. Within 15 min of its finish a held lease is
    // transient and never cards; past that the task is stuck and the card says
    // what is TRUE (the environment is not released), never 'Stop pending'.
    const lateBefore = now0 - TASK_ENVIRONMENT_UNRELEASED_LATE_MS;
    if (!boundRuns.length || !boundRuns.every(run => run.finishedAt && run.finishedAt.getTime() <= lateBefore)) return;
    environmentUnreleased = true;
  } else {
    // C1 guard 2: give the stop receipt time to land: 60 s after the finish, or
    // after the Stop request when the run has not finished. No exception.
    const settledBefore = now0 - TASK_STOP_PENDING_SETTLE_MS;
    if (!stoppedRuns.some(run => (run.finishedAt?.getTime() ?? personStopRequestedAt(run)) <= settledBefore)) return;
    // No card once a successor has answered after the person's Stop.
    if (await laterSuccessfulTaskRun(tx, { ...input, runIds: boundRunIds }, { afterPersonStop: true })) return;
  }
  // A provider refusal is not a Stop request. Suppress only that diagnostic,
  // never the underlying execution claims or any genuinely requested Stop.
  const noStopRefusals = new Set(boundRuns.filter(run => run.status === "failed"
    && run.errorCode === PROVIDER_POLICY_REFUSAL_CODE && !hasRecordedStopRequest(run)).map(run => run.id));
  const runIds = boundRunIds.filter(id => !noStopRefusals.has(id));
  if (!runIds.length) return;
  // Do not recreate a retired no-Stop card on every tick while the old lease
  // remains held. A later answer does not release either execution claim.
  if (await laterSuccessfulTaskRun(tx, { ...input, runIds })) return;
  let existing = await activeAction(tx, input);
  const prior = existing && stopPending(existing);
  const instruction = pendingAction({ environmentUnreleased });
  if (prior && JSON.stringify(prior.runIds) === JSON.stringify(runIds) && Boolean(prior.environmentUnreleased) === Boolean(environmentUnreleased)
    && existing!.nextAction.includes(environmentUnreleased ? instruction : STOP_PENDING_CODE)) return;
  const now = new Date();
  await notify(tx, input);
  // A different binding is a different hold. Retain the old standalone record
  // as history, not a refreshed budget or a claim about the old executor's Stop.
  if (existing && prior?.standalone && [STOP_PENDING_CODE, ENVIRONMENT_UNRELEASED_CODE].includes(existing.cause)) {
    await tx.update(issueRecoveryActions).set({ status: "cancelled", outcome: "cancelled", resolvedAt: now,
      resolutionNote: "Task execution ownership changed; this inspection did not prove the earlier execution stopped.", updatedAt: now,
    }).where(eq(issueRecoveryActions.id, existing.id));
    existing = undefined;
  }
  const previousNextAction = existing
    ? (prior && existing.nextAction.endsWith(pendingAction(prior)) ? prior.previousNextAction : existing.nextAction)
    : null;
  const pending: StopPending = { schema: STOP_PENDING_SCHEMA, code: STOP_PENDING_CODE, owner: input.source, runIds,
    escalation: "board", automaticAttemptsExhausted: true, attemptCount: 1, maxAttempts: 1,
    checkedAt: now.toISOString(), standalone: !existing, previousNextAction, ...(environmentUnreleased ? { environmentUnreleased } : {}) };
  let actionId: string;
  if (existing) {
    // Do not consume, resolve or replace a stronger recovery obligation. Only
    // annotate its existing task-visible state; its owner and budget stay intact.
    await tx.update(issueRecoveryActions).set({ evidence: { ...existing.evidence, stopPending: pending },
      nextAction: previousNextAction ? `${previousNextAction}\n\n${instruction}` : instruction, updatedAt: now,
    }).where(eq(issueRecoveryActions.id, existing.id));
    actionId = existing.id;
  } else {
    const [created] = await tx.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", status: "escalated", ownerType: "board",
      cause: environmentUnreleased ? ENVIRONMENT_UNRELEASED_CODE : STOP_PENDING_CODE,
      fingerprint: `${environmentUnreleased ? ENVIRONMENT_UNRELEASED_CODE : STOP_PENDING_CODE}:${runIds.join(":")}`,
      evidence: { runId: runIds[0], stopPending: pending }, nextAction: instruction, attemptCount: 1, maxAttempts: 1, lastAttemptAt: now, outcome: "escalated",
    }).returning({ id: issueRecoveryActions.id });
    actionId = created!.id;
  }
  await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "recovery",
    action: environmentUnreleased ? "issue.execution_environment_unreleased" : "issue.execution_stop_pending",
    entityType: "issue", entityId: input.issueId,
    details: { code: environmentUnreleased ? ENVIRONMENT_UNRELEASED_CODE : STOP_PENDING_CODE, source: input.source, runIds, recoveryActionId: actionId,
      escalation: "board", automaticInspectionLimit: 1 },
  }, publications);
}

/** Caller supplies guarded Stop proof, or a checked later answer without any
 * recorded Stop request. Neither resolution mutates execution claims. */
export async function clearTaskStopPending(tx: Db, input: TaskBinding & { answeredByRunId?: string }, publications: ActivityPublication[]) {
  const existing = await activeAction(tx, input);
  const pending = existing && stopPending(existing);
  if (!existing || !pending) return;
  await notify(tx, input);
  const now = new Date();
  if (pending.standalone && [STOP_PENDING_CODE, ENVIRONMENT_UNRELEASED_CODE].includes(existing.cause)) {
    const sameBinding = JSON.stringify(pending.runIds) === JSON.stringify([...new Set(input.runIds)].sort());
    await tx.update(issueRecoveryActions).set({ status: sameBinding ? "resolved" : "cancelled",
      outcome: sameBinding ? "restored" : "cancelled", resolvedAt: now, updatedAt: now,
      resolutionNote: sameBinding ? input.answeredByRunId
        ? `Later run ${input.answeredByRunId} of this task succeeded; no Stop was requested. Execution claims are unchanged.`
        : "Stop proved under the task and bound-run locks."
        : "Task execution ownership changed; the old Stop inspection is historical.",
    }).where(eq(issueRecoveryActions.id, existing.id));
  } else {
    const { stopPending: _pending, ...evidence } = existing.evidence;
    await tx.update(issueRecoveryActions).set({ evidence, updatedAt: now,
      nextAction: existing.nextAction.endsWith(pendingAction(pending))
        ? pending.previousNextAction ?? "" : existing.nextAction.replace(pendingAction(pending), "").trim(),
    }).where(eq(issueRecoveryActions.id, existing.id));
  }
  await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "recovery",
    action: input.answeredByRunId ? "issue.execution_stop_pending_resolved" : "issue.execution_stop_confirmed",
    entityType: "issue", entityId: input.issueId,
    details: { runIds: input.runIds, recoveryActionId: existing.id,
      ...(input.answeredByRunId ? { reason: "later_run_succeeded", answeredByRunId: input.answeredByRunId } : {}) },
  }, publications);
}
