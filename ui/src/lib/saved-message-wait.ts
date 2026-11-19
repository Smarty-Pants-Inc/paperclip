import { REPLY_FILES_CONTINUE_ACTION, type ExecutionBlocker, type TaskInterruptionPresentation } from "@paperclipai/shared";

/**
 * A reply's file save failed for good while the person's next message waits (server execution-blocker.ts,
 * `savedMessageWait`). The task then says ONE sentence, the server's (`nextAction`), and the page shows it in ONE
 * place: the thread's recovery card. The page's other status surfaces for the same run (the saved-files panel and the
 * failed-attempt notice) are not shown beside it, and `continue_required` offers the one action.
 */
export interface SavedMessageWait {
  line: string;
  /** The one action's label ("Continue with the files as they are"), only while the message is held for it. */
  continueLabel: string | null;
}

export function readSavedMessageWait(blocker: Pick<ExecutionBlocker, "nextAction" | "savedMessageWait"> | null | undefined): SavedMessageWait | null {
  if (!blocker?.savedMessageWait || !blocker.nextAction) return null;
  return { line: blocker.nextAction, continueLabel: blocker.savedMessageWait === "continue_required" ? REPLY_FILES_CONTINUE_ACTION : null };
}

/**
 * The SAME hold where the task's execution blocker is not loaded: a list row (the Inbox failed-run row) has the task's
 * interruption projection only, and the server copies the hold onto it (task-interruption-presentation.ts, from
 * `savedMessageWait` "continue_required" of the same execution blocker). While the message is held, the row says the
 * task's ONE sentence and its press is the ONE action the thread's card sends, never a plain Retry.
 */
export interface SavedMessageHold {
  line: string;
  continueLabel: string;
  retryAction: "continue_with_files";
}

export function readSavedMessageHold(interruption: Pick<TaskInterruptionPresentation, "savedMessageWait"> | null | undefined): SavedMessageHold | null {
  const hold = interruption?.savedMessageWait;
  if (hold?.state !== "continue_required" || !hold.line) return null;
  return { line: hold.line, continueLabel: REPLY_FILES_CONTINUE_ACTION, retryAction: "continue_with_files" };
}

/**
 * What a list row says and offers while the task says one of its saved-message sentences (the same projection):
 *  - held for Continue: the sentence and the ONE action (`hold`, above);
 *  - waiting for the previous reply's environment to stop: the sentence and NOTHING to press (`hold` is null), because
 *    the message starts by itself.
 * Null in every other state: the row keeps its own text and its plain Retry.
 */
export interface SavedMessageRowWait {
  line: string;
  hold: SavedMessageHold | null;
}

export function readSavedMessageRowWait(interruption: Pick<TaskInterruptionPresentation, "savedMessageWait"> | null | undefined): SavedMessageRowWait | null {
  const wait = interruption?.savedMessageWait;
  if (!wait?.line || (wait.state !== "continue_required" && wait.state !== "waiting")) return null;
  return { line: wait.line, hold: readSavedMessageHold(interruption) };
}
