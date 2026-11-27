import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";
import { reusableSandboxLeaseIsIdle, reusableSandboxReplacementPlan } from "./reusable-sandbox-resume-replacement.js";
import { nativeHarnessBackupEventCursors, readNativeHarnessBackupStamp } from "./native-runtime/native-harness-backup-stamp.js";
import { readNativeControllerRecovery } from "./native-runtime/native-controller-recovery.js";
import { loadNativeRunnerCheckpoint } from "./native-runtime/native-runner-checkpoint.js";
import { NATIVE_PROVIDER_DURABLE_EVENT_TYPES, nativeHarnessBackupCoversProviderEvents } from "./native-runtime/native-retired-backup-source.js";
import { retiredReusableLeasePredecessors, reusableLeaseHistoryWithDeletedTaskBindings } from "./environment-lease-handoff.js";
import { terminalRunLeaseReleaseReadiness } from "./environment-lease-release-deferral.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { runningProcesses } from "../adapters/index.js";

export const REPLACEMENT_DEFERRED_CONVERSATION = "replacement_deferred_unexported_conversation";

/** A named, non-destructive operator state, not an unbounded raw retry error. */
export class ReusableConversationHeldError extends Error {
  readonly code = REPLACEMENT_DEFERRED_CONVERSATION;
  readonly retryable = false;
  constructor() {
    super(`${REPLACEMENT_DEFERRED_CONVERSATION}: A Pi conversation still holds the source sandbox. `
      + "Continue with its original configuration, or ask an operator to complete a preservation handoff before replacing it. "
      + "Reset the task only if you intend to start a new conversation; a saved backup alone does not authorize release.");
    this.name = "ReusableConversationHeldError";
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export type ReusableConversationCoverage = Array<{ sessionId: string; cursors: Array<{ runId: string; seq: number }> }>;

/** Unknown/no-run/nonterminal rows block in the claiming snapshot. Terminal
 * rows are only candidates for staleness, NOT permission to destroy: both the
 * census and post-claim dispatch must pass the sweeper's shared readiness
 * decision below. Allocation identity never depends on nullable environment. */
export function reusableAllocationHasActiveSiblingSql(lease: EnvironmentLease) {
  return sql`exists (select 1 from ${environmentLeases} active_lease
    where active_lease.company_id = ${lease.companyId}
      and active_lease.provider_lease_id = ${lease.providerLeaseId}
      and active_lease.id <> ${lease.id} and active_lease.status = 'active'
      and not exists (select 1 from ${heartbeatRuns} terminal_owner
        where terminal_owner.company_id = active_lease.company_id
          and terminal_owner.id = active_lease.heartbeat_run_id
          and terminal_owner.status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')))`;
}

/** Evaluate terminal-labelled active rows with exactly the orphan sweeper's
 * release barriers, including the pending-export predicate, not status alone.
 * Repeat after the claim: a sibling can appear after the census snapshot. */
export async function reusableAllocationHasHeldSibling(db: Db, lease: EnvironmentLease) {
  const siblings = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.providerLeaseId, lease.providerLeaseId!),
    sql`${environmentLeases.id} <> ${lease.id}`, eq(environmentLeases.status, "active")));
  const localRuns = { has: (id: string) => adapterExecutionControls.has(id) || runningProcesses.has(id) };
  for (const sibling of siblings) {
    if (!(await terminalRunLeaseReleaseReadiness(db, sibling, localRuns)).ready) return true;
  }
  return false;
}

/** Recheck the proven, hash-bound causal cursors in the claiming snapshot AND
 * immediately before dispatch. Missing/legacy cursors cover no events. This
 * narrows P11; it is not publisher admission exclusion during the provider RPC. */
export function reusableConversationCoverageSql(companyId: string, coverage: ReusableConversationCoverage) {
  return and(...coverage.map(proof => sql`not exists (
    select 1 from ${heartbeatRunEvents} provider_event
    inner join ${heartbeatRuns} provider_run on provider_run.id = provider_event.run_id
      and provider_run.company_id = provider_event.company_id
    left join jsonb_to_recordset(${JSON.stringify(proof.cursors)}::jsonb)
      as proven("runId" text, seq bigint) on proven."runId" = provider_event.run_id::text
    where provider_event.company_id = ${companyId} and provider_run.native_session_id = ${proof.sessionId}
      and provider_event.event_type in (${sql.join([...NATIVE_PROVIDER_DURABLE_EVENT_TYPES].map(type => sql`${type}`), sql`, `)})
      and provider_event.seq > coalesce(proven.seq, -1))`));
}

/** Census still-held continuous Pi conversations. Done/cancelled tasks and
 * older same-task sessions can remain selected by a task pointer or pinned
 * native run, so each needs proof. Archive is reversible and also needs proof.
 * Only explicit resets and deleted tasks waive it; another task or a merely
 * newer session never does. */
export async function preserveReusableSandboxConversation(input: {
  db: Db; lease: EnvironmentLease; heartbeatRunId?: string | null;
  /** Acquisition-time generic release has no retired-source restore contract.
   * It may release only an unheld allocation, never substitute a saved backup. */
  unheldReleaseOnly?: boolean;
}): Promise<
  | { kind: "unheld"; lease: EnvironmentLease }
  | { kind: "preserved"; lease: EnvironmentLease; coverage: ReusableConversationCoverage }
  | { kind: "deferred"; lease: EnvironmentLease; detail: string }
> {
  const { db, lease } = input;
  if (!lease.providerLeaseId) return { kind: "unheld", lease };
  const [current] = input.heartbeatRunId ? await db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
    nativeIssueId: heartbeatRuns.nativeIssueId, nativeSessionId: heartbeatRuns.nativeSessionId,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, input.heartbeatRunId))) : [];
  // Bound the result in PostgreSQL before reading profiles or finalization
  // owners. The allocation lookup uses environment_leases_provider_lease_idx,
  // its runs and finalizations use their PKs, and explicit reset is task-scoped
  // through heartbeat_runs_company_native_issue_id_uq. No per-history RPCs.
  // Deduplicate the allocation's run IDs before joining profiles. This also
  // prevents a planner from repeatedly scanning all the allocation's leases
  // for each historical run when table statistics are still cold.
  const allocationRuns = db.selectDistinctOn([environmentLeases.heartbeatRunId], {
    runId: environmentLeases.heartbeatRunId,
    backup: sql<unknown>`${environmentLeases.metadata}->'nativeHarnessBackup'`.as("source_backup"),
  }).from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, lease.companyId),
      eq(environmentLeases.providerLeaseId, lease.providerLeaseId), isNotNull(environmentLeases.heartbeatRunId)))
    .orderBy(environmentLeases.heartbeatRunId, desc(environmentLeases.acquiredAt), desc(environmentLeases.id))
    .as("reusable_allocation_runs");
  const latest = db.$with("reusable_conversation_latest").as(db.selectDistinctOn([
    heartbeatRuns.agentId, heartbeatRuns.nativeIssueId, heartbeatRuns.nativeSessionId,
  ], { id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, nativeIssueId: heartbeatRuns.nativeIssueId,
    nativeSessionId: heartbeatRuns.nativeSessionId, runnerInstanceId: heartbeatRuns.runnerInstanceId,
    status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt, finishedAt: heartbeatRuns.finishedAt,
    backup: allocationRuns.backup }).from(allocationRuns)
    .innerJoin(heartbeatRuns, eq(allocationRuns.runId, heartbeatRuns.id))
    .where(and(eq(heartbeatRuns.companyId, lease.companyId),
      eq(heartbeatRuns.runtimeMode, "native"), isNotNull(heartbeatRuns.nativeSessionId),
      sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'pi_rpc'`,
      sql`coalesce(${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'sessionContinuity', 'continuous') = 'continuous'`))
    .orderBy(heartbeatRuns.agentId, heartbeatRuns.nativeIssueId, heartbeatRuns.nativeSessionId,
      desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)));
  const newer = alias(heartbeatRuns, "reusable_conversation_newer");
  const explicitFresh = current?.contextSnapshot?.explicitFreshSession === true || current?.contextSnapshot?.conversationReset === true;
  const heldSelection = db.with(latest).select({ run: { id: latest.id, agentId: latest.agentId,
    nativeIssueId: latest.nativeIssueId, nativeSessionId: latest.nativeSessionId,
    runnerInstanceId: latest.runnerInstanceId, status: latest.status, createdAt: latest.createdAt,
    finishedAt: latest.finishedAt }, backup: latest.backup,
  }).from(latest)
    .leftJoin(issues, and(eq(issues.companyId, lease.companyId), eq(issues.id, latest.nativeIssueId)))
    .where(and(sql`(${latest.nativeIssueId} is null or ${issues.id} is not null)`,
      // A fresh request without a task cannot reset some other task's history.
      explicitFresh && current && (current.nativeIssueId || current.nativeSessionId)
        ? sql`not (${latest.agentId} = ${current.agentId} and ${current.nativeIssueId
          ? sql`${latest.nativeIssueId} is not distinct from ${current.nativeIssueId}`
          : sql`(${latest.nativeIssueId} is null and ${latest.nativeSessionId} = ${current.nativeSessionId})`})` : undefined,
      sql`not exists (select 1 from ${heartbeatRuns} as "reusable_conversation_newer" where ${newer.companyId} = ${lease.companyId}
        and ${newer.agentId} = ${latest.agentId} and ${newer.nativeIssueId} = ${latest.nativeIssueId}
        and (
          ((${newer.createdAt}, ${newer.id}) > (${latest.createdAt}, ${latest.id}) and (
            ${newer.contextSnapshot}->'conversationReset' = 'true'::jsonb
            or (${newer.contextSnapshot}->'explicitFreshSession' = 'true'::jsonb and
              (${newer.nativeSessionId} is null or ${newer.nativeSessionId} <> ${latest.nativeSessionId}))
          ))
          or (${newer.id} = ${latest.id} and ${newer.contextSnapshot}->'conversationReset' = 'true'::jsonb)
        ))`)).as("reusable_conversations_held");
  // Keep one sentinel even when reset/deletion leaves no held conversation.
  // Ownership belongs to every allocation run, not merely its newest turn.
  // The asking run may reacquire its own released lease during same-run resume;
  // its execution status is not a competing owner. Finalizers and every
  // OTHER active lease row without a terminal holder (including its own)
  // still fence the allocation. Terminal rows remain in the held census.
  const census = await db.select({ run: heldSelection.run, backup: heldSelection.backup,
    busy: sql<boolean>`${reusableAllocationHasActiveSiblingSql(lease)}
      or exists (select 1 from ${allocationRuns}
      inner join ${heartbeatRuns} on ${heartbeatRuns.id} = ${allocationRuns.runId}
      left join ${nativeRunFinalizations} on ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
        and ${nativeRunFinalizations.companyId} = ${lease.companyId}
      where ${heartbeatRuns.companyId} = ${lease.companyId} and (
        (${heartbeatRuns.id} is distinct from ${current?.id ?? null}
          and ${heartbeatRuns.status} in ('queued', 'scheduled_retry', 'running')) or
        (${nativeRunFinalizations.leaseOwner} is not null and
          (${nativeRunFinalizations.leaseExpiresAt} is null or ${nativeRunFinalizations.leaseExpiresAt} > clock_timestamp()))))`,
  }).from(sql`(select 1) as reusable_census_sentinel`).leftJoin(heldSelection, sql`true`);
  const held = census.filter((source): source is typeof source & { run: NonNullable<typeof source.run> } => source.run !== null);
  if (input.unheldReleaseOnly) return held.length
    ? { kind: "deferred", lease, detail: "source_release_requires_retirement" }
    : { kind: "unheld", lease };

  const defer = async (detail: string) => {
    const [fresh] = await db.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, lease.companyId), eq(environmentLeases.id, lease.id)));
    const changedOwner = fresh && (fresh.status === "active" || fresh.heartbeatRunId !== lease.heartbeatRunId);
    return { kind: "deferred" as const, lease: fresh ? { ...lease, metadata: fresh.metadata } : lease,
      detail: changedOwner ? "source_busy" : detail };
  };
  if (census.some(source => source.busy)
    || await reusableAllocationHasHeldSibling(db, lease)
    || !await reusableSandboxLeaseIsIdle({ db, lease, companyId: lease.companyId, heartbeatRunId: current?.id ?? null })) {
    return defer("source_busy");
  }
  if (!held.length) return { kind: "unheld", lease };
  if (!current || held.some(source => current.agentId !== source.run.agentId)) return defer("source_binding_unavailable");
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
    // Read the tip after close. An extra saved conversation keeps its stamp on
    // its own historical lease; it is usable only through the receipt-linked
    // lineage that the restore consumer also verifies below. Never substitute
    // one task/session's proof for another's.
    const coverage: ReusableConversationCoverage = [];
    for (const source of held) {
      const tipStamp = readNativeHarnessBackupStamp(fresh.metadata?.nativeHarnessBackup, lease.providerLeaseId);
      const stamp: ReturnType<typeof readNativeHarnessBackupStamp> = tipStamp?.normalizedSessionId === source.run.nativeSessionId
        && tipStamp.runnerInstanceId === source.run.runnerInstanceId ? tipStamp
        : readNativeHarnessBackupStamp(source.backup, lease.providerLeaseId);
      if (!stamp || stamp.sourceProviderLeaseId !== lease.providerLeaseId
        || stamp.normalizedSessionId !== source.run.nativeSessionId || stamp.runnerInstanceId !== source.run.runnerInstanceId) {
        return defer(result.closed === 0 ? "no_owner_or_committed_backup" : "source_backup_uncommitted");
      }
      // A terminal save must cover the last run, not just an older turn with
      // the same session identity. Later provider-event checks remain required.
      if (Date.parse(stamp.completedAt) <= (source.run.finishedAt ?? source.run.createdAt).getTime()) {
        return defer("source_backup_stale");
      }
      if (await reusableSandboxReplacementPlan({ db, lease: { ...refreshed,
        metadata: { ...refreshed.metadata, nativeHarnessBackup: stamp } }, companyId: lease.companyId,
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
      if (!await nativeHarnessBackupCoversProviderEvents(db, { companyId: lease.companyId,
        sessionId: stamp.normalizedSessionId,
        // Busy exemption is not event exemption: an older asking run may
        // have resumed and advanced this session after its representative's
        // save. Every run's provider work must be covered before destruction.
        stamp })) return defer("source_backup_stale");
      coverage.push({ sessionId: stamp.normalizedSessionId,
        cursors: [...(nativeHarnessBackupEventCursors(stamp) ?? new Map<string, number>())]
          .map(([runId, seq]) => ({ runId, seq })) });
    }
    // Only pay for lease-lineage proof after the held conversations' backups
    // pass. The restore consumer accepts one tip and its verified predecessors;
    // a backup must not authorize destruction if restore would then refuse it.
    const history = await reusableLeaseHistoryWithDeletedTaskBindings(db, lease.companyId, lease.providerLeaseId);
    if (!retiredReusableLeasePredecessors(fresh, history.filter(row => row.id !== fresh.id))) {
      return defer("source_history_unproven");
    }
    return { kind: "preserved", lease: refreshed, coverage };
  } catch (error) {
    return defer(`source_preservation_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
