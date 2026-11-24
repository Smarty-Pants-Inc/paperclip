import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { agentRunWritesRevoked } from "../../agent-run-cancellation.js";
import { createSteerQueuedComment } from "../../modules/wake-queue/application/queued-comment-use-cases.js";
import { createQueuedCommentSteeringAdapter, readBoardQueuedComments } from "../../modules/wake-queue/adapters/queued-comment-board-postgres.js";
import { logActivity } from "../activity-log.js";
import { resolveSessionContinuity } from "./continued-session.js";

// Final publication can be replayed or observed concurrently. The queue mutation
// still owns durable idempotence; this only serializes local drain attempts.
const drains = new Map<string, Promise<void>>();

/** Reuse the board's FIFO queue and ACK/consumption path, never the release path. */
export async function drainContinuousPersonMessages(db: Db, scope: { companyId: string; issueId: string; runId: string; agentId: string }) {
  const key = `${scope.companyId}:${scope.runId}`;
  const pending = drains.get(key);
  if (pending) return pending;
  const work = drain(db, scope);
  drains.set(key, work);
  try { await work; } finally { if (drains.get(key) === work) drains.delete(key); }
}

async function drain(db: Db, scope: { companyId: string; issueId: string; runId: string; agentId: string }) {
  const steer = createSteerQueuedComment(createQueuedCommentSteeringAdapter(db));
  const actor = { actorType: "agent" as const, actorId: scope.agentId, agentId: scope.agentId,
    runId: scope.runId, agentApiKeyId: null };
  for (;;) {
    // These reads deliberately hold NO issue lock. Steering owns its transaction
    // and appends run events before taking its acknowledgement run-row lock.
    const [row] = await db.select({ run: heartbeatRuns, issue: issues, config: agents.adapterConfig, agentStatus: agents.status })
      .from(heartbeatRuns)
      .innerJoin(issues, and(eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId)))
      .innerJoin(agents, and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)))
      .where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
        eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.nativeIssueId, scope.issueId)));
    if (!row || row.run.status !== "running" || row.run.runtimeMode !== "native" || agentRunWritesRevoked(row.run) || row.run.resultJson?.personStop ||
        row.issue.executionRunId !== scope.runId || row.issue.assigneeAgentId !== scope.agentId ||
        (row.issue.conversationAgentId && (row.issue.conversationAgentId !== scope.agentId || row.issue.conversationState !== "active" ||
          row.run.contextSnapshot?.conversationSessionGeneration !== row.issue.conversationSessionGeneration)) ||
        ["paused", "terminated", "pending_approval", "error"].includes(row.agentStatus) ||
        row.config.provider !== "pi_rpc" || resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous" ||
        !Object.keys((row.run.resultJson?.continuousReplies ?? {}) as object).length) return;
    const board = await readBoardQueuedComments({ executor: db, issue: row.issue, activeRun: row.run, actor });
    const head = board.entries[0];
    if (board.state !== "deferred" || board.executionWait || board.steeringDisposition !== "available" || !board.queueId ||
        !head || head.comment.authorType !== "user" || !head.comment.authorUserId ||
        head.comment.body.trim() === "/new" || head.source?.requiresFreshSession) return;
    const [wake] = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, board.queueId), eq(agentWakeupRequests.companyId, scope.companyId),
      eq(agentWakeupRequests.agentId, scope.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    if (!wake || parseObject(wake.payload?._paperclipWakeContext).forceFreshSession === true) return;
    const accepted = await steer({ issue: row.issue, actor,
      queueId: board.queueId, commentId: head.comment.id, targetRunId: scope.runId, revision: board.revision });
    if (accepted.duplicate) return;
    await logActivity(db, { companyId: scope.companyId, actorType: "system", actorId: "continuous-person-drain",
      agentId: scope.agentId, runId: scope.runId, issueId: scope.issueId,
      action: "issue.queued_comment_steered", entityType: "issue", entityId: scope.issueId,
      details: { commentId: head.comment.id, queueId: board.queueId, targetRunId: scope.runId,
        turnId: accepted.turnId, automatic: true } });
    // Re-read after each ACK: edits, Stop, a reset head, or a competing sender
    // must take effect before the next person message is delivered.
  }
}
