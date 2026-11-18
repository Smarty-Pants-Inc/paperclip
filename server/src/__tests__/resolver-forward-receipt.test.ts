// rf-4 resolver forward-only: resolveRemoteTerminationLease may give an EXPIRED
// reuse-chain lease the destroyed receipt of the chain's single LATER tip
// (acquired after the owner's lease ended). It must never let an EARLIER lease
// of the same allocation (a predecessor of the owner's lease) prove the owner
// gone, and an ambiguous chain (two tips) proves nothing. Real PostgreSQL rows,
// read through ownLeaseTerminated (the retirement path, ownLeaseOnly).
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createReusableLeaseHandoff } from "../services/environment-lease-handoff.js";
import { hasRemoteTerminationReceipt, ownLeaseTerminated, resolveRemoteTerminationLease } from "../services/remote-execution-termination.js";

type Row = { run: string; status: "expired" | "released" | "active"; destroyed?: boolean };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("rf-4 receipt inheritance is forward-only (real PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-resolver-forward-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  /** One allocation (box) whose leases form a validated reuse chain in time
   * order: chain[0] is the earliest, chain[n-1] the tip. Each lease ends when
   * the next is acquired. `extraTip` adds a second row with no successor key. */
  async function allocation(chain: Row[], extraTip?: Row) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID();
    const box = `bx_rf4_${randomUUID().slice(0, 8)}`;
    await db.insert(companies).values({ id: companyId, name: "rf-4 forward", issuePrefix: `F${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "forward", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Boat ${box}`, driver: "sandbox", config: { provider: "boat" } });
    const runs = new Map<string, string>();
    const runId = (name: string) => { if (!runs.has(name)) runs.set(name, randomUUID()); return runs.get(name)!; };
    for (const row of [...chain, ...(extraTip ? [extraTip] : [])]) runId(row.run);
    await db.insert(heartbeatRuns).values([...runs.values()].map(id => ({ id, companyId, agentId, issueId, status: "cancelled", runtimeMode: "native" })));
    const t0 = Date.parse("2026-11-18T09:00:00.000Z");
    const ids: string[] = [];
    const insert = async (row: Row, acquiredAt: Date, releasedAt: Date | null) => {
      const id = randomUUID();
      const heartbeatRunId = runId(row.run);
      await db.insert(environmentLeases).values({ id, companyId, environmentId, issueId, heartbeatRunId, provider: "boat", providerLeaseId: box,
        status: row.status, cleanupStatus: row.status === "active" ? null : "success", leasePolicy: "reuse_by_environment",
        acquiredAt, releasedAt, lastUsedAt: releasedAt ?? acquiredAt, metadata: { agentId, ...(row.destroyed ? { remoteExecutionTermination: {
          schema: "paperclip.remote-termination.v1", companyId, runId: heartbeatRunId, leaseId: id, provider: "boat", providerLeaseId: box,
          state: "destroyed", confirmedAt: (releasedAt ?? acquiredAt).toISOString() } } : {}) } });
      return id;
    };
    for (const [i, row] of chain.entries()) {
      const end = i < chain.length - 1 || row.status !== "active" ? new Date(t0 + (i + 1) * 60_000) : null;
      ids.push(await insert(row, new Date(t0 + i * 60_000), end));
    }
    for (let i = 0; i + 1 < ids.length; i++) {
      const [previous] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids[i]!));
      const [next] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids[i + 1]!));
      const handoff = createReusableLeaseHandoff(previous!, next!);
      await db.update(environmentLeases).set({ metadata: { ...previous!.metadata, reusableLeaseSuccessor: handoff } }).where(eq(environmentLeases.id, previous!.id));
      // Re-read: the previous step may already have written this row's own outgoing key.
      const [fresh] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, next!.id));
      await db.update(environmentLeases).set({ metadata: { ...fresh!.metadata, reusableLeasePredecessor: handoff } }).where(eq(environmentLeases.id, next!.id));
    }
    if (extraTip) ids.push(await insert(extraTip, new Date(t0 + chain.length * 60_000), extraTip.status === "active" ? null : new Date(t0 + (chain.length + 1) * 60_000)));
    const lease = async (i: number) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids[i]!)))[0]!;
    const verdict = (ownerIndex: number, owner = chain[ownerIndex]!) => ownLeaseTerminated(db,
      { companyId, environmentId, providerLeaseId: box, runId: runId(owner.run) }, { successorOnOwnerSandbox: false, ownLeaseOnly: true });
    return { ids, lease, verdict, runId };
  }

  it("RED 1: an EARLIER lease (the owner's chain predecessor) carries destroyed; the owner expired into a tip with NO receipt => NOT proven", async () => {
    const a = await allocation([{ run: "earlier", status: "expired", destroyed: true }, { run: "owner", status: "expired" }, { run: "tip", status: "released" }]);
    const resolved = await resolveRemoteTerminationLease(db, await a.lease(1));
    expect(resolved.metadata?.remoteExecutionTermination, "no receipt is synthesized for the owner from an earlier lease").toBeUndefined();
    expect(hasRemoteTerminationReceipt(resolved)).toBe(false);
    expect(await a.verdict(1)).toBe(false);
  });

  it("RED 1b: the earlier destroyed lease is the SAME run's own earlier lifecycle (run -> other -> run) => NOT proven", async () => {
    const a = await allocation([{ run: "owner", status: "expired", destroyed: true }, { run: "between", status: "expired" },
      { run: "owner", status: "expired" }, { run: "tip", status: "released" }]);
    expect(hasRemoteTerminationReceipt(await resolveRemoteTerminationLease(db, await a.lease(2)))).toBe(false);
    expect(await a.verdict(2)).toBe(false);
  });

  it("GREEN 2 (rf-4 forward): the owner expired and a LATER tip on the same allocation was destroyed => proven", async () => {
    const a = await allocation([{ run: "owner", status: "expired" }, { run: "tip", status: "released", destroyed: true }]);
    const owner = await a.lease(0), tip = await a.lease(1);
    expect(tip.acquiredAt.getTime()).toBeGreaterThanOrEqual(owner.releasedAt!.getTime());
    const resolved = await resolveRemoteTerminationLease(db, owner);
    expect(resolved.metadata?.remoteExecutionTermination).toMatchObject({ runId: owner.heartbeatRunId, leaseId: owner.id, state: "destroyed" });
    expect(owner.metadata?.remoteExecutionTermination, "the stored row is unchanged").toBeUndefined();
    expect(await a.verdict(0)).toBe(true);
  });

  it("GREEN 2b: forward through a longer chain (owner -> middle -> destroyed tip) => proven", async () => {
    const a = await allocation([{ run: "owner", status: "expired" }, { run: "middle", status: "expired" }, { run: "tip", status: "released", destroyed: true }]);
    expect(await a.verdict(0)).toBe(true);
  });

  it("RED 3: two tips (ambiguous chain) => NOT proven, even with a destroyed tip", async () => {
    const a = await allocation([{ run: "owner", status: "expired" }, { run: "tip", status: "released", destroyed: true }],
      { run: "other", status: "released", destroyed: true });
    expect(hasRemoteTerminationReceipt(await resolveRemoteTerminationLease(db, await a.lease(0)))).toBe(false);
    expect(await a.verdict(0)).toBe(false);
  });
});
