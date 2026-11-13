// Boot sources are allocation identity, never compatible creation settings.
// Even clearing an explicit source must not resume an older snapshot.
const BOOT_SOURCE_KEYS = ["from", "snapshot", "image", "rootfs"] as const;

export function sandboxLeaseSourceMatches(
  current: Record<string, unknown>,
  admitted: Record<string, unknown>,
): boolean {
  return BOOT_SOURCE_KEYS.every(key => JSON.stringify(current[key] ?? null) === JSON.stringify(admitted[key] ?? null));
}

// Allocation identity is deliberately fail-closed: only these sizing/timing
// settings may drain. Unknown provider fields, boot sources, accounts, regions,
// endpoints, mounts, environment variables and credentials remain identity fields.
const COMPATIBLE_SCALAR_KEYS = new Set([
  "cpu", "memory", "disk", "gpu", "size", "shape",
  "timeoutMs", "bridgeRequestTimeoutMs", "livenessTimeoutMs", "ttlMinutes",
  "autoStopInterval", "autoArchiveInterval", "autoDeleteInterval", "runnerIdleTimeoutMs",
]);
const RESOURCE_SIZE_KEYS = new Set(["cpu", "memory", "disk", "gpu"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string" || typeof value === "number";
}

function split(config: Record<string, unknown>) {
  const identity: Record<string, unknown> = {};
  const compatible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (COMPATIBLE_SCALAR_KEYS.has(key) && scalar(value)) {
      compatible[key] = value;
    } else if (key === "resources" && record(value)) {
      const identityResources: Record<string, unknown> = {};
      const compatibleResources: Record<string, unknown> = {};
      for (const [resource, amount] of Object.entries(value)) {
        if (RESOURCE_SIZE_KEYS.has(resource) && scalar(amount)) compatibleResources[resource] = amount;
        else identityResources[resource] = amount;
      }
      if (Object.keys(identityResources).length) identity.resources = identityResources;
      if (Object.keys(compatibleResources).length) compatible.resources = compatibleResources;
    } else {
      identity[key] = value;
    }
  }
  return { identity, compatible };
}

export function sandboxLeaseIdentityConfig(config: Record<string, unknown>): Record<string, unknown> {
  return split(config).identity;
}

/** Keep the admitted allocation's creation settings, including absent optional
 * settings. Never rewrite its fingerprint as if it had booted the new image. */
export function admittedSandboxLeaseConfig(
  current: Record<string, unknown>,
  admitted: Record<string, unknown>,
): Record<string, unknown> {
  const { identity } = split(current);
  const { compatible } = split(admitted);
  const result = { ...identity, ...compatible };
  if (record(identity.resources) && record(compatible.resources)) {
    result.resources = { ...identity.resources, ...compatible.resources };
  }
  return result;
}
