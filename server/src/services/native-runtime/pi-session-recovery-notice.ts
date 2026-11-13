import { and, eq, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { issueService } from "../issues.js";
import { readPiConversation } from "./pi-conversation-record.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const nativeId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

/** Runner-owned admission receipt, not text from a provider/model message. */
export function piSessionRecovery(event: Pick<PrpEvent, "eventType" | "payload">): { previousId: string; id: string } | null {
  if (!["session.started", "session.resumed", "harness.ready"].includes(event.eventType)) return null;
  const nativeReceipt = event.payload.provider === "pi_rpc";
  const admission = nativeReceipt ? record(record(event.payload.providerDescriptor).piNativeAdmission)
    : record(record(event.payload.context).piNativeAdmission);
  if (!nativeReceipt && admission.provider !== "pi_rpc") return null;
  const recovery = record(admission.sessionRecovery);
  if (recovery.code !== "pi_session_file_missing" || !nativeId(recovery.previousDriverSessionId)
    || !nativeId(recovery.driverSessionId) || recovery.previousDriverSessionId === recovery.driverSessionId
    || recovery.driverSessionId !== (nativeReceipt ? event.payload.providerSessionId : event.payload.driverSessionId)
    || recovery.driverSessionId !== (nativeReceipt ? event.payload.providerAccountSessionId : event.payload.providerSessionId)) return null;
  return { previousId: recovery.previousDriverSessionId, id: recovery.driverSessionId };
}

/** Also invoked on durable event replay, repairing an interrupted projection.
 * The issue lock serializes the provenance-key check and comment insert across
 * events, runs and controllers. Later warm identity events cannot repeat it. */
export async function materializePiSessionRecoveryNotice(input: {
  db: Db; execution: NativeExecutionInput; event: PrpEvent;
}): Promise<void> {
  const { db, execution, event } = input;
  const recovery = piSessionRecovery(event);
  const { companyId, agentId, issueId, runId } = execution.binding;
  if (!recovery || execution.provider.kind !== "pi_rpc" || event.runId !== runId
    || event.normalizedSessionId !== execution.session.normalizedSessionId) return;
  const key = `pi_session_file_missing:${event.normalizedSessionId}:${recovery.previousId}`;
  await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("no key update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))).for("update");
    if (!issue || !run || run.status !== "running" || run.resultJson?.startupCancellation
      || run.nativeSessionId !== event.normalizedSessionId || run.nativeIssueId !== issueId
      || (issue.conversationAgentId && (issue.conversationAgentId !== agentId
        || run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration))) return;
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"),
      eq(agentTaskSessions.taskKey, issueId))).for("update");
    if (readPiConversation(session?.sessionParamsJson)?.id !== event.normalizedSessionId) return;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      sql`${issueComments.metadata}->>'authorizationReason' = ${key}`)).limit(1);
    if (existing) return;
    await issueService(db).addComment(issueId,
      "My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one.",
      // This is a lasting transcript boundary, not the run's status. Keep
      // run provenance in its detail link without making chat relevance hide
      // the notice when this run completes or a later turn is admitted.
      {}, { authorType: "system", presentation: {
        kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false,
      }, metadata: { version: 1, authorizationReason: key,
        sections: [{ rows: [{ type: "run_link", runId, agentId, title: "Fresh conversation" }] }] } }, tx);
  });
}
