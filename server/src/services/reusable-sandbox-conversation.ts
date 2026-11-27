import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { reusableSandboxLeaseIsIdle, reusableSandboxReplacementPlan } from "./reusable-sandbox-resume-replacement.js";
import { readNativeHarnessBackupStamp } from "./native-runtime/native-harness-backup-stamp.js";
import { readNativeControllerRecovery } from "./native-runtime/native-controller-recovery.js";
import { loadNativeRunnerCheckpoint } from "./native-runtime/native-runner-checkpoint.js";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES } from "./native-runtime/native-retired-backup-source.js";

export const REPLACEMENT_DEFERRED_CONVERSATION = "replacement_deferred_unexported_conversation";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Durable source lookup, not a census of this process's warm handles. A new
 * explicit session releases the old conversation; an absent current binding
 * does not prove that the old box is expendable. */
export async function preserveReusableSandboxConversation(input: {
  db: Db; lease: EnvironmentLease; heartbeatRunId?: string | null;
}): Promise<{ kind: "unheld" | "preserved" | "deferred"; lease: EnvironmentLease; detail?: string }> {
  const { db, lease } = input;
  if (!lease.providerLeaseId) return { kind: "unheld", lease };
  const [source] = await db.select({ run: heartbeatRuns }).from(heartbeatRuns)
    .innerJoin(environmentLeases, and(eq(environmentLeases.heartbeatRunId, heartbeatRuns.id),
      eq(environmentLeases.companyId, heartbeatRuns.companyId)))
    .where(and(eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
      eq(heartbeatRuns.runtimeMode, "native"), isNotNull(heartbeatRuns.nativeSessionId),
      sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'pi_rpc'`,
      sql`coalesce(${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'sessionContinuity', 'continuous') = 'continuous'`))
    .orderBy(desc(heartbeatRuns.createdAt)).limit(1);
  if (!source) return { kind: "unheld", lease };
  const [current] = input.heartbeatRunId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, input.heartbeatRunId))) : [];
  if (current?.contextSnapshot?.explicitFreshSession === true || current?.contextSnapshot?.conversationReset === true
    || current?.nativeSessionId && current.nativeSessionId !== source.run.nativeSessionId) return { kind: "unheld", lease };
  const defer = async (detail: string) => {
    const [fresh] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id)));
    const changedOwner = fresh && (fresh.status === "active" || fresh.heartbeatRunId !== lease.heartbeatRunId);
    return { kind: "deferred" as const, lease: fresh ? { ...lease, metadata: fresh.metadata } : lease,
      detail: changedOwner ? "source_busy" : detail };
  };
  if (!current || current.agentId !== source.run.agentId) return defer("source_binding_unavailable");
  // A durable live owner is just as busy as a process-local warm handle. This
  // run cannot safely share its allocation, even after a controller restart.
  if (!await reusableSandboxLeaseIsIdle({ db, lease, companyId: lease.companyId, heartbeatRunId: current.id })) {
    return defer("source_busy");
  }
  const [owner] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, lease.companyId), eq(nativeRunFinalizations.runId, source.run.id),
    isNotNull(nativeRunFinalizations.leaseOwner),
    sql`(${nativeRunFinalizations.leaseExpiresAt} is null or ${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp())`));
  if (owner) return defer("source_busy");
  // Await the actual preservation result. A timeout/failed/busy close is not a
  // receipt, and zero local owners after a restart is not a receipt either.
  try {
    const executor = await import("./native-runtime/native-session-executor.js");
    const sourceAllocation = { environmentId: lease.environmentId!, providerLeaseId: lease.providerLeaseId };
    const result = await executor.closeWarmNativeSessionsForEnvironment({
      ...sourceAllocation, reason: "lease_fingerprint_mismatch", db,
    });
    if (result.busy) return defer("source_busy");
    if (result.failed) return defer(executor.warmNativeRetirementPending(sourceAllocation)
      ? "source_retirement_unconfirmed" : "source_export_failed");
    const [fresh] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId)));
    if (!fresh) return defer("source_lease_missing");
    const refreshed = { ...lease, metadata: fresh.metadata };
    const stamp = readNativeHarnessBackupStamp(fresh.metadata?.nativeHarnessBackup, lease.providerLeaseId);
    if (!stamp || stamp.sourceProviderLeaseId !== lease.providerLeaseId
      || stamp.normalizedSessionId !== source.run.nativeSessionId || stamp.runnerInstanceId !== source.run.runnerInstanceId) {
      return defer(result.closed === 0 ? "no_owner_or_committed_backup" : "source_backup_uncommitted");
    }
    // Reuse the existing idle + clean committed workspace + verified exact
    // provider-backup proof (reusable-sandbox-resume-replacement.ts).
    if (await reusableSandboxReplacementPlan({ db, lease: refreshed, companyId: lease.companyId,
      heartbeatRunId: current.id, executionWorkspaceId: lease.executionWorkspaceId,
      adapterType: "paperclip_runner", cause: new Error("lease_fingerprint_mismatch") }) !== "retire") {
      return defer("source_preservation_unproven");
    }
    // Close can commit a newer snapshot; never validate the pre-close copy.
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
    return { kind: "preserved", lease: refreshed };
  } catch (error) {
    return defer(`source_preservation_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
