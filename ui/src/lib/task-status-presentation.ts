import type { Issue, IssueBlockerAttention } from "@paperclipai/shared";

/** Read-only task evidence. Never use this presentation to admit or stop work. */
export interface TaskStatusPresentationInput {
  status: string;
  id?: string;
  displayStatus?: string | null;
  externalConversationState?: "active" | "waiting" | null;
  blockerAttention?: IssueBlockerAttention | null;
  unblockDescriptor?: Issue["unblockDescriptor"];
  blockedInboxAttention?: Issue["blockedInboxAttention"];
  interruption?: Issue["interruption"];
  /** Optional server authority; absent on older responses. Null/false means no human action. */
  actionRequired?: unknown;
}

export interface TaskStatusPresentation {
  /** Key into the unified StatusGlyph icon/colour tables. */
  glyphStatus: string;
  label: string;
  /** Full accessible/tooltip copy, including the next action or wait. */
  ariaLabel: string;
}

export function taskStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function waitingLabel(attention: IssueBlockerAttention | null | undefined): string {
  if (attention?.reason === "active_child") {
    if (attention.coveredBlockerCount === 1 && attention.sampleBlockerIdentifier) {
      return `Blocked · waiting on sub-task ${attention.sampleBlockerIdentifier}`;
    }
    return "Blocked · waiting on sub-tasks";
  }
  if (attention?.reason === "active_dependency") {
    return attention.sampleBlockerIdentifier
      ? `Blocked · waiting on dependency ${attention.sampleBlockerIdentifier}`
      : "Blocked · waiting on dependencies";
  }
  if (attention?.reason === "stalled_review") return "Blocked · waiting on review";
  // Compact responses can name a blocking task, but not who must act on it.
  const blocker = attention?.terminalBlocker?.identifier
    ?? attention?.sampleBlockerIdentifier ?? attention?.sampleStalledBlockerIdentifier;
  if (blocker) return `Blocked · waiting on ${blocker}`;
  if (attention && attention.unresolvedBlockerCount > 0) {
    return `Blocked · waiting on ${attention.unresolvedBlockerCount} ${attention.unresolvedBlockerCount === 1 ? "task" : "tasks"}`;
  }
  return "Blocked · waiting";
}

function personAction(input: TaskStatusPresentationInput): string | null {
  if (Object.hasOwn(input, "actionRequired")) {
    const required = input.actionRequired;
    // Presence is authoritative, including null/false. Never resurrect the
    // stop-gap from a stale descriptor after the server cleared the action.
    if (required === true) return "Take the requested action";
    if (required && typeof required === "object") {
      return "action" in required && typeof required.action === "string" && required.action.trim()
        ? required.action.trim() : "Take the requested action";
    }
    return null;
  }
  // Legacy evidence is valid only while the canonical task is blocked.
  if (input.status !== "blocked") return null;
  const descriptor = input.unblockDescriptor;
  if (descriptor && typeof descriptor.owner === "object" && "userId" in descriptor.owner && descriptor.owner.userId) {
    return descriptor.action.trim() || "Unblock this task";
  }

  // This is the task's own current human wait, not an inherited child alarm.
  const interruption = input.interruption;
  if (interruption?.state === "waiting_for_user" && interruption.responsibility === "user") {
    if (interruption.userAction === "question") return "Answer question";
    if (interruption.userAction === "approval") return "Decide approval";
  }

  const attention = input.blockedInboxAttention;
  if (input.id && attention?.state === "awaiting_decision" && attention.sourceIssue?.id === input.id
      && (!attention.leafIssue || attention.leafIssue.id === input.id)) {
    if (attention.approvalId) return attention.action.label || "Decide approval";
    // A generic board interaction can be an agent-resolvable suggestion. It is
    // not proof of a human question; the user-decision projection is.
    if (attention.interactionId && attention.reason === "pending_user_decision") {
      return attention.action.label || "Answer question";
    }
  }
  return null;
}

/**
 * One state → glyph/label rule. Until the server supplies actionRequired, only
 * blocked tasks with an explicit person owner or their own open human question /
 * approval are red. These inputs are task read results, not loading state:
 * absent ownership is a wait, never a resting checking sign. Blocker attention
 * names the wait but cannot identify a person. Missing data cannot hide a known action.
 * Current human-action evidence wins over pause evidence; other paused work stays paused.
 */
export function resolveTaskStatusPresentation(input: TaskStatusPresentationInput, context: "task" | "lifecycle" | "summary" = "task"): TaskStatusPresentation {
  const { status, displayStatus, externalConversationState, blockerAttention, interruption } = input;
  const action = personAction(input);
  if (!action && (status === "paused" || (status === "blocked"
      && interruption?.state === "waiting_for_user" && interruption.userAction === "resume"))) {
    return { glyphStatus: "paused", label: "Paused", ariaLabel: "Paused" };
  }
  // Completed/cancelled and optimistic canonical transitions win over stale
  // projections. Resolve task projections before applying lifecycle colour so
  // idle, monitoring and paused never revert to their raw stored status.
  const projectedStatus = status === "in_progress" ? (displayStatus ?? status) : status;
  if (projectedStatus === "blocked" || (projectedStatus === "paused" && action)) {
    // Static lanes/filter/picker options describe a lifecycle, not an emergency.
    if (context === "lifecycle") {
      return { glyphStatus: "blocked_lifecycle", label: "Blocked", ariaLabel: "Blocked" };
    }
    // Known task-owned human action wins even on a sparse read. Only the
    // explicit actionRequired authority (including null/false) can clear it.
    // Summaries use bounded, stable buckets, not one segment per action/child.
    const label = context === "summary"
      ? (action ? "Needs a person" : "Waiting")
      : (action ? `Person: ${action}` : waitingLabel(blockerAttention));
    // Aggregated counts are not emergencies; only the individual task is red.
    const glyphStatus = action ? (context === "summary" ? "blocked_lifecycle" : "blocked") : "in_queue";
    return { glyphStatus, label, ariaLabel: label };
  }
  const visibleStatus = projectedStatus === "in_review" && externalConversationState === "waiting"
    ? "idle"
    : projectedStatus;
  return { glyphStatus: visibleStatus, label: taskStatusLabel(visibleStatus), ariaLabel: taskStatusLabel(visibleStatus) };
}

/** Spread this on every task status surface so no view drops human-wait evidence. */
export function taskStatusIconProps(task: TaskStatusPresentationInput): TaskStatusPresentationInput {
  return {
    id: task.id,
    status: task.status,
    displayStatus: task.displayStatus ?? null,
    externalConversationState: task.externalConversationState ?? null,
    blockerAttention: task.blockerAttention ?? null,
    ...(Object.hasOwn(task, "unblockDescriptor") ? { unblockDescriptor: task.unblockDescriptor } : {}),
    blockedInboxAttention: task.blockedInboxAttention ?? null,
    interruption: task.interruption ?? null,
    ...(Object.hasOwn(task, "actionRequired") ? { actionRequired: task.actionRequired } : {}),
  };
}
