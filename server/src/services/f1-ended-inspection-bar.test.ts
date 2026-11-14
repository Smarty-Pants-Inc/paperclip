import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, environmentLeases, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { freshThreadStopGate, inspectFreshThreadStopResources, readFreshThreadStopProof, FRESH_THREAD_STOPPING_NOTE, FRESH_THREAD_STOP_UNAVAILABLE_NOTE } from "./native-runtime/fresh-thread-stop-gate.js";
import { readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";

// Keep: F1-1 target E, a data-safety/trust boundary. Use the real persisted
// lease, proof owner and cleanup sweep; fake only external provider transport.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("F1 ended inspection binding bar", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("f1-ended-inspection-bar"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const now = Date.now(), userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const [company] = await db.insert(companies).values({ name: "Ended source evidence", issuePrefix: `E${randomUUID().slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: userId }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Owner", role: "engineer", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Saved follow-up", status: "in_progress", assigneeAgentId: agent.id, responsibleUserId: userId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, nativeIssueId: issue.id, nativeSessionId: randomUUID(), runtimeMode: "native", nativePhase: "terminal_failure", status: "failed", errorCode: "runner_remote_state_unavailable", createdAt: new Date(now - 600_000), finishedAt: new Date(now - 60_000), responsibleUserId: userId }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId: company.id, issueId: issue.id, heartbeatRunId: run.id, provider: "boat", providerLeaseId: `ended-${randomUUID()}`, status: "released", cleanupStatus: "success", failureReason: "historical-idle-close", acquiredAt: new Date(now - 590_000), releasedAt: new Date(now - 300_000), metadata: { pluginId: "fixture-boat", leaseController: { bootId: "historical-boot" }, historicalEvidence: "must survive" } }).returning();
    const readLease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]!;
    const readStorage = async () => (await db.execute<{ row: Record<string, unknown> }>(sql`select to_jsonb(${environmentLeases}) as row from ${environmentLeases} where ${environmentLeases.id} = ${lease.id}`))[0]!.row;
    const storage = await readStorage();
    const notes = () => db.select().from(issueComments).where(and(eq(issueComments.issueId, issue.id), eq(issueComments.authorType, "system")));
    const gate = () => db.transaction(tx => freshThreadStopGate(tx as unknown as Db, run, issue.id));
    const inspector = (result: unknown) => vi.fn(async () => {
      // External inspection must not hold the task lock.
      await db.transaction(async tx => { await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("update", { noWait: true }); });
      if (result instanceof Error) throw result;
      return result;
    });
    const cleanup = (stop: ReturnType<typeof vi.fn>) => heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
    return { run, issue, lease, readLease, readStorage, storage, notes, gate, inspector, cleanup };
  }

  it.each(["error", "absent"] as const)("released no receipt + GET %s: unchanged row, one cannot-confirm note, bounded, no stop or run", async observation => {
    const f = await fixture();
    const inspect = f.inspector(observation === "error" ? new Error("provider GET failed") : undefined);
    const stop = vi.fn(async () => undefined), hb = f.cleanup(stop);
    for (let n = 0; n < 3; n++) {
      await inspectFreshThreadStopResources(db, f.run, f.issue.id, inspect);
      await f.gate();
      await hb.sweepPendingCleanupLeases();
      expect(await f.readLease()).toEqual(f.lease);
      expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(false);
    }
    expect(stop).not.toHaveBeenCalled();
    expect(await f.notes()).toMatchObject([{ body: FRESH_THREAD_STOP_UNAVAILABLE_NOTE }]);
    expect(await f.notes()).toHaveLength(1);
    expect(inspect).toHaveBeenCalledTimes(3); // one bounded read per disposition pass, never an inner retry
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
  }, 60_000);

  function expectRestored(original: typeof environmentLeases.$inferSelect, restored: typeof environmentLeases.$inferSelect) {
    const receipt = restored.metadata?.remoteExecutionTermination;
    expect(receipt).toMatchObject({ schema: "paperclip.remote-termination.v1", companyId: original.companyId,
      runId: original.heartbeatRunId, leaseId: original.id, provider: original.provider,
      providerLeaseId: original.providerLeaseId, state: "stopped", endedLeaseEvidence: JSON.parse(JSON.stringify(original)) });
    expect(Date.parse((receipt as { confirmedAt: string }).confirmedAt)).toBeGreaterThanOrEqual(original.releasedAt!.getTime());
    // RFL 22:57Z (2): EVERY field, including all original timestamps and every
    // metadata key, is restored. The new stop receipt is the sole addition.
    for (const key of Object.keys(original) as (keyof typeof original)[]) {
      expect(restored[key], key).toEqual(key === "metadata" ? { ...original.metadata, remoteExecutionTermination: receipt } : original[key]);
    }
    expect(restored).toEqual({ ...original, metadata: { ...original.metadata, remoteExecutionTermination: receipt } });
  }

  async function expectStorageRestored(f: Awaited<ReturnType<typeof fixture>>) {
    const restored = await f.readStorage(), metadata = f.storage.metadata as Record<string, unknown>;
    // to_jsonb retains PostgreSQL microseconds that a JS Date read discards.
    expect(restored).toEqual({ ...f.storage, metadata: { ...metadata,
      remoteExecutionTermination: (restored.metadata as Record<string, unknown>).remoteExecutionTermination } });
  }

  it("released no receipt + GET running: one waiting note, single stop, restored original plus new receipt, no proofless run", async () => {
    const f = await fixture(), inspect = f.inspector({ providerLeaseId: f.lease.providerLeaseId!, state: "running" });
    const stop = vi.fn(async () => ({ providerLeaseId: f.lease.providerLeaseId!, state: "stopped" })), hb = f.cleanup(stop);
    await inspectFreshThreadStopResources(db, f.run, f.issue.id, inspect);
    const pending = await f.readLease();
    expect((pending.metadata?.sandboxStopAndRetain as Record<string, unknown>)?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    expect(pending.status).toBe("pending_cleanup");
    await f.gate();
    expect(await f.notes()).toMatchObject([{ body: FRESH_THREAD_STOPPING_NOTE }]);
    expect(await f.notes()).toHaveLength(1);
    expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(false);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
    for (let n = 0; n < 3; n++) await hb.sweepPendingCleanupLeases();
    expect(stop).toHaveBeenCalledOnce();
    expectRestored(f.lease, await f.readLease());
    await expectStorageRestored(f);
    expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
  }, 60_000);

  it("pending-cleanup-only owner alternative preserves COMPLETE ended evidence after its single confirmed stop", async () => {
    const f = await fixture();
    const inspect = f.inspector({ providerLeaseId: f.lease.providerLeaseId!, state: "active" });
    await inspectFreshThreadStopResources(db, f.run, f.issue.id, inspect);
    const pending = await f.readLease();
    expect(pending.status).toBe("pending_cleanup");
    expect(readStopOnlyCleanup(pending)).not.toBeNull();
    expect(pending.metadata?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    await f.gate();
    expect(await f.notes()).toMatchObject([{ body: FRESH_THREAD_STOPPING_NOTE }]);
    expect(await f.notes()).toHaveLength(1);
    expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(false);
    const stop = vi.fn(async () => ({ providerLeaseId: f.lease.providerLeaseId!, state: "stopped" })), hb = f.cleanup(stop);
    await hb.sweepPendingCleanupLeases();
    await hb.sweepPendingCleanupLeases();
    expect(stop).toHaveBeenCalledOnce();
    const settled = await f.readLease();
    expectRestored(f.lease, settled);
    await expectStorageRestored(f);
    expect(readStopOnlyCleanup(settled)).toBeNull();
    expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
  }, 60_000);

  it("restart after the persisted rewrite recovers the exact original from its intent and restores it once", async () => {
    const f = await fixture(), inspect = f.inspector({ providerLeaseId: f.lease.providerLeaseId!, state: "running" });
    await inspectFreshThreadStopResources(db, f.run, f.issue.id, inspect);
    const pending = await f.readLease(), requestId = readStopOnlyCleanup(pending)!.requestId;
    expect(pending.status).toBe("pending_cleanup");
    expect((pending.metadata?.sandboxStopAndRetain as Record<string, unknown>)?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    await f.gate();
    expect(await f.notes()).toMatchObject([{ body: FRESH_THREAD_STOPPING_NOTE }]);
    // Nothing in memory is passed to the successor service. This is the crash
    // boundary after committed intent/rewrite and before dispatch/restoration.
    const restartedDb = createDb(database.connectionString);
    const stop = vi.fn(async () => {
      const [claimed] = await restartedDb.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(readStopOnlyCleanup(claimed)!.requestId).toBe(requestId);
      expect((claimed.metadata?.sandboxStopAndRetain as Record<string, unknown>)?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
      return { providerLeaseId: f.lease.providerLeaseId!, state: "stopped" };
    });
    const restarted = heartbeatService(restartedDb, { environmentRuntime: { retryPendingSandboxTeardown: stop } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
    try {
      for (let n = 0; n < 3; n++) await restarted.sweepPendingCleanupLeases();
      expect(stop).toHaveBeenCalledOnce();
      const restored = await f.readLease();
      expectRestored(f.lease, restored);
      await expectStorageRestored(f);
      expect(readStopOnlyCleanup(restored)).toBeNull();
      expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(true);
      expect(await f.notes()).toHaveLength(1);
      // Snapshot and time checks must not become a broad bad-time exception.
      await db.update(environmentLeases).set({ failureReason: "tampered" }).where(eq(environmentLeases.id, f.lease.id));
      expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(false);
      await db.update(environmentLeases).set({ failureReason: restored.failureReason, metadata: { ...restored.metadata,
        remoteExecutionTermination: { ...(restored.metadata?.remoteExecutionTermination as object), confirmedAt: new Date(Date.now() + 60000).toISOString() } } }).where(eq(environmentLeases.id, f.lease.id));
      expect((await readFreshThreadStopProof(db, f.run, f.issue.id)).gone).toBe(false);
    } finally { await restarted.drainActiveRunExecutions(); await restartedDb.$client.end(); }
  }, 60_000);
});
