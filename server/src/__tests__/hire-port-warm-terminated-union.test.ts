// hire-port RFL CONDITION (binding): warmSandboxTerminated's resolved body is
// the UNION. Every termination case c3c15054 accepts (resolveRemoteTerminationLease,
// "destroyed" on any lease of the box, "stopped" on the owner run's own lease)
// AND F3''s own-lease receipt proof (a setup probe's exact lease) both stay,
// each with a row here, so neither side's case drops silently.
//
// On the port, warmSandboxTerminated(db, entry, scope) is exactly
// ownLeaseTerminated(db, { companyId, environmentId, providerLeaseId, runId }, scope)
// (native-session-executor.ts). BASE_BODY below is c3c15054's
// warmSandboxTerminated body copied verbatim (native-session-executor.ts:1284-1297
// at c3c15054); every base-case row asserts the port's default-scope verdict
// equals it. Real PostgreSQL rows.
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createReusableLeaseHandoff } from "../services/environment-lease-handoff.js";
import { hasRemoteTerminationReceipt, ownLeaseTerminated, resolveRemoteTerminationLease } from "../services/remote-execution-termination.js";

type Entry = { companyId: string; environmentId: string; providerLeaseId: string; runId: string };
type State = "stopped" | "destroyed";

/** c3c15054 native-session-executor.ts warmSandboxTerminated, verbatim body. */
async function BASE_BODY(db: Db, entry: Entry): Promise<boolean> {
  if (!entry.providerLeaseId || !entry.environmentId) return false;
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, entry.companyId),
    eq(environmentLeases.environmentId, entry.environmentId),
    eq(environmentLeases.providerLeaseId, entry.providerLeaseId),
  ));
  const resolved = await Promise.all(leases.map(lease => resolveRemoteTerminationLease(db, lease)));
  return resolved.some(lease => {
    if (!hasRemoteTerminationReceipt(lease)) return false;
    const state = (lease.metadata?.remoteExecutionTermination as { state?: unknown } | undefined)?.state;
    return state === "destroyed" || (state === "stopped" && lease.heartbeatRunId === entry.runId);
  });
}

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("hire-port RFL union: warmSandboxTerminated keeps c3c15054's cases AND F3''s own-lease probe proof", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-hire-port-union-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });

  /** One Boat box; leases are added in time order, one minute apart. */
  async function box() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), environmentId = randomUUID();
    const providerLeaseId = `bx_union_${randomUUID().slice(0, 8)}`;
    await db.insert(companies).values({ id: companyId, name: "union", issuePrefix: `U${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "union", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: `Boat ${providerLeaseId}`, driver: "sandbox", config: { provider: "boat" } });
    const runs = new Map<string, string>();
    const run = async (name: string) => {
      if (!runs.has(name)) {
        const id = randomUUID(); runs.set(name, id);
        await db.insert(heartbeatRuns).values({ id, companyId, agentId, issueId, status: "cancelled", runtimeMode: "native" });
      }
      return runs.get(name)!;
    };
    const t0 = Date.parse("2026-11-19T06:00:00.000Z");
    let n = 0;
    /** run null = a setup probe's lease (no run, no issue). */
    const lease = async (input: { run: string | null; status: "released" | "expired" | "active"; receipt?: State; policy?: string }) => {
      const id = randomUUID();
      const heartbeatRunId = input.run === null ? null : await run(input.run);
      const acquiredAt = new Date(t0 + n++ * 60_000);
      // A lease ends exactly when the next one on the box starts (the reuse-chain handoff rule).
      const releasedAt = input.status === "active" ? null : new Date(acquiredAt.getTime() + 60_000);
      await db.insert(environmentLeases).values({ id, companyId, environmentId, issueId: input.run === null ? null : issueId, heartbeatRunId,
        provider: "boat", providerLeaseId, status: input.status, cleanupStatus: input.status === "active" ? null : "success",
        leasePolicy: input.policy ?? (input.run === null ? "ephemeral" : "reuse_by_environment"), acquiredAt, releasedAt, lastUsedAt: releasedAt ?? acquiredAt,
        metadata: { agentId, ...(input.receipt ? { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId: heartbeatRunId,
          leaseId: id, provider: "boat", providerLeaseId, state: input.receipt, confirmedAt: (releasedAt ?? acquiredAt).toISOString() } } : {}) } });
      return id;
    };
    const chain = async (ids: string[]) => {
      for (let i = 0; i + 1 < ids.length; i++) {
        const [previous] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids[i]!));
        const [next] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids[i + 1]!));
        const handoff = createReusableLeaseHandoff(previous!, next!);
        await db.update(environmentLeases).set({ metadata: { ...previous!.metadata, reusableLeaseSuccessor: handoff } }).where(eq(environmentLeases.id, previous!.id));
        const [fresh] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, next!.id));
        await db.update(environmentLeases).set({ metadata: { ...fresh!.metadata, reusableLeasePredecessor: handoff } }).where(eq(environmentLeases.id, next!.id));
      }
    };
    const entry = async (name: string): Promise<Entry> => ({ companyId, environmentId, providerLeaseId, runId: await run(name) });
    /** The port's warmSandboxTerminated: ownLeaseTerminated on the warm owner. */
    const warm = (e: Entry, scope: { successorOnOwnerSandbox?: boolean; ownLeaseOnly?: boolean } = {}) =>
      ownLeaseTerminated(db, { companyId: e.companyId, environmentId: e.environmentId, providerLeaseId: e.providerLeaseId, runId: e.runId }, scope);
    return { companyId, environmentId, providerLeaseId, lease, chain, entry, warm };
  }

  /** A base case: the port's default-scope verdict equals c3c15054's body and the expectation. */
  async function baseCase(b: Awaited<ReturnType<typeof box>>, e: Entry, expected: boolean, why: string) {
    expect(await BASE_BODY(db, e), `${why} (c3c15054 body)`).toBe(expected);
    expect(await b.warm(e), `${why} (port, default scope)`).toBe(expected);
  }

  it("BASE destroyed-anywhere: a destroy receipt on ANOTHER run's released lease of the same box proves the warm owner gone (default scope); the retirement scope (ownLeaseOnly) does not", async () => {
    const b = await box();
    await b.lease({ run: "owner", status: "released" });
    await b.lease({ run: "other", status: "released", receipt: "destroyed" });
    const owner = await b.entry("owner");
    await baseCase(b, owner, true, "destroyed on another lease");
    expect(await b.warm(owner, { ownLeaseOnly: true }), "c1 retirement: only the owner's own lease").toBe(false);
  });

  it("BASE stopped-on-own-run: a stop receipt on the owner run's own released lease proves it gone (default scope); a successor on that same box is not told so", async () => {
    const b = await box();
    await b.lease({ run: "owner", status: "released", receipt: "stopped" });
    const owner = await b.entry("owner");
    await baseCase(b, owner, true, "stopped on own run");
    expect(await b.warm(owner, { successorOnOwnerSandbox: true }), "successor on the owner's box").toBe(false);
    expect(await b.warm(owner, { ownLeaseOnly: true }), "retirement scope keeps own-run stopped").toBe(true);
  });

  it("BASE stopped on ANOTHER run's lease is no proof", async () => {
    const b = await box();
    await b.lease({ run: "owner", status: "released" });
    await b.lease({ run: "other", status: "released", receipt: "stopped" });
    await baseCase(b, await b.entry("owner"), false, "stopped on another run");
  });

  it("BASE an unreleased (active) lease's receipt is no proof", async () => {
    const b = await box();
    await b.lease({ run: "owner", status: "active", receipt: "destroyed" });
    await baseCase(b, await b.entry("owner"), false, "receipt on an active lease");
  });

  it("BASE resolveRemoteTerminationLease forward inheritance: the owner's expired lease takes the LATER chain tip's destroy receipt (default scope and retirement scope)", async () => {
    const b = await box();
    const ids = [await b.lease({ run: "owner", status: "expired" }), await b.lease({ run: "tip", status: "released", receipt: "destroyed" })];
    await b.chain(ids);
    const owner = await b.entry("owner");
    await baseCase(b, owner, true, "forward inheritance from the later tip");
    expect(await b.warm(owner, { ownLeaseOnly: true })).toBe(true);
  });

  it("F3' own-lease probe proof: a setup probe's exact lease (no run) with its bound destroy receipt proves THAT probe gone; stopped does not under the probe's scope (C3)", async () => {
    const b = await box();
    const probe = await b.lease({ run: null, status: "released", receipt: "destroyed" });
    const owner = { companyId: b.companyId, environmentId: b.environmentId, providerLeaseId: b.providerLeaseId, runId: null, leaseId: probe };
    expect(await ownLeaseTerminated(db, owner, { ownLeaseOnly: true, successorOnOwnerSandbox: true }), "probe's exact lease, destroyed").toBe(true);
    expect(await ownLeaseTerminated(db, { ...owner, leaseId: randomUUID() }, { ownLeaseOnly: true, successorOnOwnerSandbox: true }), "another lease id never reads it").toBe(false);
    const b2 = await box();
    const stopped = await b2.lease({ run: null, status: "released", receipt: "stopped" });
    expect(await ownLeaseTerminated(db, { companyId: b2.companyId, environmentId: b2.environmentId, providerLeaseId: b2.providerLeaseId, runId: null, leaseId: stopped },
      { ownLeaseOnly: true, successorOnOwnerSandbox: true }), "C3: stopped is not proof for a probe").toBe(false);
  });

  it("UNION isolation: a probe lease's receipt on the same box never changes a WARM owner's verdict (warm owners carry no leaseId), exactly as c3c15054", async () => {
    const b = await box();
    await b.lease({ run: "owner", status: "released" });
    await b.lease({ run: null, status: "released", receipt: "destroyed" });
    await baseCase(b, await b.entry("owner"), false, "a probe's run-less receipt binds only to its holder's exact lease id");
  });
});
