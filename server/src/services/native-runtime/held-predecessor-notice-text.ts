export const HELD_PREDECESSOR_NOTICE = "Your message and saved work are kept, but the previous run of this conversation did not finish. Send a new message to try again.";
/** SCREEN row 3 (RFL 06:40Z): a message held behind a PERSON's Stop. It is not a
 * failed run, and "send a new message to try again" would invite a retype that
 * gets answered twice (the held one is sent right after the next message).
 * Both the sweep (recovery/unanswered-person-message.ts) and the executor's
 * held-predecessor writer (S6) use it. */
export const PERSON_STOP_HELD_MESSAGE_TEXT =
  "Stopped. This message is waiting and will be sent when you send your next message. Send it now, or delete it.";
export const PERSON_STOP_HELD_MESSAGE_TITLE = "Stopped: your message is waiting";
export const PERSON_STOP_HELD_MESSAGE_NEXT_ACTION = "Send it now, or delete it.";
