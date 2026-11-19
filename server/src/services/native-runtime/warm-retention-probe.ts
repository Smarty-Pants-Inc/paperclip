import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { logger } from "../../middleware/logger.js";

export const WARM_RETENTION_PROBE = "native.warm_retention.probe";

type ProbePhase = "acquisition" | "admission" | "retention" | "proof" | "proof_runner_stop";
type ProbeInput = {
  companyId: string; runId: string; agentId?: string; predecessorRunId?: string | null;
  leaseId: string | null;
};
type ProbeFields = Record<string, string | number | boolean | null> & { phase: ProbePhase };
type ProbeRun = { phases: Set<ProbePhase>; tail: Promise<void> };
const probeRuns = new WeakMap<Db, Map<string, ProbeRun>>();
// Fail closed on saturation rather than evicting and allowing another write for
// an old run. Diagnostics must not grow without bound, even with a held store.
const MAX_PROBE_RUNS = 10_000;

/** Best effort, process-local: at most one attempt per phase per run (including
 * failed attempts). All I/O is detached, including enrichment reads. Never await
 * this from a decision or attach it to trace.finish(), which would backpressure
 * cancellation. Per-run ordering preserves retention -> runner-stop enrichment.
 * A saturated recorder drops new runs until this Db is collected/restarted. */
export function recordWarmRetentionProbe(db: Db, input: ProbeInput, fields: ProbeFields): void {
  try {
    let runs = probeRuns.get(db);
    if (!runs) { runs = new Map(); probeRuns.set(db, runs); }
    const key = `${input.companyId}:${input.runId}`;
    let run = runs.get(key);
    if (!run) {
      if (runs.size >= MAX_PROBE_RUNS) return;
      run = { phases: new Set(), tail: Promise.resolve() };
      runs.set(key, run);
    }
    if (run.phases.has(fields.phase)) return;
    run.phases.add(fields.phase);
    // A microtask can still run before the caller's awaited decision resolves.
    // Cross a real task boundary for EVERY phase, even after the tail settles,
    // before any enrichment read or sink. A held sink queues at most five callbacks.
    run.tail = run.tail.then(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await persistWarmRetentionProbe(db, input, fields);
    }).catch(() => {});
  } catch {
    // Diagnostic bookkeeping must not throw into the decision either.
  }
}

/** Never changes a lease, admission, run activity time or a gate's answer. */
async function persistWarmRetentionProbe(db: Db, input: ProbeInput, fields: ProbeFields): Promise<void> {
  try {
    let agentId = input.agentId;
    if (!agentId) {
      const [run] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId))).limit(1);
      agentId = run?.agentId;
    }
    if (!agentId) return;
    let predecessorRunId = input.predecessorRunId;
    if (predecessorRunId === undefined) {
      const [acquisition] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, input.runId),
          eq(heartbeatRunEvents.eventType, WARM_RETENTION_PROBE), sql`${heartbeatRunEvents.payload}->>'phase' = 'acquisition'`))
        .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
      predecessorRunId = typeof acquisition?.payload?.predecessorRunId === "string" ? acquisition.payload.predecessorRunId : null;
    }
    let retention: Record<string, boolean | null> = {};
    if (fields.phase === "proof_runner_stop") {
      const [decision] = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
        .where(and(eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, input.runId),
          eq(heartbeatRunEvents.eventType, WARM_RETENTION_PROBE), sql`${heartbeatRunEvents.payload}->>'phase' = 'retention'`))
        .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
      const retainedInCancel = typeof decision?.payload?.retained === "boolean" ? decision.payload.retained : null;
      retention = { retainedInCancel, stoppedRetainedRunner: retainedInCancel === null ? null
        : fields.runnerStopProven === true && retainedInCancel };
    }
    await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId,
      eventType: WARM_RETENTION_PROBE, stream: "system", level: "info", keepRunUpdatedAt: true,
      payload: { ...fields, ...retention, runId: input.runId, predecessorRunId, leaseId: input.leaseId } });
  } catch {
    // No exception or provider/user text enters this diagnostic path.
    logger.warn({ runId: input.runId, code: "warm_retention_probe_write_failed" }, "Warm retention probe could not be persisted");
  }
}
