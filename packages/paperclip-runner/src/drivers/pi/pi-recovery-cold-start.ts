/** First-turn instruction after native Pi history loss: the Paperclip skill's
 * cold-start read (skills/paperclip/SKILL.md). The issue thread is the record;
 * Pi's file is only its runtime copy. */
export const PI_RECOVERY_COLD_START_INSTRUCTIONS = [
  "Pi recovery cold start: your saved runtime history could not be restored. This is still the same Paperclip conversation.",
  "Before answering, call get_task_context, get_task_history, and read_document with key plan for this issue. Follow the Paperclip skill's cold-start read for any further relevant thread history. A missing plan is not a missing issue thread.",
  "Answer from the retrieved conversation record, preserving current user direction and approval gates. Do not claim unrecovered Pi-only memory. If the issue thread cannot be read, explicitly report that failure instead of guessing its history.",
].join("\n\n");
