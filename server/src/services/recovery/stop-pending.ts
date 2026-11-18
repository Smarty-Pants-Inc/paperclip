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

/** An answer can retire a no-request diagnostic, never prove execution Stop. */
async function laterSuccessfulTaskRun(tx: Db, input: TaskBinding) {
  if (!input.runIds.length) return null;
  const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue || issue.status === "cancelled" || issue.cancelledAt) return null;
  const runs = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, input.runIds)));
  if (runs.length !== input.runIds.length || runs.some(hasRecordedStopRequest)) return null;
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
  if (!hasTaskStopPending(action) || nextAction.includes(STOP_PENDING_ACTION)) return nextAction;
  return `${STOP_PENDING_ACTION}\n\n${nextAction}`;
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
  if (prior && JSON.stringify(prior.runIds) === JSON.stringify(runIds) && existing!.nextAction.includes(STOP_PENDING_CODE)) return;
  const now = new Date();
  await notify(tx, input);
  // A different binding is a different hold. Retain the old standalone record
  // as history, not a refreshed budget or a claim about the old executor's Stop.
  if (existing && prior?.standalone && existing.cause === STOP_PENDING_CODE) {
    await tx.update(issueRecoveryActions).set({ status: "cancelled", outcome: "cancelled", resolvedAt: now,
      resolutionNote: "Task execution ownership changed; this inspection did not prove the earlier execution stopped.", updatedAt: now,
    }).where(eq(issueRecoveryActions.id, existing.id));
    existing = undefined;
  }
  const previousNextAction = existing
    ? (prior && existing.nextAction.endsWith(STOP_PENDING_ACTION) ? prior.previousNextAction : existing.nextAction)
    : null;
  const pending: StopPending = { schema: STOP_PENDING_SCHEMA, code: STOP_PENDING_CODE, owner: input.source, runIds,
    escalation: "board", automaticAttemptsExhausted: true, attemptCount: 1, maxAttempts: 1,
    checkedAt: now.toISOString(), standalone: !existing, previousNextAction };
  let actionId: string;
  if (existing) {
    // Do not consume, resolve or replace a stronger recovery obligation. Only
    // annotate its existing task-visible state; its owner and budget stay intact.
    await tx.update(issueRecoveryActions).set({ evidence: { ...existing.evidence, stopPending: pending },
      nextAction: previousNextAction ? `${previousNextAction}\n\n${STOP_PENDING_ACTION}` : STOP_PENDING_ACTION, updatedAt: now,
    }).where(eq(issueRecoveryActions.id, existing.id));
    actionId = existing.id;
  } else {
    const [created] = await tx.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", status: "escalated", ownerType: "board", cause: STOP_PENDING_CODE,
      fingerprint: `${STOP_PENDING_CODE}:${runIds.join(":")}`, evidence: { runId: runIds[0], stopPending: pending },
      nextAction: STOP_PENDING_ACTION, attemptCount: 1, maxAttempts: 1, lastAttemptAt: now, outcome: "escalated",
    }).returning({ id: issueRecoveryActions.id });
    actionId = created!.id;
  }
  await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "recovery",
    action: "issue.execution_stop_pending", entityType: "issue", entityId: input.issueId,
    details: { code: STOP_PENDING_CODE, source: input.source, runIds, recoveryActionId: actionId,
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
  if (pending.standalone && existing.cause === STOP_PENDING_CODE) {
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
      nextAction: existing.nextAction.endsWith(STOP_PENDING_ACTION)
        ? pending.previousNextAction ?? "" : existing.nextAction.replace(STOP_PENDING_ACTION, "").trim(),
    }).where(eq(issueRecoveryActions.id, existing.id));
  }
  await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "recovery",
    action: input.answeredByRunId ? "issue.execution_stop_pending_resolved" : "issue.execution_stop_confirmed",
    entityType: "issue", entityId: input.issueId,
    details: { runIds: input.runIds, recoveryActionId: existing.id,
      ...(input.answeredByRunId ? { reason: "later_run_succeeded", answeredByRunId: input.answeredByRunId } : {}) },
  }, publications);
}
