// Person-facing Stop / saved-work copy lives here together. A cancelled run
// is not itself a held conversation: only the standing prior-owner notice is.
// follow-Paperclip Cut B R8 (PV2, judged): a held notice never withholds
// Retry; Retry rotates a held conversation onto a fresh thread that carries its
// history (retry-fresh). The notice names that same single action, never
// "send a new message" or "assign a new task" beside an offered Retry.
export const HELD_RETRY_ACTION = "Press Retry to continue in a fresh run with this conversation's history.";
// retry-fold6 (rf-3 FAIL 3): the held condition; the instruction after it is the
// one Retry authority's (task-retry-eligibility.ts heldConversationNoticeText).
export const HELD_CONDITION = "Your message and saved work are kept, but the previous run of this conversation did not finish.";
export const HELD_PREDECESSOR_NOTICE = `${HELD_CONDITION} ${HELD_RETRY_ACTION}`;
export const HELD_RECOVERED_WORK_MESSAGE = `Saved work recovered, but the previous run of this conversation did not finish. ${HELD_RETRY_ACTION}`;
// Only where Retry is NOT offered for another reason (Retry's own source check
// refuses, e.g. a managing agent's Stop): the held thread meets the same fence
// on a new message too, so the one action is a new task.
export const HELD_NEW_TASK_MESSAGE = "Your message and saved work are kept, but this conversation cannot continue. Assign this agent a new task to continue.";
export const HELD_RECOVERED_NEW_TASK_MESSAGE = "Saved work recovered, but this conversation cannot continue. Assign this agent a new task to continue.";
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

// Retry fold (one authority, task-retry-eligibility.ts decideRetryAuthority):
// every person-facing Retry instruction below is chosen there, once, for the
// card, the transcript note and the structured Next action together.
/** The one action in every HELD / new-task text above (exact substring). */
export const NEW_TASK_ACTION = "Assign this agent a new task to continue.";
export const AGENT_PAUSED_ACTION = "Resume this agent to continue.";
export const AGENT_PAUSED_RETRY_MESSAGE = "This agent is paused. Resume this agent to continue. Your message and saved work are kept.";
// Judge R9 / R15: the words the transcript already says for a fresh
// continuation (execution-projection.ts reads this constant through the
// authority); a status, not an instruction, so the decision names no action.
export const AUTOMATIC_RECOVERY_MESSAGE = "Paperclip continues the task in a fresh run from its saved work.";
// stoppending-retry3's strings (task-retry-stop-gate.ts re-exports them).
export const RETRY_STOP_WAIT_ACTION = "Your message is saved.";
export const RETRY_STOP_WAIT_MESSAGE = "Retry is waiting for the previous execution to stop. Your message is saved.";
export const RETRY_STOP_UNPROVEN_ACTION = "To continue, assign this agent a new task.";
export const RETRY_STOP_UNPROVEN_MESSAGE = "Paperclip could not confirm that the previous run stopped, so Retry can't continue this conversation. "
  + "To continue, assign this agent a new task.";
export const SEND_MESSAGE_ACTION = "Send a message to continue.";
export const RECOVERED_WORK_RETRY_ACTION = "Retry continues from it.";
export const NO_SAVED_WORK_RETRY_ACTION = "Press Retry to start it again.";
export const STOPPED_TASK_RETRY_ACTION = "Press Retry to run it again, or assign this agent a new task.";
