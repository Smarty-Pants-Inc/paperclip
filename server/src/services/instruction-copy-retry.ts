/** One durable age-based retry policy for pending collection and held saves. */
export const INSTRUCTION_COPY_RETRY_MS = 30_000;
export const INSTRUCTION_COPY_MAX_RETRY_MS = 6 * 60 * 60_000;

export function instructionCopyRetryAt(waitingSince: Date, now = Date.now()) {
  const waited = Math.max(0, now - waitingSince.getTime());
  return new Date(now + Math.min(INSTRUCTION_COPY_MAX_RETRY_MS, Math.max(INSTRUCTION_COPY_RETRY_MS, Math.floor(waited / 2))));
}
