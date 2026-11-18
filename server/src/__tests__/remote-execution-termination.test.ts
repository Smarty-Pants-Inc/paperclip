// B1 (rf-4 finding, rf-3's definition): ownLeaseTerminated is the one stop-proof
// reader. A "stopped" receipt on the owner P's lease is not proof once ANY lease
// on that allocation (same environment + providerLeaseId: the box) held by
// someone other than P was acquired at or after the receipt's confirmedAt, or is
// still open: the box may have been resumed, and P's runner with it. Boat's
// driver is not in this tree, so nothing here shows an allocation id is never
// reused after destroy; "destroyed" follows the same rule. Real PostgreSQL rows.
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ownLeaseTerminated } from "../services/remote-execution-termination.js";

/** One lease row. Minutes are offsets from t0; released null = still open. */
type LeaseRow = { holder: string | null; box: "A" | "B"; acquired: number; released: number | null;
  receipt?: { state: "stopped" | "destroyed"; confirmed: number } };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("B1: a stopped receipt is not proof after another holder resumed the box (real PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-b1-reader-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  const t0 = Date.parse("2026-11-18T09:00:00.000Z");
  const at = (minute: number) => new Date(t0 + minute * 60_000);

  async function world(rows: LeaseRow[]) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const boxes = { A: `bx_b1_A_${suffix}`, B: `bx_b1_B_${suffix}` };
    await db.insert(companies).values({ id: companyId, name: "B1", issuePrefix: `B${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "B1", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Boat ${suffix}`, driver: "sandbox", config: { provider: "boat" } });
    const runs = new Map<string, string>();
    for (const row of rows) if (row.holder && !runs.has(row.holder)) runs.set(row.holder, randomUUID());
    if (runs.size) await db.insert(heartbeatRuns).values([...runs.values()].map(id => ({ id, companyId, agentId, issueId, status: "cancelled", runtimeMode: "native" })));
    const ids: string[] = [];
    for (const row of rows) {
      const id = randomUUID(), heartbeatRunId = row.holder ? runs.get(row.holder)! : null, providerLeaseId = boxes[row.box];
      const open = row.released === null;
      await db.insert(environmentLeases).values({ id, companyId, environmentId, issueId, heartbeatRunId, provider: "boat", providerLeaseId,
        status: open ? "active" : "released", cleanupStatus: open ? null : "success", leasePolicy: "reuse_by_environment",
        acquiredAt: at(row.acquired), releasedAt: open ? null : at(row.released!), lastUsedAt: at(row.released ?? row.acquired),
        metadata: { agentId, ...(row.receipt ? { remoteExecutionTermination: {
          schema: "paperclip.remote-termination.v1", companyId, runId: heartbeatRunId, leaseId: id, provider: "boat", providerLeaseId,
          state: row.receipt.state, confirmedAt: at(row.receipt.confirmed).toISOString() } } : {}) } });
      ids.push(id);
    }
    /** The reader for run P on box A, as the retirement path asks it (S is on B). */
    const runOwner = (scope: { successorOnOwnerSandbox?: boolean; ownLeaseOnly?: boolean } = { successorOnOwnerSandbox: false, ownLeaseOnly: true }) =>
      ownLeaseTerminated(db, { companyId, environmentId, providerLeaseId: boxes.A, runId: runs.get("P")! }, scope);
    /** The reader for a setup probe's exact lease (no run), as F5 asks it. */
    const probeOwner = (index: number) =>
      ownLeaseTerminated(db, { companyId, environmentId, providerLeaseId: boxes.A, runId: null, leaseId: ids[index]! }, { ownLeaseOnly: true });
    return { runOwner, probeOwner };
  }

  const pStopped: LeaseRow = { holder: "P", box: "A", acquired: 0, released: 2, receipt: { state: "stopped", confirmed: 2 } };
  const sOnB: LeaseRow = { holder: "S", box: "B", acquired: 6, released: null };

  it("B1 (i) CLEAN RESUME: P stops on A; Q resumes A (acquired after confirmedAt, then released); S on B => refuse", async () => {
    const w = await world([pStopped, { holder: "Q", box: "A", acquired: 3, released: 5 }, sOnB]);
    expect(await w.runOwner()).toBe(false);
    expect(await w.runOwner({}), "default scope too").toBe(false);
  });

  it("B1 (i'): Q resumes A exactly AT confirmedAt => refuse", async () => {
    const w = await world([pStopped, { holder: "Q", box: "A", acquired: 2, released: 5 }, sOnB]);
    expect(await w.runOwner()).toBe(false);
  });

  it("B1 (ii) OPEN OVERLAP: Q's lease on A acquired BEFORE confirmedAt is still open => refuse", async () => {
    const w = await world([pStopped, { holder: "Q", box: "A", acquired: 1, released: null }, sOnB]);
    expect(await w.runOwner()).toBe(false);
  });

  it("control: no other-holder lease on A => proven", async () => {
    const w = await world([pStopped, sOnB]);
    expect(await w.runOwner()).toBe(true);
    expect(await w.runOwner({ successorOnOwnerSandbox: true, ownLeaseOnly: true }), "same-box successor: unchanged, never proof").toBe(false);
  });

  it("control: another holder on A acquired AND released before confirmedAt => proven (a past holder is not a resume)", async () => {
    const w = await world([{ holder: "Q", box: "A", acquired: 0, released: 1 }, { ...pStopped, acquired: 1 }, sOnB]);
    expect(await w.runOwner()).toBe(true);
  });

  it("control (8693dcb4 forward-only): P -> Q -> P on A, receipt only on P's EARLIER lease => not proven, unchanged", async () => {
    const w = await world([pStopped, { holder: "Q", box: "A", acquired: 2, released: 4 }, { holder: "P", box: "A", acquired: 4, released: 6 }]);
    expect(await w.runOwner()).toBe(false);
  });

  it("control (8693dcb4 forward-only): P -> Q -> P on A, receipt on P's LATEST lease after Q => proven, unchanged", async () => {
    const w = await world([{ holder: "P", box: "A", acquired: 0, released: 2 }, { holder: "Q", box: "A", acquired: 2, released: 4 },
      { holder: "P", box: "A", acquired: 4, released: 6, receipt: { state: "stopped", confirmed: 6 } }]);
    expect(await w.runOwner()).toBe(true);
  });

  it("control: P's OWN later lease on A after its stop is not another holder => default-scope result unchanged (proven)", async () => {
    const w = await world([pStopped, { holder: "P", box: "A", acquired: 3, released: null }]);
    expect(await w.runOwner({})).toBe(true);
  });

  it("destroyed (no in-tree proof that a destroyed allocation id is never reused): Q holds A after confirmedAt => refuse", async () => {
    const w = await world([{ ...pStopped, receipt: { state: "destroyed", confirmed: 2 } }, { holder: "Q", box: "A", acquired: 3, released: 5 }, sOnB]);
    expect(await w.runOwner()).toBe(false);
    expect(await w.runOwner({}), "default scope too").toBe(false);
  });

  it("destroyed control: no other holder => proven", async () => {
    const w = await world([{ ...pStopped, receipt: { state: "destroyed", confirmed: 2 } }, sOnB]);
    expect(await w.runOwner()).toBe(true);
    expect(await w.runOwner({ successorOnOwnerSandbox: true, ownLeaseOnly: true })).toBe(true);
  });

  it("F5 probe: a closed probe lease with its stopped receipt and no later lease => proven", async () => {
    const w = await world([{ holder: null, box: "A", acquired: 0, released: 2, receipt: { state: "stopped", confirmed: 2 } }]);
    expect(await w.probeOwner(0)).toBe(true);
  });

  it("F5 probe: a run resumes the probe's box after the stop => refuse", async () => {
    const w = await world([{ holder: null, box: "A", acquired: 0, released: 2, receipt: { state: "stopped", confirmed: 2 } },
      { holder: "Q", box: "A", acquired: 3, released: null }]);
    expect(await w.probeOwner(0)).toBe(false);
  });
});
