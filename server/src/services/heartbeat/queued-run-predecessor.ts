import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { hasPendingRunCleanup } from "../execution-blocker.js";
import { isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";

export type QueuedRunPredecessorHold = {
  reason: "predecessor_still_executing" | "predecessor_cleanup_pending";
  predecessorRunId: string;
};

/** The issue execution claim's ownership test (heartbeat/queue.ts claimQueuedRun). */
export function queuedRunOwnsIssue(assigneeAgentId: string | null | undefined, runAgentId: string, wakeReason: unknown) {
  return assigneeAgentId === runAgentId && wakeReason !== "source_scoped_recovery_action";
}

/** The ONE predecessor decision of the issue execution claim: is this queued
 * run held by a predecessor (its task's execution owner, or the run it
 * retries) that is still executing or whose cleanup is unsettled? The claim
 * (heartbeat/queue.ts) declines with the returned reason; the task card
 * (task-interruption-presentation.ts) names the same hold. */
export async function queuedRunPredecessorHold(db: Db, input: {
  run: { id: string; companyId: string; agentId: string; retryOfRunId: string | null; scheduledRetryReason: string | null };
  issueId: string | null;
  ownsIssue: boolean;
  executionRunId: string | null | undefined;
  isTerminal?: (status: string | null | undefined) => boolean;
  isLive?: (runId: string) => boolean;
}): Promise<QueuedRunPredecessorHold | null> {
  const { run, issueId, ownsIssue } = input;
  const isTerminal = input.isTerminal ?? isHeartbeatRunTerminalStatus;
  const isLive = input.isLive ?? (() => false);
  const executionOwnerId = run.scheduledRetryReason === "native_provider_overloaded"
    ? run.retryOfRunId : ownsIssue ? input.executionRunId : null;
  for (const previousRunId of new Set([executionOwnerId, ownsIssue ? run.retryOfRunId : null])) {
    if (!previousRunId || previousRunId === run.id) continue;
    const [previous] = await db.select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId,
      issueId: heartbeatRuns.issueId, nativeIssueId: heartbeatRuns.nativeIssueId,
      supersededByFreshContinuation: sql<boolean>`${heartbeatRuns.resultJson} ? 'freshContinuationSupersededAt'`,
      contextIssueId: sql<unknown>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
    })
      .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, previousRunId),
        eq(heartbeatRuns.companyId, run.companyId),
      ));
    if (previousRunId !== executionOwnerId && (previous?.agentId !== run.agentId ||
        (previous.nativeIssueId ?? previous.issueId ?? previous.contextIssueId) !== issueId)) continue;
    // A terminal result can precede workspace/lease cleanup on this or
    // another controller. Local absence alone is not a release receipt.
    if (!isTerminal(previous?.status) ||
        isLive(previousRunId)) {
      return { reason: "predecessor_still_executing", predecessorRunId: previousRunId };
    }
    // A fresh continuation replaced the predecessor: its writes are revoked
    // and it shares no workspace with this run (a fenced remote epoch or a
    // new isolated workspace), so its cleanup continues without holding it.
    if (!previous?.supersededByFreshContinuation && await hasPendingRunCleanup(db, run.companyId, previousRunId)) {
      return { reason: "predecessor_cleanup_pending", predecessorRunId: previousRunId };
    }
  }
  return null;
}
