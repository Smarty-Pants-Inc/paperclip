import { PROVIDER_LAUNCH_PROFILE_MISMATCH, runnerPrepareRefusalCode, runnerReconciliationFailureClass } from "../../vendor/paperclip-runner/index.js";

export function runnerLaunchProfileMismatch(error: unknown): boolean {
  return runnerPrepareRefusalCode(error) === PROVIDER_LAUNCH_PROFILE_MISMATCH;
}

/** Member (b) of the fresh-thread floor (SMA-66, J3-23). A finished per-turn
 * owner on another, non-active sandbox passed every retirement proof except
 * lifecycle commands (runner.suspend/drain/shutdown) its Runner never
 * acknowledged. That box may still exist, so its thread is never resumed: its
 * root is quarantined and the conversation continues in a fresh thread. The
 * run error keeps the exact upstream refusal text; only `code` carries this. */
export const PRIOR_OWNER_LIFECYCLE_UNSETTLED = "runner_state_identity_mismatch: prior_owner_lifecycle_unsettled";

/** Closed control-plane codes, never matches provider/model diagnostic prose. */
export const FRESH_THREAD_REFUSAL_CODES = [
  "native_controller_recovery_missing_evidence:snapshot_binding",
  "native_controller_recovery_unsupported:metadata_format",
  "runner_remote_state_unavailable",
  "runner_harness_state_mismatch: backup_without_reusable_lease",
  "runner_harness_state_mismatch: resumed_unavailable",
  "native_controller_recovery_missing_evidence:retained_sandbox_binding",
  "native_runner_refresh_required",
  "native_runner_launch_profile_mismatch",
  PRIOR_OWNER_LIFECYCLE_UNSETTLED,
] as const;
export type FreshThreadRefusalCode = typeof FRESH_THREAD_REFUSAL_CODES[number];

/** The floor: members of the closed set above whose fresh thread may start in
 * the SAME run, before any Runner or provider work, instead of failing the run
 * and leaving the fresh thread to the automatic continuation. Only the
 * executor's own admission takes it (it records the fresh thread and the
 * continuation note); everywhere else the member stays an ordinary
 * fresh-thread refusal. Members (a) backup_without_reusable_lease and (c) an
 * unrecorded runner-internal Pi fresh thread join here, each with its RED. */
export const SAME_RUN_FRESH_THREAD_REFUSAL_CODES = [
  PRIOR_OWNER_LIFECYCLE_UNSETTLED,
] as const satisfies readonly FreshThreadRefusalCode[];
export type SameRunFreshThreadRefusalCode = typeof SAME_RUN_FRESH_THREAD_REFUSAL_CODES[number];

/** A typed error whose message stays the exact legacy refusal text. */
export function freshThreadRefusal(code: FreshThreadRefusalCode, message: string): Error & { code: FreshThreadRefusalCode } {
  return Object.assign(new Error(message), { code });
}
const isCode = (value: unknown): value is FreshThreadRefusalCode =>
  typeof value === "string" && (FRESH_THREAD_REFUSAL_CODES as readonly string[]).includes(value);

export function freshThreadRefusalCode(error: unknown, depth = 0): FreshThreadRefusalCode | null {
  if (!error || typeof error !== "object" || depth > 5) return null;
  const value = error as { code?: unknown; cause?: unknown };
  if (isCode(value.code)) return value.code;
  // C1 carries the specific authenticated prepare refusal. Preserve it before
  // the generic refresh class so restoration failures never claim a skill edit.
  const prepareCode = runnerPrepareRefusalCode(error);
  if (isCode(prepareCode)) return prepareCode;
  const failureClass = runnerReconciliationFailureClass(error);
  if (failureClass === "provider_refresh_required") return "native_runner_refresh_required";
  if (failureClass === PROVIDER_LAUNCH_PROFILE_MISMATCH) return "native_runner_launch_profile_mismatch";
  return freshThreadRefusalCode(value.cause, depth + 1);
}

export function isFreshThreadRefusal(run: { errorCode?: string | null; error?: string | null; resultJson?: Record<string, unknown> | null }): boolean {
  // Older controller rows saved the exact reserved code in `error` under the
  // generic reconciliation envelope. They need the SAME strict stop gate,
  // not the generic upstream isolation fallback. Only a whole code is accepted;
  // embedded diagnostic text and provider messages never grant this boundary.
  return isCode(run.errorCode) || isCode(run.error)
    || isCode((run.resultJson?.nativeFreshContinuationRefusal as { code?: unknown } | undefined)?.code);
}

/** Projection only: this receipt never grants admission or proves a stop. */
export const FRESH_THREAD_STOP_STATE_KEY = "nativeFreshContinuationStop";

export function nativeReconciliationError(code: string, options?: ErrorOptions): Error & { code: string } {
  return Object.assign(new Error(code, options), { code });
}
