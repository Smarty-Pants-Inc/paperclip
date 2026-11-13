import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns } from "@paperclipai/db";
import type { PluginEnvironmentLeaseObservation } from "@paperclipai/plugin-sdk";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { classifyEnvironmentCapabilities, environmentRuntimeService, predecessorSandboxRecordFromObservation } from "../services/environment-runtime.js";
import { remoteRunnerGenerationLost } from "../services/native-runtime/native-session-executor.js";
import { resolvePredecessorRunnerLease } from "../services/native-runtime/predecessor-runner-lease.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// The server half of "predecessor proven gone": a FRESH provider inspection of
// the PREDECESSOR's own sandbox (any lease status, the company's own lease),
// mapped to the predicate's record. The provider decodes its API; Core reads
// only the typed observation and its optional stoppedAt/lastRebootAt/observedAt.
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe("predecessorSandboxRecordFromObservation", () => {
  const id = "bx_predecessor";
  it("maps destroyed to gone, stopped and active to present, and refuses everything else", () => {
    expect(predecessorSandboxRecordFromObservation({ providerLeaseId: id, state: "destroyed" }, id)).toEqual({ kind: "gone" });
    expect(predecessorSandboxRecordFromObservation({ providerLeaseId: id, state: "stopped", stoppedAt: "2026-11-13T10:00:00.000Z",
      lastRebootAt: null, observedAt: "2026-11-13T10:30:00.000Z" }, id)).toEqual({ kind: "present", state: "stopped",
      stoppedAt: "2026-11-13T10:00:00.000Z", lastRebootAt: null, observedAt: "2026-11-13T10:30:00.000Z" });
    expect(predecessorSandboxRecordFromObservation({ providerLeaseId: id, state: "active", stoppedAt: "2026-11-13T10:00:00.000Z",
      lastRebootAt: "2026-11-13T10:10:00.000Z" }, id)).toEqual({ kind: "present", state: "running", stoppedAt: null,
      lastRebootAt: "2026-11-13T10:10:00.000Z", observedAt: null });
    // An older plugin without the optional fields: present, but nothing to prove with.
    expect(predecessorSandboxRecordFromObservation({ providerLeaseId: id, state: "stopped" }, id)).toEqual({ kind: "present",
      state: "stopped", stoppedAt: null, lastRebootAt: null, observedAt: null });
    for (const bad of ["yesterday", "2026-02-30T10:00:00.000Z", "2026-11-13T10:00:00"]) {
      expect(predecessorSandboxRecordFromObservation({ providerLeaseId: id, state: "stopped", stoppedAt: bad, lastRebootAt: bad,
        observedAt: bad }, id), bad).toMatchObject({ stoppedAt: null, lastRebootAt: null, observedAt: null });
    }
    expect(() => predecessorSandboxRecordFromObservation({ providerLeaseId: id, state: "unknown" }, id)).toThrow("predecessor_sandbox_state_unknown");
    expect(() => predecessorSandboxRecordFromObservation(undefined, id)).toThrow("predecessor_sandbox_unobserved");
    expect(() => predecessorSandboxRecordFromObservation({ providerLeaseId: "bx_other", state: "destroyed" }, id)).toThrow("predecessor_sandbox_unobserved");
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping predecessor sandbox database tests: ${support.reason}`);
(support.supported ? describe : describe.skip)("readPredecessorSandboxRecord", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("predecessor-sandbox-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { await db.execute(sql`SET client_min_messages = warning; TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Predecessor fixture", issuePrefix: `P${companyId.slice(0, 6).toUpperCase()}` });
    const [environment] = await db.insert(environments).values({ name: "Remote fixture", driver: "sandbox" }).returning();
    // A released, reusable lease: the cleanup-only inspection would not read it.
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, status: "released",
      leasePolicy: "reuse_by_environment", provider: "boat", providerLeaseId: "bx_predecessor", releasedAt: new Date(),
      metadata: { driver: "sandbox" } }).returning();
    return { companyId, lease: lease! };
  }
  const runtimeWith = (observe: (input: { providerLeaseId: string }) => Promise<PluginEnvironmentLeaseObservation | undefined>) => {
    const inspected: string[] = [];
    const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      resolveCapabilities: async () => classifyEnvironmentCapabilities({}),
      acquireRunLease: async () => { throw new Error("unexpected acquire"); }, releaseRunLease: async () => null,
      inspectLeaseResource: async ({ lease }) => { inspected.push(lease.providerLeaseId!); return observe({ providerLeaseId: lease.providerLeaseId! }); },
    }] });
    return { runtime, inspected };
  };
  // The marker probe must not decide these cases: a box with no marker.
  const noMarker: CommandManagedRuntimeRunner = { execute: vi.fn(async () => ({ exitCode: 31, signal: null, timedOut: false, stdout: "", stderr: "" })) } as never;
  const lost = (runtime: ReturnType<typeof runtimeWith>["runtime"], companyId: string, leaseId: string) => remoteRunnerGenerationLost({
    runner: noMarker, remoteCwd: "/workspace", identity: { runnerInstanceId: "runner-1", normalizedSessionId: "session-1" },
    predecessor: { providerLeaseId: "bx_predecessor", probedProviderLeaseId: "bx_predecessor", start: { at: minutesAgo(120), source: "run" },
      readSandbox: () => runtime.readPredecessorSandboxRecord({ companyId, leaseId }) } });

  it("reads the predecessor's own sandbox freshly on every decision and proves a long stop", async () => {
    const f = await seed();
    const { runtime, inspected } = runtimeWith(async ({ providerLeaseId }) => ({ providerLeaseId, state: "stopped", stoppedAt: minutesAgo(20),
      lastRebootAt: null, observedAt: new Date().toISOString() }));
    expect(await lost(runtime, f.companyId, f.lease.id)).toBe(true);
    expect(await lost(runtime, f.companyId, f.lease.id)).toBe(true);
    expect(inspected).toEqual(["bx_predecessor", "bx_predecessor"]);
  });

  it.each([
    ["destroyed (404 or cancelled)", { state: "destroyed" }, true],
    ["a reboot after the predecessor started, active", { state: "active", lastRebootAt: minutesAgo(30) }, true],
    ["stopped 14 minutes", { state: "stopped", stoppedAt: minutesAgo(14) }, false],
    ["stopped without the optional fields (an older plugin)", { state: "stopped" }, false],
    ["active with no reboot (the marker probe decides; no marker here)", { state: "active" }, false],
    ["unknown (stopping, starting, error)", { state: "unknown", stoppedAt: minutesAgo(60) }, false],
  ] as const)("%s", async (_name, observation, expected) => {
    const f = await seed();
    const { runtime } = runtimeWith(async ({ providerLeaseId }) => ({ providerLeaseId, ...observation }) as PluginEnvironmentLeaseObservation);
    expect(await lost(runtime, f.companyId, f.lease.id)).toBe(expected);
  });

  it("proves nothing when the provider read throws, cannot inspect, or the lease is another company's", async () => {
    const f = await seed();
    const failing = runtimeWith(async () => { throw new Error("Boat GET failed (502)"); });
    expect(await lost(failing.runtime, f.companyId, f.lease.id)).toBe(false);
    const silent = runtimeWith(async () => undefined);
    expect(await lost(silent.runtime, f.companyId, f.lease.id)).toBe(false);
    const destroyed = runtimeWith(async ({ providerLeaseId }) => ({ providerLeaseId, state: "destroyed" }));
    await expect(destroyed.runtime.readPredecessorSandboxRecord({ companyId: randomUUID(), leaseId: f.lease.id }))
      .rejects.toThrow("predecessor_sandbox_lease_unavailable");
    expect(destroyed.inspected).toEqual([]);
  });
});

(support.supported ? describe : describe.skip)("resolvePredecessorRunnerLease", () => {
  let db: ReturnType<typeof createDb>, database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("predecessor-lease-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(async () => { await db.execute(sql`SET client_min_messages = warning; TRUNCATE companies, plugins, environments CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function company() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Lease fixture", issuePrefix: `L${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lease agent", role: "engineer", status: "idle", adapterType: "process" });
    const [environment] = await db.insert(environments).values({ name: `Remote fixture ${companyId}`, driver: "sandbox" }).returning();
    const run = async (providerLeaseId: string, fields: Partial<typeof heartbeatRuns.$inferInsert> = {}) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "succeeded", ...fields });
      const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, heartbeatRunId: runId,
        status: "released", leasePolicy: "reuse_by_environment", provider: "boat", providerLeaseId, metadata: { driver: "sandbox" } }).returning();
      return { runId, leaseId: lease!.id };
    };
    return { companyId, run };
  }

  it("returns the predecessor run's own lease, not the current run's, with the recorded process start", async () => {
    const c = await company();
    const predecessor = await c.run("bx_old", { startedAt: new Date("2026-11-13T09:59:00.000Z"),
      processStartedAt: new Date("2026-11-13T10:00:00.000Z"), processHostHash: "remote" });
    const current = await c.run("bx_new", { startedAt: new Date("2026-11-13T11:00:00.000Z") });
    expect(await resolvePredecessorRunnerLease(db, { companyId: c.companyId, runId: predecessor.runId })).toEqual({
      leaseId: predecessor.leaseId, providerLeaseId: "bx_old", start: { at: "2026-11-13T10:00:00.000Z", source: "process" } });
    expect(await resolvePredecessorRunnerLease(db, { companyId: c.companyId, runId: current.runId })).toEqual({
      leaseId: current.leaseId, providerLeaseId: "bx_new", start: { at: "2026-11-13T11:00:00.000Z", source: "run" } });
  });

  it("falls back to the run's start when no remote process start is recorded, and to none without either", async () => {
    const c = await company();
    const local = await c.run("bx_local", { startedAt: new Date("2026-11-13T09:00:00.000Z"),
      processStartedAt: new Date("2026-11-13T09:00:01.000Z"), processHostHash: "host-hash" });
    expect((await resolvePredecessorRunnerLease(db, { companyId: c.companyId, runId: local.runId }))?.start)
      .toEqual({ at: "2026-11-13T09:00:00.000Z", source: "run" });
    const unstarted = await c.run("bx_unstarted");
    expect((await resolvePredecessorRunnerLease(db, { companyId: c.companyId, runId: unstarted.runId }))?.start).toBeNull();
  });

  it("refuses another company's run and a run without a provider sandbox", async () => {
    const owner = await company(), other = await company();
    const predecessor = await owner.run("bx_old", { startedAt: new Date() });
    expect(await resolvePredecessorRunnerLease(db, { companyId: other.companyId, runId: predecessor.runId })).toBeNull();
    const [bare] = await db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: owner.companyId,
      agentId: (await db.select().from(agents).where(sql`${agents.companyId} = ${owner.companyId}`))[0]!.id,
      invocationSource: "on_demand", status: "succeeded" }).returning();
    expect(await resolvePredecessorRunnerLease(db, { companyId: owner.companyId, runId: bare!.id })).toBeNull();
  });
});
