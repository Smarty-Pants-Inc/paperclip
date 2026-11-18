// Boot sources are allocation identity, never compatible creation settings.
// Even clearing an explicit source must not resume an older snapshot.
const BOOT_SOURCE_KEYS = ["from", "snapshot", "image", "rootfs"] as const;

export function sandboxLeaseSourceMatches(
  current: Record<string, unknown>,
  admitted: Record<string, unknown>,
): boolean {
  return BOOT_SOURCE_KEYS.every(key => JSON.stringify(current[key] ?? null) === JSON.stringify(admitted[key] ?? null));
}
