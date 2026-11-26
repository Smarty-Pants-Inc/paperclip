import { and, count, eq, gt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, companyMemberships, heartbeatRuns, type issues } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { readRunCancellation } from "./run-cancellation.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { HttpError } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/** Agent presses on one task in a rolling day, across all agents. */
export const AGENT_TASK_RETRY_DAILY_CAP = 3;
export const AGENT_TASK_RETRY_ACTION = "issue.retry_requested_by_agent";

export type AgentTaskRetryPresser = {
  agentId: string; runId: string; companyId: string;
  credentialSource: "agent_jwt"; onBehalfOfUserId: string;
};

/** Rechecked at admission and dispatch. Only a signed, run-bound request may
 * carry the original person's authority; an unsigned run header is not proof. */
export async function agentTaskRetryPresserAllowed(db: Db, input: AgentTaskRetryPresser, person: string) {
  if (input.credentialSource !== "agent_jwt" || input.onBehalfOfUserId !== person) return false;
  const [presser] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.responsibleUserId, person))).limit(1);
  return Boolean(presser);
}

/** Called under Retry's task lock, before joining or creating an intent.
 * No unchanged-input alternative and no Retry grant supplies authority. */
export async function agentTaskRetryOriginalPerson(db: Db, input: AgentTaskRetryPresser,
  issue: typeof issues.$inferSelect, source: typeof heartbeatRuns.$inferSelect) {
  const refuse = (reason: string, message: string): never => {
    throw forbidden(message, { code: "agent_task_retry_refused", reason });
  };
  if (input.companyId !== issue.companyId || source.companyId !== issue.companyId)
    refuse("company_mismatch", "Retry must stay in the agent's company.");
  const [scheduled] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.status, "scheduled_retry"),
    or(eq(heartbeatRuns.issueId, issue.id), eq(heartbeatRuns.nativeIssueId, issue.id),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`))).limit(1);
  if (source.status === "scheduled_retry" || scheduled)
    refuse("automatic_retry_pending", "Paperclip already has an automatic retry scheduled for this task.");
  const cancellation = readRunCancellation(source.resultJson);
  if (!source.finishedAt || !["failed", "interrupted", "cancelled", "timed_out"].includes(source.status) ||
      cancellation?.initiator.type === "user" || cancellation?.source === "operator" ||
      (source.status === "cancelled" && cancellation?.expected !== false) || source.resultJson?.cancelledByUserId ||
      ["user", "board"].includes(String(source.resultJson?.cancelledByActorType ?? source.resultJson?.interruptedByActorType)) ||
      ["issue_paused", "operator_interrupted"].includes(source.errorCode ?? "") ||
      await issueTreeControlService(db).getActivePauseHoldGate(issue.companyId, issue.id))
    refuse("person_stopped_or_not_failed", "An agent cannot retry live work or work a person stopped or paused.");
  const person = source.responsibleUserId;
  if (!person) return refuse("original_person_missing", "The original run has no responsible person.");
  const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, issue.companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, person), eq(companyMemberships.status, "active"))).limit(1);
  if (!member) refuse("original_person_inactive", "The original run's person is missing or no longer an active member.");
  if (!await agentTaskRetryPresserAllowed(db, input, person))
    refuse("presser_not_acting_for_original_person", "The pressing agent must be running for the original person with run-bound credentials.");
  return person;
}

/**
 * Count an agent's Retry toward the shared daily cap on the task. The activity row
 * names the pressing agent and run, and is written before the Retry so refused
 * and failed attempts count too. A replay of an idempotency key that already
 * has a saved Retry receipt for this task and presser, or was already counted
 * for this agent within the current 24-hour window, counts once; an old
 * unsaved attempt from outside the window cannot bypass today's cap.
 */
export async function recordAgentTaskRetry(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string; idempotencyKey: string;
}) {
  const publications: ActivityPublication[] = [];
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-task-retry:${input.issueId}`}))`);
    const [savedReceipt] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.idempotencyKey, `task-retry:${input.idempotencyKey}`),
      sql`${agentWakeupRequests.payload}#>>'{taskRetry,agentRetry,agentId}' = ${input.agentId}`,
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`)).limit(1);
    if (savedReceipt) return;
    const [recentReplay] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId), eq(activityLog.action, AGENT_TASK_RETRY_ACTION),
      eq(activityLog.actorId, input.agentId), gt(activityLog.createdAt, sql`now() - interval '1 day'`),
      sql`${activityLog.details}->>'idempotencyKey' = ${input.idempotencyKey}`)).limit(1);
    if (recentReplay) return;
    const [{ value: recent }] = await tx.select({ value: count() }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, input.issueId), eq(activityLog.action, AGENT_TASK_RETRY_ACTION),
      gt(activityLog.createdAt, sql`now() - interval '1 day'`)));
    if (recent >= AGENT_TASK_RETRY_DAILY_CAP)
      throw new HttpError(429, `Agents can request at most ${AGENT_TASK_RETRY_DAILY_CAP} Retries in total on a task per day`,
        { code: "agent_task_retry_cap_reached" });
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
      agentId: input.agentId, runId: input.runId, action: AGENT_TASK_RETRY_ACTION, entityType: "issue",
      entityId: input.issueId, details: { idempotencyKey: input.idempotencyKey } },
      publications);
  });
  for (const publication of publications) publishActivity(publication);
}
