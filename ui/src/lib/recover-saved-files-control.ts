import { useSyncExternalStore } from "react";

/**
 * Whether the board's "Recover saved files" button is on screen for a task.
 * WorkspaceExportRecovery owns the button and reports it here; the thread's
 * file line (reply-file-line.ts) only promises that recovery while it is shown.
 */
const shown = new Set<string>();
const listeners = new Set<() => void>();

export function reportRecoverSavedFilesShown(issueId: string, isShown: boolean) {
  if (shown.has(issueId) === isShown) return;
  if (isShown) shown.add(issueId); else shown.delete(issueId);
  for (const listener of [...listeners]) listener();
}

export function useRecoverSavedFilesShown(issueId: string | null | undefined): boolean {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => Boolean(issueId && shown.has(issueId)), () => false);
}
