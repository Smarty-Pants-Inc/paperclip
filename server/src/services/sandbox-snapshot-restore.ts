/** The allocation survived but no process from before this timestamp did. */
export function sandboxRestartMetadata(
  lease: { metadata?: Record<string, unknown> | null },
  reply?: { restoredFromSnapshotAt?: string; metadata?: Record<string, unknown> | null },
): { restoredFromSnapshotAt?: string; rebootedAt?: string } {
  const result: { restoredFromSnapshotAt?: string; rebootedAt?: string } = {};
  for (const key of ["restoredFromSnapshotAt", "rebootedAt"] as const) {
    const value = (key === "restoredFromSnapshotAt" ? reply?.restoredFromSnapshotAt : undefined)
      ?? reply?.metadata?.[key] ?? lease.metadata?.[key];
    if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) result[key] = value;
  }
  return result;
}
