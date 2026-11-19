import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns,
  issueComments, issues, plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));
// The run is hung in provider setup: no native session exists yet. The real
// cancelNativeSession waits for the startup (native-session-executor.ts:512-529)
// and then rejects with NativeCancellationPendingRecoveryError (:10996-10998).
// The first cancel here hangs until the test lets it reach that outcome; later
// cancels reach it at once. The startup itself never returns.
// arm(true): the first cancel instead RETURNS NORMALLY once let go (S3).
const cancelGate = vi.hoisted(() => {
  const gate = { calls: 0, returns: false, released: Promise.resolve(), release: () => {},
    arm(returns: boolean) {
      gate.calls = 0; gate.returns = returns;
      gate.released = new Promise<void>(resolve => { gate.release = resolve; });
    } };
  gate.arm(false);
  return gate;
});
vi.mock("../services/native-runtime/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/index.js")>();
  return { ...actual, cancelNativeSession: vi.fn(async () => {
    if (cancelGate.calls++ === 0) await cancelGate.released;
    if (cancelGate.returns) return { dispatched: true, decision: { kind: "cancelled" }, decisionId: "d", auditId: "a" };
    throw new actual.NativeCancellationPendingRecoveryError();
  }) };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// Keep reason: RFL ruling "Resume always works at once" (tB2). A Resume while
// 'pausing' cancels the pause; the stuck run keeps its own bounded cancel.
const support = await getEmbeddedPostgresTestSupport();
const PROVIDER_METHODS = ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease",
  "environmentDestroyLease", "environmentStopLease"];

class Timeout extends Error {}
async function within<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout(`${label} did not finish within ${ms} ms`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

describe.skipIf(!support.supported)("Resume while a pause waits on a run hung in provider setup (tB2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pause-resume-setup-hang-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID(), userId = `board-${companyId.slice(0, 8)}`;
    const pluginKey = `paperclip.pause-resume-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Fake Boat", description: "Test provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-boat", kind: "sandbox_provider", displayName: "Fake Boat",
          configSchema: { type: "object" } }] } } as never);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Pause resume",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false,
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
    // Still in setup: running, no native session, no process, no finish.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running",
      runtimeMode: "native", runtimeModeResolvedAt: startedAt, issueId, nativeIssueId: issueId, startedAt,
      contextSnapshot: { issueId }, resultJson: {} });
    await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: runId, issueId,
      status: "active", leasePolicy: "ephemeral", provider: "fake-boat", providerLeaseId: `setup-box-${randomUUID()}`,
      metadata: { ...config, agentId, driver: "sandbox", pluginId, pluginKey, sandboxProviderPlugin: true,
        remoteCwd: "/workspace", sandboxState: "started" } });
    // The provider's acquire/pack and destroy calls never return (Boat blocked).
    const call = vi.fn(() => new Promise(() => {}));
    const manager = { isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: PROVIDER_METHODS })), call } as unknown as PluginWorkerManager;
    return { companyId, agentId, issueId, runId, userId, manager };
  }

  const agentRow = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const due = (id: string) => db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` })
    .where(eq(agents.id, id));
  /** One server process's lifecycle worker. */
  function lifecycleWorker(manager: PluginWorkerManager) {
    const worker = configureAgentLifecycle(db, createLifecycleDriver(db, manager));
    return { process: (id: string) => worker.process(id), stop: () => within(worker.stop(), 2_000, "worker stop").catch(() => {}) };
  }
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

  it("S2: run hung in provider setup, Pause then Resume: 'ready' within seconds; the old pause never re-applies", async () => {
    const f = await seed();
    // Two server processes. The last configured one takes the in-process schedule of
    // Pause and Resume, so `pausing` runs the pause step and `other` claims next.
    const other = lifecycleWorker(f.manager), pausing = lifecycleWorker(f.manager);
    let oldPause: Promise<void> | undefined;
    try {
      const lifecycle = createAgentLifecycle(db);
      await lifecycle.pauseAgent(f.agentId);
      const paused = await agentRow(f.agentId);
      expect(paused.lifecycleState).toBe("pausing");
      // The pause step is in flight, blocked on the hung run's cancel.
      oldPause = pausing.process(f.agentId);
      const deadline = Date.now() + 5_000;
      while (cancelGate.calls === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(cancelGate.calls).toBe(1);
      const resumedAt = Date.now();
      await lifecycle.resumeAgent(f.agentId);
      const resumed = await agentRow(f.agentId);
      expect(resumed.lifecycleState).toBe("resuming");
      expect(resumed.lifecycleOperation?.id).not.toBe(paused.lifecycleOperation?.id);
      const row = await until(other, f.agentId, "ready", 5_000);
      expect(row).toMatchObject({ lifecycleState: "ready", lifecycleHolds: [], pauseReason: null });
      expect(Date.now() - resumedAt).toBeLessThan(5_000);
      // The hung run settles later on its own; the old pause step then returns.
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      cancelGate.release();
      await within(oldPause, 5_000, "old pause step");
      await due(f.agentId); await within(pausing.process(f.agentId), 5_000, "later sweep");
      const after = await agentRow(f.agentId);
      expect(after).toMatchObject({ lifecycleState: "ready", lifecycleHolds: [], lifecycleVersion: row.lifecycleVersion });
    } finally { cancelGate.release(); await pausing.stop(); await other.stop(); }
  }, 30_000);

  /** A person's message: the comment row plus the comment route's wakeup (routes/issues.ts issue_commented). */
  async function personMessage(heartbeat: ReturnType<typeof heartbeatService>, f: Awaited<ReturnType<typeof seed>>,
    issueId: string, body: string) {
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId, authorType: "user",
      authorUserId: f.userId, body }).returning();
    await within(heartbeat.wakeup(f.agentId, { source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId, commentId: comment!.id, mutation: "comment" },
      requestedByActorType: "user", requestedByActorId: f.userId,
      contextSnapshot: { issueId, taskId: issueId, commentId: comment!.id, wakeCommentId: comment!.id,
        source: "issue.comment", wakeReason: "issue_commented" } }), 10_000, "message wakeup");
    const [wakeup] = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.agentId} = ${f.agentId} and ${agentWakeupRequests.payload}->>'commentId' = ${comment!.id}`);
    return wakeup!;
  }

  it("S3: Pause (blocked in its cancel), Resume, a message, then the old cancel RETURNS: the message's wakeup is not cancelled", async () => {
    cancelGate.arm(true);
    const f = await seed();
    const heartbeat = heartbeatService(db);
    // The message's task is busy with a colleague's run, so its wakeup waits
    // unclaimed (deferred) and the hung run's own cancel cannot promote it.
    const colleagueId = randomUUID(), busyIssueId = randomUUID(), colleagueRunId = randomUUID();
    await db.insert(agents).values({ id: colleagueId, companyId: f.companyId, name: "Colleague", role: "engineer",
      status: "running", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: busyIssueId, companyId: f.companyId, title: "Busy task", status: "in_progress",
      priority: "medium", assigneeAgentId: f.agentId });
    await db.insert(heartbeatRuns).values({ id: colleagueRunId, companyId: f.companyId, agentId: colleagueId,
      invocationSource: "on_demand", status: "running", runtimeMode: "native", runtimeModeResolvedAt: new Date(), issueId: busyIssueId,
      nativeIssueId: busyIssueId, startedAt: new Date(), contextSnapshot: { issueId: busyIssueId } });
    await db.update(issues).set({ executionRunId: colleagueRunId }).where(eq(issues.id, busyIssueId));
    const other = lifecycleWorker(f.manager), pausing = lifecycleWorker(f.manager);
    let oldPause: Promise<void> | undefined;
    try {
      const lifecycle = createAgentLifecycle(db);
      await lifecycle.pauseAgent(f.agentId);
      oldPause = pausing.process(f.agentId);
      const deadline = Date.now() + 5_000;
      while (cancelGate.calls === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(cancelGate.calls).toBe(1);
      await lifecycle.resumeAgent(f.agentId);
      const ready = await until(other, f.agentId, "ready", 5_000);
      expect(ready.lifecycleState).toBe("ready");
      const queued = await personMessage(heartbeat, f, busyIssueId, "Are you back?");
      expect(queued.status).toBe("deferred_issue_execution");
      expect(queued.runId).toBeNull();
      // The old pause's cancel now returns normally (not "stop still pending").
      cancelGate.release();
      await within(oldPause, 10_000, "old pause step");
      const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queued.id));
      expect(wakeup!.status).not.toBe("cancelled");
      expect(await agentRow(f.agentId)).toMatchObject({ lifecycleState: "ready", lifecycleVersion: ready.lifecycleVersion });
      // It still waits, unclaimed, for its task to free up: deliverable, not dropped.
      expect(wakeup).toMatchObject({ status: "deferred_issue_execution", runId: null, error: null, finishedAt: null });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, queued.id))).toHaveLength(0);
    } finally { cancelGate.release(); await pausing.stop(); await other.stop(); }
  }, 40_000);

  it("Stop control: a person's Stop (no pause operation) cancels the same queued wakeups as at tB2", async () => {
    const f = await seed();
    const heartbeat = heartbeatService(db);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const base = { companyId: f.companyId, agentId: f.agentId, source: "on_demand", reason: "issue_commented" } as const;
    const rows = await db.insert(agentWakeupRequests).values([
      { ...base, status: "queued" },
      { ...base, status: "deferred_issue_execution", payload: { issueId: f.issueId } },
      { ...base, status: "deferred_issue_execution", payload: { issueId: f.issueId, executionWait: { trigger: "pause_lifted" } } },
      { ...base, status: "queued", runId: f.runId },
      { ...base, status: "completed" },
    ] as never).returning();
    const result = await heartbeat.cancelInvocationsForAgents([f.agentId], "Stopped by a person");
    expect(result).toMatchObject({ wakeupsCancelled: 3 });
    expect("pauseSuperseded" in result).toBe(false);
    const after = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, rows.map(row => row.id)));
    const status = new Map(after.map(row => [row.id, row.status]));
    expect(rows.map(row => status.get(row.id))).toEqual(["cancelled", "cancelled", "cancelled", "queued", "completed"]);
  }, 30_000);
});
