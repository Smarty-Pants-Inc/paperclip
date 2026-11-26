import type { GateDecision } from "../domain/policy.js";
import type {
  CancelStaleQueuedRunOutcome,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type DueRetryRun = {
  runId: string;
  companyId: string;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
};

export type EvaluateScheduledRetryGateInput = {
  runId: string;
  companyId: string;
  retryReasonOverride: string;
  now: Date;
};

/** Read-only scheduled-retry operations exposed to application use cases. */
export interface ScheduledRetryReader {
  nextScheduledRetryAt(input: { cutoff: Date | null }): Promise<number | null>;
  evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput): Promise<GateDecision>;
  listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]>;
}

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
};

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
  expectedStatus: "queued" | "running";
};

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  reservationId: string;
  recoveryLeaseOwner?: string;
  enforceContinuationOwnership?: boolean;
  /** Acquire configuration fences before authority locks. Defer issue content
   * checks to the returned callback, which MUST run after the coordinator and
   * optional ownership issue FOR UPDATE, before the run lock. Ordinary work
   * acquires its issue SHARE there; ownership needs no second issue lock.
   * The opaque transaction must not escape or perform provider I/O. */
  configurationFence?: (transaction: unknown, ownershipIssueId?: string | null) => Promise<void | (() => Promise<void>)>;
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; admissionBlockReason: string }
  | { dispatched: false; cancellation: CancelStaleQueuedRunOutcome };

/** Semantic database operations; persistence rows and transaction handles stay inside the adapter. */
export interface RunDispatchWriter {
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
  dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>>;
}
