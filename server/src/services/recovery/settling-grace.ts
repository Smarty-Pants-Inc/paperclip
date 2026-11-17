/** How long a just-finished run may still be settling (retry scheduling,
 * claim release) before its task is judged. A re-check follows at the end.
 *
 * A leaf module (no imports): agent-conversations.ts reads it, and importing
 * it through assigned-work-invariant.ts closed an eager ESM cycle
 * (assigned-work-invariant -> execution-recovery-attempt -> run-dispatch ->
 * ... -> agent-conversations) that left SERVER_RESTART_RETRY_MAX_ATTEMPTS in
 * its temporal dead zone for an unbundled Node/tsx controller. */
export const SETTLING_GRACE_MS = 90_000;
