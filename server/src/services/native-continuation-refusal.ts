// The person reads one text for a refused conversation, owned by the durable
// held-conversation notice: HELD_PREDECESSOR_NOTICE in
// native-runtime/native-session-executor.ts. This module only recognises runs
// from before that notice existed.

// Saved as the run error or errorCode by native controller recovery and the
// Runner when a conversation's prior owner cannot be proven gone or its saved
// controller state cannot be read. Each fails the same way on every later
// message:
// - a retained sandbox whose binding cannot be proven;
// - a saved controller format this release cannot read;
// - a completed turn whose cleanup is quarantined;
// - a Runner process whose termination was never confirmed;
// - a prior owner whose terminal state is indeterminate.
const REFUSAL = new RegExp("(?:^|[\\s:])(?:"
  + "native_controller_recovery_missing_evidence:retained_sandbox_binding\\b"
  + "|native_controller_recovery_unsupported:\\S"
  + "|native_session_cleanup_quarantined\\b"
  + "|runner_process_termination_unconfirmed\\b"
  + "|runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate\\b"
  + ")");

/**
 * Fallback for runs saved before the held-conversation notice: true when the
 * run's own error or errorCode says its conversation cannot be continued by
 * another message. The no-replay hold code
 * (native_continuation_requires_reconciliation) alone is not a refusal: an
 * ordinary recovered hold with that code does continue on the next message.
 */
export function isNativeContinuationRefusal(
  run: { error?: string | null; errorCode?: string | null } | null | undefined,
): boolean {
  return [run?.error, run?.errorCode].some(value => typeof value === "string" && REFUSAL.test(value));
}
