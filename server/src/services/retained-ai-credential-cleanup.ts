import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";

export type RetainedAiCleanupScope = { companyId: string; accountKey: string };
export function retainedAiAccountKeyHash(accountKey: string): string {
  return createHash("sha256").update(accountKey).digest("hex").slice(0, 12);
}
type Cleanup = {
  scope: RetainedAiCleanupScope;
  home?: string;
  cleanup: () => Promise<void>;
  retryRetirement?: () => Promise<void>;
  retired: "pending" | "confirmed" | "failed";
  running?: Promise<void>;
  executing?: boolean;
  warned?: boolean;
  agentId?: string;
};
const retained = new Map<string, Set<Cleanup>>();
const homes = new Map<string, RetainedAiCleanupScope>();
const active = new AsyncLocalStorage<ReadonlySet<Cleanup>>();
const key = (scope: RetainedAiCleanupScope) => JSON.stringify([scope.companyId, scope.accountKey]);
registerIdleLocalWorkProbe(() => retained.size ? "present" : "none");

function pending() {
  return unprocessable("This runtime still has unfinished credential cleanup.", { code: "ai_credential_cleanup_pending" });
}
function remove(entry: Cleanup) {
  const entries = retained.get(key(entry.scope));
  entries?.delete(entry);
  if (!entries?.size) retained.delete(key(entry.scope));
}
function warn(entry: Cleanup, reason: "retirement_rejected" | "cleanup_threw") {
  if (entry.warned) return;
  entry.warned = true;
  try {
    logger.warn({ companyId: entry.scope.companyId, code: "AI_CREDENTIAL_CLEANUP_PENDING",
      accountKeyHash: retainedAiAccountKeyHash(entry.scope.accountKey), reason,
      ...(entry.agentId ? { agentId: entry.agentId } : {}) },
    "Selected AI credential cleanup remains pending");
  } catch { /* Diagnostics must not change cleanup behavior. */ }
}
function cleaningScope(scope: RetainedAiCleanupScope) {
  return [...(active.getStore() ?? [])].some(entry => entry.executing && key(entry.scope) === key(scope));
}

function attempt(entry: Cleanup): Promise<void> {
  if (!retained.get(key(entry.scope))?.has(entry)) return Promise.resolve();
  if (entry.retired === "pending" || (entry.retired === "failed" && !entry.retryRetirement)) return Promise.reject(pending());
  return entry.running ??= active.run(new Set([...(active.getStore() ?? []), entry]), async () => {
    entry.executing = true;
    try {
      if (entry.retired === "failed") {
        await entry.retryRetirement!();
        entry.retired = "confirmed";
      }
      await entry.cleanup(); remove(entry);
    }
    catch (error) {
      // The encrypted journal now owns recovery; the next account preparation
      // reads it before it can launch another provider.
      if (entry.retired === "confirmed" && error instanceof RetiredCredentialRecoveryError) { remove(entry); return; }
      warn(entry, "cleanup_threw");
      throw pending();
    } finally { entry.executing = false; }
  }).finally(() => { entry.running = undefined; });
}

/** A retirement event gets one cleanup attempt. Already-retired failures retry
 * only on the next same-account action, never on an idle timer or SQL scan. */
export function retainAiCredentialCleanup(input: {
  // Accept legacy Google home metadata for compatibility. Only the explicit
  // bindRetainedAiCredentialHome mapping grants home-to-account authority.
  scope: RetainedAiCleanupScope; cleanup: () => Promise<void>; retired?: Promise<void>; retryRetirement?: () => Promise<void>; home?: string;
  agentId?: string;
}): void {
  const scopeKey = key(input.scope);
  const entries = retained.get(scopeKey) ?? new Set<Cleanup>();
  if ([...entries].some(entry => entry.cleanup === input.cleanup)) return;
  const entry: Cleanup = { scope: { ...input.scope }, home: input.home, cleanup: input.cleanup, retryRetirement: input.retryRetirement,
    agentId: input.agentId, retired: input.retired ? "pending" : "confirmed" };
  entries.add(entry); retained.set(scopeKey, entries);
  if (input.retired) void input.retired.then(() => {
    entry.retired = "confirmed";
    return attempt(entry).catch(() => undefined);
  }, () => { entry.retired = "failed"; warn(entry, "retirement_rejected"); });
}

export async function reconcileRetainedAiCleanup(scope: RetainedAiCleanupScope): Promise<void> {
  await Promise.resolve();
  const scopeKey = key(scope);
  if (cleaningScope(scope)) return;
  for (const entry of [...(retained.get(scopeKey) ?? [])]) await attempt(entry);
}

export function bindRetainedAiCredentialHome(home: string, scope: RetainedAiCleanupScope): () => void {
  const bound = { ...scope };
  homes.set(home, bound);
  return () => { if (homes.get(home) === bound) homes.delete(home); };
}
export async function reconcileRetainedAiCleanupForHome(home: string): Promise<void> {
  const scope = homes.get(home);
  if (!scope || cleaningScope(scope)) return;
  for (const entry of [...(retained.get(key(scope)) ?? [])]) {
    if (entry.home === home) await attempt(entry);
  }
}
export function retainAiCredentialCleanupForHome(home: string, input: {
  cleanup: () => Promise<void>; retired?: Promise<void>; retryRetirement?: () => Promise<void>;
}): void {
  const scope = homes.get(home);
  if (scope) retainAiCredentialCleanup({ ...input, scope, home });
}
