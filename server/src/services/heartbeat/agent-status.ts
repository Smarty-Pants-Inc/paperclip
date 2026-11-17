import { notifyStrandedAgentStatus } from "../live-run-recovery-notifications.js";
import { notifyAttentionRetentionWork } from "../retention-work-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { trackAgentFirstHeartbeat } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../../telemetry.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { publishLiveEvent } from "../live-events.js";
import { finishedIdleRun, finishedIdleWake, finishedFailedIdleLease } from "../idle-work-proof.js";

type Outcome = "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out";

const RECONCILIATION_GRACE_MS = 5 * 60_000;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "interrupted"]);
const RECONCILIATION_BATCH_SIZE = 25;

function errorReason(reason: string | null | undefined) {
  const trimmed = reason?.trim();
  if (!trimmed) return null;
  return trimmed.length > 500 ? `${trimmed.slice(0, 499)}…` : trimmed;
}

function settledStatus(outcome: string | undefined, keepIdleOnFailure = false) {
  return outcome === "failed" || outcome === "timed_out"
    ? keepIdleOnFailure && outcome === "failed" ? "idle" : "error"
    : "idle";
}

function publishStatus(agent: typeof agents.$inferSelect, outcome: string) {
  publishLiveEvent({
    companyId: agent.companyId,
    type: "agent.status",
    payload: {
      agentId: agent.id,
      status: agent.status,
      lastHeartbeatAt: agent.lastHeartbeatAt?.toISOString() ?? null,
      outcome,
    },
  });
}

export function settledAgentWorkCondition(liveRunIds: ReadonlySet<string>, now: Date) {
  const localRuns = liveRunIds.size > 0
    ? sql`AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r
        WHERE r.id IN (${sql.join([...liveRunIds].map(id => sql`${id}::uuid`), sql`, `)})
          AND r.company_id = ${agents.companyId} AND r.agent_id = ${agents.id})`
    : sql``;
  // A retained allocation is warm capacity, not agent execution. Finished-run,
  // ownership, finalization and cleanup obligations must still settle separately.
  // Superseded handoff receipts are aliases: the successor owns the shared tree,
  // so none of the predecessor's stale stop/retry/cleanup fields owns work.
  return sql`NOT EXISTS (SELECT 1 FROM heartbeat_runs r
      WHERE r.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND r.status IN ('running', 'queued'))
    AND NOT EXISTS (SELECT 1 FROM heartbeat_runs r
      WHERE r.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND ((${sql.raw(finishedIdleRun("r"))}) IS NOT TRUE
          OR r.controller_lease_expires_at > ${now.toISOString()}::timestamptz))
    ${localRuns}
    AND NOT EXISTS (SELECT 1 FROM native_run_finalizations f
      JOIN heartbeat_runs r ON r.id = f.run_id AND r.company_id = f.company_id
      WHERE f.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND (f.phase NOT IN ('committed', 'terminal_failure')
          OR f.lease_expires_at > ${now.toISOString()}::timestamptz OR f.next_attempt_at IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM environment_leases l
      JOIN heartbeat_runs r ON r.id = l.heartbeat_run_id AND r.company_id = l.company_id
      WHERE l.company_id = ${agents.companyId} AND r.agent_id = ${agents.id}
        AND ((l.status NOT IN ('released', 'expired', 'retained')
            AND (${sql.raw(finishedFailedIdleLease("l"))}) IS NOT TRUE)
          OR COALESCE(l.metadata->>'pendingCleanupInFlight', 'false') <> 'false'
          OR COALESCE(l.metadata, '{}'::jsonb) ?| ARRAY['nativeWorkspaceExportResume', 'sandboxStopAndRetain']))
    AND NOT EXISTS (SELECT 1 FROM agent_wakeup_requests w
      WHERE w.company_id = ${agents.companyId} AND w.agent_id = ${agents.id}
        AND (${sql.raw(finishedIdleWake("w"))}) IS NOT TRUE)
    AND NOT EXISTS (SELECT 1 FROM agent_instruction_working_copies c
      WHERE c.company_id = ${agents.companyId} AND c.agent_id = ${agents.id}
        AND (c.state = 'superseded' AND jsonb_typeof(c.receipt->'successorRunId') = 'string'
          AND btrim(c.receipt->>'successorRunId') <> '') IS NOT TRUE
        AND (c.state NOT IN ('saved', 'unchanged', 'resolved', 'unavailable', 'conflict')
          OR c.process_stopped_at IS NULL OR c.next_attempt_at IS NOT NULL
          OR c.receipt ? 'baseline' OR c.receipt->>'cleanupPending' = 'true'))`;
}

export function createHeartbeatAgentStatus(db: Db) {
  async function finalizeAgentStatus(
    agentId: string,
    outcome: Outcome,
    failureReason?: string | null,
    options?: { keepIdleOnFailure?: boolean; wasFirstHeartbeat?: boolean },
  ) {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(agents)
        .where(eq(agents.id, agentId)).for("no key update");
      if (!existing || existing.lifecycleState !== "ready" ||
          existing.status === "paused" || existing.status === "terminated") return null;
      const [running] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, existing.companyId),
        eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running"),
      )).limit(1);
      const nextStatus = running ? "running" : settledStatus(outcome, options?.keepIdleOnFailure);
      const now = new Date();
      await notifyStrandedAgentStatus(tx, { companyId: existing.companyId, agentId });
      await notifyAttentionRetentionWork(tx, { companyId: existing.companyId });
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
      const [updated] = await tx.update(agents).set({
        status: nextStatus,
        errorReason: nextStatus === "error" ? errorReason(failureReason) : null,
        lastHeartbeatAt: now,
        updatedAt: now,
      }).where(and(eq(agents.id, agentId), eq(agents.companyId, existing.companyId),
        eq(agents.lifecycleState, "ready"))).returning();
      return { updated, isFirstHeartbeat: options?.wasFirstHeartbeat ?? !existing.lastHeartbeatAt };
    });
    if (!result?.updated) return;
    if (result.isFirstHeartbeat) {
      const client = getTelemetryClient();
      if (client) trackAgentFirstHeartbeat(client, { agentRole: result.updated.role, agentId: result.updated.id });
    }
    publishStatus(result.updated, outcome);
  }

  /**
   * Settle the agent of a run whose terminal status another path already
   * committed (for a native run, the finalizer's projection), when the live
   * owner lost the compare-and-set and so skipped its own settlement
   * (smarty-dev#21005). Only a `running` agent of a ready lifecycle moves, only
   * when this run is terminal and the agent has no other running or queued run,
   * and the conditional write makes a repeated call a no-op.
   */
  async function settleAgentAfterCommittedRun(run: { id: string; companyId: string; agentId: string }) {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(agents)
        .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))).for("no key update");
      if (!existing || existing.lifecycleState !== "ready" || existing.status !== "running") return null;
      const [committed] = await tx.select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.agentId, run.agentId))).limit(1);
      if (!committed || !TERMINAL_RUN_STATUSES.has(committed.status)) return null;
      const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId),
        ne(heartbeatRuns.id, run.id), inArray(heartbeatRuns.status, ["running", "queued"]),
      )).limit(1);
      if (active) return null;
      const nextStatus = settledStatus(committed.status);
      const now = new Date();
      await notifyStrandedAgentStatus(tx, { companyId: run.companyId, agentId: run.agentId });
      await notifyAttentionRetentionWork(tx, { companyId: run.companyId });
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.agentTimers);
      const [updated] = await tx.update(agents).set({
        status: nextStatus,
        errorReason: nextStatus === "error" ? errorReason(committed.error) : null,
        lastHeartbeatAt: now,
        updatedAt: now,
      }).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId),
        eq(agents.status, "running"), eq(agents.lifecycleState, "ready"),
        // The agent row lock does not block a new run's insert (its foreign key
        // takes only KEY SHARE), so re-check in the write itself.
        sql`NOT EXISTS (SELECT 1 FROM heartbeat_runs r
          WHERE r.company_id = ${run.companyId} AND r.agent_id = ${run.agentId}
            AND r.id <> ${run.id} AND r.status IN ('running', 'queued'))`)).returning();
      return updated ? { updated, outcome: committed.status } : null;
    });
    if (!result) return null;
    publishStatus(result.updated, result.outcome);
    return result.updated;
  }

  async function reconcileStrandedAgentStatuses(liveRunIds: () => ReadonlySet<string>, scope: { companyId?: string; agentId?: string; onDeferredDeadline?: (at: number) => void } = {}) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - RECONCILIATION_GRACE_MS);
    const candidates = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
      return tx.select({ id: agents.id, companyId: agents.companyId }).from(agents)
      .where(and(eq(agents.status, "running"), eq(agents.lifecycleState, "ready"),
        scope.companyId ? eq(agents.companyId, scope.companyId) : undefined,
        scope.agentId ? eq(agents.id, scope.agentId) : undefined,
        lte(agents.updatedAt, cutoff), settledAgentWorkCondition(liveRunIds(), now)))
      .orderBy(asc(agents.updatedAt), asc(agents.id)).limit(RECONCILIATION_BATCH_SIZE);
    });
    const reconciled: string[] = [];
    for (const candidate of candidates) {
      if (Date.now() - now.getTime() > 5_000) break;
      const publications: ActivityPublication[] = [];
      const updated = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '2s'`);
        const [locked] = await tx.select({ id: agents.id }).from(agents).where(and(
          eq(agents.id, candidate.id), eq(agents.companyId, candidate.companyId),
        )).for("update", { skipLocked: true });
        if (!locked) {
          const [pending] = await tx.select({ id: agents.id }).from(agents).where(and(
            eq(agents.id, candidate.id), eq(agents.companyId, candidate.companyId),
          ));
          if (pending) scope.onDeferredDeadline?.(Date.now() + 30_000);
          return null;
        }
        const [current] = await tx.select().from(agents).where(and(
          eq(agents.id, candidate.id), eq(agents.companyId, candidate.companyId),
          eq(agents.status, "running"), eq(agents.lifecycleState, "ready"),
          lte(agents.updatedAt, cutoff), settledAgentWorkCondition(liveRunIds(), now),
        ));
        if (!current) return null;
        const [lastRun] = await tx.select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
          .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId),
            eq(heartbeatRuns.agentId, candidate.id)))
          .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
        const nextStatus = settledStatus(lastRun?.status);
        await notifyAttentionRetentionWork(tx, { companyId: candidate.companyId });
        const [agent] = await tx.update(agents).set({ status: nextStatus,
          errorReason: nextStatus === "error" ? errorReason(lastRun?.error) : null, updatedAt: now,
        }).where(and(eq(agents.id, candidate.id), eq(agents.companyId, candidate.companyId),
          eq(agents.status, "running"), eq(agents.lifecycleState, "ready"))).returning();
        await logActivity(tx as unknown as Db, {
          companyId: candidate.companyId, actorType: "system", actorId: "system",
          action: "agent.status_reconciled", entityType: "agent", entityId: candidate.id,
          details: { previousStatus: "running", nextStatus, reason: "no_unsettled_execution" },
        }, publications);
        return agent;
      });
      if (!updated) continue;
      reconciled.push(updated.id);
      for (const publication of publications) publishActivity(publication);
      publishStatus(updated, "reconciled");
    }
    if (scope.companyId && scope.agentId && reconciled.length === 0 && scope.onDeferredDeadline) {
      const rows = await db.execute(sql`select min(deadline) as deadline from (
        select r.controller_lease_expires_at as deadline from heartbeat_runs r
          where r.company_id = ${scope.companyId} and r.agent_id = ${scope.agentId}
        union all
        select f.lease_expires_at as deadline from native_run_finalizations f
          inner join heartbeat_runs r on r.id = f.run_id and r.company_id = f.company_id
          where r.company_id = ${scope.companyId} and r.agent_id = ${scope.agentId}
      ) authority where deadline > ${now.toISOString()}::timestamptz`);
      const deadline = rows[0]?.deadline;
      if (deadline) {
        const at = deadline instanceof Date ? deadline.getTime() : Date.parse(String(deadline));
        if (Number.isFinite(at) && at > Date.now()) scope.onDeferredDeadline(at);
      }
    }
    return reconciled;
  }

  return { finalizeAgentStatus, settleAgentAfterCommittedRun, reconcileStrandedAgentStatuses };
}
