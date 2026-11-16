import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";

/**
 * The connection-lease expiry the control plane holds for this session: the
 * persisted `lastLeaseExpiresAt` (StoredCoreState, durable-prp-control-plane.ts
 * CP:227), written by the welcome (CP:4167) and by every answered renewal
 * (CP:3636). A lease-credential reconnect keeps the same expiry.
 */
export function controlPlaneLeaseExpiresAtUnixMs(authority: DurablePrpControlPlane): number | null {
  const value = (authority as { store?: { state?: { lastLeaseExpiresAt?: unknown } } }).store?.state?.lastLeaseExpiresAt;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
