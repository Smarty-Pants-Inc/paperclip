import { and, eq } from "drizzle-orm";
import { executionWorkspaces, type heartbeatRuns, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type RemoteWorkspaceAuthority } from "@paperclipai/shared";
import { persistActivity } from "./activity-log.js";

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
