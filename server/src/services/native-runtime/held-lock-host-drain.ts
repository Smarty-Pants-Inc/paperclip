import type { Db } from "@paperclipai/db";
import {
  createHostMutationDrain,
  currentHostMutationDrain,
  HOST_MUTATION_DRAIN_CAP_MS,
  withHostMutationDrain,
  type HostMutationDrain,
} from "@paperclipai/adapter-utils/host-mutation-drain";
import { logger } from "../../middleware/logger.js";
import { withWorkspaceLockKeepalive } from "./native-workspace-lock-keepalive.js";

export { currentHostMutationDrain };

/**
 * pl/keepalive6: ONE mechanism for every held advisory lock with a keepalive.
 *
 * - The lock's work runs under its own host-mutation gate, JOINED to the gate
 *   of any held lock it runs inside (`parent`, captured by the caller before it
 *   opened its lock connection). So an OUTER loss stops the inner host writes,
 *   and the outer drain also waits for them.
 * - A lost lock (keepalive onLost) closes the gate: no new host write starts
 *   (`hostMutation` is refused) and `signal` aborts with the typed lost error.
 * - Before the lock is released (this returns, so the lock transaction ends)
 *   after any loss, the in-flight host calls are drained: up to the cap, then a
 *   true logged line, and the lock is still held until the call returns.
 * - A lost lock is never reported as success.
 * Timeout 0 (no keepalive): onLost never fires; nothing closes unless an outer
 * lock is lost, so behaviour is unchanged.
 */
export async function withHeldLockHostDrain<T>(input: {
  lock: Pick<Db, "execute">;
  idleTimeoutMs: number;
  parent?: HostMutationDrain;
  lostError: (cause: unknown) => Error;
  label: string;
  capMs?: number;
}, work: (signal: AbortSignal, gate: HostMutationDrain) => Promise<T>): Promise<T> {
  const own = createHostMutationDrain();
  let gate: HostMutationDrain = own;
  // The drain runs INSIDE the keepalive: the lock session keeps pinging (and so keeps the lock) while the
  // in-flight host calls finish; only then does the lock transaction end and the next owner get in.
  return withWorkspaceLockKeepalive(input.lock, input.idleTimeoutMs, async () => {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      const value = await withHostMutationDrain(own, async () => {
        gate = currentHostMutationDrain() ?? own;
        gate.signal.throwIfAborted();
        return work(gate.signal, gate);
      }, input.parent);
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
    }
    if (gate.signal.aborted) {
      // Lost (this lock or an outer one): stop new writes, then await the in-flight
      // host calls BEFORE the lock is released.
      const capMs = input.capMs ?? HOST_MUTATION_DRAIN_CAP_MS;
      const drained = await own.closeAndDrain(capMs, gate.signal.reason);
      if (!drained.drained) {
        logger.warn({ lock: input.label, inFlight: drained.inFlight, capMs },
          `${input.label}: the lock was lost and a host write has not finished after ${Math.round(capMs / 1000)} s; the lock is kept until it returns`);
        await own.drained();
      }
      if (outcome.ok || !(outcome.error instanceof Error && outcome.error.name.endsWith("LockLostError"))) {
        gate.signal.throwIfAborted();
      }
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }, { onLost: cause => own.close(input.lostError(cause)) });
}
