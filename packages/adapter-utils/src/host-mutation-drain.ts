import { AsyncLocalStorage } from "node:async_hooks";

/**
 * adopt-drain: the HOST MUTATION DRAIN (rf-4 22:35Z structural fix).
 *
 * An owner (e.g. a workspace-finalization ownership) runs its host-filesystem
 * work inside `withHostMutationDrain(drain, fn)`. Every host mutation on that
 * path is issued through `hostMutation(fn)` (or `hostCleanup(fn)` for this
 * work's own private scratch / lock files). Contract:
 *
 * - `run(fn)` (via `hostMutation`): refused (throws `HostMutationRefusedError`,
 *   fn is NOT called) once the drain is closed; otherwise fn is called
 *   synchronously and counted in flight until its promise settles.
 * - `cleanup(fn)` (via `hostCleanup`): always runs (releasing this work's own
 *   lock / removing its uniquely named temp), and is counted in flight too.
 * - `close()`: no new `run` starts. Idempotent.
 * - `closeAndDrain(capMs)`: close, then wait until nothing is in flight or
 *   `capMs` passes. Returns `{ drained: true }` or `{ drained: false, inFlight }`.
 *   `drained()` waits without a cap.
 *
 * The owner releases its ownership only after `closeAndDrain` (and, past the
 * cap, after `drained()`), so no host write of the old owner can land after
 * the next owner is admitted, on any branch (mkdir/rename/symlink/copy/rm/git).
 * Remote (box) I/O is NOT tracked: it is abandoned at the deadline.
 *
 * The current drain is carried by AsyncLocalStorage, so nested/inner work
 * started inside the owner's callback takes the outer drain automatically.
 * Outside any drain, `hostMutation(fn)` is just `fn()`.
 */
export class HostMutationRefusedError extends Error {
  readonly code = "HOST_MUTATION_REFUSED";
  constructor(reason?: unknown) {
    super("host_mutation_refused_after_owner_abort", reason === undefined ? undefined : { cause: reason });
  }
}

export type HostMutationDrain = {
  readonly closed: boolean;
  readonly inFlight: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
  cleanup<T>(fn: () => Promise<T>): Promise<T>;
  close(reason?: unknown): void;
  closeAndDrain(capMs: number, reason?: unknown): Promise<{ drained: true } | { drained: false; inFlight: number }>;
  drained(): Promise<void>;
};

/** The default cap on how long an owner waits for in-flight host calls before
 * it reports that a host write is stuck (it still keeps ownership until the
 * call returns). */
export const HOST_MUTATION_DRAIN_CAP_MS = 10_000;

export function createHostMutationDrain(): HostMutationDrain {
  let closed = false;
  let closeReason: unknown;
  let inFlight = 0;
  let waiters: Array<() => void> = [];
  const settle = () => {
    inFlight -= 1;
    if (inFlight === 0) { const ready = waiters; waiters = []; for (const wake of ready) wake(); }
  };
  const track = <T>(fn: () => Promise<T>): Promise<T> => {
    inFlight += 1;
    let promise: Promise<T>;
    try { promise = Promise.resolve(fn()); } catch (error) { settle(); return Promise.reject(error); }
    return promise.finally(settle);
  };
  const drained = () => inFlight === 0 ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push(resolve); });
  return {
    get closed() { return closed; },
    get inFlight() { return inFlight; },
    run(fn) {
      if (closed) return Promise.reject(new HostMutationRefusedError(closeReason));
      return track(fn);
    },
    cleanup: track,
    close(reason) { if (!closed) { closed = true; closeReason = reason; } },
    async closeAndDrain(capMs, reason) {
      this.close(reason);
      if (inFlight === 0) return { drained: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = await Promise.race([
        drained().then(() => false),
        new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), capMs); }),
      ]);
      if (timer) clearTimeout(timer);
      return capped && inFlight > 0 ? { drained: false, inFlight } : { drained: true };
    },
    drained,
  };
}

// One store per process even if this module is loaded twice (src + dist).
const STORE_KEY = Symbol.for("paperclip.adapter-utils.host-mutation-drain");
const store: AsyncLocalStorage<HostMutationDrain> =
  ((globalThis as Record<symbol, unknown>)[STORE_KEY] as AsyncLocalStorage<HostMutationDrain> | undefined)
  ?? ((globalThis as Record<symbol, unknown>)[STORE_KEY] = new AsyncLocalStorage<HostMutationDrain>()) as AsyncLocalStorage<HostMutationDrain>;

/** Run `fn` (and everything it starts) under `drain`. */
export function withHostMutationDrain<T>(drain: HostMutationDrain, fn: () => Promise<T>): Promise<T> {
  return store.run(drain, fn);
}

export function currentHostMutationDrain(): HostMutationDrain | undefined {
  return store.getStore();
}

/** A host mutation (a write another owner can see): refused once the current
 * owner's drain is closed; tracked so the owner's release waits for it. */
export function hostMutation<T>(fn: () => Promise<T>): Promise<T> {
  const drain = store.getStore();
  return drain ? drain.run(fn) : fn();
}

/** Housekeeping of this work's own private scratch or lock files: always
 * runs (so an aborted owner still releases its lock), and is tracked. */
export function hostCleanup<T>(fn: () => Promise<T>): Promise<T> {
  const drain = store.getStore();
  return drain ? drain.cleanup(fn) : fn();
}
