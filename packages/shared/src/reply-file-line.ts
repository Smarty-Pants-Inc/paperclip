/**
 * The file line of an accepted reply: what happened to the files the reply may
 * describe. The server stores a bounded STATE on the run's presentation
 * decision (`presentationDecision.fileLine`); the thread RENDERS the line from
 * that state, so the line can change (or clear) without rewriting the reply.
 * Every word a person reads lives here, so it can be changed in one place.
 */
export const REPLY_FILE_LINE_STATES = ["saving", "saved", "lost", "kept"] as const;
export type ReplyFileLineState = (typeof REPLY_FILE_LINE_STATES)[number];
export interface ReplyFileLine {
  state: ReplyFileLineState;
  /** ISO time after which `saving` is no longer shown as "Saving…". Null for a settled state. */
  deadlineAt: string | null;
}

/** native_workspace_sync_out_unrecoverable: the box or its lease is gone. */
export const FILE_LINE_LOST = "The file changes from this reply couldn't be saved.";
/** native_workspace_sync_out_retry_exhausted while the box is retained, and the
 * board's "Recover saved files" button (ui WorkspaceExportRecovery.tsx) is shown. */
export const FILE_LINE_KEPT = "The file changes from this reply are kept and can be recovered from the task's saved files.";
/** The same kept state while the "Recover saved files" button is not shown. */
export const FILE_LINE_KEPT_NO_BUTTON = "The file changes from this reply aren't saved yet. They're kept, and we can recover them.";
/** The reply was published at acceptance and the copy-back has not ended yet. */
export const FILE_LINE_SAVING = "Saving this turn's files…";
/** `saving` past its deadline: never "Saving…" for ever. */
export const FILE_LINE_NOT_SAVED_YET = "The file changes from this reply aren't saved yet.";

/**
 * RFL's words (11:45Z, byte-exact). A reply's file save failed for good (its line reads LOST) while the person's next
 * message waits. At every moment the person reads exactly ONE of these three sentences, and every place says the SAME
 * one: the task's next action (server execution-blocker.ts), the queue's wait line (the gate,
 * server explicit-native-continuation.ts), and the thread's recovery card (ui TaskChatThread.tsx).
 *
 * 1. While the reply's box is not stopped yet: the queue's own wait words (never "starts now" before it is true).
 */
export const REPLY_FILES_LOST_WAITING_LINE = "Waiting for the previous environment to stop. Your message will start automatically.";
/** 2. The box is stopped and the project's files equal the last saved state: the message starts, on the same checkout.
 * Also posted in the thread once, at the moment the message starts. */
export const REPLY_FILES_NOT_SAVED_LINE = "Your message is saved. The last reply's file changes couldn't be saved; your message starts now on the project's files as they are.";
/** 3. The box is stopped and the files differ from the last saved state (the failed copy-back applies file by file, so
 * a part of the reply's changes can be in them, or the saved state can no longer be read): the message is HELD until
 * the person chooses the one action below. It never starts by itself on a mixed tree. */
export const REPLY_FILES_PARTLY_SAVED_LINE = "The last reply's file changes couldn't be saved, and part of them may already be in the project's files. Your message will start once you choose Continue.";
/** The ONE action of sentence 3 (POST /api/issues/:id/retry with `retryAction: "continue_with_files"`). */
export const REPLY_FILES_CONTINUE_ACTION = "Continue with the files as they are";
/** Which of the three sentences the task's next action is saying (ExecutionBlocker.savedMessageWait). */
export const SAVED_MESSAGE_WAIT_STATES = ["waiting", "starting", "continue_required"] as const;
export type SavedMessageWaitState = (typeof SAVED_MESSAGE_WAIT_STATES)[number];
/** The gate's wait reason while sentence 3 holds the message. */
export const CHECKOUT_CONTINUE_REQUIRED_REASON = "checkout_continue_required";

export function readReplyFileLine(value: unknown): ReplyFileLine | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { state, deadlineAt } = value as Record<string, unknown>;
  if (!(REPLY_FILE_LINE_STATES as readonly unknown[]).includes(state)) return null;
  return { state: state as ReplyFileLineState, deadlineAt: typeof deadlineAt === "string" ? deadlineAt : null };
}

/** `saving` is shown only before its deadline; a missing or unreadable deadline is already past. */
export function replyFileLineSavingExpired(fileLine: ReplyFileLine, nowMs: number): boolean {
  if (fileLine.state !== "saving") return false;
  const deadline = fileLine.deadlineAt ? Date.parse(fileLine.deadlineAt) : Number.NaN;
  return !Number.isFinite(deadline) || nowMs >= deadline;
}

/** The ONE renderer of the file line. Null means no line. */
export function replyFileLineText(fileLine: ReplyFileLine | null | undefined,
  options: { nowMs: number; recoverSavedFilesShown: boolean }): string | null {
  if (!fileLine) return null;
  switch (fileLine.state) {
    case "saved": return null;
    case "lost": return FILE_LINE_LOST;
    case "kept": return options.recoverSavedFilesShown ? FILE_LINE_KEPT : FILE_LINE_KEPT_NO_BUTTON;
    case "saving": return replyFileLineSavingExpired(fileLine, options.nowMs) ? FILE_LINE_NOT_SAVED_YET : FILE_LINE_SAVING;
  }
}
