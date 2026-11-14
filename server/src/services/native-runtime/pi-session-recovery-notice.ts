import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, issueComments, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import type { NativeExecutionInput, PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { notifyStatusCardIssueChange } from "../status-card-notifications.js";
import { notifyIssueRecovery } from "../issue-recovery-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { readPiConversation } from "./pi-conversation-record.js";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nativeId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
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

function invalidPiSessionRecovery(event: Pick<PrpEvent, "eventType" | "payload" | "normalizedSessionId">): { previousId: string; preservedFile: string } | null {
  if (event.eventType !== "session.resumed" && event.eventType !== "run.attached") return null;
  const nativeReceipt = event.payload.provider === "pi_rpc";
  const admission = nativeReceipt ? record(record(event.payload.providerDescriptor).piNativeAdmission)
    : record(record(event.payload.context).piNativeAdmission);
  const recovery = record(event.eventType === "run.attached" ? event.payload.piSessionRecovery : admission.sessionRecovery);
  if (recovery.reason !== "pi_session_file_invalid" || recovery.normalizedSessionId !== event.normalizedSessionId
    || !nativeId(recovery.previousSessionId) || typeof recovery.preservedFile !== "string"
    || /[\\/]/u.test(recovery.preservedFile)
    || !recovery.preservedFile.startsWith(`${event.normalizedSessionId}.jsonl.invalid-`)
    || !/\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(recovery.preservedFile)) return null;
  if (event.eventType === "session.resumed" && ((!nativeReceipt && (event.payload.provider !== undefined || admission.provider !== "pi_rpc"))
    || !nativeId(admission.providerSessionId) || admission.providerSessionId === recovery.previousSessionId
    || admission.providerSessionId !== (nativeReceipt ? event.payload.providerSessionId : event.payload.driverSessionId)
    || admission.providerSessionId !== (nativeReceipt ? event.payload.providerAccountSessionId : event.payload.providerSessionId))) return null;
  return { previousId: recovery.previousSessionId, preservedFile: recovery.preservedFile };
}

/** Shared typed projection for lasting history-loss boundaries, including legacy
 * selection. Caller must hold the company-scoped issue → run → task locks and
 * verify admission authority in this same transaction. Detail links preserve
 * run provenance without transient run ownership in chat relevance. */
export async function writePiSessionHistoryLossNotice(db: Db,
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0], input: {
    companyId: string; issueId: string; runId: string; agentId: string;
    authorizationReason: string; body: string; replaceExisting?: boolean;
  }): Promise<boolean> {
  const { companyId, issueId, runId, agentId, authorizationReason, body } = input;
  const [existing] = await tx.select({ id: issueComments.id, body: issueComments.body }).from(issueComments).where(and(
    eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
    eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt),
    sql`${issueComments.metadata}->>'authorizationReason' = ${authorizationReason}`)).limit(1);
  if (existing) {
    if (input.replaceExisting && existing.body !== body) {
      const updatedAt = new Date();
      await tx.update(issueComments).set({ body, updatedAt }).where(and(
        eq(issueComments.companyId, companyId), eq(issueComments.id, existing.id)));
      await tx.update(issues).set({ updatedAt }).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)));
      // Same transaction-scoped invalidations as the shared comment writer.
      // Rechecking an unchanged waiting note must not generate more work.
      await notifyStatusCardIssueChange(tx, companyId);
      await notifyIssueRecovery(tx, { companyId, issueId });
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.dotEvents, `company:${companyId}`);
    }
    return false;
  }
  await issueService(db).addComment(issueId, body, {}, { authorType: "system", presentation: {
    kind: "system_notice", tone: "warning", density: "compact", detailsDefaultOpen: false,
  }, metadata: { version: 1, authorizationReason,
    sections: [{ rows: [{ type: "run_link", runId, agentId, title: "Fresh conversation" }] }] } }, tx);
  return true;
}

/** authorizationReason prefix of the durable notice written when a
 * conversation is held behind an unfinished predecessor; the normalized native
 * session id follows it. */
export const HELD_CONVERSATION_NOTICE_REASON_PREFIX = "native_prior_owner_held:";

export type HeldConversationNotice = {
  commentId: string;
  issueId: string;
  normalizedSessionId: string;
  body: string;
  createdAt: Date;
};

/**
 * The newest held-conversation notice per issue, unless it is superseded: a
 * LATER run (created after the notice) on the same issue AND the same native
 * session that succeeded with a committed result. A success on another session
 * (a fresh conversation for a new task) does not clear it. One set-based read
 * for the whole batch.
 */
export async function readUnsupersededHeldConversationNotices(db: Db,
  input: { companyId: string; issueIds: readonly string[] }): Promise<Map<string, HeldConversationNotice>> {
  const notices = new Map<string, HeldConversationNotice>();
  const issueIds = [...new Set(input.issueIds)];
  if (!issueIds.length) return notices;
  const reason = sql<string>`${issueComments.metadata}->>'authorizationReason'`;
  const sessionOf = sql`substr(${reason}, ${HELD_CONVERSATION_NOTICE_REASON_PREFIX.length + 1})`;
  const rows = await db.selectDistinctOn([issueComments.issueId], {
    commentId: issueComments.id,
    issueId: issueComments.issueId,
    reason,
    body: issueComments.body,
    createdAt: issueComments.createdAt,
    // Compared in SQL so the notice and run timestamps keep full precision.
    superseded: sql<boolean>`exists (select 1 from ${heartbeatRuns} later
      join ${nativeRunFinalizations} finalization on finalization.company_id = later.company_id
        and finalization.run_id = later.id
      where later.company_id = issue_comments.company_id
        and later.native_issue_id = issue_comments.issue_id
        and later.native_session_id::text = ${sessionOf}
        and later.status = 'succeeded'
        and finalization.phase = 'committed'
        and later.created_at > issue_comments.created_at)`,
  }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    inArray(issueComments.issueId, issueIds),
    eq(issueComments.authorType, "system"),
    isNull(issueComments.deletedAt),
    sql`starts_with(${reason}, ${HELD_CONVERSATION_NOTICE_REASON_PREFIX})`,
  )).orderBy(issueComments.issueId, desc(issueComments.createdAt), desc(issueComments.id));
  for (const row of rows) {
    const normalizedSessionId = row.reason.slice(HELD_CONVERSATION_NOTICE_REASON_PREFIX.length);
    if (row.superseded || !normalizedSessionId) continue;
    notices.set(row.issueId, { commentId: row.commentId, issueId: row.issueId, normalizedSessionId,
      body: row.body, createdAt: row.createdAt });
  }
  return notices;
}

/** The issue's held-conversation notice that still stands, or null. */
export async function readUnsupersededHeldConversationNotice(db: Db,
  input: { companyId: string; issueId: string }): Promise<HeldConversationNotice | null> {
  return (await readUnsupersededHeldConversationNotices(db, { companyId: input.companyId, issueIds: [input.issueId] }))
    .get(input.issueId) ?? null;
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
  const code = invalid ? "pi_session_file_invalid" : "pi_session_file_missing";
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
    return writePiSessionHistoryLossNotice(db, tx, { companyId, issueId, runId, agentId, authorizationReason: key,
      body: invalid ? invalidNotice
        : "My earlier conversation could not be restored: the saved Pi conversation file is missing on this computer. Starting a new one." });
  });
  if (inserted) logger.error({ companyId, agentId, issueId, runId, code,
    ...(invalid ? { preservedFile: invalid.preservedFile } : {}), normalizedSessionId: event.normalizedSessionId },
  invalid ? "Pi saved-history recovery owner alarm: original file preserved; native session restarted fresh"
    : "Pi saved-history recovery owner alarm: saved history unavailable; native session restarted fresh");
}
