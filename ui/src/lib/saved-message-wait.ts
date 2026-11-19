import { REPLY_FILES_CONTINUE_ACTION, type ExecutionBlocker } from "@paperclipai/shared";

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
