import { and, inArray, isNull } from "drizzle-orm";
import { executionWorkspaces } from "@paperclipai/db";

export function taskWorkspaceSelectableCondition() {
  return and(
    inArray(executionWorkspaces.status, ["active", "idle"]),
    isNull(executionWorkspaces.closedAt),
  )!;
}

/** Metadata key of a task root that was ABANDONED: the copy-back bound ended its writer unsaved
 * (isolateClassicSourceWorkspace) and the task continues in another root. The row is closed (`closedAt`), so no
 * selector above and no Files fallback picks it again; its directory is kept, named here, for explicit recovery. */
export const ABANDONED_TASK_ROOT_KEY = "abandonedTaskRoot";
export const ABANDONED_TASK_ROOT_SCHEMA = "paperclip.abandoned-task-root.v1";
