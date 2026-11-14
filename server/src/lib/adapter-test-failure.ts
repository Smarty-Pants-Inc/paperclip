import type { AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { collectSensitiveStringValues, redactSensitiveValueOccurrences } from "../middleware/redact-sensitive.js";
import { redactSensitiveText } from "../redaction.js";

export interface AdapterTestFailureDiagnostic {
  failureCode: string;
  failureDetail: string;
}

const failures = new WeakMap<Error, AdapterTestFailureDiagnostic>();
const MAX_DETAIL_LENGTH = 2_000;

/** Probe output crosses the same secret boundary in HTTP, lifecycle storage and logs. */
export function redactAdapterTestResult(result: AdapterEnvironmentTestResult, config: Record<string, unknown> = {}): AdapterEnvironmentTestResult {
  // Environment values are private even when their caller-chosen names do not
  // look like credentials. Include nested credential JSON and encoded echoes.
  const sensitive = collectSensitiveStringValues({ ...config, credentials: config.env });
  for (const value of [...sensitive]) {
    try { sensitive.push(...collectSensitiveStringValues({ credentials: JSON.parse(value) })); }
    catch { /* Most environment values are not JSON. */ }
  }
  const text = (value: string) => redactSensitiveText(String(redactSensitiveValueOccurrences(value, sensitive))).slice(0, MAX_DETAIL_LENGTH);
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
