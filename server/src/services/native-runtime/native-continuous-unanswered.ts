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
    // A run that ended normally answered every prompt Pi took (a person's Stop returns the rest itself); only a run that
    // died mid-answer can leave an acknowledged comment unanswered, so only that hands comments to the next run.
    if (!issue || !row || !["failed", "cancelled", "timed_out", "interrupted"].includes(row.run.status) ||
        row.run.runtimeMode !== "native" || row.config.provider !== "pi_rpc" ||
        resolveSessionContinuity("pi_rpc", row.config.sessionContinuity) !== "continuous") return;
    const result = parseObject(row.run.resultJson);
    // Nothing self-starts after a person's Stop (0260): whatever was not taken went back to their input box.
    if (result.continuousUnansweredWakeId || parseObject(result.personStop).requestedAt !== undefined) return;
    const answered = new Set(Object.values(parseObject(result.continuousReplies)).flatMap(value => {
      const ids = parseObject(value).questionCommentIds;
      return Array.isArray(ids) ? ids : [];
    }));
    // A comment a person's Stop handed back to the input box is the person's to send again, never the next run's.
    const returned = parseObject(result.personStop).returned;
    if (Array.isArray(returned)) for (const id of returned) answered.add(id);
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
