import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { agentRunWritesRevoked, FRESH_CONTINUATION_SUPERSEDED_KEY, lockAgentForRunWrite } from "../../agent-run-cancellation.js";
import { conflict } from "../../errors.js";
import { logActivity } from "../activity-log.js";
import { FRESH_CONTINUATION_ACTOR, FRESH_CONTINUATION_CAUSE, FRESH_CONTINUATION_SCHEMA } from "../fresh-continuation-fallback.js";
import { fenceSourceWorkspace } from "../remote-workspace-epoch-abandonment.js";

/** Execution admission, not a wake/notice policy. Every new successor passes
 * here before selecting a conversation, session or workspace. A terminal run
 * is not proof its writer stopped: revoke its writes and abandon its root in
 * the SAME transaction before the successor can execute. No process stop is
 * claimed, and no provider I/O belongs under these locks. */
export async function fenceUnverifiedPredecessorsAtAdmission(db: Db, candidate: typeof heartbeatRuns.$inferSelect) {
  const issueId = candidate.nativeIssueId ?? candidate.issueId
    ?? (typeof candidate.contextSnapshot?.issueId === "string" ? candidate.contextSnapshot.issueId : null);
  if (!issueId) return candidate;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await lockAgentForRunWrite(tx, candidate.companyId, candidate.agentId);
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, candidate.companyId),
      eq(issues.id, issueId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId),
      eq(heartbeatRuns.agentId, candidate.agentId), eq(heartbeatRuns.id, candidate.id))).for("update");
    if (!issue || !run || run.status !== "running" || agentRunWritesRevoked(run)) {
      throw conflict("Successor no longer owns execution admission");
    }
    // Reattachment of an already admitted runner keeps its immutable input.
    // It is not a new successor and cannot change its prepared workspace.
    if (run.runnerProfileJson?.nativeExecutionInput) return run;
    const predecessors = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), ne(heartbeatRuns.id, run.id),
      or(eq(heartbeatRuns.nativeIssueId, issueId), eq(heartbeatRuns.issueId, issueId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`),
      inArray(heartbeatRuns.status, ["failed", "timed_out", "interrupted", "cancelled"]),
      sql`${heartbeatRuns.createdAt} <= ${run.createdAt.toISOString()}::timestamptz`,
      sql`jsonb_typeof(${heartbeatRuns.resultJson}->${FRESH_CONTINUATION_SUPERSEDED_KEY}) is distinct from 'string'`,
      sql`(coalesce(${heartbeatRuns.error}, '') || ' ' || coalesce(${heartbeatRuns.errorCode}, ''))
        ~ '(^|[[:space:]:])runner_process_(termination_unconfirmed|supervision_budget_exhausted)(:|[[:space:]]|$)'`,
    )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).for("update");
    let context = run.contextSnapshot ?? {};
    let detachWorkspace = false;
    for (const source of predecessors) {
      const now = new Date(), recordedAt = now.toISOString();
      const fenced = await fenceSourceWorkspace(tx, source);
      // Without an epoch abandonment receipt, select a new isolated workspace.
      // A stale/missing reference is never evidence that an old root is safe.
      const isolation = fenced ? "remote_epoch" : "fresh_isolated_workspace";
      detachWorkspace ||= !fenced;
      const freshContinuation = { schema: FRESH_CONTINUATION_SCHEMA, sourceRunId: source.id,
        trigger: "successor_admission", failureCode: source.errorCode, delivery: "caller_owns", recordedAt, isolation,
        stopProof: fenced ? "unproven_epoch_abandoned" : "unproven_isolated", ...(fenced ? { workspace: fenced } : {}) };
      const settlement = { schema: FRESH_CONTINUATION_SCHEMA, actorType: "system", actorId: FRESH_CONTINUATION_ACTOR,
        decision: "continue_in_fresh_run", replay: "none", sourceRunId: source.id, failureCode: source.errorCode,
        reason: "predecessor_termination_unconfirmed", isolation, recordedAt };
      const reconciliation = { runId: source.id, providerStopped: true, providerStopProof: "isolated",
        actorId: FRESH_CONTINUATION_ACTOR, recordedAt,
        workspaceRepairEvidence: "The previous writer is not proven stopped. Its writes are revoked; this successor uses a new workspace root, without applying unverified files." };
      const [action] = await tx.insert(issueRecoveryActions).values({ companyId: run.companyId, sourceIssueId: issueId,
        kind: "active_run_watchdog", status: "resolved", outcome: "restored", ownerType: "system",
        returnOwnerAgentId: run.agentId, cause: FRESH_CONTINUATION_CAUSE,
        fingerprint: `fresh-continuation:admission:${run.id}:${source.id}`, resolvedAt: now,
        nextAction: "The previous runner is unverified. Continue from saved work without reusing it.",
        resolutionNote: "successor_admission_fenced", evidence: { runId: source.id, originalFailureCode: source.errorCode,
          executionReconciliation: reconciliation, freshContinuationSettlement: settlement, freshContinuation,
          continuationDelivery: "delivered", continuationRunId: run.id } }).returning({ id: issueRecoveryActions.id });
      await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
        || ${JSON.stringify({ [FRESH_CONTINUATION_SUPERSEDED_KEY]: recordedAt })}::jsonb`, updatedAt: now })
        .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, source.id)));
      await tx.update(nativeRunFinalizations).set({ failureDetail: sql`coalesce(${nativeRunFinalizations.failureDetail}, '{}'::jsonb)
        || '{"replacementDenied":"fresh_continuation"}'::jsonb` }).where(and(
          eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, source.id)));
      context = { ...context, forceFreshSession: true, previousRunId: source.id,
        // The workspace reader consumes this existing, server-owned receipt.
        ...(!fenced ? { freshContinuationIsolation: action!.id } : {}) };
      delete context.resumeSessionParams;
      delete context.resumeSessionDisplayId;
      await logActivity(tx, { companyId: run.companyId, actorType: "system", actorId: FRESH_CONTINUATION_ACTOR,
        action: "issue.predecessor_fenced_at_admission", entityType: "issue", entityId: issueId,
        agentId: run.agentId, runId: run.id, details: { sourceRunId: source.id, recoveryActionId: action!.id,
          isolation, terminationConfirmed: false, ...(fenced ? { abandonedEpoch: fenced.abandonedEpoch, epoch: fenced.epoch } : {}) } });
    }
    if (!predecessors.length) return run;
    if (detachWorkspace && issue.executionWorkspaceId) {
      await tx.update(issues).set({ executionWorkspaceId: null,
        workspaceBindingRevision: sql`${issues.workspaceBindingRevision} + 1`, updatedAt: new Date() })
        .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)));
    }
    const [updated] = await tx.update(heartbeatRuns).set({ contextSnapshot: context, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).returning();
    return updated!;
  });
}
