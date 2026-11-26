import { createContext, useContext, type ReactNode } from "react";
import type { ExecutionProjection, TaskInterruptionPresentation } from "@paperclipai/shared";
import { CircleAlert } from "lucide-react";
import { useSecondTick } from "@/hooks/useSecondTick";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { TaskChatItem } from "./task-chat-model";
import { toolActivityPresentation } from "./tool-taxonomy";

/** The dock owns current status; the thread keeps only earlier runs' receipts. */
export const TaskChatStatusContext = createContext<ReadonlyMap<string, string> | null>(null);
export const useTaskChatStatusLine = () => useContext(TaskChatStatusContext);

/** One format for the run clock, ended receipts and retry countdown. */
export function formatTaskRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor(seconds % 3_600 / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

/** The same vocabulary for legacy transcript adapters, without inventing steps. */
export function taskChatActivityLabel(items: readonly TaskChatItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "thinking" && item.streaming) return "Thinking";
    if (item.kind === "message" && item.author === "agent" && item.streaming) return "Writing the answer";
    if (item.kind === "tool" && ["pending", "in_progress"].includes(item.status)) {
      const { family } = toolActivityPresentation({ name: item.rawName ?? item.name });
      return family === "terminal" ? "Running a command" : family === "read" ? "Reading a file"
        : family === "edit" ? "Editing files" : "Using a tool";
    }
    if (item.kind === "protocol" && item.surface === "runtime_request" && item.status === "pending") return "Waiting for your answer";
  }
  return undefined;
}

type Failure = NonNullable<TaskInterruptionPresentation["failure"]>;
/** Read optional public fields without requiring a server upgrade. */
export type StatusExecution = ExecutionProjection & {
  failure?: Failure;
  setupFailure?: { title?: string; message?: string; settingsPath?: string; detail?: string };
};

export interface TaskChatLineState {
  label: string;
  working: boolean;
  ended: boolean;
  failed?: boolean;
  detail?: string | null;
  retryAt?: string | null;
}

const clean = (label: string) => label.replace(/[.…]+$/, "");
const recoveryDetail = {
  checking_previous_run: "checking that the previous attempt stopped",
  saving_previous_files: "saving files from the previous attempt",
  finishing_recovery: "finishing recovery of saved work",
};

/** Wording only: execution and interruption remain the server's decisions. */
export function taskChatLineState({ status, execution, interruption, activityLabel, starting, stopping, reconnecting, personStopped, failure, failureReceipt, requestWait }: {
  status?: string;
  execution?: StatusExecution | null;
  interruption?: TaskInterruptionPresentation | null;
  activityLabel?: string;
  starting?: boolean;
  stopping?: boolean;
  reconnecting?: boolean;
  personStopped?: boolean;
  failure?: Failure | null;
  failureReceipt?: boolean;
  requestWait?: string | null;
}): TaskChatLineState | null {
  const work = (label: string, detail?: string | null): TaskChatLineState => ({ label, detail, working: true, ended: false });
  const wait = (label: string, detail?: string | null): TaskChatLineState => ({ label: clean(label), detail, working: false, ended: false });
  const fail = (label: string): TaskChatLineState => ({ label: clean(label), working: false, ended: true, failed: true });
  if (stopping) return work("Stopping");
  if (starting) return work("Starting");
  const live = !failureReceipt && (status === "queued" || status === "running");
  if (personStopped && !live) return { label: "Stopped", working: false, ended: true };
  if (requestWait) return wait(requestWait);
  // A later success is positive terminal authority, even if the old failed
  // interruption/retry projection has not refreshed yet. Receipts are reconciled
  // with this attempt's start/finish chronology by the caller.
  if (status === "succeeded" && !failureReceipt) return { label: "Finished", working: false, ended: true };
  // A scheduled successor is positive authority for more work. A stale
  // working/recovery/finishing projection is not: a terminal receipt wins it.
  if (interruption?.state === "retry_scheduled" || status === "scheduled_retry") {
    return { ...wait("Waiting to retry"), retryAt: interruption?.nextRetryAt ?? execution?.retryAt };
  }
  if (failureReceipt || ["failed", "timed_out", "interrupted", "cancelled"].includes(status ?? "")) {
    return fail("Couldn't finish the answer");
  }
  const projected = !live || execution?.phase === "retry_scheduled" || execution?.phase === "recovery_needed";
  if (execution?.setupFailure || execution?.cause === "agent_setup_failed") {
    return fail(execution.failure?.title ?? failure?.title ?? "Couldn't set up the agent");
  }
  if (execution?.phase === "retry_scheduled") {
    return { ...wait("Waiting to retry"), retryAt: interruption?.nextRetryAt ?? execution?.retryAt };
  }
  if (projected && interruption?.recoveryStep && interruption.state === "working") {
    return work("Recovering saved work", recoveryDetail[interruption.recoveryStep]);
  }
  if ((projected && interruption?.state === "failed") || execution?.phase === "failed") {
    return fail("Couldn't finish the answer");
  }
  if (interruption?.state === "waiting_for_user" && (!live || execution?.phase === "waiting_for_answer" || execution?.phase === "waiting_for_access")) {
    const label = interruption.userAction === "question" ? "Waiting for your answer"
      : interruption.userAction === "approval" ? "Waiting for approval"
      : interruption.userAction === "budget" ? "Waiting for budget"
      : interruption.userAction === "project_access" ? "Waiting for project access"
      : interruption.userAction === "assign_agent" ? "Waiting for an agent"
      : interruption.userAction === "choose_model" ? "Waiting for a model"
      : interruption.userAction === "resume" ? "Waiting to resume"
      : interruption.userAction === "confirm_run_stopped" || interruption.userAction === "confirm_owner_stop" ? "Waiting for stop confirmation"
      : "Waiting for your help";
    return wait(label);
  }
  if (execution?.phase === "finishing") return work("Stopping");
  if (execution?.phase === "queued" && execution.cause) {
    return wait(execution.label === "Waiting for previous run to stop" ? "Waiting for the previous run to stop" : execution.label);
  }
  if (execution?.phase === "waiting_for_answer") return wait("Waiting for your answer");
  if (execution?.phase === "waiting_for_access") return wait(execution.label);
  if (execution?.phase === "waiting_for_provider") return { ...wait("Waiting to retry", execution.retryAt ? null : execution.label.replace(/^Waiting for /, "")), retryAt: execution.retryAt };
  if (execution?.phase === "recovery_needed") return work("Reconnecting");
  if (projected && interruption?.state === "working" && interruption.retryWait) return wait(interruption.retryWait.message);
  if (projected && interruption?.state === "working" && interruption.retryAction === "move_forward") return wait("Waiting for the agent's other work");
  if (live) {
    if (reconnecting) return work("Reconnecting");
    if (activityLabel) return activityLabel.startsWith("Waiting") ? wait(activityLabel) : work(activityLabel);
    if (execution?.phase === "reconnecting") return work("Reconnecting");
    return work(status === "queued" ? "Starting" : "Working");
  }
  if (status === "succeeded") return { label: "Finished", working: false, ended: true };
  if (interruption?.state === "working") return work("Starting");
  return null;
}

/** Fixed geometry, outside the scroller. Only the label owns motion. */
export function TaskChatStatusLine({ state, clockKey, startedAtMs, finishedAtMs, action }: {
  state: TaskChatLineState | null;
  clockKey: string;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  action?: ReactNode;
}) {
  useSecondTick(Boolean(state && !state.ended));
  // Saved request/end timestamps are authoritative, including a correction
  // after an overshooting live tick. Never preserve a mount-local high water.
  const end = state?.ended ? finishedAtMs : Date.now();
  const elapsed = startedAtMs != null && end != null ? Math.max(0, end - startedAtMs) : null;
  const retryAtMs = state?.retryAt ? Date.parse(state.retryAt) : NaN;
  const detail = Number.isFinite(retryAtMs)
    ? `next try in ${formatTaskRunDuration(Math.max(0, retryAtMs - Date.now()))}`
    : state?.detail;
  return <div className="task-chat-status-line" data-testid="task-chat-status-line" data-clock-key={clockKey} data-state={state?.ended ? state.failed ? "failed" : "ended" : state?.working ? "working" : state ? "waiting" : "empty"}>
    {state ? <>
      {state.failed ? <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden /> : null}
      <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate" title={state.label}>
        <span className={cn("task-chat-status-label", state.working && "task-chat-status-shimmer", state.ended && !state.failed && "text-muted-foreground font-normal")}>{state.label}</span>
      </span>
      {detail ? <span className="min-w-0 truncate text-muted-foreground" title={detail}>{detail}</span> : null}
      {action ? <span className="ml-auto shrink-0">{action}</span> : null}
      <span className={cn("task-chat-status-clock shrink-0 pl-2 text-muted-foreground tabular-nums", !action && "ml-auto")}
        title={elapsed == null ? "Saved send or finish time unavailable" : undefined}
        aria-label={elapsed == null ? "Duration unavailable" : state.ended ? "Time the run took" : "Time since you sent your message"}>
        {elapsed == null ? "—" : formatTaskRunDuration(elapsed)}
      </span>
    </> : null}
  </div>;
}

export function TaskChatStatusRetry({ onRetry, pending, label = "Retry" }: { onRetry: () => void; pending?: boolean; label?: string }) {
  return <Button type="button" variant="outline" size="sm" className="task-chat-status-action" onClick={onRetry} disabled={pending}>
    {pending ? "Retrying" : label}
  </Button>;
}
