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
