import type { environmentLeases, Db } from "@paperclipai/db";
import { hasConfirmedSandboxStopAndRetain } from "../sandbox-stop-and-retain.js";
import { preparedRemoteWorkspaceSource } from "../remote-workspace-lifecycle.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";

/** A stopped v3 native-sync source: the run's prepared v3 reference (its own
 * binding proof) names this exact lease, box, remote directory and workspace,
 * and its export is still owed (not finalized). preparedRemoteWorkspaceSource
 * understands only the remoteWorkspace reference, so it cannot prove this. */
export function stoppedNativeSyncSource(profile: Record<string, unknown> | null | undefined,
  lease: Pick<typeof environmentLeases.$inferSelect, "id" | "providerLeaseId" | "executionWorkspaceId" | "metadata">) {
  const reference = readNativeWorkspaceSyncReference(profile?.nativeWorkspaceSync);
  return Boolean(reference && reference.schema === "paperclip.native-workspace-sync/v3"
    && reference.state === "prepared" && reference.finalHostSha256 === null
    && reference.leaseId === lease.id && reference.providerLeaseId === lease.providerLeaseId
    && reference.remoteCwd === lease.metadata?.remoteCwd
    && (!lease.executionWorkspaceId || lease.executionWorkspaceId === reference.workspaceId));
}

/** The prepared source of a stopped (released, confirmed stop-and-retain)
 * reusable lease. Legacy runs prove it with the remote workspace binding,
 * exactly as before; v3 native-sync runs with their own descriptor reference. */
export async function stoppedReusableSourceProof(db: Db, profile: Record<string, unknown> | null | undefined,
  lease: typeof environmentLeases.$inferSelect) {
  if (!hasConfirmedSandboxStopAndRetain(lease)) return false;
  return profile?.nativeWorkspaceSync == null ? Boolean(await preparedRemoteWorkspaceSource(db, lease))
    : stoppedNativeSyncSource(profile, lease);
}
