// Verbatim consumer regression fixture; no plugin implementation is used.
// environment-runtime.d2badcf4.ts:820-838 (supplied F-04B input).
// Input SHA-256: 4c3e9dd4bbe91f51b6f0b2cbad58c5253bb21dc321733643f4ce7566e26f6a82
// State-transition helper verbatim from frozen8 server reusable-sandbox-resume-replacement.ts.
export function sandboxStateTransitionFailure(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth++) {
    const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    if (/state change in progress|\bis still [a-z_]+ at its start deadline\b/i.test(message)) return true;
  }
  return false;
}

export function transientSandboxResumeFailure(error: unknown): boolean {
  const candidate = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const status = typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : null;
  if (status === 429 || (status !== null && status >= 500)) return true;
  // A sandbox still stopping, archiving, or starting can be started shortly.
  if (sandboxStateTransitionFailure(error)) return true;
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : "";
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH"].includes(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /\b(timeout|timed out|rate limit|temporar|network|connection reset|service unavailable)\b/.test(message);
}
