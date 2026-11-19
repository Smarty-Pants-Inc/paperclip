import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { readPersonStopHold } from "../acknowledged-native-stop.js";
import { PersistedExecutionWaitRefusal } from "../deferred-execution-wait.js";
import { queuedCommentIdsFromWakePayload } from "../issue-queued-comment-queue.js";
import { settleUnansweredPersonMessage } from "../recovery/unanswered-person-message.js";
import type { WakeupOptions } from "./run-preparation.js";

/** Release has committed. Restored input is a person's ordinary comment, not
 * automatic failure recovery: needs_review must not swallow their next turn.
 * Reconsider the saved receipt through the SAME enqueueWakeup used by the
 * comment outbox, adopting it under ordinary admission's issue-row fence. */
export async function admitRestoredSteersAfterRelease(
  db: Db,
  source: { companyId: string; id: string },
  enqueue: (agentId: string, options: WakeupOptions, requestId?: string) => Promise<unknown>,
): Promise<void> {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, source.id),
    inArray(heartbeatRuns.status, ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]),
  ));
  const restored = parseObject(run?.resultJson).restoredSteeredCommentIds;
  if (!run || !Array.isArray(restored) || !restored.length) return;
  const issueId = parseObject(run.contextSnapshot).issueId ?? run.nativeIssueId;
  if (typeof issueId !== "string") return;
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, source.companyId), eq(issues.id, issueId),
    eq(issues.conversationAgentId, run.agentId), eq(issues.assigneeAgentId, run.agentId)));
  if (!issue) return;
  const pending = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, source.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
  for (const wake of pending) {
    const ids = queuedCommentIdsFromWakePayload(wake.payload);
    // An unrelated waiting message retains its own queue/admission owner.
    if (!ids.length || !ids.every(id => restored.includes(id))) continue;
    const [successor] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.agentId, run.agentId),
      or(eq(heartbeatRuns.nativeIssueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
      inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    )).limit(1);
    if (successor) return;
    // A restored, pre-Stop message is not a new Send. Use the ONE hold reader;
    // only the person's later Send can authorize delivery of this held batch.
    if (await readPersonStopHold(db, { companyId: source.companyId, issueId, agentId: run.agentId, wakeId: wake.id })) {
      await settleUnansweredPersonMessage(db, { companyId: source.companyId, issueId });
      return;
    }
    const [comment] = await db.select().from(issueComments).where(and(eq(issueComments.companyId, source.companyId),
      eq(issueComments.issueId, issue.id), eq(issueComments.id, ids[0]!), isNull(issueComments.deletedAt)));
    if (!comment?.authorUserId) continue;
    try {
      await enqueue(run.agentId, {
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        idempotencyKey: `conversation-comment:${comment.id}`,
        requestedByActorType: "user", requestedByActorId: comment.authorUserId,
        payload: { issueId, commentId: comment.id },
        contextSnapshot: { issueId, taskKey: issueId, commentId: comment.id, wakeCommentId: comment.id,
          wakeCommentIds: ids, source: "issue.comment" },
      }, wake.id);
    } catch (error) {
      // Ordinary admission remains authoritative (pause, Stop, budgets, cleanup).
      // Its persisted wait retains custody. Reuse the existing fenced writer;
      // an operational failure must still propagate rather than look delivered.
      await settleUnansweredPersonMessage(db, { companyId: source.companyId, issueId });
      if (!(error instanceof PersistedExecutionWaitRefusal)) throw error;
    }
  }
}
