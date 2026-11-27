import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issues, issueRecoveryActions, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { notifyDeferredWakesForIssue } from "../deferred-execution-notifications.js";
import { nativeRunHasNoProviderWork } from "../native-runtime/native-session-resume.js";
import { isBorrowedReusableSandboxLease } from "../sandbox-creation-operations.js";
import { personStopHasNoFirstInput } from "../person-stop-before-turn.js";
import { readNativeWorkspaceSyncReference } from "../native-runtime/native-workspace-sync.js";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { releaseUnchangedRemoteWorkspaceWriterById } from "../remote-workspaces.js";
import { issueService } from "../issues.js";
import { logActivity } from "../activity-log.js";
import { hasAcknowledgedNativeRunStopRequest } from "../acknowledged-native-stop.js";
import { logger } from "../../middleware/logger.js";
import { writeDeferredExecutionWait } from "../deferred-execution-wait.js";

export const STOP_STATUS_CHANGED_MESSAGE = "The task status changed after Stop. Held messages have not been delivered. Set the task to Todo or press Retry to deliver the held messages.";

type StopSettlementConsent = {
  kind: "retry" | "status_todo"; userId: string; runId: string; statusVersion: number;
};

function repairRefused<T extends 0 | false>(value: T, issueId: string | null, runId: string | null,
  gate: string, field: string): T {
  logger.info({ issueId, runId, gate, field }, "stop_repair_refused");
  return value;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
import { STOPPED_BEFORE_FIRST_INPUT, stoppedBeforeFirstInput } from "../person-stop-outcome.js";
export { stoppedBeforeFirstInput } from "../person-stop-outcome.js";

/** A startup cancellation receipt alone is not a person's Stop. An explicit
 * system cancellation overrides any older person-attribution fields. */
function personStopRequested(run: typeof heartbeatRuns.$inferSelect): boolean {
  if (typeof record(run.resultJson?.personStop).requestedAt !== "string") return false;
  const cancellation = record(run.resultJson?.cancellation);
  const userInitiator = cancellation.initiator === "user" || record(cancellation.initiator).type === "user";
  return cancellation.source == null
    ? userInitiator || cancellation.initiator == null && run.resultJson?.cancelledByActorType === "user"
    : cancellation.source === "operator" && cancellation.expected === true && userInitiator;
}

/** Legacy startup Stop can finish before native selection without setting an
 * error code. Accept that shape only with the recorded person/operator intent. */
function personStopErrorCode(run: typeof heartbeatRuns.$inferSelect): boolean {
  if (run.errorCode === "cancelled") return true;
  const cancellation = record(run.resultJson?.cancellation);
  return run.errorCode === null && cancellation.source === "operator" && cancellation.expected === true &&
    (cancellation.initiator === "user" || record(cancellation.initiator).type === "user") &&
    Boolean(record(run.resultJson?.personStop).requestedAt);
}

function preparationStopSettled(run: typeof heartbeatRuns.$inferSelect): boolean {
  if (run.resultJson?.preDispatchCancellationSettledAt ||
      hasAcknowledgedNativeRunStopRequest(run) && record(run.resultJson?.nativeCancellation).beforeProviderTurn === true) return true;
  if (!personStopRequested(run)) return false;
  const startup = record(run.resultJson?.startupCancellation);
  const requested = typeof startup.requestedAt === "string" ? Date.parse(startup.requestedAt) : NaN;
  const settled = typeof run.resultJson?.startupPreparationSettledAt === "string" ? Date.parse(run.resultJson.startupPreparationSettledAt) : NaN;
  return startup.beforeNativeSelection === true && Number.isFinite(requested) && Number.isFinite(settled) && settled >= requested;
}

/** Negative 'not created by this run' is insufficient for historical repair:
 * bind the borrowed box to its recorded creation and unchanged handoff. */
async function unchangedBorrowedAllocation(db: Db, lease: typeof environmentLeases.$inferSelect): Promise<boolean> {
  if (!await isBorrowedReusableSandboxLease(db, lease) || lease.metadata?.reusableLeaseSuccessor ||
      lease.metadata?.reusableSandboxLeaseSuperseded || lease.metadata?.portableTaskSuccessor) return false;
  const handoff = record(lease.metadata?.reusableLeasePredecessor);
  if (typeof handoff.previousLeaseId !== "string") return false;
  const [previous] = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.id, handoff.previousLeaseId), eq(environmentLeases.companyId, lease.companyId),
  )).for("update");
  if (!previous || previous.status !== "expired" || previous.cleanupStatus !== "success" ||
      previous.releasedAt?.getTime() !== lease.acquiredAt.getTime() ||
      previous.heartbeatRunId === lease.heartbeatRunId || previous.provider !== lease.provider ||
      previous.providerLeaseId !== lease.providerLeaseId || previous.environmentId !== lease.environmentId ||
      previous.issueId !== lease.issueId ||
      previous.metadata?.agentId !== lease.metadata?.agentId || !previous.heartbeatRunId ||
      typeof handoff.handoffId !== "string" || previous.acquiredAt > lease.acquiredAt) return false;
  const expected = { schema: "paperclip.reusable-lease-handoff.v1", previousLeaseId: previous.id,
    successorLeaseId: lease.id, previousRunId: previous.heartbeatRunId, successorRunId: lease.heartbeatRunId,
    companyId: lease.companyId, environmentId: lease.environmentId, workspaceId: previous.executionWorkspaceId,
    issueId: lease.issueId, agentId: lease.metadata?.agentId ?? null, provider: lease.provider,
    providerLeaseId: lease.providerLeaseId, recordedAt: lease.acquiredAt.toISOString(), handoffId: handoff.handoffId };
  const outgoing = record(previous.metadata?.reusableLeaseSuccessor);
  return Object.keys(handoff).length === Object.keys(expected).length && Object.keys(outgoing).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => handoff[key] === value && outgoing[key] === value);
}

/** The existing Stop/dispatch fence supplies input proof; this transaction adds
 * settled ownership and exact allocation custody. It never resumes any input.
 * Called at release boundaries, not by a new recovery poller. */
export async function recordStoppedBeforeFirstInput(db: Db, companyId: string, runId: string): Promise<boolean> {
  // Ordinary/system release must retain its existing bounded lock-conflict
  // handling. Only a person-Stop candidate enters the issue-serialized proof.
  const [candidate] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
  let issueId = candidate?.nativeIssueId ?? candidate?.issueId ?? null;
  const refuse = (field: string) => repairRefused(false, issueId, runId, "recordStoppedBeforeFirstInput", field);
  if (!candidate || candidate.status !== "cancelled" || !["native", "legacy"].includes(candidate.runtimeMode ?? "") ||
      !personStopRequested(candidate)) return refuse("candidate.person_stop");
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [selected] = await tx.select({ issueId: sql<string>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    if (!selected?.issueId) return refuse("run.issueId");
    issueId = selected.issueId;
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId),
      eq(issues.id, selected.issueId))).for("no key update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.id, runId))).for("update");
    if (!run || run.status !== "cancelled" || !run.finishedAt || !personStopRequested(run) || !personStopErrorCode(run)) return refuse("run.person_stop_terminal");
    if (stoppedBeforeFirstInput(run)) return true;
    const [owner] = await tx.select().from(nativeRunFinalizations).where(and(
      eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId),
      eq(nativeRunFinalizations.issueId, selected.issueId))).for("update");
    // Absence of an owner is not its retirement receipt: generic release can
    // clear that row. Require the preparation owner's fence or the audited
    // startup controller's acknowledgement as well as negative work evidence.
    if (!preparationStopSettled(run)) return refuse("run.preparation_settlement");
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date() ||
        owner?.leaseOwner || owner?.controllerPid || owner?.resultId || owner?.failureDetail?.successorRunId ||
        !await personStopHasNoFirstInput(tx, run)) return refuse("run.owner_or_first_input");
    const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, companyId),
      eq(environmentLeases.heartbeatRunId, runId))).for("update");
    const remote = leases.filter(lease => lease.provider !== "local");
    if ((!remote.length && run.runtimeMode !== "legacy") || leases.some(lease => !["active", "released"].includes(lease.status) ||
        lease.status === "released" && (lease.cleanupStatus !== "success" || !lease.releasedAt) ||
        lease.metadata?.pendingCleanupInFlight === true || lease.metadata?.workspaceRestoreRecovery)) return refuse("leases.cleanup");
    for (const lease of remote) if (!await unchangedBorrowedAllocation(tx, lease)) return refuse("lease.borrowed_allocation");
    const sync = readNativeWorkspaceSyncReference(run.runnerProfileJson?.nativeWorkspaceSync);
    if (run.runnerProfileJson?.nativeWorkspaceSync != null && !sync) return refuse("nativeWorkspaceSync.shape");
    if (sync && (sync.state !== "prepared" || !remote.some(lease => lease.id === sync.leaseId &&
        lease.providerLeaseId === sync.providerLeaseId && lease.issueId === selected.issueId &&
        lease.executionWorkspaceId === sync.workspaceId && lease.metadata?.remoteCwd === sync.remoteCwd))) return refuse("nativeWorkspaceSync.custody");
    const workspace = remoteWorkspaceRunReferenceSchema.safeParse(run.runnerProfileJson?.remoteWorkspace);
    if (run.runnerProfileJson?.remoteWorkspace != null && (!workspace.success || workspace.data.state !== "prepared")) return refuse("remoteWorkspace.state");
    if (workspace.success && workspace.data.state === "prepared" &&
        !await releaseUnchangedRemoteWorkspaceWriterById(transaction, { companyId, workspaceId: workspace.data.workspaceId, runId })) return refuse("remoteWorkspace.writer");
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
      ${JSON.stringify({ stoppedBeforeFirstInput: { schema: STOPPED_BEFORE_FIRST_INPUT, runId, issueId: selected.issueId,
        settledAt: new Date().toISOString(), leases: remote.map(lease => ({ id: lease.id, providerLeaseId: lease.providerLeaseId })) } })}::jsonb`,
    }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    return true;
  });
}

/** The preparation owner calls this only after its dispatch gate unwound and
 * lease cleanup finished. Close only this run's conservative unwind hold, not
 * another run's reconciliation and never a hold backed by provider work. */
export async function settlePreDispatchStopRecovery(db: Db, companyId: string, runId: string,
  consent?: StopSettlementConsent): Promise<number> {
  let issueId: string | null = null;
  const refuse = (field: string) => repairRefused(0, issueId, runId, "settlePreDispatchStopRecovery", field);
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [selected] = await tx.select({ issueId: sql<string>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
    if (!selected?.issueId) return refuse("run.issueId");
    issueId = selected.issueId;
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId),
      eq(issues.id, selected.issueId))).for("no key update");
    const [storedRun] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.status, "cancelled"),
      or(eq(heartbeatRuns.runtimeMode, "native"), sql`${heartbeatRuns.resultJson}->'stoppedBeforeFirstInput'->>'schema' = ${STOPPED_BEFORE_FIRST_INPUT}`),
    )).for("update");
    // Share the exact intent/settlement predicates with the release seal;
    // this primary-key lookup must not exclude the legacy null-error shape.
    const run = storedRun?.finishedAt && personStopErrorCode(storedRun) &&
      (stoppedBeforeFirstInput({ ...storedRun, nativeIssueId: selected.issueId }) || preparationStopSettled(storedRun))
      ? { ...storedRun, nativeIssueId: selected.issueId } : undefined;
    const cancellation = run?.resultJson?.cancellation as { initiator?: { type?: string } } | undefined;
    if (!run?.nativeIssueId || (run.resultJson?.cancelledByActorType !== "user" && cancellation?.initiator?.type !== "user") ||
      !(stoppedBeforeFirstInput(run) ? await personStopHasNoFirstInput(tx, run)
        : await nativeRunHasNoProviderWork(tx, { companyId, agentId: run.agentId, issueId: run.nativeIssueId }, runId))) return refuse("run.person_stop_or_provider_work");
    if (stoppedBeforeFirstInput(run)) {
      const [owner] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, companyId),
        eq(nativeRunFinalizations.runId, runId), eq(nativeRunFinalizations.issueId, run.nativeIssueId))).for("update");
      if (owner?.leaseOwner || owner?.controllerPid || owner?.resultId || owner?.failureDetail?.successorRunId ||
          run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return refuse("run.controller_owner");
    }
    const leases = await tx.select().from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId),
    )).for("update");
    if (leases.some(lease => !lease.releasedAt || !["released", "expired"].includes(lease.status) ||
      lease.cleanupStatus === "failed" || lease.metadata?.pendingCleanupInFlight === true)) return refuse("leases.cleanup");
    const remote = leases.filter(lease => lease.provider !== "local");
    if (!remote.length && !stoppedBeforeFirstInput(run)) return refuse("leases.missing_remote_receipt");
    for (const lease of remote) {
      if (lease.status !== "released" || lease.cleanupStatus !== "success" ||
        !await unchangedBorrowedAllocation(tx, lease)) return refuse("lease.borrowed_allocation");
    }
    const firstInputStop = stoppedBeforeFirstInput(run);
    const receipt = record(run.resultJson?.stoppedBeforeFirstInput);
    if (firstInputStop && (remote.length !== (receipt.leases as unknown[])?.length || remote.some(lease =>
      !(receipt.leases as Array<{ id: string; providerLeaseId: string }>).some(saved => saved.id === lease.id && saved.providerLeaseId === lease.providerLeaseId)))) return refuse("receipt.leases");
    const actions = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, run.nativeIssueId),
      firstInputStop ? inArray(issueRecoveryActions.cause, ["native_continuation_requires_reconciliation", "legacy_execution_requires_reconciliation"])
        : eq(issueRecoveryActions.cause, "native_continuation_requires_reconciliation"),
      firstInputStop ? or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
        and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked")))
        : inArray(issueRecoveryActions.status, ["active", "escalated"]),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${runId}`,
    )).for("update");
    // Decide status-version custody BEFORE changing any hold, file flag or
    // finalizer. Refusing is smaller and safer than overriding a newer status.
    const captured = record(record(run.resultJson?.startupCancellation).task);
    const ownBlock = actions.some(action =>
      [action.evidence.nativeFailureBlock, action.evidence.nativeBootstrapFailureBlock, action.evidence.legacyCancellationBlock]
        .some(value => { const block = record(value); return block.runId === runId && block.statusVersion === task?.statusVersion; }));
    // Only a newly authorized, exact-run Retry or person-owned Todo edit can
    // replace Stop's status-version authority. Send and recovery sweeps cannot.
    const renewedConsent = Boolean(firstInputStop && task && consent?.userId && consent.runId === runId &&
      consent.statusVersion === task.statusVersion && task.assigneeAgentId === run.agentId && !task.assigneeUserId &&
      (consent.kind === "retry" && !["done", "cancelled"].includes(task.status) ||
        consent.kind === "status_todo" && task.status === "todo"));
    const capturedCurrent = Boolean(task && (renewedConsent ||
      (task.status === "in_progress" || task.status === "todo") && captured.issueId === task.id &&
        captured.assigneeAgentId === task.assigneeAgentId && captured.statusVersion === task.statusVersion));
    if (firstInputStop && (!task || !(capturedCurrent || task.status === "blocked" && ownBlock))) {
      for (const action of actions) await tx.update(issueRecoveryActions).set({
        nextAction: STOP_STATUS_CHANGED_MESSAGE,
        evidence: { ...action.evidence, stopSettlementRefusal: { code: "person_stop_task_status_changed", runId,
          currentStatusVersion: task?.statusVersion ?? null } }, updatedAt: new Date(),
      }).where(eq(issueRecoveryActions.id, action.id));
      // Older held messages need the same explanation as the refused new Send.
      const held = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, run.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${run.nativeIssueId}`,
      )).for("update");
      for (const wake of held) await writeDeferredExecutionWait(tx, { companyId, requestId: wake.id }, {
        reason: "person_stop_task_status_changed", message: STOP_STATUS_CHANGED_MESSAGE,
        recoveryActionId: actions[0]?.id, runId,
      });
      return refuse("task.statusVersion");
    }
    let settled = 0;
    const settledActionIds = new Set<string>();
    for (const action of actions) {
      if (firstInputStop && action.status === "resolved") {
        const recovery = record(action.evidence.workspaceRestoreRecovery);
        const automatic = record(action.evidence.automaticRecovery);
        const field = automatic.runId !== runId ? "automaticRecovery.runId"
          : automatic.replay !== "blocked" ? "automaticRecovery.replay"
          : action.evidence.executionReconciliation ? "executionReconciliation"
          : action.evidence.freshContinuation ? "freshContinuation"
          : action.evidence.workspaceRestoreRecovery != null && (!Array.isArray(recovery.leaseIds) ||
              !recovery.leaseIds.every(id => remote.some(lease => lease.id === id))) ? "workspaceRestoreRecovery.leaseIds" : null;
        if (field) {
          logger.info({ issueId, runId, recoveryActionId: action.id, gate: "settlePreDispatchStopRecovery.hold", field }, "stop_repair_refused");
          continue;
        }
        await tx.update(issueRecoveryActions).set({ outcome: "cancelled", resolutionNote: "stopped before first input",
          evidence: { ...action.evidence, workspaceRestoreFailure: null, workspaceRestoreRecovery: null,
            automaticRecovery: { ...record(action.evidence.automaticRecovery), replay: "cancelled" } }, updatedAt: new Date(),
        }).where(eq(issueRecoveryActions.id, action.id));
        settled++;
        settledActionIds.add(action.id);
        continue;
      }
      const resolved = await issueRecoveryActionService(tx).resolveActiveForIssue({ companyId,
        sourceIssueId: run.nativeIssueId, actionId: action.id, cause: action.cause,
        status: "resolved", outcome: "cancelled", resolutionNote: "stopped before dispatch" }, tx);
      if (resolved) { settled++; settledActionIds.add(action.id); }
    }
    for (const action of actions.filter(action => settledActionIds.has(action.id))) {
      await tx.update(issueRecoveryActions).set({
        evidence: sql`(${issueRecoveryActions.evidence} - 'stopSettlementRefusal') ||
          ${JSON.stringify(renewedConsent ? { stopSettlementConsent: consent } : {})}::jsonb`,
      }).where(eq(issueRecoveryActions.id, action.id));
    }
    if (firstInputStop) {
      // Repair only this run's no-result finalizer and this run's false file flag.
      // Accepted results, successor decisions and other sources are untouched.
      await tx.update(nativeRunFinalizations).set({ phase: "terminal_failure", recoveryState: null,
        failureCode: null, nextAttemptAt: null, controlDeadlineAt: null, updatedAt: new Date(),
      }).where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId),
        isNull(nativeRunFinalizations.resultId), isNull(nativeRunFinalizations.leaseOwner),
        sql`${nativeRunFinalizations.failureDetail}->>'successorRunId' is null`));
      const recovery = record(run.resultJson?.workspaceRestoreRecovery);
      const clearFiles = Array.isArray(recovery.leaseIds) && recovery.leaseIds.every(id => remote.some(lease => lease.id === id));
      await tx.update(heartbeatRuns).set({
        resultJson: clearFiles ? sql`${heartbeatRuns.resultJson} - 'workspaceRestoreFailure' - 'workspaceRestoreRecovery'` : run.resultJson,
        runnerProfileJson: sql`(case when ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' = 'prepared'
          then (${heartbeatRuns.runnerProfileJson} - 'nativeWorkspaceSync') || jsonb_build_object(
            'nativeWorkspaceSyncReleasedUnchanged', ${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync')
          else ${heartbeatRuns.runnerProfileJson} end) -
          case when ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'->>'state' = 'prepared' then array['remoteWorkspace'] else array[]::text[] end ||
          case when ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace'->>'state' = 'prepared' then jsonb_build_object(
            'remoteWorkspaceReleasedUnchanged', ${heartbeatRuns.runnerProfileJson}->'remoteWorkspace') else '{}'::jsonb end`,
      }).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)));
      const settledOwnBlock = actions.some(action => {
        return settledActionIds.has(action.id) && [action.evidence.nativeFailureBlock, action.evidence.nativeBootstrapFailureBlock, action.evidence.legacyCancellationBlock].some(value => {
          const block = record(value);
          return block.runId === runId && block.statusVersion === task?.statusVersion;
        });
      });
      const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId),
        sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${run.nativeIssueId}`,
        ne(heartbeatRuns.id, runId),
        or(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
          sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (${run.createdAt.toISOString()}::timestamptz, ${run.id}::uuid)`),
      )).limit(1);
      const [otherHold] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, run.nativeIssueId),
        or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
          and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"))),
      )).limit(1);
      if (task && !successor && !otherHold && task.assigneeAgentId === run.agentId && !task.assigneeUserId &&
          (!task.executionRunId || task.executionRunId === runId) && (!task.checkoutRunId || task.checkoutRunId === runId) &&
          (capturedCurrent || task.status === "blocked" && settledOwnBlock)) {
        if (task.status !== "todo") {
          await issueService(tx).update(task.id, { status: "todo" }, tx);
          await logActivity(tx, { companyId, actorType: "system", actorId: "person-stop-settlement",
            action: "issue.updated", entityType: "issue", entityId: task.id, runId,
            details: { status: "todo", previousStatus: task.status, reason: "stopped_before_first_input" } });
        }
      }
    }
    // EVENT: the last reconciliation gate cleared; wake each parked message in
    // this same transaction, through the existing deferred-receipt event door.
    if (settled) await notifyDeferredWakesForIssue(tx, { companyId, issueId: run.nativeIssueId });
    return settled || refuse("holds.no_eligible_settlement");
  });
}

/** Request-time repair, not a historical sweep or replay authority. The caller
 * has verified a new person Send/Retry. Only the latest exact task attempt and
 * its existing hold are eligible; normal admission still owns every message. */
export async function reevaluateStoppedBeforeFirstInput(db: Db, input: {
  companyId: string; issueId: string; agentId: string;
  consent?: StopSettlementConsent;
}): Promise<number> {
  let runId: string | null = null;
  const refuse = (field: string) => repairRefused(0, input.issueId, runId, "reevaluateStoppedBeforeFirstInput", field);
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId),
      eq(issues.id, input.issueId))).for("no key update");
    if (!task || ["done", "cancelled"].includes(task.status) || task.assigneeAgentId !== input.agentId || task.assigneeUserId) return refuse("task.status_or_assignee");
    const [latest] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
    )).orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1).for("update");
    runId = latest?.id ?? null;
    if (!latest || latest.agentId !== input.agentId || latest.status !== "cancelled" || !latest.finishedAt ||
        task.executionRunId && task.executionRunId !== latest.id || task.checkoutRunId && task.checkoutRunId !== latest.id) return refuse("run.latest_terminal_owner");
    const holds = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId),
      or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
        and(eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.outcome, "blocked"))),
    )).limit(26).for("update");
    if (!holds.length || holds.length > 25 || holds.some(hold => hold.evidence.runId !== latest.id ||
        !["legacy_execution_requires_reconciliation", "native_continuation_requires_reconciliation"].includes(hold.cause) ||
        hold.evidence.executionReconciliation || hold.evidence.freshContinuation)) return refuse("holds.scope_or_authority");
    if (!await recordStoppedBeforeFirstInput(tx, input.companyId, latest.id)) return refuse("run.first_input_seal");
    if (input.consent && (input.consent.runId !== latest.id || input.consent.statusVersion !== task.statusVersion))
      return refuse("consent.run_or_statusVersion");
    return settlePreDispatchStopRecovery(tx, input.companyId, latest.id, input.consent);
  });
}
