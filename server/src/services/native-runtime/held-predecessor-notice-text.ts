// Person-facing Stop / saved-work copy lives here together. A cancelled run
// is not itself a held conversation: only the standing prior-owner notice is.
// Task Retry does not bypass that owner fence, so HELD names only a new task.
export const HELD_PREDECESSOR_NOTICE = "Your message and saved work are kept, but this conversation cannot continue. Assign this agent a new task to continue.";
export const HELD_RECOVERED_WORK_MESSAGE = "Saved work recovered, but this conversation cannot continue. Assign this agent a new task to continue.";
export const STOPPED_TASK_RETRY_MESSAGE = "This task was stopped and its saved work is kept. Press Retry to run it again, or assign this agent a new task.";
// Also used when task Retry's target is closed, unassigned or superseded.
export const STOPPED_TASK_NEW_TASK_MESSAGE = "This task was stopped and its saved work is kept. Assign this agent a new task to continue.";
export const STOP_PROVED_MESSAGE = "The previous execution stopped.";

// A completed recovery pass can also have had nothing to save. Never turn
// that bookkeeping receipt into a claim that this run produced saved work.
export const NO_SAVED_WORK_RETRY_MESSAGE = "This run stopped before any work was saved. Press Retry to start it again.";
export const NO_SAVED_WORK_NEW_TASK_MESSAGE = "This run stopped before any work was saved. Assign this agent a new task to continue.";

// Non-held recovery receipts retain their existing contract.
export const RECOVERED_WORK_RETRY_MESSAGE = "Saved work recovered. Retry continues from it.";
export const RECOVERED_WORK_MESSAGE = "Saved work recovered.";
export const RECOVERED_WORK_CONTINUE_MESSAGE = "Saved work recovered. Send a message to continue.";
