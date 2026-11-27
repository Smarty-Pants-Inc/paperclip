import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { reusableSandboxLeaseIsIdle, reusableSandboxReplacementPlan } from "./reusable-sandbox-resume-replacement.js";
import { readNativeHarnessBackupStamp } from "./native-runtime/native-harness-backup-stamp.js";
import { readNativeControllerRecovery } from "./native-runtime/native-controller-recovery.js";
import { loadNativeRunnerCheckpoint } from "./native-runtime/native-runner-checkpoint.js";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-runtime/native-retired-backup-source.js";
import { retiredReusableLeasePredecessors } from "./environment-lease-handoff.js";

export const REPLACEMENT_DEFERRED_CONVERSATION = "replacement_deferred_unexported_conversation";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Census only still-held continuous Pi conversations. Finished tasks and a
 * task's superseded sessions need no backup. Different tasks never waive each
 * other; several still-held conversations still each need committed proof. */
export async function preserveReusableSandboxConversation(input: {
  db: Db; lease: EnvironmentLease; heartbeatRunId?: string | null;
}): Promise<{ kind: "unheld" | "preserved" | "deferred"; lease: EnvironmentLease; detail?: string }> {
  const { db, lease } = input;
  if (!lease.providerLeaseId) return { kind: "unheld", lease };
  const [current] = input.heartbeatRunId ? await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
    nativeIssueId: heartbeatRuns.nativeIssueId, nativeSessionId: heartbeatRuns.nativeSessionId,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, input.heartbeatRunId))) : [];
  // Bound the result in PostgreSQL before reading profiles or finalization
  // owners. The allocation lookup uses environment_leases_provider_lease_idx,
  // its runs and finalizations use their PKs, and supersession is task-scoped
  // through heartbeat_runs_company_native_issue_id_uq. No per-history RPCs.
  // Deduplicate the allocation's run IDs before joining profiles. This also
  // prevents a planner from repeatedly scanning all the allocation's leases
  // for each historical run when table statistics are still cold.
  const allocationRuns = db.selectDistinct({ runId: environmentLeases.heartbeatRunId }).from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.environmentId, lease.environmentId!),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId), isNotNull(environmentLeases.heartbeatRunId)))
    .as("reusable_allocation_runs");
  const latest = db.$with("reusable_conversation_latest").as(db.selectDistinctOn([
    heartbeatRuns.agentId, heartbeatRuns.nativeIssueId, heartbeatRuns.nativeSessionId,
  ], { id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, nativeIssueId: heartbeatRuns.nativeIssueId,
    nativeSessionId: heartbeatRuns.nativeSessionId, runnerInstanceId: heartbeatRuns.runnerInstanceId,
    status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt }).from(allocationRuns)
    .innerJoin(heartbeatRuns, eq(allocationRuns.runId, heartbeatRuns.id))
    .where(and(eq(heartbeatRuns.companyId, lease.companyId),
      eq(heartbeatRuns.runtimeMode, "native"), isNotNull(heartbeatRuns.nativeSessionId),
      sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'pi_rpc'`,
      sql`coalesce(${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'sessionContinuity', 'continuous') = 'continuous'`))
    .orderBy(heartbeatRuns.agentId, heartbeatRuns.nativeIssueId, heartbeatRuns.nativeSessionId,
      desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)));
  const newer = alias(heartbeatRuns, "reusable_conversation_newer");
  const explicitFresh = current?.contextSnapshot?.explicitFreshSession === true || current?.contextSnapshot?.conversationReset === true;
  const held = await db.with(latest).select({ run: { id: latest.id, agentId: latest.agentId,
    nativeIssueId: latest.nativeIssueId, nativeSessionId: latest.nativeSessionId,
    runnerInstanceId: latest.runnerInstanceId, status: latest.status },
    busy: sql<boolean>`${nativeRunFinalizations.leaseOwner} is not null and
      (${nativeRunFinalizations.leaseExpiresAt} is null or ${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp())`,
  }).from(latest)
    .leftJoin(issues, and(eq(issues.companyId, lease.companyId), eq(issues.id, latest.nativeIssueId)))
    .leftJoin(nativeRunFinalizations, and(eq(nativeRunFinalizations.companyId, lease.companyId),
      eq(nativeRunFinalizations.runId, latest.id)))
    .where(and(sql`(${issues.id} is null or ${issues.status} not in ('done', 'cancelled'))`,
      // A fresh request without a task cannot reset some other task's history.
      explicitFresh && current && (current.nativeIssueId || current.nativeSessionId)
        ? sql`not (${latest.agentId} = ${current.agentId} and ${current.nativeIssueId
          ? sql`${latest.nativeIssueId} is not distinct from ${current.nativeIssueId}`
          : sql`(${latest.nativeIssueId} is null and ${latest.nativeSessionId} = ${current.nativeSessionId})`})` : undefined,
      sql`not exists (select 1 from ${heartbeatRuns} as "reusable_conversation_newer" where ${newer.companyId} = ${lease.companyId}
        and ${newer.agentId} = ${latest.agentId} and ${newer.nativeIssueId} = ${latest.nativeIssueId}
        and (
          ((${newer.createdAt}, ${newer.id}) > (${latest.createdAt}, ${latest.id}) and (
            (${newer.nativeSessionId} is not null and ${newer.nativeSessionId} <> ${latest.nativeSessionId})
            or ${newer.contextSnapshot}->'conversationReset' = 'true'::jsonb
            or (${newer.contextSnapshot}->'explicitFreshSession' = 'true'::jsonb and
              (${newer.nativeSessionId} is null or ${newer.nativeSessionId} <> ${latest.nativeSessionId}))
          ))
          or (${newer.id} = ${latest.id} and ${newer.contextSnapshot}->'conversationReset' = 'true'::jsonb)
        ))`));
  if (!held.length) return { kind: "unheld", lease };
  const defer = async (detail: string) => {
    const [fresh] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id)));
    const changedOwner = fresh && (fresh.status === "active" || fresh.heartbeatRunId !== lease.heartbeatRunId);
    return { kind: "deferred" as const, lease: fresh ? { ...lease, metadata: fresh.metadata } : lease,
      detail: changedOwner ? "source_busy" : detail };
  };
  if (!current || held.some(source => current.agentId !== source.run.agentId)) return defer("source_binding_unavailable");
  if (!await reusableSandboxLeaseIsIdle({ db, lease, companyId: lease.companyId, heartbeatRunId: current.id })) {
    return defer("source_busy");
  }
  // The held-set query includes each newest owner's finalization lease. Old
  // turns are not additional conversations and never cause per-run queries.
  if (held.some(source => source.busy || (source.run.id !== current.id
    && ["queued", "scheduled_retry", "running"].includes(source.run.status)))) return defer("source_busy");
  try {
    const executor = await import("./native-runtime/native-session-executor.js");
    const sourceAllocation = { environmentId: lease.environmentId!, providerLeaseId: lease.providerLeaseId };
    const result = await executor.closeWarmNativeSessionsForEnvironment({
      ...sourceAllocation, reason: "lease_fingerprint_mismatch", db,
      // Other tasks on the box need their own committed proof; do not retire
      // their warm owners merely because this task edited its configuration.
      conversations: held.filter(source => source.run.agentId === current.agentId
        && source.run.nativeIssueId === current.nativeIssueId
        && source.run.nativeSessionId === current.nativeSessionId)
        .map(source => ({ companyId: lease.companyId, agentId: source.run.agentId,
          issueId: source.run.nativeIssueId, normalizedSessionId: source.run.nativeSessionId! })),
    });
    if (result.busy) return defer("source_busy");
    if (result.failed) return defer(executor.warmNativeRetirementPending(sourceAllocation)
      ? "source_retirement_unconfirmed" : "source_export_failed");
    const [fresh] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId)));
    if (!fresh) return defer("source_lease_missing");
    const refreshed = { ...lease, metadata: fresh.metadata };
    // Read after close, and prove each conversation's bytes, checkpoint,
    // identity and staleness separately. The existing restore authority uses
    // the allocation's tip lease stamp, not arbitrary historical-row stamps.
    // Until that authority can represent several conversations, older backups
    // alone cannot authorize destroying a box shared by different sessions.
    for (const source of held) {
      const stamp = readNativeHarnessBackupStamp(fresh.metadata?.nativeHarnessBackup, lease.providerLeaseId);
      if (!stamp || stamp.sourceProviderLeaseId !== lease.providerLeaseId
        || stamp.normalizedSessionId !== source.run.nativeSessionId || stamp.runnerInstanceId !== source.run.runnerInstanceId) {
        return defer(result.closed === 0 ? "no_owner_or_committed_backup" : "source_backup_uncommitted");
      }
      if (await reusableSandboxReplacementPlan({ db, lease: refreshed, companyId: lease.companyId,
        heartbeatRunId: current.id, executionWorkspaceId: lease.executionWorkspaceId,
        adapterType: "paperclip_runner", cause: new Error("lease_fingerprint_mismatch") }) !== "retire") {
        return defer("source_preservation_unproven");
      }
      const [settled] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, source.run.id)));
      const profile = record(settled?.runnerProfileJson);
      const snapshotIdentity = record(record(profile.sessionCheckpoint).identity);
      const recovery = readNativeControllerRecovery(profile.nativeControllerRecovery, profile.sessionCheckpoint);
      if (!settled?.nativeIssueId || snapshotIdentity.companyId !== lease.companyId
        || snapshotIdentity.agentId !== source.run.agentId || snapshotIdentity.issueId !== settled.nativeIssueId
        || snapshotIdentity.runId !== settled.id || snapshotIdentity.sessionId !== stamp.normalizedSessionId || !recovery || recovery.checkpoint?.runId !== settled.id
        || recovery.checkpoint.normalizedSessionId !== stamp.normalizedSessionId
        || recovery.checkpoint.runnerInstanceId !== stamp.runnerInstanceId) return defer("source_controller_uncommitted");
      const checkpoint = await loadNativeRunnerCheckpoint(db, { companyId: lease.companyId,
        issueId: settled.nativeIssueId, runId: settled.id });
      if (!checkpoint || checkpoint.recoveryEvidence.normalizedSessionId !== stamp.normalizedSessionId
        || checkpoint.recoveryEvidence.runnerInstanceId !== stamp.runnerInstanceId) return defer("source_controller_uncommitted");
      const [later] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
        .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId)).where(and(
          eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRunEvents.companyId, lease.companyId),
          eq(heartbeatRuns.nativeSessionId, stamp.normalizedSessionId), ne(heartbeatRuns.id, current.id),
          inArray(heartbeatRunEvents.eventType, [...NATIVE_PROVIDER_DURABLE_EVENT_TYPES]),
          gt(heartbeatRunEvents.createdAt, new Date(stamp.completedAt)))).limit(1);
      if (later) return defer("source_backup_stale");
    }
    // Only pay for lease-lineage proof after the held conversations' backups
    // pass. The restore consumer accepts exactly one tip and a verified chain;
    // a backup must not authorize destruction if restore would then refuse it.
    const history = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.providerLeaseId, lease.providerLeaseId)));
    if (!retiredReusableLeasePredecessors(fresh, history.filter(row => row.id !== fresh.id))) {
      return defer("source_history_unproven");
    }
    return { kind: "preserved", lease: refreshed };
  } catch (error) {
    return defer(`source_preservation_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
