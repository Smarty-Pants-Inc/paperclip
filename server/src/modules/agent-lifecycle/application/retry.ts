/** An unproven setup-probe retirement retries on the durable retryAt (about
 * 1, 2, 4, 8, 15 min) from transientFailureSince, then parks for Retry. */
export const LIFECYCLE_PROBE_CLEANUP_BOUND_MS = 30 * 60_000;
/** The one true line for native_probe_cleanup_pending, while a retryAt exists. */
export const LIFECYCLE_PROBE_CLEANUP_PENDING_MESSAGE = "The last account test has not confirmed its test computer stopped; Paperclip will retry automatically.";
/** The same line at the park (no retryAt): no "will retry". */
export const LIFECYCLE_PROBE_CLEANUP_PARKED_MESSAGE = "The last account test has not confirmed its test computer stopped. Wait a few minutes, then choose Retry; if it stays stuck, tell your operator.";

/** Saved retries use the shared lifecycle deadline, never a separate timer. */
export function lifecycleRetryDelay(failures: number): number {
  return Math.min(60_000 * 2 ** Math.min(3, Math.max(0, failures - 1)), 300_000);
}

/** Stable, secret-safe diagnostic on a Stop operation awaiting explicit Retry. */
export const LIFECYCLE_STOP_RETRY_REQUIRED = "lifecycle_stop_retry_required";

/** Incomplete host/plugin Stop attempts per operation before explicit Retry. */
export const LIFECYCLE_STOP_FAILURE_LIMIT = 5;
