import { randomUUID } from "node:crypto";
import type { heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { publishPluginDomainEvent } from "../activity-log.js";

/** Publish after the owning status transaction commits, only for its winning transition. */
export function publishRunLifecyclePluginEvent(run: typeof heartbeatRuns.$inferSelect) {
  const issueId = parseObject(run.contextSnapshot).issueId;
  publishRunLifecyclePluginEventData({
    companyId: run.companyId,
    runId: run.id,
    agentId: run.agentId,
    status: run.status,
    invocationSource: run.invocationSource,
    triggerDetail: run.triggerDetail,
    error: run.error,
    errorCode: run.errorCode,
    issueId: typeof issueId === "string" && issueId.trim().length > 0 ? issueId.trim() : null,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  });
}

export function publishRunLifecyclePluginEventData(run: {
  companyId: string;
  runId: string;
  agentId: string;
  status: string;
  invocationSource: string;
  triggerDetail: string | null;
  error: string | null;
  errorCode: string | null;
  issueId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}) {
  const eventType =
    run.status === "running"
      ? "agent.run.started"
      : run.status === "succeeded"
        ? "agent.run.finished"
        : run.status === "failed" || run.status === "timed_out"
          ? "agent.run.failed"
          : run.status === "cancelled"
            ? "agent.run.cancelled"
            : null;
  if (!eventType) return;
  publishPluginDomainEvent({
    eventId: randomUUID(),
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
