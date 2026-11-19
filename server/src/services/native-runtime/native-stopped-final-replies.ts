import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getServerProcessStartedAt } from "../../server-info.js";
import { agentRunSuperseded, lockAgentForRunWrite } from "../../agent-run-cancellation.js";
import { isAcknowledgedNativeStop } from "../acknowledged-native-stop.js";
import { publishChatPublicationCommitSignal } from "../chat-publication-reconciliation.js";
import { resolveChatRunPresentationAuthorizationReason } from "../chat-run-publications.js";
import { stopAcceptanceEventSql } from "../heartbeat-run-events.js";
import { issueService } from "../issues.js";
import { readRunCancellation } from "../run-cancellation.js";
import { completedNativeResponseItems } from "./native-response-items.js";

/** Stop's own finalization ONLY, never a discovery/reconciliation work item.
 * Item completion is narrower than run-result acceptance: a person's Stop
 * ends work, not the already completed answers. The server acceptance sequence
 * fences out partial messages and finals recorded after Stop. An old Stop is
 * never publication authority in a new server process (the Monday boundary).
 */
export async function publishStoppedNativeFinals(db: Db, input: { companyId: string; runId: string }) {
  const [source] = await db.select({ agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.nativeIssueId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  if (!source?.issueId) return [];
  const comments = await db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await lockAgentForRunWrite(tx, input.companyId, source.agentId);
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, source.issueId!),
      eq(issues.companyId, input.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId))).for("update");
    if (!issue || !run || run.runtimeMode !== "native" || run.status !== "cancelled" || !run.nativeSessionId
      || agentRunSuperseded(run) || !isAcknowledgedNativeStop(run) || !run.finishedAt) return [];
    const cancellation = readRunCancellation(run.resultJson);
    if (!cancellation?.expected || cancellation.initiator.type !== "user" || !cancellation.initiator.id
      || !["operator", "queued_message"].includes(cancellation.source)
      || run.contextSnapshot?.skipIssueComment === true) return [];
    const [stop] = await tx.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, run.id), stopAcceptanceEventSql(),
      sql`${heartbeatRunEvents.payload}->>'schema' = 'paperclip.stop-acceptance.v1'`,
      sql`${heartbeatRunEvents.payload}->>'kind' in ('person_stop', 'interrupt')`,
      sql`${heartbeatRunEvents.payload}->>'issueId' = ${issue.id}`,
      sql`${heartbeatRunEvents.payload}->>'userId' = ${cancellation.initiator.id}`,
    )).orderBy(asc(heartbeatRunEvents.seq)).limit(1);
    const boot = new Date(getServerProcessStartedAt());
    if (!stop || stop.createdAt < boot || new Date(cancellation.recordedAt) < boot || run.finishedAt < boot) return [];
    if (issue.conversationAgentId && (issue.conversationAgentId !== run.agentId
      || issue.conversationUserId !== run.responsibleUserId
      || run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration)) return [];
    // External-chat delivery has its own authority; this repair is the internal
    // chat/task reply path, never an endpoint authorization bypass.
    if (await resolveChatRunPresentationAuthorizationReason(tx, { ...input, issueId: issue.id }) !== "internal_agent_write") return [];
    const items = await completedNativeResponseItems(tx, { ...input, agentId: run.agentId,
      nativeSessionId: run.nativeSessionId, beforeSeq: stop.seq });
    const replies = [];
    const seen = new Set<string>();
    const createdAt = Date.now();
    for (const item of items) {
      if (item.providerPhase !== "final_answer" || seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      replies.push(await issueService(db).addComment(issue.id, item.text, { agentId: run.agentId, runId: run.id }, {
        authorizationReason: "internal_agent_write", completionReply: true, completionReplyItemId: item.itemId,
        stoppedFinalReply: true, createdAt: new Date(createdAt + replies.length),
      }, tx));
    }
    return replies;
  });
  if (comments.length) publishChatPublicationCommitSignal({ ...input, issueId: source.issueId,
    agentId: source.agentId, eventType: "run.presentation.resolved" });
  return comments;
}
