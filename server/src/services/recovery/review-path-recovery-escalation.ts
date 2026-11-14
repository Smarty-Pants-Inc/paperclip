import { and, desc, eq, getTableColumns, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isWaitingConversation } from "../agent-conversations.js";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { externalConversationStateSql } from "../slack-conversation-state.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import {
  executeIssuePostCommitActions,
  issueService,
  TERMINAL_HEARTBEAT_RUN_STATUSES,
  type IssuePostCommitAction,
} from "../issues.js";
import {
  buildIssueReviewPathLostIdempotencyKey,
  decideIssueReviewPathRecovery,
  ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
  reviewPathConsumedRefFromRun,
} from "./review-path-recovery.js";
import { buildStrandedRecoveryEscalationNotice } from "./stranded-notice.js";
import { hasUnconsumedIssueMonitorPath } from "./issue-graph-liveness.js";

/*
 * No plugin hook can replace this core policy: run completion enters at run-lifecycle.ts:2155 and the stranded sweep at service.ts:4881.
 * The seam is this row-locked predicate before block-plus-note; both callers share it via review-path-recovery-escalation.ts:87,112.
 * It counts only a non-deleted assignee comment backed by chat_publications.state='published' and a non-null provider_message_id.
 * Its person-message definition matches settlement: author_agent_id IS NULL, excluding system rows without an inbound link (slack-conversation-lifecycle.ts:79-84).
 * Provider authorization is enforced at issues.ts:14143-14147; settlement's positive publication evidence is slack-conversation-lifecycle.ts:66-77.
 */
async function hasPublishedChannelAnswer(
  db: Pick<Db, "execute">,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<boolean> {
  const [row] = await db.execute<{ answered: boolean }>(sql`select exists (
    select 1
    from issue_comments answer
    join chat_publications publication
      on publication.company_id = answer.company_id
      and publication.issue_id = answer.issue_id
      and publication.comment_id = answer.id
    join chat_conversations conversation
      on conversation.company_id = publication.company_id
      and conversation.id = publication.conversation_id
      and conversation.endpoint_id = publication.endpoint_id
      and conversation.issue_id = publication.issue_id
    where answer.company_id = ${input.companyId}
      and answer.issue_id = ${input.issueId}
      and answer.author_agent_id = ${input.agentId}
      and answer.deleted_at is null
      and publication.state = 'published'
      and publication.provider_message_id is not null
      and exists (
        select 1 from issue_comments person
        where person.company_id = answer.company_id and person.issue_id = answer.issue_id
          and person.deleted_at is null and person.author_agent_id is null
          and (coalesce(person.author_type, 'user') <> 'system' or exists (
            select 1 from chat_message_links inbound
            where inbound.company_id = person.company_id and inbound.comment_id = person.id
              and inbound.conversation_id = conversation.id and inbound.direction = 'inbound'))
          and (person.created_at, person.id) < (answer.created_at, answer.id))
      and not exists (
        select 1 from issue_comments newer
        where newer.company_id = answer.company_id and newer.issue_id = answer.issue_id
          and newer.deleted_at is null and newer.author_agent_id is null
          and (coalesce(newer.author_type, 'user') <> 'system' or exists (
            select 1 from chat_message_links inbound
            where inbound.company_id = newer.company_id and inbound.comment_id = newer.id
              and inbound.conversation_id = conversation.id and inbound.direction = 'inbound'))
          and (newer.created_at, newer.id) > (answer.created_at, answer.id))
  ) as answered`);
  return row?.answered === true;
}

/** Run completion and sweep share the same predicate while holding the issue fence. */
export async function hasPublishedChannelAnswerForReviewDisposition(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const issue = await tx.select({ status: issues.status, originKind: issues.originKind,
      conversationAgentId: issues.conversationAgentId, assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId }).from(issues)
      .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)))
      .for("update").then((rows) => rows[0] ?? null);
    if (!issue || issue.status !== "in_review" || issue.originKind !== "chat_channel"
      || issue.conversationAgentId !== null || issue.assigneeAgentId !== input.agentId || issue.assigneeUserId) return false;
    return hasPublishedChannelAnswer(tx, input);
  });
}

/** A spent repair wake must leave an operator action, never another automatic wake. */
export async function escalateExhaustedIssueReviewPathRecovery(
  db: Db,
  input: { run: typeof heartbeatRuns.$inferSelect; issueId: string },
) {
  const { run, issueId } = input;
  const publications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const action = await db.transaction(async (tx) => {
    // Services must use the transaction connection for implicit settings reads
    // too; borrowing the outer pool deadlocks when its only connection is held.
    const issuesSvc = issueService(tx as unknown as Db);
    // Share the issue fence with ownership, monitor, and interaction updates.
    // Re-read the disposition under the lock rather than blocking a repaired task.
    const issue = await tx.select({ ...getTableColumns(issues), externalConversationState: externalConversationStateSql() }).from(issues)
      .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
      .for("update").then((rows) => rows[0] ?? null);
    if (!issue || issue.status !== "in_review" || issue.assigneeAgentId !== run.agentId
      || issue.assigneeUserId || isWaitingConversation(issue)
      || issue.externalConversationState === "waiting") return null;
    if (issue.originKind === "chat_channel" && issue.conversationAgentId === null
      && await hasPublishedChannelAnswer(tx, { companyId: run.companyId, issueId, agentId: run.agentId })) return null;

    // Startup recovery precedes monitor ticks. Preserve a due or claimed check
    // only while the owner still allows the on-demand wake used by dispatch.
    // Otherwise the dispatcher leaves it overdue indefinitely without consuming it.
    if (hasUnconsumedIssueMonitorPath(issue, new Date())) {
      const owner = await tx.select({ runtimeConfig: agents.runtimeConfig }).from(agents)
        .where(and(eq(agents.companyId, run.companyId), eq(agents.id, issue.assigneeAgentId)))
        .then((rows) => rows[0] ?? null);
      if (owner && isHeartbeatWakeOnDemandEnabled(owner)) return null;
    }

    const attention = (await issuesSvc.listReviewAttention(run.companyId, [issue], tx)).get(issueId);
    if (!attention || decideIssueReviewPathRecovery({
      issueId,
      sourceRunId: run.id,
      assigneeAgentId: issue.assigneeAgentId,
      contextSnapshot: run.contextSnapshot,
      reviewAttention: attention,
      existingWake: false,
    }).kind !== "exhausted") return null;

    const latestRun = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, run.companyId), or(
        eq(heartbeatRuns.issueId, issueId),
        eq(heartbeatRuns.nativeIssueId, issueId),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId') = ${issueId}`,
      )))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1)
      .then((rows) => rows[0] ?? null);
    if (latestRun?.id !== run.id || !TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) return null;

    const consumedPathRef = reviewPathConsumedRefFromRun({
      runId: run.id, issueId, contextSnapshot: run.contextSnapshot,
    });
    const nextAction = "Inspect the run, then restore a scheduled check or review path, retry the original assignee, or record an intentional resolution.";
    const recoveryAction = await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
      companyId: run.companyId,
      sourceIssueId: issueId,
      kind: "missing_disposition",
      ownerType: "board",
      previousOwnerAgentId: run.agentId,
      returnOwnerAgentId: run.agentId,
      cause: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
      fingerprint: buildIssueReviewPathLostIdempotencyKey({ issueId, consumedPathRef }),
      evidence: {
        correctiveRunId: run.id,
        consumedPathRef,
        previousStatus: "in_review",
        recoveryAttempt: 1,
        maxRecoveryAttempts: 1,
      },
      nextAction,
      wakePolicy: { type: "board_escalation", preservesSourceAssignee: true },
      attemptCount: 1,
      maxAttempts: 1,
      lastAttemptAt: run.finishedAt ?? new Date(),
    });
    await issuesSvc.update(issueId, {
      status: "blocked", companyGuard: run.companyId,
    }, tx, publications, postCommitActions);
    const notice = buildStrandedRecoveryEscalationNotice({
      seed: {
        title: "No follow-up scheduled",
        tone: "danger",
        body: "The automatic review-path repair finished without saving a scheduled check, reviewer, approval, or other maintained path. Paperclip has blocked this task for a board decision; no further automatic follow-up is scheduled.",
        nextAction,
      },
      recoveryCause: ISSUE_REVIEW_PATH_LOST_WAKE_REASON,
      recoveryActionId: recoveryAction.id,
      recoveryOwner: null,
      sourceRun: { id: run.id, agentId: run.agentId, status: run.status },
    });
    const comment = await issuesSvc.addComment(issueId, notice.body, {}, {
      authorType: "system", presentation: notice.presentation, metadata: notice.metadata,
    }, tx);
    await logActivity(tx as unknown as Db, {
      companyId: run.companyId,
      actorType: "system",
      actorId: "heartbeat",
      agentId: run.agentId,
      runId: run.id,
      action: "issue.review_path_recovery_exhausted",
      entityType: "issue",
      entityId: issueId,
      details: { recoveryActionId: recoveryAction.id, commentId: comment.id, consumedPathRef, recoveryAttempt: 1, maxRecoveryAttempts: 1 },
    }, publications);
    return recoveryAction;
  });
  for (const publication of publications) publishActivity(publication);
  await executeIssuePostCommitActions(db, postCommitActions);
  return action;
}
