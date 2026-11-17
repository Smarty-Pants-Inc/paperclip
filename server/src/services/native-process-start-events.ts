export const PROCESS_START_REQUESTED = "native.process_start_requested";
export const PROCESS_IDENTITY_RECORDED = "native.process_identity_recorded";
/** Server-authored: the runner-state fence refused this run before it asked for
 * a runner, because a prior run's saved state could not be proven finished.
 * Both writers (native-session-executor recordPriorOwnerFenceRefusal) throw
 * immediately after recording it, before any launch or attach. */
export const PRIOR_OWNER_FENCE_REFUSED = "native.prior_owner_fence_refused";

/** Server-authored events (no source event ID) that prove a run started its own process. */
export const OWN_PROCESS_START_EVENT_TYPES = [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED] as const;
