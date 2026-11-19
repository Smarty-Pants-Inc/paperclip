import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { logger } from "../../middleware/logger.js";

export const WARM_RETENTION_PROBE = "native.warm_retention.probe";

/** Diagnostic only. Never changes a lease, admission, run activity time or a gate's answer. */
export async function recordWarmRetentionProbe(db: Db, input: {
  companyId: string; runId: string; agentId?: string; predecessorRunId?: string | null;
  leaseId: string | null;
}, fields: Record<string, string | number | boolean | null>): Promise<void> {
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
      retention = { retainedInCancel, stoppedRetainedRunner: fields.runnerStopProven === true && retainedInCancel === true };
    }
    await appendHeartbeatRunEvent(db, { companyId: input.companyId, runId: input.runId, agentId,
      eventType: WARM_RETENTION_PROBE, stream: "system", level: "info", keepRunUpdatedAt: true,
      payload: { ...fields, ...retention, runId: input.runId, predecessorRunId, leaseId: input.leaseId } });
  } catch {
    // No exception or provider/user text enters this diagnostic path.
    logger.warn({ runId: input.runId, code: "warm_retention_probe_write_failed" }, "Warm retention probe could not be persisted");
  }
}
