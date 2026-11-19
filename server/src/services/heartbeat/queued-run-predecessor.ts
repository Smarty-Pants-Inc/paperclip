import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { WORKSPACE_SYNC_OUT_STALL_KEY } from "../../agent-run-cancellation.js";
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

/** What a release producer reads of a predecessor run: one row shape, selected with PREDECESSOR_RELEASE_COLUMNS. */
export type PredecessorReleaseRow = { id: string; status: string | null; errorCode: string | null; copyBackBoundWorkspace: boolean };
export const PREDECESSOR_RELEASE_COLUMNS = {
  id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
  // The copy-back bound's marker (native-run-finalizer.ts): a fenced epoch, or a classic run's isolated root and box.
  copyBackBoundWorkspace: sql<boolean>`jsonb_typeof(${heartbeatRuns.resultJson} #> array[${WORKSPACE_SYNC_OUT_STALL_KEY}::text, 'workspace']) = 'object'`,
};
/** A producer of a predecessor release: a durable or in-process fact that an ENDED predecessor, whose executor is
 * still live in this process (a hung copy-back, a teardown), holds nothing the next input uses.
 * `cleanup: "still_holds"`: only the live executor is released; the predecessor's pending cleanup still holds.
 * `cleanup: "released"`: its cleanup continues on resources the next input never reuses, and does not hold either. */
export type PredecessorReleaseProducer = {
  name: string;
  cleanup: "still_holds" | "released";
  released(previous: PredecessorReleaseRow): boolean;
};
/** A run the copy-back bound ended keeps a live executor (its hung copy-back) for as long as that hangs. It owns
 * nothing of the task any more: its epoch is fenced, or its root and box are isolated from the next run. */
export const COPY_BACK_BOUND_RELEASE: PredecessorReleaseProducer = {
  name: "copy_back_bound", cleanup: "still_holds", released: previous => previous.copyBackBoundWorkspace === true,
};
export const PREDECESSOR_RELEASE_PRODUCERS: readonly PredecessorReleaseProducer[] = [COPY_BACK_BOUND_RELEASE];
/** The ONE reader of "this ended predecessor no longer holds the next input", for both checks of the claim
 * (heartbeat/queue.ts: the in-process settling owner, and queuedRunPredecessorHold below). A run that has not
 * ended is never released, whatever a producer says. */
export function readPredecessorRelease(previous: PredecessorReleaseRow | null | undefined,
  producers: readonly PredecessorReleaseProducer[] = PREDECESSOR_RELEASE_PRODUCERS): PredecessorReleaseProducer | null {
  if (!previous || !isHeartbeatRunTerminalStatus(previous.status)) return null;
  return producers.find(producer => producer.released(previous)) ?? null;
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
  /** The claim's release producers (default: the copy-back bound only). */
  releaseProducers?: readonly PredecessorReleaseProducer[];
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
      errorCode: PREDECESSOR_RELEASE_COLUMNS.errorCode, copyBackBoundWorkspace: PREDECESSOR_RELEASE_COLUMNS.copyBackBoundWorkspace,
      contextIssueId: sql<unknown>`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`,
    })
      .from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, previousRunId),
        eq(heartbeatRuns.companyId, run.companyId),
      ));
    if (previousRunId !== executionOwnerId && (previous?.agentId !== run.agentId ||
        (previous.nativeIssueId ?? previous.issueId ?? previous.contextIssueId) !== issueId)) continue;
    // The one release reader: an ended predecessor a producer released does not hold this run by its live executor.
    const release = previous ? readPredecessorRelease({ id: previousRunId, status: previous.status, errorCode: previous.errorCode,
      copyBackBoundWorkspace: previous.copyBackBoundWorkspace }, input.releaseProducers) : null;
    if (release?.cleanup === "released" && isTerminal(previous?.status)) continue;
    // A terminal result can precede workspace/lease cleanup on this or
    // another controller. Local absence alone is not a release receipt.
    if (!isTerminal(previous?.status) ||
        (isLive(previousRunId) && !release)) {
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
