/** Saved retries use the shared lifecycle deadline, never a separate timer. */
export function lifecycleRetryDelay(failures: number): number {
  return Math.min(60_000 * 2 ** Math.min(3, Math.max(0, failures - 1)), 300_000);
}

/** Incomplete host/plugin Stop attempts per operation before explicit Retry. */
export const LIFECYCLE_STOP_FAILURE_LIMIT = 5;
