import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { collectSensitiveStringValues, redactSensitiveValueOccurrences } from "../middleware/redact-sensitive.js";
import { REDACTED_EVENT_VALUE, redactSensitiveText } from "../redaction.js";

export interface AdapterTestFailureDiagnostic {
  failureCode: string;
  failureDetail: string;
}

const failures = new WeakMap<Error, AdapterTestFailureDiagnostic>();
const MAX_DETAIL_LENGTH = 2_000;

// Diagnostic prose is not a structured HTTP payload: object-key/Pino path
// redaction cannot see credentials inside message/detail/hint. Keep the existing
// text redactor (Bearer/Basic, JSON, shell assignments and credential shapes),
// and cover provider header, URL and whitespace-assignment formats here, before
// the shared persistence/HTTP/log boundary truncates any field.
function redactAdapterDiagnosticText(input: string): string {
  const withoutHeaders = input.replace(
    /((?<![A-Za-z0-9_-])(?:(?:set-cookie|cookie|proxy-authorization|authorization)["']?[ \t]*[:=][ \t]*|(?:set-cookie|cookie)[ \t]+(?=[A-Za-z0-9_-]+=)|(?:proxy-authorization|authorization)[ \t]+(?=(?:bearer|basic|digest|negotiate|dpop)\b)))[^\r\n]*/gi,
    `$1${REDACTED_EVENT_VALUE}`,
  );
  const withoutUrlCredentials = withoutHeaders
    // Userinfo is private as a whole, including usernames and encoded bytes.
    .replace(/((?:[a-z][a-z\d+.-]*:)?\/\/)[^/\s?#]*@/gi, `$1${REDACTED_EVENT_VALUE}@`)
    .replace(/([?&;])([^=&#\s"'<>]+)=([^&#\s"'<>]*)/g, (match, separator: string, name: string) => {
      let decoded: string;
      try { decoded = decodeURIComponent(name.replaceAll("+", " ")); }
      catch { return `${separator}${name}=${REDACTED_EVENT_VALUE}`; }
      return /password|passwd|secret|token|key|cookie|credential|auth|signature|(?:^|[_-])sig(?:$|[_-])|^x-amz-/i.test(decoded)
        ? `${separator}${name}=${REDACTED_EVENT_VALUE}` : match;
    });
  // Require an identifier start and a real assignment delimiter. In particular,
  // never start halfway through a digit-led product name such as "1Password".
  // Quoted values include whitespace/escaped quotes; an unfinished quote consumes
  // the rest of its line rather than exposing the remainder of that value.
  const withoutAssignments = withoutUrlCredentials.replace(
    /((?<![A-Za-z0-9_.-])(?=[A-Za-z0-9_.-]*(?:password|passwd|secret|token|key|cookie|credential|auth))[A-Za-z_][A-Za-z0-9_.-]*(?:\\?["'])?(?:[ \t]*[=:][ \t]*|[ \t]+))(?:\\["'][^\r\n]*|"(?:\\.|[^"\\\r\n])*(?:"|(?=\r?$))|'(?:\\.|[^'\\\r\n])*(?:'|(?=\r?$))|[^\s;,&#"'`}\])]+)/gim,
    (match, prefix: string, offset: number, source: string) => {
      // Match the shared redactor's treatment of the ordinary noun phrase
      // "bearer authentication", not an assignment. Explicit :/= delimiters
      // and arbitrary auth-named fields still fail closed.
      if (/^(?:authentication|authorization)[ \t]+$/i.test(prefix)
        && /\bbearer[ \t]+$/i.test(source.slice(0, offset))) return match;
      return `${prefix}${REDACTED_EVENT_VALUE}`;
    },
  );
  return redactSensitiveText(withoutAssignments);
}

/** Probe output crosses the same secret boundary in HTTP, lifecycle storage and logs. */
export function redactAdapterTestResult(result: AdapterEnvironmentTestResult, config: Record<string, unknown> = {}): AdapterEnvironmentTestResult {
  // Environment values are private even when their caller-chosen names do not
  // look like credentials. Include nested credential JSON and encoded echoes.
  const sensitive = collectSensitiveStringValues({ ...config, credentials: config.env });
  for (const value of [...sensitive]) {
    try { sensitive.push(...collectSensitiveStringValues({ credentials: JSON.parse(value) })); }
    catch { /* Most environment values are not JSON. */ }
  }
  const text = (value: string) => redactAdapterDiagnosticText(String(redactSensitiveValueOccurrences(value, sensitive))).slice(0, MAX_DETAIL_LENGTH);
  return { ...result, checks: result.checks.map(check => {
    const code = text(check.code);
    return { ...(redactSensitiveValueOccurrences(check, sensitive) as typeof check),
      code: /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(code) ? code : "harness_test_failed",
      level: check.level, message: text(check.message),
      ...(check.detail != null ? { detail: text(check.detail) } : {}),
      ...(check.hint != null ? { hint: text(check.hint) } : {}),
      ...(check.retryable !== undefined ? { retryable: check.retryable } : {}) };
  }) };
}

/** Select the failed check, not an informational prefix such as account metadata. */
export function adapterTestFailureDiagnostic(result: AdapterEnvironmentTestResult): AdapterTestFailureDiagnostic {
  const check = result.checks.find(check => check.level === "error")
    ?? result.checks.find(check => check.level === "warn") ?? result.checks[0];
  return { failureCode: check?.code ?? "harness_test_failed",
    failureDetail: check ? [check.message, check.detail, check.hint].filter(Boolean).join("\n").slice(0, MAX_DETAIL_LENGTH)
      : "The execution test did not pass and returned no diagnostic checks." };
}

/** Preserve owned probe evidence without trusting arbitrary error fields in lifecycle policy. */
export function recordAdapterTestFailure(error: unknown, result: AdapterEnvironmentTestResult, config: Record<string, unknown> = {}): Error {
  const failure = error instanceof Error ? error : new Error("The harness test failed", { cause: error });
  if (!failures.has(failure)) failures.set(failure, adapterTestFailureDiagnostic(redactAdapterTestResult(result, config)));
  return failure;
}

export function readAdapterTestFailure(error: unknown): AdapterTestFailureDiagnostic | undefined {
  return error instanceof Error ? failures.get(error) : undefined;
}

function probeErrorCheck(error: unknown, fallbackCode: string, cleanup = false) {
  const candidate = error as { code?: unknown; details?: { code?: unknown } } | null;
  const message = error instanceof Error ? error.message
    : cleanup && typeof error === "string" ? error : "The adapter environment probe failed.";
  // Runner checkpoint errors historically name their code in the message.
  // Recognize only that narrow convention, and never override an explicit code.
  const code = candidate?.details?.code ?? candidate?.code
    ?? (cleanup ? /^(runner_[A-Za-z0-9_]{1,120})(?=:|$)/.exec(message)?.[1] : undefined);
  return { code: typeof code === "string" ? code : fallbackCode, level: "error" as const, message };
}

/** Only call at the probe boundary, not for authorization, allocation or release errors. */
export function adapterTestErrorResult(adapterType: string, error: unknown, config: Record<string, unknown> = {}): AdapterEnvironmentTestResult {
  return redactAdapterTestResult({ adapterType, status: "fail", testedAt: new Date().toISOString(),
    checks: [probeErrorCheck(error, "adapter_probe_failed")] }, config);
}

/** Normalize teardown causes, not the operation failure or its cleanup-pending wrapper. */
export function adapterTestCleanupErrorResult(adapterType: string, cleanupErrors: readonly unknown[], config: Record<string, unknown> = {}): AdapterEnvironmentTestResult {
  const checks = cleanupErrors.map(error => probeErrorCheck(error, "native_probe_cleanup_failed", true));
  return redactAdapterTestResult({ adapterType, status: "fail", testedAt: new Date().toISOString(),
    checks: checks.length ? checks : [{ code: "native_probe_cleanup_failed", level: "error", message: "Native probe cleanup did not complete." }] }, config);
}
