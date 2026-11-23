import { describeError } from "../api/errors";
import type { ExecutionBlocker, IssueRelationIssueSummary, TaskInterruptionPresentation } from "@paperclipai/shared";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { TaskProjectAccessNotice } from "./TaskProjectAccessNotice";
import { ProviderFailureNotice } from "./ProviderFailureNotice";
import { LockedIssueChip, isLockedIssueStub } from "./LockedIssueChip";
import { PreviousServerStopConfirmation } from "./WorkspaceExportRecovery";
import { issuesApi } from "../api/issues";

const recoveryStepText: Record<NonNullable<TaskInterruptionPresentation["recoveryStep"]>, string> = {
  checking_previous_run: "Checking that the previous attempt stopped",
  saving_previous_files: "Saving files from the previous attempt",
  finishing_recovery: "Finishing recovery of saved work",
};

/** Ordinary working/resolved projections are not recovery ownership. */
export function isConversationRecovery(presentation: TaskInterruptionPresentation | null | undefined, observedStatus?: string) {
  return presentation?.responsibility === "system" && ["working", "retry_scheduled", "failed"].includes(presentation.state)
    && observedStatus !== "person_stopped" && !presentation.projectAccess && !presentation.setupFailure && !presentation.workspaceFailure
    && presentation.retryWait?.reason !== "dependency_blocked" && presentation.retryAction !== "move_forward"
    && (presentation.state !== "working" || Boolean(presentation.recoveryStep)
      || ["failed", "cancelled", "timed_out", "interrupted", "scheduled_retry"].includes(observedStatus ?? ""));
}

/** A budget hard stop holds saved work. Only a task that already ran has an
 * attempt to report; a task refused before its first run just waits. */
function budgetWaitText(presentation: TaskInterruptionPresentation) {
  const wait = "It is waiting for the budget to allow new work. Raise the budget in Costs.";
  return presentation.observedRunId || presentation.sourceRunIds.length
    ? `Couldn’t finish this attempt. Your message is saved. ${wait}`
    : `This task has not started. ${wait}`;
}
const isBudgetWait = (presentation: TaskInterruptionPresentation | null | undefined) =>
  presentation?.state === "waiting_for_user" && presentation.userAction === "budget";

const blockerAction: Record<string, string> = {
  blocked: "Blocked: open it to Retry",
  cancelled: "Cancelled: remove or replace it",
  done: "Saving its files",
};

/** One ordinary interruption surface. Technical records remain in diagnostics. */
export function ExecutionBlockerNotice({ presentation, observedStatus, blocker, canRetry, onRetry, optimistic, takingLonger, error, className, issueId, companyId, agentName, projectName, blockers }: {
  presentation: TaskInterruptionPresentation | null | undefined;
  observedStatus?: string;
  blocker?: ExecutionBlocker | null;
  companyId?: string;
  blockers?: IssueRelationIssueSummary[];
  canRetry: boolean;
  onRetry: () => void;
  optimistic?: boolean;
  takingLonger?: boolean;
  error?: Error | null;
  className?: string;
  issueId?: string;
  agentName?: string;
  projectName?: string;
}) {
  const recovery = isConversationRecovery(presentation,
    observedStatus ?? (blocker?.workspaceRepairRequired ? "failed" : undefined));
  if (presentation?.projectAccess && !optimistic && !takingLonger) return <TaskProjectAccessNotice
    access={presentation.projectAccess} issueId={issueId} agentName={agentName} projectName={projectName}
    canRetry={canRetry && presentation.canRetry} onRetry={onRetry} error={error} className={className} />;
  if (recovery && presentation) return <div role="status" aria-label="Task status"
    className={cn("flex items-center gap-3 text-sm text-muted-foreground", className)}>
    {(optimistic || presentation.state !== "failed") && <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />}
    <span className="min-w-0 flex-1">{!optimistic && presentation.state === "failed"
      ? "Couldn't resume this conversation. Your message is saved." : "Resuming your conversation…"}</span>
    {!optimistic && presentation.state === "failed" && canRetry && presentation.canRetry &&
      <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}
  </div>;
  if (error && !optimistic && !takingLonger) return <div role="alert" className={cn("flex items-center justify-between gap-2 text-sm text-destructive", className)}><span>{describeError(error).body}</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}</div>;
  if (takingLonger) return <div role="status" className={cn("flex items-center justify-between gap-2 text-sm text-muted-foreground", className)}><span>Taking longer than usual…</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}</div>;
  if (blocker?.workspaceRepairRequired) return (
    <div className={cn("pt-4", className)}>
      <div role="status" aria-label="Task status"
        className="flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground">
        <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0 flex-1">{blocker.nextAction}</span>
        {canRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}
      </div>
    </div>
  );
  const step = !optimistic && presentation?.responsibility === "system" && presentation.recoveryStep
    && ["working", "retry_scheduled"].includes(presentation.state) ? recoveryStepText[presentation.recoveryStep] : null;
  const retryIn = "Trying again…";
  if (!optimistic && presentation?.state === "waiting_for_user" && presentation.userAction === "question")
    return <div role="status" data-testid="task-execution-waiting" className={cn("flex items-center justify-between gap-2 text-sm text-muted-foreground", className)}>
      <span>Respond to the pending question to continue.</span>
      {canRetry && presentation.canRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}
    </div>;
  if (!optimistic && !presentation?.retryWait && presentation?.providerFailure && ["failed", "retry_scheduled", "waiting_for_user"].includes(presentation.state)) {
    // Saved-work recovery is what the task waits for, so name it over the
    // generic automatic-retry line while keeping the provider explanation.
    return <ProviderFailureNotice failure={presentation.providerFailure} className={className}
      actions={<>
        {presentation.userAction === "provider_billing" && <Button variant="outline" size="sm" asChild><Link to="/apps">Review AI account</Link></Button>}
        {canRetry && presentation.canRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}
      </>}>
      {presentation.state === "retry_scheduled" && <p>{step ? `${step}…` : "Paperclip will retry automatically."}</p>}
      {presentation.userAction === "provider_billing" && <p>Check your provider account’s billing and usage allowance, then retry.</p>}
      {isBudgetWait(presentation) && <p data-testid="task-execution-waiting">It is waiting for the budget to allow new work. Raise the budget in Costs.</p>}
    </ProviderFailureNotice>;
  }
  if (step && presentation?.state === "working") return <div role="status" aria-label="Task status"
    className={cn("text-sm text-muted-foreground", className)}>{`${step}…`}</div>;
  if (!optimistic && presentation?.state === "working" && presentation.retryAction === "move_forward" && presentation.canRetry)
    return <div role="status" aria-label="Task status" className={cn("flex items-center justify-between gap-3 text-sm text-muted-foreground", className)}>
      <span className="min-w-0 flex-1">Waiting for the agent to finish other work. Paperclip continues this task by itself.</span>
      {canRetry && <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry} data-testid="task-execution-move-forward">Move it forward now</Button>}
    </div>;
  // A task that has not started yet names the admission hold it waits for.
  if (!optimistic && presentation?.state === "working" && presentation.retryWait) {
    const dependencies = presentation.retryWait.reason === "dependency_blocked" ? blockers ?? [] : [];
    const unfinished = dependencies.filter(blocker => isLockedIssueStub(blocker) || blocker.status !== "done");
    const waitingOn = unfinished.length ? unfinished : dependencies;
    return <div role="status" aria-label="Task status" className={cn("text-sm text-muted-foreground", className)}>
      <p>{presentation.retryWait.message}</p>
      {waitingOn.length ? <ul className="mt-1 space-y-0.5" data-testid="retry-waiting-on">
        {waitingOn.map(blocker => isLockedIssueStub(blocker)
          ? <li key={blocker.id} className="flex min-w-0 items-center gap-2"><LockedIssueChip identifier={blocker.identifier} /></li>
          : <li key={blocker.id} className="flex min-w-0 items-center gap-2">
          <Link to={createIssueDetailPath(blocker.identifier ?? blocker.id)}
            className="font-mono text-xs text-foreground underline-offset-2 hover:underline">
            {blocker.identifier ?? "Task"}
          </Link>
          <span className="min-w-0 truncate">{blocker.title}</span>
          <span className="shrink-0 text-xs">{blockerAction[blocker.status] ?? blocker.status.replace(/_/g, " ")}</span>
        </li>)}
      </ul> : null}
    </div>;
  }
  if (!optimistic && presentation?.userAction === "confirm_run_stopped" && presentation.observedRunId && issueId && companyId) {
    const runId = presentation.observedRunId;
    return <PreviousServerStopConfirmation key={`${issueId}:${runId}`} runId={runId} formId={runId} issueId={issueId} companyId={companyId}
      className={className} confirmStop={stopEvidence => issuesApi.confirmRunStopped(issueId, { runId, stopEvidence })}
      copy={{ waiting: presentation.retryWait?.message ?? "Paperclip can't confirm that the previous run stopped. Your message is saved.",
        question: "How did you confirm that no agent is still working on this task?",
        placeholder: "For example: no codex or claude process for this task is running on the server host.",
        resuming: "Starting your Retry…", confirm: "Confirm it stopped" }} />;
  }
  // Other person-owned decisions have their own card on the task (approval,
  // project access, ...). A budget hold has none, so name it here and keep the
  // failure visible. The saved attempt starts by itself once the budget allows.
  if (!optimistic && presentation && isBudgetWait(presentation)) return (
    <div className={cn("pt-4", className)}>
      <div role="status" aria-label="Task status" data-testid="task-execution-waiting"
        className="flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground">
        <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0 flex-1">{budgetWaitText(presentation)}</span>
      </div>
    </div>
  );
  if (optimistic || !presentation || presentation.responsibility !== "system" ||
      !["failed", "retry_scheduled"].includes(presentation.state)) return null;
  return (
    <div className={cn(presentation.state === "failed" && "pt-4", className)}>
      <div role="status" aria-label="Task status" className={cn(
        "flex items-center justify-between gap-3 text-sm",
        presentation.state === "failed" ? "rounded-lg bg-destructive/10 p-4 text-foreground" : "text-muted-foreground",
      )}>
        {presentation.state === "failed" && <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />}
        <span className="min-w-0 flex-1">{presentation.state === "retry_scheduled"
          ? step ? `${step}…`
            : presentation.setupFailure ? `${presentation.setupFailure.message}. ${retryIn}` : retryIn
          : presentation.retryWait ? presentation.retryWait.message
          : presentation.workspaceFailure
            ? <>Couldn’t prepare the task folders. {presentation.workspaceFailure.message}</>
          : presentation.setupFailure
            ? <>Couldn’t set up the task workspace. {presentation.setupFailure.message}. Fix the command in the project’s workspace settings, then retry.</>
            : "Couldn’t finish this attempt. Your message is saved."}</span>
        {canRetry && presentation.canRetry && <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}
      </div>
    </div>
  );
}
