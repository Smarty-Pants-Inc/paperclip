import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { runExecutionsHaveStopped } from "../agent-execution-stop.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { notifyIssueRecovery } from "../issue-recovery-notifications.js";
import { notifyNativeRecoveryNotices } from "../native-recovery-notice-notifications.js";

const STOP_PENDING_CODE = "execution_stop_pending";
export const STOP_PENDING_SCHEMA = "paperclip.task-stop-pending.v1";
const STOP_PENDING_FINDING = "Paperclip cannot confirm that the previous execution stopped.";
/** The card's own finding, for the person's held message. It names no wait
 * and promises no automatic start (adopt-stopu-bound2). */
export const STOP_PENDING_PERSON_LINE = `Stop pending: ${STOP_PENDING_FINDING} Your message is saved.`;
/** adopt-stopu-card5 (RFL ruling (a)): a person's Stop card says only what the code does.
 * The card is written only after PERSON_STOP_CARD_AFTER_MS, by which time the stopped
 * executor has exited (its in-memory gate, heartbeat/queue.ts predecessor_settling_in_process,
 * is gone) and the release-site guard exported the box before releasing it. An ordinary new
 * message is then admitted at once (no durable hold applies) on a fresh machine: the old
 * box's lease is pending_cleanup, which the reuse filter excludes. While the export is
 * unproven the box is never released, so person_stop_export_pending holds instead with
 * its own line. Pre-Stop messages stay Send-only. Stop proof retires the card. */
export const STOP_PENDING_PERSON_ACTION =
  `Stop pending: ${STOP_PENDING_FINDING} New messages you send start now on a fresh machine; messages waiting from before the Stop still need Send.`;
/** ONE bound for a person's Stop card, read by BOTH writers: the recovery sweep's
 * deferral (recovery/service.ts) and the cleanup retry (recordPersonStopCleanupPending,
 * called from heartbeat/recovery.ts). Measured from nativeCancellation.recordedAt. */
export const PERSON_STOP_CARD_AFTER_MS = 5 * 60_000;
type PersonStopRun = Parameters<typeof hasAcknowledgedNativeStopIntent>[0] & { runtimeMode: string | null };
/** A person's acknowledged run-only Stop of a native run. */
export function isPersonStop(run: PersonStopRun): boolean {
  return run.status === "cancelled" && run.runtimeMode === "native" && hasAcknowledgedNativeStopIntent(run);
}
/** When a person's Stop card becomes due, or null: not a person's Stop, or no usable
 * Stop time (missing, invalid or future recordedAt), which earns no grace. */
export function personStopCardBoundAt(run: PersonStopRun, now = Date.now()): number | null {
  if (!isPersonStop(run)) return null;
  const recordedAt = (run.resultJson?.nativeCancellation as Record<string, unknown> | undefined)?.recordedAt;
  const at = typeof recordedAt === "string" ? Date.parse(recordedAt) : NaN;
  return Number.isFinite(at) && at <= now ? at + PERSON_STOP_CARD_AFTER_MS : null;
}
const STOP_PENDING_ACTION = `Stop pending (execution_stop_pending): ${STOP_PENDING_FINDING} ` +
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
  /** adopt-stopu-card2: a person's Stop; the card carries STOP_PENDING_PERSON_ACTION. */
  personStop?: true;
};
const stopPendingCopy = (pending: Pick<StopPending, "personStop"> | null | undefined) =>
  pending?.personStop ? STOP_PENDING_PERSON_ACTION : STOP_PENDING_ACTION;
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
  if (!hasTaskStopPending(action)) return nextAction;
  const copy = stopPendingCopy(action.evidence.stopPending as StopPending);
  if (nextAction.includes(copy)) return nextAction;
  return `${copy}\n\n${nextAction}`;
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
  const runIds = [...new Set(input.runIds)].sort();
  // Do not recreate a retired no-Stop card on every tick while the old lease
  // remains held. A later answer does not release either execution claim.
  if (await laterSuccessfulTaskRun(tx, { ...input, runIds })) return;
  let existing = await activeAction(tx, input);
  const prior = existing && stopPending(existing);
  // One card per binding, whichever writer comes first (no double card).
  if (prior && JSON.stringify(prior.runIds) === JSON.stringify(runIds) && existing!.nextAction.includes(stopPendingCopy(prior))) return;
  // adopt-stopu-card2: the copy follows the bound runs, not the writer, so every
  // writer of this card (sweep, stranded escalation, cleanup retry) says the same.
  const boundRuns = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), inArray(heartbeatRuns.id, runIds)));
  const personStop = runIds.length > 0 && boundRuns.length === runIds.length && boundRuns.every(isPersonStop);
  const copy = personStop ? STOP_PENDING_PERSON_ACTION : STOP_PENDING_ACTION;
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
    ? (prior && existing.nextAction.endsWith(stopPendingCopy(prior)) ? prior.previousNextAction : existing.nextAction)
    : null;
  const pending: StopPending = { schema: STOP_PENDING_SCHEMA, code: STOP_PENDING_CODE, owner: input.source, runIds,
    escalation: "board", automaticAttemptsExhausted: true, attemptCount: 1, maxAttempts: 1,
    checkedAt: now.toISOString(), standalone: !existing, previousNextAction, ...(personStop ? { personStop: true as const } : {}) };
  let actionId: string;
  if (existing) {
    // Do not consume, resolve or replace a stronger recovery obligation. Only
    // annotate its existing task-visible state; its owner and budget stay intact.
    await tx.update(issueRecoveryActions).set({ evidence: { ...existing.evidence, stopPending: pending },
      nextAction: previousNextAction ? `${previousNextAction}\n\n${copy}` : copy, updatedAt: now,
    }).where(eq(issueRecoveryActions.id, existing.id));
    actionId = existing.id;
  } else {
    const [created] = await tx.insert(issueRecoveryActions).values({ companyId: input.companyId, sourceIssueId: input.issueId,
      kind: "active_run_watchdog", status: "escalated", ownerType: "board", cause: STOP_PENDING_CODE,
      fingerprint: `${STOP_PENDING_CODE}:${runIds.join(":")}`, evidence: { runId: runIds[0], stopPending: pending },
      nextAction: copy, attemptCount: 1, maxAttempts: 1, lastAttemptAt: now, outcome: "escalated",
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
      nextAction: existing.nextAction.endsWith(stopPendingCopy(pending))
        ? pending.previousNextAction ?? "" : existing.nextAction.replace(stopPendingCopy(pending), "").trim(),
    }).where(eq(issueRecoveryActions.id, existing.id));
  }
  await logActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "recovery",
    action: input.answeredByRunId ? "issue.execution_stop_pending_resolved" : "issue.execution_stop_confirmed",
    entityType: "issue", entityId: input.issueId,
    details: { runIds: input.runIds, recoveryActionId: existing.id,
      ...(input.answeredByRunId ? { reason: "later_run_succeeded", answeredByRunId: input.answeredByRunId } : {}) },
  }, publications);
}

type StoppedRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "status" | "nativeIssueId" | "issueId" | "resultJson" | "runtimeMode">;
const runIssueId = (run: StoppedRun & { contextSnapshot?: Record<string, unknown> | null }) => {
  const id = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  return typeof id === "string" ? id : null;
};
/** adopt-stopu-bound2: a person's Stop whose environment cleanup retry failed
 * to get the stop receipt. Raise the existing Stop-pending card under the task
 * and run locks, rather than holding the person's messages with no card.
 * Non-person stops keep the ordinary cleanup escalation. */
export async function recordPersonStopCleanupPending(db: Db, run: StoppedRun & { contextSnapshot?: Record<string, unknown> | null }) {
  const issueId = runIssueId(run);
  if (!issueId || !isPersonStop(run)) return false;
  // adopt-stopu-card2: the SAME bound as the sweep's deferral. Before it, the sweep
  // owns the (re)check and cards at the bound; no card from this writer earlier.
  const bound = personStopCardBoundAt(run);
  if (bound !== null && Date.now() < bound) return false;
  const publications: ActivityPublication[] = [];
  const recorded = await db.transaction(async tx => {
    const [task] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, run.companyId), eq(issues.id, issueId))).for("update");
    if (!task) return false;
    await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).for("update");
    if (await runExecutionsHaveStopped(tx as unknown as Db, run.companyId, [run.id])) return false;
    await recordTaskStopPending(tx as unknown as Db, { companyId: run.companyId, issueId, runIds: [run.id],
      source: "recovery.person_stop_cleanup_pending" }, publications);
    return true;
  });
  for (const publication of publications) publishActivity(publication);
  return recorded;
}
/** The receipt landed: retire the card under the same locks before the held
 * messages are reconsidered (recheck proves Stop; it never invents it). */
export async function recheckPersonStopCleanupPending(db: Db, run: StoppedRun & { contextSnapshot?: Record<string, unknown> | null }) {
  const issueId = runIssueId(run);
  if (!issueId) return;
  const publications: ActivityPublication[] = [];
  await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, run.companyId), eq(issues.id, issueId))).for("update");
    await recheckTaskStopPending(tx as unknown as Db, { companyId: run.companyId, issueId }, publications);
  });
  for (const publication of publications) publishActivity(publication);
}
/** The person's line while this run's Stop-pending card is open, else null. */
export async function personStopPendingLine(db: Db, input: { companyId: string; issueId: string; runId: string }) {
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"])));
  return actions.some(action => stopPending(action)?.runIds.includes(input.runId)) ? STOP_PENDING_PERSON_LINE : null;
}
