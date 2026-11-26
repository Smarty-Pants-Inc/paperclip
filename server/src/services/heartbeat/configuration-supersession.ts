import { and, eq, sql } from "drizzle-orm";
import { agents, authUsers, agentWakeupRequests, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { insertIssueComment } from "../issue-comment-writes.js";
import { systemNoticePresentation } from "../recovery/notice-format.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { parseObject } from "../../adapters/utils.js";
import { currentControllerBootId } from "../controller-process-identity.js";
import { legacyControllerProvenGone } from "../legacy-controller-lease.js";
import { notifyQueuedRunDispatch, notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { logger } from "../../middleware/logger.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Park only a proven fresh, pre-handoff attempt. Keep the SAME run, issue
 * ownership, wake request and queued input. The durable receipt owns the budget
 * hold while normal executor teardown releases this preparation's resources. */
export async function parkConfigurationSupersession(db: Db, original: Run): Promise<boolean> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const issueId = typeof original.contextSnapshot?.issueId === "string" ? original.contextSnapshot.issueId : null;
    const [coordinator] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, original.companyId), eq(nativeRunFinalizations.runId, original.id))).for("update");
    if (coordinator && (coordinator.resultId || coordinator.leaseOwner || coordinator.phase !== "observed")) return false;
    if (issueId) await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, original.companyId), eq(issues.id, issueId))).for("update");
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, original.id), eq(heartbeatRuns.companyId, original.companyId))).for("update");
    const dispatch = parseObject(current?.usageJson?.budgetDispatch);
    if (!current || current.status !== "running" || current.costAccountedAt || dispatch.handedOffAt ||
      current.resultJson?.firstTurnDispatchCommitted || current.contextSnapshot?.firstTurnQueuedInput || current.resultJson?.personStop ||
      current.resultJson?.cancellation || current.resultJson?.startupCancellation || current.resultJson?.nativeCancellation) return false;
    const attempt = Number(parseObject(current.resultJson?.configurationSupersession).attempt ?? 0) + 1;
    if (attempt > 3) return false;
    const receipt = { attempt, state: "cleanup_pending", reservationId: dispatch.reservationId ?? null,
      // Recovery must never reinterpret an already-admitted native execution.
      // This fresh run's original (legacy) profile is the re-preparation base.
      originalProfile: original.runnerProfileJson,
      controllerBootId: original.controllerBootId, controllerProcess: original.controllerProcess,
      recordedAt: new Date().toISOString() };
    // No native result/lease exists: retire the *unlaunched* admission under
    // its coordinator lock. Do not manufacture a terminal native failure for
    // finalization workers to interpret as failed provider work.
    if (coordinator) await tx.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, original.id));
    // Nonterminal while teardown owns the preparation: terminal delivery and
    // accounting workers must not mistake this for an unanswered failed wake.
    await notifyScheduledRetryDispatch(tx, { companyId: original.companyId, runId: original.id });
    await tx.update(heartbeatRuns).set({ status: "scheduled_retry", errorCode: "configuration_superseded", error: null,
      scheduledRetryReason: "configuration_superseded", scheduledRetryAt: new Date(Date.now() + 30_000), finishedAt: null,
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ configurationSupersession: receipt })}::jsonb`,
    }).where(eq(heartbeatRuns.id, original.id));
    return true;
  });
}

/** Called after teardown, never from a provider callback. The input's queue and
 * wake rows are untouched. A concurrently winning Stop/ownership change wins. */
export async function requeueConfigurationSupersession(db: Db, original: Run): Promise<boolean> {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const issueId = typeof original.contextSnapshot?.issueId === "string" ? original.contextSnapshot.issueId : null;
    const [coordinator] = await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, original.id)).for("update");
    if (coordinator) return false;
    if (issueId) {
      const [issue] = await tx.select({ executionRunId: issues.executionRunId }).from(issues)
        .where(and(eq(issues.companyId, original.companyId), eq(issues.id, issueId))).for("update");
      if (issue?.executionRunId !== original.id) return false;
    }
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, original.id), eq(heartbeatRuns.companyId, original.companyId))).for("update");
    const receipt = parseObject(run?.resultJson?.configurationSupersession);
    if (!run || run.status !== "scheduled_retry" || run.errorCode !== "configuration_superseded" || receipt.state !== "cleanup_pending" ||
      run.resultJson?.personStop || run.resultJson?.nativeCancellation || run.resultJson?.cancellation || run.resultJson?.startupCancellation) return false;
    // Drop only preparation-derived snapshots. Keep every wake/comment identity
    // and concurrent caller-owned context field; first-turn input was not sealed.
    await notifyQueuedRunDispatch(tx, { companyId: original.companyId, runId: original.id });
    await tx.update(heartbeatRuns).set({ status: "queued", errorCode: null, error: null, finishedAt: null,
      scheduledRetryReason: null, scheduledRetryAt: null,
      runtimeMode: "legacy", runtimeModeResolvedAt: null, runtimeModeResolverVersion: null, runtimeModeReason: null,
      runnerProfileJson: receipt.originalProfile as Run["runnerProfileJson"],
      runnerInstanceId: null, nativeSessionId: null, nativeIssueId: null, driverKind: null, driverVersion: null,
      completionContractId: null, completionContractSha256: null, nativePhase: null, nativePhaseUpdatedAt: null,
      processPid: null, processGroupId: null, processStartedAt: null,
      controllerBootId: null, controllerLeaseExpiresAt: null,
      contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) - array['paperclipEnvironment','paperclipSecrets','paperclipSecretIdentity','skillVersions','skillSelectionSnapshot','shadowedSkills']`,
      resultJson: sql`(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) - 'heldNativeConfigurationEnd') || ${JSON.stringify({ configurationSupersession: { ...receipt, state: "ready" } })}::jsonb`,
      usageJson: sql`coalesce(${heartbeatRuns.usageJson}, '{}'::jsonb) - 'budgetDispatch'`,
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, original.id));
    return true;
  });
}

/** A failed requeue spends a durable, bounded recovery attempt. Do not steal
 * a successor's issue lock or delete a coordinator that refused requeue. */
async function recordConfigurationRecoveryFailure(db: Db, original: Run) {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
      .where(eq(nativeRunFinalizations.runId, original.id)).for("update");
    const issueId = typeof original.contextSnapshot?.issueId === "string" ? original.contextSnapshot.issueId : null;
    const [issue] = issueId ? await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, original.companyId))).for("update") : [];
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, original.id), eq(heartbeatRuns.companyId, original.companyId))).for("update");
    const receipt = parseObject(run?.resultJson?.configurationSupersession);
    if (!run || run.status !== "scheduled_retry" || run.errorCode !== "configuration_superseded" || receipt.state !== "cleanup_pending" ||
      run.resultJson?.personStop || run.resultJson?.nativeCancellation || run.resultJson?.cancellation || run.resultJson?.startupCancellation) return null;
    const recoveryAttempts = Number(receipt.recoveryAttempts ?? 0) + 1;
    const exhausted = recoveryAttempts >= 3;
    const now = new Date();
    const message = "Automatic configuration restart could not complete after three recovery attempts. This attempt stopped; review execution ownership and cleanup before retrying.";
    await notifyScheduledRetryDispatch(tx, { companyId: run.companyId, runId: run.id });
    if (exhausted) {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, run.companyId);
      await notifyExecutionRunWork(tx, { companyId: run.companyId, runId: run.id, agentId: run.agentId });
    }
    const [updated] = await tx.update(heartbeatRuns).set({
      ...(exhausted ? { status: "failed", errorCode: "configuration_incomplete", error: message, finishedAt: now,
        scheduledRetryAt: null, scheduledRetryReason: null, executionControlDeadlineAt: null } : { scheduledRetryAt: new Date(Date.now() + 30_000) }),
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        configurationSupersession: { ...receipt, recoveryAttempts, state: exhausted ? "recovery_exhausted" : "cleanup_pending" },
        ...(exhausted ? { configurationIncomplete: { reason: "configuration_recovery_stalled", recoveryAttempts } } : {}),
      })}::jsonb`, updatedAt: now,
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    if (!exhausted) return null;
    if (run.wakeupRequestId) await tx.update(agentWakeupRequests).set({ status: "failed", error: message, finishedAt: now, updatedAt: now })
      .where(and(eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.companyId, run.companyId)));
    if (issue) {
      const userId = issue.assigneeUserId ?? (issue.assigneeAgentId ? null : issue.responsibleUserId ?? run.responsibleUserId);
      const [user] = userId ? await tx.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, userId)) : [];
      const ownerAgentId = issue.assigneeAgentId ?? run.agentId;
      const [agent] = await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.id, ownerAgentId), eq(agents.companyId, run.companyId)));
      const owner = userId ? `${user?.name ?? userId} (${userId})` : `${agent?.name ?? ownerAgentId} (${ownerAgentId})`;
      await insertIssueComment(tx, { companyId: run.companyId, issueId: issue.id, authorType: "system", authorAgentId: null, authorUserId: null,
        body: `${message} Owner: ${owner}. Your message is saved.`,
        presentation: systemNoticePresentation({ tone: "danger", title: "Configuration restart stopped" }),
        metadata: { version: 1, sourceRunId: run.id, recoveryResponsibility: userId ? "user" : "system", sections: [] },
      });
      // A successor may now own the task. Never block/release that successor.
      if (issue.executionRunId === run.id) await tx.update(issues).set({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, updatedAt: now })
        .where(and(eq(issues.id, issue.id), eq(issues.executionRunId, run.id)));
    }
    return updated;
  });
}

/** Startup/reaper recovery of the durable pre-provider receipt. Never steal a
 * live preparation from another controller. Once its exact process is proven
 * gone (or this process knows its executor finished), cleanup is idempotent and
 * serialized among recoverers by a per-run transaction advisory lock. No row
 * lock is held across lease cleanup. Stop/ownership changes still win at CAS. */
export async function recoverConfigurationSupersessions(db: Db, input: {
  isExecuting: (runId: string) => boolean;
  cleanup: (run: Run) => Promise<void>;
  resume: (run: Run) => Promise<void>;
  terminal?: (run: Run) => Promise<void>;
  runIds?: string[];
}) {
  const pending = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.status, "scheduled_retry"), eq(heartbeatRuns.errorCode, "configuration_superseded"),
    sql`${heartbeatRuns.resultJson}#>>'{configurationSupersession,state}' = 'cleanup_pending'`));
  for (const run of pending) {
    if (input.runIds && !input.runIds.includes(run.id)) continue;
    // Bound repeated recovery checks while the old owner is still settling or
    // its process proof is unavailable; never spin on an overdue receipt.
    await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() + 30_000) }).where(and(
      eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "scheduled_retry"),
      eq(heartbeatRuns.errorCode, "configuration_superseded")));
    if (input.isExecuting(run.id)) continue;
    const receipt = parseObject(run.resultJson?.configurationSupersession);
    const localOwnerFinished = receipt.controllerBootId === currentControllerBootId();
    if (!localOwnerFinished && !await legacyControllerProvenGone({ runtimeMode: "legacy",
      controllerBootId: receipt.controllerBootId as string | null,
      controllerProcess: receipt.controllerProcess as Run["controllerProcess"] })) continue;
    const outcome = await db.transaction(async tx => {
      const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`configuration_supersession:${run.id}`}, 0)) as held`);
      if (!lock.held) return false;
      const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      if (!current || current.status !== "scheduled_retry" || current.errorCode !== "configuration_superseded" ||
        parseObject(current.resultJson?.configurationSupersession).state !== "cleanup_pending" || input.isExecuting(run.id)) return false;
      try {
        await input.cleanup(current);
        if (await requeueConfigurationSupersession(db, current)) return { requeued: true, terminal: null };
      } catch {
        // Cleanup errors spend the same bounded recovery budget. Never leak
        // provider diagnostics into the terminal notice.
        logger.warn({ runId: run.id, errorKind: "configuration_supersession_cleanup_pending" }, "Configuration re-preparation cleanup could not complete");
      }
      return { requeued: false, terminal: await recordConfigurationRecoveryFailure(db, current) };
    }).catch(() => {
      // An unavailable database cannot safely settle this receipt. Leave it
      // durable for recovery without failing unrelated startup work.
      logger.warn({ runId: run.id, errorKind: "configuration_supersession_recovery_unavailable" }, "Configuration recovery could not persist its outcome");
      return false;
    });
    if (outcome && typeof outcome === "object") {
      if (outcome.requeued) await input.resume(run);
      else if (outcome.terminal) await input.terminal?.(outcome.terminal);
    }
  }
}
