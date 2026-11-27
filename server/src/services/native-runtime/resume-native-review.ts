import { agentWakeupRequests, heartbeatRuns, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { conflict, forbidden, notFound } from "../../errors.js";
import { getNativeReviewAssignment } from "./native-review-participant.js";

/** Read-only eligibility; the action repeats it under the issue -> interaction locks. */
export async function nativeReviewResumeFacts(db: Db, input: {
  companyId: string; issueId: string; interactionId: string;
}) {
  const [interaction] = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.id, input.interactionId),
  ));
  const target = (interaction?.payload as { target?: { type?: string; key?: string; revisionId?: string } } | undefined)?.target;
  if (interaction?.status !== "pending" || interaction.kind !== "request_confirmation"
    || !interaction.addresseeAgentId || target?.type !== "custom"
    || target.key !== "native_completion_review" || !target.revisionId) return null;
  const context = { nativeReviewInteractionId: interaction.id, nativeReviewDecisionId: target.revisionId };
  if (!await getNativeReviewAssignment(db, { ...input, agentId: interaction.addresseeAgentId, contextSnapshot: context })) return null;
  const runs = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, interaction.addresseeAgentId),
    sql`${heartbeatRuns.contextSnapshot}->>'nativeReviewInteractionId' = ${interaction.id}`,
  )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id));
  const latest = runs[0];
  if (!latest || latest.runtimeMode !== "native" || latest.status !== "succeeded"
    || !latest.finishedAt || !latest.resultJson?.personStop || typeof latest.resultJson.personStop !== "object"
    || latest.nativeIssueId !== input.issueId
    || latest.contextSnapshot?.nativeReviewDecisionId !== target.revisionId
    || runs.some(run => run.status === "queued" || run.status === "running" || run.status === "scheduled_retry")) return null;
  const [live] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, interaction.addresseeAgentId),
    sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
    sql`(${heartbeatRuns.nativeIssueId} = ${input.issueId} or ${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId})`,
  )).limit(1);
  if (live) return null;
  const wakes = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, interaction.addresseeAgentId),
    eq(agentWakeupRequests.reason, "native_completion_review"),
    sql`${agentWakeupRequests.payload}->>'nativeReviewInteractionId' = ${interaction.id}`,
  ));
  return { interaction, context, latest, wakes };
}

export async function canResumeNativeReview(db: Db, input: Parameters<typeof nativeReviewResumeFacts>[1]): Promise<boolean> {
  const facts = await nativeReviewResumeFacts(db, input);
  return !!facts && !facts.wakes.some(wake => ["queued", "claimed", "deferred_issue_execution"].includes(wake.status));
}

/** An explicit person action, never an automatic retry or a new review decision. */
export async function resumeNativeReview(db: Db, input: Parameters<typeof nativeReviewResumeFacts>[1] & {
  authorize?: (facts: {
    issue: typeof issues.$inferSelect;
    interaction: typeof issueThreadInteractions.$inferSelect;
  }) => Promise<boolean>;
}) {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
    )).for("update");
    if (!issue) throw notFound("Issue not found");
    await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.id, input.interactionId),
    )).for("update");
    const facts = await nativeReviewResumeFacts(tx as unknown as Db, input);
    if (!facts) throw conflict("This review cannot be resumed. Refresh the task to see its current state.");
    if (input.authorize && !await input.authorize({ issue, interaction: facts.interaction })) {
      throw forbidden("You can no longer act on this review card.");
    }
    // Both simultaneous clicks and a lost response reuse the intent for this Stop.
    const originalWakes = facts.wakes.filter(wake => wake.requestedByActorId === "native-status-committer");
    // A dispatch skipped before creating a run did not consume this Stop. A later
    // explicit press may try again; do not report a skipped intent as a resume.
    const existing = originalWakes.find(wake => wake.payload?.resumeFromRunId === facts.latest.id
      && (wake.status !== "skipped" || wake.runId !== null));
    if (existing) return { wakeId: existing.id };
    if (facts.wakes.some(wake => ["queued", "claimed", "deferred_issue_execution"].includes(wake.status))) {
      throw conflict("A reviewer attempt is already queued. Refresh the task to see its progress.");
    }
    const n = originalWakes.filter(wake => wake.idempotencyKey?.startsWith(`native-review:${input.interactionId}:resume:`)).length + 1;
    // Lazy import keeps read-time projection independent of the committer's interaction service.
    const { enqueueWake } = await import("./status-decision-committer.js");
    const wakeId = await enqueueWake({ tx: tx as unknown as Db, companyId: input.companyId,
      issueId: input.issueId, agentId: facts.interaction.addresseeAgentId!,
      originRunId: facts.interaction.sourceRunId ?? undefined,
      reason: "native_completion_review", idempotencyKey: `native-review:${input.interactionId}:resume:${n}`,
      payload: { ...facts.context, resumeFromRunId: facts.latest.id },
      contextSnapshot: { ...facts.context, forceFreshSession: true },
    });
    return { wakeId };
  });
}
