// The person reads one text for a refused conversation, owned by the durable
// held-conversation notice: HELD_PREDECESSOR_NOTICE. It is imported from its
// dependency-free leaf, never from native-session-executor.ts, which imports
// modules that import this one. This module only recognises runs from before
// that notice existed.
import { HELD_PREDECESSOR_NOTICE } from "./native-runtime/held-predecessor-notice-text.js";
import { isFreshThreadRefusal } from "./native-runtime/runner-reconciliation-refusal.js";
import { REMOTE_RUNNER_SUPERVISION_EXHAUSTED, REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION } from "./native-runtime/remote-runner-recovery-diagnostics.js";

/** The action shown for a refused conversation: the held notice's one wording. */
export const NATIVE_CONTINUATION_REFUSED_ACTION = HELD_PREDECESSOR_NOTICE;

// Saved as the run error or errorCode by native controller recovery and the
// Runner when a conversation's prior owner cannot be proven gone or its saved
// controller state cannot be read. Each fails the same way on every later
// message:
// - a retained sandbox whose binding cannot be proven;
// - a saved controller format outside the D10 fresh-history family;
// - a completed turn whose cleanup is quarantined;
// - a Runner process whose termination was never confirmed;
// - a warm attachment whose Runner exited;
// - any prior-owner identity refusal, current or legacy (terminal state
//   indeterminate, still active, scope mismatch, ...). These are the same
//   prefixes the executor holds behind its notice (HELD_PREDECESSOR_REFUSAL).
const REFUSAL = new RegExp("(?:^|[\\s:])(?:"
  + "native_controller_recovery_missing_evidence:retained_sandbox_binding\\b"
  + "|native_controller_recovery_unsupported:\\S"
  + "|native_session_cleanup_quarantined\\b"
  + "|runner_process_termination_unconfirmed\\b"
  + "|native_runner_warm_attachment_runner_exited\\b"
  + "|runner_state_identity_mismatch: (?:legacy_)?prior_owner_\\w"
  + ")");

/**
 * Fallback for runs saved before the held-conversation notice: true when the
 * run's own error or errorCode says its conversation cannot be continued by
 * another message. The no-replay hold code
 * (native_continuation_requires_reconciliation) alone is not a refusal: an
 * ordinary recovered hold with that code does continue on the next message.
 */
export function isNativeContinuationRefusal(
  run: { error?: string | null; errorCode?: string | null; resultJson?: Record<string, unknown> | null } | null | undefined,
): boolean {
  // D10 has an automatic, physically fenced end. A broader legacy permanent
  // refusal must not hide that owner or turn its next message into a dead end.
  if (run && isFreshThreadRefusal(run)) return false;
  return [run?.error, run?.errorCode].some(value => typeof value === "string" && REFUSAL.test(value)
    && !isRecoverableNativeSupervisionFailure(value));
}

/** Old persisted supervision loss is not permanent identity incompatibility.
 * This only admits recovery, never the old process: heartbeat admission
 * fences API writes and abandons the workspace epoch before a new root runs.
 * Check each field independently so a separate prior-owner refusal still wins.
 */
export function isRecoverableNativeSupervisionFailure(value: string): boolean {
  const unwrapped = value.replace(/^(?:Error: |RemoteRunnerSupervisionExhaustedError: )?(?:Notification transport failed closed: )?(?:runner_process_termination_unconfirmed: runnerd process supervision failed: )?/, "");
  if (unwrapped === REMOTE_RUNNER_SUPERVISION_EXHAUSTED
    || unwrapped === `${REMOTE_RUNNER_SUPERVISION_EXHAUSTED}: ${REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION}`) return true;
  // Every alternative ends at the token's end, not just at its prefix. An
  // independent ownership refusal in this SAME field must still refuse.
  return /^(?:Error: )?(?:Notification transport failed closed: )?runner_process_termination_unconfirmed: runnerd process supervision failed: (?:boat_command_possibly_ran: unavailable|Boat POST \/sandboxes\/\{sandboxId\}\/commands failed \(unavailable\): result_unconfirmed, evidence=unknown \(possibly ran\))$/.test(value);
}
