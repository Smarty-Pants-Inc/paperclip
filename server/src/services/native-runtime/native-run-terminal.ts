import { and, eq, inArray } from "drizzle-orm";
import { agents, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { createHeartbeatAgentStatus } from "../heartbeat/agent-status.js";
import { writeRuntimeRunPointer } from "../heartbeat/runtime-run-pointer.js";

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const;
const TERMINAL_LIFECYCLE_MESSAGES = TERMINAL_STATUSES.map(status => `run ${status}`);

/**
 * The one post-commit step every native terminal writer calls once, after its
 * terminal run state is committed and outside the run-row transaction
 * (smarty-dev#21005). The live completion tail (completeRun/failRun) does the
 * same three things for runs it ends itself; a native run ended by the
 * finalizer, the result-commit worker, projection, chat-response recovery or
 * a superseded/exhausted finalization has no such tail.
 *
 * (a) settle the agent: queued-aware, never un-pauses, never idles an agent
 *     with another queued or running run (settleAgentAfterCommittedRun);
 * (b) the runtime last-run pointer/status (the live writer, factored);
 * (c) a terminal lifecycle event, when the run has none.
 *
 * Each part is conditional, so a repeated call is a no-op. Each part runs in
 * its own short transaction and never takes an issue lock, so it adds no
 * issue -> agent or run -> agent lock edge to a caller's transaction.
 */
export async function completeNativeRunTerminal(db: Db, runId: string) {
  const [run] = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId, status: heartbeatRuns.status, error: heartbeatRuns.error,
    runtimeMode: heartbeatRuns.runtimeMode, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).limit(1);
  if (!run || run.runtimeMode !== "native"
    || !(TERMINAL_STATUSES as readonly string[]).includes(run.status)) return null;
  // (a) Agent row lock only, in its own transaction.
  const settled = await createHeartbeatAgentStatus(db).settleAgentAfterCommittedRun(run);
  // (b) Runtime truth; never replaces a newer run's pointer.
  const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, adapterType: agents.adapterType })
    .from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))).limit(1);
  const pointed = agent ? await writeRuntimeRunPointer(db, agent, run, { onlyIfNotOlder: true }) : false;
  // (c) The run row lock serializes concurrent calls, so one event is written.
  const evented = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [locked] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id)).for("no key update").limit(1);
    if (!locked || !(TERMINAL_STATUSES as readonly string[]).includes(locked.status)) return false;
    const [existing] = await tx.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.eventType, "lifecycle"),
        inArray(heartbeatRunEvents.message, TERMINAL_LIFECYCLE_MESSAGES))).limit(1);
    if (existing) return false;
    await appendHeartbeatRunEvent(tx, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: "lifecycle", stream: "system", level: locked.status === "succeeded" ? "info" : "error",
      message: `run ${locked.status}`, payload: { status: locked.status, source: "native_run_terminal" } });
    return true;
  });
  return { settled: Boolean(settled), pointed, evented };
}
