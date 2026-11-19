import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns,
  issueComments, issues, plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { agentPausedText, settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

// Keep reason: tB2 pause stuck in 'pausing' while the provider box stop never
// returned (PL-PAUSE-STUCK-TB2). Pause completes on the server's own record;
// the box is released in the background through the existing lease sweep.
const support = await getEmbeddedPostgresTestSupport();
const PROVIDER_METHODS = ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease",
  "environmentDestroyLease", "environmentStopLease"];
const TEARDOWN = new Set(["environmentDestroyLease", "environmentStopLease", "environmentReleaseLease"]);
// NSE's active-cancellation bound: native-session-executor.ts:682
// NATIVE_SESSION_CANCELLATION_CLEANUP_GRACE_MS = 2_000 (raced at :11014-11024).
const NSE_CANCELLATION_BOUND_MS = 2_000;

class Timeout extends Error {}
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(`${label} did not finish within ${ms} ms`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe.skipIf(!support.supported)("pause completes on the server's own record (tB2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pause-server-record-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  /** A provider whose stop/destroy/release NEVER returns (Boat blocked). */
  function blockedProvider(pluginId: string, rpcBoundMs?: number) {
    const call = vi.fn((_pluginId: string, method: string, _params: { providerLeaseId?: string }) => {
      // Boat never answers. In production the plugin worker manager bounds each
      // RPC (manager.call timeout); rpcBoundMs models that bound being reached.
      if (TEARDOWN.has(method)) return rpcBoundMs === undefined ? new Promise(() => {})
        : new Promise((_, reject) => setTimeout(() => reject(new Error("plugin RPC timed out")), rpcBoundMs));
      return Promise.reject(new Error(`Unexpected provider method ${method}`));
    });
    const manager = { isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: PROVIDER_METHODS })), call } as unknown as PluginWorkerManager;
    const teardowns = () => call.mock.calls.filter(([, method]) => TEARDOWN.has(method))
      .map(([, method, params]) => ({ method, providerLeaseId: params.providerLeaseId }));
    return { manager, teardowns };
  }

  async function seed(opts: { runStatus?: "cancelled" | "succeeded"; withLease?: boolean; warmBox?: boolean;
    rpcBoundMs?: number; runnerProfileJson?: Record<string, unknown> } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID(), userId = `board-${companyId.slice(0, 8)}`;
    const pluginKey = `paperclip.pause-record-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Fake Boat", description: "Test provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-boat", kind: "sandbox_provider", displayName: "Fake Boat",
          configSchema: { type: "object" } }] } } as never);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Pause record",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user",
      status: "active", membershipRole: "owner" });
    const config = { provider: "fake-boat", image: "fake:test", timeoutMs: 1234, reuseLease: true };
    await db.insert(environments).values({ id: environmentId, name: `Fake Boat ${environmentId}`, driver: "sandbox",
      status: "active", config });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi" }, runtimeConfig: {}, permissions: {},
      defaultEnvironmentId: environmentId });
    await db.insert(issues).values({ id: issueId, companyId, title: "Person conversation", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId });
    const startedAt = new Date(Date.now() - 60_000);
    // The person's Stop already cancelled this native run; its box stop is blocked.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      status: opts.runStatus ?? "cancelled", runtimeMode: "native", runtimeModeResolvedAt: startedAt, issueId,
      nativeIssueId: issueId, startedAt, finishedAt: new Date(Date.now() - 30_000), contextSnapshot: { issueId },
      // A person's Stop records these (routes/issues.ts:8133).
      errorCode: "operator_interrupted",
      resultJson: { executionCancellation: { state: "requested" }, cancelledByActorType: "user" } });
    const stoppedBox = `stopped-box-${randomUUID()}`, warmBox = `warm-box-${randomUUID()}`;
    const leaseIds: string[] = [];
    if (opts.withLease !== false) {
      const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: runId, issueId,
        status: "active", leasePolicy: "ephemeral", provider: "fake-boat", providerLeaseId: stoppedBox,
        metadata: { ...config, agentId, driver: "sandbox", pluginId, pluginKey, sandboxProviderPlugin: true,
          remoteCwd: "/workspace", sandboxState: "started" } }).returning();
      leaseIds.push(lease!.id);
    }
    if (opts.warmBox) {
      // The agent's warm box, matched only by metadata.agentId (agent-execution-stop.ts:22).
      await db.insert(environmentLeases).values({ companyId, environmentId, issueId, status: "active",
        leasePolicy: "reuse_by_environment", provider: "fake-boat", providerLeaseId: warmBox,
        metadata: { ...config, agentId, driver: "sandbox", pluginId, pluginKey, sandboxProviderPlugin: true,
          remoteCwd: "/workspace", sandboxState: "started" } });
    }
    if (opts.runnerProfileJson) await db.update(heartbeatRuns).set({ runnerProfileJson: opts.runnerProfileJson }).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, issueId, runId, userId, environmentId, stoppedBox, warmBox, leaseIds, ...blockedProvider(pluginId, opts.rpcBoundMs) };
  }

  /** A person's message: the comment row plus the comment route's wakeup (routes/issues.ts issue_commented). */
  async function personMessage(heartbeat: ReturnType<typeof heartbeatService>, f: Awaited<ReturnType<typeof seed>>, body: string) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: f.userId, body, createdAt: new Date(Date.now() - 5 * 60_000) }).returning();
    await within(heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: comment!.id, mutation: "comment" },
      requestedByActorType: "user", requestedByActorId: f.userId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, commentId: comment!.id, wakeCommentId: comment!.id,
        source: "issue.comment", wakeReason: "issue_commented" } }), 10_000, "message wakeup")
      // The route fires this wakeup without awaiting it (routes/issues.ts:21167); a
      // paused agent refuses it and the saved comment waits for the paused note.
      .catch(error => { if (!/not invokable/.test(String(error))) throw error; });
    return comment!;
  }
  const agentRow = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const due = (id: string) => db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` })
    .where(eq(agents.id, id));
  function lifecycleWorker(manager: PluginWorkerManager) {
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager));
    // A worker blocked on a provider call never stops; do not let it hang the file.
    return { process: (id: string) => worker.process(id), stop: () => within(worker.stop(), 2_000, "worker stop").catch(() => {}) };
  }
  /** Drive the lifecycle worker until `state` or the deadline. */
  async function until(worker: ReturnType<typeof lifecycleWorker>, agentId: string, state: string, ms: number) {
    const deadline = Date.now() + ms;
    for (;;) {
      await due(agentId);
      await within(worker.process(agentId), Math.max(500, deadline - Date.now()), `lifecycle step toward ${state}`);
      const row = await agentRow(agentId);
      if (row.lifecycleState === state || Date.now() >= deadline) return row;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  it("R1: a warm box and a cancelled native run: Pause -> 'paused' within seconds; destroy runs in the background", async () => {
    const f = await seed({ warmBox: true });
    const worker = lifecycleWorker(f.manager);
    try {
      await createAgentLifecycle(db).pauseAgent(f.agentId);
      const started = Date.now();
      const row = await until(worker, f.agentId, "paused", 5_000);
      expect(row).toMatchObject({ lifecycleState: "paused", status: "paused" });
      expect(Date.now() - started).toBeLessThan(5_000);
      // The pause step itself called no provider teardown: nothing was awaited inline.
      expect(f.teardowns()).toEqual([]);
      // The existing durable lease sweep (recovery.ts:1665 retryTerminalRunLeaseRelease via
      // live-recovery-work.ts:149 orphanActiveLeases) takes the stopped box: same release path.
      const sweep = heartbeatService(db, { pluginWorkerManager: f.manager }).sweepOrphanedActiveLeases({ backoffMs: 0, leaseId: f.leaseIds[0] });
      void sweep.catch(() => {});
      const deadline = Date.now() + 5_000;
      while (!f.teardowns().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      expect(f.teardowns()).toEqual([{ method: "environmentDestroyLease", providerLeaseId: f.stoppedBox }]);
      // The destroy never returned: the box stays owned and is never released or reusable
      // (environment-runtime.ts:1224 resumes only released/retained, or active of the same run).
      const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.leaseIds[0]!));
      expect(["released", "retained"]).not.toContain(lease!.status);
      expect((await agentRow(f.agentId)).lifecycleState).toBe("paused");
    } finally { await worker.stop(); }
  }, 30_000);

  it("R2: Stop then Pause then Resume then a message, stop blocked: paused at once, ready at once, message admitted once", async () => {
    const f = await seed({ warmBox: true });
    const worker = lifecycleWorker(f.manager);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager,
      runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } } as never);
    try {
      const lifecycle = createAgentLifecycle(db);
      await lifecycle.pauseAgent(f.agentId);
      expect((await until(worker, f.agentId, "paused", 5_000)).lifecycleState).toBe("paused");
      await lifecycle.resumeAgent(f.agentId);
      expect((await until(worker, f.agentId, "ready", 5_000)).lifecycleState).toBe("ready");
      await personMessage(heartbeat, f, "Please continue.");
      await within(heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId }), 10_000, "reconcile");
      const fresh = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agentId), ne(heartbeatRuns.id, f.runId)));
      expect(fresh).toHaveLength(1);
      // Not onto the stopped run's box: no lease of the new run names the stopped box.
      const boxes = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, fresh[0]!.id));
      expect(boxes.map(lease => lease.providerLeaseId)).not.toContain(f.stoppedBox);
    } finally { await worker.stop(); await heartbeat.drainActiveRunExecutions(); }
  }, 40_000);

  it("R3: Resume pressed while 'pausing' reaches 'ready' within seconds, no stuck state", async () => {
    const f = await seed({ warmBox: true });
    const worker = lifecycleWorker(f.manager);
    try {
      const lifecycle = createAgentLifecycle(db);
      await lifecycle.pauseAgent(f.agentId);
      expect((await agentRow(f.agentId)).lifecycleState).toBe("pausing");
      await lifecycle.resumeAgent(f.agentId);
      const row = await until(worker, f.agentId, "ready", 5_000);
      expect(row).toMatchObject({ lifecycleState: "ready", lifecycleHolds: [] });
    } finally { await worker.stop(); }
  }, 30_000);

  it("R4: a run still EXECUTING here keeps Pause in 'pausing' (run_executing_here) until it settles", async () => {
    const f = await seed({ withLease: false });
    const worker = lifecycleWorker(f.manager);
    runningProcesses.set(f.runId, { child: { pid: undefined } as never, graceSec: 0, processGroupId: null });
    try {
      await createAgentLifecycle(db).pauseAgent(f.agentId);
      for (let pass = 0; pass < 3; pass++) { await due(f.agentId); await within(worker.process(f.agentId), 5_000, "pause step"); }
      const held = await agentRow(f.agentId);
      expect(held.lifecycleState).toBe("pausing");
      expect(held.lifecycleOperation).toMatchObject({ pendingReason: "run_executing_here" });
      runningProcesses.delete(f.runId);
      expect((await until(worker, f.agentId, "paused", 5_000)).lifecycleState).toBe("paused");
    } finally { runningProcesses.delete(f.runId); await worker.stop(); }
  }, 30_000);

  it("R4b (C1): executing here at Pause, provider stop never returns: 'paused' after the NSE cancellation bound, never stuck", async () => {
    const f = await seed({ warmBox: true });
    const worker = lifecycleWorker(f.manager);
    runningProcesses.set(f.runId, { child: { pid: undefined } as never, graceSec: 0, processGroupId: null });
    // The executor leaves this process when its cancellation cleanup race ends (NSE :682 bound).
    const settle = setTimeout(() => runningProcesses.delete(f.runId), NSE_CANCELLATION_BOUND_MS);
    try {
      const started = Date.now();
      await createAgentLifecycle(db).pauseAgent(f.agentId);
      await due(f.agentId); await within(worker.process(f.agentId), 5_000, "first pause step");
      expect((await agentRow(f.agentId)).lifecycleState).toBe("pausing");
      const row = await until(worker, f.agentId, "paused", NSE_CANCELLATION_BOUND_MS + 5_000);
      expect(row.lifecycleState).toBe("paused");
      expect(Date.now() - started).toBeGreaterThanOrEqual(NSE_CANCELLATION_BOUND_MS - 50);
      expect(f.teardowns()).toEqual([]);
    } finally { clearTimeout(settle); runningProcesses.delete(f.runId); await worker.stop(); }
  }, 30_000);

  it("R5: a message to the paused agent gets the plain paused line exactly once and runs after Resume", async () => {
    const f = await seed({ warmBox: true });
    const worker = lifecycleWorker(f.manager);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager,
      runStartHandover: { isYielding: () => true, refreshIfStale: async () => {} } } as never);
    const notes = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, f.issueId),
      eq(issueComments.authorType, "system"), isNull(issueComments.deletedAt)));
    try {
      const lifecycle = createAgentLifecycle(db);
      await lifecycle.pauseAgent(f.agentId);
      expect((await until(worker, f.agentId, "paused", 5_000)).lifecycleState).toBe("paused");
      await personMessage(heartbeat, f, "Are you there?");
      for (let pass = 0; pass < 2; pass++) {
        await within(heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.issueId }), 10_000, "notice");
        await settleUnansweredPersonMessage(db, { companyId: f.companyId, issueId: f.issueId, now: new Date(Date.now() + 30 * 60_000) });
      }
      expect((await notes()).map(note => note.body)).toEqual([agentPausedText("Managed Pi")]);
      await lifecycle.resumeAgent(f.agentId);
      expect((await until(worker, f.agentId, "ready", 5_000)).lifecycleState).toBe("ready");
      // The saved message is released by the existing deferred-receipt work (the
      // production delivery coordinator), not by a test-only call.
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
        onError: () => {} });
      try {
        await heartbeat.registerDeferredReceiptWork(coordinator, () => true).ready;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && !(await db.select().from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.agentId, f.agentId), ne(heartbeatRuns.id, f.runId)))).length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally { await coordinator.stop(); }
      const fresh = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agentId), ne(heartbeatRuns.id, f.runId)));
      expect(fresh).toHaveLength(1);
      expect((await notes()).filter(note => note.body === agentPausedText("Managed Pi"))).toHaveLength(1);
    } finally { await worker.stop(); await heartbeat.drainActiveRunExecutions(); }
  }, 40_000);
});
