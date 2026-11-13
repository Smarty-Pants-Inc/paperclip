import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, sandboxCreationOperations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createOwnedSandbox, recoverSandboxCreations, recordSandboxCreationResource, queueSandboxCreationCleanup, type SandboxCreationOperation } from "../services/sandbox-creation-operations.js";
import { ENVIRONMENT_CLEANUP_RETRY_MS, nextEnvironmentCleanupAt } from "../services/environment-cleanup-state.js";

// Keep reason: Image B-s4 905542b5 left 375 intents from refused allocations.
// Exercise the actual creation journal and recovery with PostgreSQL; only the
// external provider is controlled. No provider allocation or credentials needed.
describe("bounded absent sandbox creation recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, companyId: string, environmentId: string, runId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-creation-bound-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(async () => {
    await db.execute(sql`truncate sandbox_creation_operations, companies, environments cascade`);
    companyId = randomUUID(); environmentId = randomUUID(); runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Creation budget", issuePrefix: "CB" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Creation owner" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, status: "running", invocationSource: "manual" });
    await db.insert(environments).values({ id: environmentId, name: "Creation fixture", driver: "plugin", config: {} });
  });
  const current = async () => (await db.select().from(sandboxCreationOperations))[0]!;
  async function intent(kind: "task" | "login" | "sandbox" = "task", heartbeatRunId: string | null = runId) {
    await expect(createOwnedSandbox(db, { companyId, environmentId, heartbeatRunId, provider: "plugin:fixture", driverKey: "fixture", config: {},
      metadata: kind === "login" ? { driver: "plugin", purpose: "login" } : kind === "sandbox" ? { sandboxProviderPlugin: true }
        : { driver: "plugin", runnerTaskLease: true, creationOperationVersion: 1, runnerTaskCreationContextId: randomUUID(), providerMetadata: {} },
    }, async () => { throw new Error("Provider refused allocation (429)"); })).rejects.toThrow("429");
    await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0),
      metadata: sql`${sandboxCreationOperations.metadata} || '{"creationSettleAt":"2000-01-01T00:00:00Z"}'::jsonb` });
    return current();
  }
  const absent = (operation: SandboxCreationOperation) => Promise.resolve({ providerLeaseId: operation.id, state: "destroyed" as const });
  async function due() { await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0) }); }
  it.each(["task", "login", "sandbox"] as const)("settles %s only after three confirmed absences past its settle deadline", async kind => {
    await intent(kind);
    const inspect = vi.fn(absent);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = Date.now();
      await recoverSandboxCreations(db, inspect);
      const row = await current();
      expect(row.metadata.creationRecoveryAttempts).toBe(attempt);
      expect(row.state).toBe(attempt === 3 ? "resolved" : "pending");
      if (attempt < 3) {
        expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + ENVIRONMENT_CLEANUP_RETRY_MS);
        await recoverSandboxCreations(db, inspect);
        expect(inspect).toHaveBeenCalledTimes(attempt);
        await due();
      }
    }
    expect((await current()).metadata.creationReconciliationReason).toBe("provider_absent_after_bounded_recovery");
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
    await recoverSandboxCreations(db, inspect);
    expect(inspect).toHaveBeenCalledTimes(3);
    expect(await db.select().from(environmentLeases)).toHaveLength(0);
  });
  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted", "missing"])("settles an absent allocation owned by a %s run after one inspect", async status => {
    if (status === "missing") runId = randomUUID();
    else await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, runId));
    await intent();
    await recoverSandboxCreations(db, absent);
    expect(await current()).toMatchObject({ state: "resolved", metadata: {
      creationRecoveryAttempts: 1, creationReconciliationReason: "provider_absent_after_bounded_recovery",
    } });
  });
  it("does not confuse a same-id run from another company with a live owner", async () => {
    const otherCompany = randomUUID();
    await db.insert(companies).values({ id: otherCompany, name: "Other", issuePrefix: "OTHER" });
    const [agent] = await db.insert(agents).values({ companyId: otherCompany, name: "Other owner" }).returning();
    await db.update(heartbeatRuns).set({ companyId: otherCompany, agentId: agent.id }).where(eq(heartbeatRuns.id, runId));
    await intent(); await recoverSandboxCreations(db, absent);
    expect((await current()).state).toBe("resolved");
  });
  it("does not treat a synthetic agentless correlation id as a missing heartbeat owner", async () => {
    await intent("task", null);
    await recoverSandboxCreations(db, absent);
    expect(await current()).toMatchObject({ state: "pending", metadata: { creationRecoveryAttempts: 1 } });
  });
  it.each(["running", "queued"])("never uses the dead-owner shortcut for a %s run", async status => {
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, runId));
    await intent(); await recoverSandboxCreations(db, absent);
    expect(await current()).toMatchObject({ state: "pending", metadata: { creationRecoveryAttempts: 1 } });
  });
  it("does not count early absence or settle a terminal owner's intent before materialization ends", async () => {
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    await intent();
    const settleAt = new Date(Date.now() + 30 * 60_000).toISOString();
    await db.update(sandboxCreationOperations).set({ metadata: sql`${sandboxCreationOperations.metadata} || ${JSON.stringify({ creationSettleAt: settleAt })}::jsonb` });
    await recoverSandboxCreations(db, absent);
    expect((await current()).state).toBe("pending");
    expect((await current()).metadata.creationRecoveryAttempts ?? 0).toBe(0);
    expect((await current()).nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
  it.each(["throw", "null", "unknown", "foreign absence"] as const)("never spends absence budget on %s inspection, even for a terminal run", async mode => {
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
    await intent();
    const inspect = vi.fn(async (operation: SandboxCreationOperation) => {
      if (mode === "throw") throw new Error("Provider unavailable");
      if (mode === "null") return null;
      return { providerLeaseId: mode === "foreign absence" ? randomUUID() : operation.id,
        state: mode === "unknown" ? "unknown" as const : "destroyed" as const };
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await recoverSandboxCreations(db, inspect);
      expect((await current()).state).toBe("pending");
      expect((await current()).metadata.creationRecoveryAttempts ?? 0).toBe(0);
      expect((await current()).nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      await due();
    }
    await recoverSandboxCreations(db, absent);
    expect((await current()).state).toBe("resolved");
  });
  it("does not count an unavailable lookup among confirmed absences", async () => {
    await intent();
    await recoverSandboxCreations(db, absent); await due();
    await recoverSandboxCreations(db, async () => { throw new Error("Provider offline"); });
    expect(await current()).toMatchObject({ state: "pending", metadata: { creationRecoveryAttempts: 1 } });
    await due(); await recoverSandboxCreations(db, absent);
    expect(await current()).toMatchObject({ state: "pending", metadata: { creationRecoveryAttempts: 2 } });
  });
  it("recovers a recorded late resource after restart before its caller could queue cleanup", async () => {
    const operation = await intent();
    for (let attempt = 0; attempt < 3; attempt++) { await due(); await recoverSandboxCreations(db, absent); }
    const resource = { id: operation.id, companyId, environmentId, providerLeaseId: "late-before-restart" };
    await recordSandboxCreationResource(db, resource);
    expect(await current()).toMatchObject({ state: "pending", leaseId: null });
    expect((await current()).nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await nextEnvironmentCleanupAt(db)).not.toBeNull();
    const inspect = vi.fn(absent);
    await recoverSandboxCreations(db, inspect);
    expect(inspect).not.toHaveBeenCalled();
    const row = await current();
    expect(row.state).toBe("cleanup_pending");
    expect(await db.select().from(environmentLeases)).toEqual([expect.objectContaining({
      id: row.leaseId, providerLeaseId: resource.providerLeaseId, status: "pending_cleanup",
    })]);
  });
  it("serializes concurrent late cleanup transfers and never reopens completed cleanup", async () => {
    const operation = await intent();
    for (let attempt = 0; attempt < 3; attempt++) { await due(); await recoverSandboxCreations(db, absent); }
    const resource = { id: operation.id, companyId, environmentId, providerLeaseId: "one-late-resource" };
    await Promise.all(Array.from({ length: 4 }, () => queueSandboxCreationCleanup(db, resource)));
    const row = await current();
    expect(row.state).toBe("cleanup_pending");
    expect(await db.select().from(environmentLeases)).toEqual([expect.objectContaining({
      id: row.leaseId, providerLeaseId: resource.providerLeaseId, status: "pending_cleanup",
    })]);
    // Completed cleanup, unlike absence, already has a durable lease owner.
    await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, row.leaseId!));
    await db.update(sandboxCreationOperations).set({ state: "resolved" });
    await recordSandboxCreationResource(db, resource);
    await queueSandboxCreationCleanup(db, resource);
    expect(await current()).toMatchObject({ state: "resolved", leaseId: row.leaseId });
    expect(await db.select().from(environmentLeases)).toHaveLength(1);
    expect(await nextEnvironmentCleanupAt(db)).toBeNull();
    await expect(recordSandboxCreationResource(db, { ...resource, providerLeaseId: "foreign-resource" })).rejects.toThrow("identity changed");
  });
  it("still transfers a discovered allocation to cleanup even after earlier absence", async () => {
    await intent(); await recoverSandboxCreations(db, absent); await due();
    const onRecovered = vi.fn();
    await recoverSandboxCreations(db, async () => ({ providerLeaseId: "actual-resource", state: "active",
      creationLease: { providerLeaseId: "actual-resource", metadata: { exactReceipt: true } } }), onRecovered);
    expect((await current()).state).toBe("cleanup_pending");
    expect(await db.select().from(environmentLeases)).toEqual([expect.objectContaining({ providerLeaseId: "actual-resource", status: "pending_cleanup" })]);
    expect(onRecovered).toHaveBeenCalledOnce();
  });
});
