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
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueComments,
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
import { createDurableChatWakeupRequest } from "../services/durable-chat-wakeup.js";
import { reevaluateStoppedBeforeFirstInput, settlePreDispatchStopRecovery } from "../services/heartbeat/pre-dispatch-stop-settlement.js";
import { settleStartupStop } from "../services/person-stop-before-turn.js";
import { canRetryStoppedRun } from "../services/cancelled-native-startup.js";
import { requestTaskRetry } from "../services/task-retry.js";
import { claimFirstTurnQueuedInput, readFirstTurnQueuedInputReceipt } from "../services/native-runtime/first-turn-queued-input.js";
import { deliveredQueuedCommentIds } from "../services/queued-comment-delivery.js";
import { findNativeSessionResumeRun } from "../services/native-runtime/native-session-resume.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
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

  it.each(["before-input", "legacy-preparation", "after-input", "system", "owner-active", "newer-status"] as const)(
    "first-input Stop settlement preserves the exact boundary (%s)", async boundary => {
      const fixture = await acquireReusable("replace");
      const original = await run(fixture.runId);
      const now = new Date(), workspaceId = randomUUID(), sessionId = randomUUID(), priorAnswerRunId = randomUUID();
      if (boundary === "before-input") await db.insert(heartbeatRuns).values({ id: priorAnswerRunId,
        companyId: fixture.companyId, agentId: fixture.agentId, nativeIssueId: fixture.issueId, issueId: fixture.issueId,
        nativeSessionId: sessionId, runtimeMode: "native", status: "succeeded", createdAt: new Date(now.getTime() - 60_000),
        finishedAt: new Date(now.getTime() - 50_000), runnerProfileJson: { sessionCheckpoint: {
          backendKind: "codex", driverKind: "pi_rpc", sessionId, providerSessionId: "earlier-real-conversation" } } });
      await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: fixture.companyId,
        sourceIssueId: fixture.issueId, mode: "shared", strategyType: "shared", name: "Borrowed workspace", cwd: "/workspace" });
      await db.update(environmentLeases).set({ executionWorkspaceId: workspaceId }).where(eq(environmentLeases.id, fixture.leaseId));
      await db.update(heartbeatRuns).set({ processStartedAt: now, nativeSessionId: sessionId,
        runnerProfileJson: { ...original.runnerProfileJson,
          nativeExecutionInput: { provider: { kind: "pi_rpc" } },
          nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
            descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
            workspaceId, leaseId: fixture.leaseId, providerLeaseId: fixture.providerLeaseId,
            remoteCwd: "/workspace", resourceDisposition: "keep_running" } },
      }).where(eq(heartbeatRuns.id, fixture.runId));
      if (boundary === "legacy-preparation") {
        await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
        await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null,
          nativeIssueId: null, nativeSessionId: null, processStartedAt: null, executionStage: "preparing",
          runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        }).where(eq(heartbeatRuns.id, fixture.runId));
      } else await db.insert(heartbeatRunEvents).values({ companyId: fixture.companyId, agentId: fixture.agentId,
        runId: fixture.runId, seq: 1, eventType: PROCESS_START_REQUESTED, stream: "system", level: "info", message: "Pi starting" });
      if (boundary !== "system") expect(await settleStartupStop(db, await run(fixture.runId), {
        pressedAt: now.toISOString(), userId: "operator" })).not.toBeNull();
      const preparing = await run(fixture.runId);
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: now,
        resultJson: { ...preparing.resultJson, cancelledByActorType: boundary === "system" ? "system" : "user",
          ...(boundary === "legacy-preparation" ? { preDispatchCancellationSettledAt: now.toISOString() } : {}),
          ...(boundary === "before-input" || boundary === "newer-status" || boundary === "owner-active" ? { nativeCancellation: {
            schema: "paperclip.native-cancellation.v1", companyId: fixture.companyId, issueId: fixture.issueId,
            runId: fixture.runId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
            dispatched: false, beforeProviderTurn: true, intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
          } } : {}),
          ...(boundary === "after-input" ? { firstTurnDispatchCommitted: true } : {}) },
      }).where(eq(heartbeatRuns.id, fixture.runId));
      if (boundary === "after-input") await db.insert(heartbeatRunEvents).values({
        companyId: fixture.companyId, agentId: fixture.agentId, runId: fixture.runId, seq: 2,
        eventType: "turn.started", stream: "system", level: "info", message: "real input and edits" });
      if (boundary === "owner-active") await db.update(nativeRunFinalizations).set({ leaseOwner: "live-controller",
        leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, fixture.runId));
      if (boundary === "newer-status") await db.update(issues).set({ status: "blocked", statusVersion: 77 })
        .where(eq(issues.id, fixture.issueId));
      const [beforeReleaseTask] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
      const heartbeat = heartbeatService(db, { pluginWorkerManager: fixture.manager });
      // Exercise the stock release writer before cleanup, as the real Stop does.
      await createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: async () => null,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }), resolveSessionBeforeForWakeup: async () => null,
      }).withIssueExecutionLock({ companyId: fixture.companyId, runId: fixture.runId, now: new Date() },
        async () => { throw new Error("Stop must not promote work"); });
      await heartbeat.releaseEnvironmentLeasesForRun({ runId: fixture.runId, companyId: fixture.companyId,
        agentId: fixture.agentId, status: "cancelled" });
      await settlePreDispatchStopRecovery(db, fixture.companyId, fixture.runId);
      const [task] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
      const stopped = await run(fixture.runId);
      if (boundary === "newer-status") {
        expect(task!.status).toBe("blocked");
        const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
        // This release has no reconciliation hold to settle. Refusal must
        // still preserve the newer version and the unsurrendered file proof.
        expect(holds).toHaveLength(0);
        expect(task!.statusVersion).toBe(beforeReleaseTask!.statusVersion);
        expect(stopped.runnerProfileJson).toHaveProperty("nativeWorkspaceSync.state", "prepared");
      } else if (boundary === "before-input" || boundary === "legacy-preparation") {
        expect(task!.status).toBe("todo");
        expect(stopped.resultJson).toHaveProperty("stoppedBeforeFirstInput.runId", fixture.runId);
        expect(stopped.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
        expect(stopped.runnerProfileJson).not.toHaveProperty("nativeWorkspaceSync");
        expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId)))
          .not.toContainEqual(expect.objectContaining({ status: "active", cause: "native_continuation_requires_reconciliation" }));
        expect(await lease(fixture.leaseId)).toMatchObject({ status: "released", cleanupStatus: "success",
          providerLeaseId: fixture.providerLeaseId });
        expect(fixture.teardownCalls()).toHaveLength(0);
        expect(await canRetryStoppedRun(db, stopped)).toBe(true);
        if (boundary === "before-input") {
          const resume = await findNativeSessionResumeRun(db, { companyId: fixture.companyId, agentId: fixture.agentId,
            issueId: fixture.issueId, normalizedSessionId: sessionId, beforeCreatedAt: new Date() });
          expect(resume?.id).toBe(priorAnswerRunId);
          expect(resume?.nativeSessionId).toBe(sessionId);
          const started = Date.now();
          for (const seconds of [1, 30, 120]) {
            await new Promise(resolve => setTimeout(resolve, Math.max(0, seconds * 1000 - (Date.now() - started))));
            await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
            await settlePreDispatchStopRecovery(db, fixture.companyId, fixture.runId);
            const [observed] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
            const observedRun = await run(fixture.runId);
            const holds = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, fixture.issueId));
            expect(observed!.status).toBe("todo");
            expect(observedRun.resultJson).not.toHaveProperty("workspaceRestoreRecovery");
            expect(holds.filter(hold => ["active", "escalated"].includes(hold.status))).toHaveLength(0);
            console.info("stop-first-input-observation", JSON.stringify({ seconds, runId: fixture.runId, taskStatus: observed!.status,
              workspaceRecovery: false, activeHolds: 0, providerLeaseId: fixture.providerLeaseId }));
          }
        }
        // Replay is idempotent and never starts a successor, including 0260's sweep boundary.
        await settlePreDispatchStopRecovery(db, fixture.companyId, fixture.runId);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId, fixture.issueId)))
          .filter(row => ["queued", "running"].includes(row.status))).toHaveLength(0);
        if (boundary === "legacy-preparation") {
          const receipt = await requestTaskRetry({ db, companyId: fixture.companyId, issueId: fixture.issueId,
            actorId: "operator", observedRunId: fixture.runId, idempotencyKey: randomUUID(), actorSource: "local_implicit" });
          expect(receipt).toMatchObject({ accepted: true });
          await heartbeat.resumeTaskRetry(fixture.companyId, receipt.requestId!);
          const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.requestId!));
          expect(wake.payload?.executionWait).toBeUndefined();
          expect(wake).toMatchObject({ status: "coalesced", runId: expect.any(String) });
          const successor = await run(wake.runId!);
          expect(successor.contextSnapshot).toMatchObject({ previousRunId: fixture.runId, taskRetryRequestId: receipt.requestId });
          console.info("early-stop-task-retry-admitted", JSON.stringify({ sourceRunId: fixture.runId, successorRunId: successor.id }));
        }
      } else {
        expect(stopped.resultJson).not.toHaveProperty("stoppedBeforeFirstInput");
        expect(task!.status).toBe("blocked");
        if (boundary === "after-input") {
          expect(stopped.resultJson).toHaveProperty("workspaceRestoreRecovery.schema", "paperclip.workspace-restore-recovery.v1");
          expect(fixture.teardownCalls().some(([, method]) => method === "environmentDestroyLease")).toBe(false);
          // The borrowed allocation is stopped/returned, not destroyed; the
          // exact workspace-recovery receipt above keeps its files protected.
        }
      }
    }, 150_000);

  // Recorded gate-5 shape: Stop before staging, legacy hold already resolved
  // blocked, no captured old task version, and four messages already parked.
  it.each(["send", "retry", "newer-status", "successor", "live-owner", "provider-work", "changed-allocation", "foreign-hold",
    "h-send", "h-retry", "h-wait-send", "h-wait-retry", "h-unsettled", "h-system", "startup-system", "startup-no-person", "startup-system-initiator"] as const)(
    "re-evaluates an already-stuck early Stop only at a person's request (%s)", async scenario => {
      const liveShape = scenario.startsWith("h-") || scenario.startsWith("startup-");
      const waiting = scenario.startsWith("h-wait-");
      const action = scenario === "h-send" || scenario === "h-wait-send" || scenario === "newer-status" ? "send" : scenario === "h-retry" || scenario === "h-wait-retry" ? "retry" : scenario;
      const f = await acquireReusable("replace");
      const now = new Date(), actionId = randomUUID();
      await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      await db.update(heartbeatRuns).set({ runtimeMode: "legacy", runtimeModeResolvedAt: null,
        nativeIssueId: null, executionStage: "preparing", status: "cancelled", errorCode: scenario.startsWith("h-") ? null : "cancelled", finishedAt: now,
        runnerProfileJson: { adapterDispatch: { adapterType: "paperclip_runner" } },
        resultJson: { startupCancellation: { requestedAt: now.toISOString(), beforeNativeSelection: true },
          cancelledByActorType: "user", cancelledByUserId: "operator",
          ...(liveShape ? { ...(scenario === "startup-no-person" ? {} : { personStop: { userId: "operator", returned: [], requestedAt: now.toISOString() } }),
            startupPreparationSettledAt: new Date(now.getTime() + (scenario === "h-unsettled" ? -1 : 1)).toISOString(),
            cancellation: { reason: "Execution stopped", source: scenario === "h-system" || scenario === "startup-system" ? "system" : "operator",
              ...(scenario === "startup-system-initiator" ? { source: null, initiator: { type: "system" } } : { initiator: "user" }),
              expected: true, recordedAt: now.toISOString() } }
            : { personStop: { userId: "operator", returned: [], requestedAt: now.toISOString() },
              preDispatchCancellationSettledAt: now.toISOString() }) },
      }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: now })
        .where(eq(environmentLeases.id, f.leaseId));
      await db.update(issues).set({ status: "blocked", statusVersion: 5, executionRunId: null })
        .where(eq(issues.id, f.issueId));
      const [blockedTask] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      await db.insert(issueRecoveryActions).values({ id: actionId, companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${f.runId}`,
        status: "resolved", outcome: "blocked", nextAction: "Inspect the run before sending a new message to request continuation.",
        evidence: { runId: f.runId, legacyCancellationBlock: { runId: f.runId, statusVersion: blockedTask.statusVersion, previousStatus: "in_progress" },
          ...(liveShape ? { attempt: 1, adapterRecovery: {}, originalFailureCode: null,
            freshContinuationCheck: { kind: "person_owned", reason: "stopped_on_request" }, savedPersonWakeNoticeCommentId: randomUUID() } : {}),
          automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked", actionOutcome: "unknown" } } });
      const commentIds: string[] = [], wakeIds: string[] = [];
      const heldCount = waiting ? 5 : 4;
      for (let index = 0; index < heldCount; index++) {
        const id = randomUUID(), wakeId = randomUUID(), at = new Date(now.getTime() + index + 1);
        commentIds.push(id); wakeIds.push(wakeId);
        await db.insert(issueComments).values({ id, companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "operator", body: `held-message-${index}`, createdAt: at, updatedAt: at });
        await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.agentId,
          source: "issue", reason: "issue_commented", status: "deferred_issue_execution", requestedAt: at,
          requestedByActorType: "user", requestedByActorId: "operator", payload: { issueId: f.issueId,
            ...(waiting ? { executionWait: { reason: "previous_execution_unverified", recoveryActionId: actionId } } : {}),
            _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentId: id, wakeCommentIds: [id] } } });
      }
      if (scenario === "newer-status") await db.update(issues).set({ statusVersion: blockedTask.statusVersion + 1 }).where(eq(issues.id, f.issueId));
      if (action === "successor") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        issueId: f.issueId, status: "failed", createdAt: new Date(now.getTime() + 1000) });
      if (action === "live-owner") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
        .where(eq(heartbeatRuns.id, f.runId));
      if (action === "provider-work") await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
        runId: f.runId, seq: 1, eventType: "turn.started", stream: "system" });
      if (action === "changed-allocation") await db.update(environmentLeases).set({ providerLeaseId: "another-box" })
        .where(eq(environmentLeases.id, f.leaseId));
      if (action === "foreign-hold") await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
        status: "active", nextAction: "Another run", evidence: { runId: randomUUID() } });
      const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager });
      // A real queue admission, held below provider launch by another task's
      // slot. This row may prove input custody, never a model answer.
      await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      if (action === "send") {
        const id = randomUUID(); commentIds.push(id);
        await db.insert(issueComments).values({ id, companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "operator", body: "new-edited-send", createdAt: new Date(now.getTime() + 10) });
        const durable = waiting ? createDurableChatWakeupRequest({ id: randomUUID(), companyId: f.companyId,
          agentId: f.agentId, issueId: f.issueId, commentId: id, requestedByActorType: "user", requestedByActorId: "operator",
          requestedAt: new Date(now.getTime() + 10), resumeDeferred: true, authorize: async () => {} }) : undefined;
        if (durable) await db.insert(agentWakeupRequests).values({ id: durable.id, companyId: f.companyId, agentId: f.agentId,
          source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution", requestedAt: durable.requestedAt,
          idempotencyKey: durable.idempotencyKey, requestedByActorType: "user", requestedByActorId: "operator",
          payload: { issueId: f.issueId, executionWait: { reason: "previous_execution_unverified", recoveryActionId: actionId }, _paperclipWakeContext: { issueId: f.issueId,
              wakeReason: "issue_commented", wakeCommentId: id, wakeCommentIds: [id] } } });
        await heartbeat.wakeup(f.agentId, { source: "on_demand", reason: "issue_commented", requestedByActorType: "user",
          ...(durable ? { durableChatRequest: durable } : {}),
          requestedByActorId: "operator", payload: { issueId: f.issueId, commentId: id },
          contextSnapshot: { issueId: f.issueId, wakeCommentId: id, wakeReason: "issue_commented" } });
      } else if (action === "retry") {
        const receipt = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "operator",
          actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
        expect(receipt.accepted).toBe(true);
        await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId!);
      } else await reevaluateStoppedBeforeFirstInput(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId });
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [hold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId));
      if (scenario === "newer-status") {
        expect(hold.outcome).toBe("blocked");
        expect(task.status).toBe("blocked");
        expect(hold.nextAction).toContain("task status changed");
        expect(hold.evidence).toMatchObject({ stopSettlementRefusal: {
          code: "person_stop_task_status_changed", runId: f.runId, currentStatusVersion: blockedTask.statusVersion + 1,
        } });
        const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        expect(wakes.filter(wake => wakeIds.includes(wake.id)).every(wake => wake.status === "deferred_issue_execution")).toBe(true);
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
          .filter(row => row.status === "queued")).toHaveLength(0);
        return;
      }
      if (!["send", "retry"].includes(action)) {
        expect(hold.outcome).toBe("blocked");
        expect((await run(f.runId)).resultJson).not.toHaveProperty("stoppedBeforeFirstInput");
        return;
      }
      expect(hold.outcome).toBe("cancelled");
      expect(task.status).toBe("todo");
      expect(await reevaluateStoppedBeforeFirstInput(db, { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId })).toBe(0);
      const successors = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
        .filter(row => row.status === "queued");
      expect(successors).toHaveLength(1);
      const next = successors[0];
      const ownIds = next.contextSnapshot?.wakeCommentIds as string[];
      expect(ownIds).toEqual(action === "retry" ? commentIds : commentIds.slice(0, 1));
      // Run the production first-input seal after the harness's launch boundary.
      await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.issueId,
        startedAt: new Date(), responsibleUserId: "operator" })
        .where(eq(heartbeatRuns.id, next.id));
      await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, f.issueId));
      const binding = { companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, runId: next.id };
      const text = await claimFirstTurnQueuedInput(db, binding);
      const delivered = readFirstTurnQueuedInputReceipt(await run(next.id));
      const inputIds = [...ownIds, ...(delivered?.commentIds ?? [])];
      expect(inputIds).toEqual(commentIds);
      expect(new Set(inputIds).size).toBe(commentIds.length);
      if (action === "send") {
        expect(text).toContain("new-edited-send");
        for (let index = 1; index < heldCount; index++) expect(text!.indexOf(`held-message-${index}`))
          .toBeGreaterThan(index > 1 ? text!.indexOf(`held-message-${index - 1}`) : -1);
      } else expect(text).toBeNull();
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId, runId: next.id,
        seq: 1, eventType: "turn.started", stream: "system" });
      // Simulate the harness's accepted terminal receipt to exercise the real
      // consumption ledger; this is not a provider/model answer.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, next.id));
      const accepted = await deliveredQueuedCommentIds(db, { companyId: f.companyId, issueId: f.issueId,
        agentId: f.agentId, commentIds: commentIds.slice(0, heldCount) });
      expect([...accepted].sort()).toEqual(commentIds.slice(0, heldCount).sort());
      const followupId = randomUUID(), followupRunId = randomUUID();
      await db.insert(issueComments).values({ id: followupId, companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "operator", body: "one-follow-up" });
      await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
        source: "issue", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user",
        requestedByActorId: "operator", payload: { issueId: f.issueId, _paperclipWakeContext: {
          wakeReason: "issue_commented", wakeCommentId: followupId, wakeCommentIds: [followupId] } } });
      await db.insert(heartbeatRuns).values({ id: followupRunId, companyId: f.companyId, agentId: f.agentId,
        nativeIssueId: f.issueId, status: "running", runtimeMode: "native", responsibleUserId: "operator" });
      await db.update(issues).set({ executionRunId: followupRunId }).where(eq(issues.id, f.issueId));
      const followupText = await claimFirstTurnQueuedInput(db, { ...binding, runId: followupRunId });
      expect(followupText).toContain("one-follow-up");
      expect(followupText).not.toContain("held-message-");
      expect(readFirstTurnQueuedInputReceipt(await run(followupRunId))?.commentIds).toEqual([followupId]);
      console.info("historical-stop-input-custody", JSON.stringify({ action, sourceRunId: f.runId,
        successorRunId: next.id, orderedInputIds: inputIds, modelAnswer: false }));
    }, 60_000);

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
