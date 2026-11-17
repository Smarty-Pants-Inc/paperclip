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
 * before. Also the bound of a lease release's wait for a warm owner closing on
 * its sandbox (environment-runtime releaseRunLeases, once per release call).
 */
export const warmSessionReleaseWait = { timeoutMs: 30_000, pollMs: 25 };

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
