import { and, eq, inArray, or, sql } from "drizzle-orm";
import { heartbeatRunEvents, issueRecoveryActions, type Db } from "@paperclipai/db";
import { completedWorkspaceRecoveryCondition } from "../workspace-recovery-receipt.js";

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

/** A Stop receipt cannot close an open recovery action or substitute for the
 * existing workspace-recovery settlement receipts. */
export async function nativeUserStopRecoveryHeld(db: Db, binding: {
  companyId: string; issueId: string; runId: string;
}): Promise<boolean> {
  const [held] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, binding.companyId), eq(issueRecoveryActions.sourceIssueId, binding.issueId),
    or(sql`${issueRecoveryActions.evidence}->>'runId' = ${binding.runId}`,
      sql`${issueRecoveryActions.evidence}->>'sourceRunId' = ${binding.runId}`,
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,sourceRunId}' = ${binding.runId}`),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`(${issueRecoveryActions.evidence}#>>'{automaticRecovery,replay}' = 'blocked'
        and not coalesce((${completedWorkspaceRecoveryCondition(binding.runId)}), false))`),
  )).limit(1);
  return !!held;
}
