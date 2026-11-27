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

/** Census the allocation's durable continuous Pi conversations, not just the
 * newest run or this process's warm handles. A different task/session is not a
 * reset. An explicit fresh choice waives only the conversation being reset. */
export async function preserveReusableSandboxConversation(input: {
  db: Db; lease: EnvironmentLease; heartbeatRunId?: string | null;
}): Promise<{ kind: "unheld" | "preserved" | "deferred"; lease: EnvironmentLease; detail?: string }> {
  const { db, lease } = input;
  if (!lease.providerLeaseId) return { kind: "unheld", lease };
  const sources = await db.selectDistinct({ run: heartbeatRuns }).from(heartbeatRuns)
    .innerJoin(environmentLeases, and(eq(environmentLeases.heartbeatRunId, heartbeatRuns.id),
      eq(environmentLeases.companyId, heartbeatRuns.companyId)))
    .where(and(eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.environmentId, lease.environmentId!),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId),
      eq(heartbeatRuns.runtimeMode, "native"), isNotNull(heartbeatRuns.nativeSessionId),
      sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'pi_rpc'`,
      sql`coalesce(${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'sessionContinuity', 'continuous') = 'continuous'`))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  const conversationKey = (run: typeof heartbeatRuns.$inferSelect) =>
    JSON.stringify([run.agentId, run.nativeIssueId, run.nativeSessionId]);
  const conversations = new Map<string, typeof sources[number]>();
  for (const source of sources) if (!conversations.has(conversationKey(source.run))) conversations.set(conversationKey(source.run), source);
  if (!conversations.size) return { kind: "unheld", lease };
  const [current] = input.heartbeatRunId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, input.heartbeatRunId))) : [];
  const explicitFresh = current?.contextSnapshot?.explicitFreshSession === true || current?.contextSnapshot?.conversationReset === true;
  const reset = explicitFresh && current ? sources.find(source => source.run.agentId === current.agentId
    && source.run.nativeIssueId === current.nativeIssueId && source.run.nativeSessionId === current.nativeSessionId)
    ?? sources.find(source => source.run.agentId === current.agentId && current.nativeIssueId
      && source.run.nativeIssueId === current.nativeIssueId) : undefined;
  const held = [...conversations.values()].filter(source => !reset || conversationKey(source.run) !== conversationKey(reset.run));
  const heldRuns = sources.filter(source => !reset || conversationKey(source.run) !== conversationKey(reset.run));
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
  // Every durable owner must be idle, even if the selected lease row belongs to
  // a different task. One task's proof cannot authorize destroying another's.
  for (const source of heldRuns) {
    if (source.run.id !== current.id && ["queued", "scheduled_retry", "running"].includes(source.run.status)) return defer("source_busy");
    const [owner] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, lease.companyId), eq(nativeRunFinalizations.runId, source.run.id),
      isNotNull(nativeRunFinalizations.leaseOwner),
      sql`(${nativeRunFinalizations.leaseExpiresAt} is null or ${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp())`));
    if (owner) return defer("source_busy");
  }
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
    return { kind: "preserved", lease: refreshed };
  } catch (error) {
    return defer(`source_preservation_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
