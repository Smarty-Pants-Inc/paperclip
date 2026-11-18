import { and, eq, sql, type SQL } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { noRetainedExecutionPredicate } from "./pre-dispatch-execution-evidence.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

/** Admission denied by an existing hold is not a provider attempt. Require the
 * dispatcher's receipt and absence of execution authority, resources and events. */
function preDispatchExecutionWaitPredicate() {
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.errorCode} = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'stopReason' = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'timeoutSource' = 'stale_queued_run_gate'
    AND ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}->'executionWait'->>'issueId'`)}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
    AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)})
    AND ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}->'executionWait'->>'recoveryActionId'`)} IS NOT NULL
    AND ${noRetainedExecutionPredicate()}, false)`;
}

export async function isPreDispatchExecutionWaitVerified(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "errorCode" | "runtimeMode">): Promise<boolean> {
  if (run.errorCode !== "execution_reconciliation_required" || run.runtimeMode !== "legacy") return false;
  const [verified] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), preDispatchExecutionWaitPredicate(),
  )).limit(1);
  return Boolean(verified);
}

/** The held source of a run the stale-run gate cancelled before it started:
 * the run named by the recovery action its executionWait receipt recorded.
 * Only the same company, task and agent; anything else names no source.
 * An exhausted saved-work recovery names none either: a person's Retry behind
 * it is the fresh isolated continuation's (fresh-continuation-fallback.ts
 * interruptionEligibility personAsked), not a new recovery budget. */
export function preDispatchHeldSourceRunId(input: { runId: SQL; companyId: string; issueId: string; agentId: string }) {
  return sql<string | null>`(select held_source.id from ${heartbeatRuns}
    join ${issueRecoveryActions} on ${issueRecoveryActions.companyId} = ${heartbeatRuns.companyId}
      and ${issueRecoveryActions.id} = ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}->'executionWait'->>'recoveryActionId'`)}
      and ${issueRecoveryActions.sourceIssueId}::text = ${input.issueId}
      and ${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' is distinct from 'exhausted'
    join ${heartbeatRuns} held_source on held_source.company_id = ${heartbeatRuns.companyId}
      and held_source.id = ${canonicalExecutionUuid(sql`${issueRecoveryActions.evidence}->>'runId'`)}
      and held_source.id <> ${heartbeatRuns.id} and held_source.agent_id = ${input.agentId}::uuid
      and coalesce(held_source.native_issue_id::text, held_source.issue_id::text,
        held_source.context_snapshot->>'issueId') = ${input.issueId}
    where ${heartbeatRuns.companyId} = ${input.companyId} and ${heartbeatRuns.id} = ${input.runId}
      and ${heartbeatRuns.retryOfRunId} is null and ${heartbeatRuns.startedAt} is null
      and ${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}
      and ${preDispatchExecutionWaitPredicate()}
    limit 1)`;
}

/** Re-evaluate old false incidents with the same proof; retain their audit rows
 * and leave the original execution/workspace hold to its own recovery policy. */
export function preDispatchExecutionWaitRecoveryActionPredicate() {
  return sql`(${issueRecoveryActions.cause} = 'legacy_execution_requires_reconciliation'
    AND coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
    AND coalesce(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}
    AND EXISTS (SELECT 1 FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        AND ${heartbeatRuns.id} = ${canonicalExecutionUuid(sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`)}
        AND ${issueRecoveryActions.sourceIssueId} = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
        AND ${preDispatchExecutionWaitPredicate()}))`;
}
