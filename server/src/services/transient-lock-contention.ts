export const TRANSIENT_LOCK_CONTENTION_CODES: ReadonlySet<string> = new Set(["55P03", "40P01", "40001"]);

export function postgresErrorCode(error: unknown): string | null {
  for (let value = error, depth = 0; value && typeof value === "object" && depth < 4; depth += 1) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    value = (value as { cause?: unknown }).cause;
  }
  return null;
}

export function isTransientLockContention(error: unknown): boolean {
  const code = postgresErrorCode(error);
  return code !== null && TRANSIENT_LOCK_CONTENTION_CODES.has(code);
}

export async function retryTransientLockContention<T>(
  write: () => Promise<T>,
  attempts = 5,
  options: { shouldRetry?: (error: unknown) => boolean; backoffMs?: (attempt: number) => number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= attempts || !(options.shouldRetry ?? isTransientLockContention)(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, options.backoffMs?.(attempt) ?? 100 * attempt));
    }
  }
}
