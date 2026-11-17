import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { currentControllerBootId } from "../services/controller-process-identity.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../services/native-local-process-stop.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const PROVIDER_METHODS = ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease",
  "environmentDestroyLease", "environmentStopLease"];

// The shape a pause left on a fresh instance (run 5a4d609a, lease d9950cbf,
// agent de05198d): a native run cancelled with agent_not_invokable after its
// remote runner process identity was recorded and before any turn started; its
// finalization coordinator still owned by the restart-recovery CONTROLLER claim
// "<bootId>:<generation>:<uuid>" (phase observed, owner lease expired); the
// sandbox lease active; the agent parked in pausing after 5 incomplete stops.
// Identifiers are fresh per test; states, codes and timestamps are the rows'.
const T = (iso: string) => new Date(iso);

describeEmbeddedPostgres("pause Stop of a run cancelled under an expired controller claim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const workers: Array<{ stop(): Promise<void> }> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pause-stop-controller-claim-");
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

  async function seed(options: { checkpoint: boolean; holds: string[] }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), leaseId = randomUUID(), pluginId = randomUUID(), workspaceId = randomUUID();
    const providerLeaseId = `bx_${randomUUID().slice(0, 8)}`;
    // The controller that claimed the run (its boot is gone after a restart).
    const oldBootId = randomUUID();
    expect(oldBootId).not.toBe(currentControllerBootId());
    const controllerOwner = `${oldBootId}:2:${randomUUID()}`;
    const pluginKey = `paperclip.pause-stop-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Fake sandbox", description: "Test provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin",
          configSchema: { type: "object" } }] } } as never);
    await db.insert(companies).values({ id: companyId, name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const config = { provider: "fake-plugin", image: "fake:test", timeoutMs: 1234, reuseLease: true };
    await db.insert(environments).values({ id: environmentId, name: `Fake sandbox ${environmentId}`, driver: "sandbox",
      status: "active", config });
    const operationId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", status: "paused",
      adapterType: "paperclip_runner", adapterConfig: { provider: "opencode" }, runtimeConfig: {}, permissions: {},
      defaultEnvironmentId: environmentId, pausedAt: T("2026-11-17T01:05:51.624Z"), pauseReason: options.holds[0] ?? null,
      lifecycleState: "pausing", lifecycleHolds: options.holds, lifecycleRequiredPluginIds: [], lifecycleVersion: 5,
      lifecycleError: `lifecycle_stop_retry_required: Automatic stop work is paused after 5 incomplete attempts in pausing: invocation ${runId} remains unresolved (lifecycle operation ${operationId}). Recheck the stop evidence, then use Retry.`,
      lifecycleOperation: { id: operationId, attempts: 13, pauseCause: { holds: ["manual"], companyPauseReason: null },
        resumeState: "ready", hostComplete: false, stopFailures: 5, retryRequired: true, completedPluginIds: [] } } as never);
    await db.insert(issues).values({ id: issueId, companyId, title: "Assigned task", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "system",
      status: "cancelled", errorCode: "agent_not_invokable", error: "Agent is not invokable in its current state",
      startedAt: T("2026-11-17T01:00:09.329Z"), finishedAt: T("2026-11-17T01:05:52.453Z"),
      runtimeMode: "native", runtimeModeResolvedAt: T("2026-11-17T01:00:16.140Z"), issueId, nativeIssueId: issueId,
      contextSnapshot: { issueId }, nextEventSeq: 82, nativePhase: "observed", nativePhaseUpdatedAt: T("2026-11-17T01:05:09.845Z"),
      processPid: 15231, processStartedAt: T("2026-11-17T01:00:26.148Z"), processHostHash: "remote",
      controllerProcess: { pid: 7, bootId: oldBootId, hostHash: "a5ce5f9846d7be141d6295d753fdb78a",
        processStartedAt: "2026-11-17T00:03:17.900Z" },
      livenessState: "failed", driverKind: "pi_rpc", driverVersion: "phase6-v1",
      resultJson: { pauseStop: { holds: ["manual"], companyPauseReason: null }, stopReason: "cancelled" },
      runnerProfileJson: {
        mode: "native", backend: "pi_rpc",
        nativeResourceDisposition: "keep_running",
        nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
          descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
          workspaceId, leaseId, providerLeaseId, remoteCwd: "/home/user/paperclip-workspace", resourceDisposition: "keep_running" },
        ...(options.checkpoint ? { sessionCheckpoint: { sessionId: randomUUID(), driverKind: "pi_rpc", backendKind: "runner",
          cursor: "779", activeTurnId: null, terminalTurns: [{ turnId: randomUUID() }], pendingRuntimeRequests: [] } } : {}),
      } } as never);
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", attempt: 2,
      leaseOwner: controllerOwner, leaseExpiresAt: T("2026-11-17T01:06:50.292Z"),
      controllerBootId: oldBootId, controllerPid: 7, controllerProcessStartedAt: T("2026-11-17T00:03:17.900Z"),
      controllerGeneration: 2, controllerHostHash: "a5ce5f9846d7be141d6295d753fdb78a", recoveryState: "awaiting_runner_reattach",
      failureDetail: { recoverable: true, recoveryMode: "same_run", recoveryOwner: "system", checkpointExists: options.checkpoint,
        providerEventsExist: false, providerSessionEstablished: false, originalFailureCode: null, nextAction: null, message: "" },
      createdAt: T("2026-11-17T01:00:16.137Z"), updatedAt: T("2026-11-17T01:05:50.292Z") } as never);
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, issueId,
      executionWorkspaceId: null, status: "active", leasePolicy: "reuse_by_environment", provider: "fake-plugin", providerLeaseId,
      acquiredAt: T("2026-11-17T01:00:13.326Z"), lastUsedAt: T("2026-11-17T01:05:51.583Z"), expiresAt: T("2026-11-17T01:30:12.575Z"),
      metadata: { ...config, agentId, driver: "sandbox", pluginId, pluginKey, sandboxProviderPlugin: true,
        remoteCwd: "/home/user/paperclip-workspace", reusableSandboxLease: true } } as never);
    // Launch evidence up to seq 81, then nothing: no turn.started, no provider event.
    await db.insert(heartbeatRunEvents).values([
      { companyId, runId, agentId, seq: 80, eventType: PROCESS_START_REQUESTED, stream: "system", level: "info",
        message: PROCESS_START_REQUESTED },
      { companyId, runId, agentId, seq: 81, eventType: PROCESS_IDENTITY_RECORDED, stream: "system", level: "info",
        message: PROCESS_IDENTITY_RECORDED, payload: { targetKind: "remote", processPid: 15231,
          processStartedAt: "2026-11-17T01:00:26.148Z" } },
    ]);
    return { companyId, agentId, issueId, runId, leaseId, providerLeaseId, controllerOwner, ...providerWorker(pluginId) };
  }

  // The live agent row has no holds left (a Resume arrived while it was
  // pausing), so a completed pause Stop continues to that Resume: ready. With
  // the pause hold still in place the same Stop leaves the agent paused.
  it.each([
    { name: "live rows: no checkpoint (brief), no holds", checkpoint: false, holds: [] as string[], settled: "ready" },
    { name: "live rows: checkpoint (API row), no holds", checkpoint: true, holds: [] as string[], settled: "ready" },
    { name: "pause hold still held", checkpoint: false, holds: ["manual"], settled: "paused" },
  ])("after a restart, one lifecycle Retry completes the pause Stop and releases the lease: $name", async ({ checkpoint, holds, settled }) => {
    const fixture = await seed({ checkpoint, holds });
    // Restart: fresh services in a process whose controller boot is not the owner's.
    const lifecycle = createAgentLifecycle(db);
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, fixture.manager));
    workers.push(worker);
    await lifecycle.retry(fixture.agentId);
    await worker.process(fixture.agentId);

    const agent = (await db.select().from(agents).where(eq(agents.id, fixture.agentId)))[0]!;
    const lease = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, fixture.leaseId)))[0]!;
    const coordinator = (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId)))[0]!;
    const run = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId)))[0]!;
    console.log("SHAPE_RESULT", JSON.stringify({ checkpoint, holds, lifecycleState: agent.lifecycleState, lifecycleError: agent.lifecycleError,
      operation: agent.lifecycleOperation, leaseStatus: lease.status, leaseReleasedAt: lease.releasedAt,
      releaseDeferral: (lease.metadata as Record<string, unknown> | null)?.releaseDeferral ?? null,
      coordinatorOwner: coordinator.leaseOwner, runStatus: run.status,
      workspaceRestoreRecovery: Boolean((run.resultJson as Record<string, unknown> | null)?.workspaceRestoreRecovery),
      teardownCalls: fixture.teardownCalls().map(([, method]) => method) }));

    expect(run.status).toBe("cancelled");
    expect(lease.status).not.toBe("active");
    expect(lease.releasedAt).not.toBeNull();
    expect(fixture.teardownCalls()).toContainEqual([expect.any(String), expect.any(String),
      expect.objectContaining({ providerLeaseId: fixture.providerLeaseId }), expect.any(Number)]);
    expect(coordinator.leaseOwner).toBeNull();
    // The launched run's prepared files stay recoverable on the stopped sandbox.
    expect(run.resultJson).toHaveProperty("workspaceRestoreRecovery.schema", "paperclip.workspace-restore-recovery.v1");
    expect(agent.lifecycleError).toBeNull();
    expect(agent.lifecycleState).toBe(settled);
  }, 60_000);
});
