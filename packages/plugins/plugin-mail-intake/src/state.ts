import { fail, only, record } from "./config.js";

export const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{1,64}$/.test(v);
export const timestamp = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
export interface Seen { id: string; internalDate: number }
export interface Failure extends Seen { attempts: number; nextRetryAt: number; lastFailureAt?: number }
export interface MailState { version: 2; seen: Seen[]; failures: Failure[]; notBefore?: number }
export const MAX_FAILURES = 10;
/** The scanner's own bound: at most 100 list pages of 500 IDs (intake.ts). */
export const MAX_SEEN_IDS = 50_000;
export const PARKED_WARNING = "mail intake has parked deliveries";
export function parkedWarning(parked: readonly Failure[]): string {
  return `${PARKED_WARNING}: ${parked.map(m => m.id).sort().join(", ")}`;
}
export function emptyState(): MailState { return { version: 2, seen: [], failures: [] }; }
export function parseState(value: unknown): MailState {
  if (!record(value)) fail();
  only(value, ["version", "seen", "failures", "notBefore"]);
  if (value.version !== 2 || !Array.isArray(value.seen) || !Array.isArray(value.failures) ||
      (value.notBefore !== undefined && !timestamp(value.notBefore))) fail();
  const ids = new Set<string>();
  for (const [entries, failed] of [[value.seen, false], [value.failures, true]] as const) {
    for (const entry of entries) {
      if (!record(entry)) fail();
      only(entry, failed ? ["id", "internalDate", "attempts", "nextRetryAt", "lastFailureAt"] : ["id", "internalDate"]);
      if (!isId(entry.id) || !timestamp(entry.internalDate) || ids.has(entry.id)) fail();
      if (failed && (typeof entry.attempts !== "number" || !Number.isInteger(entry.attempts) ||
          entry.attempts < 1 || entry.attempts > MAX_FAILURES || !timestamp(entry.nextRetryAt) ||
          (entry.lastFailureAt !== undefined && !timestamp(entry.lastFailureAt)))) fail();
      ids.add(entry.id);
    }
  }
  return value as unknown as MailState;
}
export function cutoff(days: number, now = Date.now()): number { return now - days * 86_400_000; }
export function prune(state: MailState, since: number): MailState & { notBefore: number } {
  const notBefore = Math.max(state.notBefore ?? since, since);
  return { version: 2, notBefore, seen: state.seen.filter(m => m.internalDate >= notBefore),
    failures: state.failures.filter(m => m.internalDate >= notBefore) };
}
export function failedDelivery(id: string, internalDate: number, prior?: Failure): Failure {
  const attempts = (prior?.attempts ?? 0) + 1;
  const lastFailureAt = Date.now();
  return { id, internalDate, attempts, lastFailureAt,
    nextRetryAt: lastFailureAt + Math.min(120_000 * 2 ** (attempts - 1), 6 * 3_600_000) };
}
/**
 * A board-approved initialize-seen request, recorded by the action and completed by
 * the next job tick (the action cannot read the mailbox inside the host's 30 s cap).
 * IDs only; `failure` is one fixed step code, never provider text.
 */
export interface PendingInit {
  version: 1; seenIds: string[]; requestedAt: number;
  failure?: string; final?: boolean; failedAt?: number;
}
const PENDING_FAILURES = ["mailbox read failed", "seenIds not in window"];
export function parsePending(value: unknown): PendingInit {
  if (!record(value)) fail();
  only(value, ["version", "seenIds", "requestedAt", "failure", "final", "failedAt"]);
  if (value.version !== 1 || !Array.isArray(value.seenIds) || value.seenIds.length > MAX_SEEN_IDS ||
      !value.seenIds.every(isId) || new Set(value.seenIds).size !== value.seenIds.length ||
      !timestamp(value.requestedAt) ||
      (value.failure !== undefined && !(typeof value.failure === "string" && PENDING_FAILURES.includes(value.failure))) ||
      (value.final !== undefined && typeof value.final !== "boolean") ||
      (value.failedAt !== undefined && !timestamp(value.failedAt))) fail();
  return value as unknown as PendingInit;
}
