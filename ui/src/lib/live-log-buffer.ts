/**
 * `appendCapped` ceilings: nothing in a full view is cut, so both are
 * unbounded. Memory is bounded by paging instead (below).
 */
export const MAX_LIVE_LOG_LINES = Number.POSITIVE_INFINITY;
export const MAX_LIVE_EVENTS = Number.POSITIVE_INFINITY;

/**
 * Window bounds for the run log viewer. Older log lines leave browser memory
 * only as recorded saved-log ranges that "Show earlier output" reads back
 * (see run-log-paging.ts), so every line stays reachable.
 */
export const LOG_VIEWER_WINDOW_LINES = 5_000;
export const LOG_VIEWER_WINDOW_UTF16_UNITS = 4_000_000;

/**
 * Initial number of blocks mounted by the live nice view. RunTranscriptView's
 * explicit history control reveals all earlier blocks without discarding them.
 */
export const LIVE_TRANSCRIPT_RENDER_LIMIT = 1_500;

/**
 * Append `additions` to `prev`, dropping the oldest entries so the result never
 * exceeds `max`. Returns `prev` unchanged when there is nothing to add, so React
 * state setters can bail out of a re-render, and never mutates its inputs.
 */
export function appendCapped<T>(prev: T[], additions: readonly T[], max: number): T[] {
  if (additions.length === 0) return prev;
  const next = [...prev, ...additions];
  return next.length > max ? next.slice(next.length - max) : next;
}
