import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, environmentLeases, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { heartbeatService } from "./heartbeat.js";
import { prepareInspectedSourceSandboxStop, readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";

// Keep: F1-1 target E, a data-safety/trust boundary. Exercise the retained
// stop-and-keep owner directly, not the removed fresh-admission stop producer.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("F1 ended inspection binding bar", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("f1-ended-inspection-bar"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { vi.useRealTimers(); await db.execute(sql`truncate table companies cascade`); });
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
    const cleanup = (stop: ReturnType<typeof vi.fn>) => heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
    return { run, issue, lease, readLease, readStorage, storage, notes, cleanup };
  }

  // follow-Paperclip Cut B R5: absent/error observations confer no cleanup authority; no fresh-gate inspection or notice remains.
  it.each(["error", "absent"] as const)("released no receipt + observation %s: cleanup preserves the row, with no stop or run", async observation => {
    const f = await fixture();
    const result = observation === "error" ? new Error("provider GET failed") : undefined;
    const stop = vi.fn(async () => undefined), hb = f.cleanup(stop);
    for (let n = 0; n < 3; n++) {
      expect(await prepareInspectedSourceSandboxStop(db, f.lease, result)).toBeNull();
      await hb.sweepPendingCleanupLeases();
      expect(await f.readLease()).toEqual(f.lease);
    }
    expect(stop).not.toHaveBeenCalled();
    expect(await f.notes()).toHaveLength(0);
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

  // follow-Paperclip Cut B R5: move stop-and-keep/restoration safety to its cleanup owner; fresh admission no longer produces a stop or note.
  it("released no receipt + running observation: cleanup stops once and restores the original plus receipt without launching a run", async () => {
    const f = await fixture();
    const stop = vi.fn(async () => ({ providerLeaseId: f.lease.providerLeaseId!, state: "stopped" })), hb = f.cleanup(stop);
    expect(await prepareInspectedSourceSandboxStop(db, f.lease, { providerLeaseId: f.lease.providerLeaseId!, state: "running" })).not.toBeNull();
    const pending = await f.readLease();
    expect((pending.metadata?.sandboxStopAndRetain as Record<string, unknown>)?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    expect(pending.status).toBe("pending_cleanup");
    expect(await f.notes()).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
    for (let n = 0; n < 3; n++) await hb.sweepPendingCleanupLeases();
    expect(stop).toHaveBeenCalledOnce();
    expectRestored(f.lease, await f.readLease());
    await expectStorageRestored(f);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
  }, 60_000);

  // follow-Paperclip Cut B R5: retain complete ended-evidence and single-stop checks at the existing cleanup preparation seam.
  it("pending-cleanup-only owner preserves COMPLETE ended evidence after its single confirmed stop", async () => {
    const f = await fixture();
    expect(await prepareInspectedSourceSandboxStop(db, f.lease, { providerLeaseId: f.lease.providerLeaseId!, state: "active" })).not.toBeNull();
    const pending = await f.readLease();
    expect(pending.status).toBe("pending_cleanup");
    expect(readStopOnlyCleanup(pending)).not.toBeNull();
    expect(pending.metadata?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    expect(await f.notes()).toHaveLength(0);
    const stop = vi.fn(async () => ({ providerLeaseId: f.lease.providerLeaseId!, state: "stopped" })), hb = f.cleanup(stop);
    await hb.sweepPendingCleanupLeases();
    await hb.sweepPendingCleanupLeases();
    expect(stop).toHaveBeenCalledOnce();
    const settled = await f.readLease();
    expectRestored(f.lease, settled);
    await expectStorageRestored(f);
    expect(readStopOnlyCleanup(settled)).toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
  }, 60_000);

  // follow-Paperclip Cut B R5: the persisted cleanup intent still has a single dispatch and bounded proof reads, without gate notices.
  it.each([false, true])("an unconfirmed cleanup stop uses bounded read-only sweeps (later proof: %s)", async laterProof => {
    const f = await fixture(), t0 = Date.now();
    expect(await prepareInspectedSourceSandboxStop(db, f.lease,
      { providerLeaseId: f.lease.providerLeaseId!, state: "running" })).not.toBeNull();
    expect(await f.notes()).toHaveLength(0);
    const stop = vi.fn(async () => undefined);
    let reads = 0;
    const inspect = vi.fn(async () => ++reads >= 3 && laterProof
      ? { providerLeaseId: f.lease.providerLeaseId!, state: "stopped" } : undefined);
    const hb = heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop,
      inspectLeaseResource: inspect } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let n = 0; n < 10; n++) {
      vi.setSystemTime(t0 + n * 1800_000);
      await hb.sweepPendingCleanupLeases();
      expect(stop).toHaveBeenCalledOnce();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, f.issue.id))).toHaveLength(1);
    }
    expect(inspect).toHaveBeenCalledTimes(laterProof ? 3 : 5);
    if (laterProof) {
      expectRestored(f.lease, await f.readLease());
      await expectStorageRestored(f);
      expect(await f.notes()).toHaveLength(0);
    } else {
      const pending = await f.readLease();
      expect(pending.status).toBe("pending_cleanup");
      expect((pending.metadata?.sandboxStopAndRetain as Record<string, unknown>)?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
      expect(await f.notes()).toHaveLength(0); // cleanup cannot narrate a thread selection
    }
  }, 60_000);

  // follow-Paperclip Cut B R5: restart safety belongs to the durable cleanup owner, not the removed fresh-thread gate.
  it("restart after the persisted rewrite recovers the exact original from its intent and restores it once", async () => {
    const f = await fixture();
    expect(await prepareInspectedSourceSandboxStop(db, f.lease, { providerLeaseId: f.lease.providerLeaseId!, state: "running" })).not.toBeNull();
    const pending = await f.readLease(), requestId = readStopOnlyCleanup(pending)!.requestId;
    expect(pending.status).toBe("pending_cleanup");
    expect((pending.metadata?.sandboxStopAndRetain as Record<string, unknown>)?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    expect(await f.notes()).toHaveLength(0);
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
      expect(await f.notes()).toHaveLength(0);
      // Snapshot and time checks must not become a broad bad-time exception.
      await db.update(environmentLeases).set({ failureReason: "tampered" }).where(eq(environmentLeases.id, f.lease.id));
      await db.update(environmentLeases).set({ failureReason: restored.failureReason, metadata: { ...restored.metadata,
        remoteExecutionTermination: { ...(restored.metadata?.remoteExecutionTermination as object), confirmedAt: new Date(Date.now() + 60000).toISOString() } } }).where(eq(environmentLeases.id, f.lease.id));
    } finally { await restarted.drainActiveRunExecutions(); await restartedDb.$client.end(); }
  }, 60_000);
});
