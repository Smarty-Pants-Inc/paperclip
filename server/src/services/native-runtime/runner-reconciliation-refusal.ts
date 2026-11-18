import { PROVIDER_LAUNCH_PROFILE_MISMATCH, runnerPrepareRefusalCode, runnerReconciliationFailureClass } from "../../vendor/paperclip-runner/index.js";

export function runnerLaunchProfileMismatch(error: unknown): boolean {
  return runnerPrepareRefusalCode(error) === PROVIDER_LAUNCH_PROFILE_MISMATCH;
}

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
] as const;
export type FreshThreadRefusalCode = typeof FRESH_THREAD_REFUSAL_CODES[number];
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

/**
 * J3-22 member (a) (RFL 09:55Z): SMA-60's refused restore on a NEW box. Host
 * preparation on a created box refuses a current backup whose source is not
 * provably retired with this exact code (NSE created branch). It stays a plain
 * member of FRESH_THREAD_REFUSAL_CODES above; this is its OWN predicate, not a
 * set. Its automatic retry already goes fresh for this exact code:
 * fresh-continuation-fallback.ts BACKLOG_CONTINUATION_SOURCE_CODES /
 * heldExecutionWhere select it, and selectPiConversation /
 * selectFreshContinuationThread mint the fresh thread (pi-conversation-record.ts).
 * Member (a) only moves that fresh thread into the run that met the refusal,
 * at the managed backend's open (NSE openSession / recoverSession). A failed
 * workspace restore after it (workspaceRestoreFailure='restore_failed') is that
 * failed run's retained workspace, so (a) covers it.
 */
export const RESTORE_UNAVAILABLE_ON_NEW_BOX_CODE: FreshThreadRefusalCode & "runner_harness_state_mismatch: backup_without_reusable_lease" =
  "runner_harness_state_mismatch: backup_without_reusable_lease";
/** The person-visible, named reason of member (a)'s continuation note. */
export const RESTORE_UNAVAILABLE_ON_NEW_BOX_REASON = "restore_unavailable_on_new_box" as const;

/** Member (a)'s exact code, carried by a structured error or by a recovery
 * result's exact refusal code. Prose never matches; no other code matches. */
export function restoreUnavailableOnNewBoxCode(value: unknown): typeof RESTORE_UNAVAILABLE_ON_NEW_BOX_CODE | null {
  const code = typeof value === "string" ? (isCode(value) ? value : null) : freshThreadRefusalCode(value);
  return code === RESTORE_UNAVAILABLE_ON_NEW_BOX_CODE ? code : null;
}

/**
 * F20 (gate-6 dress): the runner's launch-profile refusal of a box's legacy
 * state on the managed backend's OPEN path (no checkpoint of this run). Taken
 * there only (NSE openSession); never on the recover path.
 */
export const LAUNCH_PROFILE_MISMATCH_CODE: FreshThreadRefusalCode & "native_runner_launch_profile_mismatch" =
  "native_runner_launch_profile_mismatch";
/** The person-visible, named reason of that open's continuation note. */
export const LAUNCH_PROFILE_CHANGED_REASON = "launch_profile_changed" as const;

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
