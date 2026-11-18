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
  if (!issue) return strandedRetryAdmissionFromPresentation(presentation, null);
  return admissionFollowingPresentation(db, issue, presentation);
}

/**
 * The one mapping from the screen's decision to the refusal the notice, the
 * execution blocker and the recovery card all say (stranded2g G1: the card used
 * the bare presentation mapping and missed the system-held saved-work recovery,
 * so it said "Nothing restarts it by itself" while the blocker and the notice
 * said Paperclip was recovering the saved work).
 */
async function admissionFollowingPresentation(db: Db, issue: { id: string; companyId: string; assigneeAgentId: string | null },
  presentation: Presentation): Promise<StrandedRetryAdmission> {
  const admission = strandedRetryAdmissionFromPresentation(presentation, await assigneeOf(db, issue));
  if (admission.admits) return admission;
  // ONE precedence (rf-5 onA F1). #21914 (9c008635) first: the observed run is a
  // stale-run gate's pre-start cancellation whose hold's source Retry cannot bind
  // for the assignee (another agent's run). Whatever that hold shows (the screen's
  // "Retry is waiting for execution checks", or its saved-work recovery
  // "Recovering saved work…"), Retry on this task binds and admits nothing there
  // (two real presses: 202, runs 2→2→2). The step that works is a new task. It is
  // decided before the saved-work fallback, so the notice, blocker, card, wake-skip
  // and heartbeat-context all say the same step before and after a press.
  if ((admission.refusal === "system_waiting" || admission.refusal === "none"
    || admission.refusal === "workspace_repair_required") && issue.assigneeAgentId && presentation?.observedRunId) {
    const { preDispatchHeldSourceUnbound } = await import("../pre-dispatch-execution-wait.js");
    if (await preDispatchHeldSourceUnbound(db, { companyId: issue.companyId, issueId: issue.id,
      agentId: issue.assigneeAgentId, runId: presentation.observedRunId }))
      return { admits: false, refusal: "held_source_unbound" };
  }
  // r2f SD5: while Paperclip itself holds the saved-work recovery (the task
  // screen's execution blocker shows "Recovering saved work…",
  // workspaceRecoveryDisplay; or the hold's RECOVERING_SAVED_WORK_NEXT_ACTION),
  // the system state wins over the person action workspace_repair_required
  // would name: no "Press Recover saved files" while the system holds it.
  if (admission.refusal === "none" || admission.refusal === "workspace_repair_required") {
    const { getExecutionBlocker } = await import("../execution-blocker.js");
    const blocker = await getExecutionBlocker(db, issue.companyId, issue.id);
    const { RECOVERING_SAVED_WORK_NEXT_ACTION } = await import("../legacy-execution-recovery.js");
    if (blocker?.workspaceRecovery && ["queued", "recovering"].includes(blocker.workspaceRecovery.status)
      || blocker?.nextAction === RECOVERING_SAVED_WORK_NEXT_ACTION)
      return { admits: false, refusal: "saved_work_recovering" };
  }
  return admission;
}

/** A refusal whose wait Paperclip itself owns: nothing is needed from the person. */
function systemHolds(admission: StrandedRetryAdmission): boolean {
  return !admission.admits && (admission.refusal === "saved_work_recovering" || admission.refusal === "system_waiting");
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
  db: Db, issue: { id: string; companyId: string; assigneeAgentId: string | null }, blocker: B | null, presentation: Presentation,
): Promise<B | null> {
  if (!blocker || !presentation || presentation.canRetry) return blocker;
  const admission = await admissionFollowingPresentation(db, issue, presentation);
  // F1: a blocker that offers no Retry still names a wait ("Recovering saved
  // work…"). Where the one decision says that wait never ends in a run on this
  // task (held_source_unbound), its words are replaced whole by the decision's
  // step, so the blocker and wake-skip say what the notice and card say.
  // F3: its raw workspaceRecovery.message (the same wait) says the same step.
  if (!blocker.canRetry) {
    if (admission.admits || admission.refusal !== "held_source_unbound") return blocker;
    const step = strandedRetryRefusalCopy(admission).nextAction;
    const recovery = (blocker as { workspaceRecovery?: Record<string, unknown> | null }).workspaceRecovery;
    return { ...blocker, nextAction: step, ...(recovery && typeof recovery.message === "string"
      ? { workspaceRecovery: { ...recovery, message: step } } : {}) };
  }
  const nextAction = textFollowingAdmission(blocker.nextAction, admission, true);
  return nextAction === null ? blocker : { ...blocker, canRetry: false, nextAction };
}

/**
 * rf-5 onA F3: the task screen's ordinary interruption notice
 * (ExecutionBlockerNotice, from GET /issues/:id `interruption`; also the POST
 * /issues/:id/retry `presentation` the screen caches and the issue list's
 * `interruption` the inbox reads) says the step the one decision says. The
 * presentation is the decision's input, so its own retry-wait wording cannot
 * know a refusal the decision adds (held_source_unbound): there its wait
 * ("Retry is waiting for … Your message is saved.") is replaced whole by the
 * decision's step, as the execution blocker's is. Pass the RAW presentation to
 * the other …FollowingPresentation mappings; this one only shapes the output.
 */
export async function interruptionFollowingPresentation(
  db: Db, issue: { id: string; companyId: string; assigneeAgentId: string | null }, presentation: Presentation,
): Promise<Presentation> {
  if (!presentation || presentation.canRetry) return presentation;
  const admission = await admissionFollowingPresentation(db, issue, presentation);
  if (admission.admits || admission.refusal !== "held_source_unbound") return presentation;
  // No run follows on this task, so a press's grace "working" (or a scheduled
  // retry) is not shown either: the notice states the failed attempt and the step.
  return { ...presentation, state: "failed", retryWait: { reason: presentation.retryWait?.reason ?? "execution_recovery",
    message: strandedRetryRefusalCopy(admission).nextAction } };
}

/**
 * rf-5 onA F3 (the class): the task's runs say the same step. The run ledger
 * (GET /issues/:id/runs; IssueRunLedger.tsx renders `execution.nextAction`) and
 * the run page (GET /heartbeat-runs/:runId `error`) show the hold's wait for the
 * held source run ("Recovering saved work…", workspaceRecoveryDisplay) and for the
 * run the stale-run gate cancelled behind it (its recorded reason). Where the one
 * decision replaces that wait whole (held_source_unbound) they say its step.
 */
export async function runsFollowingDecision<R extends { errorCode?: string | null; error?: string | null;
  execution?: { phase?: string | null; nextAction?: string | null } | null }>(
  db: Db, input: { companyId: string; issueId: string | null | undefined }, runs: R[],
): Promise<R[]> {
  const waitShown = (run: R) => Boolean(run.execution?.phase === "recovery_needed" && run.execution.nextAction);
  const reasonShown = (run: R) => Boolean(run.errorCode === "execution_reconciliation_required" && run.error);
  if (!input.issueId || !runs.some(run => waitShown(run) || reasonShown(run))) return runs;
  const admission = await decideStrandedRetryAdmission(db, { companyId: input.companyId, issueId: input.issueId });
  if (admission.admits || admission.refusal !== "held_source_unbound") return runs;
  const step = strandedRetryRefusalCopy(admission).nextAction;
  return runs.map(run => !waitShown(run) && !reasonShown(run) ? run : { ...run,
    ...(waitShown(run) ? { execution: { ...run.execution, nextAction: step } } : {}),
    ...(reasonShown(run) ? { error: step } : {}) });
}

/** The same mapping for a run list that spans tasks (an agent's or the company's runs page). */
export async function runsFollowingDecisionAcrossIssues<R extends { issueId?: string | null; errorCode?: string | null; error?: string | null;
  execution?: { phase?: string | null; nextAction?: string | null } | null }>(db: Db, companyId: string, runs: R[]): Promise<R[]> {
  const byIssue = new Map<string, R[]>();
  for (const run of runs) if (run.issueId) byIssue.set(run.issueId, [...byIssue.get(run.issueId) ?? [], run]);
  const shown = new Map<R, R>();
  await Promise.all([...byIssue].map(async ([issueId, group]) => {
    const mapped = await runsFollowingDecision(db, { companyId, issueId }, group);
    group.forEach((run, index) => shown.set(run, mapped[index]!));
  }));
  return runs.map(run => shown.get(run) ?? run);
}

/**
 * r2f SD2: the same rule for the task's active recovery action
 * (GET /issues/:id `activeRecoveryAction`), whose `nextAction`
 * IssueRecoveryActionCard renders (IssueRecoveryActionCard.tsx, "Next action").
 * The card says "Retry" only where `presentation.canRetry` offers it.
 */
export async function recoveryActionFollowingPresentation<A extends { nextAction?: string | null; wakePolicy?: Record<string, unknown> | null }>(
  db: Db, issue: { id: string; companyId: string; assigneeAgentId: string | null }, action: A | null, presentation: Presentation,
): Promise<A | null> {
  if (!action?.nextAction || !presentation || presentation.canRetry) return action;
  const admission = await admissionFollowingPresentation(db, issue, presentation);
  const nextAction = textFollowingAdmission(action.nextAction, admission, false);
  // G1: while Paperclip itself holds the task, the card's wake line says the
  // system continues it, not the board escalation's "Waiting for you".
  // F2: the card's description follows the same decision (retryWithheld): a
  // withheld Retry has a named next step, so the card never says there is no
  // next owner or asks the person to choose (IssueRecoveryActionCard.tsx).
  const wakePolicy = admission.admits ? action.wakePolicy
    : { ...(action.wakePolicy ?? {}), retryWithheld: admission.refusal,
      ...(systemHolds(admission) && action.wakePolicy?.type === "board_escalation" ? { type: "system_recovery" } : {}) };
  return nextAction === null && wakePolicy === action.wakePolicy ? action
    : { ...action, nextAction: nextAction ?? action.nextAction, wakePolicy };
}

/**
 * Where the projection withholds Retry, a text's sentences that offer Retry are
 * dropped and the projection's own next action (the stranded notice's refusal
 * copy) is said instead. `presentation.canRetry` is the only rule.
 */
function textFollowingAdmission(text: string, admission: StrandedRetryAdmission, blockerSaysRetry: boolean): string | null {
  // null: unchanged. The blocker's canRetry=true is itself a Retry offer.
  if (!blockerSaysRetry && !/\bretry\b/i.test(text)) return null;
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
