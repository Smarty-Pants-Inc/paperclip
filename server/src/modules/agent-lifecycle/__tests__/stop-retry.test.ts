import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../../../services/agent-lifecycle-driver.js";
import { createLifecycleStore, surfaceAgentLifecycleStopParkInTransaction } from "../adapters/postgres.js";
import { createLifecycleWorker } from "../application/worker.js";
import { startAgentLifecycle } from "../index.js";

// Keep reason: the reported production pausing row kept being claimed even
// after an operator set retryRequired. Exercise the saved journal and worker.
describe("bounded lifecycle Stop recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, companyId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stop-retry-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stop retry", issuePrefix: `S${companyId.slice(0, 7)}` });
  });
  afterEach(async () => {
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  async function fixture(lifecycleState: "pausing" | "terminating" | "cleaning_up", operation = {}) {
    const [agent] = await db.insert(agents).values({ companyId, name: "Pending Stop", status: lifecycleState === "pausing" ? "paused" : "terminated",
      lifecycleState, lifecycleHolds: ["manual"], lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, ...operation } }).returning();
    return agent;
  }
  const makeDriver = (runHost = vi.fn(async () => "pending" as "complete" | "pending")) => ({
    requiredPluginIds: async () => [], runHost, runPlugin: async () => "complete" as const,
  });
  const due = (id: string) => db.update(agents).set({ lifecycleOperation: sql`${agents.lifecycleOperation} - 'retryAt'` }).where(eq(agents.id, id));

  it.each(["pausing", "terminating", "cleaning_up"] as const)("backs off %s pending Stop then parks across restart until explicit Retry", async phase => {
    const agent = await fixture(phase);
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const driver = makeDriver();
    const worker = createLifecycleWorker(store, driver, () => {});
    let previousDelay = 0;
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const before = Date.now();
        await worker.process(agent.id);
        const row = await current(agent.id);
        expect(row.lifecycleOperation).toMatchObject({ attempts: attempt, stopFailures: attempt });
        if (attempt < 5) {
          const deadline = Date.parse(row.lifecycleOperation!.retryAt!);
          const delay = deadline - before;
          expect(delay).toBeGreaterThan(previousDelay);
          const expectedDelay = [60_000, 120_000, 240_000, 300_000][attempt - 1];
          expect(deadline).toBeGreaterThanOrEqual(before + expectedDelay);
          expect(deadline).toBeLessThanOrEqual(Date.now() + expectedDelay);
          previousDelay = delay;
          expect(await store.pending(100, new Date(deadline - 1))).not.toContain(agent.id);
          expect(await store.claim(agent.id, "too-early", new Date(deadline - 1))).toBeNull();
          expect(await store.pending(100, new Date(deadline))).toContain(agent.id);
          await worker.sweep(); await worker.process(agent.id);
          expect(driver.runHost).toHaveBeenCalledTimes(attempt);
          await due(agent.id);
        }
      }
      const parked = await current(agent.id);
      expect(parked.lifecycleState).toBe(phase);
      expect(parked.lifecycleOperation).toMatchObject({ retryRequired: true, attempts: 5 });
      expect(parked.lifecycleOperation).not.toHaveProperty("retryAt");
      expect(parked.lifecycleOperation).not.toHaveProperty("leaseOwner");
      expect(parked.lifecycleError).toContain("Automatic stop work is paused");
      expect(parked.lifecycleError).toContain(parked.lifecycleOperation!.id);
      expect(parked.lifecycleError).toContain("Retry");
      await worker.stop();
      const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), driver, () => true);
      try {
        expect(await restarted.hasPending()).toBe(false);
        expect(restarted.nextRunAt()).toBeNull();
        await restarted.sweep();
        const tomorrow = new Date(Date.now() + 86_400_000);
        expect(await store.pending(100, tomorrow)).not.toContain(agent.id);
        expect(await store.claim(agent.id, "tomorrow", tomorrow)).toBeNull();
        expect(driver.runHost).toHaveBeenCalledTimes(5);
        await createAgentLifecycle(db).retry(agent.id);
        const retried = await current(agent.id);
        expect(retried.lifecycleOperation).not.toHaveProperty("retryRequired");
        expect(retried.lifecycleOperation).not.toHaveProperty("stopFailures");
        expect(retried.lifecycleError).toBeNull();
        driver.runHost.mockResolvedValue("complete");
        await restarted.sweep();
        expect((await current(agent.id)).lifecycleState).toBe(phase === "pausing" ? "paused" : "terminated");
      } finally { await restarted.stop(); }
    } finally { await worker.stop(); }
  });
  it.each(["pausing", "terminating", "cleaning_up"] as const)("honors an operator's already-set retryRequired on %s", async phase => {
    const agent = await fixture(phase, { retryRequired: true });
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const driver = makeDriver();
    const worker = createLifecycleWorker(store, driver, () => {});
    try {
      expect(await store.pending(100, new Date())).not.toContain(agent.id);
      expect(await store.claim(agent.id, "operator-park", new Date())).toBeNull();
      await worker.process(agent.id);
      expect(driver.runHost).not.toHaveBeenCalled();
      expect((await current(agent.id)).lifecycleOperation?.attempts).toBe(0);
    } finally { await worker.stop(); }
  });
  it.each(["active", "paused", "archived"])("surfaces old parks without changing their ownership or Retry while company is %s", async status => {
    const parked = await Promise.all((["pausing", "terminating", "cleaning_up"] as const).map(phase => fixture(phase, {
      retryRequired: true, attempts: 25, hostComplete: false, completedPluginIds: ["already-done"],
    })));
    await db.update(companies).set({ status }).where(eq(companies.id, companyId));
    const driver = makeDriver();
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), driver, () => true);
    try {
      await restarted.sweep();
      expect(await restarted.hasPending()).toBe(false);
      expect(restarted.nextRunAt()).toBeNull();
      for (const agent of parked) {
        const row = await current(agent.id);
        expect(row.lifecycleOperation).toEqual(agent.lifecycleOperation);
        expect(row.lifecycleVersion).toBe(agent.lifecycleVersion);
        expect(row.lifecycleError).toContain(`Automatic stop work is paused in ${agent.lifecycleState}`);
        expect(row.lifecycleError).toContain(agent.lifecycleOperation!.id);
        expect(row.lifecycleError).toContain("use Retry");
      }
      expect(driver.runHost).not.toHaveBeenCalled();
      driver.runHost.mockResolvedValue("complete");
      // Use the existing action, not a recovery-only way of un-parking.
      for (const agent of parked) await createAgentLifecycle(db).retry(agent.id);
      await restarted.sweep();
      for (const agent of parked) {
        const row = await current(agent.id);
        expect(row.lifecycleError).toBeNull();
        expect(row.lifecycleOperation?.retryRequired).toBeUndefined();
        expect(row.lifecycleState).toBe(agent.lifecycleState === "pausing" ? "paused" : "terminated");
      }
    } finally { await restarted.stop(); }
  });
  it("bounds old-park visibility recovery to existing startup pages without invoking stop work", async () => {
    await db.insert(agents).values(Array.from({ length: 101 }, () => ({ companyId, name: "Old silent park", status: "paused", lifecycleState: "pausing" as const,
      lifecycleHolds: ["manual"], lifecycleRequiredPluginIds: [], lifecycleError: "  ",
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 25, retryRequired: true },
    })));
    const driver = makeDriver();
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), driver, () => true);
    try {
      await restarted.sweep();
      const first = await db.select().from(agents).where(eq(agents.companyId, companyId));
      expect(first.filter(row => row.lifecycleError?.includes("use Retry"))).toHaveLength(100);
      expect(await restarted.hasPending()).toBe(true);
      await restarted.sweep();
      const second = await db.select().from(agents).where(eq(agents.companyId, companyId));
      expect(second.every(row => row.lifecycleError?.includes("use Retry"))).toBe(true);
      expect(second.every(row => row.lifecycleOperation?.attempts === 25 && row.lifecycleOperation.retryRequired === true)).toBe(true);
      expect(await restarted.hasPending()).toBe(false);
      expect(restarted.nextRunAt()).toBeNull();
      expect(driver.runHost).not.toHaveBeenCalled();
    } finally { await restarted.stop(); }
  });
  it("does not overwrite a diagnostic, a raced Retry or a newer operation during visibility recovery", async () => {
    const effects = createAgentLifecycleEffects();
    const store = createLifecycleStore(db, effects);
    const repair = (agent: Awaited<ReturnType<typeof fixture>>) => effects.transaction(db, companyId, tx =>
      surfaceAgentLifecycleStopParkInTransaction(tx, { companyId, agentId: agent.id, expectedVersion: agent.lifecycleVersion }));
    const detailed = await fixture("pausing", { retryRequired: true });
    await db.update(agents).set({ lifecycleError: "Specific blocking invocation; use Retry." }).where(eq(agents.id, detailed.id));
    expect(await repair(detailed)).toBe(false);
    expect((await current(detailed.id)).lifecycleError).toBe("Specific blocking invocation; use Retry.");
    const retried = await fixture("pausing", { retryRequired: true });
    await store.change(retried.id, "retry");
    expect(await repair(retried)).toBe(false);
    expect((await current(retried.id)).lifecycleError).toBeNull();
    const changed = await fixture("pausing", { retryRequired: true });
    await store.change(changed.id, "terminate");
    expect(await repair(changed)).toBe(false);
    expect((await current(changed.id)).lifecycleError).toBeNull();
  });
  it("names the real blocking invocation in a parked Stop error, without treating cancellation as proof", async () => {
    const agent = await fixture("pausing");
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, status: "cancelled",
      invocationSource: "on_demand", runtimeMode: "legacy", executionStage: "dispatching",
      startedAt: new Date("2000-01-01T00:00:00Z"), finishedAt: new Date("2000-01-01T00:00:01Z"),
      runnerProfileJson: { adapterDispatch: { adapterType: "http" } }, resultJson: {} }).returning();
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const worker = createLifecycleWorker(store, { ...makeDriver(), runHost: createLifecycleDriver(db, {} as never).runHost }, () => {});
    try {
      for (let attempt = 0; attempt < 5; attempt++) { await due(agent.id); await worker.process(agent.id); }
      const row = await current(agent.id);
      expect(row.lifecycleState).toBe("pausing");
      expect(row.lifecycleOperation?.retryRequired).toBe(true);
      expect(row.lifecycleError).toContain(`invocation ${run.id}`);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].status).toBe("cancelled");
      expect(await store.claim(agent.id, "parked-real-stop", new Date(Date.now() + 86_400_000))).toBeNull();
      // The operator rechecks after a real stop acknowledgement arrives.
      await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "acknowledged" } } }).where(eq(heartbeatRuns.id, run.id));
      await store.change(agent.id, "retry");
      await worker.process(agent.id);
      expect((await current(agent.id)).lifecycleState).toBe("paused");
    } finally { await worker.stop(); }
  });
  it.each(["pausing", "terminating", "cleaning_up"] as const)("also bounds thrown %s Stop failures with secret-safe errors", async phase => {
    const agent = await fixture(phase);
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const runHost = vi.fn(async () => { throw new Error("private provider detail"); });
    const worker = createLifecycleWorker(store, { ...makeDriver(), runHost }, () => {});
    try {
      for (let attempt = 0; attempt < 5; attempt++) { await due(agent.id); await worker.process(agent.id); }
      const row = await current(agent.id);
      expect(row.lifecycleOperation?.retryRequired).toBe(true);
      expect(row.lifecycleError).toContain("Automatic stop work is paused");
      expect(row.lifecycleError).not.toContain("private provider detail");
      expect(await store.claim(agent.id, "parked-error", new Date(Date.now() + 86_400_000))).toBeNull();
    } finally { await worker.stop(); }
  });
  it("bounds a required cleanup plugin without replaying a completed host stop", async () => {
    const agent = await fixture("cleaning_up");
    await db.update(agents).set({ lifecycleRequiredPluginIds: ["cleanup-plugin"] }).where(eq(agents.id, agent.id));
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const runHost = vi.fn(async () => "complete" as const);
    const runPlugin = vi.fn(async () => "pending" as const);
    const worker = createLifecycleWorker(store, { requiredPluginIds: async () => [], runHost, runPlugin }, () => {});
    try {
      for (let attempt = 0; attempt < 5; attempt++) { await due(agent.id); await worker.process(agent.id); }
      expect(runHost).toHaveBeenCalledOnce();
      expect(runPlugin).toHaveBeenCalledTimes(5);
      const row = await current(agent.id);
      expect(row.lifecycleOperation).toMatchObject({ hostComplete: true, retryRequired: true });
      expect(row.lifecycleError).toContain("cleanup-plugin");
      expect(await store.claim(agent.id, "parked-plugin", new Date(Date.now() + 86_400_000))).toBeNull();
    } finally { await worker.stop(); }
  });
  it("does not spend a Stop budget when work is deferred before any external step", async () => {
    const agent = await fixture("pausing");
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    let allowed = true;
    const driver = makeDriver();
    const worker = createLifecycleWorker({ ...store, async claim(...args) {
      const claimed = await store.claim(...args); allowed = false; return claimed;
    } }, driver, () => {}, () => allowed);
    try {
      for (let claim = 0; claim < 6; claim++) { allowed = true; await due(agent.id); await worker.process(agent.id); }
      expect(driver.runHost).not.toHaveBeenCalled();
      expect((await current(agent.id)).lifecycleOperation).not.toHaveProperty("stopFailures");
      expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
    } finally { await worker.stop(); }
  });
  it("fences an old Stop result after operator Retry and after a newer lifecycle operation", async () => {
    const agent = await fixture("pausing");
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const first = await store.claim(agent.id, "old-owner", new Date());
    expect(first).not.toBeNull();
    await store.change(agent.id, "retry");
    await store.defer(first!, "old-owner", "Old pending stop", new Date(), { retryRequired: true });
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
    await due(agent.id);
    const second = await store.claim(agent.id, "old-phase", new Date());
    expect(second).not.toBeNull();
    await store.change(agent.id, "terminate");
    expect(await store.defer(second!, "old-phase", "Old pause", new Date(), { retryRequired: true })).toBe(false);
    expect((await current(agent.id)).lifecycleOperation?.retryRequired).toBeUndefined();
  });
});
