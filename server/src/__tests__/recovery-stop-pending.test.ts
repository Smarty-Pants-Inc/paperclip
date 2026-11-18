import { randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// Keep the stale-candidate ownership guard; the removed Stop-pending policy
// must not make an old sweep observation authoritative over a newer claim.
describe("stale task claim ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-stale-task-claim-");
    db = createDb(database.connectionString, { maxConnections: 4 });
    db.$client.options.onnotice = () => {};
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  it("never annotates a new claim using a stale sweep candidate", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stale task claim", issuePrefix: `ST${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Old owner", adapterType: "http",
      status: "active", lifecycleState: "ready", lifecycleHolds: [], lifecycleRequiredPluginIds: [] });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "cancelled",
      runtimeMode: "legacy", executionStage: "dispatching", startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(),
      runnerProfileJson: { adapterDispatch: { adapterType: "http" } }, resultJson: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stale task claim", status: "in_progress",
      checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date() });
    const newerRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: newerRun, companyId, agentId,
      status: "running", invocationSource: "manual", startedAt: new Date() });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(), beforeStaleLockClear: async () => {
      await db.update(issues).set({ checkoutRunId: newerRun, executionRunId: newerRun }).where(eq(issues.id, issueId));
    } });
    expect((await recovery.sweepStaleIssueLocks()).cleared).toBe(0);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0])
      .toMatchObject({ checkoutRunId: newerRun, executionRunId: newerRun });
  });
});
