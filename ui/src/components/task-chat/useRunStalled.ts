import { useEffect, useReducer } from "react";

/**
 * How long a RUNNING turn may show no run event before the thread says so. A run that is working emits events
 * (output, tool calls, status); five minutes with none is not a normal pause.
 */
export const RUN_STALLED_AFTER_MS = 5 * 60_000;

/**
 * THE line a person reads while the run carrying their message has been silent that long (RFL 23:47Z, final
 * words). It promises nothing about the run: only that the message is saved, which stays true if the run is hung.
 * ONE constant: the words change here and nowhere else.
 */
export const RUN_STALLED_LINE = "This is taking longer than usual. Your message is saved.";

/**
 * True once an eligible running turn has had no run event for RUN_STALLED_AFTER_MS since `lastEventAtMs` (the
 * run's last event, or its start when it never had one). A newer event moves `lastEventAtMs`, which retires the
 * line and re-arms the one timer. One timer at the threshold; no per-second ticking.
 */
export function useRunStalled(eligible: boolean, lastEventAtMs: number | null): boolean {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const remainingMs = eligible && lastEventAtMs != null ? RUN_STALLED_AFTER_MS - (Date.now() - lastEventAtMs) : null;
  const pending = remainingMs != null && remainingMs > 0;
  useEffect(() => {
    if (!eligible || lastEventAtMs == null) return;
    const delay = RUN_STALLED_AFTER_MS - (Date.now() - lastEventAtMs);
    if (delay <= 0) return;
    const timer = setTimeout(rerender, delay + 50);
    return () => clearTimeout(timer);
  }, [eligible, lastEventAtMs, pending]);
  return remainingMs != null && remainingMs <= 0;
}
