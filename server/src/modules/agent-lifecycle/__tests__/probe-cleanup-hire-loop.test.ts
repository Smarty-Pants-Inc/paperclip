import { appendFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agents, companies, companyMemberships, environmentLeases, createDb, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../../../services/agent-lifecycle.js";
import { aiConnectionService } from "../../../services/ai-connections.js";
import { agentHarnessVerificationService } from "../../../services/agent-harness-verification.js";
import * as environmentTests from "../../../services/agent-environment-test.js";
import { PROBE_CLEANUP_PENDING_PARK_MS, reconcileRetainedAiCleanup } from "../../../services/retained-ai-credential-cleanup.js";
import { SandboxLeaseStartDeniedError } from "../../../services/retained-sandbox-absent-error.js";
import { logger } from "../../../middleware/logger.js";
import { NativeEnvironmentProbeCleanupError } from "../../../vendor/paperclip-runner/index.js";

// Replays gate 7 (agent 0d3339d0): the probe's credential retirement is rejected
// (JsonRpc -32002 while confirming the credential handoff), the lifecycle fails
// native_probe_cleanup_pending on attempts 1/2/3, the probe box is swept and every
// retained retry then fails sandbox_lease_start_denied. Real: lifecycle worker +
// store, harness verifier, AI connection selection, prepareManagedAiRuntime /
// withManagedAiProbe and the retained-cleanup gate. Fake: the native probe and
// its box (SQL lease receipts only).
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("a recoverable probe cleanup that never confirms parks its agent truthfully", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let companyId: string;
  const workers: Array<{ stop(): Promise<void> }> = [];
  const model = "openrouter/deepseek/deepseek-v4.1-flash-1017";
  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-hire-loop-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "probe-cleanup-hire-loop");
    database = await startEmbeddedPostgresTestDatabase("paperclip-hire-loop-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Probe hire loop", issuePrefix: `H${companyId.slice(0, 7)}` });
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    vi.restoreAllMocks();
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const exists = (target: string) => stat(target).then(() => true, () => false);

  async function account(owner: string) {
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const saved = await aiConnectionService(db).save(companyId, owner, { provider: "openrouter", method: "api_key", ownership: "personal", name: owner,
      apiKey: `key-${owner}`, agentIds: [], allAgents: true }, `key-${owner}`);
    await aiConnectionService(db).setDefault(companyId, owner, saved.grantId);
    return saved;
  }
  async function hire(name: string, owner: string) {
    const [agent] = await db.insert(agents).values({ companyId, name, adapterType: "opencode_local", status: "paused",
      adapterConfig: { model }, lifecycleState: "verifying", lifecycleRequiredPluginIds: [],
      runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "openrouter", method: "api_key" } },
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0, responsibleUserId: owner } }).returning();
    return agent;
  }
  const pass = () => ({ adapterType: "opencode_local", status: "pass" as const, testedAt: new Date().toISOString(),
    checks: [{ code: "opencode_hello_probe_passed", level: "info" as const, message: "Fixture passed" }] });
  function harness(probe: (agentId: string, managed: { home: string; cleanup: () => Promise<void> }) => Promise<ReturnType<typeof pass>>) {
    const tests = environmentTests.agentEnvironmentTestService;
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => ({ ...tests(database, manager),
      resolveAdapterTestEnvironmentId: async () => null,
      resolveAdapterTestExecutionContext: async () => {
        const [lease] = await db.insert(environmentLeases).values({ companyId, provider: "fixture", providerLeaseId: randomUUID() }).returning();
        return { executionTarget: null, environmentName: null, fallbackChecks: [], release: async () => {
          await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() }).where(eq(environmentLeases.id, lease.id));
        } };
      },
      testManagedEnvironment: async (_adapter: string, _input: unknown, _binding: unknown, managed: { home: string; cleanup: () => Promise<void> }, agentId: string) => probe(agentId, managed),
    }) as never);
    const verifier = agentHarnessVerificationService(db, {} as never);
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: row => verifier.verify(row) });
    workers.push(work);
    return { work };
  }
  // The gate's -32002 while confirming the credential handoff.
  const handoffRejected = () => Object.assign(new Error("confirming credential handoff"), { name: "JsonRpcCallError", code: -32002 });
  const retryLifecycle = async (work: { process(id: string): Promise<void> }, id: string) => {
    await createAgentLifecycle(db).retry(id);
    await work.process(id);
    return current(id);
  };
  const receipt = async (summary: unknown) => {
    console.info("PROBE_CLEANUP_HIRE_LOOP", JSON.stringify(summary));
    if (process.env.PROBE_GATE_RECEIPTS) await appendFile(process.env.PROBE_GATE_RECEIPTS, `${JSON.stringify(summary)}\n`);
  };

  it("(a) retirement rejected -> 3x cleanup pending -> box swept: off-box cleanup runs and is read back, the agent parks truthfully, Retry -> ready", async () => {
    const owner = `owner-${randomUUID()}`;
    const saved = await account(owner);
    const first = await hire("Gate 7 hire", owner);
    let boxSwept = false;
    const retryCleanup = vi.fn(async () => { throw boxSwept ? new SandboxLeaseStartDeniedError() : handoffRejected(); });
    let firstProbes = 0, runtimeCleanups = 0;
    let probeHome = "";
    const { work } = harness(async (agentId, managed) => {
      if (agentId === first.id && firstProbes++ === 0) {
        probeHome = managed.home;
        const real = managed.cleanup;
        managed.cleanup = () => { runtimeCleanups++; return real(); };
        const retired = new Promise<void>((_resolve, reject) => { setTimeout(() => reject(handoffRejected()), 0); });
        throw new NativeEnvironmentProbeCleanupError(retired, undefined, [handoffRejected()], retryCleanup);
      }
      return pass();
    });
    const later: string[] = [];
    const hireLater = async (name: string) => {
      const agent = await hire(name, owner);
      await work.process(agent.id);
      later.push((await current(agent.id)).lifecycleState);
    };
    try {
      await work.process(first.id);
      const attempts = [await current(first.id)];
      await new Promise(resolve => setTimeout(resolve, 20));
      for (let i = 0; i < 5; i++) await hireLater(`Before sweep ${i}`);
      attempts.push(await retryLifecycle(work, first.id));
      attempts.push(await retryLifecycle(work, first.id));
      const homeBeforeSweep = await exists(probeHome);
      boxSwept = true;
      const parked = await retryLifecycle(work, first.id);
      const homeAfterPark = await exists(probeHome);
      const scopeAfterPark = await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }).then(() => "clear", () => "pending");
      for (let i = 0; i < 5; i++) await hireLater(`After sweep ${i}`);
      const retried = await retryLifecycle(work, first.id);
      const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId));
      await receipt({ row: "a", attempts: attempts.map(a => ({ state: a.lifecycleState, retryRequired: (a.lifecycleOperation as { retryRequired?: boolean }).retryRequired ?? false })),
        retryCleanupCalls: retryCleanup.mock.calls.length, homeBeforeSweep, homeAfterPark, runtimeCleanups, scopeAfterPark,
        parked: { state: parked.lifecycleState, operation: parked.lifecycleOperation, error: parked.lifecycleError },
        retried: retried.lifecycleState, firstProbes, later, leasesLive: leases.filter(lease => lease.status !== "released").length });
      expect(attempts.map(a => a.lifecycleState)).toEqual(["verifying", "verifying", "verifying"]);
      expect(attempts.every(a => !(a.lifecycleOperation as { retryRequired?: boolean }).retryRequired)).toBe(true);
      expect(homeBeforeSweep).toBe(true);
      expect(parked.lifecycleState).toBe("verifying");
      expect(parked.lifecycleOperation).toMatchObject({ retryRequired: true });
      expect(parked.lifecycleError).toContain("could not finish the test's cleanup");
      expect(parked.lifecycleError).toContain("Automatic verification is paused");
      expect(parked.lifecycleError).toContain("Retry");
      // The off-box part ran (this runtime's cleanup: write-back + home removal) and was read back.
      expect(runtimeCleanups).toBeGreaterThanOrEqual(1);
      expect(homeAfterPark).toBe(false);
      expect(scopeAfterPark).toBe("clear");
      expect(retried.lifecycleState).toBe("ready");
      expect(firstProbes).toBe(2);
      expect(later).toEqual(Array(10).fill("ready"));
      expect(leases.every(lease => lease.status === "released")).toBe(true);
    } finally { boxSwept = true; await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }).catch(() => {}); }
  }, 60_000);

  it("(b) box present and handoff pending: waits, then parks at the time bound with one alarm; the entry stays retained; Retry re-attempts once", async () => {
    const owner = `owner-${randomUUID()}`;
    const saved = await account(owner);
    const first = await hire("Pending handoff", owner);
    let retire!: () => void;
    const retired = new Promise<void>(resolve => { retire = resolve; });
    let firstProbes = 0;
    let probeHome = "";
    const { work } = harness(async (agentId, managed) => {
      if (agentId === first.id && firstProbes++ === 0) {
        probeHome = managed.home;
        throw new NativeEnvironmentProbeCleanupError(retired, undefined, [handoffRejected()]);
      }
      return pass();
    });
    const errors = vi.spyOn(logger, "error");
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    const stalledAlarms = () => errors.mock.calls.filter(call => (call[0] as { code?: unknown })?.code === "native_probe_cleanup_stalled");
    const later: string[] = [];
    const laterErrors: unknown[] = [];
    try {
      await work.process(first.id);
      const waiting = [await current(first.id), await retryLifecycle(work, first.id)];
      skew = PROBE_CLEANUP_PENDING_PARK_MS - 60_000;
      waiting.push(await retryLifecycle(work, first.id));
      skew = PROBE_CLEANUP_PENDING_PARK_MS + 1_000;
      const parked = await retryLifecycle(work, first.id);
      const alarmsAtPark = stalledAlarms().length;
      const homeWhileParked = await exists(probeHome);
      const retainedWhileParked = await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }).then(() => "clear", () => "pending");
      // The fake clock moves only Date.now (the bound's clock); the lifecycle
      // store's claims use new Date(), so other hires run on the real clock.
      skew = 0;
      for (let i = 0; i < 10; i++) {
        const agent = await hire(`Same connection ${i}`, owner);
        await work.process(agent.id);
        const row = await current(agent.id);
        later.push(row.lifecycleState);
        if (row.lifecycleState !== "ready") laterErrors.push(row.lifecycleError);
      }
      skew = PROBE_CLEANUP_PENDING_PARK_MS + 2_000;
      const reparked = await retryLifecycle(work, first.id);
      const alarmsAfterRetry = stalledAlarms().length;
      retire();
      skew = 0;
      await vi.waitFor(async () => expect(await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId })).toBeUndefined());
      const ready = await retryLifecycle(work, first.id);
      await receipt({ row: "b", waiting: waiting.map(a => ({ state: a.lifecycleState, retryRequired: (a.lifecycleOperation as { retryRequired?: boolean }).retryRequired ?? false })),
        parked: { operation: parked.lifecycleOperation, error: parked.lifecycleError }, alarmsAtPark, alarmsAfterRetry,
        alarmNamesResource: stalledAlarms()[0]?.[0], homeWhileParked, retainedWhileParked, reparked: reparked.lifecycleError, later, laterErrors,
        afterRetirement: ready.lifecycleState, firstProbes, homeAfterRetirement: await exists(probeHome) });
      expect(waiting.every(a => a.lifecycleState === "verifying" && !(a.lifecycleOperation as { retryRequired?: boolean }).retryRequired)).toBe(true);
      expect(parked.lifecycleOperation).toMatchObject({ retryRequired: true });
      expect(parked.lifecycleError).toContain("could not finish the test's cleanup");
      expect(parked.lifecycleError).toContain("Automatic verification is paused");
      expect(alarmsAtPark).toBe(1);
      expect(stalledAlarms()[0]![0]).toMatchObject({ agentId: first.id, runtimeHome: expect.stringContaining(probeHome) });
      expect(homeWhileParked).toBe(true);
      expect(retainedWhileParked).toBe("pending");
      expect(later).toEqual(Array(10).fill("ready"));
      expect(reparked.lifecycleOperation).toMatchObject({ retryRequired: true });
      expect(alarmsAfterRetry).toBe(1);
      expect(firstProbes).toBe(2);
      expect(ready.lifecycleState).toBe("ready");
      expect(await exists(probeHome)).toBe(false);
    } finally { retire(); await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }).catch(() => {}); }
  }, 60_000);
});
