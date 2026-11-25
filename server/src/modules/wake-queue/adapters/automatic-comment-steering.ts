import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { agentRunWritesRevoked } from "../../../agent-run-cancellation.js";
import { isConversationReset } from "../../../services/agent-conversations.js";
import { logActivity } from "../../../services/activity-log.js";
import { createSteerQueuedComment } from "../application/queued-comment-use-cases.js";
import { createQueuedCommentSteeringAdapter, readBoardQueuedComments } from "./queued-comment-board-postgres.js";
import { parseObject } from "../domain/values.js";
import { isAutomaticSteeringComment, isAutomaticSteeringWake } from "../domain/policy.js";

/** Called only after comment and wake admission commit. The page and this path
 * share the same delivery, identity, ACK and wake-consumption transaction. */
export async function steerCommittedQueuedComment(db: Db, scope: { companyId: string; issueId: string; agentId: string; commentId: string }) {
  const [row] = await db.select({ issue: issues, run: heartbeatRuns, comment: issueComments }).from(issues)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, issues.executionRunId), eq(heartbeatRuns.companyId, issues.companyId),
      eq(heartbeatRuns.agentId, issues.assigneeAgentId)))
    .innerJoin(issueComments, and(eq(issueComments.id, scope.commentId), eq(issueComments.issueId, issues.id),
      eq(issueComments.companyId, issues.companyId)))
    .where(and(eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId), eq(issues.assigneeAgentId, scope.agentId)));
  if (!row || row.comment.authorType !== "agent" || !row.comment.authorAgentId || row.run.status !== "running" || row.comment.deletedAt || agentRunWritesRevoked(row.run) || row.run.resultJson?.personStop ||
      !isAutomaticSteeringComment(row.comment, row.run.agentId)) return;
  const actor = { actorType: "agent" as const, actorId: row.comment.authorAgentId, agentId: row.comment.authorAgentId,
    runId: row.comment.createdByRunId, agentApiKeyId: null };
  const board = await readBoardQueuedComments({ executor: db, issue: row.issue, activeRun: row.run, actor });
  const entry = board.entries[0];
  if (board.state !== "deferred" || board.steeringDisposition !== "available" || !board.queueId ||
      board.targetRunId !== row.run.id || !entry || entry.comment.id !== scope.commentId || entry.source?.requiresFreshSession ||
      board.entries.some(({ comment }) => isConversationReset(comment.body)) ||
      (board.executionWait && board.executionWait.reason !== "execution_recovery")) return;
  const [wake] = await db.select({ payload: agentWakeupRequests.payload, reason: agentWakeupRequests.reason }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, board.queueId), eq(agentWakeupRequests.companyId, scope.companyId),
    eq(agentWakeupRequests.agentId, scope.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
  if (!wake || !isAutomaticSteeringWake(wake.reason, parseObject(wake.payload?._paperclipWakeContext))) return;
  const accepted = await createSteerQueuedComment(createQueuedCommentSteeringAdapter(db, { requireQueueHead: true }))({
    issue: row.issue, actor, queueId: board.queueId, revision: board.revision, targetRunId: row.run.id, commentId: scope.commentId,
  });
  await logActivity(db, { companyId: scope.companyId, ...actor, action: "issue.queued_comment_steered",
    entityType: "issue", entityId: scope.issueId, details: { commentId: scope.commentId, targetRunId: row.run.id,
      turnId: accepted.turnId, duplicate: accepted.duplicate, automatic: true } });
  return accepted;
}
