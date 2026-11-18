import { setTimeout } from "node:timers/promises";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

/**
 * Keeps an advisory-lock transaction from being cut by
 * idle_in_transaction_session_timeout while `work` runs.
 *
 * pl/lockloss: a failed keepalive ping means the lock session is gone (the
 * timeout or pg_terminate_backend ended it) and the advisory lock with it.
 * It is no longer swallowed: `onLost` is told once, so work that opted in
 * stops instead of writing on after another owner may hold the lock.
 */
export async function withWorkspaceLockKeepalive<T>(
  lock: Pick<Db, "execute">,
  idleTimeoutMs: number,
  work: () => Promise<T>,
  options?: { onLost?: (cause: unknown) => void },
): Promise<T> {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return work();
  const stop = new AbortController();
  const interval = Math.max(1, Math.min(30_000, Math.floor(idleTimeoutMs / 3)));
  const keeper = (async () => {
    while (!stop.signal.aborted) {
      await setTimeout(interval, undefined, { signal: stop.signal, ref: false });
      await lock.execute(sql`select 1`);
    }
  })().catch((cause) => {
    // The sleep rejects when `work` finished (stop aborted): not a loss.
    if (!stop.signal.aborted) options?.onLost?.(cause);
  });
  try {
    return await work();
  } finally {
    stop.abort();
    await keeper;
  }
}
