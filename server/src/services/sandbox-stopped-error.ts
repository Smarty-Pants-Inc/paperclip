import { JsonRpcCallError } from "@paperclipai/plugin-sdk";

export const SANDBOX_STOPPED_RESUME_BUDGET_MS = 20_000;

/** A provider rejected the command before execution. Not an unknown RPC outcome. */
export class SandboxStoppedError extends Error {
  readonly code = "sandbox_stopped";
  constructor(readonly reason: "resume_failed" | "still_stopped" | "lease_not_active" | "resume_unavailable" | "sync_rejected", cause: unknown) {
    super(`sandbox_stopped: ${reason}; the exact sandbox and its saved conversation were preserved`, { cause });
    this.name = "SandboxStoppedError";
  }
}

/** Legacy Boat workers do not serialize HTTP status on environmentExecute. Only
 * their authenticated, exact-allocation command rejection proves no execution.
 * A generic 409, stdout containing this text, or an ambiguous timeout must NEVER
 * authorize command replay. Remove this compatibility parser when the provider
 * exports a structured command-rejection diagnostic through the SDK. */
export function isStoppedSandboxCommandRejection(error: unknown, providerLeaseId: string): boolean {
  if (!(error instanceof JsonRpcCallError)) return false;
  const match = /^Boat POST \/sandboxes\/([^/?\s]+)\/commands failed \(409\): Sandbox (\S+) is stopped\.(?:\s|$)/.exec(error.message);
  if (!match || match[2] !== providerLeaseId) return false;
  try { return decodeURIComponent(match[1]!) === providerLeaseId; }
  catch { return false; }
}

/** The same exact-allocation rejection from a file transfer: Boat refuses
 * `/files`, `/files/upload-url` and `/commands` on a stopped box at once (409,
 * body code machine_not_running). It types the failure only; it never
 * authorizes a transfer replay. */
export function isStoppedSandboxSyncRejection(error: unknown, providerLeaseId: string): boolean {
  if (!(error instanceof JsonRpcCallError)) return false;
  const match = /^Boat (?:POST|PUT) \/sandboxes\/([^/?\s]+)\/(?:files(?:\/upload-url)?|commands) failed \(409\): Sandbox (\S+) is stopped\.(?:\s|$)/.exec(error.message);
  if (!match || match[2] !== providerLeaseId) return false;
  try { return decodeURIComponent(match[1]!) === providerLeaseId; }
  catch { return false; }
}

/** Preserve the definite failure through transport wrappers, without matching
 * arbitrary command text or changing the policy for unknown transport errors. */
export function findSandboxStoppedError(error: unknown): SandboxStoppedError | null {
  const seen = new Set<unknown>();
  for (let current = error; current instanceof Error && !seen.has(current) && seen.size < 8; current = current.cause) {
    if (current instanceof SandboxStoppedError) return current;
    seen.add(current);
  }
  return null;
}
