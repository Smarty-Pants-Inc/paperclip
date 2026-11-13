/**
 * Bounded retry for transaction OWNERS whose work is database-only.
 *
 * A deadlock (40P01) or serialization failure (40001) aborts and rolls back the
 * whole transaction, so re-running the owner's `db.transaction(...)` starts from
 * a clean slate. Never wrap a body that performs an external effect (filesystem,
 * object storage, provider or network call) before commit, and never retry from
 * inside an aborted transaction: callers pass a function that opens a NEW
 * transaction on each attempt.
 */
export const TRANSACTION_RETRY_ATTEMPTS = 3;

/** True when the error (or a wrapped cause, as drizzle wraps pg errors) is 40P01 or 40001. */
export function isRetryableTransactionError(error: unknown): boolean {
  for (let e = error as { code?: unknown; cause?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (e.code === "40P01" || e.code === "40001") return true;
  }
  return false;
}

/** Process-wide count of retried 40P01/40001 failures (observability and tests). */
export const transactionRetryStats = { retried: 0 };

export async function withTransactionRetry<T>(run: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= TRANSACTION_RETRY_ATTEMPTS || !isRetryableTransactionError(error)) throw error;
      transactionRetryStats.retried++;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt + Math.floor(Math.random() * 50)));
    }
  }
}
