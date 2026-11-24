import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRunEvents, heartbeatRuns, issueThreadInteractions, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import type { IssueComment, IssueQueuedCommentEntry } from "@paperclipai/shared";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The exact resolved response returned to a live assignee run by its tools. */
export const INTERACTION_RESPONSE_READ_EVENT = "interaction.response_read";

export async function recordInteractionResponseRead(db: Db, input: {
  companyId: string; agentId: string; runId: string;
  issue: { id: string; companyId: string; assigneeAgentId: string | null };
  interactions: Array<{ id: string; status: string; result?: unknown; resolvedAt?: Date | string | null }>;
}) {
  if (input.issue.companyId !== input.companyId || input.issue.assigneeAgentId !== input.agentId) return;
  const resolved = input.interactions.filter(row => ["accepted", "answered", "rejected"].includes(row.status) && row.resolvedAt);
  if (!resolved.length) return;
  const [run] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running"),
  ));
  if (record(run?.context).issueId !== input.issue.id) return;
  const previous = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, input.runId),
    eq(heartbeatRunEvents.eventType, INTERACTION_RESPONSE_READ_EVENT),
  ));
  const seen = new Map<string, unknown[]>();
  for (const event of previous) {
    const id = String(record(event.payload).interactionId);
    seen.set(id, [...(seen.get(id) ?? []), event.payload]);
  }
  for (const row of resolved) {
    const payload = { issueId: input.issue.id, interactionId: row.id, status: row.status,
      resolvedAt: new Date(row.resolvedAt!).toISOString(), result: row.result ?? null };
    if (seen.get(row.id)?.some(previous => isDeepStrictEqual(previous, payload))) continue;
    await appendHeartbeatRunEvent(db, { companyId: input.companyId, agentId: input.agentId, runId: input.runId,
      eventType: INTERACTION_RESPONSE_READ_EVENT, stream: "system", level: "info", payload });
  }
}

/** Interaction receipts keep their typed payload; they never become editable comments. */
export function queuedInteractionId(payload: unknown): string | null {
  const p = record(payload);
  return p.mutation === "interaction" && typeof p.interactionId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.interactionId)
    && ["accepted", "answered", "rejected"].includes(String(p.interactionStatus))
    && p.externalChatContinuation !== true
    ? p.interactionId : null;
}

/**
 * A governed tool action resolves as approve = run: by the time a receipt for
 * it waits behind another turn, the tool already ran or was declined, and the
 * approval card shows that outcome. The receipt only hands the recorded result
 * to the agent. It still counts as owed input for delivery and recovery, but it
 * is not a message the person can send, steer or interrupt with, so the
 * composer queue never lists it. The saved interaction decides this, because a
 * recovered wake does not carry the tool action fields of the original one.
 */
export function isToolActionConfirmation(interaction: { kind: string; payload?: unknown }): boolean {
  const toolAction = record(record(interaction.payload).toolAction);
  return interaction.kind === "request_confirmation" && Object.keys(toolAction).length > 0;
}

/**
 * One readable line for a queued response. The steering body also carries the
 * typed JSON receipt for the agent; people only ever see this line.
 */
export function queuedInteractionSummary(interaction: {
  kind: string; status: string; title?: string | null; payload?: unknown;
}): string {
  const p = record(interaction.payload);
  if (interaction.kind === "connection_intent") {
    const service = typeof p.serviceName === "string" && p.serviceName.trim() ? p.serviceName.trim() : null;
    const subject = service ? `${service} connection` : interaction.title ?? "Connection request";
    return interaction.status === "rejected" ? `Declined: ${subject}` : `Connected: ${subject}`;
  }
  const label = interaction.status === "accepted" ? "Accepted" : interaction.status === "rejected" ? "Rejected" : "Answered";
  const subject = interaction.title ?? (typeof p.prompt === "string" ? p.prompt : null) ?? "Questions";
  return `${label}: ${subject}`;
}

// Table-qualified on purpose: inside a select list Drizzle renders columns
// unqualified, which would bind them to the subquery's own run row.
/** A tool read alone is not delivery: that same successful assignee must close
 * this task afterward. Match the stored resolution, not just the card ID (which
 * survives retries/revisions). Shared by queue projection, recovery and drain. */
function consumedInteractionResponseExists(companyId: string, issueId: string, runId?: string, agentId?: string) {
  return sql<boolean>`EXISTS (SELECT 1 FROM heartbeat_run_events response_read
    JOIN heartbeat_runs consuming_run ON consuming_run.id = response_read.run_id
      AND consuming_run.company_id = response_read.company_id AND consuming_run.agent_id = response_read.agent_id
    JOIN issues consumed_task ON consumed_task.id = ${issueId} AND consumed_task.company_id = response_read.company_id
    JOIN activity_log response_done ON response_done.company_id = response_read.company_id
      AND response_done.run_id = consuming_run.id AND response_done.action = 'issue.updated'
      AND response_done.entity_type = 'issue' AND response_done.entity_id = ${issueId}
      AND ((response_done.actor_type = 'agent' AND response_done.agent_id = consuming_run.agent_id
        AND response_done.details->>'status' = 'done' AND response_done.details->'_previous'->>'status' <> 'done')
        OR (response_done.actor_type = 'system' AND response_done.actor_id = 'native-status-committer'
          AND response_done.details->>'source' = 'native_status_decision'
          AND response_done.details->>'toStatus' = 'done' AND response_done.details->>'fromStatus' <> 'done'))
    WHERE response_read.company_id = ${companyId}
      AND response_read.event_type = ${INTERACTION_RESPONSE_READ_EVENT}
      AND response_read.payload->>'issueId' = ${issueId}
      AND response_read.payload->>'interactionId' = issue_thread_interactions.id::text
      AND response_read.payload->>'status' = issue_thread_interactions.status
      AND (response_read.payload->>'resolvedAt')::timestamptz = issue_thread_interactions.resolved_at
      AND response_read.payload->'result' = COALESCE(issue_thread_interactions.result, 'null'::jsonb)
      AND consuming_run.context_snapshot->>'issueId' = ${issueId}
      AND consuming_run.status = 'succeeded' AND consuming_run.started_at IS NOT NULL
      AND consuming_run.agent_id = consumed_task.assignee_agent_id
      AND consumed_task.status = 'done' AND consumed_task.completed_at >= date_trunc('milliseconds', response_read.created_at)
      AND response_read.created_at >= issue_thread_interactions.resolved_at
      AND response_read.created_at >= consuming_run.started_at
      AND response_done.created_at >= response_read.created_at
      AND response_done.created_at >= consumed_task.completed_at
      AND consuming_run.finished_at >= date_trunc('milliseconds', response_read.created_at)
      ${runId ? sql`AND consuming_run.id = ${runId}` : sql``}
      ${agentId ? sql`AND consuming_run.agent_id = ${agentId}` : sql``})`;
}

export async function hasConsumedInteractionResponse(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; runId: string; agentId: string; payload: unknown;
}) {
  const id = queuedInteractionId(input.payload);
  if (!id) return false;
  const [row] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.status, String(record(input.payload).interactionStatus)),
    consumedInteractionResponseExists(input.companyId, input.issueId, input.runId, input.agentId),
  )).limit(1);
  return Boolean(row);
}

/** A resolved response in a started run's initial context is delivered too.
 * Pending card-creation wakes and failed/cancelled starts still do not count. */
function deliveredInteractionRunExists(companyId: string, issueId: string) {
  return sql<boolean>`(${consumedInteractionResponseExists(companyId, issueId)} OR EXISTS (SELECT 1 FROM heartbeat_runs delivered_run
    WHERE delivered_run.company_id = ${companyId}
      AND delivered_run.context_snapshot->>'issueId' = ${issueId}
      AND delivered_run.context_snapshot->>'interactionId' = issue_thread_interactions.id::text
      AND delivered_run.context_snapshot->>'interactionStatus' = issue_thread_interactions.status
      AND delivered_run.started_at IS NOT NULL
      AND delivered_run.status IN ('running', 'succeeded')))`;
}

/**
 * The explicit steering message for a resolved interaction. It preserves the
 * question labels, selected options, custom answers, approval target and exact
 * revision.
 */
export function queuedInteractionSteeringBody(interaction: {
  id: string; kind: string; status: string; title?: string | null; payload?: unknown; result?: unknown;
}): string {
  return `${queuedInteractionSummary(interaction)}\n\n${JSON.stringify({
    interactionId: interaction.id, kind: interaction.kind, status: interaction.status,
    payload: interaction.payload, result: record(interaction.result),
  }, null, 2)}`;
}

export type QueuedInteractionResponse = NonNullable<Awaited<ReturnType<typeof readQueuedInteractionResponse>>>;

/** A stored human answer can reach its assignee while dependency work stays blocked. */
export async function isVerifiedDependencyInteractionResponse(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown;
}): Promise<boolean> {
  const id = queuedInteractionId(input.context);
  if (!id) return false;
  const context = record(input.context);
  const [interaction] = await db.select({ status: issueThreadInteractions.status, kind: issueThreadInteractions.kind,
    resolvedByUserId: issueThreadInteractions.resolvedByUserId, resolvedAt: issueThreadInteractions.resolvedAt })
    .from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId), eq(issueThreadInteractions.createdByAgentId, input.agentId),
    )).limit(1);
  return Boolean(interaction?.resolvedByUserId && interaction.resolvedAt
    && interaction.status === context.interactionStatus
    && (context.interactionKind === undefined || interaction.kind === context.interactionKind));
}

export async function readQueuedInteractionResponse(db: Db, companyId: string, issueId: string, payload: unknown) {
  const id = queuedInteractionId(payload);
  if (!id) return null;
  const [row] = await db.select({
    interaction: issueThreadInteractions,
    delivered: deliveredInteractionRunExists(companyId, issueId),
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, companyId),
    eq(issueThreadInteractions.issueId, issueId),
    inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
  ));
  const interaction = row?.interaction;
  if (!interaction || interaction.status !== record(payload).interactionStatus || row.delivered) return null;
  const heading = queuedInteractionSummary(interaction);
  const body = queuedInteractionSteeringBody(interaction);
  const comment: IssueComment = {
    id: interaction.id, companyId, issueId, authorType: interaction.resolvedByUserId ? "user" : "agent",
    authorUserId: interaction.resolvedByUserId, authorAgentId: interaction.resolvedByAgentId,
    body, presentation: null, metadata: null,
    createdAt: interaction.resolvedAt ?? interaction.updatedAt, updatedAt: interaction.updatedAt,
  };
  const source: NonNullable<IssueQueuedCommentEntry["source"]> = {
    kind: "interaction", interactionId: interaction.id, interactionKind: interaction.kind,
    requiresFreshSession: record(record(payload)._paperclipWakeContext).forceFreshSession === true,
    summary: heading,
  };
  return { comment, source, toolActionOutcome: isToolActionConfirmation(interaction) };
}

/** A saved answer is a live continuation, even though its card is no longer pending. */
export async function hasQueuedInteractionResponse(db: Db, companyId: string, issueId: string, agentId?: string | null) {
  if (!agentId) return false;
  const [row] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
    .innerJoin(issueThreadInteractions, and(
      eq(issueThreadInteractions.companyId, agentWakeupRequests.companyId),
      sql`${issueThreadInteractions.id}::text = ${agentWakeupRequests.payload}->>'interactionId'`,
      eq(issueThreadInteractions.issueId, issueId),
      inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
    )).where(and(
      eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId),
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,
      sql`NOT ${deliveredInteractionRunExists(companyId, issueId)}`,
    )).limit(1);
  return Boolean(row);
}
