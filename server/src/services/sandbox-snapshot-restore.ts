type RestartMetadata = {
  restoredFromSnapshotAt?: string;
  rebootedAt?: string;
  handledProcessRestartKey?: string;
};

/** The allocation survived, but only processes started BEFORE this generation were lost.
 * Keep the handled generation durable: providers can repeat the same receipt forever. */
export function sandboxRestartMetadata(
  lease: { providerLeaseId?: string | null; metadata?: Record<string, unknown> | null },
  reply?: { providerLeaseId?: string | null; restoredFromSnapshotAt?: string; metadata?: Record<string, unknown> | null },
): RestartMetadata {
  // A resume reply for another allocation has no authority to inherit either
  // this allocation's loss receipt or the generation handled by its Runner.
  const sameAllocation = !reply?.providerLeaseId || !lease.providerLeaseId
    || reply.providerLeaseId === lease.providerLeaseId;
  const leaseMetadata = sameAllocation ? lease.metadata : undefined;
  const result: RestartMetadata = {};
  for (const key of ["restoredFromSnapshotAt", "rebootedAt"] as const) {
    const value = (key === "restoredFromSnapshotAt" ? reply?.restoredFromSnapshotAt : undefined)
      ?? reply?.metadata?.[key] ?? leaseMetadata?.[key];
    if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) result[key] = value;
  }
  // Only this allocation's persisted lease provenance can acknowledge a restart.
  const handled = leaseMetadata?.handledProcessRestartKey;
  if (typeof handled === "string") result.handledProcessRestartKey = handled;
  if (restartKey(result) === handled) {
    delete result.restoredFromSnapshotAt;
    delete result.rebootedAt;
  }
  return result;
}

function restartKey(metadata: RestartMetadata): string | undefined {
  return metadata.restoredFromSnapshotAt || metadata.rebootedAt
    ? JSON.stringify([metadata.restoredFromSnapshotAt ?? null, metadata.rebootedAt ?? null]) : undefined;
}

/** Shared by target construction, restart reattachment, adoption and owner retirement. */
export function sandboxRestartKey(metadata?: RestartMetadata | null): string | undefined {
  return metadata ? restartKey(sandboxRestartMetadata({ metadata: { ...metadata } })) : undefined;
}
