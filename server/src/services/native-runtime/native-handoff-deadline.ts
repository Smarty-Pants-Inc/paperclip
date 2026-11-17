/**
 * pl/s3-fence-deadline: ONE deadline for a successor's pre-provider handoff
 * (waiting out the predecessor's release, retiring it, proving its Runner
 * exited, collecting its files and stopping its credentials). Its clock starts
 * at the person's recorded Stop of the predecessor, so first words come within
 * the warm start plus this budget. Without a recorded Stop (or with a Stop
 * older than the whole budget, i.e. one that no longer bounds this handoff),
 * the clock starts at the successor's admission and `origin` says so.
 *
 * Every wait takes min(its own timeout, remaining) and checks the remaining
 * budget BEFORE it starts. At expiry the signal aborts in-flight remote
 * commands, and code that finishes late checks `expired()` before it
 * publishes or deletes anything.
 */
import { NativePredecessorRetirementUnprovenError } from "./predecessor-retirement.js";

export const nativeHandoffDeadlineBudget = { totalMs: 60_000 };

export const NATIVE_HANDOFF_DEADLINE_EXPIRED = "native_handoff_deadline_expired";

/** What remote command code needs: the absolute expiry and the abort signal. */
export type RemoteHandoffBudget = { readonly expiresAtMs: number; readonly signal: AbortSignal;
  expiredError(): Error };

export class NativeHandoffDeadlineExpiredError extends Error {
  readonly code = NATIVE_HANDOFF_DEADLINE_EXPIRED;
  constructor(readonly deadline: Pick<NativeHandoffDeadline, "origin" | "startedAtMs" | "totalMs">) {
    super(`${NATIVE_HANDOFF_DEADLINE_EXPIRED}: the previous run's session was not retired within ${
      deadline.totalMs / 1_000} s of the ${deadline.origin === "stop" ? "Stop" : "new run's admission"}`);
    this.name = "NativeHandoffDeadlineExpiredError";
  }
}

export type NativeHandoffDeadline = RemoteHandoffBudget & {
  readonly origin: "stop" | "admission";
  /** Why the clock did not start at a Stop, when it did not. */
  readonly admissionReason: "no_stop_recorded" | "stop_older_than_budget" | null;
  readonly startedAtMs: number;
  readonly totalMs: number;
  remainingMs(): number;
  expired(): boolean;
  /** min(ms, remaining), never negative. */
  bound(ms: number): number;
  /** The one typed outcome at expiry: the predecessor stays unretired (kept). */
  unproven(predecessorRunId: string | null, providerLeaseId: string | null): NativePredecessorRetirementUnprovenError;
  /** Resolves with `work`, or rejects with the expiry error at the deadline (aborting the signal). */
  race<T>(work: Promise<T>): Promise<T>;
};

export function createNativeHandoffDeadline(input: { stopRequestedAtMs: number | null | undefined; admissionStartedAtMs?: number;
  totalMs?: number }): NativeHandoffDeadline {
  const totalMs = input.totalMs ?? nativeHandoffDeadlineBudget.totalMs;
  const admittedAt = input.admissionStartedAtMs ?? Date.now();
  const stop = input.stopRequestedAtMs ?? null;
  const fromStop = stop !== null && admittedAt - stop <= totalMs;
  const startedAtMs = fromStop ? stop : admittedAt;
  const expiresAtMs = startedAtMs + totalMs;
  const controller = new AbortController();
  const abortIfDue = () => { if (!controller.signal.aborted && Date.now() >= expiresAtMs) controller.abort(); };
  // A real timer, so an in-flight command is cancelled even if nothing polls.
  const timer = setTimeout(() => controller.abort(), Math.max(0, expiresAtMs - Date.now()));
  (timer as { unref?: () => void }).unref?.();
  const deadline: NativeHandoffDeadline = {
    origin: fromStop ? "stop" : "admission",
    admissionReason: fromStop ? null : stop === null ? "no_stop_recorded" : "stop_older_than_budget",
    startedAtMs, totalMs, expiresAtMs,
    get signal() { abortIfDue(); return controller.signal; },
    remainingMs: () => { abortIfDue(); return controller.signal.aborted ? 0 : Math.max(0, expiresAtMs - Date.now()); },
    expired: () => deadline.remainingMs() <= 0,
    bound: ms => Math.max(0, Math.min(ms, deadline.remainingMs())),
    expiredError: () => new NativeHandoffDeadlineExpiredError(deadline),
    unproven: (predecessorRunId, providerLeaseId) =>
      new NativePredecessorRetirementUnprovenError(predecessorRunId, providerLeaseId, deadline.expiredError()),
    race: async <T>(work: Promise<T>) => {
      if (deadline.expired()) { work.catch(() => undefined); throw deadline.expiredError(); }
      let onAbort: (() => void) | undefined;
      const expiry = new Promise<never>((_, reject) => {
        onAbort = () => reject(deadline.expiredError());
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      expiry.catch(() => undefined);
      work.catch(() => undefined);
      try { return await Promise.race([work, expiry]); }
      finally { if (onAbort) controller.signal.removeEventListener("abort", onAbort); }
    },
  };
  return deadline;
}

/** The deadline error itself or one of its first causes. */
export function isNativeHandoffDeadlineExpired(error: unknown): boolean {
  let current: unknown = error;
  for (let seen = 0; current instanceof Error && seen < 8; seen++) {
    if (current instanceof NativeHandoffDeadlineExpiredError) return true;
    current = current.cause;
  }
  return false;
}

/** Run one remote command under min(its own timeout, remaining). Returns null
 * without starting it when the budget is spent; an abort at expiry settles it
 * as null at once, even when the provider ignores the signal. */
export async function executeWithinHandoff<T>(handoff: RemoteHandoffBudget | undefined, ownTimeoutMs: number,
  run: (bounded: { timeoutMs: number; signal?: AbortSignal }) => Promise<T>): Promise<T | null> {
  if (!handoff) return run({ timeoutMs: ownTimeoutMs });
  const remaining = handoff.expiresAtMs - Date.now();
  if (remaining <= 0 || handoff.signal.aborted) return null;
  const { signal } = handoff;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>(resolve => { onAbort = () => resolve(null); signal.addEventListener("abort", onAbort, { once: true }); });
  const work = run({ timeoutMs: Math.min(ownTimeoutMs, remaining), signal });
  work.catch(() => undefined);
  try { return await Promise.race([work, aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
