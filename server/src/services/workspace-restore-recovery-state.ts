import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";
import { STOP_PROOF_MAX_REARMS, STOP_PROOF_RECOVERY_SCHEMA } from "./system-recovery-state.js";
import { hasWorkspaceRestoreFailure, WORKSPACE_RESTORE_PENDING_KEY, WORKSPACE_RESTORE_PERSON_BOUND_MS } from "@paperclipai/shared";

export const LEGACY_WORKSPACE_RECOVERY_KEY = "workspaceRestoreRecovery";
export const LEGACY_WORKSPACE_RECOVERY_SCHEMA = "paperclip.workspace-restore-recovery.v1";
/** Lease metadata that replaces the hold marker once recovery saved the files
 * and returned the warm sandbox to reuse. It grants no recovery authority. */
export const SETTLED_WORKSPACE_RESTORE_HOLD_KEY = "workspaceRestoreRecoverySettled";

/** The admitted external contract can prohibit workspace access even though its
 * managed Runner has a synchronization descriptor for durable recovery. That
 * descriptor alone does not create a user-file export obligation. */
export function nativeRunHasNoWorkspaceAccess(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "nativeIssueId" | "runtimeMode" | "driverKind" | "runnerProfileJson">): boolean {
  const input = run.runnerProfileJson?.nativeExecutionInput as Record<string, unknown> | undefined;
  if (run.runtimeMode !== "native" || !input || (input.schema !== "paperclip.native-execution-input.v6" && input.schema !== "paperclip.native-execution-input.v8")) return false;
  const binding = input.binding as Record<string, unknown> | undefined;
  const workspace = input.workspace as Record<string, unknown> | undefined;
  const provider = input.provider as Record<string, unknown> | undefined;
  const driver = input?.schema === "paperclip.native-execution-input.v8"
    ? provider?.kind === "muse" && provider.bridgeRevision === "muse-v1" ? "muse_external" : null
    : provider?.kind === "grok_bot" ? "grok_bot_mcp"
      : provider?.kind === "openai_dot" ? "openai_dot_mcp" : null;
  return driver !== null && run.driverKind === driver && workspace?.access === "none" && workspace.cwd === null
    && binding?.runId === run.id && binding.companyId === run.companyId && binding.agentId === run.agentId
    && binding.issueId === (run.nativeIssueId ?? run.issueId);
}

export function hasRequiredWorkspaceRecovery(result: Record<string, unknown> | null | undefined): boolean {
  const value = result?.[LEGACY_WORKSPACE_RECOVERY_KEY];
  return hasWorkspaceRestoreFailure(result) && !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === LEGACY_WORKSPACE_RECOVERY_SCHEMA;
}



/**
 * The run's owed-files label follows its hold, read where the recovery worker
 * records it: updateSystemRecovery (system-recovery.ts) writes
 * workspaceRecovery.status queued/recovering/blocked/recovered on the hold
 * (evidence.runId = the run), the same field the hold card renders
 * (workspaceRecoveryDisplay). A recovered hold wins over a sibling; otherwise
 * the latest write. No hold row yet means the worker has not adopted it: owed.
 */
const runRestoreHoldStatusSql = sql`(select hold.evidence #>> '{workspaceRecovery,status}'
  from issue_recovery_actions hold
  where hold.company_id = ${heartbeatRuns.companyId}
    and hold.evidence ->> 'runId' = ${heartbeatRuns.id}::text
    and hold.evidence #>> '{workspaceRecovery,runId}' = ${heartbeatRuns.id}::text
  order by (hold.evidence #>> '{workspaceRecovery,status}' = 'recovered') desc, hold.updated_at desc
  limit 1)`;
const runOwesRestoreSql = sql`${heartbeatRuns.resultJson} -> '${sql.raw(WORKSPACE_RESTORE_PENDING_KEY)}' = 'true'::jsonb`;
/** When the run's hold was written (the earliest action for this run). */
const runRestoreHoldWrittenSql = sql`(select min(hold.created_at) from issue_recovery_actions hold
  where hold.company_id = ${heartbeatRuns.companyId} and hold.evidence ->> 'runId' = ${heartbeatRuns.id}::text)`;
const runRestoreInProgressSql = sql`${runOwesRestoreSql}
  and coalesce(${runRestoreHoldStatusSql}, 'queued') in ('queued', 'recovering')`;
/** Past the person bound (WORKSPACE_RESTORE_PERSON_BOUND_MS after the hold was written). */
const runRestorePastBoundSql = sql`coalesce(${runRestoreHoldWrittenSql}, ${heartbeatRuns.updatedAt})
  < now() - make_interval(secs => ${WORKSPACE_RESTORE_PERSON_BOUND_MS / 1000})`;
/** Projection of the run's owed fact: still in progress (no terminal hold state), within the person bound. */
export const workspaceRestorePendingProjectionSql = sql`case when ${runRestoreInProgressSql}
  and not (${runRestorePastBoundSql}) then to_jsonb(true) end`;
/** Projection: still in progress past the person bound; the person may Retry. */
export const workspaceRestoreDelayedProjectionSql = sql`case when ${runRestoreInProgressSql}
  and ${runRestorePastBoundSql} then to_jsonb(true) end`;
/** rf-3 15:30Z (3): the run's latest hold is exhausted on an unconfirmed stop
 * (the SQL form of exhaustedStopWait in system-recovery-state.ts): the value is
 * the failure code; the chat reads it as waiting with the card's words, no Retry.
 * A recovered sibling wins, as for the status above. */
export const workspaceRestoreStopWaitProjectionSql = sql`(select case
    when hold.evidence #>> '{systemRecovery,state}' = 'exhausted'
      and (hold.evidence #>> '{systemRecovery,failure,code}' = 'copyback_stop_unconfirmed'
        or (hold.evidence #>> '{systemRecovery,failure,code}' = 'agent_stop_unconfirmed'
          and hold.evidence #>> '{systemRecovery,failure,retryClass}' = 'recheck_evidence'
          and coalesce(case when hold.evidence #>> '{stopProofRecovery,schema}' = ${STOP_PROOF_RECOVERY_SCHEMA}
            and jsonb_typeof(hold.evidence #> '{stopProofRecovery,rearms}') = 'number'
            then (hold.evidence #>> '{stopProofRecovery,rearms}')::numeric end, 0) < ${STOP_PROOF_MAX_REARMS}))
    then hold.evidence #> '{systemRecovery,failure,code}' end
  from issue_recovery_actions hold
  where hold.company_id = ${heartbeatRuns.companyId}
    and hold.evidence ->> 'runId' = ${heartbeatRuns.id}::text
    and hold.evidence #>> '{workspaceRecovery,runId}' = ${heartbeatRuns.id}::text
  order by (hold.evidence #>> '{workspaceRecovery,status}' = 'recovered') desc, hold.updated_at desc
  limit 1)`;
/** Projection of the run's owed fact once the worker recovered the files. */
export const workspaceRestoreRecoveredProjectionSql = sql`case when ${runOwesRestoreSql}
  and ${runRestoreHoldStatusSql} = 'recovered' then to_jsonb(true) end`;

/** Late adapter/projection writes cannot certify recovery or remove its pin. */
export function preserveWorkspaceRestoreRecoveryMetadata(
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  return hasRequiredWorkspaceRecovery(current) ? { ...incoming,
    workspaceRestoreFailure: current!.workspaceRestoreFailure,
    workspaceRestoreRecovery: current!.workspaceRestoreRecovery,
    // Owed files stay owed unless this write itself reports a restore failure.
    ...(current![WORKSPACE_RESTORE_PENDING_KEY] === true && !hasWorkspaceRestoreFailure(incoming)
      ? { [WORKSPACE_RESTORE_PENDING_KEY]: true } : {}),
  } : incoming;
}
