/**
 * release-order: the in-process warm owners still closing on each sandbox.
 *
 * A warm owner's close checkpoints its Runner and copies the harness out of
 * the sandbox (provider file sync). A provider release, stop or destroy of the
 * same sandbox ends that sandbox's activity (a provider plugin may revoke its
 * in-flight requests), so it must run only after the close finished: "run your
 * own cleanup first, then stop". Keyed by the provider lease id, which names
 * one physical sandbox for every lease row on it.
 */

/**
 * How long a new run's admission waits for the warm session to stop being busy.
 * A follow-up comment can wake the next run within milliseconds of the previous
 * run settling, while that run's warm release is still finishing. Waiting out
 * the release lets the follow-up reuse the session instead of failing. A
 * session still busy at the deadline is a real concurrent owner and fails as
 * before.
 */
export const warmSessionReleaseWait = { timeoutMs: 30_000, pollMs: 25 };

/** settle-sites: ONE own-predecessor settle deadline per successor run.
 * Every site where a successor joins its own predecessor's release (the
 * instruction-directory join in heartbeat preparation, the superseded-owner
 * wait, the Stop-command wait, warm admission, and the run's own lease release
 * on the predecessor's sandbox) reads the deadline the first of them derived,
 * so sequential waits never exceed warmSessionReleaseWait in total. Memory
 * only, never inside a database transaction. An entry is dropped one further
 * bound after it expired, so a later attempt of the same run starts afresh. */
const ownPredecessorSettleDeadlines = new Map<string, number>();
export function ownPredecessorSettleDeadline(successorRunId: string): number {
  const now = Date.now();
  for (const [runId, expiresAt] of ownPredecessorSettleDeadlines) {
    if (expiresAt + warmSessionReleaseWait.timeoutMs < now) ownPredecessorSettleDeadlines.delete(runId);
  }
  let deadline = ownPredecessorSettleDeadlines.get(successorRunId);
  if (deadline === undefined) {
    deadline = now + warmSessionReleaseWait.timeoutMs;
    ownPredecessorSettleDeadlines.set(successorRunId, deadline);
  }
  return deadline;
}

const closingOnSandbox = new Map<string, Set<Promise<unknown>>>();

/** Records a warm owner's close on its sandbox until the close settles. */
export function trackWarmOwnerSandboxClose<T>(providerLeaseId: string | null | undefined, closing: Promise<T>): Promise<T> {
  if (!providerLeaseId) return closing;
  const settled: Promise<unknown> = closing.then(() => undefined, () => undefined);
  let closes = closingOnSandbox.get(providerLeaseId);
  if (!closes) closingOnSandbox.set(providerLeaseId, closes = new Set());
  closes.add(settled);
  void settled.then(() => {
    const current = closingOnSandbox.get(providerLeaseId);
    current?.delete(settled);
    if (current?.size === 0) closingOnSandbox.delete(providerLeaseId);
  });
  return closing;
}

export function warmOwnerClosingOnSandbox(providerLeaseId: string | null | undefined): boolean {
  return Boolean(providerLeaseId && closingOnSandbox.get(providerLeaseId)?.size);
}

/** Thrown when a warm owner's close on the sandbox outlived the bound: the
 * provider release is not dispatched, so the close is never cut off. */
export class WarmOwnerCloseInFlightError extends Error {
  readonly code = "warm_owner_close_in_flight";
  constructor(readonly providerLeaseId: string) {
    super(`A previous run's session on sandbox ${providerLeaseId} is still saving its work; its release waits for that.`);
  }
}

/**
 * Waits (success or failure) for every warm owner close in flight on the
 * sandbox, until the deadline. Returns at once when none is closing. Throws
 * WarmOwnerCloseInFlightError when one is still closing at the deadline.
 */
export async function awaitWarmOwnerSandboxCloses(providerLeaseId: string | null | undefined, deadline: number): Promise<void> {
  while (providerLeaseId) {
    const closes = closingOnSandbox.get(providerLeaseId);
    if (!closes?.size) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new WarmOwnerCloseInFlightError(providerLeaseId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...closes]),
      new Promise<void>(resolve => { timer = setTimeout(resolve, remaining); }),
    ]).finally(() => clearTimeout(timer));
  }
}
