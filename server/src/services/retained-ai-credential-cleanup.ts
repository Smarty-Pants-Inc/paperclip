import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";
import { boundDiagnosticFields, summarizeDiagnosticError } from "./native-runtime/diagnostic-error-summary.js";
import { LIFECYCLE_PROBE_CLEANUP_BOUND_MS } from "../modules/agent-lifecycle/application/retry.js";

export type RetainedAiCleanupScope = { companyId: string; accountKey: string };
export function retainedAiAccountKeyHash(accountKey: string): string {
  return createHash("sha256").update(accountKey).digest("hex").slice(0, 12);
}
type Cleanup = {
  scope: RetainedAiCleanupScope;
  home?: string;
  cleanup: () => Promise<void>;
  retryRetirement?: () => Promise<void>;
  /** The probe lease's own durable receipt (one indexed read); never an error code. */
  proveRetired?: () => Promise<boolean>;
  retired: "pending" | "confirmed" | "failed";
  failedAt?: number;
  expired?: boolean;
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

function pending(expired = false) {
  return unprocessable("This runtime still has unfinished credential cleanup.", { code: "ai_credential_cleanup_pending", ...(expired ? { expired: true } : {}) });
}
/** Past the bound an unproven retirement is expired: the hire parks. Expiry
 * never cleans up, never removes the entry and never touches a box. */
function expire(entry: Cleanup): boolean {
  if (entry.expired || entry.retired !== "failed" || entry.failedAt === undefined) return entry.expired === true;
  if (Date.now() - entry.failedAt < LIFECYCLE_PROBE_CLEANUP_BOUND_MS) return false;
  entry.expired = true;
  try {
    logger.warn({ companyId: entry.scope.companyId, code: "AI_CREDENTIAL_CLEANUP_EXPIRED",
      accountKeyHash: retainedAiAccountKeyHash(entry.scope.accountKey), ...(entry.agentId ? { agentId: entry.agentId } : {}) },
    "Selected AI credential cleanup is still unproven after its bound; the hire waits for Retry");
  } catch { /* Diagnostics must not change cleanup behavior. */ }
  return true;
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
  if (entry.retired === "pending" || (entry.retired === "failed" && !entry.retryRetirement && !entry.proveRetired)) return Promise.reject(pending());
  return entry.running ??= active.run(new Set([...(active.getStore() ?? []), entry]), async () => {
    entry.executing = true;
    try {
      if (entry.retired === "failed") {
        if (await entry.proveRetired?.() !== true) {
          if (!entry.retryRetirement) throw pending();
          await entry.retryRetirement();
        }
        entry.retired = "confirmed";
      }
      await entry.cleanup(); remove(entry);
    }
    catch (error) {
      // The encrypted journal now owns recovery; the next account preparation
      // reads it before it can launch another provider.
      if (entry.retired === "confirmed" && error instanceof RetiredCredentialRecoveryError) { remove(entry); return; }
      warn(entry, "cleanup_threw");
      throw pending(expire(entry));
    } finally { entry.executing = false; }
  }).finally(() => { entry.running = undefined; });
}

/** A retirement event gets one cleanup attempt. Already-retired failures retry
 * only on the next same-account action, never on an idle timer or SQL scan. */
export function retainAiCredentialCleanup(input: {
  // Accept legacy Google home metadata for compatibility. Only the explicit
  // bindRetainedAiCredentialHome mapping grants home-to-account authority.
  scope: RetainedAiCleanupScope; cleanup: () => Promise<void>; retired?: Promise<void>; retryRetirement?: () => Promise<void>; home?: string;
  agentId?: string; proveRetired?: () => Promise<boolean>;
}): void {
  const scopeKey = key(input.scope);
  const entries = retained.get(scopeKey) ?? new Set<Cleanup>();
  const existing = [...entries].find(entry => entry.cleanup === input.cleanup);
  if (existing) {
    // The same cleanup retained again by its known owner adopts that owner:
    // a probe's entry must never stay unowned (and gate every agent) once its
    // agent is known. An owned entry keeps its first owner.
    if (existing.agentId === undefined && input.agentId !== undefined) existing.agentId = input.agentId;
    return;
  }
  const entry: Cleanup = { scope: { ...input.scope }, home: input.home, cleanup: input.cleanup, retryRetirement: input.retryRetirement,
    proveRetired: input.proveRetired, agentId: input.agentId, retired: input.retired ? "pending" : "confirmed" };
  entries.add(entry); retained.set(scopeKey, entries);
  if (input.retired) void input.retired.then(() => {
    entry.retired = "confirmed";
    return attempt(entry).catch(() => undefined);
  }, (reason: unknown) => {
    entry.retired = "failed"; entry.failedAt = Date.now(); warn(entry, "retirement_rejected");
    // DIAGNOSTIC (log only): why retirement rejected, as a sanitized summary.
    try {
      const message = "Retained AI credential retirement rejected";
      logger.info(boundDiagnosticFields({ event: "native_retirement_rejected_detail", companyId: entry.scope.companyId, ...(entry.agentId ? { agentId: entry.agentId } : {}),
        error: summarizeDiagnosticError(reason) }, message), message);
    } catch { /* log only */ }
  });
}

/** With `agentId`, only that agent's own retained probe entries (and entries no
 * agent owns) are attempted: one agent's unfinished probe cleanup gates its own
 * next probe, never another agent's hire on the same account. */
export async function reconcileRetainedAiCleanup(scope: RetainedAiCleanupScope, options?: { agentId?: string }): Promise<void> {
  await Promise.resolve();
  const scopeKey = key(scope);
  if (cleaningScope(scope)) return;
  for (const entry of [...(retained.get(scopeKey) ?? [])]) {
    if (options?.agentId !== undefined && entry.agentId !== undefined && entry.agentId !== options.agentId) continue;
    await attempt(entry);
  }
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
