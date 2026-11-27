import { useRef, useState } from "react";
import { describeError } from "../api/errors";
import type { IssueChatComment } from "../lib/issue-chat-messages";
import type { ExecutionBlocker, IssueQueuedCommentQueue, IssueRelationIssueSummary, TaskInterruptionPresentation } from "@paperclipai/shared";
import { AlertCircle, LoaderCircle, PauseCircle } from "lucide-react";
import { Link } from "@/lib/router";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import { TaskProjectAccessNotice } from "./TaskProjectAccessNotice";
import { ProviderFailureNotice } from "./ProviderFailureNotice";
import { LockedIssueChip, isLockedIssueStub } from "./LockedIssueChip";
import { PreviousServerStopConfirmation } from "./WorkspaceExportRecovery";
import { issuesApi } from "../api/issues";
import { formatTaskChatTimestamp } from "./task-chat/task-chat-adapter";

const recoveryStepText: Record<NonNullable<TaskInterruptionPresentation["recoveryStep"]>, string> = {
  checking_previous_run: "Checking that the previous attempt stopped",
  saving_previous_files: "Saving files from the previous attempt",
  finishing_recovery: "Finishing recovery of saved work",
};

/** A startup cancellation fence alone also covers budget stops, not just person Stop. */
export function isPersonStoppedRun(run: { errorCode?: string | null; resultJson?: Record<string, unknown> | null } | undefined) {
  const cancellation = run?.resultJson?.cancellation as { source?: string; initiator?: { type?: string } } | undefined;
  return Boolean(run?.resultJson?.personStop ||
    (cancellation?.source === "operator" && cancellation.initiator?.type === "user") ||
    (run?.errorCode === "cancelled" && run.resultJson?.executionCancellation));
}

/** Only the persisted no-result receipt can own this failure's explanation. */
export function nativeFailureNoticeRunId(comment: IssueChatComment) {
  const runId = comment.clientRequestId?.match(/^native-output-without-result:(.+)$/)?.[1];
  return runId && !comment.deletedAt && comment.body.trim() && comment.authorType === "system" &&
    comment.presentation?.kind === "system_notice" && comment.presentation.tone === "danger" &&
    comment.metadata?.recoveryResponsibility !== "system" &&
    [comment.metadata?.sourceRunId, comment.createdByRunId, comment.runId, comment.derivedCreatedByRunId].every(id => !id || id === runId)
    ? runId : null;
}

/** C31 blocks Retry of the refused run, not every older attempt. At C31 v11
 * the cause attributes a contributor to the selected composition; it does not
 * prove that part alone exceeds the bound. Task Retry changes protected source
 * origins; Agent Chat selects the older request's IDs. Queue/command composition
 * is checked independently. Every kind is therefore UNKNOWN for an older run
 * from this receipt alone: keep base behaviour, including ordinary canRetry=false. */
export function isExecutionRetryRefused(presentation?: TaskInterruptionPresentation | null, errorCode?: string | null, resultJson?: Record<string, unknown> | null) {
  const permanentRefusal = "native_turn_prompt_exceeds_command_bound";
  return resultJson?.nativeTurnPromptRefusalCause != null || errorCode === permanentRefusal || presentation?.failure?.code === permanentRefusal;
}

// Page-side vocabulary at C31 v11 (d21f281a), native-turn-budget.ts:31-57.
// Keep server implementation out of the UI graph. Titles/details are sent by
// the server; readable future kind/measure labels survive version skew.
export type NativePromptRemedy = "edit_task_description" | "edit_message" | "delete_own_message" | "new_followup_task" | "report_defect" | "check_versions";
export type ExecutionRefusalRemedyControls = Partial<Record<NativePromptRemedy, () => void | Promise<void>>>;
// Friday gate: keep every remedy button off until the server supplies BOTH
// helper-derived remedies for unknown kind/measure labels and message id(s) on
// the cause, so edit/delete can bind to that message and its actual author.
// A saved list plus the newest visible message is not that authority.
const C31_REMEDY_BUTTONS = false;
type NativePromptRefusalKind = "task_description" | "newest_message" | "unread_message" | "unread_messages" | "queued_input" | "human_response" | "protected_input" | "protected_inputs" | "command" | "unmeasured_composition" | "stale_copy";
type NativePromptMeasure = "command" | "command_upper_bound" | "prompt" | "envelope" | "handoff_note" | "protected_parts" | "envelope_with_reserve";
type NativePromptRefusalCause = {
  kind: NativePromptRefusalKind | (string & {});
  bytes: number;
  count?: number;
  measure?: NativePromptMeasure | (string & {});
  remedies: NativePromptRemedy[];
};
// A remedy is a route, not a capability grant. Hosts supply only controls they
// already expose to this viewer. No per-kind or prose-derived action list.
const refusalRemedyControls: Record<NativePromptRemedy, string | null> = {
  edit_task_description: "Go to description", edit_message: "Edit queued message",
  delete_own_message: "Delete queued message", new_followup_task: "New follow-up task",
  // This page has no report/version-repair route. The server explains the
  // handover, including run + task title; do not invent a repair button.
  report_defect: null, check_versions: null,
};
const refusalKindMeasurements: Record<NativePromptRefusalKind, readonly NativePromptMeasure[]> = {
  task_description: [], newest_message: [], unread_message: [], unread_messages: [],
  queued_input: [], human_response: [], protected_input: [],
  protected_inputs: ["protected_parts", "envelope_with_reserve"],
  command: ["command", "command_upper_bound", "prompt", "envelope", "handoff_note"],
  unmeasured_composition: [], stale_copy: [],
};
const refusalMeasureLabels: Record<NativePromptMeasure, string | null> = {
  command: "Serialized command", prompt: "Encoded prompt", envelope: "Encoded envelope",
  handoff_note: "Encoded history-omission note", protected_parts: "Located required inputs before command encoding",
  // Reserved room is not an observed size. Preserve the qualified server detail
  // without appending an observed-byte claim for either reserve-bearing measure.
  command_upper_bound: null, envelope_with_reserve: null,
};

function executionFailureCause(failure: NonNullable<TaskInterruptionPresentation["failure"]>, resultJson?: Record<string, unknown> | null): NativePromptRefusalCause | null {
  const value = resultJson?.nativeTurnPromptRefusalCause ?? (failure as typeof failure & { cause?: unknown }).cause;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { kind, bytes, count, measure, remedies } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !/^[^\s:\[\]]+$/.test(kind) ||
    (measure !== undefined && (typeof measure !== "string" || !/^[^\s:\[\]]+$/.test(measure))) ||
    Object.keys(value).some(key => !["kind", "bytes", "count", "measure", "remedies"].includes(key)) ||
    (remedies !== undefined && (!Array.isArray(remedies) || !remedies.every(value => typeof value === "string" && /^[a-z_]+$/.test(value)))) ||
    typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0 ||
    count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)) return null;
  return { kind, bytes, count, measure,
    // Unknown future action values are ignored, never guessed. A legacy cause
    // with no remedies grants no action, even when this host has all controls.
    remedies: Array.isArray(remedies) ? [...new Set(remedies.filter((value): value is NativePromptRemedy =>
      typeof value === "string" && Object.hasOwn(refusalRemedyControls, value)))] : [],
  } as NativePromptRefusalCause;
}

/** Server copy owns what was refused and the supported way out. Only an explicit
 * observed measure with a recognized meaning for this kind earns a byte line.
 * Legacy unlabelled counts and unknown labels add no size claim. Stale-copy
 * bytes are diagnostic, not evidence of exceeding a limit. */
export function executionFailureDetail(failure: NonNullable<TaskInterruptionPresentation["failure"]>, resultJson?: Record<string, unknown> | null) {
  const cause = executionFailureCause(failure, resultJson);
  const measure = cause?.measure;
  const label = cause && measure && Object.hasOwn(refusalKindMeasurements, cause.kind) &&
    refusalKindMeasurements[cause.kind as NativePromptRefusalKind].includes(measure as NativePromptMeasure) &&
    Object.hasOwn(refusalMeasureLabels, measure) ? refusalMeasureLabels[measure as NativePromptMeasure] : null;
  return label && cause ? `${failure.detail}\n\n${label}: ${cause.bytes.toLocaleString()} bytes.` : failure.detail;
}

function RefusalRemedyActions({ remedies, controls }: { remedies: NativePromptRemedy[]; controls?: ExecutionRefusalRemedyControls }) {
  const [pending, setPending] = useState<NativePromptRemedy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const available = remedies.filter(remedy => refusalRemedyControls[remedy] && controls?.[remedy]);
  if (!available.length) return null;
  return <div className="flex min-w-0 flex-col gap-2 sm:max-w-sm">
    <div className="flex flex-wrap gap-2">
      {available.map(remedy => <Button key={remedy} type="button" variant="outline" size="sm" disabled={pending !== null}
        aria-busy={pending === remedy} data-testid={`task-refusal-remedy-${remedy}`} onClick={() => {
          if (pendingRef.current) return;
          pendingRef.current = true; setPending(remedy); setError(null);
          void Promise.resolve().then(() => controls![remedy]!()).catch(error => setError(describeError(error).body))
            .finally(() => { pendingRef.current = false; setPending(null); });
        }}>{refusalRemedyControls[remedy]}</Button>)}
    </div>
    {error && <span role="alert" className="text-destructive">{error}</span>}
  </div>;
}

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
export function ExecutionBlockerNotice({ presentation, observedStatus, observedResultJson, observedErrorCode, blocker, canRetry, onRetry, optimistic, takingLonger, error, className, issueId, companyId, agentName, projectName, blockers, savedMessageBlocked = false, conversationMode = false, remedyControls, queuedMessageWait }: {
  presentation: TaskInterruptionPresentation | null | undefined;
  observedStatus?: string;
  /** Admission wait for a message still in the server's queue. */
  queuedMessageWait?: IssueQueuedCommentQueue["executionWait"];
  /** Saved, unanswered chat with no live work or actionable interruption projection. */
  savedMessageBlocked?: boolean;
  conversationMode?: boolean;
  observedResultJson?: Record<string, unknown> | null;
  observedErrorCode?: string | null;
  blocker?: ExecutionBlocker | null;
  companyId?: string;
  blockers?: IssueRelationIssueSummary[];
  canRetry: boolean;
  onRetry: () => void;
  onNewSession?: () => Promise<void>;
  remedyControls?: ExecutionRefusalRemedyControls;
  optimistic?: boolean;
  takingLonger?: boolean;
  error?: Error | null;
  className?: string;
  issueId?: string;
  agentName?: string;
  projectName?: string;
}) {
  const repairWait = queuedMessageWait?.reason === "workspace_repair_required" ? queuedMessageWait
    : presentation?.retryWait?.reason === "workspace_repair_required" ? presentation.retryWait : null;
  const workspaceRepairRequired = blocker?.workspaceRepairRequired || Boolean(repairWait);
  // Structured recovery ownership, not reassuring hold wording, means wait.
  const repairRecovering = workspaceRepairRequired && (blocker?.workspaceRecovery?.status === "queued"
    || blocker?.workspaceRecovery?.status === "recovering"
    || presentation?.responsibility === "system" && (presentation.state === "working" && Boolean(presentation.recoveryStep)
      || presentation.state === "retry_scheduled" && Boolean(presentation.nextRetryAt)));
  const personStopped = isPersonStoppedRun({ resultJson: observedResultJson, errorCode: observedErrorCode });
  const heldMessageCount = blocker?.savedMessageCount ?? 0;
  // Stop is not a failure, but it does not resolve any hold on saved messages.
  if (!workspaceRepairRequired && heldMessageCount <= 0 && personStopped) return null;
  const retryRefused = isExecutionRetryRefused(presentation, observedErrorCode ?? blocker?.cause, observedResultJson);
  canRetry = canRetry && !retryRefused && (!repairRecovering ||
    (presentation?.canRetry ?? blocker?.workspaceRecovery?.canRetry ?? false) && blocker?.workspaceRecovery?.canRetry !== false);
  if (savedMessageBlocked && (!retryRefused || presentation?.state !== "failed")) presentation = { state: "failed", responsibility: "system", canRetry,
    intentId: null, nextRetryAt: null, userAction: null, sourceRunIds: [], observedRunId: null };
  // Only C31 owns this new explanation/remedy path, including during optimism.
  // Ordinary server failure projections retain base wording, Retry and /new.
  if (retryRefused && presentation?.state === "failed" && presentation.failure) return <div role="status" aria-label="Task status"
    className={cn("flex flex-col items-start gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center", className)}>
    <span className="min-w-0 flex-1 whitespace-pre-line break-words"><span className="block font-medium text-foreground">{presentation.failure.title}</span>{presentation.observedRunId ? executionFailureDetail(presentation.failure, observedResultJson) : presentation.failure.detail}</span>
    {C31_REMEDY_BUTTONS && <RefusalRemedyActions key={`${presentation.observedRunId}:${JSON.stringify(executionFailureCause(presentation.failure, observedResultJson)?.remedies)}`}
      remedies={executionFailureCause(presentation.failure, observedResultJson)?.remedies ?? []} controls={remedyControls} />}
  </div>;
  if (personStopped && heldMessageCount > 0) {
    // Do not turn a recovery hold into a promise of automatic progress, or echo
    // advice to send another message while the person's messages are held.
    const retryAllowed = canRetry && blocker?.canRetry === true && presentation?.canRetry !== false;
    return <div className={cn(retryAllowed && "pt-4", className)}>
      <div role="status" aria-label="Task status" className={retryAllowed
        ? "flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground"
        : "flex items-center gap-3 text-sm text-muted-foreground"}>
        {retryAllowed ? <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
          : <PauseCircle className="size-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1">Your {heldMessageCount} {heldMessageCount === 1 ? "message is" : "messages are"} saved. {retryAllowed
          ? "Press Retry to continue from your saved work."
          : "This task is on hold after the Stop and can't continue from here yet."}
          {error && !optimistic && !takingLonger && <span role="alert" className="mt-1 block text-destructive">{describeError(error).body}</span>}
        </span>
        {retryAllowed && <Button variant="outline" size="sm" className="shrink-0" disabled={optimistic} onClick={onRetry}
          data-testid="task-execution-retry">{optimistic ? "Retrying…" : "Retry"}</Button>}
      </div>
    </div>;
  }
  // Capabilities own permission; server prose is displayed, never parsed.
  const messageContinues = blocker?.canContinue === true;
  const recoveryRetryAllowed = canRetry && presentation?.canRetry === true && blocker?.canRetry !== false;
  const cannotContinue = blocker?.canContinue === false && blocker.canRetry === false && !messageContinues;
  const newSession = !retryRefused && !messageContinues && !cannotContinue && conversationMode && presentation?.state === "failed" && !(canRetry && presentation.canRetry)
    ? <> Send <code>/new</code> to start a fresh session, then send your message again.</> : null;
  // Recovered files do not prove an unanswered person message is saved.
  const savedPersonInput = heldMessageCount === 1 ? " Your message is saved."
    : heldMessageCount > 1 ? ` Your ${heldMessageCount} messages are saved.` : "";
  const recoveryFailure = blocker?.nextAction?.trim()
    ? blocker.nextAction
    : recoveryRetryAllowed
      ? `This conversation paused after a problem on our side.${savedPersonInput} Press Retry to continue.`
      : messageContinues
        ? `This conversation paused after a problem on our side.${savedPersonInput} Send a message to continue.`
        : cannotContinue
          ? `Couldn't resume this conversation.${savedPersonInput} This task is on hold and can't continue from here yet.`
          : <>This conversation paused after a problem on our side.{savedPersonInput}{newSession}</>;
  const recovery = !workspaceRepairRequired && !savedMessageBlocked && isConversationRecovery(presentation,
    observedStatus ?? (blocker?.workspaceRepairRequired ? "failed" : undefined));
  if (presentation?.projectAccess && !optimistic && !takingLonger) return <TaskProjectAccessNotice
    access={presentation.projectAccess} issueId={issueId} agentName={agentName} projectName={projectName}
    canRetry={canRetry && presentation.canRetry} onRetry={onRetry} error={error} className={className} />;
  if (recovery && presentation) {
    const recovering = optimistic || presentation.state !== "failed" || Boolean(presentation.nextRetryAt)
      || blocker?.workspaceRecovery?.status === "queued" || blocker?.workspaceRecovery?.status === "recovering";
    const retryRequired = recoveryRetryAllowed && !recovering;
    const personActionRequired = !recovering && (recoveryRetryAllowed || messageContinues);
    const retryTime = !optimistic ? formatTaskChatTimestamp(presentation.nextRetryAt) : undefined;
    return <div className={cn(personActionRequired && "pt-4", className)}>
      <div role="status" aria-label="Task status" className={personActionRequired
        ? "flex items-center gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground"
        : "flex items-center gap-3 text-sm text-muted-foreground"}>
        {personActionRequired ? <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
          : recovering ? <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          : <PauseCircle className="size-4 shrink-0" aria-hidden="true" />}
        <span className="min-w-0 flex-1">{recovering
          ? retryTime ? `Trying again at ${retryTime}` : "Preparing your reply…"
          : recoveryFailure}</span>
        {retryRequired &&
          <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}
      </div>
    </div>;
  }
  if (error && !optimistic && !takingLonger) return <div role="alert" className={cn("flex items-center justify-between gap-2 text-sm text-destructive", className)}><span>{describeError(error).body}</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}</div>;
  if (takingLonger) return <div role="status" className={cn("flex items-center justify-between gap-2 text-sm text-muted-foreground", className)}><span>Taking longer than usual…</span>{canRetry && <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}</div>;
  if (workspaceRepairRequired) return (
    <div className={cn(!repairRecovering && "pt-4", className)}>
      <div role="status" aria-label="Task status"
        className={cn("flex items-center gap-3 text-sm", repairRecovering
          ? "text-muted-foreground" : "rounded-lg bg-destructive/10 p-4 text-foreground")}>
        {repairRecovering ? <LoaderCircle className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden="true" />
          : <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />}
        <span className="min-w-0 flex-1">{blocker?.workspaceRepairRequired ? blocker.nextAction : repairWait?.message}
          {!repairRecovering && canRetry ? " Press Retry to continue from your saved work." : null}</span>
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
      actions={canRetry && presentation.canRetry ? <Button variant="outline" size="sm" onClick={onRetry} data-testid="task-execution-retry">Retry</Button> : undefined}>
      {presentation.state === "retry_scheduled" && <p>{step ? `${step}…` : "Paperclip will retry automatically."}</p>}
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
  if (!optimistic && presentation?.userAction === "unblock") return (
    <div className={cn("pt-4", className)}>
      <div role="status" aria-label="Task status" data-testid="task-execution-waiting"
        className="flex items-center justify-between gap-3 rounded-lg bg-destructive/10 p-4 text-sm text-foreground">
        <AlertCircle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
        <span className="min-w-0 flex-1">The agent stopped and needs your help to continue. Read its last comment, do what it asks, then Retry.</span>
        {canRetry && presentation.canRetry && <Button variant="outline" size="sm" className="shrink-0" onClick={onRetry} data-testid="task-execution-retry">Retry</Button>}
      </div>
    </div>
  );
  if ((optimistic && !savedMessageBlocked) || !presentation || presentation.responsibility !== "system" ||
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
            : "Couldn’t finish this attempt. Your message is saved."}
          {!presentation.retryWait && !presentation.workspaceFailure && !presentation.setupFailure ? newSession : null}
        </span>
        {canRetry && presentation.canRetry && <Button variant="outline" size="sm" className="shrink-0" disabled={optimistic} onClick={onRetry} data-testid="task-execution-retry">{optimistic ? "Retrying…" : "Retry"}</Button>}
      </div>
    </div>
  );
}
