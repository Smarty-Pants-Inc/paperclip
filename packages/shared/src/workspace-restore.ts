/** Closed, path-free classifications persisted by adapter settlement. */
export const WORKSPACE_RESTORE_FAILURE_CODES = [
  "restore_permission_denied",
  "restore_lock_timeout",
  "restore_unsafe_archive",
  "restore_invalid_metadata",
  "restore_failed",
] as const;

/** These failures preserve an accepted native result for board-owned export repair. */
export function isNativeWorkspaceExportRepairCause(value: unknown): boolean {
  return value === "native_workspace_sync_out_retry_exhausted";
}

export function hasWorkspaceRestoreFailure(result: Record<string, unknown> | null | undefined): boolean {
  return WORKSPACE_RESTORE_FAILURE_CODES.some((code) => result?.workspaceRestoreFailure === code);
}

/** Sibling key the server's restore-hold authority writes beside
 * workspaceRestoreFailure (run resultJson and hold evidence) while the files are
 * only owed: no restore has been tried or has failed yet. A recorded real
 * failure clears it. The raw failure value stays as-is for DB predicates. */
export const WORKSPACE_RESTORE_PENDING_KEY = "workspaceRestorePending";
/** The one wording for owed files, shared by the server hold and the UI. */
export const WORKSPACE_RESTORE_RECOVERING_TEXT = "Recovering your saved work; your message is kept and runs when it's back.";

/** True only when the restore marker is set and the server recorded the files as only owed. */
export function isWorkspaceRestorePending(result: Record<string, unknown> | null | undefined): boolean {
  return hasWorkspaceRestoreFailure(result) && result?.[WORKSPACE_RESTORE_PENDING_KEY] === true;
}
/** Read-only projection key: the run's owed files were saved by the recovery
 * worker (its hold's workspaceRecovery.status is 'recovered'). Never stored. */
export const WORKSPACE_RESTORE_RECOVERED_KEY = "workspaceRestoreRecovered";
/** The one wording for saved work the recovery worker recovered. */
export const WORKSPACE_RESTORE_RECOVERED_TEXT = "Saved work recovered.";

/** True only when the restore marker is set and the server projected the owed files as recovered. */
export function isWorkspaceRestoreRecovered(result: Record<string, unknown> | null | undefined): boolean {
  return hasWorkspaceRestoreFailure(result) && result?.[WORKSPACE_RESTORE_RECOVERED_KEY] === true;
}

/** The person bound (RFL 15:09Z): an owed hold not recovered within this long
 * of being written reads 'delayed' with a Retry the server accepts. The
 * worker's own schedule is unchanged and the files stay kept. */
export const WORKSPACE_RESTORE_PERSON_BOUND_MS = 60 * 60_000;
/** Read-only projection key: the owed hold is past the person bound. Never stored. */
export const WORKSPACE_RESTORE_DELAYED_KEY = "workspaceRestoreDelayed";
export const WORKSPACE_RESTORE_DELAYED_TEXT = "Recovering your saved work is taking longer than expected. "
  + "You can Retry to continue from the last saved version.";
/** True only when the restore marker is set and the server projected the owed hold as delayed. */
export function isWorkspaceRestoreDelayed(result: Record<string, unknown> | null | undefined): boolean {
  return hasWorkspaceRestoreFailure(result) && result?.[WORKSPACE_RESTORE_DELAYED_KEY] === true;
}

/** Display only ordinary repository paths, never targets, host paths or temp IDs. */
export function safeWorkspaceRestorePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 180) return null;
  const relative = value.replace(/^\.\//, "");
  if (!relative || !/^[a-zA-Z0-9_.\/-]+$/.test(relative) || relative.startsWith("/")) return null;
  if (relative.split("/").some((part) => !part || part === "." || part === "..")) return null;
  if (/(?:[a-f0-9]{8}-[a-f0-9-]{27,}|[a-zA-Z0-9_-]{32,}|(?:^|\/)(?:tmp|temp|paperclip-clone)[^/]*)(?:\/|$)/i.test(relative)) return null;
  return relative;
}
