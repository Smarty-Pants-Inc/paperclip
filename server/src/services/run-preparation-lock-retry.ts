import { isTransientLockContention } from "./transient-lock-contention.js";

/** Fork runtime-MCP preparation policy; keep upstream's generic retry helper unchanged. */
export async function retryRunPreparationLockContention<T>(
  write: () => Promise<T>,
  attempts = 5,
  options: {
    jitterMs?: number | ((attempt: number) => number);
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= attempts || !isTransientLockContention(error)) throw error;
      const jitterMs = typeof options.jitterMs === "function" ? options.jitterMs(attempt) : options.jitterMs ?? 0;
      const delayMs = 100 * attempt + Math.floor(Math.random() * Math.max(0, jitterMs));
      options.onRetry?.(error, attempt, delayMs);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}
