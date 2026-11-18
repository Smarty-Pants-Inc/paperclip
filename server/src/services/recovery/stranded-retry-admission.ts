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
  return strandedRetryAdmissionFromPresentation(presentation, issue?.assigneeAgentId
    ? (await db.select({ name: agents.name }).from(agents).where(and(eq(agents.companyId, input.companyId),
      eq(agents.id, issue.assigneeAgentId))).limit(1))[0]?.name ?? null : null);
}

type Presentation = Awaited<ReturnType<typeof taskInterruptionPresentation>>;

/** Maps the screen's decision to notice copy. `canRetry` is the decision. */
export function strandedRetryAdmissionFromPresentation(presentation: Presentation, agentName: string | null): StrandedRetryAdmission {
  if (presentation?.canRetry) return { admits: true };
  if (presentation?.userAction === "resume") return { admits: false, refusal: "agent_paused", agentName };
  if (presentation?.userAction === "confirm_run_stopped" || presentation?.retryWait?.reason === "previous_execution_unverified")
    return { admits: false, refusal: "previous_execution_unverified" };
  if (presentation?.retryWait?.reason === "workspace_repair_required") return { admits: false, refusal: "workspace_repair_required" };
  return { admits: false, refusal: "none" };
}
