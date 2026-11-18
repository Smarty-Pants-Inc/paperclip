const HELD_PREDECESSOR_STATE = "Your message and saved work are kept, but the previous run of this conversation did not finish.";
/** The held banner's default remedy: a new task for this agent works in every held state. */
export const HELD_PREDECESSOR_NEW_TASK_ACTION = "Assign this agent a new task to continue.";
/** Only where the comment route's own admission would admit a new message (held-conversation-remedy.ts).
 * A posted notice is never refreshed, so the Send remedy carries its own hedge:
 * it stays true when a later hold defers the new message. */
export const HELD_PREDECESSOR_SEND_ACTION = "Send a new message to try again; if it doesn't start, assign this agent a new task.";
export const HELD_PREDECESSOR_NOTICE = `${HELD_PREDECESSOR_STATE} ${HELD_PREDECESSOR_NEW_TASK_ACTION}`;
export const HELD_PREDECESSOR_SEND_NOTICE = `${HELD_PREDECESSOR_STATE} ${HELD_PREDECESSOR_SEND_ACTION}`;
/** SCREEN row 3 (RFL 06:40Z): a message held behind a PERSON's Stop. It is not a
 * failed run, and "send a new message to try again" would invite a retype that
 * gets answered twice (the held one is sent right after the next message).
 * Both the sweep (recovery/unanswered-person-message.ts) and the executor's
 * held-predecessor writer (S6) use it. */
export const PERSON_STOP_HELD_MESSAGE_TEXT =
  "Stopped. This message is waiting: Send it, or delete it.";
export const PERSON_STOP_HELD_MESSAGE_TITLE = "Stopped: your message is waiting";
export const PERSON_STOP_HELD_MESSAGE_NEXT_ACTION = "Send it, or delete it.";
