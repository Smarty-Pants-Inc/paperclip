const HELD_PREDECESSOR_STATE = "Your message and saved work are kept, but the previous run of this conversation did not finish.";
/** The held banner's default remedy: a new task for this agent works in every held state. */
export const HELD_PREDECESSOR_NEW_TASK_ACTION = "Assign this agent a new task to continue.";
/** Only where the comment route's own admission would admit a new message (held-conversation-remedy.ts). */
export const HELD_PREDECESSOR_SEND_ACTION = "Send a new message to try again.";
export const HELD_PREDECESSOR_NOTICE = `${HELD_PREDECESSOR_STATE} ${HELD_PREDECESSOR_NEW_TASK_ACTION}`;
export const HELD_PREDECESSOR_SEND_NOTICE = `${HELD_PREDECESSOR_STATE} ${HELD_PREDECESSOR_SEND_ACTION}`;
