import { groupImageResources } from "./image-resources";
import { AgentQueueWait } from "@/components/AgentQueueWait";
import { agentQueueWaitOf } from "@/lib/agent-queue-wait";
import { WAITING_TO_START_LABEL, useWaitingToStart } from "./useWaitingToStart";
import { McpAppTurnViews, mcpAppRunRefreshKey } from "@/components/mcp-app/McpAppTurnViews";
import { useContext, useRef, useState, type ReactNode } from "react";
import { TaskChatExpansionState } from "./expansion-state";
import { ChevronRight } from "lucide-react";
import type { ExecutionProjection } from "@paperclipai/shared";
import { useSecondTick } from "@/hooks/useSecondTick";
import { cn } from "@/lib/utils";
import type {
  TaskChatItem,
  TaskChatMessageItem,
  TaskChatRuntimeRequestDecision,
  TaskChatRuntimeRequestItem,
} from "./task-chat-model";
import { TaskChatAgentIdentity, TaskChatBubble } from "./TaskChatBubble";
import { TaskChatBubbleActions } from "./TaskChatBubbleActions";
import { formatTaskChatTimestamp } from "./task-chat-adapter";
import { TaskChatRunnerActivityGroup } from "./TaskChatRunnerActivityGroup";
import { TaskChatSubagentTree } from "./TaskChatSubagentCard";
import { TaskChatRunHealthBanner, partitionRunHealthItems } from "./TaskChatRunHealthBanner";
import { TaskChatProtocolCard } from "./TaskChatProtocolCard";
import { TaskChatPlanPreviewCard } from "./TaskChatPlanPreviewCard";
import { TaskChatMarker } from "./TaskChatMarker";
import { TaskChatThinking } from "./TaskChatThinking";
import { TaskChatShimmerScope, useTaskChatShimmer } from "./TaskChatShimmer";
import {
  buildTurnTimelineRows,
  isTerminalRunStatus,
  isPersistentRunnerWorkItem,
  isYieldedWaitStub,
  omitProgressRepeatedByResponse,
  paperclipRunnerFinalResponse,
  paperclipRunnerTimelineItems,
  type ReasoningDisplay,
} from "./transcript-adapter";

function currentActivityStatusItems(
  items: readonly TaskChatItem[],
): readonly TaskChatItem[] {
  let boundaryIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.kind === "message" ||
      item.kind === "plan_document" ||
      (item.kind === "protocol" &&
        (item.surface === "runtime_request" ||
          item.surface === "run_result" ||
          item.surface === "run_terminal"))
    ) {
      boundaryIndex = index;
      break;
    }
  }
  return items.slice(boundaryIndex + 1);
}

function formatCompactDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function terminalStatusFailed(status: string): boolean {
  return (
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out" ||
    status === "interrupted"
  );
}

function RunnerTurnStatus({
  status,
  startedAtMs,
  finishedAtMs,
  continuedAfterSteering = false,
  waitingLabel,
}: {
  status: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  continuedAfterSteering?: boolean;
  waitingLabel?: string | null;
}) {
  const terminal = isTerminalRunStatus(status);
  useSecondTick(!terminal && startedAtMs != null);
  const elapsedMs =
    startedAtMs == null
      ? null
      : Math.max(
          0,
          (terminal ? (finishedAtMs ?? Date.now()) : Date.now()) - startedAtMs,
        );
  const elapsed = formatCompactDuration(elapsedMs);

  const failed = terminalStatusFailed(status);
  const label = terminal ? (failed ? "Stopped" : "Worked") : waitingLabel ?? "Working";
  const suffix = terminal
    ? elapsed ? ` ${failed ? "after" : "for"} ${elapsed}` : ""
    : elapsed ? `${waitingLabel ? " · " : " for "}${elapsed}` : "";

  return (
    <span
      className="min-w-0 truncate text-sm font-normal text-muted-foreground"
      data-testid="task-chat-turn-status-header"
      data-turn-position="identity"
      aria-live="polite"
      aria-atomic="true"
    >
      {continuedAfterSteering ? <span data-conversation-meta="">Continued after steering · </span> : null}
      {label}<span data-conversation-meta="">{suffix}</span>
    </span>
  );
}

function RunnerCurrentActivityTail({ status, waitingLabel }: { status: string; waitingLabel?: string | null }) {
  const shimmer = useTaskChatShimmer("working");
  if (isTerminalRunStatus(status)) return null;
  return <div className="mt-2 flex min-h-8 min-w-0 items-center gap-2 px-1 py-1 text-xs text-muted-foreground" data-testid="task-chat-current-activity" data-turn-position="tail">
    <span className={cn(!waitingLabel && shimmer && "shimmer-text shimmer-text-muted")} aria-live="polite" data-testid="task-chat-current-activity-label">{waitingLabel ?? "Thinking"}</span>
  </div>;
}

interface RunnerHeaderProps {
  runId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  agent?: import("../AgentAvatar").AvatarAgent;
  status: string;
  execution?: ExecutionProjection | null;
  preparationLabel?: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  continuedAfterSteering?: boolean;
}

function runnerWaitingLabel({ runId, status, execution, preparationLabel }: RunnerHeaderProps, waitingToStart = false) {
  if (isTerminalRunStatus(status)) return null;
  if (execution?.phase === "waiting_for_provider") return execution.label;
  if (!runId && preparationLabel) return preparationLabel;
  if (status === "queued" && execution?.cause) return execution.label;
  return waitingToStart ? WAITING_TO_START_LABEL : null;
}

/** A run's queued turn with no named hold, past the startup grace period. */
function useRunnerWaitingToStart({ runId, status, execution, startedAtMs }: Pick<RunnerHeaderProps, "runId" | "status" | "execution" | "startedAtMs">) {
  return useWaitingToStart(status === "queued" && !!runId && !execution?.cause, startedAtMs);
}

function agentQueueWaitFor({ status, execution }: Pick<RunnerHeaderProps, "status" | "execution">) {
  return status === "queued" ? agentQueueWaitOf(execution) : null;
}

/** One identity stays mounted while admission discovers the run's renderer. */
export function TaskChatRunnerHeader({ statusContent, ...props }: RunnerHeaderProps & { statusContent?: ReactNode }) {
  const waitingToStart = useRunnerWaitingToStart(props);
  return <div className="flex min-h-8 min-w-0 items-center gap-2 pb-1 pt-2" data-testid="task-chat-runner-identity-row">
    {props.agentName ? <TaskChatAgentIdentity agentName={props.agentName} agentIcon={props.agentIcon} agent={props.agent} /> : null}
    {statusContent ?? (agentQueueWaitFor(props) ? <AgentQueueWait queue={agentQueueWaitFor(props)!} /> : null) ?? <RunnerTurnStatus status={props.status} startedAtMs={props.startedAtMs} finishedAtMs={props.finishedAtMs}
      continuedAfterSteering={props.continuedAfterSteering} waitingLabel={runnerWaitingLabel(props, waitingToStart)} />}
  </div>;
}

export function TaskChatRunnerTurn({
  runId,
  agentName,
  agentIcon,
  agent,
  items,
  runAnswerItems,
  postedAnswerTexts,
  responseComment,
  status,
  execution,
  preparationLabel,
  startedAtMs,
  finishedAtMs,
  activityUnavailable = false,
  allowSummaryFallback = true,
  awaitingContinuation = false,
  waitSummary = null,
  continuedAfterSteering = false,
  showHeader = true,
  reasoningDisplay,
  onRuntimeRequestDecision,
}: {
  /** Stable identity used to clear replay-latched final text for the next turn. */
  runId?: string | null;
  agentName?: string | null;
  agentIcon?: string | null;
  agent?: import("../AgentAvatar").AvatarAgent;
  items: readonly TaskChatItem[];
  /**
   * The whole run's transcript items when `items` is only its latest steering
   * segment; every answer the run gave is read from here. Defaults to `items`.
   */
  runAnswerItems?: readonly TaskChatItem[];
  /**
   * Normalized texts of this run's replies the thread already shows; an
   * earlier answer with one of them is not drawn a second time.
   */
  postedAnswerTexts?: readonly string[];
  /** Saved duplicate hidden by this live lane; only its identical visible reply is read. */
  responseComment?: Pick<TaskChatMessageItem, "id" | "text" | "createdAtIso">;
  status: string;
  execution?: ExecutionProjection | null;
  /** Presentation only while Send/Retry admission has no run yet. */
  preparationLabel?: string;
  startedAtMs: number | null;
  finishedAtMs?: number | null;
  activityUnavailable?: boolean;
  allowSummaryFallback?: boolean;
  /**
   * Accepted wait/interaction authority: the turn is waiting, so an early
   * provider final that only restates the wait is not presented as a reply.
   * Prose the agent wrote for the user stays visible.
   */
  awaitingContinuation?: boolean;
  /** The accepted yielded result's wait summary, when known. */
  waitSummary?: string | null;
  /** The visible tail resumes the same native run after an accepted steer. */
  continuedAfterSteering?: boolean;
  /** The task thread keeps a shared header across native and legacy discovery. */
  showHeader?: boolean;
  /**
   * The thread's resolved reasoning display for this run: the run adapter's
   * `transcriptPresentation.liveReasoningView`. Omitted only by hosts without
   * that resolution, which fold.
   */
  reasoningDisplay?: ReasoningDisplay;
  onRuntimeRequestDecision?: (
    item: TaskChatRuntimeRequestItem,
    decision: TaskChatRuntimeRequestDecision,
  ) => void | Promise<void>;
}) {
  const { failures: mcpStartupFailures, rest: turnItems } = partitionRunHealthItems(items);
  const terminal = isTerminalRunStatus(status);
  const [workOpen, setWorkOpen] = useState(false);
  const sharedExpansion = useContext(TaskChatExpansionState);
  const localExpansion = useRef(new Map<string, boolean>());
  const workRun = useRef(runId);
  if (workRun.current !== runId) {
    workRun.current = runId;
    localExpansion.current.clear();
    if (workOpen) setWorkOpen(false);
  }
  const waitingToStart = useRunnerWaitingToStart({ runId, status, execution, startedAtMs });
  const waitingLabel = runnerWaitingLabel({ runId, status, execution, preparationLabel, startedAtMs }, waitingToStart);
  const yielded = turnItems.some(
    (item) =>
      item.kind === "protocol" &&
      item.surface === "run_result" &&
      item.disposition === "yielded",
  );
  const observedFinal = paperclipRunnerFinalResponse(turnItems, awaitingContinuation
    ? { allowFallback: false, yielded: true, waitSummary }
    : { allowFallback: terminal && allowSummaryFallback });
  const observedProviderText = Boolean(
    observedFinal &&
    turnItems.some(
      (item) =>
        item.kind === "message" &&
        item.id === observedFinal.id &&
        item.channel !== "progress",
    ),
  );
  // A reconnect/replay can briefly rebuild the transcript without the final
  // item (or with an earlier, shorter prefix). Provider-authored final text
  // always replaces a structured summary fallback, even when it is shorter;
  // within either class, displayed answer text remains monotonic.
  const finalRef = useRef<{
    runId?: string | null;
    item?: TaskChatMessageItem;
    providerText?: boolean;
  }>({ runId });
  if (finalRef.current.runId !== runId) finalRef.current = { runId };
  // A provider final can arrive before the accepted yielded result. Clear any
  // replay latch once the control plane establishes that this turn is waiting
  // for continuation; only an authored (non-wait) final is re-latched below.
  if (yielded || awaitingContinuation) finalRef.current = { runId };
  // One run can answer several steered questions with separate finals. A
  // later provider final is a new answer, not a replay prefix: it replaces
  // the displayed one even when shorter (earlier answers stay as replies).
  const observedLaterProviderFinal = Boolean(
    observedFinal && observedProviderText && finalRef.current.providerText &&
    observedFinal.atMs != null && finalRef.current.item?.atMs != null &&
    observedFinal.atMs > finalRef.current.item.atMs,
  );
  if (
    observedFinal &&
    (!finalRef.current.item || observedLaterProviderFinal ||
      (observedProviderText && !finalRef.current.providerText) ||
      (observedProviderText === Boolean(finalRef.current.providerText) &&
        observedFinal.text.length >= finalRef.current.item.text.length))
  ) {
    finalRef.current.item = observedFinal;
    finalRef.current.providerText = observedProviderText;
  }
  const final = finalRef.current.item;
  // One run can answer several steered questions, each with its own provider
  // final. Every answer stays on screen as its own block, in transcript order,
  // keyed by its transcript item id; a new one never replaces the last. Each is
  // latched by id: a replay prefix (a shorter copy of the same item) or a
  // rebuild that has not re-read it yet never regresses or drops it.
  const answersRef = useRef<{ runId?: string | null; byId: Map<string, TaskChatMessageItem> }>({ runId, byId: new Map() });
  if (answersRef.current.runId !== runId) answersRef.current = { runId, byId: new Map() };
  const waitSummaries = [waitSummary, ...turnItems.flatMap((item) =>
    item.kind === "protocol" && item.surface === "run_result" ? [item.summary] : [])];
  for (const item of runAnswerItems ?? turnItems) {
    if (item.kind !== "message" || item.channel !== "final" || !item.text.trim()) continue;
    if ((yielded || awaitingContinuation) && isYieldedWaitStub(item.text, waitSummaries)) continue;
    // Item ids are transcript positions; a rebuild that shifts entries re-keys
    // the same answer (same time, same text). Keep it under its first key.
    const text = item.text.trim().replace(/\s+/g, " ");
    const key = answersRef.current.byId.has(item.id) ? item.id : [...answersRef.current.byId].find(([, answer]) =>
      item.atMs != null && answer.atMs === item.atMs && answer.text.trim().replace(/\s+/g, " ") === text)?.[0] ?? item.id;
    const latched = answersRef.current.byId.get(key);
    if (!latched || item.text.length >= latched.text.length) answersRef.current.byId.set(key, item);
  }
  // The latest answer is `final` (drawn below, with its read identity). An
  // earlier answer whose reply the thread already shows is not drawn twice.
  const postedLeft = new Map<string, number>();
  for (const text of postedAnswerTexts ?? []) postedLeft.set(text, (postedLeft.get(text) ?? 0) + 1);
  const earlierAnswers = [...answersRef.current.byId.values()].filter((answer) => {
    if (final && (answer.atMs != null && final.atMs != null
      ? answer.atMs >= final.atMs
      : answer.text === final.text)) return false;
    const text = answer.text.trim().replace(/\s+/g, " ");
    const posted = postedLeft.get(text) ?? 0;
    if (posted > 0) {
      postedLeft.set(text, posted - 1);
      return false;
    }
    return true;
  });
  const responseReadIdentity = final && responseComment &&
    final.text === responseComment.text
    ? { id: responseComment.id, createdAtIso: responseComment.createdAtIso }
    : {};
  const timelineItems = paperclipRunnerTimelineItems(turnItems);
  const currentActivityItems = currentActivityStatusItems(timelineItems);
  const timelineRows = groupImageResources(buildTurnTimelineRows(
    omitProgressRepeatedByResponse(timelineItems, final?.text),
    !terminal,
    reasoningDisplay,
  ));

  const foldWork = status === "succeeded" && !yielded && !awaitingContinuation && reasoningDisplay !== "inline" &&
    !turnItems.some((item) => item.kind === "message" && item.streaming) &&
    timelineRows.some((row) => !isPersistentRunnerWorkItem(row));
  const visibleTimelineRows = foldWork && !workOpen
    ? timelineRows.filter(isPersistentRunnerWorkItem)
    : timelineRows;

  return (
    <TaskChatExpansionState.Provider value={sharedExpansion ?? localExpansion.current}>
    <TaskChatShimmerScope items={items}><div
      className="flex min-w-0 flex-col"
      data-testid="task-chat-runner-turn"
      data-phase={status === "queued" ? "startup" : undefined}
    >
      {showHeader ? <TaskChatRunnerHeader runId={runId} agentName={agentName} agentIcon={agentIcon} agent={agent}
        status={status} execution={execution} preparationLabel={preparationLabel} startedAtMs={startedAtMs}
        finishedAtMs={finishedAtMs} continuedAfterSteering={continuedAfterSteering}
        statusContent={foldWork ? (
          <button type="button" data-testid="task-chat-work-toggle" aria-expanded={workOpen}
            onClick={() => setWorkOpen((value) => !value)}
            className="flex min-h-8 min-w-0 items-center gap-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <RunnerTurnStatus status={status} startedAtMs={startedAtMs} finishedAtMs={finishedAtMs} continuedAfterSteering={continuedAfterSteering} />
            <ChevronRight className={cn("size-3.5 shrink-0", workOpen && "rotate-90")} aria-hidden />
          </button>
        ) : undefined} /> : null}
      <TaskChatRunHealthBanner failures={mcpStartupFailures} />
      {activityUnavailable ? (
        <div
          className="px-1 py-1 text-xs text-muted-foreground"
          role="status"
          data-testid="task-chat-activity-unavailable"
        >
          Live runner activity is temporarily unavailable. Retrying…
        </div>
      ) : null}
      {visibleTimelineRows.length > 0 ? (
        <div
          className="flex min-w-0 flex-col gap-2 py-1"
          data-testid="task-chat-turn-timeline"
        >
          {visibleTimelineRows.map((row) => (
            <div
              className="min-w-0"
              key={`${runId ?? "run"}:${row.id}`}
              data-testid="task-chat-turn-timeline-row"
              data-timeline-row-id={row.id}
              data-thread-anchor={row.id}
            >
              {row.kind === "activity_phase" ? (
                <TaskChatRunnerActivityGroup item={row} />
              ) : row.kind === "plan_document" ? (
                <TaskChatPlanPreviewCard
                  source={{ kind: "saved", document: row.document }}
                  testId={
                    row.placement === "fallback"
                      ? "task-chat-plan-preview-fallback"
                      : "task-chat-plan-preview"
                  }
                />
              ) : row.kind === "marker" ? (
                <TaskChatMarker item={row} />
              ) : row.kind === "subagent_group" ? (
                <TaskChatSubagentTree subagents={row.subagents} />
              ) : row.kind === "protocol" ? (
                <TaskChatProtocolCard
                  item={row}
                  onRuntimeRequestDecision={onRuntimeRequestDecision}
                />
              ) : row.kind === "thinking" ? (
                <TaskChatThinking item={row} inline={reasoningDisplay === "inline"} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <McpAppTurnViews runId={runId} refreshKey={mcpAppRunRefreshKey(turnItems, status)} />
      {earlierAnswers.map((answer) => (
        <div
          className="w-full"
          key={`${runId ?? "run"}:answer:${answer.id}`}
          data-testid="task-chat-earlier-response"
          data-answer-id={answer.id}
        >
          <TaskChatBubble
            item={{ ...answer, authorName: agentName ?? undefined, agentIcon, agent, timestamp: answer.timestamp ?? formatTaskChatTimestamp(answer.atMs) }}
            animateEntry={false}
            hideAgentIdentity={!continuedAfterSteering}
            actions={<TaskChatBubbleActions copyText={answer.text} />}
          />
        </div>
      ))}
      {final ? (
        <div
          className="w-full"
          data-testid="task-chat-final-response"
        >
          <TaskChatBubble
            item={{ ...final, ...responseReadIdentity, authorName: agentName ?? undefined, agentIcon, agent, timestamp: final.timestamp ?? formatTaskChatTimestamp(final.atMs) }}
            animateEntry={false}
            hideAgentIdentity={!continuedAfterSteering}
            actions={<TaskChatBubbleActions copyText={final.text} />}
          />
        </div>
      ) : null}
      {!final && currentActivityItems.length === 0 && !(status === "queued" && runId && (waitingLabel || agentQueueWaitFor({ status, execution })))
        ? <RunnerCurrentActivityTail status={status} waitingLabel={waitingLabel} /> : null}
    </div></TaskChatShimmerScope>
    </TaskChatExpansionState.Provider>
  );
}
