// Small, shared domain values for the wake-queue module: string readers, the
// two failed-run codes, and the recovery retry reason they gate. The
// application and adapter layers both need these, so they live here once
// instead of twice.

export function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function parseObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The release drain's deferred wake status: the wake-queue drain reads its
 * next wake with this status (adapters/postgres.ts findNextDeferredWake). */
export const DEFERRED_WAKE_STATUS = "deferred_issue_execution";
/** The deferred wakes a person's Stop can hold (acknowledged-native-stop
 * readPersonStopHold): the drain's status, and a 'deferred' row WHATEVER its
 * wait text (RFL ruling (a)); held only when (a)-(c) hold for its messages. */
export const PERSON_STOP_HOLDABLE_WAKE_STATUSES: readonly string[] = [DEFERRED_WAKE_STATUS, "deferred"];

export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";
export const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";
export const EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON = "execution_review_participant_recovery";

export function isWorkspaceValidationFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE;
}

export function isConfigurationIncompleteFailedRun(run: { errorCode: string | null }): boolean {
  return run.errorCode === CONFIGURATION_INCOMPLETE_FAILURE_CODE || run.errorCode === "model_not_found" ||
    run.errorCode === "native_provider_model_rejected";
}
