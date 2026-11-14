import { PROVIDER_LAUNCH_PROFILE_MISMATCH, runnerPrepareRefusalCode, runnerReconciliationFailureClass } from "../../vendor/paperclip-runner/index.js";

export function runnerLaunchProfileMismatch(error: unknown): boolean {
  return runnerPrepareRefusalCode(error) === PROVIDER_LAUNCH_PROFILE_MISMATCH;
}

/** Closed control-plane codes, never matches provider/model diagnostic prose. */
export const FRESH_THREAD_REFUSAL_CODES = [
  "native_controller_recovery_missing_evidence:snapshot_binding",
  "native_controller_recovery_unsupported:metadata_format",
  "runner_remote_state_unavailable",
  "native_runner_refresh_required",
  "native_runner_launch_profile_mismatch",
] as const;
export type FreshThreadRefusalCode = typeof FRESH_THREAD_REFUSAL_CODES[number];
const isCode = (value: unknown): value is FreshThreadRefusalCode =>
  typeof value === "string" && (FRESH_THREAD_REFUSAL_CODES as readonly string[]).includes(value);

export function freshThreadRefusalCode(error: unknown, depth = 0): FreshThreadRefusalCode | null {
  if (!error || typeof error !== "object" || depth > 5) return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (isCode(value.code)) return value.code;
  const failureClass = runnerReconciliationFailureClass(error);
  if (failureClass === "provider_refresh_required") return "native_runner_refresh_required";
  if (failureClass === PROVIDER_LAUNCH_PROFILE_MISMATCH) return "native_runner_launch_profile_mismatch";
  return freshThreadRefusalCode(value.cause, depth + 1);
}

export function isFreshThreadRefusal(run: { errorCode?: string | null; resultJson?: Record<string, unknown> | null }): boolean {
  return isCode(run.errorCode) || isCode((run.resultJson?.nativeFreshContinuationRefusal as { code?: unknown } | undefined)?.code);
}

export function nativeReconciliationError(code: string, options?: ErrorOptions): Error & { code: string } {
  return Object.assign(new Error(code, options), { code });
}
