/** The lifecycle controls admission. Execution status describes current work. */
export const AGENT_LIFECYCLE_STATES = [
  "pending_approval", "preparing", "verifying", "ready", "pausing", "paused",
  "resuming", "terminating", "cleaning_up", "terminated", "rejected",
] as const;
export type AgentLifecycleState = typeof AGENT_LIFECYCLE_STATES[number];

export interface AgentLifecycleOperation {
  id: string;
  resumeState?: "preparing" | "verifying" | "ready";
  hostComplete: boolean;
  completedPluginIds: string[];
  leaseOwner?: string;
  leaseUntil?: string;
  /** The controller process holding the lease; restart recovery settles it once proven gone. */
  leaseHolder?: { bootId: string; pid: number; hostHash: string; processStartedAt: string | null };
  retryAt?: string;
  /** Healthy host verification awaits a durable external producer, not a retry timer. */
  waitingForSignal?: boolean;
  /** A committed recheck raced an active host attempt; its defer must not park it. */
  recheckRequested?: boolean;
  /** A failed or stalled lifecycle step waits for repair or an explicit retry. */
  retryRequired?: boolean;
  /** Failed generic host verification tests for this saved configuration. */
  verificationFailures?: number;
  /** First consecutive non-budgeted host failure in this operation; survives worker restarts. */
  transientFailureSince?: string;
  /** Consecutive non-budgeted host failures, independent of claims and the verification budget. */
  transientFailures?: number;
  /** Incomplete host/plugin Stop attempts for this saved operation. */
  stopFailures?: number;
  attempts: number;
  responsibleUserId?: string | null;
  /** Why a pause started: its holds and the company's pause reason at that moment. Runs the
   * pause stops record it, so a budget resume continues only work its own budget stopped. */
  pauseCause?: { holds: string[]; companyPauseReason: string | null };
  /** Who asked for a termination. The terminal step's `agent.terminated` audit row names this caller. */
  requestedBy?: AgentLifecycleRequester;
  /** Written with the terminal state in the same transaction. The hand-over recovery worker clears it
   * only when no open task and no live report remains on the retired agent. */
  handover?: AgentHandoverMarker;
}

export interface AgentLifecycleRequester {
  actorType: "user" | "agent" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
}

/** The named pending code a retired agent shows until its work and reports are handed over. */
export interface AgentHandoverMarker {
  code: "agent_handover_pending";
  since: string;
  /** Items the recovery worker could not move yet, each with why and when it tries again. */
  blocked?: AgentHandoverBlockedItem[];
}

export interface AgentHandoverBlockedItem {
  kind: "task" | "report";
  id: string;
  reason: string;
  attempts: number;
  retryAt?: string;
}

export interface AgentLifecycleRequest {
  companyId: string;
  agentId: string;
  operationId: string;
  version: number;
  phase: AgentLifecycleState;
  environmentDriverKey?: string;
  instanceSecrets?: Record<string, string>;
}
export interface AgentLifecycleResult {
  operationId: string;
  version: number;
  status: "complete" | "pending";
  instanceSecrets?: Record<string, string | null>;
}
