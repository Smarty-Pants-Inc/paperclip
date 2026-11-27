import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { hasUnchangedNativeInputRefusal, isNativeInputSizeRefusal } from "../native-input-refusal.js";
import { issueService } from "../issues.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { isAutomaticRecoverySuppressedByPauseHold } from "./pause-hold-guard.js";
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Called with the issue admission/release lock held. A source repair may undo
 * only the precise automatic block created for that refusal, never a later
 * person's decision or an independent recovery hold. */
export async function resumeRepairedNativeInputRefusal(db: Db, scope: { companyId: string; issueId: string }) {
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId)));
  if (!issue || issue.status !== "blocked" || issue.hiddenAt || await isAutomaticRecoverySuppressedByPauseHold(db, scope.companyId, scope.issueId)) return;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, scope.companyId), eq(issueRecoveryActions.sourceIssueId, scope.issueId),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  ));
  for (const action of actions) {
    const marker = object(action.evidence.nativeInputRefusalBlock);
    if (marker.statusVersion !== issue.statusVersion || typeof marker.runId !== "string" || typeof marker.agentId !== "string"
      || !["todo", "in_progress", "in_review"].includes(String(marker.previousStatus))) continue;
    const [latest] = await db.select({ id: heartbeatRuns.id, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, marker.agentId),
      inArray(heartbeatRuns.status, ["succeeded", "failed", "timed_out", "interrupted"]),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${scope.issueId}`,
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
    // An explicit person attempt may fail on the same input while the issue
    // remains blocked, without running escalation again. The original block
    // still belongs to us; require both its source and the latest terminal
    // attempt to be size refusals, rather than stranding the owned block.
    const [source] = await db.select({ errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.id, marker.runId),
      eq(heartbeatRuns.agentId, marker.agentId), eq(heartbeatRuns.status, "failed"),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${scope.issueId}`,
    )).limit(1);
    if (!isNativeInputSizeRefusal(source?.errorCode) || !isNativeInputSizeRefusal(latest?.errorCode)
      || await hasUnchangedNativeInputRefusal(db, { ...scope, agentId: marker.agentId })) continue;
    await issueRecoveryActionService(db).resolveActiveForIssue({ companyId: scope.companyId, sourceIssueId: scope.issueId,
      actionId: action.id, status: "resolved", outcome: "restored", resolutionNote: "The refused source input changed; saved automatic events remain owed to the next admitted turn." }, db);
    if (actions.some(other => other.id !== action.id)) return;
    // issueService retains the ordinary dependency/status transition policy.
    await issueService(db).update(issue.id, { status: marker.previousStatus as "todo" | "in_progress" | "in_review", companyGuard: scope.companyId }, db);
    return;
  }
}
