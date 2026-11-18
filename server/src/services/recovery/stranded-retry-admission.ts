import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import type { StrandedRetryAdmission } from "./stranded-notice.js";

/**
 * Whether the stranded notice may say "Press Retry". It does not decide this
 * itself: it asks `taskInterruptionPresentation` (task-interruption-presentation.ts),
 * the one function that decides `canRetry` for the task screen's Retry button
 * and that `POST /issues/:id/retry` returns as its `presentation`. A refusal
 * only selects the copy for the action that screen offers instead
 * (`userAction` / `retryWait.reason`); no predicate is repeated here.
 */
export async function decideStrandedRetryAdmission(db: Db, input: {
  companyId: string;
  issueId: string;
  runId?: string | null | undefined;
}): Promise<StrandedRetryAdmission> {
  const [issue] = await db.select({ id: issues.id, companyId: issues.companyId, status: issues.status,
    assigneeAgentId: issues.assigneeAgentId, projectId: issues.projectId }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).limit(1);
  const presentation = issue ? await taskInterruptionPresentation(db, issue) : null;
  const admission = strandedRetryAdmissionFromPresentation(presentation, issue?.assigneeAgentId
    ? (await db.select({ name: agents.name }).from(agents).where(and(eq(agents.companyId, input.companyId),
      eq(agents.id, issue.assigneeAgentId))).limit(1))[0]?.name ?? null : null);
  if (admission.admits || admission.refusal !== "none" || !issue) return admission;
  // The task screen's execution blocker shows Paperclip recovering the saved
  // work ("Recovering saved work…", workspaceRecoveryDisplay; or the hold's
  // RECOVERING_SAVED_WORK_NEXT_ACTION) with no button.
  // Say that; do not say nothing restarts it.
  const { getExecutionBlocker } = await import("../execution-blocker.js");
  const blocker = await getExecutionBlocker(db, issue.companyId, issue.id);
  const { RECOVERING_SAVED_WORK_NEXT_ACTION } = await import("../legacy-execution-recovery.js");
  if (blocker?.workspaceRecovery && ["queued", "recovering"].includes(blocker.workspaceRecovery.status)
    || blocker?.nextAction === RECOVERING_SAVED_WORK_NEXT_ACTION)
    return { admits: false, refusal: "system_waiting", waitMessage: "Paperclip is recovering the saved work first. Your message is saved." };
  return admission;
}

type Presentation = Awaited<ReturnType<typeof taskInterruptionPresentation>>;

/** Maps the screen's decision to notice copy. `canRetry` is the decision. */
export function strandedRetryAdmissionFromPresentation(presentation: Presentation, agentName: string | null): StrandedRetryAdmission {
  if (presentation?.canRetry) return { admits: true };
  if (presentation?.userAction === "resume") return { admits: false, refusal: "agent_paused", agentName };
  // Confirm it stopped is named only under the screen's own condition for its button
  // (ExecutionBlockerNotice.tsx: userAction === "confirm_run_stopped").
  if (presentation?.userAction === "confirm_run_stopped") return { admits: false, refusal: "confirm_run_stopped" };
  if (presentation?.retryWait?.reason === "previous_execution_unverified") return { admits: false, refusal: "previous_execution_unverified" };
  if (presentation?.retryWait?.reason === "workspace_repair_required") return { admits: false, refusal: "workspace_repair_required" };
  if (presentation?.userAction === "budget" || presentation?.retryWait?.reason === "budget.blocked")
    return { admits: false, refusal: "budget_blocked" };
  if (presentation?.retryWait?.reason === "heartbeat.daily_run_limit" || presentation?.retryWait?.reason === "heartbeat.daily_cost_limit")
    return { admits: false, refusal: "daily_limit", agentName };
  // Any other wait Paperclip owns: say what the screen says, with no button.
  if (presentation?.responsibility === "system" && !presentation.userAction && presentation.retryWait?.message)
    return { admits: false, refusal: "system_waiting", waitMessage: presentation.retryWait.message };
  return { admits: false, refusal: "none" };
}
