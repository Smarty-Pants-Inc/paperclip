import { createContext, useContext } from "react";
import type { ExecutionProjection } from "@paperclipai/shared";
import { useSecondTick } from "@/hooks/useSecondTick";
import type { IssueChatComment } from "@/lib/issue-chat-messages";
import { cn } from "@/lib/utils";
import type { TaskChatItem } from "./task-chat-model";
import { toolActivityPresentation } from "./tool-taxonomy";

/** Only this active run's clock moves to the dock. Finished headers stay intact. */
export const TaskChatStatusContext = createContext<string | null>(null);
export const useTaskChatStatusLine = () => useContext(TaskChatStatusContext);

/** The approved run-clock format, independent of the current step. */
export function formatTaskRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor(seconds % 3_600 / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

/** Use saved provenance, never the latest bubble or a mount-local stopwatch.
 * Steering and queued follow-ups cannot replace the original send time. */
export function taskChatRunStartedAt(
  run: { id: string; startedAt?: Date | string | null; createdAt: Date | string },
  comments: readonly IssueChatComment[],
  requestCommentId?: string | null,
): number | null {
  let sentAt: number | null = null;
  for (const comment of comments) {
    if (comment.authorType !== "user" || comment.steeredIntoRunId ||
      (comment.id !== requestCommentId && comment.consumedByRunId !== run.id)) continue;
    const at = new Date(comment.createdAt).getTime();
    if (Number.isFinite(at) && (sentAt == null || at < sentAt)) sentAt = at;
  }
  if (sentAt != null) return sentAt;
  const startedAt = new Date(run.startedAt ?? run.createdAt).getTime();
  return Number.isFinite(startedAt) ? startedAt : null;
}

/** The current turn of an open run: a person's send after the run's last
 * answer starts a new turn (clock + label reset); a send before any answer
 * since the turn began is a steer and keeps both. */
export function taskChatTurnStart(
  run: { id: string; startedAt?: Date | string | null; createdAt: Date | string },
  comments: readonly IssueChatComment[],
  requestCommentId: string | null | undefined,
  transcript: readonly { kind: string; ts: string; channel?: string }[],
): { startedAtMs: number | null; newTurn: boolean } {
  const first = taskChatRunStartedAt(run, comments, requestCommentId);
  if (first == null) return { startedAtMs: null, newTurn: false };
  const answers = transcript
    .filter((entry) => entry.kind === "assistant" && entry.channel === "final")
    .map((entry) => new Date(entry.ts).getTime())
    .filter(Number.isFinite);
  const sends = comments
    .filter((comment) => comment.authorType === "user" && (
      comment.id === requestCommentId || comment.consumedByRunId === run.id || comment.steeredIntoRunId === run.id ||
      (!comment.consumedByRunId && !comment.steeredIntoRunId)))
    .map((comment) => new Date(comment.createdAt).getTime())
    .filter((at) => Number.isFinite(at) && at > first)
    .sort((a, b) => a - b);
  let turnStart = first;
  for (const at of sends) {
    if (answers.some((answerAt) => answerAt > turnStart && answerAt < at)) turnStart = at;
  }
  return { startedAtMs: turnStart, newTurn: turnStart !== first };
}

/** Reuse the page's tool taxonomy; command/file details remain in the thread. */
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

const activityLabels: Readonly<Record<string, string>> = {
  "Starting": "Starting",
  "Queued": "Starting",
  "Waiting to start": "Starting",
  "Preparing run": "Preparing the workspace",
  "Workspace ready": "Connecting to the model",
  "Conversation ready": "Connecting to the model",
  "Sending message": "Connecting to the model",
  "Message sent": "Connecting to the model",
  "Preparing your reply": "Resuming your conversation",
  "Reasoning": "Thinking",
  "Writing an answer": "Writing the answer",
  "Responding": "Writing the answer",
  "Waiting for you": "Waiting for your answer",
  "Waiting for previous run to stop": "Waiting for the previous run to stop",
  "Confirming execution": "Reconnecting",
  "Checking recovery": "Reconnecting",
};

export interface TaskChatLineState {
  label: string;
  working: boolean;
}

/** Wording only. The caller uses the existing Stop signal for visibility;
 * this component neither infers a retry nor changes execution authority. */
export function taskChatLineState({ status, execution, activityLabel, items, stopping, reconnecting }: {
  status: string;
  execution?: ExecutionProjection | null;
  activityLabel?: string;
  items: readonly TaskChatItem[];
  stopping: boolean;
  reconnecting: boolean;
}): TaskChatLineState {
  const clean = (label: string) => label.replace(/[.…]+$/, "");
  const normalize = (label: string) => activityLabels[clean(label)] ?? clean(label);
  if (stopping) return { label: "Stopping", working: true };
  if (execution && (execution.cause || ["waiting_for_answer", "waiting_for_access", "waiting_for_provider"].includes(execution.phase))) {
    return { label: normalize(execution.label), working: false };
  }
  if (reconnecting) return { label: "Reconnecting", working: true };
  const parsedLabel = taskChatActivityLabel(items);
  const label = activityLabel === "Running a tool"
    ? parsedLabel ?? "Using a tool"
    : activityLabel ? normalize(activityLabel)
    : parsedLabel ?? (execution?.phase === "reconnecting" ? "Reconnecting" : status === "queued" ? "Starting" : "Working");
  return { label, working: !label.startsWith("Waiting") };
}

/** Fixed 32px geometry outside the scroller; only the current label shimmers. */
export function TaskChatStatusLine({ state, clockKey, startedAtMs }: {
  state: TaskChatLineState;
  clockKey: string;
  startedAtMs: number | null;
}) {
  useSecondTick(true);
  const elapsed = startedAtMs == null ? null : Math.max(0, Date.now() - startedAtMs);
  return <div className="task-chat-status-line" data-testid="task-chat-status-line" data-clock-key={clockKey}
    data-state={state.working ? "working" : "waiting"}>
    <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate" title={state.label}>
      <span className={cn("task-chat-status-label", state.working && "task-chat-status-shimmer")}>{state.label}</span>
    </span>
    <span className="task-chat-status-clock ml-auto shrink-0 pl-2 text-muted-foreground tabular-nums"
      title={elapsed == null ? "Saved send or start time unavailable" : undefined}
      aria-label={elapsed == null ? "Duration unavailable" : "Elapsed run time"}>
      {elapsed == null ? "—" : formatTaskRunDuration(elapsed)}
    </span>
  </div>;
}
