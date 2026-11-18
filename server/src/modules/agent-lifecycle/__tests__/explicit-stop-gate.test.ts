import { randomUUID } from "node:crypto";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../../../services/agent-lifecycle.js";
import { createLifecycleStore } from "../adapters/postgres.js";
import { createLifecycleWorker } from "../application/worker.js";
import { startAgentLifecycle } from "../index.js";

// Keep reason: 3548b8e6/165038d0 incident; an explicit Stop must fence allocation,
// without fencing existing hires whose legacy status is also paused.
describe("explicit lifecycle startup stop admission", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, companyId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-explicit-stop-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Explicit stop", issuePrefix: `G${companyId.slice(0, 7)}` });
  });
  afterEach(async () => {
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  async function fixture(lifecycleState: "preparing" | "verifying" | "resuming" | "pausing" | "terminating" | "cleaning_up", patch: Partial<typeof agents.$inferInsert> = {}) {
    const [agent] = await db.insert(agents).values({ companyId, name: "Existing row", status: "paused", lifecycleState,
      lifecycleRequiredPluginIds: [], lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 }, ...patch }).returning();
    return agent;
  }
  it.each(["manual", "budget", "company_paused", "company_archived"])("fences all startup phases carrying an explicit %s marker in any recorded location", async hold => {
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const runHost = vi.fn(async () => "pending" as const);
    const worker = createLifecycleWorker(store, { requiredPluginIds: async () => [], runHost, runPlugin: async () => "complete" }, () => {});
    try {
      for (const phase of ["preparing", "verifying", "resuming"] as const) {
        for (const patch of [
          { pauseReason: hold }, { lifecycleHolds: [hold] },
          { lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0,
            pauseCause: { holds: [hold], companyPauseReason: null } } },
        ]) {
          const agent = await fixture(phase, patch);
          expect(await store.pending(100, new Date())).not.toContain(agent.id);
          expect(await store.claim(agent.id, "blocked", new Date())).toBeNull();
          await worker.process(agent.id);
          expect((await current(agent.id)).lifecycleOperation?.attempts).toBe(0);
        }
      }
      await worker.sweep();
      expect(runHost).not.toHaveBeenCalled();
    } finally { await worker.stop(); }
  });
  it.each([null, "setup"])("still claims legacy paused startup rows with pauseReason=%s and no stop hold", async pauseReason => {
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    for (const phase of ["preparing", "verifying", "resuming"] as const) {
      const agent = await fixture(phase, { pauseReason });
      expect(await store.pending(100, new Date())).toContain(agent.id);
      expect(await store.claim(agent.id, "legacy-startup", new Date())).not.toBeNull();
      expect((await current(agent.id)).status).toBe("paused");
    }
    // The wizard's separate, pre-existing setup hold must still wait for completion.
    const draft = await fixture("verifying", { pauseReason: "setup", lifecycleHolds: ["setup"] });
    expect(await store.claim(draft.id, "wizard-wait", new Date())).toBeNull();
  });
  it("does not recover saved verification waits across an explicit Stop", async () => {
    const agent = await fixture("verifying", { lifecycleOperation: { id: randomUUID(), hostComplete: false,
      completedPluginIds: [], attempts: 0, waitingForSignal: true, pauseCause: { holds: ["manual"], companyPauseReason: null } } });
    const runHost = vi.fn(async () => "complete" as const);
    const work = startAgentLifecycle(db, createAgentLifecycleEffects(), { requiredPluginIds: async () => [], runHost,
      runPlugin: async () => "complete" }, () => true);
    try {
      expect(await work.hasPending()).toBe(false);
      await work.sweep();
      expect(runHost).not.toHaveBeenCalled();
      expect((await current(agent.id)).lifecycleOperation).toMatchObject({ waitingForSignal: true, attempts: 0 });
    } finally { await work.stop(); }
  });
  it.each(["pausing", "terminating", "cleaning_up"] as const)("still runs %s despite every explicit Stop marker", async phase => {
    const agent = await fixture(phase, { pauseReason: "manual", lifecycleHolds: ["manual", "budget"], lifecycleOperation: {
      id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, pauseCause: { holds: ["manual"], companyPauseReason: null } } });
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    expect(await store.pending(100, new Date())).toContain(agent.id);
    expect(await store.claim(agent.id, "stop", new Date())).not.toBeNull();
  });
  it("records the board pause markers, completes Stop, then resumes with the unchanged legacy representation", async () => {
    const lifecycle = createAgentLifecycle(db);
    const hired = await lifecycle.requestHire(companyId, { name: "Normal hire", adapterType: "process" });
    expect(await current(hired.id)).toMatchObject({ status: "paused", lifecycleState: "preparing" });
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const worker = createLifecycleWorker(store, { requiredPluginIds: async () => [], runHost: async () => "complete",
      runPlugin: async () => "complete" }, () => {});
    try {
      await worker.process(hired.id);
      expect(await current(hired.id)).toMatchObject({ status: "idle", lifecycleState: "ready" });
      await lifecycle.pauseAgent(hired.id);
      expect(await current(hired.id)).toMatchObject({ status: "paused", lifecycleState: "pausing", pauseReason: "manual",
        lifecycleHolds: ["manual"], lifecycleOperation: { pauseCause: { holds: ["manual"], companyPauseReason: null } } });
      await worker.process(hired.id);
      expect((await current(hired.id)).lifecycleState).toBe("paused");
      await lifecycle.resumeAgent(hired.id);
      expect(await current(hired.id)).toMatchObject({ status: "paused", lifecycleState: "resuming", pauseReason: null, lifecycleHolds: [] });
      expect(await store.pending(100, new Date())).toContain(hired.id);
      await worker.process(hired.id);
      expect(await current(hired.id)).toMatchObject({ status: "idle", lifecycleState: "ready" });
    } finally { await worker.stop(); }
  });
});
