import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { and, eq, sql } from "drizzle-orm";
import { agents, issues, heartbeatRuns, issueComments, issueRecoveryActions, type Db } from "@paperclipai/db";
import { isChatTaskSql } from "./fresh-continuation-retry-fold.js";
import { writeExecutionControl } from "./execution-control-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { createSystemRecovery, exhaustedSystemRecoveryAction, SYSTEM_RECOVERY_MAX_RETRIES, readSystemRecovery, type SystemRecoveryState } from "./system-recovery-state.js";
import { workspaceRecoverySourceEligible, type WorkspaceRecoverySourceIdentity } from "./workspace-recovery-source.js";
import { capturePolicyRearmDueAt, capturePolicyRearmPendingCondition, retainedSourceFallbackDueAt,
  retainedSourceFallbackPendingCondition, stopProofRearmDueAt, stopProofRearmPendingCondition } from "./workspace-recovery-fallback-discovery.js";

export async function adoptSystemRecovery(db: Db, source: WorkspaceRecoverySourceIdentity) {
  return db.transaction(async tx => {
    const [existing] = await tx.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, source.actionId),
        eq(issueRecoveryActions.sourceIssueId, source.issueId))).for("update");
    if (!existing || existing.evidence.systemRecovery) return;
    await notifyIssueRecovery(tx, { companyId: source.companyId });
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    const state = createSystemRecovery(source.runId);
    // Atomic, once per source. An exhausted previous execution budget is history;
    // adoption grants only the explicitly versioned maintenance capability.
    const adopted = await tx.update(issueRecoveryActions).set({
      ownerType: "system", ownerAgentId: null, ownerUserId: null,
      evidence: sql`${issueRecoveryActions.evidence} || jsonb_build_object(
        'previousWorkspaceRecovery', ${issueRecoveryActions.evidence}->'workspaceRecovery',
        'systemRecovery', ${JSON.stringify(state)}::jsonb,
        'workspaceRecovery', ${JSON.stringify({
          schema: "paperclip.workspace-recovery.v1", runId: source.runId, status: "queued",
          stage: "verifying_stop", attempt: 0, attemptLimit: 6, requestIds: [],
        })}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, source.actionId),
      eq(issueRecoveryActions.sourceIssueId, source.issueId),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${source.runId}`,
      sql`not (${issueRecoveryActions.evidence} ? 'systemRecovery')`))
      .returning({ id: issueRecoveryActions.id });
    if (!adopted.length) return;
    // Classify only notices emitted by the historical recovery producer, bound
    // to this exact source/action. Their content remains available in diagnostics;
    // neither user prose nor unrelated user-action notices are suppressed.
    await tx.update(issueComments).set({
      metadata: sql`${issueComments.metadata} || '{"recoveryResponsibility":"system"}'::jsonb`,
    }).where(and(eq(issueComments.companyId, source.companyId), eq(issueComments.issueId, source.issueId),
      eq(issueComments.authorType, "system"),
      sql`${issueComments.presentation}->>'kind' = 'system_notice'`,
      sql`${issueComments.metadata}->>'recoveryResponsibility' is null`,
      sql`${issueComments.metadata} @> ${JSON.stringify({ version: 1, sourceRunId: source.runId,
        sections: [{ rows: [{ type: "key_value", label: "Recovery action", value: source.actionId }] }] })}::jsonb`));
  });
}

export { exhaustedSystemRecoveryAction };
export const COMMENT_WORKSPACE_RECHECK_HINT = "person-comment-recheck";

/** CAS protects a newer manual generation from an old worker's late write.
 * This is bookkeeping authority only; physical writes still require ownership. */
export async function updateSystemRecovery(db: Db, source: WorkspaceRecoverySourceIdentity,
  previous: SystemRecoveryState, next: SystemRecoveryState) {
  const status = next.state === "complete" ? "recovered" : next.state === "exhausted" ? "blocked"
    : next.state === "running" ? "recovering" : "queued";
  // A spent budget is not system work any more. Hand it to the board with the
  // one action that can progress it, instead of leaving an inert system owner.
  const exhausted = next.state === "exhausted";
  const handoff = exhausted ? exhaustedSystemRecoveryAction(next, await loadActionEvidence(db, source)) : null;
  const compatibility = {
    schema: "paperclip.workspace-recovery.v1", runId: source.runId, status,
    stage: next.phase === "verify_execution" ? "verifying_stop" : next.phase === "preserve_files" ? "restoring_files" : "saving_receipts",
    attempt: next.attempts, attemptLimit: 6, retryable: true, retryAt: next.nextAttemptAt ?? undefined,
    ...(handoff ? { message: handoff } : {}),
  };
  return writeExecutionControl(db, DELIVERY_QUEUES.workspaceRecovery, async tx => {
    const [updated] = await tx.update(issueRecoveryActions).set({
      ownerType: exhausted ? "board" : "system", ownerAgentId: null, ownerUserId: null,
      ...(handoff ? { nextAction: handoff } : {}),
      evidence: sql`${issueRecoveryActions.evidence} || jsonb_build_object('systemRecovery', ${JSON.stringify(next)}::jsonb ||
        ${next.generationId === previous.generationId && next.intentId === previous.intentId
          ? sql`jsonb_build_object('intentId', ${issueRecoveryActions.evidence}#>'{systemRecovery,intentId}')`
          : sql`'{}'::jsonb`},
        'workspaceRecovery', ${JSON.stringify(compatibility)}::jsonb || jsonb_build_object('requestIds',
          coalesce(${issueRecoveryActions.evidence}#>'{workspaceRecovery,requestIds}', '[]'::jsonb)))`,
      updatedAt: new Date(),
    }).where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, source.actionId),
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,generationId}' = ${previous.generationId}`,
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,revision}' = ${String(previous.revision)}`))
      .returning({ id: issueRecoveryActions.id });
    return Boolean(updated);
  }, { companyId: source.companyId });
}

/** Bookkeeping only: an action that was exhausted before the board handoff
 * existed still reaches the board. It grants no attempt and keeps the generation. */
export async function handOffExhaustedSystemRecovery(db: Db, source: WorkspaceRecoverySourceIdentity,
  state: SystemRecoveryState) {
  if (state.state !== "exhausted") return false;
  const handoff = exhaustedSystemRecoveryAction(state, await loadActionEvidence(db, source));
  const [updated] = await db.update(issueRecoveryActions).set({
    ownerType: "board", ownerAgentId: null, ownerUserId: null, nextAction: handoff,
    evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{workspaceRecovery,message}', ${JSON.stringify(handoff)}::jsonb)`,
    updatedAt: new Date(),
  }).where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, source.actionId),
    eq(issueRecoveryActions.sourceIssueId, source.issueId), eq(issueRecoveryActions.ownerType, "system"),
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'exhausted'`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,generationId}' = ${state.generationId}`,
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,revision}' = ${String(state.revision)}`,
    sql`jsonb_typeof(${issueRecoveryActions.evidence}->'workspaceRecovery') = 'object'`))
    .returning({ id: issueRecoveryActions.id });
  return Boolean(updated);
}

async function loadActionEvidence(db: Db, source: WorkspaceRecoverySourceIdentity) {
  const [row] = await db.select({ evidence: issueRecoveryActions.evidence,
    chat: isChatTaskSql(source.companyId, source.issueId),
  }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.sourceIssueId, source.issueId),
    eq(issueRecoveryActions.id, source.actionId)));
  return row ? { ...row.evidence, chatStopRequiresProof: row.chat } : null;
}

export async function loadSystemRecovery(db: Db, source: WorkspaceRecoverySourceIdentity) {
  const [row] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.sourceIssueId, source.issueId),
    eq(issueRecoveryActions.id, source.actionId)));
  return readSystemRecovery(row?.evidence);
}

/** Called only for a newly inserted human chat comment, in its issue-locked
 * transaction. Duplicate client requests return before this hook. Concurrent
 * comments coalesce while the attempt is due/running; neither grants a budget
 * nor proves a stop. Only the existing preservation worker may release files. */
export async function expediteCommentWorkspaceRecheck(db: Db, input: {
  companyId: string; issueId: string; userId: string;
}) {
  const rows = await db.select({ actionId: issueRecoveryActions.id,
    runId: heartbeatRuns.id, evidence: issueRecoveryActions.evidence })
    .from(issueRecoveryActions).innerJoin(issues, and(
      eq(issues.id, issueRecoveryActions.sourceIssueId), eq(issues.companyId, issueRecoveryActions.companyId)))
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
      sql`${heartbeatRuns.id}::text = ${issueRecoveryActions.evidence}->>'runId'`))
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
      eq(issues.status, "blocked"), eq(issues.conversationUserId, input.userId),
      sql`${issues.conversationAgentId} is not null`,
      workspaceRecoverySourceEligible()))
    .for("update", { of: issueRecoveryActions });
  for (const row of rows) {
    const state = readSystemRecovery(row.evidence), now = Date.now();
    if (!state || state.state !== "awaiting_evidence" || state.failure?.retryClass !== "recheck_evidence"
      || state.retriesUsed >= SYSTEM_RECOVERY_MAX_RETRIES || state.deadlineAt !== null && state.deadlineAt <= now) continue;
    // A person's input is not authority to bypass a provider's cooldown either.
    const nextAttemptAt = Math.max(now, state.providerCooldownAt ?? 0);
    if (state.nextAttemptAt === null || state.nextAttemptAt <= nextAttemptAt) continue;
    const source = { ...input, actionId: row.actionId, runId: row.runId };
    if (state.commentRecheck?.retriesUsed === state.retriesUsed) {
      // Further comments in this step are coalesced. A NEW physical stop
      // receipt may still advance recovery through the normal proof observer.
      const { observeStoppedWorkspaceRecovery } = await import("./workspace-recovery.js");
      if (await observeStoppedWorkspaceRecovery(db, source))
        await notifyDeliveryWork(db, DELIVERY_QUEUES.workspaceRecovery, COMMENT_WORKSPACE_RECHECK_HINT);
      continue;
    }
    await notifyDeliveryWork(db, DELIVERY_QUEUES.workspaceRecovery, COMMENT_WORKSPACE_RECHECK_HINT);
    await updateSystemRecovery(db, { ...input, actionId: row.actionId, runId: row.runId }, state,
      { ...state, revision: state.revision + 1, nextAttemptAt,
        commentRecheck: { scheduledAt: state.nextAttemptAt, retriesUsed: state.retriesUsed, pending: true } });
  }
}

export async function nextWorkspaceRecoveryAt(db: Db): Promise<number | null> {
  const rows = await db.select({ at: sql<number>`case
    when ${retainedSourceFallbackPendingCondition()} then ${retainedSourceFallbackDueAt()}
    when ${stopProofRearmPendingCondition()} then ${stopProofRearmDueAt()}
    when ${capturePolicyRearmPendingCondition()} then ${capturePolicyRearmDueAt()}
    when jsonb_typeof(${issueRecoveryActions.evidence}#>'{systemRecovery,nextAttemptAt}') = 'number'
    then (${issueRecoveryActions.evidence}#>>'{systemRecovery,nextAttemptAt}')::bigint else 0 end` })
    .from(issueRecoveryActions).innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
      eq(heartbeatRuns.id, sql`case when ${issueRecoveryActions.evidence}->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (${issueRecoveryActions.evidence}->>'runId')::uuid end`),
      sql`${heartbeatRuns.status} in ('failed', 'interrupted', 'timed_out', 'cancelled', 'succeeded')`,
    )).where(and(
      workspaceRecoverySourceEligible(true),
      sql`(${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('scheduled', 'running', 'awaiting_evidence')
        or ${retainedSourceFallbackPendingCondition()}
        or ${stopProofRearmPendingCondition()}
        or ${capturePolicyRearmPendingCondition()}
        or (${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'complete'
          and ${issueRecoveryActions.evidence}->>'bootstrapPreparationSettledAt' is not null
          and coalesce(${issueRecoveryActions.evidence}->>'bootstrapPreparationContinuation', 'pending') = 'pending'
          and exists (select 1 from ${issues} inner join ${agents}
            on ${agents.id} = ${heartbeatRuns.agentId} and ${agents.companyId} = ${heartbeatRuns.companyId}
            where ${issues.id} = ${issueRecoveryActions.sourceIssueId} and ${issues.companyId} = ${heartbeatRuns.companyId}
              and ${issues.assigneeAgentId} = ${heartbeatRuns.agentId}
              and ${issues.status} in ('todo', 'in_progress', 'in_review')
              and ${issues.executionRunId} is null and ${issues.checkoutRunId} is null
              and ${agents.status} in ('idle', 'running', 'error'))))`,
    )).orderBy(sql`1`).limit(1);
  return rows.length ? Number(rows[0].at) : null;
}
