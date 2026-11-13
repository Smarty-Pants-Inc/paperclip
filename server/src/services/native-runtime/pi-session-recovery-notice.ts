import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { readPiConversation } from "./pi-conversation-record.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nativeId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const partialNotice = "Part of my saved Pi conversation was interrupted (pi_session_file_partial). Earlier complete history was restored, but some already-shown messages or tool results may be missing from my memory. The original file was preserved.";
const invalidNotice = "My earlier Pi conversation could not be restored (pi_session_file_invalid: the saved file is corrupt, foreign, or has a different identity). The original file was preserved. Starting fresh in this conversation.";

/** Runner-owned admission receipt, not text from a provider/model message. */
export function piSessionRecovery(event: Pick<PrpEvent, "eventType" | "payload" | "normalizedSessionId">): { previousId: string; id: string } | null {
  if (!["session.started", "session.resumed", "harness.ready"].includes(event.eventType)) return null;
  const nativeReceipt = event.payload.provider === "pi_rpc";
  const admission = nativeReceipt ? record(record(event.payload.providerDescriptor).piNativeAdmission)
    : record(record(event.payload.context).piNativeAdmission);
  if (!nativeReceipt && admission.provider !== "pi_rpc") return null;
  const recovery = record(admission.sessionRecovery);
  if (recovery.reason === "pi_session_file_invalid") {
    const invalid = invalidPiSessionRecovery(event);
    return invalid && nativeId(admission.providerSessionId) ? { previousId: invalid.previousId, id: admission.providerSessionId } : null;
  }
  if (recovery.code !== "pi_session_file_missing" || !nativeId(recovery.previousDriverSessionId)
    || !nativeId(recovery.driverSessionId) || recovery.previousDriverSessionId === recovery.driverSessionId
    || recovery.driverSessionId !== (nativeReceipt ? event.payload.providerSessionId : event.payload.driverSessionId)
    || recovery.driverSessionId !== (nativeReceipt ? event.payload.providerAccountSessionId : event.payload.providerSessionId)) return null;
  return { previousId: recovery.previousDriverSessionId, id: recovery.driverSessionId };
}

function invalidPiSessionRecovery(event: Pick<PrpEvent, "eventType" | "payload" | "normalizedSessionId">): { previousId: string; preservedFile: string; partial: boolean } | null {
  if (event.eventType !== "session.resumed" && event.eventType !== "run.attached") return null;
  const nativeReceipt = event.payload.provider === "pi_rpc";
  const admission = nativeReceipt ? record(record(event.payload.providerDescriptor).piNativeAdmission)
    : record(record(event.payload.context).piNativeAdmission);
  const recovery = record(event.eventType === "run.attached" ? event.payload.piSessionRecovery : admission.sessionRecovery);
  const partial = recovery.reason === "pi_session_file_partial" && recovery.historyLost === true;
  if ((recovery.reason !== "pi_session_file_invalid" && !partial) || recovery.normalizedSessionId !== event.normalizedSessionId
    || !nativeId(recovery.previousSessionId) || typeof recovery.preservedFile !== "string"
    || /[\\/]/u.test(recovery.preservedFile)
    || !recovery.preservedFile.startsWith(`${event.normalizedSessionId}.jsonl.invalid-`)
    || !/\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(recovery.preservedFile)) return null;
  if (event.eventType === "session.resumed" && ((!nativeReceipt && (event.payload.provider !== undefined || admission.provider !== "pi_rpc"))
    || !nativeId(admission.providerSessionId) || (partial ? admission.providerSessionId !== recovery.previousSessionId : admission.providerSessionId === recovery.previousSessionId)
    || admission.providerSessionId !== (nativeReceipt ? event.payload.providerSessionId : event.payload.driverSessionId)
    || admission.providerSessionId !== (nativeReceipt ? event.payload.providerAccountSessionId : event.payload.providerSessionId))) return null;
  return { previousId: recovery.previousSessionId, preservedFile: recovery.preservedFile, partial };
}

/** Both typed history-loss receipts use one authority check, issue lock and
 * provenance-key projection. Durable replay repairs an interrupted comment;
 * later warm events or run rotation cannot duplicate a committed notice. */
export async function materializePiSessionRecoveryNotice(input: {
  db: Db; execution: NativeExecutionInput; event: PrpEvent;
}): Promise<void> {
  const { db, execution, event } = input;
  const missing = piSessionRecovery(event);
  const invalid = invalidPiSessionRecovery(event);
  const { companyId, agentId, issueId, runId } = execution.binding;
  if ((!missing && !invalid) || execution.provider.kind !== "pi_rpc" || event.runId !== runId
    || event.normalizedSessionId !== execution.session.normalizedSessionId) return;
  const code = invalid?.partial ? "pi_session_file_partial" : invalid ? "pi_session_file_invalid" : "pi_session_file_missing";
  // Comment authorizationReason is bounded to 160 characters. Hash the full
  // preserved basename (including its unique suffix), never truncate identity.
  const provenance = invalid ? createHash("sha256").update(invalid.preservedFile).digest("hex") : missing!.previousId;
  const key = `${code}:${event.normalizedSessionId}:${provenance}`;
  const inserted = await db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("no key update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId))).for("update");
    if (!issue || !run || run.status !== "running" || run.resultJson?.startupCancellation
      || run.nativeSessionId !== event.normalizedSessionId || run.nativeIssueId !== issueId
      || (issue.conversationAgentId && (issue.conversationAgentId !== agentId
        || run.contextSnapshot?.conversationSessionGeneration !== issue.conversationSessionGeneration))) return false;
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, companyId),
      eq(agentTaskSessions.agentId, agentId), eq(agentTaskSessions.adapterType, "paperclip_runner"),
      eq(agentTaskSessions.taskKey, issueId))).for("update");
    if (readPiConversation(session?.sessionParamsJson)?.id !== event.normalizedSessionId) return false;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      sql`${issueComments.metadata}->>'authorizationReason' = ${key}`)).limit(1);
    if (existing) return false;
    await issueService(db).addComment(issueId, invalid?.partial ? partialNotice : invalid ? invalidNotice
      : "My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one.",
      // Every history-loss reason is a lasting transcript boundary, not run
      // status. Keep provenance in its detail link without making chat relevance
      // hide the notice when this run completes or a later turn is admitted.
      {}, { authorType: "system", presentation: {
        kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false,
      }, metadata: { version: 1, authorizationReason: key,
        sections: [{ rows: [{ type: "run_link", runId, agentId, title: invalid?.partial ? "Recovered conversation" : "Fresh conversation" }] }] } }, tx);
    return true;
  });
  if (inserted && invalid) logger.error({ companyId, agentId, issueId, runId, code,
    preservedFile: invalid.preservedFile, normalizedSessionId: event.normalizedSessionId },
  invalid.partial ? "Pi saved-history recovery owner alarm: complete prefix restored; visible history may be missing"
    : "Pi saved-history recovery owner alarm: original file preserved; native session restarted fresh");
}
