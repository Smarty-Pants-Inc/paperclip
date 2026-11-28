import { classifyError, errorRetryAfterMs } from "@/api/errors";

export const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15_000;
const TRANSCRIPT_REQUEST_RETRY_MS = 2_000;

/** Bound history reads, including body consumption, and release coalesced GETs
 * on timeout so Retry starts a fresh request. Late responses cannot commit. */
export function readTranscriptRequest<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("History read cancelled", "AbortError"));
  const deadline = performance.now() + TRANSCRIPT_REQUEST_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let retried = false;
    let firstError: unknown;
    let retryTimer: number | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.clearTimeout(retryTimer);
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => {
      finish(() => reject(new DOMException("History read cancelled", "AbortError")));
      controller.abort();
    };
    const timer = window.setTimeout(() => {
      finish(() => reject(retried ? firstError : new Error("Run history took too long to load. Retry to load it.")));
      controller.abort();
    }, TRANSCRIPT_REQUEST_TIMEOUT_MS);
    signal.addEventListener("abort", onAbort, { once: true });
    const onError = (error: unknown) => {
      if (settled) return;
      const kind = classifyError(error);
      if (!retried && (kind === "transient" || kind === "aborted")) {
        const wait = Math.max(
          TRANSCRIPT_REQUEST_RETRY_MS,
          errorRetryAfterMs(error) ?? 0,
        );
        if (performance.now() + wait >= deadline) {
          finish(() => reject(error));
          return;
        }
        firstError = error;
        retried = true;
        retryTimer = window.setTimeout(read, wait);
      } else {
        finish(() => reject(error));
      }
    };
    const read = () => {
      if (settled) return;
      try {
        request(controller.signal).then(
          (value) => finish(() => resolve(value)),
          onError,
        );
      } catch (error) {
        onError(error);
      }
    };
    read();
  });
}
