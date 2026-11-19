import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));
// The run is hung in provider setup: no native session exists yet. The real
// cancelNativeSession waits for the startup (native-session-executor.ts:512-529)
// and then rejects with NativeCancellationPendingRecoveryError (:10996-10998).
// The first cancel here hangs until the test lets it reach that outcome; later
// cancels reach it at once. The startup itself never returns.
const cancelGate = vi.hoisted(() => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  return { calls: 0, released, release };
});
vi.mock("../services/native-runtime/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/index.js")>();
  return { ...actual, cancelNativeSession: vi.fn(async () => {
    if (cancelGate.calls++ === 0) await cancelGate.released;
    throw new actual.NativeCancellationPendingRecoveryError();
  }) };
});

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
    return { agentId, runId, manager };
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
});
