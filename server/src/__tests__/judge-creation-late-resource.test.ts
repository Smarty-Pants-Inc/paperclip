import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createOwnedSandbox, recoverSandboxCreations, recordSandboxCreationResource, queueSandboxCreationCleanup, type SandboxCreationOperation } from "../services/sandbox-creation-operations.js";
import { nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";

// Independent judge checks. Real PostgreSQL and production journal/transfer code;
// only provider observation and wall-clock deadline are controlled. No live box,
// credential or production write. Required invariant: a positively found resource
// always retains cleanup ownership, including a late reply racing final absence.
describe("judge: absence cannot erase positive creation ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, companyId: string, environmentId: string, runId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-judge-creation-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate sandbox_creation_operations, companies, environments cascade`);
    companyId = randomUUID(); environmentId = randomUUID(); runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Judge creation safety", issuePrefix: "JUDGE" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Creation owner" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, status: "running", invocationSource: "manual" });
    await db.insert(environments).values({ id: environmentId, name: "Creation fixture", driver: "plugin", config: {} });
    await expect(createOwnedSandbox(db, { companyId, environmentId, heartbeatRunId: runId, provider: "plugin:fixture", driverKey: "fixture", config: {},
      metadata: { driver: "plugin", runnerTaskLease: true, creationOperationVersion: 1, runnerTaskCreationContextId: randomUUID(), providerMetadata: {} },
    }, async () => { throw new Error("Provider reply lost; request may still materialize"); })).rejects.toThrow("reply lost");
    await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0),
      metadata: sql`${sandboxCreationOperations.metadata} || '{"creationSettleAt":"2000-01-01T00:00:00Z"}'::jsonb` });
  });
  const current = async () => (await db.select().from(sandboxCreationOperations))[0]!;
  const due = () => db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0) });
  const absent = async (operation: SandboxCreationOperation) => ({ providerLeaseId: operation.id, state: "destroyed" as const });

  it("keeps cleanup ownership when a concurrent lookup finds a live resource after the last absence lookup", async () => {
    await recoverSandboxCreations(db, absent); await due();
    await recoverSandboxCreations(db, absent); await due();
    let inspected!: () => void, release!: () => void;
    const hasInspected = new Promise<void>(resolve => { inspected = resolve; });
    const releaseReply = new Promise<void>(resolve => { release = resolve; });
    const found = recoverSandboxCreations(db, async () => {
      inspected();
      await releaseReply;
      return { providerLeaseId: "real-box", state: "active" as const,
        creationLease: { providerLeaseId: "real-box", metadata: { confirmedLive: true } } };
    });
    await hasInspected;
    try { await recoverSandboxCreations(db, absent); }
    finally { release(); await found; }
    const row = await current();
    const leases = await db.select().from(environmentLeases);
    console.log("JUDGE_FOUND_AFTER_ABSENCE", JSON.stringify({ state: row.state, knownResource: row.metadata.creationProviderLeaseId,
      absenceCount: row.metadata.creationRecoveryAttempts ?? 0, cleanupLeases: leases.length, nextCleanup: await nextEnvironmentCleanupAt(db) }));
    expect(row.state, "A positive resource observation must retain cleanup ownership, even after a final absence races it").toBe("cleanup_pending");
    expect(leases).toEqual([expect.objectContaining({ providerLeaseId: "real-box", status: "pending_cleanup" })]);
    expect(await nextEnvironmentCleanupAt(db)).not.toBeNull();
  });

  it("queues a late successful creation reply even after the absence counter reached its bound", async () => {
    for (let attempt = 0; attempt < 3; attempt++) { await due(); await recoverSandboxCreations(db, absent); }
    const operation = await current();
    // Same late-result sequence used by environment-task-runtime.ts:339–342.
    const resource = { id: operation.id, companyId, environmentId, providerLeaseId: "late-real-box", providerMetadata: { confirmedLive: true } };
    await recordSandboxCreationResource(db, resource);
    await queueSandboxCreationCleanup(db, resource);
    const row = await current();
    const leases = await db.select().from(environmentLeases);
    console.log("JUDGE_LATE_CREATE_REPLY", JSON.stringify({ state: row.state, knownResource: row.metadata.creationProviderLeaseId,
      absenceCount: row.metadata.creationRecoveryAttempts ?? 0, cleanupLeases: leases.length, nextCleanup: await nextEnvironmentCleanupAt(db) }));
    expect(row.state, "An exact late provider resource ID must reopen/transfer cleanup, not leave a resolved row").toBe("cleanup_pending");
    expect(leases).toEqual([expect.objectContaining({ providerLeaseId: "late-real-box", status: "pending_cleanup" })]);
  });
});
