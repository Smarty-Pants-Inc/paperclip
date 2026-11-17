import { isWorkspaceRestoreDelayed, isWorkspaceRestorePending, isWorkspaceRestoreRecovered, safeWorkspaceRestorePath,
  WORKSPACE_RESTORE_DELAYED_TEXT, WORKSPACE_RESTORE_RECOVERED_TEXT, WORKSPACE_RESTORE_RECOVERING_TEXT } from "@paperclipai/shared";

/** The run marker reads the server's owed fact (workspaceRestorePending), never
 * the raw workspaceRestoreFailure value alone: owed files are recovering. */
export function workspaceRestoreMarker(result: Record<string, unknown> | null | undefined): {
  pending: boolean; recovered: boolean; delayed: boolean; label: string; tone: "neutral" | "error";
} {
  // The server projects both facts from the run's hold: in progress, or the
  // worker saved the files. A hold that ended blocked projects neither.
  const pending = isWorkspaceRestorePending(result);
  const recovered = !pending && isWorkspaceRestoreRecovered(result);
  // Past the person bound the hold is still recovering, but Retry is offered
  // (not pending), the same Retry the server's blocker offers and accepts.
  const delayed = !pending && !recovered && isWorkspaceRestoreDelayed(result);
  return pending || delayed
    ? { pending, recovered, delayed, label: "Recovering saved work", tone: "neutral" }
    : recovered
    ? { pending, recovered, delayed, label: "Saved work recovered", tone: "neutral" }
    : { pending, recovered, delayed, label: "Workspace restore failed", tone: "error" };
}

export function workspaceRestoreMarkerDetail(input: {
  result: Record<string, unknown> | null | undefined;
  savedPlan: boolean;
  hasResponse: boolean;
}): string {
  const marker = workspaceRestoreMarker(input.result);
  const parts = marker.pending || marker.recovered || marker.delayed
    ? [marker.pending ? WORKSPACE_RESTORE_RECOVERING_TEXT : marker.delayed ? WORKSPACE_RESTORE_DELAYED_TEXT : WORKSPACE_RESTORE_RECOVERED_TEXT,
      ...(input.savedPlan ? ["The saved plan is available."] : [])]
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
