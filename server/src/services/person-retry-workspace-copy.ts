import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { environmentLeases, environments, executionWorkspaces, executionWorkspaceSnapshots, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, remoteWorkspaceRunReferenceSchema, type EnvironmentLease, type RemoteWorkspaceRunReference } from "@paperclipai/shared";
import { resolveEnvironmentExecutionTarget } from "./environment-execution-target.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { captureReadOnlyWorkspaceArchive, requireRemoteWorkspaceTarget } from "./remote-workspace-transport.js";
import { beginWorkspaceSnapshot, uploadWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";
import { notifyRemoteWorkspaceSnapshots } from "./remote-workspace-snapshot-retention.js";
import { getStorageService } from "../storage/index.js";
import { captureTaskDirectorySnapshot, materializeTaskDirectorySnapshot } from "./isolated-task-directory-snapshot.js";
import { storeTaskDirectoryRestorePoint } from "./isolated-task-directory-retention.js";
import { activateGitRestorePoints } from "./git-restore-point-storage.js";

/** A person-authorized copy, never a second binding to the old writer's directory.
 * The ordinary snapshot reader enforces no-follow, bounded reads and byte checks;
 * the ordinary sealed restore-point ledger retains custody of the copied bytes.
 * Nothing here stops the old process or mutates its files.
 */
export async function copyWorkspaceAtPersonRetry(db: Db, input: { companyId: string; issueId: string; workspaceId: string; runId: string; remoteReference?: unknown }) {
  const remote = remoteWorkspaceRunReferenceSchema.safeParse(input.remoteReference);
  if (remote.success) return copyRemoteWorkspaceAtPersonRetry(db, { ...input, reference: remote.data });
  const [source] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId)));
  if (!source?.cwd || source.providerType !== "local_fs") throw new Error("workspace_copy_unavailable");
  const captured = await captureTaskDirectorySnapshot(source.cwd);
  const id = randomUUID();
  const cwd = path.join(path.dirname(source.cwd), `retry-${id}`);
  const staged = await materializeTaskDirectorySnapshot({ payload: captured.payload, target: cwd, expectedDigest: captured.digest });
  try {
    await fs.rename(staged, cwd);
    const [workspace] = await db.insert(executionWorkspaces).values({
      id, companyId: source.companyId, projectId: source.projectId, sourceIssueId: input.issueId,
      mode: "isolated_workspace", strategyType: "project_primary", name: "Retry copy", cwd,
      providerType: "local_fs", providerRef: cwd, derivedFromExecutionWorkspaceId: source.id,
      metadata: { personRetryCopy: { sourceRunId: input.runId, sourceWorkspaceId: source.id, copiedAt: new Date().toISOString(), digest: captured.digest } },
    }).returning();
    const stored = await storeTaskDirectoryRestorePoint(db, getStorageService(), workspace!, 1, captured);
    await activateGitRestorePoints(db as unknown as Parameters<typeof activateGitRestorePoints>[0], { ledgerIds: [stored.ledgerId], workspaceId: id, at: new Date() });
    await db.update(executionWorkspaces).set({ metadata: { ...workspace!.metadata, personRetryRestorePoint: stored.ref } })
      .where(eq(executionWorkspaces.id, id));
    return { workspaceId: id, cwd, files: captured.files, excluded: captured.excluded as number | null, digest: captured.digest, remote: false };
  } catch (error) {
    await fs.rm(staged, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

/** The remote variant uses the existing read-only inventory/capture and sealed
 * snapshot custody. It publishes ONLY to a new workspace identity; the caller
 * must still fence the source epoch before binding the task to the copy. */
async function copyRemoteWorkspaceAtPersonRetry(db: Db, input: {
  companyId: string; issueId: string; workspaceId: string; runId: string; reference: RemoteWorkspaceRunReference;
}) {
  const reference = input.reference;
  if (reference.state !== "prepared" || reference.workspaceId !== input.workspaceId) throw new Error("source_binding_changed");
  const [source] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.workspaceId))).for("update");
  const authority = source ? readRemoteWorkspaceAuthority(source.metadata) : null;
  if (!source || !authority || authority.writerRunId !== input.runId || authority.epoch !== reference.epoch ||
    authority.location?.leaseId !== reference.leaseId || authority.location.remoteCwd !== reference.remoteCwd ||
    authority.location.providerLeaseId !== reference.providerLeaseId) throw new Error("source_binding_changed");
  const [lease] = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId),
    eq(environmentLeases.id, reference.leaseId), eq(environmentLeases.heartbeatRunId, input.runId)));
  if (!lease?.environmentId || lease.providerLeaseId !== reference.providerLeaseId) throw new Error("source_allocation_unreadable");
  const [environment] = await db.select().from(environments).where(and(eq(environments.id, lease.environmentId)));
  if (!environment) throw new Error("source_environment_unreadable");
  const executionTarget = await resolveEnvironmentExecutionTarget({ db, companyId: input.companyId, adapterType: "paperclip_runner", environment,
    leaseId: lease.id, leaseMetadata: lease.metadata, lease: lease as EnvironmentLease, environmentRuntime: environmentRuntimeService(db, { readOnlyInspection: true }) });
  const target = requireRemoteWorkspaceTarget(executionTarget);
  const operationId = randomUUID();
  const captured = await captureReadOnlyWorkspaceArchive({ target, remoteCwd: reference.remoteCwd, operationId });
  try {
    const id = randomUUID();
    const cwd = `/workspaces/${id}`;
    const proof = { sourceRunId: input.runId, sourceWorkspaceId: source.id, copiedAt: new Date().toISOString(), digest: captured.manifestDigest };
    await db.insert(executionWorkspaces).values({ id, companyId: input.companyId, projectId: source.projectId, projectWorkspaceId: source.projectWorkspaceId,
      sourceIssueId: input.issueId, mode: "isolated_workspace", strategyType: source.strategyType, name: "Retry copy", cwd,
      providerType: source.providerType, derivedFromExecutionWorkspaceId: source.id,
      metadata: { personRetryCopy: proof, remoteWorkspace: { ...authority, epoch: 0, snapshotId: null, writerRunId: null, dirty: false, location: null } } });
    await db.insert(workspaceOperations).values({ id: operationId, companyId: input.companyId, executionWorkspaceId: id,
      issueId: input.issueId, heartbeatRunId: input.runId, phase: "person_retry_workspace_copy", status: "running", metadata: proof });
    const snapshot = await beginWorkspaceSnapshot(db, { companyId: input.companyId, workspaceId: id, operationId, runId: input.runId, generation: 1, epoch: 0 });
    const saved = await uploadWorkspaceSnapshot({ db, storage: getStorageService(), snapshotId: snapshot.id, companyId: input.companyId,
      workspaceId: id, archivePath: captured.archivePath, manifestDigest: captured.manifestDigest,
      expectedArchive: { sha256: captured.sha256, byteSize: captured.byteSize }, signal: AbortSignal.timeout(120_000) });
    await db.update(executionWorkspaceSnapshots).set({ status: "committed", updatedAt: new Date() }).where(and(
      eq(executionWorkspaceSnapshots.id, saved.id), eq(executionWorkspaceSnapshots.status, "uploaded")));
    await db.update(executionWorkspaces).set({ metadata: { personRetryCopy: proof,
      remoteWorkspace: { ...authority, epoch: 0, snapshotId: saved.id, writerRunId: null, dirty: false, location: null },
      remoteWorkspaceSnapshotRepositories: { snapshotId: saved.id, repositories: authority.source.repositories ?? [] } } }).where(eq(executionWorkspaces.id, id));
    await db.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date(),
      metadata: { ...proof, snapshotId: saved.id } }).where(eq(workspaceOperations.id, operationId));
    await notifyRemoteWorkspaceSnapshots(db as unknown as Parameters<typeof notifyRemoteWorkspaceSnapshots>[0], `workspace:${id}`);
    return { workspaceId: id, cwd, files: captured.entries, excluded: null as number | null, digest: captured.manifestDigest, remote: true };
  } finally { await captured.cleanup(); }
}
