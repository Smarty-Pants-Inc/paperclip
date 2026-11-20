import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { registerIdleLocalWorkProbe } from "./idle-local-work.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";
import { isSandboxLeaseStartDeniedError } from "./retained-sandbox-absent-error.js";
import { boundDiagnosticFields, summarizeDiagnosticError } from "./native-runtime/diagnostic-error-summary.js";

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
  /** When this entry was first retained (the time bound's start). */
  retainedAt: number;
  /** The probe box's lease was denied on a retirement retry: the on-box part is moot. */
  boxGone?: boolean;
  stallAlarmed?: boolean;
};
/** An owned probe cleanup still pending after this long parks its owning
 * agent for Retry (checked on that agent's next lifecycle attempt, never on a
 * timer). The entry stays retained and keeps retrying on same-account actions. */
export const PROBE_CLEANUP_PENDING_PARK_MS = 10 * 60_000;
const retained = new Map<string, Set<Cleanup>>();
/** Agents whose probe box was gone before its handoff was confirmed: their
 * next own reconcile parks them once (a Retry then re-attempts). */
const boxGoneNotices = new Set<string>();
const noticeKey = (scope: RetainedAiCleanupScope, agentId: string) => JSON.stringify([scope.companyId, scope.accountKey, agentId]);
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
/** The retirement retry could not start the probe box: its lease is retired or
 * superseded (the box was swept), so no on-box handoff can ever be confirmed. */
function sandboxLeaseStartDenied(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return false;
    seen.add(value);
    if (isSandboxLeaseStartDeniedError(value)) return true;
    const candidate = value as { cause?: unknown; errors?: unknown };
    return visit(candidate.cause, depth + 1) || (Array.isArray(candidate.errors) && candidate.errors.some(item => visit(item, depth + 1)));
  };
  return visit(error, 0);
}
function alarm(entry: Cleanup, code: "native_probe_cleanup_box_gone" | "native_probe_cleanup_stalled", message: string) {
  try {
    logger.error({ code, companyId: entry.scope.companyId, accountKeyHash: retainedAiAccountKeyHash(entry.scope.accountKey),
      ...(entry.agentId ? { agentId: entry.agentId } : {}), ...(entry.home ? { runtimeHome: entry.home } : {}),
      pendingMs: Date.now() - entry.retainedAt }, message);
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
        try { await entry.retryRetirement!(); }
        catch (error) {
          // The probe box is gone: its on-box handoff can never be confirmed and
          // nothing runs there. The transport's off-box steps (authority
          // release, refresh preservation) precede that handoff step; this
          // runtime's off-box cleanup (credential write-back, home removal)
          // still runs below and is read back before the entry is dropped.
          if (!sandboxLeaseStartDenied(error)) throw error;
          entry.boxGone = true;
        }
        entry.retired = "confirmed";
      }
      await entry.cleanup();
      // Read back: the runtime home this entry held is gone from this server.
      if (entry.home && await stat(entry.home).then(() => true, () => false)) throw new Error("retained runtime home still present");
      remove(entry); settledBoxGone(entry);
    }
    catch (error) {
      // The encrypted journal now owns recovery; the next account preparation
      // reads it before it can launch another provider.
      if (entry.retired === "confirmed" && error instanceof RetiredCredentialRecoveryError) { remove(entry); settledBoxGone(entry); return; }
      warn(entry, "cleanup_threw");
      throw pending();
    } finally { entry.executing = false; }
  }).finally(() => { entry.running = undefined; });
}

function settledBoxGone(entry: Cleanup) {
  if (!entry.boxGone) return;
  alarm(entry, "native_probe_cleanup_box_gone", "Native probe box was gone before its credential handoff was confirmed; its runtime cleanup on this server finished");
  if (entry.agentId) boxGoneNotices.add(noticeKey(entry.scope, entry.agentId));
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
  const existing = [...entries].find(entry => entry.cleanup === input.cleanup);
  if (existing) {
    // The same cleanup retained again by its known owner adopts that owner:
    // a probe's entry must never stay unowned (and gate every agent) once its
    // agent is known. An owned entry keeps its first owner.
    if (existing.agentId === undefined && input.agentId !== undefined) existing.agentId = input.agentId;
    return;
  }
  const entry: Cleanup = { scope: { ...input.scope }, home: input.home, cleanup: input.cleanup, retryRetirement: input.retryRetirement,
    agentId: input.agentId, retired: input.retired ? "pending" : "confirmed", retainedAt: Date.now() };
  entries.add(entry); retained.set(scopeKey, entries);
  if (input.retired) void input.retired.then(() => {
    entry.retired = "confirmed";
    return attempt(entry).catch(() => undefined);
  }, (reason: unknown) => {
    entry.retired = "failed"; warn(entry, "retirement_rejected");
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
    try { await attempt(entry); }
    catch (error) {
      // The time bound: the owning agent's own attempt, once its entry has been
      // pending this long, parks it for Retry. The entry stays retained.
      if (options?.agentId !== undefined && entry.agentId === options.agentId
        && Date.now() - entry.retainedAt >= PROBE_CLEANUP_PENDING_PARK_MS
        && (error as { details?: { code?: unknown } } | null)?.details?.code === "ai_credential_cleanup_pending") {
        if (!entry.stallAlarmed) {
          entry.stallAlarmed = true;
          alarm(entry, "native_probe_cleanup_stalled", "Native probe cleanup has stayed pending past its bound; the agent is parked for Retry and the cleanup stays retained");
        }
        throw unprocessable("The native account test could not finish its cleanup.", { code: "native_probe_cleanup_stalled" });
      }
      throw error;
    }
  }
  if (options?.agentId !== undefined && boxGoneNotices.delete(noticeKey(scope, options.agentId))) {
    throw unprocessable("The native account test's machine was gone before its cleanup was confirmed.", { code: "native_probe_cleanup_box_gone" });
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
