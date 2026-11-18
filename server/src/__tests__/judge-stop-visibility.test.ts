import { randomUUID } from "node:crypto";
import { agents, companies, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { startAgentLifecycle } from "../modules/agent-lifecycle/index.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";

describe("judge: pre-existing operator stop parks must be visible", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-judge-visible-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  it.each(["pausing", "terminating", "cleaning_up"] as const)("does not leave an operator-parked %s row with no error and no retry surface", async phase => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Judge stop visibility", issuePrefix: `J${companyId.slice(0,7)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Previously parked stop", status: phase === "pausing" ? "paused" : "terminated",
      lifecycleState: phase, lifecycleHolds: ["manual"], lifecycleRequiredPluginIds: [], lifecycleError: null,
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 25, retryRequired: true } }).returning();
    const runHost = vi.fn(async () => "pending" as const);
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), { requiredPluginIds: async () => [], runHost, runPlugin: async () => "complete" }, () => true);
    try {
      await restarted.sweep();
      const store = createLifecycleStore(db, createAgentLifecycleEffects());
      const view = await createAgentLifecycle(db).get(agent.id);
      const claim = await store.claim(agent.id, "tomorrow", new Date(Date.now() + 86_400_000));
      console.log("JUDGE_SILENT_PARK", JSON.stringify({ phase, hasPending: await restarted.hasPending(), nextRunAt: restarted.nextRunAt(),
        claim: claim?.id ?? null, hostCalls: runHost.mock.calls.length, visibleError: view?.lifecycleError ?? null }));
      expect(runHost).not.toHaveBeenCalled();
      expect(claim).toBeNull();
      expect(view?.lifecycleError, "The existing error/Retry UI is only rendered for a nonempty lifecycleError").toEqual(expect.any(String));
    } finally {
      await restarted.stop();
      await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.id, agent.id));
    }
  });
});
