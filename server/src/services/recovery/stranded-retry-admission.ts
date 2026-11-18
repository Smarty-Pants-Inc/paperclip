import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";
import { strandedRetryRefusalCopy, type StrandedRetryAdmission } from "./stranded-notice.js";

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
  const admission = strandedRetryAdmissionFromPresentation(presentation, issue ? await assigneeOf(db, issue) : null);
  if (admission.admits || !issue) return admission;
  // r2f SD5: while Paperclip itself holds the saved-work recovery (the task
  // screen's execution blocker shows "Recovering saved work…",
  // workspaceRecoveryDisplay; or the hold's RECOVERING_SAVED_WORK_NEXT_ACTION),
  // the system state wins over the person action workspace_repair_required
  // would name: no "Press Recover saved files" while the system holds it.
  if (admission.refusal !== "none" && admission.refusal !== "workspace_repair_required") return admission;
  const { getExecutionBlocker } = await import("../execution-blocker.js");
  const blocker = await getExecutionBlocker(db, issue.companyId, issue.id);
  const { RECOVERING_SAVED_WORK_NEXT_ACTION } = await import("../legacy-execution-recovery.js");
  if (blocker?.workspaceRecovery && ["queued", "recovering"].includes(blocker.workspaceRecovery.status)
    || blocker?.nextAction === RECOVERING_SAVED_WORK_NEXT_ACTION)
    return { admits: false, refusal: "saved_work_recovering" };
  return admission;
}

type Assignee = { name: string | null; maxDailyRuns: number | null; maxDailyCostCents: number | null };

/** The assignee's name and daily limits (heartbeat/timer-policy.ts parseHeartbeatPolicy, the reader dispatch uses). */
async function assigneeOf(db: Db, issue: { companyId: string; assigneeAgentId: string | null }): Promise<Assignee | null> {
  if (!issue.assigneeAgentId) return null;
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, issue.companyId),
    eq(agents.id, issue.assigneeAgentId))).limit(1);
  if (!agent) return null;
  const { parseHeartbeatPolicy } = await import("../heartbeat/timer-policy.js");
  const policy = parseHeartbeatPolicy(agent);
  return { name: agent.name ?? null, maxDailyRuns: policy.maxDailyRuns, maxDailyCostCents: policy.maxDailyCostCents };
}

type Presentation = Awaited<ReturnType<typeof taskInterruptionPresentation>>;

/**
 * r2e: the task's execution blocker (GET /issues/:id `executionBlocker`, read by
 * agents and the board) says "Retry" only where the screen's one Retry decision
 * (`taskInterruptionPresentation.canRetry`) offers it. Where the projection
 * withholds Retry, the blocker's Retry sentences are dropped and the
 * projection's own next action (the same refusal copy as the stranded notice)
 * is said instead. No predicate is repeated: `presentation.canRetry` decides.
 */
export async function executionBlockerFollowingPresentation<B extends { nextAction: string; canRetry?: boolean }>(
  db: Db, issue: { companyId: string; assigneeAgentId: string | null }, blocker: B | null, presentation: Presentation,
): Promise<B | null> {
  if (!blocker?.canRetry || !presentation || presentation.canRetry) return blocker;
  const nextAction = await textFollowingPresentation(db, issue, blocker.nextAction, presentation, true);
  return nextAction === null ? blocker : { ...blocker, canRetry: false, nextAction };
}

/**
 * r2f SD2: the same rule for the task's active recovery action
 * (GET /issues/:id `activeRecoveryAction`), whose `nextAction`
 * IssueRecoveryActionCard renders (IssueRecoveryActionCard.tsx, "Next action").
 * The card says "Retry" only where `presentation.canRetry` offers it.
 */
export async function recoveryActionFollowingPresentation<A extends { nextAction?: string | null }>(
  db: Db, issue: { companyId: string; assigneeAgentId: string | null }, action: A | null, presentation: Presentation,
): Promise<A | null> {
  if (!action?.nextAction || !presentation || presentation.canRetry) return action;
  const nextAction = await textFollowingPresentation(db, issue, action.nextAction, presentation, false);
  return nextAction === null ? action : { ...action, nextAction };
}

/**
 * Where the projection withholds Retry, a text's sentences that offer Retry are
 * dropped and the projection's own next action (the stranded notice's refusal
 * copy) is said instead. `presentation.canRetry` is the only rule.
 */
async function textFollowingPresentation(db: Db, issue: { companyId: string; assigneeAgentId: string | null },
  text: string, presentation: NonNullable<Presentation>, blockerSaysRetry: boolean): Promise<string | null> {
  // null: unchanged. The blocker's canRetry=true is itself a Retry offer.
  if (presentation.canRetry || !blockerSaysRetry && !/\bretry\b/i.test(text)) return null;
  const admission = strandedRetryAdmissionFromPresentation(presentation, await assigneeOf(db, issue));
  if (admission.admits) return null;
  const kept = (text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) ?? [])
    .map(sentence => sentence.trim()).filter(sentence => sentence && !/\bretry\b/i.test(sentence));
  return [...kept, strandedRetryRefusalCopy(admission).nextAction].join(" ");
}

/** Maps the screen's decision to notice copy. `canRetry` is the decision. */
export function strandedRetryAdmissionFromPresentation(presentation: Presentation, assignee: Assignee | string | null): StrandedRetryAdmission {
  const agentName = typeof assignee === "string" ? assignee : assignee?.name ?? null;
  if (presentation?.canRetry) return { admits: true };
  if (presentation?.userAction === "resume") return { admits: false, refusal: "agent_paused", agentName };
  // Confirm it stopped is named only under the screen's own condition for its button
  // (ExecutionBlockerNotice.tsx: userAction === "confirm_run_stopped").
  if (presentation?.userAction === "confirm_run_stopped") return { admits: false, refusal: "confirm_run_stopped" };
  if (presentation?.retryWait?.reason === "previous_execution_unverified") return { admits: false, refusal: "previous_execution_unverified", agentName };
  if (presentation?.retryWait?.reason === "workspace_repair_required") return { admits: false, refusal: "workspace_repair_required" };
  if (presentation?.userAction === "budget" || presentation?.retryWait?.reason === "budget.blocked")
    return { admits: false, refusal: "budget_blocked" };
  if (presentation?.retryWait?.reason === "heartbeat.daily_run_limit" || presentation?.retryWait?.reason === "heartbeat.daily_cost_limit") {
    const kind = presentation.retryWait.reason === "heartbeat.daily_cost_limit" ? "cost" as const : "runs" as const;
    const limit = typeof assignee === "object" && assignee ? kind === "cost" ? assignee.maxDailyCostCents : assignee.maxDailyRuns : null;
    return { admits: false, refusal: "daily_limit", agentName, kind, limit };
  }
  // Any other wait Paperclip owns: say what the screen says, with no button.
  if (presentation?.responsibility === "system" && !presentation.userAction && presentation.retryWait?.message)
    return { admits: false, refusal: "system_waiting", waitMessage: presentation.retryWait.message };
  return { admits: false, refusal: "none" };
}
