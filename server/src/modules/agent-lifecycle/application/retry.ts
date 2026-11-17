export const LIFECYCLE_ENVIRONMENT_WAIT_MS = 10 * 60_000;
export const LIFECYCLE_ENVIRONMENT_WAIT_MESSAGE = "Waiting for its environment; retrying automatically";

/** Saved retries use the shared lifecycle deadline, never a separate timer. */
export function lifecycleRetryDelay(failures: number, capMs = 300_000): number {
  return Math.min(60_000 * 2 ** Math.min(Math.ceil(Math.log2(capMs / 60_000)), Math.max(0, failures - 1)), capMs);
}

/** Stable, secret-safe diagnostic on a Stop operation awaiting explicit Retry. */
export const LIFECYCLE_STOP_RETRY_REQUIRED = "lifecycle_stop_retry_required";

/** Incomplete host/plugin Stop attempts per operation before explicit Retry. */
export const LIFECYCLE_STOP_FAILURE_LIMIT = 5;
