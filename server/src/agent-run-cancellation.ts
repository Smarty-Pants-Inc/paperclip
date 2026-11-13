import { and, eq, inArray } from "drizzle-orm";
import { agents, caseHandoffs, heartbeatRuns, type Db } from "@paperclipai/db";
import { forbidden } from "./errors.js";

/** Stop revokes write authority before waiting for the executor to settle. */
export function agentRunWritesRevoked(run: {
  status: string;
  resultJson?: Record<string, unknown> | null;
} | null | undefined): boolean {
  const cancellation = run?.resultJson?.executionCancellation;
  return run?.status === "cancelled" || Boolean(cancellation && typeof cancellation === "object"
    && "state" in cancellation && cancellation.state === "requested");
}

/**
 * Shared lock order for agent-run writes: agents FOR SHARE -> issue(s) FOR
 * UPDATE -> heartbeat_runs (FOR SHARE here, or FOR UPDATE OF heartbeat_runs in
 * the native authority). Writers that lock the run must take the agent row
 * first, in SHARE mode, and must never lock the agent row FOR UPDATE through a
 * join after the run: that inverts the order of assertInteractionRunWriteAllowed
 * and of any FK insert that key-shares the agent row before
 * assertAgentRunWriteAllowed, and the two deadlock (40P01). FOR SHARE on the
 * agent row still blocks pause/terminate/status UPDATEs until commit, so a
 * status check made after this lock stays valid for the transaction.
 */
export async function lockAgentForRunWrite(tx: Db, companyId: string, agentId: string) {
  const [row] = await tx.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for("share");
  return row ?? null;
}

/** The caller must supply its write transaction, so Stop and commit serialize. */
export async function assertAgentRunWriteAllowed(tx: Db, companyId: string, actor: {
  agentId?: string | null;
  runId?: string | null;
  stopId?: string | null;
}) {
  if (!actor.agentId || !actor.runId) return;
  const [run] = await tx.select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson,
    runtimeMode: heartbeatRuns.runtimeMode, companyId: heartbeatRuns.companyId,
    contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actor.agentId)))
    .for("share");
  const stoppedForThisMutation = run?.status === "cancelled" && actor.stopId &&
    run.resultJson?.issueMutationStopId === actor.stopId;
  if (agentRunWritesRevoked(run) && !stoppedForThisMutation) {
    throw forbidden("This run was cancelled", { code: "agent_run_cancelled" });
  }
  const [handoff] = await tx.select({ id: caseHandoffs.id }).from(caseHandoffs).where(and(
    eq(caseHandoffs.companyId, companyId), eq(caseHandoffs.sourceRunId, actor.runId),
    inArray(caseHandoffs.state, ["awaiting_release", "pending_dispatch", "delivered"]),
  )).limit(1);
  if (handoff) throw forbidden("This run handed off its task. End the turn.", { code: "case_handoff_run_yielded", handoffId: handoff.id });
  return run;
}
