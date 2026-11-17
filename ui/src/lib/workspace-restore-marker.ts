import { isWorkspaceRestorePending, safeWorkspaceRestorePath, WORKSPACE_RESTORE_RECOVERING_TEXT } from "@paperclipai/shared";

/** The run marker reads the server's owed fact (workspaceRestorePending), never
 * the raw workspaceRestoreFailure value alone: owed files are recovering. */
export function workspaceRestoreMarker(result: Record<string, unknown> | null | undefined): {
  pending: boolean; label: string; tone: "neutral" | "error";
} {
  const pending = isWorkspaceRestorePending(result);
  return pending
    ? { pending, label: "Recovering saved work", tone: "neutral" }
    : { pending, label: "Workspace restore failed", tone: "error" };
}

export function workspaceRestoreMarkerDetail(input: {
  result: Record<string, unknown> | null | undefined;
  savedPlan: boolean;
  hasResponse: boolean;
}): string {
  const parts = workspaceRestoreMarker(input.result).pending
    ? [WORKSPACE_RESTORE_RECOVERING_TEXT, ...(input.savedPlan ? ["The saved plan is available."] : [])]
    : [input.savedPlan
      ? "Workspace restore failed after the plan was saved. The saved plan is available."
      : "Workspace restore failed.", "Workspace files need recovery."];
  if (!input.hasResponse && input.result?.finalResponseRecorded === false) {
    parts.push("No final response was recorded.");
  }
  const relativePath = safeWorkspaceRestorePath(input.result?.workspaceRestorePath);
  if (relativePath) parts.push(`Affected path: ${relativePath}.`);
  return parts.join(" ");
}
