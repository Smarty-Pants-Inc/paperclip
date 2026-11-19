import { realpath } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { persistActivity } from "./activity-log.js";
import { FRESH_CONTINUATION_CAUSE, FRESH_CONTINUATION_SCHEMA } from "./fresh-continuation-fallback.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { readNativeWorkspaceSyncReference } from "./native-runtime/native-workspace-sync.js";

/** Abandons a source run's remote epoch only while it still owns it. Shared
 * by fallback and admission; caller holds the company-scoped issue/run locks. */
export async function fenceSourceWorkspace(tx: Db, run: typeof heartbeatRuns.$inferSelect) {
  const parsed = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
  if (!parsed.success || parsed.data.state !== "prepared") return null;
  const reference = parsed.data;
  const [workspace] = await tx.select({ metadata: executionWorkspaces.metadata }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
  let authority;
  try { authority = readRemoteWorkspaceAuthority(workspace?.metadata); } catch { return null; }
  if (!authority?.location || authority.writerRunId !== run.id || authority.epoch !== reference.epoch) return null;
  try {
    const abandoned = await tx.transaction(savepoint => abandonUnverifiedRemoteWorkspaceEpoch(savepoint, {
      companyId: run.companyId, workspaceId: reference.workspaceId, runId: run.id, epoch: authority.epoch,
      snapshotId: authority.snapshotId, location: authority.location! }));
    return { workspaceId: reference.workspaceId, abandonedEpoch: authority.epoch, epoch: abandoned.authority.epoch,
      snapshotId: authority.snapshotId,
      quarantine: { state: "retained_unapplied" as const, remoteCwd: authority.location.remoteCwd,
        providerLeaseId: authority.location.providerLeaseId } };
  } catch (error) {
    if (error instanceof Error && error.message === "remote_workspace_authority_changed") return null;
    throw error;
  }
}

/** A root only this task writes: its own isolated workspace, or (whatever mode its row records) its own task
 * directory by path identity, `isolated-workspaces/<company>/<task>` or `isolated-workspace-attempts/<company>/<task>/<run>`.
 * A project's primary checkout, an agent home and a legacy chat directory are not. */
async function isTaskOwnRoot(workspace: typeof executionWorkspaces.$inferSelect, issueId: string) {
  if (!workspace.cwd || workspace.sourceIssueId !== issueId || workspace.providerType !== "local_fs"
    || (workspace.metadata?.remoteWorkspace ?? null) !== null) return false;
  const segments = path.relative(await realpath(resolvePaperclipInstanceRoot()), workspace.cwd).split(path.sep);
  return segments[1] === workspace.companyId && segments[2] === issueId
    && ((segments[0] === "isolated-workspaces" && segments.length === 3) || (segments[0] === "isolated-workspace-attempts" && segments.length === 4));
}

/**
 * The classic analog of fenceSourceWorkspace, for a run whose files are copied
 * back by nativeWorkspaceSync (no remote epoch). Nothing is stopped and no lock
 * is taken: the run keeps its own root and box, and loses every authority over
 * the task. Its copy-back owner becomes a tombstone, so each later ownership
 * check of a still-running copy-back fails (`owner_replaced`) and no later claim
 * succeeds; its `prepared` reference stays, so its box is never adopted; the
 * task is detached from its root, and the next run is given a new root seeded
 * from this run's startup seed (the readiness record below). Null when the root
 * is not this task's own (a shared root has other writers and other readers):
 * such a run is never ended by the bound. Caller holds the task and run locks.
 */
export async function isolateClassicSourceWorkspace(tx: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const reference = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
  if (reference?.state !== "prepared") return null;
  const [workspace] = await tx.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, run.companyId), eq(executionWorkspaces.id, reference.workspaceId)));
  if (!workspace || !await isTaskOwnRoot(workspace, issueId)) return null;
  const recordedAt = new Date();
  // Detach the task from this root (a task already bound elsewhere keeps that binding).
  await tx.update(issues).set({ executionWorkspaceId: null,
    workspaceBindingRevision: sql`${issues.workspaceBindingRevision} + 1`, updatedAt: recordedAt }).where(and(
    eq(issues.companyId, run.companyId), eq(issues.id, issueId), eq(issues.executionWorkspaceId, workspace.id)));
  await tx.update(heartbeatRuns).set({ runnerProfileJson: sql`jsonb_set(coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb),
    '{nativeWorkspaceFinalizationOwner}', ${JSON.stringify({ fenced: true, at: recordedAt.toISOString() })}::jsonb)` })
    .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  const savedSeed = { sourceRunId: run.id, descriptorSha256: reference.descriptorSha256, baselineSha256: reference.baselineSha256 };
  const [readiness] = await tx.insert(issueRecoveryActions).values({ companyId: run.companyId, sourceIssueId: issueId,
    kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system", returnOwnerAgentId: run.agentId,
    cause: FRESH_CONTINUATION_CAUSE, fingerprint: `copy-back-bound:${run.id}`, resolvedAt: recordedAt,
    nextAction: "The previous turn's file changes were not saved. Continue from the last saved files in a new workspace.",
    resolutionNote: "copy_back_bound_isolated", evidence: { runId: run.id, freshContinuation: { schema: FRESH_CONTINUATION_SCHEMA,
      sourceRunId: run.id, trigger: "copy_back_bound", isolation: "fresh_isolated_workspace", stopProof: "unproven_isolated",
      delivery: "caller_owns", recordedAt: recordedAt.toISOString(), savedSeed } } }).returning({ id: issueRecoveryActions.id });
  return { kind: "classic_isolated" as const, sourceRunId: run.id, workspaceId: workspace.id, readinessId: readiness!.id, savedSeed,
    // The root and box stay as they are; a copy-back still running may yet write into that root, and nothing reads it.
    quarantine: { state: "retained" as const, leaseId: reference.leaseId, providerLeaseId: reference.providerLeaseId,
      remoteCwd: reference.remoteCwd } };
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA = "paperclip.remote-workspace-abandoned-epoch.v1";
export const ABANDONED_WORKSPACE_FILES_RETENTION_DAYS = 7;
export const ABANDONED_WORKSPACE_FILES_RETENTION_MS = ABANDONED_WORKSPACE_FILES_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Ends an epoch whose unsaved files cannot be verified, without applying them.
 * The last committed save stays the workspace's content. The writer, its dirty
 * flag and its location are cleared and the epoch advances, so the old writer
 * can no longer publish. The published root and any migration root are
 * forgotten, so the next preparation restores the saved version into a new
 * directory and never reuses or overwrites the root that holds the unverified
 * files. The caller holds the task, run and recovery locks; this locks the
 * workspace last.
 */
export async function abandonUnverifiedRemoteWorkspaceEpoch(tx: Transaction, input: {
  companyId: string; workspaceId: string; runId: string; epoch: number; snapshotId: string | null;
  location: NonNullable<RemoteWorkspaceAuthority["location"]>;
}) {
  const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId),
    eq(executionWorkspaces.companyId, input.companyId))).for("update");
  const current = workspace ? readRemoteWorkspaceAuthority(workspace.metadata) : null;
  const location = current?.location;
  if (!workspace || !current || !location || current.writerRunId !== input.runId || current.epoch !== input.epoch
    || current.snapshotId !== input.snapshotId
    || (["environmentId", "leaseId", "providerLeaseId", "remoteCwd"] as const).some(key => location[key] !== input.location[key])) {
    throw new Error("remote_workspace_authority_changed");
  }
  const next: RemoteWorkspaceAuthority = { ...current, epoch: current.epoch + 1, writerRunId: null, dirty: false, location: null };
  const prior = Array.isArray(workspace.metadata?.remoteWorkspaceAbandonedEpochs)
    ? workspace.metadata.remoteWorkspaceAbandonedEpochs as unknown[] : [];
  const abandoned = { schema: REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA, epoch: current.epoch, runId: input.runId,
    snapshotId: current.snapshotId, location, providerRef: workspace.providerRef,
    ...(workspace.metadata?.nativeWorkspaceMigration !== undefined ? { nativeWorkspaceMigration: workspace.metadata.nativeWorkspaceMigration } : {}),
    abandonedAt: new Date().toISOString(), retainUntil: new Date(Date.now() + ABANDONED_WORKSPACE_FILES_RETENTION_MS).toISOString() };
  const held = (receipt: unknown) => {
    const value = receipt as { schema?: unknown; released?: unknown; location?: { providerLeaseId?: unknown } } | null;
    return value?.schema === REMOTE_WORKSPACE_ABANDONED_EPOCH_SCHEMA && value.released == null
      && typeof value.location?.providerLeaseId === "string";
  };
  const sameRoot = (receipt: unknown) => {
    const value = receipt as { location?: { providerLeaseId?: unknown; remoteCwd?: unknown } };
    return held(receipt) && value.location?.providerLeaseId === location.providerLeaseId && value.location?.remoteCwd === location.remoteCwd;
  };
  const kept = [...prior.filter(receipt => !sameRoot(receipt)), abandoned];
  const releasedHistory = kept.filter(receipt => !held(receipt)).slice(-20);
  const metadata: Record<string, unknown> = { ...workspace.metadata, remoteWorkspace: next,
    remoteWorkspaceAbandonedEpochs: kept.filter(receipt => held(receipt) || releasedHistory.includes(receipt)) };
  // The migration receipt names the old root as the next preparation's root.
  delete metadata.nativeWorkspaceMigration;
  const [saved] = await tx.update(executionWorkspaces).set({ providerRef: null, cwd: `/workspaces/${workspace.id}`, metadata,
    updatedAt: new Date() }).where(and(eq(executionWorkspaces.id, workspace.id), eq(executionWorkspaces.companyId, input.companyId))).returning();
  await persistActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "system", actorId: "remote-workspaces",
    action: "workspace.remote_epoch_abandoned", entityType: "execution_workspace", entityId: workspace.id, runId: input.runId,
    details: { abandonedEpoch: current.epoch, epoch: next.epoch, snapshotId: next.snapshotId } });
  return { workspace: saved!, authority: next };
}
