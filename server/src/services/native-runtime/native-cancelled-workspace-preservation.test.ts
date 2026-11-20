import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, environmentLeases, environments,
  executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { hasAcknowledgedNativeRunStopReceipt, hasAcknowledgedNativeStopIntent } from "../acknowledged-native-stop.js";
import { requestWorkspaceRecovery } from "../workspace-recovery.js";
import { inspectWorkspaceRecoverySource } from "../workspace-recovery-source.js";
import { preserveCancelledNativeWorkspaces, preserveNativeFailedWorkspace,
  registerCancelledWorkspacePreservationWork } from "./native-failed-workspace-recovery.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "../sandbox-stop-and-retain.js";
import { readRemoteWorkspaceWriterHold } from "../remote-workspace-writer-hold.js";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";

(recoveryPostgresSupport.supported ? describe : describe.skip)("lifecycle-cancelled workspace preservation", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const fixtures = new Set<string>();
  async function seed() {
    if (!database) {
      database = await startRecoveryPostgres("lifecycle-cancelled-workspace-");
      db = createDb(database.connectionString);
    }
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    fixtures.add(runId);
    const workspaceId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `allocation-${randomUUID()}`, snapshotId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped native files", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", adapterType: "paperclip_runner",
      status: "terminated", lifecycleState: "terminating" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep cancelled files", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Preservation ${runId}`, driver: "sandbox" });
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd: "/work", epoch: 2, state: "prepared", snapshotId };
    const nativeCancellation = { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId,
      scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged", dispatched: true,
      intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(), acknowledgedAt: new Date().toISOString(),
      effects: ["release_run_resources"] };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", runtimeModeResolvedAt: new Date(), nativePhase: "observed", status: "cancelled",
      errorCode: "cancelled", error: "Agent lifecycle stop requested", finishedAt: new Date(),
      costAccountingPending: true, usageJson: { inputTokens: 7 },
      contextSnapshot: { issueId, taskId: issueId },
      runnerProfileJson: { remoteWorkspace: reference, nativeResourceDisposition: "destroy" },
      resultJson: { nativeCancellation, startupCancellation: { beforeNativeSelection: false } },
    }).returning();
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "terminal_failure",
      failureCode: "native_continuation_requires_reconciliation", recoveryState: "blocked" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      name: "Retained remote files", mode: "isolated", strategyType: "scratch", metadata: { remoteWorkspace: {
        schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" },
        location: { environmentId, leaseId, providerLeaseId, remoteCwd: "/work" }, writerRunId: runId, dirty: true,
      } } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId,
      issueId, executionWorkspaceId: workspaceId, provider: "daytona", providerLeaseId, status: "active", leasePolicy: "ephemeral",
      metadata: { driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, remoteCwd: "/work" } });
    return { companyId, agentId, issueId, runId, workspaceId, leaseId, reference, nativeCancellation, run };
  }
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  afterEach(async () => {
    vi.useRealTimers(); vi.restoreAllMocks();
    if (fixtures.size) await db.update(heartbeatRuns).set({ status: "failed" }).where(inArray(heartbeatRuns.id, [...fixtures]));
    fixtures.clear();
  });

  async function unchanged(f: Awaited<ReturnType<typeof seed>>) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0])
      .toMatchObject({ status: "active", cleanupStatus: null, releasedAt: null });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }

  async function acceptResult(f: Awaited<ReturnType<typeof seed>>) {
    const [contract] = await db.insert(completionContracts).values({ companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "v1", policyVersion: "v1", risk: "low", completionAuthority: "agent",
      incompleteCriteriaPolicy: "block", contractJson: {}, canonicalSha256: "a".repeat(64),
      createdByActorType: "system", createdByActorId: "test" }).returning();
    await db.update(heartbeatRuns).set({ completionContractId: contract.id }).where(eq(heartbeatRuns.id, f.runId));
    const [result] = await db.insert(nativeRunResults).values({ companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contract.id, serverFingerprint: "b".repeat(64), schemaStatus: "accepted",
      resultJson: {}, canonicalSha256: "c".repeat(64) }).returning();
    await db.update(nativeRunFinalizations).set({ resultId: result.id }).where(eq(nativeRunFinalizations.runId, f.runId));
    return result;
  }

  it("reconstructs prepared remote files after an audited lifecycle Stop without a board actor", async () => {
    const f = await seed();
    const [historical] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", ownerType: "board", cause: "native_continuation_requires_reconciliation",
      fingerprint: randomUUID(), evidence: { runId: f.runId, originalFailureCode: "native_continuation_requires_reconciliation",
        nativeFailureBlock: true, automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked", runId: f.runId } },
      nextAction: "The prior execution remains stopped.", resolvedAt: new Date() }).returning();
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(retained.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] },
        nativeCancellation: f.nativeCancellation });
      expect(retained).toMatchObject({ status: "cancelled", nativePhase: "observed" });
      expect(retained).toMatchObject({ costAccountingPending: true, costAccountedAt: null,
        usageJson: f.run.usageJson, finishedAt: f.run.finishedAt });
      expect(retained.runnerProfileJson).toEqual(f.run.runnerProfileJson);
      expect(hasAcknowledgedNativeStopIntent(retained)).toBe(false);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
        metadata: { sandboxStopAndRetain: { runId: f.runId, leaseId: f.leaseId } } });
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect(actions).toHaveLength(2);
      expect(actions.find(action => action.id === historical.id)).toEqual(historical);
      const preservation = actions.find(action => action.id !== historical.id)!;
      expect(preservation.evidence).toMatchObject({ runId: f.runId, workspaceRestoreRecovery: { leaseIds: [f.leaseId] } });
      await preserveCancelledNativeWorkspaces(db);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toEqual(actions);
      const source = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: preservation.id };
      expect((await inspectWorkspaceRecoverySource(db, source)).sources).toHaveLength(1);
      expect(worker.nextWakeAt()).toBeNull();
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const reads = vi.spyOn(db, "select");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore(); vi.useRealTimers();
      expect(await requestWorkspaceRecovery({ ...source, db, idempotencyKey: randomUUID(), actorId: "operator" }))
        .toMatchObject({ actionId: source.actionId, status: "queued" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
      expect((await db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, f.companyId),
        eq(nativeRunFinalizations.runId, f.runId))))[0]).toMatchObject({ phase: "terminal_failure", resultId: null,
        leaseOwner: null, failureCode: "native_continuation_requires_reconciliation" });
    } finally { await worker.stop(); }
  }, 120_000);

  it.each(["native-sync", "remote-workspace", "startup-scan"] as const)("preserves files when Stop finds no live controller (%s)", async kind => {
    const f = await seed();
    const nativeCancellation = { ...f.nativeCancellation, dispatched: false };
    const resultJson = { ...f.run.resultJson, nativeCancellation, cancelledByActorType: "user", cancelledByUserId: "operator" };
    const runnerProfileJson = kind === "native-sync" ? { nativeWorkspaceSync: {
      schema: "paperclip.native-workspace-sync/v3", state: "prepared", workspaceId: f.workspaceId,
      leaseId: f.leaseId, providerLeaseId: f.reference.providerLeaseId, remoteCwd: f.reference.remoteCwd,
      baselineSha256: "a".repeat(64), descriptorSha256: "b".repeat(64), finalHostSha256: null,
      resourceDisposition: "destroy",
    }, nativeResourceDisposition: "destroy" } : f.run.runnerProfileJson;
    await db.update(heartbeatRuns).set({ resultJson, runnerProfileJson }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === "native-sync") await db.update(executionWorkspaces).set({ metadata: {} })
      .where(and(eq(executionWorkspaces.companyId, f.companyId), eq(executionWorkspaces.id, f.workspaceId)));
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      if (kind === "startup-scan") await preserveCancelledNativeWorkspaces(db);
      else await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(retained.resultJson).toMatchObject({ ...resultJson,
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] } });
      expect(retained).toMatchObject({ status: "cancelled", finishedAt: f.run.finishedAt,
        runnerProfileJson, costAccountingPending: true, usageJson: f.run.usageJson });
      expect(hasAcknowledgedNativeRunStopReceipt(retained)).toBe(false);
      expect(hasAcknowledgedNativeStopIntent(retained)).toBe(false);
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      expect(lease).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure",
          metadata: { sandboxStopAndRetain: { runId: f.runId, leaseId: f.leaseId } } });
      expect(lease.metadata).not.toHaveProperty("remoteExecutionTermination");
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect((await inspectWorkspaceRecoverySource(db, { companyId: f.companyId, issueId: f.issueId,
        runId: f.runId, actionId: action.id })).sources).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
      expect(worker.nextWakeAt()).toBeNull();
    } finally { await worker.stop(); }
  }, 120_000);

  // A warm (reusable) run that ends without success stops its sandbox and keeps
  // the lease `released` under its reusable policy. Reassignment Stop reaches
  // that state with the workspace still dirty and bound to the stopped writer.
  async function stopReusableSource(f: Awaited<ReturnType<typeof seed>>) {
    const [reusable] = await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" })
      .where(eq(environmentLeases.id, f.leaseId)).returning();
    const stopping = (await prepareSandboxStopAndRetain(db, reusable))!;
    const stopped = (await settleStopOnlyCleanup(db, stopping, {
      attemptId: String(stopping.metadata!.pendingCleanupAttemptId),
      receipt: { providerLeaseId: f.reference.providerLeaseId, state: "stopped" },
    }))!;
    expect(stopped).toMatchObject({ status: "released", leasePolicy: "reuse_by_environment", cleanupStatus: "success" });
    return stopped;
  }

  it.each(["worker", "startup-scan"] as const)("preserves a reassignment-stopped writer's files from its stopped reusable sandbox (%s)", async kind => {
    const f = await seed();
    const resultJson = { ...f.run.resultJson, reassignmentStopRequested: true };
    await db.update(heartbeatRuns).set({ errorCode: "issue_reassigned", resultJson }).where(eq(heartbeatRuns.id, f.runId));
    const stopped = await stopReusableSource(f);
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      if (kind === "startup-scan") await preserveCancelledNativeWorkspaces(db);
      else await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(retained.resultJson).toMatchObject({ ...resultJson, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] } });
      expect(retained).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned", finishedAt: f.run.finishedAt });
      // The stop receipt and reusable policy stay exactly as the release left them.
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toEqual(stopped);
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect(action).toMatchObject({ ownerType: "board", evidence: { runId: f.runId,
        automaticRecovery: { replay: "blocked" }, workspaceRestoreRecovery: { leaseIds: [f.leaseId] } } });
      expect((await inspectWorkspaceRecoverySource(db, { companyId: f.companyId, issueId: f.issueId,
        runId: f.runId, actionId: action.id })).sources).toHaveLength(1);
      // Preservation records the save obligation only. The stopped writer keeps
      // the workspace until the saved files are published; nothing replays it.
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      expect(await readRemoteWorkspaceWriterHold(db, { companyId: f.companyId,
        authority: readRemoteWorkspaceAuthority(workspace.metadata)! })).toMatchObject({ kind: "held", writer: { runId: f.runId, ended: true } });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect(worker.nextWakeAt()).toBeNull();
    } finally { await worker.stop(); }
  }, 120_000);

  it.each(["unconfirmed-stop", "writer-released", "workspace-saved"] as const)("does not retain a reusable source (%s)", async kind => {
    const f = await seed();
    let released: typeof environmentLeases.$inferSelect;
    if (kind === "unconfirmed-stop") {
      [released] = await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment", status: "released",
        cleanupStatus: "success", releasedAt: new Date() }).where(eq(environmentLeases.id, f.leaseId)).returning();
    } else {
      released = await stopReusableSource(f);
      // The workspace moved on: another writer owns it, or the writer's save already published.
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      const authority = readRemoteWorkspaceAuthority(workspace.metadata)!;
      await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspace: kind === "writer-released"
        ? { ...authority, writerRunId: randomUUID() } : { ...authority, writerRunId: null, dirty: false } } })
        .where(eq(executionWorkspaces.id, f.workspaceId));
    }
    const before = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0];
    await preserveCancelledNativeWorkspaces(db);
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try { await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready; }
    finally { await worker.stop(); }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(before);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toEqual(released);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  });

  it.each(["pending", "missing-dispatch", "invalid-dispatch", "foreign-company", "foreign-issue", "foreign-run", "turn-scope",
    "empty-intent-audit", "missing-ack-audit", "empty-ack-audit", "live-owner", "live-controller", "accepted-result",
    "foreign-allocation", "foreign-workspace", "foreign-cwd", "saved-reference", "unknown-reference", "running"] as const)
  ("does not admit preservation for %s", async invalid => {
    const f = await seed();
    const intent: Record<string, unknown> = { ...f.nativeCancellation, dispatched: false };
    if (invalid === "pending") intent.dispatchState = "pending";
    if (invalid === "missing-dispatch") delete intent.dispatched;
    if (invalid === "invalid-dispatch") intent.dispatched = "false";
    if (invalid === "foreign-company") intent.companyId = randomUUID();
    if (invalid === "foreign-issue") intent.issueId = randomUUID();
    if (invalid === "foreign-run") intent.runId = randomUUID();
    if (invalid === "turn-scope") intent.scope = "turn";
    if (invalid === "empty-intent-audit") intent.intentAuditId = "";
    if (invalid === "missing-ack-audit") delete intent.acknowledgementAuditId;
    if (invalid === "empty-ack-audit") intent.acknowledgementAuditId = "";
    const reference = { ...f.reference };
    if (invalid === "foreign-allocation") reference.providerLeaseId = randomUUID();
    if (invalid === "foreign-workspace") reference.workspaceId = randomUUID();
    if (invalid === "foreign-cwd") reference.remoteCwd = "/another-workspace";
    if (invalid === "saved-reference") reference.state = "saved";
    if (invalid === "unknown-reference") reference.schema = "unknown";
    await db.update(heartbeatRuns).set({ resultJson: { nativeCancellation: intent },
      runnerProfileJson: { remoteWorkspace: reference },
      ...(invalid === "running" ? { status: "running" } : {}),
      ...(invalid === "live-controller" ? { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) } : {}),
    }).where(eq(heartbeatRuns.id, f.runId));
    if (invalid === "live-owner") await db.update(nativeRunFinalizations).set({ leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (invalid === "accepted-result") await acceptResult(f);
    const errors: unknown[] = [];
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { errors.push(error); } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      expect(errors).toEqual([]);
      await unchanged(f);
    } finally { await worker.stop(); }
  });

  /** A reassignment Stop of a warm (keep_running) run: the executor settles its
   * coordinator, then terminal release stops and retains the reusable sandbox
   * before the preservation worker's next check. */
  async function stopAndRetainReusableSource(f: Awaited<ReturnType<typeof seed>>, options: { stopReceipt?: boolean } = {}) {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const confirmedAt = new Date(lease.acquiredAt.getTime() + 1_000);
    const releasedAt = new Date(confirmedAt.getTime() + 1);
    const termination = { schema: "paperclip.remote-termination.v1", companyId: f.companyId, runId: f.runId,
      leaseId: f.leaseId, provider: "daytona", providerLeaseId: f.reference.providerLeaseId, state: "stopped",
      confirmedAt: confirmedAt.toISOString() };
    const receipt = { schema: "paperclip.sandbox-stop-and-retain-receipt.v1", companyId: f.companyId, runId: f.runId,
      leaseId: f.leaseId, provider: "daytona", providerLeaseId: f.reference.providerLeaseId, requestId: randomUUID(),
      method: "environmentStopLease", pluginId: lease.metadata?.pluginId, confirmedAt: confirmedAt.toISOString() };
    await db.update(environmentLeases).set({ status: "released", leasePolicy: "reuse_by_environment",
      cleanupStatus: "success", releasedAt, metadata: { ...lease.metadata, pendingCleanupInFlight: false,
        ...(options.stopReceipt === false ? {} : { remoteExecutionTermination: termination, sandboxStopAndRetainReceipt: receipt }) },
    }).where(eq(environmentLeases.id, f.leaseId));
    await db.update(executionWorkspaces).set({ mode: "shared_workspace" }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.update(heartbeatRuns).set({ errorCode: "issue_reassigned", error: "Cancelled before issue reassignment",
      runnerProfileJson: { remoteWorkspace: f.reference, nativeResourceDisposition: "keep_running" },
    }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ failureCode: "native_retry_cancelled", recoveryState: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0];
  }

  it.each(["worker", "startup-scan"] as const)("preserves files of a cancelled run whose reusable sandbox was already stopped and retained (%s)", async kind => {
    const f = await seed();
    const stopped = await stopAndRetainReusableSource(f);
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      if (kind === "startup-scan") await preserveCancelledNativeWorkspaces(db);
      else await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(retained.resultJson).toMatchObject({ nativeCancellation: f.nativeCancellation, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] } });
      expect(retained).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned", finishedAt: f.run.finishedAt });
      // The stopped allocation keeps its receipts. Preservation dispatches no
      // second stop and grants no execute right on the reusable sandbox.
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toEqual(stopped);
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect(actions).toHaveLength(1);
      expect(actions[0].evidence).toMatchObject({ runId: f.runId, workspaceRestoreRecovery: { leaseIds: [f.leaseId] } });
      expect((await inspectWorkspaceRecoverySource(db, { companyId: f.companyId, issueId: f.issueId,
        runId: f.runId, actionId: actions[0].id })).sources).toHaveLength(1);
      if (kind === "worker") expect(worker.nextWakeAt()).toBeNull();
      // A repeated pass records nothing again and starts no work.
      await preserveCancelledNativeWorkspaces(db);
      const repeated = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        await registerCancelledWorkspacePreservationWork(db, repeated, () => true, async () => true).ready;
        expect(repeated.nextWakeAt()).toBeNull();
      } finally { await repeated.stop(); }
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toEqual(actions);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson).toEqual(retained.resultJson);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: "terminal_failure", leaseOwner: null, resultId: null });
    } finally { await worker.stop(); }
  }, 120_000);

  // Never-OK guard for the warm-Stop handoff policy: an ordinary person's Stop
  // of a warm (keep_running) turn is a handoff only while the box keeps running.
  // A warm box that later REALLY stopped (released, reusable, stop receipts)
  // still has its files preserved by both producers.
  it.each(["worker", "startup-scan"] as const)("preserves files of an ordinary warm Stop whose box later really stopped (%s)", async kind => {
    const f = await seed();
    const stopped = await stopAndRetainReusableSource(f);
    const resultJson = { ...f.run.resultJson, cancelledByActorType: "user", cancelledByUserId: "responsible-user" };
    await db.update(heartbeatRuns).set({ errorCode: "cancelled", error: "Cancelled by a board operator", resultJson })
      .where(eq(heartbeatRuns.id, f.runId));
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      if (kind === "startup-scan") await preserveCancelledNativeWorkspaces(db);
      else await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(retained.runnerProfileJson).toMatchObject({ nativeResourceDisposition: "keep_running" });
      expect(retained.resultJson).toMatchObject({ workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] } });
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toEqual(stopped);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(1);
    } finally { await worker.stop(); }
  }, 120_000);

  // Stop during an accepted result's copy-back retries ends the copy-back. No
  // finalization exports those files afterwards, so preservation keeps them.
  it.each(["worker", "startup-scan", "stopped-sandbox"] as const)("preserves files of an accepted result whose copy-back was stopped (%s)", async kind => {
    const f = await seed();
    const result = await acceptResult(f);
    const nativeCancellation = { ...f.nativeCancellation, dispatched: false };
    await db.update(heartbeatRuns).set({ nativePhase: "retryable_failure", error: "Cancelled by a board operator",
      resultJson: { nativeCancellation, cancelledByActorType: "user", cancelledByUserId: "operator" } })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ failureCode: "native_retry_cancelled",
      failureDetail: { originalFailureCode: "native_workspace_sync_out_failed", workspaceFinalizeAttempt: 1 } })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === "stopped-sandbox") {
      // The Stop's resource release already stopped and kept the sandbox.
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      const stopping = (await prepareSandboxStopAndRetain(db, lease))!;
      expect(await settleStopOnlyCleanup(db, stopping, { attemptId: String(stopping.metadata!.pendingCleanupAttemptId),
        receipt: { providerLeaseId: f.reference.providerLeaseId, state: "stopped" } }))
        .toMatchObject({ status: "released", leasePolicy: "ephemeral", cleanupStatus: "success" });
    }
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      if (kind === "startup-scan") await preserveCancelledNativeWorkspaces(db);
      else await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [retained] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(retained.resultJson).toMatchObject({ nativeCancellation, workspaceRestoreFailure: "restore_failed",
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.leaseId] } });
      expect(retained).toMatchObject({ status: "cancelled", finishedAt: f.run.finishedAt });
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
      expect(actions).toHaveLength(1);
      expect(actions[0].evidence).toMatchObject({ runId: f.runId, workspaceRestoreRecovery: { leaseIds: [f.leaseId] } });
      expect((await inspectWorkspaceRecoverySource(db, { companyId: f.companyId, issueId: f.issueId,
        runId: f.runId, actionId: actions[0].id })).sources).toHaveLength(1);
      // The accepted result stays recorded and is never committed or replayed.
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
        .toMatchObject({ phase: "terminal_failure", resultId: result.id, failureCode: "native_retry_cancelled", leaseOwner: null });
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      expect(await readRemoteWorkspaceWriterHold(db, { companyId: f.companyId,
        authority: readRemoteWorkspaceAuthority(workspace.metadata)! })).toMatchObject({ kind: "held", writer: { runId: f.runId, ended: true } });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
      if (kind !== "startup-scan") expect(worker.nextWakeAt()).toBeNull();
    } finally { await worker.stop(); }
  }, 120_000);

  it("fences recovery of a stopped reusable source behind later allocation owners and live writers", async () => {
    const f = await seed();
    await stopAndRetainReusableSource(f);
    await preserveCancelledNativeWorkspaces(db);
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    const source = { companyId: f.companyId, issueId: f.issueId, runId: f.runId, actionId: action.id };
    expect((await inspectWorkspaceRecoverySource(db, source)).sources).toHaveLength(1);
    // A live writer on the task blocks recovery from the retained files.
    const writerId = randomUUID();
    fixtures.add(writerId);
    await db.insert(heartbeatRuns).values({ id: writerId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "running", contextSnapshot: { issueId: f.issueId } });
    await expect(inspectWorkspaceRecoverySource(db, source)).rejects.toMatchObject({ code: "workspace_writer_active" });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, writerId));
    // A later lease on the same reusable allocation is not a retired
    // predecessor. Ownership is ambiguous, so recovery stops.
    const [stopped] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: stopped.environmentId,
      heartbeatRunId: writerId, issueId: f.issueId, executionWorkspaceId: f.workspaceId, provider: "daytona",
      providerLeaseId: stopped.providerLeaseId, status: "active", leasePolicy: "reuse_by_environment",
      metadata: { ...stopped.metadata, remoteExecutionTermination: undefined, sandboxStopAndRetainReceipt: undefined } });
    await expect(inspectWorkspaceRecoverySource(db, source)).rejects.toMatchObject({ code: "allocation_ownership_ambiguous" });
  }, 120_000);

  it.each(["live-owner", "pending-stop", "no-stop-receipt", "invalid-receipt", "expired-lease", "native-sync", "running"] as const)
  ("does not preserve or rewrite a stopped reusable sandbox for %s", async invalid => {
    const f = await seed();
    let stopped = await stopAndRetainReusableSource(f, { stopReceipt: invalid !== "no-stop-receipt" });
    if (invalid === "live-owner") await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (invalid === "pending-stop") await db.update(heartbeatRuns).set({ resultJson: {
      nativeCancellation: { ...f.nativeCancellation, dispatchState: "pending" } } }).where(eq(heartbeatRuns.id, f.runId));
    if (invalid === "running") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    if (invalid === "invalid-receipt" || invalid === "expired-lease") {
      [stopped] = await db.update(environmentLeases).set(invalid === "expired-lease"
        ? { expiresAt: new Date(Date.now() - 1_000) }
        : { metadata: { ...stopped.metadata, sandboxStopAndRetainReceipt: {
          ...stopped.metadata?.sandboxStopAndRetainReceipt as Record<string, unknown>, runId: randomUUID() } } })
        .where(eq(environmentLeases.id, f.leaseId)).returning();
    }
    if (invalid === "native-sync") {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeResourceDisposition: "keep_running", nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", workspaceId: f.workspaceId,
        leaseId: f.leaseId, providerLeaseId: f.reference.providerLeaseId, remoteCwd: f.reference.remoteCwd,
        baselineSha256: "a".repeat(64), descriptorSha256: "b".repeat(64), finalHostSha256: null,
        resourceDisposition: "keep_running" } } }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(executionWorkspaces).set({ metadata: {} }).where(eq(executionWorkspaces.id, f.workspaceId));
    }
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const errors: unknown[] = [];
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { errors.push(error); } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      await preserveCancelledNativeWorkspaces(db);
      await preserveCancelledNativeWorkspaces(db);
      expect(errors).toEqual([]);
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
      // No pass rewrites the run: no restore-failure marker, no new status delivery.
      expect(run).toEqual(before);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0]).toEqual(stopped);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    } finally { await worker.stop(); }
  });

  it("hands the workspace on at its saved version when the stopped writer never started provider work", async () => {
    const f = await seed();
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.update(executionWorkspaces).set({ metadata: { ...workspace.metadata, remoteWorkspaceUnchangedBaseline: {
      schema: "paperclip.remote-workspace-unchanged-baseline.v1", epoch: 2, runId: f.runId, snapshotId: f.reference.snapshotId,
    } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
      expect(run.runnerProfileJson?.remoteWorkspace).toMatchObject({ state: "saved", snapshotId: f.reference.snapshotId });
      const [released] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      const authority = readRemoteWorkspaceAuthority(released.metadata)!;
      expect(authority).toMatchObject({ epoch: 2, snapshotId: f.reference.snapshotId, writerRunId: null, dirty: false });
      expect(await readRemoteWorkspaceWriterHold(db, { companyId: f.companyId, authority })).toEqual({ kind: "free" });
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0])
        .toMatchObject({ status: "active", leasePolicy: "ephemeral" });
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
      // A later pass finds nothing left to keep.
      await preserveCancelledNativeWorkspaces(db);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
    } finally { await worker.stop(); }
  });

  it("rolls preservation back with its outer transaction", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => {
      await preserveNativeFailedWorkspace(tx as unknown as typeof db, f.run,
        { allowPreterminal: true, requireCancelledStop: true });
      throw new Error("outer transaction rollback");
    })).rejects.toThrow("outer transaction rollback");
    await unchanged(f);
  });

  it.each(["existing", "renewed-under-lock"] as const)("waits for the actual %s controller lease deadline", async kind => {
    const f = await seed();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const expiresAt = new Date(Date.now() + 600_000);
    let release = () => {};
    let blocker: Promise<void> | undefined;
    if (kind === "existing") {
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: expiresAt }).where(eq(heartbeatRuns.id, f.runId));
    } else {
      let ready!: (pid: number) => void;
      const acquired = new Promise<number>(resolve => { ready = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      blocker = db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
        const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        ready(row.pid); await released;
      });
      const pid = await acquired;
      const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      try {
        const registration = registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true);
        await vi.waitFor(async () => {
          const [row] = await db.execute<{ waiting: number }>(sql`select count(*)::int as waiting from pg_stat_activity
            where datname = current_database() and ${pid} = any(pg_blocking_pids(pid))`);
          expect(row.waiting).toBe(1);
        });
        await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: expiresAt }).where(eq(heartbeatRuns.id, f.runId));
        release(); await blocker; await registration.ready;
        expect(worker.nextWakeAt()).toBe(expiresAt.getTime());
        const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction");
        await vi.advanceTimersByTimeAsync(300_000);
        expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled();
        reads.mockRestore(); transactions.mockRestore();
        await vi.advanceTimersByTimeAsync(300_001);
        await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson)
          .toHaveProperty("workspaceRestoreRecovery"));
        expect(worker.nextWakeAt()).toBeNull();
      } finally { release(); await blocker; await worker.stop(); }
      return;
    }
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true).ready;
      expect(worker.nextWakeAt()).toBe(expiresAt.getTime());
      const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction");
      await vi.advanceTimersByTimeAsync(300_000);
      expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled();
      reads.mockRestore(); transactions.mockRestore();
      await vi.advanceTimersByTimeAsync(300_001);
      await vi.waitFor(async () => expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0].resultJson)
        .toHaveProperty("workspaceRestoreRecovery"));
      expect(worker.nextWakeAt()).toBeNull();
    } finally { await worker.stop(); }
  });
  // Never-OK guard: a terminal run's only written files cannot be released
  // before the real copyback/read-back. This uses real PostgreSQL and shell
  // transport; no provider turn, cloud sandbox or deployed recovery is claimed.
  async function terminalCopyFixture(status: string, provider = "fake") {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "terminal-copy-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    const f = await seed();
    const host = path.join(root, "host"), box = path.join(root, "box");
    await fs.mkdir(host); await fs.mkdir(box);
    await fs.writeFile(path.join(host, "baseline.txt"), "saved baseline\n");
    const { runChildProcess } = await import("@paperclipai/adapter-utils/server-utils");
    const { environmentRuntimeService, classifyEnvironmentCapabilities } = await import("../environment-runtime.js");
    const { environmentService } = await import("../environments.js");
    const { resolveEnvironmentExecutionTarget } = await import("../environment-execution-target.js");
    const { prepareNativeWorkspaceSync } = await import("./native-workspace-sync.js");
    await db.update(environments).set({ config: { provider, reuseLease: true } })
      .where(eq(environments.id, (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId)))[0].environmentId!));
    await db.update(executionWorkspaces).set({ cwd: host, providerRef: host, metadata: {} }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.update(heartbeatRuns).set({ status: "running", runnerProfileJson: {}, resultJson: null }).where(eq(heartbeatRuns.id, f.runId));
    const [source] = await db.update(environmentLeases).set({ status: "active", leasePolicy: "reuse_by_environment", provider,
      metadata: { driver: "sandbox", remoteCwd: box, agentId: f.agentId, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: f.reference.providerLeaseId } } })
      .where(eq(environmentLeases.id, f.leaseId)).returning();
    let failCopy = false;
    const stops: string[] = [];
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      resolveCapabilities: async () => classifyEnvironmentCapabilities({}),
      acquireRunLease: async () => (await environmentService(db).getLeaseById(f.leaseId))!,
      releaseRunLease: async input => environmentService(db).releaseLease(input.lease.id, input.status),
      resumeRunLease: async input => input.lease,
      retryPendingSandboxTeardown: async ({ lease }) => {
        stops.push(lease.providerLeaseId!);
        return { providerLeaseId: lease.providerLeaseId!, state: "stopped" as const };
      },
      execute: async input => {
        if (failCopy) throw new Error("deliberately unavailable local copy transport");
        return runChildProcess(`terminal-copy-${randomUUID()}`, input.command, input.args ?? [], {
          cwd: input.cwd ?? box, env: input.env ?? {}, stdin: input.stdin, timeoutSec: 20, graceSec: 1, onLog: async () => {},
        });
      },
    }] });
    const service = environmentService(db), lease = (await service.getLeaseById(f.leaseId))!;
    const environment = (await service.getById(lease.environmentId!))!;
    const target = (await resolveEnvironmentExecutionTarget({ db, companyId: f.companyId, adapterType: "paperclip_runner",
      environment, lease, leaseId: lease.id, leaseMetadata: lease.metadata, environmentRuntime: runtime }))!;
    const prepared = (await prepareNativeWorkspaceSync({ db, runId: f.runId, companyId: f.companyId, workspaceId: f.workspaceId,
      workspaceLocalDir: host, target, lease, resourceDisposition: "keep_running" }))!;
    const bytes = `actual-shell-written-${randomUUID()}\n`;
    const wrote = await runChildProcess(`terminal-write-${randomUUID()}`, "bash", ["-c", "printf '%s' \"$1\" > \"$2\"", "bash", bytes, path.join(box, "written.txt")], {
      cwd: box, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
    });
    expect(wrote.exitCode).toBe(0);
    await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "retained", cleanupStatus: null }).where(eq(environmentLeases.id, f.leaseId));
    return { ...f, root, host, box, bytes, runtime, prepared, target, service, fs, path, stops, fail: (value: boolean) => { failCopy = value; },
      close: async () => { await prepared.cleanup(); await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); } };
  }

  it("leaves committed accepted exports with their existing finalization owner", async () => {
    const f = await terminalCopyFixture("succeeded");
    try {
      await acceptResult(f);
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, f.runId));
      const { exportTerminalNativeWorkspace } = await import("./native-terminal-workspace-export.js");
      expect(await exportTerminalNativeWorkspace({ db, companyId: f.companyId, runId: f.runId, environmentRuntime: f.runtime })).toBe("pending");
      await expect(f.fs.readFile(f.path.join(f.host, "written.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await f.close(); }
  }, 120_000);

  it.each(["released", "expired", "failed"] as const)("reclaims an ended %s source before registered export", async status => {
    const f = await terminalCopyFixture("failed");
    await db.update(environmentLeases).set({ status, releasedAt: new Date(), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, f.leaseId));
    const execute = f.runtime.execute.bind(f.runtime);
    const copy = vi.spyOn(f.runtime, "execute").mockImplementation(async input => {
      expect(await f.service.getLeaseById(f.leaseId)).toMatchObject({ status: "retained", releasedAt: null });
      return execute(input);
    });
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    try {
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true,
        { environmentRuntime: f.runtime }).ready;
      expect(await f.fs.readFile(f.path.join(f.host, "written.txt"), "utf8")).toBe(f.bytes);
      expect(copy).toHaveBeenCalled();
      expect(await f.service.releaseLease(f.leaseId, "released")).toMatchObject({ status: "released" });
    } finally { await worker.stop(); copy.mockRestore(); await f.close(); }
  }, 120_000);

  it.each(["failed", "cancelled", "timed_out", "interrupted", "succeeded"])("exports terminal %s files through the registered worker and reads them on a later box", async status => {
    const f = await terminalCopyFixture(status);
    const errors: unknown[] = [];
    const worker = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    try {
      if (status === "failed") {
        const [old] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        const reference = { ...(old.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>) };
        delete reference.preparedAt; // previous release's persisted shape
        await db.update(heartbeatRuns).set({ runnerProfileJson: { ...old.runnerProfileJson, nativeWorkspaceSync: reference } })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      await registerCancelledWorkspacePreservationWork(db, worker, () => true, async () => true,
        { environmentRuntime: f.runtime }).ready;
      expect(await f.fs.readFile(f.path.join(f.host, "written.txt"), "utf8")).toBe(f.bytes);
      const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(saved.status).toBe(status);
      expect(saved.runnerProfileJson?.nativeWorkspaceSync).toMatchObject({ state: "finalized", finalHostSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(errors).toEqual([]);
      // A distinct cold box receives the saved host tree through the same real
      // preparation path (not by copying a test's expected bytes).
      const runId = randomUUID(), leaseId = randomUUID(), nextBox = f.path.join(f.root, "later-box");
      await f.fs.mkdir(nextBox);
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "running" });
      const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      await db.insert(environmentLeases).values({ ...source, id: leaseId, heartbeatRunId: runId, providerLeaseId: `new-${randomUUID()}`,
        status: "active", metadata: { ...source.metadata, remoteCwd: nextBox, sandboxLeaseAcquisition: { outcome: "created" } } });
      const lease = (await f.service.getLeaseById(leaseId))!;
      const { prepareNativeWorkspaceSync } = await import("./native-workspace-sync.js");
      const { resolveEnvironmentExecutionTarget } = await import("../environment-execution-target.js");
      const target = (await resolveEnvironmentExecutionTarget({ db, companyId: f.companyId, adapterType: "paperclip_runner",
        environment: (await f.service.getById(lease.environmentId!))!, lease, leaseId, leaseMetadata: lease.metadata,
        environmentRuntime: f.runtime }))!;
      if (status === "failed") {
        // A finalized old-release descriptor was normally deleted at cleanup.
        await f.prepared.cleanup();
        const [old] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        const reference = { ...(old.runnerProfileJson!.nativeWorkspaceSync as Record<string, unknown>) };
        delete reference.preparedAt;
        await db.update(heartbeatRuns).set({ updatedAt: new Date(), runnerProfileJson: { ...old.runnerProfileJson, nativeWorkspaceSync: reference } })
          .where(eq(heartbeatRuns.id, f.runId));
      }
      const next = await prepareNativeWorkspaceSync({ db, runId, companyId: f.companyId, workspaceId: f.workspaceId,
        workspaceLocalDir: f.host, target, lease });
      expect(await f.fs.readFile(f.path.join(nextBox, "written.txt"), "utf8")).toBe(f.bytes);
      if (status === "failed") await next?.restoreWorkspace();
      await next?.cleanup();
      expect(await f.service.releaseLease(f.leaseId, "released")).toMatchObject({ status: "released" });
    } finally { await worker.stop(); await f.close(); }
  }, 120_000);

  it.each(["released", "expired", "failed", "bulk", "runtime", "stop-only", "export-resume", "restart-restore", "historical-inspection", "absence"]) ("refuses %s release while a terminal native descriptor is prepared", async path => {
    const f = await terminalCopyFixture("failed", path === "absence" ? "daytona" : "fake");
    try {
      if (path === "released") {
        const { workspaceOperations } = await import("@paperclipai/db");
        await db.insert(workspaceOperations).values({ companyId: f.companyId, heartbeatRunId: f.runId,
          phase: "workspace_recovery_snapshot", status: "succeeded", metadata: {
            schema: "paperclip.workspace-recovery-snapshot.v1", leaseId: f.leaseId, providerLeaseId: f.prepared.reference.providerLeaseId,
            archive: { sha256: "a".repeat(64), byteSize: 1, objectKey: "not-a-bound-readback" },
            manifest: { sha256: "b".repeat(64), byteSize: 1, objectKey: "not-a-bound-manifest" },
          } });
      }
      let readBack = false;
      const attemptRelease = async () => {
      if (path === "bulk") {
        await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.leaseId));
        await f.service.releaseLeasesForRun(f.runId);
      } else if (path === "runtime") {
        await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.leaseId));
        await f.runtime.releaseRunLeases(f.runId, "released", undefined, "stop_and_retain");
      } else if (path === "stop-only") {
        await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.leaseId));
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
        // Built-in stop dispatch is not mocked as custody: its positive receipt
        // alone must still fail the file-release predicate.
        const pending = (await prepareSandboxStopAndRetain(db, lease))!;
        await settleStopOnlyCleanup(db, pending, { attemptId: String(pending.metadata!.pendingCleanupAttemptId),
          receipt: { state: "stopped", providerLeaseId: lease.providerLeaseId } });
      } else if (path === "export-resume") {
        const pluginId = randomUUID(), attemptId = randomUUID();
        const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
        const [pending] = await db.update(environmentLeases).set({ status: "pending_cleanup", metadata: { ...lease.metadata, pluginId,
          pendingCleanupAttemptId: attemptId, nativeWorkspaceExportResume: { schema: "paperclip.workspace-export-resume.v2",
            requestId: attemptId, resultId: randomUUID(), companyId: f.companyId, runId: f.runId, leaseId: lease.id,
            provider: lease.provider, providerLeaseId: lease.providerLeaseId, pluginId } } })
          .where(eq(environmentLeases.id, lease.id)).returning();
        const { settleNativeWorkspaceExportResume } = await import("./native-workspace-export-resume.js");
        await settleNativeWorkspaceExportResume(db, pending, { attemptId,
          receipt: { state: "stopped", providerLeaseId: pending.providerLeaseId } });
      } else if (path === "restart-restore") {
        const { remoteTerminationReceipt } = await import("../remote-execution-termination.js");
        const { restoreSandboxStopAfterFailedRestart } = await import("../sandbox-stop-and-retain.js");
        const [lease] = await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.leaseId)).returning();
        const pending = (await prepareSandboxStopAndRetain(db, lease))!;
        const [suspended] = await db.update(environmentLeases).set({ metadata: { ...pending.metadata,
          sandboxStopAndRetain: { ...(pending.metadata!.sandboxStopAndRetain as Record<string, unknown>), priorStop: {
            remoteExecutionTermination: remoteTerminationReceipt(pending, { state: "stopped", providerLeaseId: pending.providerLeaseId }) } } } })
          .where(eq(environmentLeases.id, f.leaseId)).returning();
        await restoreSandboxStopAfterFailedRestart(db, suspended, { attemptId: String(pending.metadata!.pendingCleanupAttemptId) });
      } else if (path === "historical-inspection") {
        const [lease] = await db.update(environmentLeases).set({ status: "released", cleanupStatus: "failed" })
          .where(eq(environmentLeases.id, f.leaseId)).returning();
        await settleStopOnlyCleanup(db, lease, { attemptId: randomUUID(), receiptSource: "provider_inspection",
          receipt: { state: "stopped", providerLeaseId: lease.providerLeaseId } });
      } else if (path === "absence") {
        const { withNativeWorkspaceFinalizationOwnership } = await import("./native-workspace-finalization-ownership.js");
        const { settleAbsentSandbox } = await import("../sandbox-stop-and-retain.js");
        await withNativeWorkspaceFinalizationOwnership({ db, companyId: f.companyId, runId: f.runId }, async owner => {
          const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
          expect(await settleAbsentSandbox(db, lease, { receipt: "verified-at-caller-boundary", proof: {
            v: 1, iss: "paperclip-cloud", aud: "paperclip-sandbox-absence/v1", sub: "local-proof-row", absent: true,
            iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 30, ownerToken: owner.token,
            companyId: f.companyId, issueId: f.issueId, runId: f.runId, leaseId: lease.id,
            provider: "daytona", providerLeaseId: lease.providerLeaseId!,
          } })).toBe(readBack);
        });
      } else await f.service.releaseLease(f.leaseId, path as "released" | "expired" | "failed", { cleanupStatus: "success" });
      };
      await attemptRelease();
      expect(await f.service.getLeaseById(f.leaseId)).toMatchObject({ status: "retained", releasedAt: null });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(run.runnerProfileJson?.nativeWorkspaceSync).toMatchObject({ state: "prepared", finalHostSha256: null });
      expect(f.stops).toEqual([]);
      const { exportTerminalNativeWorkspace } = await import("./native-terminal-workspace-export.js");
      expect(await exportTerminalNativeWorkspace({ db, companyId: f.companyId, runId: f.runId, environmentRuntime: f.runtime })).toBe("settled");
      expect(await f.fs.readFile(f.path.join(f.host, "written.txt"), "utf8")).toBe(f.bytes);
      readBack = true;
      await attemptRelease();
      if (path === "runtime") expect(f.stops).toEqual([f.prepared.reference.providerLeaseId]);
      expect(await f.service.getLeaseById(f.leaseId)).toMatchObject({ status: ["expired", "failed"].includes(path) ? path : "released" });
      expect(await f.service.releaseLease(f.leaseId, "released")).toMatchObject({ status: "released" });
    } finally { await f.close(); }
  }, 120_000);

  it("keeps the source through a failed export and retries with one warning", async () => {
    const f = await terminalCopyFixture("failed");
    const { exportTerminalNativeWorkspace } = await import("./native-terminal-workspace-export.js");
    const { logger } = await import("../../middleware/logger.js");
    const warning = vi.spyOn(logger, "warn");
    const input = { db, companyId: f.companyId, runId: f.runId, environmentRuntime: f.runtime };
    try {
      f.fail(true);
      expect(await exportTerminalNativeWorkspace(input)).toBe("pending");
      expect(await exportTerminalNativeWorkspace(input)).toBe("pending");
      expect(await f.service.getLeaseById(f.leaseId)).toMatchObject({ status: "retained", releasedAt: null });
      expect(await f.fs.readFile(f.path.join(f.box, "written.txt"), "utf8")).toBe(f.bytes);
      expect(warning.mock.calls.filter(call => String(call[1]).includes("Terminal native workspace export failed"))).toHaveLength(1);
      f.fail(false);
      expect(await exportTerminalNativeWorkspace(input)).toBe("settled");
      expect(await f.fs.readFile(f.path.join(f.host, "written.txt"), "utf8")).toBe(f.bytes);
    } finally { await f.close(); }
  }, 120_000);

  it("does not export a live adopted allocation or overwrite a newer server snapshot", async () => {
    const f = await terminalCopyFixture("cancelled");
    const { exportTerminalNativeWorkspace } = await import("./native-terminal-workspace-export.js");
    const input = { db, companyId: f.companyId, runId: f.runId, environmentRuntime: f.runtime };
    const successor = randomUUID();
    try {
      await db.insert(heartbeatRuns).values({ id: successor, companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running" });
      const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
      await db.insert(environmentLeases).values({ ...source, id: randomUUID(), heartbeatRunId: successor, status: "active" });
      expect(await exportTerminalNativeWorkspace(input)).toBe("pending");
      await expect(f.fs.readFile(f.path.join(f.host, "written.txt"), "utf8")).rejects.toHaveProperty("code", "ENOENT");
      await db.update(heartbeatRuns).set({ status: "succeeded", runnerProfileJson: { nativeWorkspaceSync: {
        ...f.prepared.reference, state: "finalized", finalHostSha256: "a".repeat(64), preparedAt: new Date(Date.now() + 60000).toISOString(),
      } } }).where(eq(heartbeatRuns.id, successor));
      await f.fs.writeFile(f.path.join(f.host, "written.txt"), "newer successor snapshot\n");
      const outcome = await exportTerminalNativeWorkspace(input);
      expect(await f.fs.readFile(f.path.join(f.host, "written.txt"), "utf8")).toBe("newer successor snapshot\n");
      expect(outcome).toBe("pending");
      const { workspaceOperations } = await import("@paperclipai/db");
      const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, f.runId));
      expect(operations.at(-1)?.stderrExcerpt).toContain("native_workspace_sync_snapshot_superseded");
      expect(await f.service.getLeaseById(f.leaseId)).toMatchObject({ status: "retained" });
    } finally { await f.close(); }
  }, 120_000);

});
