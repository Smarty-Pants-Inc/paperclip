import type { heartbeatRuns, issues } from "@paperclipai/db";
import { isConversationAdapter } from "./conversation-continuation.js";

export function explicitContinuationAdapterEligible(adapterType: string | null | undefined): boolean {
  return Boolean(adapterType && (adapterType === "paperclip_runner" || isConversationAdapter(adapterType)));
}

type Task = Pick<typeof issues.$inferSelect, "id" | "status" | "assigneeAgentId">;
type Source = Pick<typeof heartbeatRuns.$inferSelect,
  "agentId" | "status" | "runtimeMode" | "nativeIssueId" | "issueId" | "contextSnapshot" | "finishedAt">;

/** The admission owner's task gate. Queued Send has separate authority to reopen done tasks. */
export function explicitContinuationTaskEligible(task: Task | null | undefined, agentId: string,
  queuedInterrupt = false): task is Task {
  return Boolean(task && task.assigneeAgentId === agentId && task.status !== "cancelled"
    && (task.status !== "done" || queuedInterrupt));
}

/** Source identity/settlement gate shared by admission and its read-only capability projection. */
export function explicitContinuationSourceEligible(run: Source | null | undefined, issueId: string,
  agentId: string): run is Source & { finishedAt: Date } {
  return Boolean(run && run.agentId === agentId && ["failed", "interrupted", "timed_out", "cancelled"].includes(run.status)
    && (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) === issueId && run.finishedAt);
}

/** A new person's message requests a native turn, never replay of the old run.
 * Eligibility grants no dispatch authority: admission still verifies the actual
 * author/message, stop/cleanup receipts, decisions and controller under lock.
 */
export function canContinueNativeRunWithMessage(task: Task | null | undefined, run: Source | null | undefined,
  adapterType: string | null | undefined): boolean {
  return Boolean(explicitContinuationAdapterEligible(adapterType)
    && run?.runtimeMode === "native" && explicitContinuationTaskEligible(task, run.agentId)
    && explicitContinuationSourceEligible(run, task.id, run.agentId));
}
