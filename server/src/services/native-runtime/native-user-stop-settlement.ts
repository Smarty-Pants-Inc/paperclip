import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { completedWorkspaceRecoveryCondition } from "../workspace-recovery-receipt.js";
import { hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { hasTaskStopPending } from "../recovery/stop-pending.js";
import { loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** A Stop-settled owner has no committed result to vouch for a tool answer.
 * Every journaled tool input needs a delivered answer; none may be outstanding.
 * Shared by retained read binding and the reviewed finished-owner fence. */
export function stopJournalLeftUndeliveredTool(controlBytes: string): boolean {
  try {
    const control = record(JSON.parse(controlBytes));
    const results = (Array.isArray(control.commands) ? control.commands : []).map(record)
      .filter(command => command.type === "semantic_tool.result");
    if (results.some(command => command.status !== "completed")) return true;
    const delivered = new Set(results.map(command => record(command.payload).sourceEventId));
    return (Array.isArray(control.committedEvents) ? control.committedEvents : []).map(record).some(event =>
      (event.eventType === "semantic_tool.input" || event.eventType === "mcp_app.tool_input") && !delivered.has(event.sourceEventId));
  } catch {
    return true;
  }
}

/** Reuse Pi's settled-interrupt uncertainty markers, including unreadable logs. */
export async function userStopLeftUncertainty(db: Db, run: { id: string; companyId: string }): Promise<boolean> {
  try {
    const rows = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
        inArray(heartbeatRunEvents.eventType, ["harness.diagnostic", "turn.failed", "session.failed"])));
    return rows.some(row => {
      if (row.eventType !== "harness.diagnostic") return true;
      const payload = record(record(record(row.payload).prpEvent).payload);
      if (payload.code === "provider_interrupt_requested"
        && !(Array.isArray(payload.pendingCallIds) && payload.pendingCallIds.length === 0)) return true;
      return [payload.code, record(payload.details).code, record(payload.error).code].some(code =>
        typeof code === "string" && /pi_abort_escalated|side_effect.*(?:pending|uncertain)|cleanup_uncertain/.test(code));
    });
  } catch {
    return true;
  }
}

/** H6's standalone Stop-pending card naming this run, with no stronger
 * obligation (workspace, system or automatic recovery) sharing it. Every
 * named run needs its own settled-Stop proof before the card stops holding. */
function onlyStopPendingFor(action: { cause: string; evidence: Record<string, unknown> }, runId: string): boolean {
  if (action.cause !== "execution_stop_pending" || !hasTaskStopPending(action)) return false;
  const pending = record(action.evidence.stopPending);
  return pending.standalone === true && Array.isArray(pending.runIds) && pending.runIds.length > 0
    && pending.runIds.every(id => typeof id === "string" && id.length > 0) && pending.runIds.includes(runId)
    && pending.runIds.includes(action.evidence.runId) && Object.keys(action.evidence).every(key => key === "runId" || key === "stopPending");
}

/** The retirement fence's own settled-Stop proof (native-session-executor
 * stoppedByUser and owner_stop_unsettled), read for this run. */
async function userStopProvenSettled(db: Db, binding: { companyId: string; issueId: string; runId: string }, controlBytes: string): Promise<boolean> {
  const [stopped] = await db.select({ run: heartbeatRuns, owner: nativeRunFinalizations }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.runId, heartbeatRuns.id),
      eq(nativeRunFinalizations.companyId, heartbeatRuns.companyId)))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(nativeRunFinalizations.issueId, binding.issueId))).limit(1);
  return !!stopped && stopped.run.status === "cancelled" && stopped.owner.failureCode === "native_retry_cancelled"
    && !stopped.owner.leaseOwner && hasAcknowledgedNativeStopIntent(stopped.run)
    && !stopJournalLeftUndeliveredTool(controlBytes) && !await userStopLeftUncertainty(db, stopped.run);
}

/** A Stop receipt cannot close an open recovery action or substitute for the
 * existing workspace-recovery settlement receipts. The one exception is H6's
 * Stop-pending card: it guards an unproven Stop, so it stops holding once the
 * caller's journal and each named run's own journal/receipts prove Stop settled. */
export async function nativeUserStopRecoveryHeld(db: Db, binding: {
  companyId: string; issueId: string; runId: string;
}, settledStop?: { controlBytes: string }): Promise<boolean> {
  const held = await db.select({ cause: issueRecoveryActions.cause, evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, binding.companyId), eq(issueRecoveryActions.sourceIssueId, binding.issueId),
    or(sql`${issueRecoveryActions.evidence}->>'runId' = ${binding.runId}`,
      sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${binding.runId}`,
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,sourceRunId}' = ${binding.runId}`,
      sql`${issueRecoveryActions.evidence}->'stopPending'->'runIds' ? ${binding.runId}`),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`(${issueRecoveryActions.evidence}#>>'{automaticRecovery,replay}' = 'blocked'
        and not coalesce((${completedWorkspaceRecoveryCondition(binding.runId)}), false))`),
  ));
  if (!held.length) return false;
  if (!settledStop || held.some(action => !onlyStopPendingFor(action, binding.runId))) return true;
  const runIds = new Set(held.flatMap(action => record(action.evidence.stopPending).runIds as string[]));
  for (const runId of runIds) {
    const runBinding = { ...binding, runId };
    let controlBytes = settledStop.controlBytes;
    if (runId !== binding.runId) {
      // Never borrow the caller's journal for another owner. Checkpoint loading
      // authenticates company/task/run binding; absent, retired or unreadable
      // checkpoints cannot prove that owner's Stop.
      try {
        const checkpoint = await loadNativeRunnerCheckpoint(db, runBinding);
        if (!checkpoint) return true;
        controlBytes = JSON.stringify({
          commands: [...checkpoint.records].filter(([key]) => key.startsWith("command:")).map(([, bytes]) => JSON.parse(bytes)),
          committedEvents: [...checkpoint.records].filter(([key]) => key.startsWith("event:")).map(([, bytes]) => JSON.parse(bytes)),
        });
      } catch { return true; }
    }
    if (!await userStopProvenSettled(db, runBinding, controlBytes)) return true;
  }
  return false;
}
