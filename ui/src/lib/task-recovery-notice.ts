/** Stranded execution recovery bodies, shared by chat compaction and notice titles.
 * Keep the single-attempt sentence boundary: "this task on its own" is a different notice.
 */
export const TASK_RECOVERY_STATEMENT = /^Paperclip (?:tried to (?:start|continue) this task again, but it still could not (?:start|continue)\b|could not (?:start|continue) this task\.)/i;
