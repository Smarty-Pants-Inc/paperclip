import { appendFile, mkdtemp, realpath, rm, chmod, writeFile, stat } from "node:fs/promises";
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
import { PROBE_CLEANUP_BEFORE_RELEASE_MS } from "../../../services/ai-connection-runtime.js";
import { NativeEnvironmentProbeCleanupError } from "../../../vendor/paperclip-runner/index.js";

// Real: lifecycle worker + store, harness verifier, AI connection selection,
// prepareManagedAiRuntime/withManagedAiProbe and the retained-cleanup gate.
// Fake: the native probe itself and the probe box (SQL lease receipts only).
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("unrecoverable probe close releases its box within the cleanup bound", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;
  let companyId: string;
  const workers: Array<{ stop(): Promise<void> }> = [];
  const model = "openrouter/deepseek/deepseek-v4.1-flash-1017";
  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-bound-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "probe-cleanup-bound");
    database = await startEmbeddedPostgresTestDatabase("paperclip-probe-bound-");
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
  function harness(probe: (agentId: string, managed: { home: string }) => Promise<ReturnType<typeof pass>>) {
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
      testManagedEnvironment: async (_adapter: string, _input: unknown, _binding: unknown, managed: { home: string }, agentId: string) => probe(agentId, managed),
    }) as never);
    const verifier = agentHarnessVerificationService(db, {} as never);
    const work = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: row => verifier.verify(row) });
    workers.push(work);
    return { work, released };
  }
  const unrecoverableClose = () => Object.assign(new Error("provider_transport_failed: runner did not durably suspend before checkpoint"),
    { code: "native_session_close_unrecoverable" });
  const SLACK_MS = 3_000;

  it("a hung runtime cleanup does not hold the probe box: release within the bound, truthful park, entry owned, ten other hires ready", async () => {
    const owner = `owner-${randomUUID()}`;
    const saved = await account(owner);
    const first = await hire("Hung cleanup", owner);
    let openGate!: () => void;
    const gate = new Promise<void>(resolve => { openGate = resolve; });
    let failedHome = "";
    let firstProbes = 0;
    const { work, released } = harness(async (agentId, managed) => {
      if (agentId === first.id && firstProbes++ === 0) {
        failedHome = managed.home;
        // The real cleanup, held behind a gate: a cleanup that does not settle (until the test opens it).
        const runtime = managed as unknown as { cleanup: () => Promise<void> };
        const real = runtime.cleanup;
        runtime.cleanup = () => gate.then(real);
        throw new NativeEnvironmentProbeCleanupError(new Promise<void>(() => {}), new Error("fixture failed verification"), [unrecoverableClose()]);
      }
      return pass();
    });
    const started = Date.now();
    const processing = work.process(first.id);
    let releasedAfterMs: number | null = null;
    try {
      await vi.waitFor(() => expect(released.some(row => row.agentId === first.id)).toBe(true),
        { timeout: PROBE_CLEANUP_BEFORE_RELEASE_MS + SLACK_MS, interval: 25 });
      releasedAfterMs = Date.now() - started;
      await processing;
      const failed = await current(first.id);
      const homeWhileParked = await stat(failedHome).then(() => true, () => false);
      const ownOnly = await Promise.race([
        reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }, { agentId: first.id }).then(() => "settled", () => "rejected"),
        new Promise(resolve => setTimeout(resolve, 200, "still running")),
      ]);
      const later = [];
      for (let i = 0; i < 10; i++) {
        const agent = await hire(`After hung cleanup ${i}`, owner);
        await work.process(agent.id);
        later.push(await current(agent.id));
      }
      openGate();
      await vi.waitFor(async () => expect(await stat(failedHome).then(() => true, () => false)).toBe(false), { timeout: 5_000 });
      const afterReconcile = await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }).then(() => "complete", (e: { details?: unknown }) => e.details);
      const summary = { kind: "hung-cleanup", bound: PROBE_CLEANUP_BEFORE_RELEASE_MS, releasedAfterMs, firstState: failed.lifecycleState,
        firstOperation: failed.lifecycleOperation, firstError: failed.lifecycleError, homeWhileParked, ownEntryWhileRunning: ownOnly,
        ready: later.filter(a => a.lifecycleState === "ready").length, afterReconcile, released };
      console.info("PROBE_CLEANUP_BOUND", JSON.stringify(summary));
      if (process.env.PROBE_GATE_RECEIPTS) await appendFile(process.env.PROBE_GATE_RECEIPTS, `${JSON.stringify(summary)}\n`);
      expect(releasedAfterMs).toBeLessThanOrEqual(PROBE_CLEANUP_BEFORE_RELEASE_MS + SLACK_MS);
      expect(released.find(row => row.agentId === first.id)?.outcome).toBe("failed");
      expect(failed.lifecycleOperation).toMatchObject({ retryRequired: true });
      expect(failed.lifecycleError).toContain("could not finish the test's cleanup");
      expect(failed.lifecycleError).not.toContain("Paperclip finished the test's cleanup.");
      expect(homeWhileParked).toBe(true);
      // The retained entry is this agent's own: its own reconcile joins the still-running cleanup.
      expect(ownOnly).toBe("still running");
      expect(later.map(a => a.lifecycleState)).toEqual(Array(10).fill("ready"));
      expect(afterReconcile).toBe("complete");
    } finally {
      openGate();
      await processing.catch(() => undefined);
      await reconcileRetainedAiCleanup({ companyId, accountKey: saved.grantId }).catch(() => {});
    }
  }, PROBE_CLEANUP_BEFORE_RELEASE_MS + 40_000);

  it("a fast runtime cleanup is unchanged: release at once, cleanup finished", async () => {
    const owner = `owner-${randomUUID()}`;
    await account(owner);
    const first = await hire("Fast cleanup", owner);
    let firstHome = "";
    let firstProbes = 0;
    const { work, released } = harness(async (agentId, managed) => {
      if (agentId === first.id && firstProbes++ === 0) {
        firstHome = managed.home;
        throw new NativeEnvironmentProbeCleanupError(new Promise<void>(() => {}), new Error("fixture failed verification"), [unrecoverableClose()]);
      }
      return pass();
    });
    const started = Date.now();
    await work.process(first.id);
    const elapsed = Date.now() - started;
    const failed = await current(first.id);
    const summary = { kind: "fast-cleanup", elapsed, firstError: failed.lifecycleError, released };
    console.info("PROBE_CLEANUP_FAST", JSON.stringify(summary));
    if (process.env.PROBE_GATE_RECEIPTS) await appendFile(process.env.PROBE_GATE_RECEIPTS, `${JSON.stringify(summary)}\n`);
    expect(elapsed).toBeLessThan(PROBE_CLEANUP_BEFORE_RELEASE_MS);
    expect(released.filter(row => row.agentId === first.id)).toHaveLength(1);
    expect(failed.lifecycleError).toContain("Paperclip finished the test's cleanup.");
    expect(await stat(firstHome).then(() => true, () => false)).toBe(false);
  });
});
