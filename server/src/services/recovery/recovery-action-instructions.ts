import type { Db } from "@paperclipai/db";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { getExecutionBlocker } from "../execution-blocker.js";
import { executionProjectionsForRuns } from "../execution-projection.js";
import { readWorkspaceRecovery } from "../workspace-recovery-receipt.js";
import { withTaskStopPendingInstruction } from "./stop-pending.js";

/** The expanded recovery detail must not revive an obsolete stored instruction
 * after preservation completed. Use the same current receipt as the card (and
 * the diagnostic transcript for older source runs), without changing history,
 * retry authority, or any independent Stop obligation. */
export async function recoveryActionInstructions(db: Db, companyId: string, issueId: string,
  actions: IssueRecoveryAction[]): Promise<IssueRecoveryAction[]> {
  const recovered = actions.flatMap(action => {
    const state = readWorkspaceRecovery(action.evidence);
    return state?.status === "recovered" ? [{ action, runId: state.runId }] : [];
  });
  if (!recovered.length) return actions;
  const blocker = await getExecutionBlocker(db, companyId, issueId);
  const others = recovered.filter(({ action }) => action.id !== blocker?.recoveryActionId);
  const projections = await executionProjectionsForRuns(db, companyId, [...new Set(others.map(({ runId }) => runId))]);
  const instructions = new Map(recovered.map(({ action, runId }) => [action.id,
    action.id === blocker?.recoveryActionId && runId === blocker.runId ? blocker.nextAction : projections.get(runId)?.nextAction]));
  return actions.map(action => {
    const instruction = instructions.get(action.id);
    return instruction ? { ...action, nextAction: withTaskStopPendingInstruction(action, instruction) } : action;
  });
}
