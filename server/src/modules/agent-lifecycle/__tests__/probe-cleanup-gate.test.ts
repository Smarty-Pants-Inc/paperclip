import { appendFile, mkdtemp, realpath, rm } from "node:fs/promises";
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
import { reconcileRetainedAiCleanup } from "../../../services/retained-ai-credential-cleanup.js";
import { NativeEnvironmentProbeCleanupError } from "../../../vendor/paperclip-runner/index.js";

// Real: lifecycle worker + store, harness verifier, AI connection selection,
// prepareManagedAiRuntime/withManagedAiProbe and the retained-cleanup gate.
// Fake: the native probe itself and the probe box (SQL lease receipts only).
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native probe cleanup gate across hires", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let companyId: string;
  const workers: Array<{ stop(): Promise<void> }> = [];
  const model = "openrouter/deepseek/deepseek-v4.1-flash-1017";
  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-gate-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "probe-cleanup-gate");
    database = await startEmbeddedPostgresTestDatabase("paperclip-probe-gate-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Probe cleanup gate", issuePrefix: `P${companyId.slice(0, 7)}` });
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.stop();
    vi.restoreAllMocks();
    await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.companyId, companyId));
  });
  const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;

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
  function harness(probe: (agentId: string) => Promise<ReturnType<typeof pass>>) {
    const released: Array<{ agentId: string; outcome?: string }> = [];
    const tests = environmentTests.agentEnvironmentTestService;
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => ({ ...tests(database, manager),
      resolveAdapterTestEnvironmentId: async () => null,
      resolveAdapterTestExecutionContext: async ({ agentId }: { agentId: string }) => {
        const [lease] = await db.insert(environmentLeases).values({ companyId, provider: "fixture", providerLeaseId: randomUUID() }).returning();
        return { executionTarget: null, environmentName: null, fallbackChecks: [], release: async (outcome?: string) => {
          await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() }).where(eq(environmentLeases.id, lease.id));
          released.push({ agentId, outcome });
        } };
      },
      testManagedEnvironment: async (_adapter: string, _input: unknown, _binding: unknown, _managed: unknown, agentId: string) => probe(agentId),
    }) as never);
    const verifier = agentHarnessVerificationService(db, {} as never);
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: row => verifier.verify(row) });
    workers.push(work);
    return { work, released };
  }
  const unrecoverableClose = () => Object.assign(new Error("provider_transport_failed: runner did not durably suspend before checkpoint"),
    { code: "native_session_close_unrecoverable" });

  it.each(["rejects", "never settles"] as const)("after an unrecoverable close whose retirement %s, the next ten hires on that connection become ready", async retirement => {
    const owner = `owner-${randomUUID()}`;
    const saved = await account(owner);
    const retired = retirement === "rejects" ? Promise.reject(new Error("fixture retirement proof unavailable")) : new Promise<void>(() => {});
    void retired.catch(() => undefined);
    const retryCleanup = vi.fn(async () => { throw new Error("fixture retirement proof unavailable"); });
    const first = await hire("First", owner);
    let firstProbes = 0;
    const { work, released } = harness(async agentId => {
      if (agentId === first.id && firstProbes++ === 0) throw new NativeEnvironmentProbeCleanupError(retired, new Error("fixture probe failed"), [unrecoverableClose()], retryCleanup);
      return pass();
    });
    await work.process(first.id);
    await Promise.resolve();
    const later = [];
    for (let index = 0; index < 10; index++) {
      const agent = await hire(`Later ${index}`, owner);
      await work.process(agent.id);
      later.push(await current(agent.id));
    }
    const failed = await current(first.id);
    const summary = { retirement, firstState: failed.lifecycleState, firstOperation: failed.lifecycleOperation, firstError: failed.lifecycleError,
      ready: later.filter(row => row.lifecycleState === "ready").length,
      laterErrors: later.map(row => row.lifecycleError).filter(Boolean), released };
    console.info("PROBE_CLEANUP_GATE", JSON.stringify(summary));
    if (process.env.PROBE_GATE_RECEIPTS) await appendFile(process.env.PROBE_GATE_RECEIPTS, `${JSON.stringify(summary)}\n`);
    expect(later.map(row => row.lifecycleState)).toEqual(Array(10).fill("ready"));
    // The owning agent is in a true paused failure with Retry, not endless verifying retries.
    expect(failed.lifecycleState).toBe("verifying");
    expect(failed.lifecycleOperation).toMatchObject({ retryRequired: true });
    expect(failed.lifecycleOperation).not.toHaveProperty("retryAt");
    expect(failed.lifecycleError).toContain("could not be closed cleanly");
    expect(failed.lifecycleError).toContain("choose Retry now");
    // Every acquired probe box was released; nothing remains retained for the account.
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId));
    expect(leases).toHaveLength(11);
    expect(leases.every(lease => lease.status === "released" && lease.releasedAt !== null)).toBe(true);
    await expect(reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId })).resolves.toBeUndefined();
    // Retry tests the first agent again; its next probe passes.
    await createAgentLifecycle(db).retry(first.id);
    await work.process(first.id);
    expect((await current(first.id)).lifecycleState).toBe("ready");
    expect(firstProbes).toBe(2);
  });

  it("a recoverable pending retirement gates only its own agent's next probe; other hires on the same and another connection proceed", async () => {
    const owner = `owner-${randomUUID()}`, otherOwner = `other-${randomUUID()}`;
    const saved = await account(owner);
    await account(otherOwner);
    let retire!: () => void;
    const retired = new Promise<void>(resolve => { retire = resolve; });
    const first = await hire("First", owner);
    let firstProbes = 0;
    const { work } = harness(async agentId => {
      if (agentId === first.id && firstProbes++ === 0) throw new NativeEnvironmentProbeCleanupError(retired, new Error("fixture probe interrupted"), [new Error("fixture close still settling")]);
      return pass();
    });
    try {
      await work.process(first.id);
      expect((await current(first.id)).lifecycleOperation).not.toHaveProperty("retryRequired");
      const same = await hire("Same connection", owner);
      await work.process(same.id);
      expect((await current(same.id)).lifecycleState).toBe("ready");
      const control = await hire("Other connection", otherOwner);
      await work.process(control.id);
      expect((await current(control.id)).lifecycleState).toBe("ready");
      // Its own retry still waits for its own retirement: no second box before the first is retired.
      await createAgentLifecycle(db).retry(first.id);
      await work.process(first.id);
      expect((await current(first.id)).lifecycleState).toBe("verifying");
      expect(firstProbes).toBe(1);
      retire();
      await vi.waitFor(async () => expect(await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId })).toBeUndefined());
      await createAgentLifecycle(db).retry(first.id);
      await work.process(first.id);
      expect((await current(first.id)).lifecycleState).toBe("ready");
      expect(firstProbes).toBe(2);
      const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, companyId));
      expect(leases).toHaveLength(4);
      expect(leases.every(lease => lease.status === "released" && lease.releasedAt !== null)).toBe(true);
    } finally { retire(); await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }).catch(() => {}); }
  });
});
