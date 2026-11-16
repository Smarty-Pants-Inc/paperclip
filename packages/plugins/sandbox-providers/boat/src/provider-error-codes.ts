// Closed errno-style codes the SDK's providerErrorDiagnostic forwards across the
// worker boundary (packages/plugins/sdk/src/environment-resume-error.ts ERROR_CODES).
// Only one of these exact strings may be copied from a transport failure; its
// text, address, syscall and the failure object itself are never retained.
export const TRANSPORT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH",
  "ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

function own(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}

/** The first closed errno on the error or its causes (depth 4, as the SDK reads). */
export function closedTransportCode(error: unknown): string | undefined {
  for (let cause = error, depth = 0; cause && depth < 4; cause = own(cause, "cause"), depth++) {
    const code = own(cause, "code");
    if (typeof code === "string" && TRANSPORT_ERROR_CODES.has(code)) return code;
  }
  return undefined;
}

/** True when the failure is our own AbortSignal.timeout deadline firing. */
export function isOwnDeadline(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted && own(signal.reason, "name") === "TimeoutError") return true;
  for (let cause = error, depth = 0; cause && depth < 4; cause = own(cause, "cause"), depth++) {
    if (own(cause, "name") === "TimeoutError") return true;
  }
  return false;
}

/**
 * Words the server's resume retry recognises (server/src/services/environment-runtime.ts
 * transientSandboxResumeFailure reads message text only; `\bnetwork\b` does not
 * match `network_error`). Present only for a transient status or errno.
 */
export function transientWords(httpStatus: number | null, code: string | undefined): string | undefined {
  if (httpStatus === 408 || httpStatus === 504) return "timeout";
  if (httpStatus === 429) return "rate limit";
  if (httpStatus === 425 || httpStatus === 500 || httpStatus === 502 || httpStatus === 503) return "service unavailable";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE" || code === "EAI_AGAIN"
    || code === "ENETUNREACH" || code === "UND_ERR_SOCKET") return "network error";
  return undefined;
}
