import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { agents, authUsers, agentWakeupRequests, databaseClientErrorCode, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
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
const CONFIGURATION_AVAILABILITY_RETRY_MS = 15 * 60_000;

async function recordConfigurationRecoveryFailure(db: Db, original: Run, availability = false) {
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
    const now = new Date();
    const savedAvailabilityAt = typeof receipt.availabilityFailureAt === "string" ? Date.parse(receipt.availabilityFailureAt) : NaN;
    const availabilityFailureAt = Number.isFinite(savedAvailabilityAt) ? savedAvailabilityAt : now.getTime();
    const recoveryAttempts = Number(receipt.recoveryAttempts ?? 0) + (availability ? 0 : 1);
    const deadlineExpired = Number.isFinite(savedAvailabilityAt) && now.getTime() - availabilityFailureAt >= CONFIGURATION_AVAILABILITY_RETRY_MS;
    const exhausted = deadlineExpired || (!availability && recoveryAttempts >= 3);
    const message = availability
      ? "Automatic configuration restart could not complete within 15 minutes; a database operation still failed on the final recovery attempt. This attempt stopped; check database access and transaction recovery before retrying."
      : deadlineExpired
        ? "Automatic configuration restart could not complete within 15 minutes; execution ownership or cleanup still failed on the final attempt. This attempt stopped; review execution ownership and cleanup before retrying."
        : "Automatic configuration restart could not complete after three recovery attempts. This attempt stopped; review execution ownership and cleanup before retrying.";
    await notifyScheduledRetryDispatch(tx, { companyId: run.companyId, runId: run.id });
    if (exhausted) {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.accounting, run.companyId);
      await notifyExecutionRunWork(tx, { companyId: run.companyId, runId: run.id, agentId: run.agentId });
    }
    const [updated] = await tx.update(heartbeatRuns).set({
      ...(exhausted ? { status: "failed", errorCode: "configuration_incomplete", error: message, finishedAt: now,
        scheduledRetryAt: null, scheduledRetryReason: null, executionControlDeadlineAt: null } : { scheduledRetryAt: new Date(availability
          ? Math.min(now.getTime() + 30_000, availabilityFailureAt + CONFIGURATION_AVAILABILITY_RETRY_MS) : now.getTime() + 30_000) }),
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({
        configurationSupersession: { ...receipt,
          ...(availability ? { availabilityFailureAt: new Date(availabilityFailureAt).toISOString() } : { recoveryAttempts }),
          state: exhausted ? "recovery_exhausted" : "cleanup_pending" },
        ...(exhausted ? { configurationIncomplete: { reason: availability ? "configuration_recovery_unavailable" : "configuration_recovery_stalled", recoveryAttempts } } : {}),
      })}::jsonb`, updatedAt: now,
    }).where(eq(heartbeatRuns.id, run.id)).returning();
    if (!exhausted) return null;
    if (run.wakeupRequestId) await tx.update(agentWakeupRequests).set({ status: "failed", error: message, finishedAt: now, updatedAt: now })
      .where(and(eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.companyId, run.companyId)));
    if (issue) {
      const userId = issue.responsibleUserId ?? run.responsibleUserId;
      const [user] = userId ? await tx.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, userId)) : [];
      const ownerAgentId = issue.assigneeAgentId ?? run.agentId;
      const [agent] = await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.id, ownerAgentId), eq(agents.companyId, run.companyId)));
      const owner = user?.name?.trim() || "Responsible person not assigned";
      const agentName = agent?.name?.trim() || "Assigned agent";
      await insertIssueComment(tx, { companyId: run.companyId, issueId: issue.id, authorType: "system", authorAgentId: null, authorUserId: null,
        body: `${message} Owner: ${owner}; Agent: ${agentName}. Your message is saved.`,
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

/** Availability/transaction-retry errors do not establish a substantive cleanup
 * failure. Drivers and Drizzle may wrap the SQLSTATE in a causal error. Never
 * classify by message (which can contain private provider diagnostics). */
function isDatabaseAvailabilityError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = databaseClientErrorCode(current);
    const { cause } = current as { cause?: unknown };
    // SQLSTATEs are meaningful only on a genuine database-client error, not
    // a matching name/code attached to a runner/sandbox/lease-release Error.
    if (code && ((/^08[0-9A-Z]{3}$/.test(code) && code !== "08P01") ||
      ["57P01", "57P02", "57P03", "40001", "40P01",
        "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT"].includes(code))) return true;
    // 55P03/53300 remain pre-dispatch retry causes in run-failure-cause.ts,
    // but are not database-availability exemptions for this cleanup budget.
    current = cause;
  }
  return false;
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
    sql`${heartbeatRuns.resultJson}#>>'{configurationSupersession,state}' = 'cleanup_pending'`,
    or(isNull(heartbeatRuns.scheduledRetryAt), lte(heartbeatRuns.scheduledRetryAt, new Date()))));
  for (const run of pending) {
    if (input.runIds && !input.runIds.includes(run.id)) continue;
    const outcome = await db.transaction(async tx => {
      const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${`configuration_supersession:${run.id}`}, 0)) as held`);
      if (!lock.held) return false;
      const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      if (!current || current.status !== "scheduled_retry" || current.errorCode !== "configuration_superseded" ||
        parseObject(current.resultJson?.configurationSupersession).state !== "cleanup_pending" ||
        (current.scheduledRetryAt && current.scheduledRetryAt.getTime() > Date.now())) return false;
      // Claim the interval under the same advisory lock used for cleanup. A
      // second recoverer that selected the old due row must recheck it here.
      // Commit this deadline even when the live owner is still settling.
      await db.transaction(async deadlineTx => {
        await notifyScheduledRetryDispatch(deadlineTx as unknown as Db, { companyId: current.companyId, runId: current.id });
        await deadlineTx.update(heartbeatRuns).set({ scheduledRetryAt: new Date(Date.now() + 30_000) })
          .where(and(eq(heartbeatRuns.id, current.id), eq(heartbeatRuns.status, "scheduled_retry"),
            eq(heartbeatRuns.errorCode, "configuration_superseded")));
      }); // Release the row lock before cleanup/requeue opens its transaction.
      if (input.isExecuting(current.id)) return false;
      const receipt = parseObject(current.resultJson?.configurationSupersession);
      const localOwnerFinished = receipt.controllerBootId === currentControllerBootId();
      if (!localOwnerFinished && !await legacyControllerProvenGone({ runtimeMode: "legacy",
        controllerBootId: receipt.controllerBootId as string | null,
        controllerProcess: receipt.controllerProcess as Run["controllerProcess"] })) return false;
      // A stopped server may miss every interval after a single blip. Always
      // try cleanup/requeue once at the deadline: healthy recovery must win.
      // Only a failure on THIS pass can exhaust the durable elapsed bound.
      try {
        await input.cleanup(current);
        if (await requeueConfigurationSupersession(db, current)) return { requeued: true, terminal: null };
      } catch (error) {
        if (isDatabaseAvailabilityError(error)) {
          logger.warn({ runId: run.id, errorKind: "configuration_supersession_database_unavailable" }, "Configuration recovery awaits the database");
          return { requeued: false, terminal: await recordConfigurationRecoveryFailure(db, current, true) };
        }
        // Only substantive cleanup/requeue failures spend the bounded budget.
        // Never leak provider diagnostics into the terminal notice.
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
