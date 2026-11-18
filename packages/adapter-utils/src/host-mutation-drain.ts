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
 * - `defer(fn)` (via `hostDeferredCleanup`): REGISTERS this work's own
 *   cleanup (its private snapshot/temp dirs, its uniquely named temporaries,
 *   its merge lock: owner sidecar + SQLite lock) and returns an idempotent
 *   runner. The work calls the runner from its finally as before; if the drain
 *   closes first, the DRAIN runs it, and the work's late call is a no-op.
 * - `close(reason)`: no new `run` starts, the drain's `signal` aborts (with
 *   `reason`), and the drain starts closing: it awaits the in-flight host fs
 *   calls (never remote I/O), then runs the outstanding registered cleanups
 *   itself (tracked, LIFO), and only then is drained. Idempotent.
 * - `signal`: aborted once this drain, or an outer drain it is joined to,
 *   closes (pl/keepalive6).
 * - `closeAndDrain(capMs)`: close, then wait until that closing finished or
 *   `capMs` passes. Returns `{ drained: true }` or `{ drained: false, inFlight }`.
 *   `drained()` waits without a cap (once closed: for the whole closing,
 *   including the registered cleanups).
 *
 * The owner releases its ownership only after `closeAndDrain` (and, past the
 * cap, after `drained()`), so no host write of the old owner can land after
 * the next owner is admitted, on any branch (mkdir/rename/symlink/copy/rm/git).
 * Remote (box) I/O is NOT tracked: it is abandoned at the deadline.
 *
 * The current drain is carried by AsyncLocalStorage, so nested/inner work
 * started inside the owner's callback takes the outer drain automatically.
 * Outside any drain, `hostMutation(fn)` is just `fn()`.
 *
 * Joined drains (pl/keepalive6, one mechanism with the above): an inner owner
 * that runs inside an outer owner (e.g. a lifecycle lock taken inside a held
 * source lock) runs under `joinHostMutationDrains(outer, inner)` (or
 * `withHostMutationDrain(inner, fn, outer)`). Its host mutations are refused
 * once EITHER drain is closed and are counted in flight by BOTH; its
 * registered cleanups are registered with BOTH, so whichever drain closes
 * first runs them, and the outer drain's closing waits for them too.
 */
export class HostMutationRefusedError extends Error {
  readonly code = "HOST_MUTATION_REFUSED";
  constructor(reason?: unknown) {
    super("host_mutation_refused_after_owner_abort", reason === undefined ? undefined : { cause: reason });
  }
}

export type HostMutationDrain = {
  readonly closed: boolean;
  /** Aborted (with the close reason) once this gate, or an outer gate it is joined to, closes. */
  readonly signal: AbortSignal;
  readonly inFlight: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
  cleanup<T>(fn: () => Promise<T>): Promise<T>;
  defer(fn: () => Promise<void>): HostCleanupHandle;
  close(reason?: unknown): void;
  closeAndDrain(capMs: number, reason?: unknown): Promise<{ drained: true } | { drained: false; inFlight: number }>;
  drained(): Promise<void>;
};

/** adopt-drain4: an idempotent runner for a registered cleanup. Every call
 * returns the same promise; the first call (by the work's finally, or by the
 * closing drain) runs the cleanup. */
export type HostCleanupHandle = () => Promise<void>;

/** The default cap on how long an owner waits for in-flight host calls before
 * it reports that a host write is stuck (it still keeps ownership until the
 * call returns). */
export const HOST_MUTATION_DRAIN_CAP_MS = 10_000;

export function createHostMutationDrain(): HostMutationDrain {
  let closed = false;
  let closeReason: unknown;
  let inFlight = 0;
  let finished = false;
  let closing: Promise<void> | undefined;
  let waiters: Array<() => void> = [];
  const gate = new AbortController();
  // Registered cleanups not yet started, in registration order.
  const pending = new Set<HostCleanupHandle>();
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
  const idle = () => inFlight === 0 ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push(resolve); });
  const drain: HostMutationDrain = {
    get closed() { return closed; },
    get inFlight() { return inFlight; },
    signal: gate.signal,
    run(fn) {
      if (closed) return Promise.reject(new HostMutationRefusedError(closeReason));
      return track(fn);
    },
    cleanup: track,
    defer(fn) {
      let started: Promise<void> | undefined;
      // Registered after the drain finished closing: nothing of this work can
      // have been created through the drain since (every host mutation is
      // refused), so this only releases non-host state; it runs untracked.
      if (finished) return () => (started ??= Promise.resolve().then(fn));
      const handle: HostCleanupHandle = () => {
        if (!started) { pending.delete(handle); started = track(fn); }
        return started;
      };
      pending.add(handle);
      return handle;
    },
    close(reason) {
      if (closed) return;
      closed = true;
      closeReason = reason;
      closing = (async () => {
        while (true) {
          // 1. the in-flight host fs calls (never remote I/O) return.
          await idle();
          // Let the continuations of the calls that just returned register
          // what they created (they run before the next macrotask).
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (inFlight > 0) continue;
          if (pending.size === 0) break;
          // 2. the drain itself runs the outstanding registered cleanups
          // (innermost first), as tracked host mutations of this owner.
          for (const handle of [...pending].reverse()) {
            await store.run(drain, handle).catch(() => undefined);
          }
        }
        finished = true;
      })();
      // After `closing` exists: an abort listener may call closeAndDrain /
      // drained / defer synchronously; a cleanup it registers is picked up.
      gate.abort(reason ?? new HostMutationRefusedError());
    },
    async closeAndDrain(capMs, reason) {
      drain.close(reason);
      if (finished) return { drained: true };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const capped = await Promise.race([
        closing!.then(() => false),
        new Promise<true>((resolve) => { timer = setTimeout(() => resolve(true), capMs); }),
      ]);
      if (timer) clearTimeout(timer);
      return capped && !finished ? { drained: false, inFlight: Math.max(inFlight, 1) } : { drained: true };
    },
    drained() { return closing ?? idle(); },
  };
  return drain;
}

// One store per process even if this module is loaded twice (src + dist).
const STORE_KEY = Symbol.for("paperclip.adapter-utils.host-mutation-drain");
const store: AsyncLocalStorage<HostMutationDrain> =
  ((globalThis as Record<symbol, unknown>)[STORE_KEY] as AsyncLocalStorage<HostMutationDrain> | undefined)
  ?? ((globalThis as Record<symbol, unknown>)[STORE_KEY] = new AsyncLocalStorage<HostMutationDrain>()) as AsyncLocalStorage<HostMutationDrain>;

/**
 * pl/keepalive6 + adopt-drain4: an inner owner's drain JOINED to the drain of
 * the owner it runs inside. Through the joined view:
 * - `run` is refused once EITHER drain is closed, and is counted in flight by
 *   BOTH (the outer's drain waits for the inner's host writes);
 * - `cleanup` is counted by both;
 * - `defer` registers the cleanup with the inner drain AND with the outer one:
 *   whichever closes first runs it (once; the other awaits the same run), so
 *   the outer's closing also waits for the inner's registered cleanups;
 * - `signal` aborts with whichever drain closes first (AbortSignal.any);
 * - `close`/`closeAndDrain`/`drained` act on the inner drain only.
 */
export function joinHostMutationDrains(outer: HostMutationDrain, inner: HostMutationDrain): HostMutationDrain {
  const signal = AbortSignal.any([outer.signal, inner.signal]);
  const joined: HostMutationDrain = {
    get closed() { return outer.closed || inner.closed; },
    get inFlight() { return inner.inFlight; },
    signal,
    run(fn) {
      if (outer.closed) return outer.run(fn);
      if (inner.closed) return inner.run(fn);
      return outer.run(() => inner.run(fn));
    },
    cleanup: (fn) => outer.cleanup(() => inner.cleanup(fn)),
    defer(fn) {
      const innerHandle = inner.defer(fn);
      // Run by the outer's closing (or the work's late call) under the joined
      // view, so the cleanup's own hostCleanup calls are counted by both.
      return outer.defer(() => store.run(joined, innerHandle));
    },
    close: (reason) => inner.close(reason),
    closeAndDrain: (capMs, reason) => inner.closeAndDrain(capMs, reason),
    drained: () => inner.drained(),
  };
  return joined;
}

/** Run `fn` (and everything it starts) under `drain`. With `parent` (the
 * owner this work runs inside, captured before any connection callback can
 * lose the async context), the drain is joined to it: see joinHostMutationDrains. */
export function withHostMutationDrain<T>(drain: HostMutationDrain, fn: () => Promise<T>, parent?: HostMutationDrain): Promise<T> {
  return store.run(parent && parent !== drain ? joinHostMutationDrains(parent, drain) : drain, fn);
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

/** adopt-drain4: register this work's own cleanup (private snapshot/temp
 * dirs, uniquely named temporaries, its merge lock) with the current owner's
 * drain BEFORE creating what it removes. Returns an idempotent runner: call it
 * from the finally as before. If the owner's drain closes first (deadline,
 * lock loss, action return), the drain runs it after the in-flight host calls
 * returned and before the ownership is released; the late finally call is then
 * a no-op. Outside a drain: a run-once wrapper of `fn`. */
export function hostDeferredCleanup(fn: () => Promise<void>): HostCleanupHandle {
  const drain = store.getStore();
  if (drain) return drain.defer(fn);
  let started: Promise<void> | undefined;
  return () => (started ??= Promise.resolve().then(fn));
}
