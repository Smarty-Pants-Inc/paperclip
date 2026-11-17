import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeftRight,
  CornerDownRight,
  GripVertical,
  Loader2,
  Pencil,
  Trash2,
  Zap,
} from "lucide-react";
import type {
  IssueQueuedCommentEntry,
  IssueQueuedCommentQueue,
} from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import { extractImageRefs, stripStandaloneImageEmbeds } from "./task-chat-attachments";
import { TaskChatComposerBar } from "./TaskChatComposerBar";
import {
  queuedMessageAutoSteerDeadline,
  queuedMessageAutoSteerEligible,
  queuedMessageAutoSteerKey,
} from "./queued-message-auto-steer";
import { isQueuedInterruptHandoff, QueuedMessagesChangedError } from "@/lib/issue-queued-comment-queue";

type QueueAction = "steer" | "interrupt" | "discard" | "intent" | null;
export const CHAT_STOPPED_BY_PERSON_REASON = "stopped_by_person";
export const CHAT_STOPPED_BY_PERSON_LINE = "Stopped. These messages are waiting: Send them, or delete any first.";

export function reorderQueuedMessageEntries(
  entries: IssueQueuedCommentEntry[],
  activeId: string,
  overId: string,
) {
  if (entries.some((entry) => entry.source?.kind === "interaction")) return null;
  const from = entries.findIndex((entry) => entry.comment.id === activeId);
  const to = entries.findIndex((entry) => entry.comment.id === overId);
  if (from < 0 || to < 0 || from === to) return null;
  return arrayMove(entries, from, to).map((entry, position) => ({
    ...entry,
    position,
  }));
}

/**
 * People see one readable line. A saved card response also carries a typed
 * JSON receipt for the agent; it never reaches a label or a hover.
 */
export function queuedMessageLabel(entry: IssueQueuedCommentEntry): string {
  if (entry.source?.kind !== "interaction") return entry.comment.body;
  const summary = entry.source.summary?.trim() || entry.comment.body.split("\n")[0] || "Saved response";
  if (entry.source.interactionKind !== "ask_user_questions") return summary;
  // The durable receipt carries the actual prompts, whereas its heading may
  // only be a generic card title (for example "Deployment choices"). Never
  // render the receipt itself, even if an older/malformed receipt cannot parse.
  try {
    const receipt = JSON.parse(entry.comment.body.slice(entry.comment.body.indexOf("\n\n") + 2));
    const questions = receipt?.payload?.questionSet?.questions ?? receipt?.payload?.questions;
    const prompts = Array.isArray(questions) ? questions.flatMap((question: unknown) => {
      const prompt = question && typeof question === "object" ? (question as { prompt?: unknown }).prompt : null;
      return typeof prompt === "string" && prompt.trim() ? [prompt.trim()] : [];
    }) : [];
    if (prompts.length) return `Your answer to: ${prompts.join("; ")}`;
  } catch { /* Older summaries still identify the card without exposing JSON. */ }
  return `Your answer to: ${summary.replace(/^Answered:\s*/, "")}`;
}

/** The server's own words for a refusal the person can act on (a paused chat). */
function queueActionErrorText(error: unknown): string | null {
  const body = typeof error === "object" && error !== null ? (error as { body?: unknown }).body : null;
  const text = typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
  return typeof text === "string" && text.trim() ? text : null;
}

function queueActionErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "object" || body === null) return null;
  const directCode = (body as { code?: unknown }).code;
  if (typeof directCode === "string") return directCode;
  const details = (body as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return null;
  const detailCode = (details as { code?: unknown }).code;
  return typeof detailCode === "string" ? detailCode : null;
}

export interface TaskChatQueuedMessagesProps {
  queue: IssueQueuedCommentQueue;
  onEdit: (commentId: string) => void;
  onReorder: (orderedCommentIds: string[], revision: string) => Promise<void>;
  onSteer: (commentId: string, revision: string) => Promise<void>;
  /** With a commentId: Interrupt now for that one message (it goes first; the rest stay queued). */
  onInterrupt?: (commentId?: string) => Promise<IssueQueuedCommentQueue | void>;
  onDiscard: (commentId: string, revision: string, queueId?: string) => Promise<void>;
  /** Stores a waiting message's mode (Steer or Queue) on the server. */
  onSetIntent?: (commentId: string, intent: "steer" | "queue") => Promise<void>;
  /** A read-only viewer sees the list without controls. */
  readOnly?: boolean;
  /** The queued message open in the editor; its automatic send waits for the save. */
  editingCommentId?: string | null;
  /** Steer eligible queued messages automatically after this delay; null keeps every message queued. */
  autoSteerDelayMs?: number | null;
  /** Agent Chat: steer automatically only the first queued message, keeping the sent order. */
  steerHeadOnly?: boolean;
}

export const RESET_ROW_CAPTION = "Starts a new conversation; always waits for this turn";
export const RESET_INTERRUPT_REASON = "Starts a new conversation; it waits for this turn. Use Stop to end the turn now";
export const BEHIND_RESET_INTERRUPT_REASON = "Behind /new: interrupting would send it into the current conversation";
export const BEHIND_RESET_STEER_REASON = "Can't move to Steering: this message is behind /new";
export const STEERING_PAUSED = "Steering paused: will send after this turn";

const isResetEntry = (entry: IssueQueuedCommentEntry) => entry.comment.body.trim() === "/new";
const intentOf = (entry: IssueQueuedCommentEntry): "steer" | "queue" =>
  isResetEntry(entry) || entry.source?.kind === "interaction" ? "queue" : entry.deliveryIntent ?? "steer";
const atOrBehindReset = (entry: IssueQueuedCommentEntry) => isResetEntry(entry) || entry.behindReset === true;

/**
 * Steering is always the head of the server order: the leading run of
 * Steer-mode messages ahead of any /new. The server steers one at a time in
 * that order, so everything after it waits for the turn boundary.
 */
export function steeringCount(entries: IssueQueuedCommentEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (intentOf(entry) !== "steer" || atOrBehindReset(entry) || entry.queueId) break;
    count += 1;
  }
  return count;
}

const ROW_BUTTON = "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45 max-sm:h-11 max-sm:min-w-11 max-sm:justify-center";

function SortableQueuedMessage({
  entry,
  queue,
  section,
  busy,
  queueMutationDisabled,
  readOnly,
  action,
  autoSteerSecondsLeft,
  pausedForEdit,
  steeringAvailable,
  canSetIntent,
  onEdit,
  onToggleIntent,
  onInterrupt,
  onDiscard,
  onCancelAutoSteer,
  sendOnLine,
}: {
  entry: IssueQueuedCommentEntry;
  queue: IssueQueuedCommentQueue;
  section: "steering" | "queued";
  busy: boolean;
  queueMutationDisabled: boolean;
  readOnly: boolean;
  action: QueueAction;
  /** Seconds until this message is steered automatically, or null when it waits in the queue. */
  autoSteerSecondsLeft: number | null;
  pausedForEdit: boolean;
  steeringAvailable: boolean;
  canSetIntent: boolean;
  onEdit: () => void;
  onToggleIntent: () => void;
  onInterrupt?: () => void;
  onDiscard: () => void;
  onCancelAutoSteer: () => void;
  /** After a person's Stop the one Send is under the list, not on each row. */
  sendOnLine: boolean;
}) {
  const immutableResponse = entry.source?.kind === "interaction";
  const reset = isResetEntry(entry);
  const behindReset = !reset && entry.behindReset === true;
  const tail = Boolean(entry.queueId);
  const body = queuedMessageLabel(entry);
  const images = extractImageRefs(body).filter(image =>
    /^\/api\/(?:attachments|assets)\/[^/?#\\]+\/content(?:\?[^#\\]*)?$/.test(image.url));
  const label = stripStandaloneImageEmbeds(body);
  const dragDisabledReason = readOnly ? "Only the conversation owner can reorder"
    : immutableResponse ? "A saved response keeps its place"
      : tail ? "Waits behind /new; it moves after /new starts"
        : !queue.queueId ? "Saving… reorder in a moment" : null;
  const sortable = useSortable({
    id: entry.comment.id,
    disabled: queueMutationDisabled || Boolean(dragDisabledReason),
  });
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const toTarget = section === "steering" ? "queue" : "steer";
  const toggleReason = !canSetIntent ? "Changing the mode is unavailable here"
    : toTarget === "steer" && behindReset ? BEHIND_RESET_STEER_REASON
      : toTarget === "steer" && immutableResponse ? "A saved response waits for this turn"
        : toTarget === "steer" && !steeringAvailable ? "This runner can't take messages mid-turn"
          : null;
  const idleQueue = !queue.targetRunId;
  const interruptReason = !onInterrupt ? "Interrupt is unavailable here"
    : reset ? RESET_INTERRUPT_REASON
      : behindReset || tail ? BEHIND_RESET_INTERRUPT_REASON
        : !queue.queueId ? "Saving… try again in a moment"
          : null;
  const editReason = immutableResponse ? "A saved response can't be edited"
    : tail ? "Edit it after /new starts"
      : !entry.canEdit ? "Only the author can edit this message" : null;
  const discardReason = !entry.canDiscard ? "Only the author can delete this message" : null;

  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={cn(
        "group flex min-h-11 min-w-0 flex-wrap items-center gap-1 rounded-lg bg-card/95 px-2 py-1 text-sm max-sm:py-2",
        sortable.isDragging && "relative z-20 ring-1 ring-border shadow-lg",
      )}
      data-testid={`task-chat-queued-message-${entry.comment.id}`}
      data-section={section}
      data-intent={intentOf(entry)}
    >
      {!readOnly ? <button
        type="button"
        ref={sortable.setActivatorNodeRef}
        {...sortable.attributes}
        {...sortable.listeners}
        disabled={queueMutationDisabled || Boolean(dragDisabledReason)}
        title={dragDisabledReason ?? "Drag to reorder, or into the other section to change its mode"}
        aria-label={`Reorder queued message: ${label || "Images"}`}
        className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing disabled:cursor-default disabled:opacity-40 max-sm:h-11 max-sm:w-11"
        data-testid={`task-chat-queued-grip-${entry.comment.id}`}
      >
        <GripVertical className="h-3.5 w-3.5" aria-hidden />
      </button> : null}

      <div className="flex min-w-24 max-w-full flex-1 flex-col items-start gap-0.5 overflow-hidden px-1" title={label || undefined}>
        {label ? <MarkdownBody
          className="w-full min-w-0 line-clamp-2 sm:line-clamp-1 [&_p]:m-0!"
          linkIssueReferences={false}
          mediaMode="omit"
        >{label}</MarkdownBody> : null}
        {reset ? <span className="text-xs text-muted-foreground" data-testid={`task-chat-queued-reset-caption-${entry.comment.id}`}>{RESET_ROW_CAPTION}</span> : null}
        {behindReset ? <span className="text-xs text-muted-foreground" data-testid={`task-chat-queued-behind-reset-caption-${entry.comment.id}`}>Behind /new: can't steer</span> : null}
        {images.length ? <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1" role="group" aria-label="Queued images">
          {images.slice(0, 3).map(image => <img
            key={image.url} src={image.url} alt={image.name} loading="lazy"
            className="size-8 shrink-0 rounded-md border border-border object-cover"
          />)}
          {images.length > 3 ? <span className="text-xs text-muted-foreground">+{images.length - 3}</span> : null}
        </div> : null}
      </div>

      {readOnly ? null : <div className="flex shrink-0 flex-wrap items-center gap-0.5 max-sm:w-full max-sm:justify-end">
        {autoSteerSecondsLeft !== null ? (
          <span className="flex shrink-0 items-center gap-0.5" data-testid={`task-chat-queued-auto-steer-${entry.comment.id}`}>
            <span className="px-1 text-xs text-muted-foreground tabular-nums">
              Steers in {autoSteerSecondsLeft}s
            </span>
            <button type="button" onClick={onCancelAutoSteer} title="Keep this message queued for after this turn"
              className={ROW_BUTTON} data-testid={`task-chat-queued-auto-steer-cancel-${entry.comment.id}`}>
              Cancel
            </button>
          </span>
        ) : pausedForEdit ? (
          <span className="px-1 text-xs text-muted-foreground" data-testid={`task-chat-queued-paused-${entry.comment.id}`}>Paused while editing</span>
        ) : null}
        {reset ? null : (
          <button
            type="button"
            onClick={onToggleIntent}
            disabled={busy || Boolean(toggleReason) || (toTarget === "steer" && !queue.queueId)}
            title={toggleReason ?? (toTarget === "steer"
              ? steeringAvailable ? "Move to Steering: delivered at the agent's next step" : "Move to Steering: sent when the runner can take it, or after this turn"
              : "Move to Queued: sent after the agent finishes this turn")}
            className={ROW_BUTTON}
            data-testid={`task-chat-queued-mode-${entry.comment.id}`}
          >
            {action === "intent" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ArrowLeftRight className="h-3.5 w-3.5" aria-hidden />}
            {toTarget === "steer" ? "Steer" : "Queue"}
          </button>
        )}
        {sendOnLine ? null : <button
          type="button"
          onClick={onInterrupt}
          aria-label={idleQueue ? "Send queued messages" : `Interrupt now: ${label || "Images"}`}
          disabled={busy || Boolean(interruptReason)}
          title={interruptReason ?? (idleQueue ? "Send queued messages now" : "Stops the current step and sends this message first; the rest stay queued")}
          className={ROW_BUTTON}
          data-testid={`task-chat-queued-interrupt-${entry.comment.id}`}
        >
          {action === "interrupt" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : idleQueue ? <CornerDownRight className="h-3.5 w-3.5" aria-hidden /> : <Zap className="h-3.5 w-3.5" aria-hidden />}
          {idleQueue ? "Send" : "Interrupt now"}
        </button>}
        <button
          type="button"
          onClick={onEdit}
          disabled={Boolean(editReason)}
          title={editReason ?? (autoSteerSecondsLeft !== null ? "Edit before it is sent (pauses the countdown)" : "Edit message")}
          aria-label={`Edit queued message: ${label}`}
          className={cn(ROW_BUTTON, "w-7 justify-center px-0")}
          data-testid={`task-chat-queued-edit-${entry.comment.id}`}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={busy || Boolean(discardReason)}
          title={discardReason ?? "Delete queued message"}
          aria-label={`Delete queued message: ${label}`}
          className={cn(ROW_BUTTON, "w-7 justify-center px-0 hover:bg-destructive/10 hover:text-destructive")}
          data-testid={`task-chat-queued-discard-${entry.comment.id}`}
        >
          {action === "discard" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>}
    </div>
  );
}

/** Compact production queue shown immediately above the default task composer. */
export function TaskChatQueuedMessages({
  queue,
  onEdit,
  onReorder,
  onSteer,
  onInterrupt,
  onDiscard,
  onSetIntent,
  readOnly = false,
  editingCommentId = null,
  autoSteerDelayMs = null,
  steerHeadOnly = false,
}: TaskChatQueuedMessagesProps) {
  const [entries, setEntries] = useState(queue.entries);
  // Automatic steering: Cancel keeps a message queued for this view; each
  // message revision gets at most one automatic attempt, so a failure falls
  // back to the ordinary queue instead of retrying in a loop.
  const [cancelledAutoSteer, setCancelledAutoSteer] = useState<ReadonlySet<string>>(() => new Set());
  const attemptedAutoSteer = useRef(new Set<string>());
  // Recomputes the deadlines after an attempt; the set itself is a ref.
  const [autoSteerAttempts, setAutoSteerAttempts] = useState(0);
  // First time this view offered each message revision for automatic steering.
  const firstEligibleAt = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const latestQueue = useRef(queue);
  latestQueue.current = queue;
  const optimisticDeliveryIds = useRef(new Set<string>());
  const [pending, setPending] = useState<{
    commentId: string;
    action: Exclude<QueueAction, null>;
  } | null>(null);
  const [reordering, setReordering] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [visibleError, setVisibleError] = useState<string | null>(null);
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  const [deferredStatus, setDeferredStatus] = useState<{ queueId: string | null; message: string } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    // Polling can return the old queue while delivery is still in flight.
    setEntries(queue.entries.filter(
      (entry) => !optimisticDeliveryIds.current.has(entry.comment.id),
    ));
  }, [queue.entries, queue.revision]);

  useEffect(() => {
    setDeferredStatus(current => {
      if (!current) return null;
      if (queue.state !== "deferred" || queue.queueId !== current.queueId || !queue.entries.length) return null;
      const message = queue.executionWait?.message ?? "Messages are still queued. They will send when the task is ready.";
      return current.message === message ? current : { ...current, message };
    });
  }, [queue.state, queue.queueId, queue.entries.length, queue.executionWait?.message]);

  const ids = useMemo(
    () => entries.map((entry) => entry.comment.id),
    [entries],
  );

  // Send decisions read the current queue snapshot, not the local copy that a
  // sync effect updates one render later: a saved edit must get its new
  // revision's full window, not the old revision's deadline.
  const autoSteerEntries = useMemo(
    () => queue.entries.filter((entry) => !optimisticDeliveryIds.current.has(entry.comment.id)),
    [queue.entries],
  );
  const autoSteerDeadlines = useMemo(() => {
    const deadlines = new Map<string, number>();
    if (autoSteerDelayMs === null || readOnly) return deadlines;
    // Only the Steering section (the head of the server order) steers.
    const steering = new Set(autoSteerEntries.slice(0, steeringCount(autoSteerEntries)).map((entry) => entry.comment.id));
    for (const entry of autoSteerEntries) {
      if (steering.has(entry.comment.id) && queuedMessageAutoSteerEligible({ queue, entry, cancelledIds: cancelledAutoSteer,
        attemptedKeys: attemptedAutoSteer.current, editingCommentId, headOnly: steerHeadOnly })) {
        const key = queuedMessageAutoSteerKey(entry);
        if (!firstEligibleAt.current.has(key)) firstEligibleAt.current.set(key, Date.now());
        deadlines.set(entry.comment.id, queuedMessageAutoSteerDeadline(entry, firstEligibleAt.current.get(key)!, autoSteerDelayMs));
      }
    }
    return deadlines;
  }, [autoSteerEntries, queue, cancelledAutoSteer, editingCommentId, autoSteerDelayMs, autoSteerAttempts, steerHeadOnly, readOnly]);

  // Announce a new countdown once; the ticking text itself is not a live region.
  const announcedCountdowns = useRef(new Set<string>());
  useEffect(() => {
    const fresh = [...autoSteerDeadlines.keys()].filter(id => !announcedCountdowns.current.has(id));
    for (const id of fresh) announcedCountdowns.current.add(id);
    if (fresh.length) setAnnouncement("Queued message will be sent into the active turn in a few seconds. Edit or Cancel to keep it.");
  }, [autoSteerDeadlines]);

  // Tick only while a countdown is visible.
  useEffect(() => {
    if (autoSteerDeadlines.size === 0) return;
    // A countdown that restarts after an edit must not read a clock that stopped while it paused.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [autoSteerDeadlines.size]);

  useEffect(() => {
    if (pending || reordering) return;
    const due = autoSteerEntries.find(entry => {
      const deadline = autoSteerDeadlines.get(entry.comment.id);
      // The deadlines memo does not see these refs change; check them here.
      return deadline !== undefined && deadline <= now
        && !attemptedAutoSteer.current.has(queuedMessageAutoSteerKey(entry))
        && !optimisticDeliveryIds.current.has(entry.comment.id);
    });
    if (!due) return;
    attemptedAutoSteer.current.add(queuedMessageAutoSteerKey(due));
    setAutoSteerAttempts((count) => count + 1);
    void runRowAction(due.comment.id, "steer");
  });

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (
      !queue.queueId ||
      !over ||
      active.id === over.id ||
      reordering ||
      pending
    )
      return;
    const previous = entries;
    const activeCommentId = String(active.id);
    const moved = entries.find((entry) => entry.comment.id === activeCommentId);
    const from = entries.findIndex((entry) => entry.comment.id === activeCommentId);
    const overIndex = entries.findIndex((entry) => entry.comment.id === String(over.id));
    if (!moved || overIndex < 0) return;
    // The drop takes the section of the row it lands on.
    const steeringRows = steeringCount(entries);
    const fromSection = from < steeringRows ? "steering" : "queued";
    const toSection = overIndex < steeringRows ? "steering" : "queued";
    if (toSection === "steering" && fromSection === "queued" && (atOrBehindReset(moved) || moved.source?.kind === "interaction")) {
      setVisibleError(isResetEntry(moved) ? "Can't move to Steering: /new always waits for this turn" : BEHIND_RESET_STEER_REASON);
      return;
    }
    const intentChange: "steer" | "queue" | null = toSection !== fromSection ? (toSection === "steering" ? "steer" : "queue") : null;
    const reordered = reorderQueuedMessageEntries(entries, activeCommentId, String(over.id));
    if (!reordered) return;
    const next = intentChange
      ? reordered.map((entry) => entry.comment.id === activeCommentId ? { ...entry, deliveryIntent: intentChange } : entry)
      : reordered;
    // The order route reorders the queue's own wake; rows behind a /new keep their wakes.
    const orderedIds = next.filter((entry) => !entry.queueId).map((entry) => entry.comment.id);
    const to = next.findIndex((entry) => entry.comment.id === activeCommentId);
    setEntries(next);
    setReordering(true);
    setVisibleError(null);
    setAnnouncement(
      intentChange
        ? `Moved queued message to ${intentChange === "steer" ? "Steering" : "Queued"}.`
        : `Moved queued message to position ${to + 1} of ${next.length}.`,
    );
    try {
      await onReorder(orderedIds, queue.revision);
      if (intentChange) {
        if (!onSetIntent) throw new Error("Changing the mode is unavailable.");
        await onSetIntent(activeCommentId, intentChange);
      }
    } catch (error) {
      setEntries(previous);
      setAnnouncement("");
      setVisibleError(
        queueActionErrorCode(error) === "queued_comment_revision_conflict"
          ? "The queue changed in another session. Its latest order has been restored."
          : "Couldn’t reorder. Previous order restored.",
      );
    } finally {
      setReordering(false);
    }
  }

  /**
   * The row's Steer/Queue toggle. Steering is the head of the order, so a
   * message moving to Steering goes to the end of Steering, and one leaving
   * it goes to the top of Queued. The order is saved first, then the mode.
   */
  async function changeIntent(commentId: string) {
    const entry = entries.find((candidate) => candidate.comment.id === commentId);
    if (!entry || !onSetIntent) return;
    const steeringRows = steeringCount(entries);
    const from = entries.indexOf(entry);
    const intent: "steer" | "queue" = from < steeringRows ? "queue" : "steer";
    if (intent === "steer" && (atOrBehindReset(entry) || entry.source?.kind === "interaction")) {
      setVisibleError(BEHIND_RESET_STEER_REASON);
      return;
    }
    const previous = entries;
    const others = entries.filter((candidate) => candidate !== entry);
    const insertAt = intent === "steer" ? steeringRows : steeringRows - 1;
    const next = [...others.slice(0, insertAt), { ...entry, deliveryIntent: intent }, ...others.slice(insertAt)]
      .map((candidate, position) => ({ ...candidate, position }));
    const orderedIds = next.filter((candidate) => !candidate.queueId).map((candidate) => candidate.comment.id);
    const orderChanged = orderedIds.join() !== previous.filter((candidate) => !candidate.queueId).map((candidate) => candidate.comment.id).join();
    setEntries(next);
    setPending({ commentId, action: "intent" });
    setVisibleError(null);
    try {
      if (orderChanged) await onReorder(orderedIds, queue.revision);
      await onSetIntent(commentId, intent);
      if (intent === "queue") setCancelledAutoSteer((current) => new Set(current).add(commentId));
      else setCancelledAutoSteer((current) => { const copy = new Set(current); copy.delete(commentId); return copy; });
      setAnnouncement(intent === "steer" ? "Moved to Steering." : "Moved to Queued. It will be sent after this turn.");
    } catch (error) {
      setEntries(previous);
      setVisibleError(queueActionErrorCode(error) === "conversation_behind_reset" ? BEHIND_RESET_STEER_REASON
        : "Couldn’t change how this message is sent. It is unchanged.");
    } finally {
      setPending(null);
    }
  }

  async function runRowAction(
    commentId: string,
    action: Exclude<QueueAction, null>,
  ) {
    if (
      pending ||
      reordering ||
      (!queue.queueId && action !== "interrupt" && action !== "discard")
    ) {
      return;
    }
    const target = entries.find((entry) => entry.comment.id === commentId);
    if (action === "interrupt" && (optimisticDeliveryIds.current.has(commentId)
      || !latestQueue.current.entries.some((entry) => entry.comment.id === commentId))) {
      setDeliveryNotice("Nothing is waiting.");
      return;
    }
    setDeliveryNotice(null);
    // Interrupt now sends this one message first; with no running turn, Send sends them all.
    const oneMessageInterrupt = action === "interrupt" && Boolean(queue.targetRunId);
    if (action === "intent") return void changeIntent(commentId);
    const deliveredIds = action === "interrupt"
      ? oneMessageInterrupt ? [commentId] : entries.map((entry) => entry.comment.id)
      : action === "steer" ? [commentId] : [];
    for (const id of deliveredIds) optimisticDeliveryIds.current.add(id);
    if (deliveredIds.length) {
      setEntries((current) => current.filter(
        (entry) => !optimisticDeliveryIds.current.has(entry.comment.id),
      ));
    }
    setPending({ commentId, action });
    setVisibleError(null); setDeferredStatus(null);
    setAnnouncement(
      action === "steer"
        ? "Steering queued message."
        : action === "interrupt"
          ? oneMessageInterrupt ? "Interrupting to send this message first." : "Sending queued messages."
          : "Discarding queued message.",
    );
    try {
      if (action === "steer") await onSteer(commentId, queue.revision);
      else if (action === "interrupt") {
        const updatedQueue = await (oneMessageInterrupt ? onInterrupt?.(commentId) : onInterrupt?.());
        // The stopped turn is handing off to these messages: they are sent.
        if (updatedQueue?.state === "deferred" && !isQueuedInterruptHandoff(updatedQueue)) {
          for (const entry of updatedQueue.entries) optimisticDeliveryIds.current.delete(entry.comment.id);
          setEntries(updatedQueue.entries.filter(entry => !optimisticDeliveryIds.current.has(entry.comment.id)));
          setDeferredStatus({ queueId: updatedQueue.queueId, message: updatedQueue.executionWait?.message ?? "Messages are still queued. They will send when the task is ready." });
          setAnnouncement("Messages are still queued.");
          return;
        }
      }
      else if (target?.queueId) await onDiscard(commentId, target.queueRevision ?? queue.revision, target.queueId);
      else await onDiscard(commentId, queue.revision);
      if (action === "discard") {
        setEntries((current) =>
          current.filter((entry) => entry.comment.id !== commentId),
        );
      }
      setAnnouncement(
        action === "steer"
          ? "Message steered into the active turn."
          : action === "interrupt"
            ? queue.targetRunId
              ? oneMessageInterrupt ? "This message will be sent first when the current step stops. The rest stay queued."
                : "Queued messages will be sent when the previous run has stopped."
              : "Queued messages submitted. Waiting for the agent."
            : "Queued message discarded.",
      );
    } catch (error) {
      for (const id of deliveredIds) optimisticDeliveryIds.current.delete(id);
      if (deliveredIds.length) {
        setEntries(latestQueue.current.entries.filter(
          (entry) => !optimisticDeliveryIds.current.has(entry.comment.id),
        ));
      }
      setAnnouncement("");
      if (error instanceof QueuedMessagesChangedError) {
        setEntries(error.queue.entries);
        setDeliveryNotice(error.message);
        return;
      }
      const code = queueActionErrorCode(error);
      setVisibleError(
        code === "queued_comment_chat_paused"
          ? queueActionErrorText(error) ?? "This chat is paused. Resume it to send these messages."
          : code === "queued_comment_already_dispatching"
          ? "Too late to discard: this message is already being sent."
          : action === "steer"
            ? "Couldn’t steer. Message is still queued."
            : action === "interrupt"
              ? queue.targetRunId ? "Couldn’t interrupt. Message is still queued." : "Couldn’t send. Message is still queued."
              : code === "queued_comment_revision_conflict"
                ? "The queue changed in another session. Review it and try again."
                : "Couldn’t discard. Message is still queued.",
      );
    } finally {
      setPending(null);
    }
  }

  // A chat message held in the outbox (for example by the agent's daily
  // limit) has no receipt or run whose task status could explain the wait,
  // so the queue says why it waits. Receipt-backed waits keep the task status.
  const statusMessage = deferredStatus?.message
    ?? (queue.state === "deferred" && !queue.queueId && !queue.targetRunId && entries.length > 0
      ? queue.executionWait?.message ?? null : null);

  // Stop means stop: keep the queue layout and captions, but offer one Send
  // for the whole stopped queue, never a per-row Interrupt with no turn.
  const stoppedByPerson = queue.executionWait?.reason === CHAT_STOPPED_BY_PERSON_REASON &&
    Boolean(queue.queueId) && !queue.targetRunId && entries.length > 0 && Boolean(onInterrupt);

  if (entries.length === 0 && !visibleError && !statusMessage && !deliveryNotice) return null;
  const steeringRows = steeringCount(entries);

  return (
    <TaskChatComposerBar
      data-testid="task-chat-queued-messages"
      aria-label="Queued messages"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {/* Bounded so a long queue scrolls here instead of covering the conversation. */}
          <div
            className="max-h-(--tc-queued-list-max-h) overflow-y-auto overscroll-contain"
            data-testid="task-chat-queued-messages-list"
          >
          {(["steering", "queued"] as const).map((section) => {
            const rows = section === "steering" ? entries.slice(0, steeringRows) : entries.slice(steeringRows);
            const paused = section === "steering" && rows.length > 0 && Boolean(queue.targetRunId)
              && queue.steeringDisposition !== "available";
            return (
              <section
                key={section}
                aria-label={section === "steering" ? "Steering" : "Queued"}
                data-testid={`task-chat-queued-section-${section}`}
                className={cn("flex flex-col gap-0.5 px-1.5 py-1", section === "queued" && "mt-px")}
              >
                {section === "queued" ? <div aria-hidden className="mx-1 mb-1 h-px bg-border/70" /> : null}
                <h3 className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 px-1.5 pt-0.5 text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{section === "steering" ? "Steering" : "Queued"}</span>
                  <span className="tabular-nums" data-testid={`task-chat-queued-count-${section}`}>{rows.length}</span>
                  {paused ? <span className="rounded-md bg-muted px-2 py-0.5 font-medium text-foreground" data-testid="task-chat-queued-steering-paused">{STEERING_PAUSED}</span>
                    : section === "queued" || rows.length > 0 ? <span className="font-normal max-sm:basis-full">{section === "steering"
                      ? "Always first. Delivered at the agent's next step, top first"
                      : "Sent after the agent finishes this turn, top first"}</span> : null}
                </h3>
                {rows.length === 0 ? (
                  <p className="px-1.5 pb-1 text-xs text-muted-foreground">
                    {section === "steering"
                      ? queue.steeringDisposition !== "available"
                        ? "This runner can't take messages mid-turn, so everything waits in the queue. Use Interrupt now to send one first."
                        : readOnly ? "Nothing steering." : "Nothing steering. Drag a message here, or press Steer on it."
                      : "Nothing queued."}
                  </p>
                ) : rows.map((entry) => {
                  const action = pending?.commentId === entry.comment.id ? pending.action : null;
                  const busy = Boolean(pending || reordering);
                  const queueMutationDisabled = Boolean(!queue.queueId || pending || reordering);
                  const deadline = autoSteerDeadlines.get(entry.comment.id);
                  return (
                    <SortableQueuedMessage
                      key={entry.comment.id}
                      entry={entry}
                      queue={queue}
                      section={section}
                      busy={busy}
                      queueMutationDisabled={queueMutationDisabled}
                      readOnly={readOnly}
                      action={action}
                      autoSteerSecondsLeft={deadline === undefined ? null : Math.max(0, Math.ceil((deadline - now) / 1000))}
                      pausedForEdit={section === "steering" && editingCommentId === entry.comment.id && autoSteerDelayMs !== null}
                      steeringAvailable={queue.steeringDisposition === "available"}
                      canSetIntent={Boolean(onSetIntent)}
                      onCancelAutoSteer={() => {
                        setCancelledAutoSteer(current => new Set(current).add(entry.comment.id));
                        // Cancel keeps it queued everywhere, not only in this view.
                        if (onSetIntent) void runRowAction(entry.comment.id, "intent");
                      }}
                      onEdit={() => onEdit(entry.comment.id)}
                      onToggleIntent={() => void runRowAction(entry.comment.id, "intent")}
                      onInterrupt={onInterrupt ? () => void runRowAction(entry.comment.id, "interrupt") : undefined}
                      onDiscard={() => void runRowAction(entry.comment.id, "discard")}
                      sendOnLine={stoppedByPerson}
                    />
                  );
                })}
              </section>
            );
          })}
          </div>
        </SortableContext>
      </DndContext>
      {statusMessage ? <p role="status" className="px-3 py-1.5 text-xs text-muted-foreground">{statusMessage}</p> : null}
      {deliveryNotice ? <p role="status" className="px-3 py-1.5 text-xs text-muted-foreground">{deliveryNotice}</p> : null}
      {stoppedByPerson ? (
        <div
          className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="task-chat-queued-stopped"
        >
          <p role="status" className="min-w-0 flex-1">{CHAT_STOPPED_BY_PERSON_LINE}</p>
          {!readOnly ? <button
            type="button"
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
            disabled={Boolean(pending || reordering)}
            onClick={() => void runRowAction(entries[0]!.comment.id, "interrupt")}
            aria-label="Send the waiting messages"
            data-testid="task-chat-queued-stopped-send"
          >
            {pending?.action === "interrupt" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            Send
          </button> : null}
        </div>
      ) : null}
      {visibleError ? (
        <div
          role="status"
          aria-live="polite"
          className="bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
        >
          {visibleError}
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </TaskChatComposerBar>
  );
}
