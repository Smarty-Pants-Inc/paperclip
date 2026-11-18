import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterDatabaseCommit, heartbeatRuns, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { publishPluginDomainEvent } from "../activity-log.js";

/**
 * Called inside the status owner's transaction with its locked pre-write row.
 * A run has only one lifecycle end, including after recovery reopens it. Claim
 * its durable marker in the status transaction, not from a stale caller row.
 * Rollback discards both the claim and its post-commit effect. This retains the
 * bus's best-effort delivery contract; it is not a durable publication outbox.
 */
export async function publishTerminalRunLifecyclePluginEventAfterCommit(
  tx: Pick<Db, "update">,
  before: { status: string },
  after: typeof heartbeatRuns.$inferSelect,
): Promise<void> {
  if (after.runtimeMode !== "native" || !["queued", "scheduled_retry", "running"].includes(before.status)
    || !["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(after.status)) return;
  const eventId = randomUUID();
  const [claimed] = await tx.update(heartbeatRuns)
    .set({ terminalPluginEventId: eventId })
    .where(and(eq(heartbeatRuns.id, after.id), eq(heartbeatRuns.companyId, after.companyId),
      isNull(heartbeatRuns.terminalPluginEventId)))
    .returning({ id: heartbeatRuns.id });
  if (claimed) afterDatabaseCommit(tx, () => publishRunLifecyclePluginEvent(after, eventId));
}

/** Publish after the owning status transaction commits, only for its winning transition. */
export function publishRunLifecyclePluginEvent(run: typeof heartbeatRuns.$inferSelect, eventId?: string) {
  const issueId = parseObject(run.contextSnapshot).issueId;
  publishRunLifecyclePluginEventData({
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    runtimeMode: run.runtimeMode,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error,
    errorCode: run.errorCode,
    issueId: typeof issueId === "string" && issueId.trim().length > 0 ? issueId.trim() : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  }, eventId);
}

export function publishRunLifecyclePluginEventData(run: {
  companyId: string;
  runId: string;
  agentId: string;
  status: string;
  runtimeMode?: string;
  invocationSource: string;
  triggerDetail: string | null;
  error: string | null;
  errorCode: string | null;
  issueId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}, eventId: string = randomUUID()) {
  const eventType =
    run.status === "running"
      ? "agent.run.started"
      : run.status === "succeeded"
        ? "agent.run.finished"
        : run.status === "failed" || run.status === "timed_out" || (run.runtimeMode === "native" && run.status === "interrupted")
          ? "agent.run.failed"
          : run.status === "cancelled"
            ? "agent.run.cancelled"
            : null;
  if (!eventType) return;
  publishPluginDomainEvent({
    eventId,
    eventType,
    occurredAt: new Date().toISOString(),
    actorId: run.agentId,
    actorType: "agent",
    entityId: run.runId,
    entityType: "heartbeat_run",
    companyId: run.companyId,
    payload: {
      runId: run.runId,
      agentId: run.agentId,
      status: run.status,
      invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail,
      error: run.error ?? null,
      errorCode: run.errorCode ?? null,
      issueId: run.issueId,
      startedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    },
  });
}
