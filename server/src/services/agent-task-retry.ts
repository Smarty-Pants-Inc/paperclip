import { and, count, eq, gt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { activityLog, agentWakeupRequests, chatConversations, companyMemberships, heartbeatRuns, issues } from "@paperclipai/db";
import { readRunCancellation } from "./run-cancellation.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { AGENT_PAUSE_STOP_REASON } from "./governance-pause-stop.js";
import { HttpError } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";

/** Retries one agent may request on one task in a rolling day. */
export const AGENT_TASK_RETRY_DAILY_CAP = 3;
export const AGENT_TASK_RETRY_ACTION = "issue.retry_requested_by_agent";

/** Use the authenticated run's active person, never a grantor or task owner. */
export async function agentTaskRetryActor(db: Db, agent: { companyId: string; agentId: string; runId?: string }) {
  if (!agent.runId || !isUuidLike(agent.runId)) return null;
  const [member] = await db.select({ userId: companyMemberships.principalId, membershipRole: companyMemberships.membershipRole })
    .from(heartbeatRuns)
    .innerJoin(companyMemberships, and(eq(companyMemberships.companyId, heartbeatRuns.companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, heartbeatRuns.responsibleUserId),
      eq(companyMemberships.status, "active")))
    .where(and(
      eq(heartbeatRuns.companyId, agent.companyId),
      eq(heartbeatRuns.agentId, agent.agentId),
      eq(heartbeatRuns.id, agent.runId), eq(heartbeatRuns.status, "running")))
    .limit(1);
  if (!member) return null;
  return {
    type: "board", userId: member.userId, companyIds: [agent.companyId], isInstanceAdmin: false,
    memberships: [{ companyId: agent.companyId, membershipRole: member.membershipRole, status: "active" }],
    source: "board_key", runId: agent.runId,
  } satisfies Express.Request["actor"];
}

/** One company/task-scoped source lookup for admission, dispatch and refusal audit. */
export async function readRetrySource(db: Db, input: { companyId: string; issueId: string; sourceRunId?: string | null }) {
  if (!input.sourceRunId || !isUuidLike(input.sourceRunId) || !isUuidLike(input.issueId)) return undefined;
  const [source] = await db.select({ person: heartbeatRuns.responsibleUserId, status: heartbeatRuns.status,
    result: heartbeatRuns.resultJson, finishedAt: heartbeatRuns.finishedAt, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId),
      or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`)));
  return source;
}

/** Admission and dispatch both recheck the exact original authority. */
export async function agentTaskRetryRefusal(db: Db, input: {
  companyId: string; issueId: string; sourceRunId: string; actorId: string;
  agentRequester?: { agentId: string; runId: string };
}): Promise<string | null> {
  if (!input.agentRequester) return null;
  const authority = await agentTaskRetryActor(db, { companyId: input.companyId, ...input.agentRequester });
  if (authority?.userId !== input.actorId) return "retry_authority_unavailable";
  const source = await readRetrySource(db, input);
  if (!source?.person) return "retry_authority_unavailable";
  if (source.person !== input.actorId) return "retry_refused_different_person";
  if (!source.finishedAt || !["failed", "cancelled", "timed_out", "interrupted"].includes(source.status)) return "retry_refused_run_not_stopped";
  const [scheduled] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.status, "scheduled_retry"),
    or(eq(heartbeatRuns.issueId, input.issueId), eq(heartbeatRuns.nativeIssueId, input.issueId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`))).limit(1);
  if (scheduled) return "retry_refused_run_not_stopped";
  const cancellation = readRunCancellation(source.result);
  if (source.status === "cancelled" && cancellation?.expected !== false) return "retry_refused_stop_unverified";
  const pause = source?.result?.pauseStop as { holds?: string[]; companyPauseReason?: string } | undefined;
  if (source.result?.personStop || source.result?.personStopHeld || source.result?.cancelledByUserId ||
      ["user", "board"].includes(String(source.result?.cancelledByActorType ?? source.result?.interruptedByActorType)) || cancellation?.source === "operator" ||
      cancellation?.initiator.type === "user" || cancellation?.reason === AGENT_PAUSE_STOP_REASON ||
      pause?.holds?.includes("manual") ||
      (pause?.holds?.includes("company_paused") && pause.companyPauseReason !== "budget") ||
      ["issue_paused", "operator_interrupted"].includes(source.errorCode ?? "") ||
      await issueTreeControlService(db).getActivePauseHoldGate(input.companyId, input.issueId))
    return "retry_refused_person_stop";
  const [issue] = await db.select({ chat: issues.conversationAgentId, origin: issues.originKind }).from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const [chat] = await db.select({ id: chatConversations.id }).from(chatConversations)
    .where(and(eq(chatConversations.companyId, input.companyId), eq(chatConversations.issueId, input.issueId))).limit(1);
  if (issue?.chat || issue?.origin === "chat_channel" || chat) return "retry_refused_chat";
  return null;
}

/** Refusals name the presser independently of execution authority; no message text. */
export async function recordAgentTaskRetryRefusal(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId?: string;
  authorityUserId?: string | null; sourceRunId?: string | null; reason: string;
}, publications?: ActivityPublication[]) {
  const runId = input.runId && await agentOwnsRun(db, { ...input, runId: input.runId }) ? input.runId : undefined;
  const source = await readRetrySource(db, input);
  await logActivity(db, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
    agentId: input.agentId, runId, action: "issue.retry_refused_by_agent", entityType: "issue",
    entityId: input.issueId, details: { authorityUserId: source?.person ?? input.authorityUserId ?? null, reason: input.reason } }, publications);
}

/** Whether the run id the agent sent names one of its own runs in its company. */
export async function agentOwnsRun(db: Db, input: { companyId: string; agentId: string; runId: string }) {
  if (!isUuidLike(input.runId)) return false;
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
  return Boolean(run);
}

/**
 * Count an agent's Retry toward its daily cap on the task. The activity row
 * names the pressing agent and the authority person, and is written before the Retry so refused
 * and failed attempts count too. A replay of an idempotency key that already
 * has a saved Retry receipt for this task and authority person, or was already counted
 * for this agent within the current 24-hour window, counts once; an old
 * unsaved attempt from outside the window cannot bypass today's cap.
 */
export async function recordAgentTaskRetry(db: Db, input: {
  companyId: string; issueId: string; agentId: string; runId: string; authorityUserId: string; idempotencyKey: string;
}) {
  const publications: ActivityPublication[] = [];
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-task-retry:${input.issueId}`}))`);
    const [savedReceipt] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.idempotencyKey, `task-retry:${input.idempotencyKey}`),
      eq(agentWakeupRequests.requestedByActorId, input.authorityUserId),
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
      eq(activityLog.actorId, input.agentId), gt(activityLog.createdAt, sql`now() - interval '1 day'`)));
    if (recent >= AGENT_TASK_RETRY_DAILY_CAP)
      throw new HttpError(429, `An agent can request at most ${AGENT_TASK_RETRY_DAILY_CAP} Retries on a task per day`,
        { code: "agent_task_retry_cap_reached" });
    await logActivity(tx as unknown as Db, { companyId: input.companyId, actorType: "agent", actorId: input.agentId,
      agentId: input.agentId, runId: input.runId, action: AGENT_TASK_RETRY_ACTION, entityType: "issue",
      entityId: input.issueId, details: { authorityUserId: input.authorityUserId, idempotencyKey: input.idempotencyKey } },
      publications);
  });
  for (const publication of publications) publishActivity(publication);
}
