/**
 * What a person reads when a chat's saved work was recovered but its
 * conversation was refused: native controller recovery could not prove the
 * retained source, so a new message is refused the same way again. The files
 * are kept; only a new task continues the work.
 */
export const NATIVE_CONTINUATION_REFUSED_ACTION =
  "Your saved work is kept, but this conversation cannot continue. Assign this agent a new task to continue.";

// Thrown by native controller recovery (native-controller-recovery.ts and
// native-session-executor.ts) and saved as the run error. A retained sandbox
// whose binding cannot be proven, and a saved controller format this release
// cannot read, both fail the same way on every later message.
const REFUSAL_ERROR = /(?:^|[\s:])native_controller_recovery_(?:missing_evidence:retained_sandbox_binding\b|unsupported:\S)/;

/**
 * True when the run's own error says its conversation cannot be continued by
 * another message. The no-replay hold code
 * (native_continuation_requires_reconciliation) alone is not a refusal: an
 * ordinary recovered hold with that code does continue on the next message.
 */
export function isNativeContinuationRefusal(run: { error?: string | null } | null | undefined): boolean {
  return typeof run?.error === "string" && REFUSAL_ERROR.test(run.error);
}
