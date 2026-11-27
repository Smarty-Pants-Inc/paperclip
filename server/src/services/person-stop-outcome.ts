import type { heartbeatRuns } from "@paperclipai/db";
type Run = typeof heartbeatRuns.$inferSelect;
export const STOPPED_BEFORE_FIRST_INPUT = "paperclip.stopped-before-first-input.v1";

/** An exact-run sealed release outcome, never inferred from a cancelled label. */
export function stoppedBeforeFirstInput(run: Pick<Run, "id" | "status"> & {
  nativeIssueId?: string | null; resultJson?: Run["resultJson"]; issueId?: string | null; contextSnapshot?: Run["contextSnapshot"];
}): boolean {
  const outcome = run.resultJson?.stoppedBeforeFirstInput;
  const issueId = run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId;
  return run.status === "cancelled" && typeof issueId === "string" &&
    outcome !== null && typeof outcome === "object" && !Array.isArray(outcome) &&
    (outcome as Record<string, unknown>).schema === STOPPED_BEFORE_FIRST_INPUT &&
    (outcome as Record<string, unknown>).runId === run.id &&
    (outcome as Record<string, unknown>).issueId === issueId;
}
