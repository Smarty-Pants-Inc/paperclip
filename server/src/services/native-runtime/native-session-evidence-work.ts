import { environmentLeases, environments, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { registerDeadlineWork } from "../deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { environmentRuntimeService } from "../environment-runtime.js";
import { scheduleNativeSessionEvidenceCopy } from "./native-session-evidence.js";

/** The delivery coordinator owns startup reconstruction, error retry and stop.
 * Once the saved obligations have each had their three bounded attempts, this
 * worker is quiet. Normal turns already schedule their own bounded copy. */
export function registerNativeSessionEvidenceWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  runtime: Pick<ReturnType<typeof environmentRuntimeService>, "execute" | "readPredecessorSandboxRecord">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.nativeSessionEvidence, {
    retryMs: 30_000, canRun, next: async () => null,
    run: async signal => {
      const rows = await db.select({ lease: environmentLeases, environment: environments, run: heartbeatRuns })
        .from(environmentLeases)
        .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, environmentLeases.companyId),
          sql`${heartbeatRuns.id}::text = ${environmentLeases.metadata}->'nativeSessionEvidencePending'->>'runId'`))
        .leftJoin(environments, eq(environments.id, environmentLeases.environmentId))
        .where(sql`${environmentLeases.metadata} ? 'nativeSessionEvidencePending'`);
      const { recoveredNativeSessionEvidenceSource } = await import("./native-session-executor.js");
      for (const { lease, environment, run } of rows) {
        if (signal.aborted || !canRun()) return;
        const marker = lease.metadata?.nativeSessionEvidencePending as Record<string, unknown>;
        if (marker.alarmReason === "box_gone") continue;
        try {
          if (!lease.providerLeaseId || marker.providerLeaseId !== lease.providerLeaseId) {
            throw new Error("native_session_evidence_recovery_box_changed");
          }
          // Only a fresh provider read proves loss. Lease labels and a failed
          // read cannot prove the box gone and never authorize deleting a marker.
          const observed = await runtime.readPredecessorSandboxRecord({ companyId: lease.companyId, leaseId: lease.id });
          if (observed.kind === "gone") {
            const changed = await db.update(environmentLeases).set({ metadata: sql`
              jsonb_set(${environmentLeases.metadata}, '{nativeSessionEvidencePending}',
                (${environmentLeases.metadata}->'nativeSessionEvidencePending') || '{"alarmReason":"box_gone"}'::jsonb)`, updatedAt: new Date() })
              .where(and(eq(environmentLeases.id, lease.id), eq(environmentLeases.companyId, lease.companyId),
                sql`${environmentLeases.metadata}->'nativeSessionEvidencePending'->>'runId' = ${run.id}`,
                sql`(${environmentLeases.metadata}->'nativeSessionEvidencePending'->>'alarmReason') is distinct from 'box_gone'`))
              .returning({ id: environmentLeases.id });
            if (changed.length) logger.error({ reason: "box_gone", boxId: lease.providerLeaseId, providerLeaseId: lease.providerLeaseId,
              companyId: lease.companyId, runId: run.id }, "custody_evidence_pending_alarm: warm evidence source box is gone; marker retained");
            continue;
          }
          const execution = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput);
          const remoteCwd = lease.metadata?.remoteCwd;
          if (!execution || execution.binding.companyId !== lease.companyId || execution.binding.runId !== run.id
            || typeof remoteCwd !== "string" || !environment || !lease.providerLeaseId) {
            throw new Error("native_session_evidence_recovery_source_unavailable");
          }
          const source = recoveredNativeSessionEvidenceSource(execution, remoteCwd);
          if (source.normalizedSessionId !== marker.sessionId) throw new Error("native_session_evidence_recovery_session_changed");
          await scheduleNativeSessionEvidenceCopy({ db, companyId: lease.companyId, issueId: execution.binding.issueId, runId: run.id,
            source: { ...source,
              providerLeaseId: lease.providerLeaseId, environmentId: lease.environmentId, environmentLeaseId: lease.id,
              runner: { execute: async command => {
                const result = await runtime.execute({ ...command, lease, environment, readOnlyProbe: true, bypassSession: true });
                return { ...result, signal: result.signal ?? null, pid: null, startedAt: new Date().toISOString() };
              } } } });
        } catch (err) {
          // Keep the durable obligation even if inspection/identity is unavailable.
          logger.error({ err, boxId: lease.providerLeaseId, providerLeaseId: lease.providerLeaseId, companyId: lease.companyId,
            runId: run.id }, "custody_evidence_pending_alarm: warm evidence recovery unavailable; marker retained");
        }
      }
    },
  });
}
