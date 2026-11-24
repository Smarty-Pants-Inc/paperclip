import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";
import { withQueuedCommentIdsInRunContext, withQueuedCommentIdsInWakePayload } from "../issue-queued-comment-queue.js";
import { resolveSessionContinuity } from "./continued-session.js";
import { recoverContinuousNativeReplies } from "./native-continuous-reply.js";

/** Hand unanswered delivery receipts back to the ordinary deferred queue before release. */
export async function requeueContinuousUnanswered(db: Db, scope: { id: string; companyId: string }) {
  await recoverContinuousNativeReplies(db, scope);
  const [source] = await db.select({ issueId: heartbeatRuns.nativeIssueId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId)));
  if (!source?.issueId) return;
  await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, source.issueId!),
      eq(issues.companyId, scope.companyId))).for("update");
    const [row] = await tx.select({ run: heartbeatRuns, config: agents.adapterConfig }).from(heartbeatRuns)
      .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, scope.companyId)))
      .where(and(eq(heartbeatRuns.id, scope.id), eq(heartbeatRuns.companyId, scope.companyId)))
      .for("update", { of: heartbeatRuns });
    if (!issue || !row || !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(row.run.status) ||
        row.run.runtimeMode !== "native" || row.config.provider !== "pi_rpc" ||
        resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous") return;
    const result = parseObject(row.run.resultJson);
    if (result.continuousUnansweredWakeId) return;
    const answered = new Set(Object.values(parseObject(result.continuousReplies)).flatMap(value => {
      const ids = parseObject(value).questionCommentIds;
      return Array.isArray(ids) ? ids : [];
    }));
    const ids = Object.entries(parseObject(result.queuedSteeringAcknowledgements))
      .filter(([id, receipt]) => !answered.has(id) && parseObject(receipt).status === "acknowledged")
      .sort((a, b) => String(parseObject(a[1]).acknowledgedAt).localeCompare(String(parseObject(b[1]).acknowledgedAt)))
      .map(([id]) => id);
    if (!ids.length) return;
    const context = withQueuedCommentIdsInRunContext({ issueId: issue.id, source: "issue.comment",
      wakeReason: "issue_commented", forceFreshSession: false,
      ...(issue.conversationAgentId ? { conversationSessionGeneration: issue.conversationSessionGeneration } : {}),
    }, ids);
    const [wake] = await tx.insert(agentWakeupRequests).values({ companyId: scope.companyId, agentId: row.run.agentId,
      source: "issue", triggerDetail: "comment", reason: "issue_commented", status: "deferred_issue_execution",
      payload: withQueuedCommentIdsInWakePayload({ issueId: issue.id, _paperclipWakeContext: context }, ids),
      requestedByActorType: row.run.responsibleUserId ? "user" : "system", requestedByActorId: row.run.responsibleUserId,
      idempotencyKey: `continuous-unanswered:${scope.id}` }).returning({ id: agentWakeupRequests.id });
    await tx.update(heartbeatRuns).set({ resultJson: { ...result, continuousUnansweredWakeId: wake.id } })
      .where(eq(heartbeatRuns.id, scope.id));
  });
}
