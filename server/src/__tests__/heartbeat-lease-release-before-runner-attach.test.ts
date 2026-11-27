import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueRecoveryActions,
  nativeRunFinalizations,
  sandboxCreationOperations,
  plugins,
} from "@paperclipai/db";
import { subscribeDatabaseWork } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { environmentService } from "../services/environments.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { createOwnedSandbox } from "../services/sandbox-creation-operations.js";
import { settlePreDispatchStopRecovery } from "../services/heartbeat/pre-dispatch-stop-settlement.js";
import { requestNativeStartupCleanup } from "../services/native-runtime/native-startup-cleanup.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../services/native-local-process-stop.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

type Window = "artifact_discovery" | "provider_pack_select" | "provider_pack_upload" | "runner_launch" | "transport_connect" | "session_open";
const PRE_LAUNCH: Window[] = ["artifact_discovery", "provider_pack_select", "provider_pack_upload"];
const ALL_WINDOWS: Window[] = [...PRE_LAUNCH, "runner_launch", "transport_connect", "session_open"];
const PROVIDER_METHODS = ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease",
  "environmentDestroyLease", "environmentStopLease", "environmentResumeLease"];

describeEmbeddedPostgres("environment lease release between sandbox acquire and runner attach", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const workers: Array<{ stop(): Promise<void> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lease-release-before-attach-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function providerWorker(pluginId: string) {
    const call = vi.fn(async (_pluginId: string, method: string, params: { providerLeaseId?: string }) => {
      if (method === "environmentDestroyLease") return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      if (method === "environmentReleaseLease") return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      throw new Error(`Unexpected provider method ${method}`);
    });
    const manager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: PROVIDER_METHODS })),
      call,
    } as unknown as PluginWorkerManager;
    const teardownCalls = () => call.mock.calls.filter(([, method]) =>
      method === "environmentDestroyLease" || method === "environmentStopLease" || method === "environmentReleaseLease");
    return { manager, teardownCalls };
  }

  async function seed(window: Window) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), pluginId = randomUUID();
    const providerLeaseId = `sandbox-${randomUUID()}`;
    const pluginKey = `paperclip.lease-release-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Fake sandbox", description: "Test provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", supportsReusableLeases: true, displayName: "Fake Plugin",
          configSchema: { type: "object" } }] } } as never);
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCoder", role: "engineer", status: "running",
      adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" }, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Short task", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId });
    const config = { provider: "fake-plugin", image: "fake:test", timeoutMs: 1234, reuseLease: false };
    await db.insert(environments).values({ id: environmentId, name: `Fake sandbox ${environmentId}`, driver: "sandbox",
      status: "active", config });
    const startedAt = new Date(Date.now() - 10_000);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", status: "running",
      runtimeMode: "native", runtimeModeResolvedAt: startedAt, issueId, nativeIssueId: issueId, startedAt,
      contextSnapshot: { issueId }, nextEventSeq: 1,
      runnerProfileJson: { nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: randomUUID(), leaseId, providerLeaseId,
        remoteCwd: "/workspace", resourceDisposition: "destroy" } } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 1,
      controllerGeneration: 1, leaseOwner: `executor-${runId}`, leaseExpiresAt: new Date(Date.now() - 1_000) });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, issueId,
      status: "active", leasePolicy: "ephemeral", provider: "fake-plugin", providerLeaseId,
      metadata: { ...config, agentId, driver: "sandbox", pluginId, pluginKey, sandboxProviderPlugin: true,
        remoteCwd: "/workspace", sandboxState: "started" } });
    const events: Array<{ eventType: string; sourceEventId?: string }> = [];
    if (!PRE_LAUNCH.includes(window)) events.push({ eventType: PROCESS_START_REQUESTED });
    if (window === "transport_connect" || window === "session_open") events.push({ eventType: PROCESS_IDENTITY_RECORDED });
    if (window === "session_open") events.push({ eventType: "session.started", sourceEventId: randomUUID() });
    for (const [index, event] of events.entries()) {
      await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: index + 1, eventType: event.eventType,
        stream: "system", level: "info", message: event.eventType, sourceEventId: event.sourceEventId ?? null });
    }
    await db.update(heartbeatRuns).set({ nextEventSeq: events.length + 1 }).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, issueId, runId, leaseId, providerLeaseId, ...providerWorker(pluginId) };
  }

  async function lease(leaseId: string) {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!;
  }

  async function run(runId: string) {
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  }

  async function expectSandboxReleased(fixture: Awaited<ReturnType<typeof seed>>) {
    let row = await lease(fixture.leaseId);
    if (row.status === "pending_cleanup") {
      await heartbeatService(db, { pluginWorkerManager: fixture.manager }).sweepPendingCleanupLeases({ backoffMs: 0 });
      row = await lease(fixture.leaseId);
    }
    expect(row.status).not.toBe("active");
    expect(row.status).not.toBe("pending_cleanup");
    expect(row.releasedAt).not.toBeNull();
    expect(fixture.teardownCalls()).toContainEqual([expect.any(String), expect.any(String),
      expect.objectContaining({ providerLeaseId: fixture.providerLeaseId }), expect.any(Number)]);
  }

  // Reproduce the persisted handoff, not acquireLease's non-persisted input keys.
  async function acquireReusable(mode: "replace" | "reuse" | "created", runnerTaskLease = false) {
    const fixture = await seed("artifact_discovery");
    const prior = await lease(fixture.leaseId);
    await db.delete(environmentLeases).where(eq(environmentLeases.id, prior.id));
    const svc = environmentService(db);
    const priorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: priorRunId, companyId: fixture.companyId,
      agentId: fixture.agentId, status: "running" });
    const ownerRunId = mode === "created" ? fixture.runId : priorRunId;
    const metadata = { ...prior.metadata, runnerTaskLease, reusableSandboxLease: { adapterType: "paperclip_runner" },
      nativeHarnessBackup: { sentinel: "exact prior save" } };
    const resource = await createOwnedSandbox(db, { companyId: fixture.companyId, environmentId: prior.environmentId!,
      heartbeatRunId: ownerRunId, issueId: fixture.issueId, provider: prior.provider!, driverKey: "sandbox",
      config: {}, metadata }, async () => ({ providerLeaseId: fixture.providerLeaseId }));
    const input = { companyId: fixture.companyId, environmentId: prior.environmentId!, issueId: fixture.issueId,
      heartbeatRunId: fixture.runId, provider: prior.provider!, providerLeaseId: fixture.providerLeaseId,
      leasePolicy: "reuse_by_environment" as const, metadata };
    let acquired = await svc.acquireLease({ ...input, heartbeatRunId: ownerRunId,
      creationOperationId: String(resource.metadata!.creationOperationId) });
    if (mode !== "created") {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, priorRunId));
      await svc.releaseLease(acquired.id, "retained", { cleanupStatus: "success" });
      acquired = await svc.acquireLease({ ...input, replacesReusableLeaseId: acquired.id });
      if (mode === "reuse") acquired = await svc.acquireLease({ ...input, reusesReusableLeaseId: acquired.id });
      expect(acquired.metadata).toHaveProperty("reusableLeasePredecessor");
    }
    expect(acquired.metadata).not.toHaveProperty("reusesReusableLeaseId");
    expect(acquired.metadata).not.toHaveProperty("replacesReusableLeaseId");
    expect(acquired.metadata).toHaveProperty("reusableSandboxLease");
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, fixture.runId));
    await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, attempt: 0,
      controllerGeneration: 0 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    return { ...fixture, leaseId: acquired.id };
  }

  it.each(["replace", "reuse"] as const)("returns a real %s reusable sandbox untouched after its preparation owner proves Stop before dispatch", async mode => {
    const fixture = await acquireReusable(mode);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(),
      resultJson: { preDispatchCancellationSettledAt: new Date().toISOString() } }).where(eq(heartbeatRuns.id, fixture.runId));
    const heartbeat = heartbeatService(db, { pluginWorkerManager: fixture.manager });
    await heartbeat.releaseEnvironmentLeasesForRun({ runId: fixture.runId, companyId: fixture.companyId,
      agentId: fixture.agentId, status: "cancelled" });
    const saved = await lease(fixture.leaseId);
    expect(saved.status).toBe("released");
    expect(saved.cleanupStatus).toBe("success");
    expect(saved.providerLeaseId).toBe(fixture.providerLeaseId);
    expect(saved.metadata?.nativeHarnessBackup).toEqual({ sentinel: "exact prior save" });
    expect(fixture.teardownCalls()).toHaveLength(0);
  });

  it("still destroys a startup-created box even with preparation-owner Stop proof", async () => {
    const fixture = await acquireReusable("created");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), runnerProfileJson: {},
      resultJson: { preDispatchCancellationSettledAt: new Date().toISOString() } }).where(eq(heartbeatRuns.id, fixture.runId));
    await heartbeatService(db, { pluginWorkerManager: fixture.manager }).releaseEnvironmentLeasesForRun({
      runId: fixture.runId, companyId: fixture.companyId, agentId: fixture.agentId, status: "cancelled" });
    expect(await lease(fixture.leaseId)).toMatchObject({ status: "expired", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { state: "destroyed" } } });
    expect(fixture.teardownCalls().map(([, method]) => method)).toEqual(["environmentDestroyLease"]);
  });

  it.each(["replace", "reuse", "created"] as const)("startup Stop retains only a real borrowed box (%s)", async mode => {
    const borrowed = mode !== "created";
    const fixture = await acquireReusable(mode, true);
    await db.update(nativeRunFinalizations).set({ leaseOwner: `executor-${fixture.runId}`, attempt: 1,
      controllerGeneration: 1 }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    expect(await requestNativeStartupCleanup(db, { companyId: fixture.companyId, agentId: fixture.agentId,
      runId: fixture.runId, contextId: randomUUID(), deadlineAtMs: Date.now() - 1,
      leaseOwner: `executor-${fixture.runId}`, requiresPreparationStop: false })).toBe(true);
    const stopping = heartbeatService(db, { pluginWorkerManager: fixture.manager }).cancelRun(fixture.runId, "Person Stop",
      { resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" } });
    await stopping;
    const saved = await lease(fixture.leaseId);
    expect(saved.cleanupStatus).toBe("success");
    expect(saved.status).toBe(borrowed ? "released" : "expired");
    expect(fixture.teardownCalls().map(([, method]) => method)).toEqual([borrowed ? "environmentStopLease" : "environmentDestroyLease"]);
    expect((await run(fixture.runId)).resultJson?.nativeStartupCleanup).toMatchObject({ state: "complete" });
  }, 60_000);

  it.each(["replace", "reuse"] as const)("expiry without a startup marker hands back a real %s borrowed box running when it did no work", async mode => {
    const fixture = await acquireReusable(mode);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: {} })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: fixture.manager });
    await runtime.releaseRunLeases(fixture.runId, "expired");
    expect(await lease(fixture.leaseId)).toMatchObject({ status: "released", cleanupStatus: "success",
      providerLeaseId: fixture.providerLeaseId });
    expect((await lease(fixture.leaseId)).metadata).not.toHaveProperty("remoteExecutionTermination");
    expect(fixture.teardownCalls()).toHaveLength(0);
  });

  it.each(["replace", "reuse", "create"] as const)("Stop landing before real runtime %s acquisition completes releases the box immediately", async mode => {
    const fixture = await seed("artifact_discovery"), prior = await lease(fixture.leaseId);
    await db.delete(environmentLeases).where(eq(environmentLeases.id, prior.id));
    const svc = environmentService(db);
    const environment = (await svc.update(prior.environmentId!, { config: {
      provider: "fake-plugin", image: "fake:test", timeoutMs: 1234, reuseLease: true,
    } }))!;
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    let block = false, providerRunning = false;
    const call = vi.fn(async (_plugin: string, method: string) => {
      if (method === "environmentAcquireLease" || method === "environmentResumeLease") {
        providerRunning = true;
        if (block) { entered.resolve(); await gate.promise; }
        return { providerLeaseId: fixture.providerLeaseId, metadata: { provider: "fake-plugin", image: "fake:test",
          timeoutMs: 1234, reuseLease: true, remoteCwd: "/workspace" } };
      }
      if (method === "environmentStopLease") { providerRunning = false; return { providerLeaseId: fixture.providerLeaseId, state: "stopped" }; }
      if (method === "environmentDestroyLease" || method === "environmentReleaseLease")
        return { providerLeaseId: fixture.providerLeaseId, state: "destroyed" };
      throw new Error(`Unexpected ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { ...fixture.manager, isRunning: () => true, call } as PluginWorkerManager });
    const input = { companyId: fixture.companyId, environment, issueId: fixture.issueId, agentId: fixture.agentId,
      persistedExecutionWorkspace: null };
    if (mode !== "create") {
      await runtime.acquireRunLease({ ...input, heartbeatRunId: fixture.runId });
      await runtime.releaseRunLeases(fixture.runId, "released", undefined, "keep_running");
    }
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, fixture.runId));
    const cancelledRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: cancelledRunId, companyId: fixture.companyId, agentId: fixture.agentId,
      issueId: fixture.issueId, nativeIssueId: fixture.issueId, status: "running" });
    if (mode === "reuse") {
      await runtime.acquireRunLease({ ...input, heartbeatRunId: cancelledRunId });
      await runtime.releaseRunLeases(cancelledRunId, "released", undefined, "keep_running");
    }
    block = true;
    const pending = runtime.acquireRunLease({ ...input, heartbeatRunId: cancelledRunId });
    const result = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await Promise.race([entered.promise, result.then(value => { throw value.error ?? new Error("Provider resume was not gated"); })]);
      if (mode === "create") expect(await db.select().from(environmentLeases)
        .where(eq(environmentLeases.heartbeatRunId, cancelledRunId))).toHaveLength(0);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: {} })
        .where(eq(heartbeatRuns.id, cancelledRunId));
    } finally { gate.resolve(); }
    expect((await result).error?.message).toBe(mode === "create"
      ? "Sandbox creation run authority changed" : "Environment acquisition completed after run cancellation");
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, cancelledRunId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "released", cleanupStatus: "success", providerLeaseId: fixture.providerLeaseId });
    if (mode === "create") {
      expect(rows[0]!.metadata).toHaveProperty("remoteExecutionTermination.state", "stopped");
      expect(call.mock.calls.map(([, method]) => method)).toContain("environmentStopLease");
    } else {
      expect(rows[0]!.metadata).toHaveProperty("reusableLeasePredecessor");
      expect(rows[0]!.metadata).not.toHaveProperty("remoteExecutionTermination");
      expect(call.mock.calls.map(([, method]) => method)).not.toContain("environmentStopLease");
    }
    expect((mode !== "reuse" ? rows[0]!.createdAt : rows[0]!.updatedAt).getTime())
      .toBeGreaterThanOrEqual((await run(cancelledRunId)).finishedAt!.getTime());
    expect(call.mock.calls.map(([, method]) => method)).not.toContain("environmentDestroyLease");
    expect(call.mock.calls.map(([, method]) => method)).not.toContain("environmentReleaseLease");
    expect(providerRunning).toBe(mode !== "create");
    const creation = await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.runId, cancelledRunId));
    if (mode === "create") expect(creation).toEqual([expect.objectContaining({ state: "resolved", leaseId: rows[0]!.id })]);
    if (process.env.CS_STOP_EVIDENCE_DIR) writeFileSync(join(process.env.CS_STOP_EVIDENCE_DIR, `acquire-stop-${mode}.json`),
      JSON.stringify({ mode, runId: cancelledRunId, providerRunning, calls: call.mock.calls.map(([, method]) => method),
        lease: rows[0], creation }, null, 2));
  }, 60_000);

  it.each(["none", "process", "dispatch", "turn", "provider", "recovery-v1", "other-run"] as const)(
    "pre-dispatch Stop settlement closes only its proven no-work reconciliation (%s)", async evidence => {
      const fixture = await acquireReusable("replace");
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date(),
        resultJson: { cancelledByActorType: "user", preDispatchCancellationSettledAt: new Date().toISOString() },
        ...(evidence === "process" ? { processStartedAt: new Date() } : {}),
        ...(evidence === "dispatch" ? { usageJson: { budgetDispatch: { handedOffAt: new Date().toISOString() } } } : {}),
        ...(evidence === "recovery-v1" ? { runnerProfileJson: {
          nativeControllerRecovery: { schema: "paperclip.native-controller-recovery.v1" } } } : {}),
      }).where(eq(heartbeatRuns.id, fixture.runId));
      if (evidence === "turn" || evidence === "provider") await db.insert(heartbeatRunEvents).values({
        companyId: fixture.companyId, runId: fixture.runId, agentId: fixture.agentId, seq: 1,
        eventType: evidence === "turn" ? "turn.started" : "provider.event", stream: "system", level: "info", message: "real work",
      });
      await environmentService(db).releaseLease(fixture.leaseId, "released", { cleanupStatus: "success" });
      const [hold] = await db.insert(issueRecoveryActions).values({ companyId: fixture.companyId,
        sourceIssueId: fixture.issueId, kind: "active_run_watchdog", status: "active", ownerType: "board",
        cause: "native_continuation_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Reconcile work",
        evidence: { runId: evidence === "other-run" ? randomUUID() : fixture.runId },
      }).returning();
      const [parked] = await db.insert(agentWakeupRequests).values({ companyId: fixture.companyId, agentId: fixture.agentId,
        source: "on_demand", status: "deferred_issue_execution", payload: { issueId: fixture.issueId } }).returning();
      const hints: string[] = [];
      const stopWatching = subscribeDatabaseWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, (event, values) => {
        if (event === "settled" && values) hints.push(...values);
      });
      try {
        expect(await settlePreDispatchStopRecovery(db, fixture.companyId, fixture.runId)).toBe(evidence === "none" ? 1 : 0);
      } finally { stopWatching(); }
      expect(hints.includes(JSON.stringify({ companyId: fixture.companyId, requestId: parked!.id }))).toBe(evidence === "none");
      const [saved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, hold!.id));
      expect(saved).toMatchObject(evidence === "none"
        ? { status: "resolved", outcome: "cancelled", resolutionNote: "stopped before dispatch" }
        : { status: "active", outcome: null });
    });

  it.each(ALL_WINDOWS)("terminating the agent releases a sandbox leased during %s", async window => {
    const fixture = await seed(window);
    const lifecycle = createAgentLifecycle(db);
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, fixture.manager));
    workers.push(worker);
    await lifecycle.pauseAgent(fixture.agentId);
    await worker.process(fixture.agentId);
    await lifecycle.terminateAgent(fixture.agentId);
    let agent = (await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]!;
    let passes = 0;
    for (; agent.lifecycleState !== "terminated" && passes < 4; passes++) {
      await db.update(agents).set({ lifecycleOperation: { ...agent.lifecycleOperation!, retryAt: undefined } })
        .where(eq(agents.id, fixture.agentId));
      await worker.process(fixture.agentId);
      agent = (await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]!;
    }
    expect(agent.lifecycleState).toBe("terminated");
    expect(passes).toBeLessThanOrEqual(1);
    const stopped = await run(fixture.runId);
    expect(stopped.status).toBe("cancelled");
    await expectSandboxReleased(fixture);
    if (PRE_LAUNCH.includes(window)) {
      expect(stopped.runnerProfileJson).not.toHaveProperty("nativeWorkspaceSync");
      expect(stopped.runnerProfileJson).toHaveProperty("nativeWorkspaceSyncReleasedUnchanged.state", "prepared");
    } else {
      expect(stopped.resultJson).toHaveProperty("workspaceRestoreRecovery.schema", "paperclip.workspace-restore-recovery.v1");
    }
  }, 60_000);

  it.each(ALL_WINDOWS)("stopping the run releases a sandbox leased during %s", async window => {
    const fixture = await seed(window);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: fixture.manager });
    await heartbeat.cancelRun(fixture.runId, "Cancelled by a board operator", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "operator" } });
    expect((await run(fixture.runId)).status).toBe("cancelled");
    await heartbeat.sweepOrphanedActiveLeases({ companyId: fixture.companyId, leaseId: fixture.leaseId, backoffMs: 5 * 60_000 });
    await expectSandboxReleased(fixture);
  }, 60_000);

  it("records a release a live workspace owner holds back and finishes it in the background once due", async () => {
    const fixture = await seed("runner_launch");
    const ownerUntil = new Date(Date.now() + 60_000);
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: ownerUntil }).where(eq(nativeRunFinalizations.runId, fixture.runId));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled" })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const heartbeat = heartbeatService(db, { pluginWorkerManager: fixture.manager });
    await heartbeat.releaseEnvironmentLeasesForRun({ runId: fixture.runId, companyId: fixture.companyId,
      agentId: fixture.agentId, status: "cancelled", providerResourceDisposition: "destroy" });
    const deferred = await lease(fixture.leaseId);
    expect(deferred.status).toBe("active");
    expect(deferred.metadata?.releaseDeferral).toMatchObject({ reason: "workspace_owner_active", attempts: 1,
      providerResourceDisposition: "destroy" });
    expect(fixture.teardownCalls()).toHaveLength(0);

    const deadlines: number[] = [];
    await heartbeat.sweepOrphanedActiveLeases({ companyId: fixture.companyId, leaseId: fixture.leaseId, backoffMs: 5 * 60_000,
      onDeferredDeadline: at => deadlines.push(at) });
    expect((await lease(fixture.leaseId)).status).toBe("active");
    expect(deadlines).toContain(Date.parse(String((deferred.metadata?.releaseDeferral as { retryAt: string }).retryAt)));

    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await db.update(environmentLeases).set({ metadata: { ...deferred.metadata,
      releaseDeferral: { ...(deferred.metadata?.releaseDeferral as object), retryAt: new Date(Date.now() - 1_000).toISOString() } } })
      .where(eq(environmentLeases.id, fixture.leaseId));
    await heartbeat.sweepOrphanedActiveLeases({ companyId: fixture.companyId, leaseId: fixture.leaseId, backoffMs: 5 * 60_000 });
    await expectSandboxReleased(fixture);
  }, 60_000);

  async function terminate(fixture: Awaited<ReturnType<typeof seed>>) {
    const lifecycle = createAgentLifecycle(db);
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, fixture.manager));
    workers.push(worker);
    await lifecycle.terminateAgent(fixture.agentId);
    await worker.process(fixture.agentId);
    return (await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]!;
  }

  it("finishes a release that lock conflicts held back, preserving the files, once the locks clear", async () => {
    const fixture = await seed("runner_launch");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled" })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const heartbeat = heartbeatService(db, { pluginWorkerManager: fixture.manager });
    let ready!: () => void, unlock!: () => void;
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { unlock = resolve; });
    const holder = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, fixture.issueId)).for("update");
      ready(); await released;
    });
    await locked;
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await heartbeat.releaseEnvironmentLeasesForRun({ runId: fixture.runId, companyId: fixture.companyId,
          agentId: fixture.agentId, status: "cancelled", providerResourceDisposition: "destroy" });
        expect((await lease(fixture.leaseId)).metadata?.releaseDeferral).toMatchObject({ reason: "workspace_retention_busy", attempts: attempt });
      }
    } finally { unlock(); await holder; }
    const deferred = await lease(fixture.leaseId);
    await db.update(environmentLeases).set({ metadata: { ...deferred.metadata, releaseDeferral: {
      ...(deferred.metadata?.releaseDeferral as object), retryAt: new Date(Date.now() - 1_000).toISOString() } } })
      .where(eq(environmentLeases.id, fixture.leaseId));
    await heartbeat.sweepOrphanedActiveLeases({ companyId: fixture.companyId, leaseId: fixture.leaseId, backoffMs: 5 * 60_000 });
    await expectSandboxReleased(fixture);
    expect((await run(fixture.runId)).resultJson).toHaveProperty("workspaceRestoreRecovery.schema", "paperclip.workspace-restore-recovery.v1");
    expect((await terminate(fixture)).lifecycleState).toBe("terminated");
  }, 60_000);

  it("attempts a slow-phase deferred release at once when the agent is terminated", async () => {
    const fixture = await seed("runner_launch");
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled" })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const current = await lease(fixture.leaseId);
    await db.update(environmentLeases).set({ metadata: { ...current.metadata, releaseDeferral: { reason: "release_failed",
      attempts: 8, retryAt: new Date(Date.now() + 60 * 60_000).toISOString(), failingSince: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      providerResourceDisposition: "destroy" } } }).where(eq(environmentLeases.id, fixture.leaseId));
    expect((await terminate(fixture)).lifecycleState).toBe("terminated");
    await expectSandboxReleased(fixture);
  }, 60_000);

  it("gives each overlapping stop operation one immediate attempt, then respects the stored retry time", async () => {
    const fixture = await seed("runner_launch");
    await db.update(nativeRunFinalizations).set({ leaseExpiresAt: new Date(Date.now() + 60 * 60_000) })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled" })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const heartbeat = heartbeatService(db, { pluginWorkerManager: fixture.manager });
    const parent = `lifecycle:${randomUUID()}`, child = `lifecycle:${randomUUID()}`;
    for (let pass = 0; pass < 30; pass++) {
      expect(await heartbeat.agentInvocationStopBlocker([fixture.agentId], "Agent lifecycle stop requested",
        { trigger: pass % 2 === 0 ? parent : child })).toMatch(/^environment_lease_release_deferred:workspace_owner_active$/);
    }
    expect((await lease(fixture.leaseId)).metadata?.releaseDeferral).toMatchObject({ reason: "workspace_owner_active",
      attempts: 2, triggers: [parent, child] });
    expect(fixture.teardownCalls()).toHaveLength(0);
  }, 60_000);

  it.each(PRE_LAUNCH)("the orphan lease check releases a sandbox a cancelled run leaked during %s", async window => {
    const fixture = await seed(window);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled" })
      .where(eq(heartbeatRuns.id, fixture.runId));
    const heartbeat = heartbeatService(db, { pluginWorkerManager: fixture.manager });
    await heartbeat.sweepOrphanedActiveLeases({ companyId: fixture.companyId, leaseId: fixture.leaseId, backoffMs: 5 * 60_000 });
    await expectSandboxReleased(fixture);
  }, 60_000);
});
