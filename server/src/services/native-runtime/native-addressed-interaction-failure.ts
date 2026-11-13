import { heartbeatRuns, issueComments, issues, issueThreadInteractions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { and, eq, isNull } from "drizzle-orm";
import type { ActivityPublication } from "../../types/activity-publication.js";
import { persistActivity } from "../activity-log.js";
import { insertIssueComment } from "../issue-comment-writes.js";
import { isIssueReviewVerdictInteraction } from "../issue-review-policy.js";
import { readNativeAddressedInteractionId, type NativeAddressedInteractionBinding } from "./native-addressed-interaction.js";

export const NATIVE_ADDRESSED_INTERACTION_FAILED = "native_addressed_interaction_failed";
export const NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE =
  "Paperclip could not handle the addressed confirmation card; it remains pending.";
export const NATIVE_ADDRESSED_INTERACTION_FAILURE_ACTION =
  "This addressed card run has stopped. Check the card's current state before sending a new card event. Automatic retry is stopped.";

type AddressedFailure = { interactionId: string; state: string };

async function readOrdinaryAddressedFailureIdentity(db: Db, binding: NativeAddressedInteractionBinding, options: {
  failed?: boolean;
  lockCard?: boolean;
} = {}): Promise<AddressedFailure | null> {
  const [row] = await db.select({ run: heartbeatRuns, issue: issues }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.id, heartbeatRuns.nativeIssueId), eq(issues.companyId, heartbeatRuns.companyId)))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId))).limit(1);
  if (!row || row.run.runtimeMode !== "native" || row.run.status !== (options.failed ? "failed" : "running")
    || row.issue.assigneeAgentId === binding.agentId || row.issue.executionRunId === binding.runId
    || row.issue.checkoutRunId === binding.runId) return null;
  const context = row.run.contextSnapshot;
  const interactionId = readNativeAddressedInteractionId(context);
  if (!interactionId || context?.nativeReviewDecisionId
    || (context?.issueId !== undefined && context.issueId !== binding.issueId)
    || (context?.taskId !== undefined && context.taskId !== binding.issueId)) return null;
  const query = db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, binding.companyId),
    eq(issueThreadInteractions.issueId, binding.issueId))).limit(1);
  const [interaction] = await (options.lockCard ? query.for("update") : query);
  if (!interaction || interaction.kind !== "request_confirmation" || interaction.addresseeAgentId !== binding.agentId
    || interaction.addresseeUserId) return null;
  const payload = interaction.payload as unknown as Record<string, unknown> | null;
  if (!payload || payload.target != null || payload.toolAction !== undefined || payload.secretProposal !== undefined) return null;
  if (row.issue.status === "in_review" && await isIssueReviewVerdictInteraction(db, { issue: row.issue, interaction })) return null;
  return { interactionId, state: interaction.status };
}

export async function readNativeAddressedInteractionFailure(db: Db, binding: NativeAddressedInteractionBinding): Promise<AddressedFailure | null> {
  return readOrdinaryAddressedFailureIdentity(db, binding);
}

export async function appendNativeAddressedInteractionFailureNotice(db: Db, binding: NativeAddressedInteractionBinding,
  interactionId: string): Promise<ActivityPublication | null> {
  return db.transaction(async tx => {
    const [issue] = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
    if (!issue) return null;
    const [coordinator] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId),
      eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.phase, "terminal_failure"),
      eq(nativeRunFinalizations.failureCode, NATIVE_ADDRESSED_INTERACTION_FAILED),
      isNull(nativeRunFinalizations.resultId), isNull(nativeRunFinalizations.nextAttemptAt))).for("update");
    if (!coordinator) return null;
    const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId),
      eq(heartbeatRuns.status, "failed"), eq(heartbeatRuns.nativePhase, "terminal_failure"),
      eq(heartbeatRuns.errorCode, NATIVE_ADDRESSED_INTERACTION_FAILED))).for("update");
    if (!run) return null;
    const current = await readOrdinaryAddressedFailureIdentity(tx as unknown as Db, binding, { failed: true, lockCard: true });
    if (!current || current.interactionId !== interactionId || current.state !== "pending") return null;
    const clientRequestId = `native-addressed-failure:${interactionId}:${binding.runId}`;
    const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, binding.companyId), eq(issueComments.issueId, binding.issueId),
      eq(issueComments.createdByRunId, binding.runId), eq(issueComments.authorType, "system"),
      eq(issueComments.clientRequestId, clientRequestId))).limit(1);
    if (existing) return null;
    const [comment] = await insertIssueComment(tx, { companyId: binding.companyId, issueId: binding.issueId,
      authorType: "system", authorAgentId: null, authorUserId: null, createdByRunId: binding.runId, clientRequestId,
      body: NATIVE_ADDRESSED_INTERACTION_PENDING_FAILURE_MESSAGE });
    if (!comment) throw new Error("native_addressed_interaction_failure_notice_missing");
    return (await persistActivity(tx as unknown as Db, { companyId: binding.companyId, actorType: "system", actorId: "system",
      agentId: binding.agentId, runId: binding.runId, action: "issue.addressed_interaction_failed", entityType: "issue",
      entityId: binding.issueId, details: { interactionId, commentId: comment.id, state: current.state,
        failureCode: NATIVE_ADDRESSED_INTERACTION_FAILED } })).publication;
  });
}
