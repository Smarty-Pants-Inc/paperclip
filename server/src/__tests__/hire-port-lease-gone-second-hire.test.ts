// hire-port (BRIEF-hp; live gate 3 06:02Z, capacity-lead): the FAULT ROW.
// Hire A's account-test box lease is gone at Boat, so retiring the AI
// credential is rejected with JsonRpc -32002 "Boat sandbox lease is no longer
// active". The in-memory cleanup entry keyed (company, AI grant) stays failed,
// and before the c1 fix EVERY later hire on that grant failed verify with
// native_probe_cleanup_pending until a restart. Here hire B is a DIFFERENT
// agent on the SAME grant. Friday already scopes retained cleanup to its
// agent: B may verify while A remains pending. Reconcile A's actual retained
// entry explicitly to test the imported own-lease proof without restoring the
// obsolete grant-wide hire gate. An ACTIVE A gets no receipt or cleanup.
//
// Runs unchanged at Friday's base and the port head. Where the port's
// retainManagedAiProbeCleanup export is absent, the fixture uses the original
// inline retention for this ordinary (not unrecoverable-close) error. B's
// readiness can already pass there; A's typed receipt settlement is the red.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { agents, companies, createDb, environmentLeases, environments, plugins, type Db } from "@paperclipai/db";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import type { LifecycleAgent } from "../modules/agent-lifecycle/application/ports.js";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import * as environmentTests from "../services/agent-environment-test.js";
import * as aiConnections from "../services/ai-connections.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import { reconcileRetainedAiCleanup, retainAiCredentialCleanup } from "../services/retained-ai-credential-cleanup.js";
import { unprocessable } from "../errors.js";
import { NativeEnvironmentProbeCleanupError } from "../vendor/paperclip-runner/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const LEASE_GONE = "Boat sandbox lease is no longer active.";
type Inspect = "stopped" | "destroyed" | "active";
const NEVER = ["environmentDestroyLease", "environmentStopLease", "environmentResumeLease", "environmentExecute", "environmentRunnerIngressEndpoint"];

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("hire-port fault row: a lease-gone retirement failure, then a SECOND hire on the same grant", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const stops: Array<() => Promise<void>> = [];
  const hired: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-hire-port-fault-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-19T06:02:00.000Z")); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop().catch(() => {});
    for (const id of hired.splice(0)) await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.id, id));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Boat: the setup-test box is released (void answer, no receipt), every
   * later call on it is refused -32002 "lease no longer active"; inspect gives
   * Boat's typed state of the box. Every call is recorded. */
  function boatWorker(pluginId: string, mode: { inspect: Inspect }) {
    let boxes = 0;
    const calls: Array<{ method: string; providerLeaseId?: string }> = [];
    const closed = new Set<string>();
    const methods = ["environmentAcquireLease", "environmentReleaseLease", "environmentDestroyLease", "environmentRealizeWorkspace", "environmentExecute", "environmentInspectLease"];
    const worker = {
      isRunning: (id: string) => id === pluginId,
      getWorker: () => ({ status: "running", supportedMethods: methods }),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string; lease?: { providerLeaseId?: string } }) => {
        const providerLeaseId = params.providerLeaseId ?? params.lease?.providerLeaseId;
        calls.push({ method, providerLeaseId });
        if (method === "environmentAcquireLease") return { providerLeaseId: `boat-box-${++boxes}`, metadata: { provider: "boat", remoteCwd: "/home/user/paperclip-workspace" } };
        if (method === "environmentRealizeWorkspace") return { cwd: "/home/user/paperclip-workspace" };
        if (method === "environmentExecute" && providerLeaseId && !closed.has(providerLeaseId)) return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
        if (method === "environmentReleaseLease") { if (providerLeaseId) closed.add(providerLeaseId); return undefined; }
        if (method === "environmentInspectLease") {
          return { providerLeaseId, state: mode.inspect, stoppedAt: mode.inspect === "stopped" ? "2026-11-19T06:01:00.000Z" : null, lastRebootAt: null, observedAt: null };
        }
        throw new JsonRpcCallError({ code: -32002, message: LEASE_GONE } as never);
      }),
    };
    return { worker: worker as unknown as PluginWorkerManager, calls };
  }

  async function fixture(inspect: Inspect) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "hire-port company", issuePrefix: `H${companyId.slice(0, 7)}` });
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: `paperclipai.plugin-boat.${pluginId.slice(0, 8)}`, packageName: "@paperclipai/plugin-boat",
      version: "0.1.17-spare.1", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1,
      manifestJson: { id: `paperclipai.plugin-boat.${pluginId.slice(0, 8)}`, apiVersion: 1, version: "0.1.17-spare.1", displayName: "Boat", description: "Boat",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", configSchema: { type: "object" } }] },
      updatedAt: new Date() } as never);
    const [environment] = await db.insert(environments).values({ name: `boat-${pluginId.slice(0, 8)}`, driver: "sandbox",
      config: { provider: "boat", reuseLease: false, timeoutMs: 1234 } }).returning();
    const mode = { inspect };
    const boat = boatWorker(pluginId, mode);
    // ONE AI grant for the company: every hire below selects it.
    const grantId = randomUUID();
    const hire = async (name: string) => {
      const [agent] = await db.insert(agents).values({ companyId, name, adapterType: "paperclip_runner",
        adapterConfig: { provider: "pi_rpc", model: "openrouter/fixture-model" }, defaultEnvironmentId: environment!.id,
        status: "paused", lifecycleState: "verifying", lifecycleRequiredPluginIds: [],
        runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "openrouter", method: "api_key" } },
        lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } }).returning();
      hired.push(agent!.id);
      return agent!;
    };
    return { companyId, environment: environment!, grantId, mode, boat, hire };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** Outside the boundary: credential selection and the Pi transport. Probe 1
   * (hire A) fails with the native cleanup error whose retirement is rejected
   * -32002 lease-gone; its retry is refused the same way. Later probes pass. */
  function probeBoundary(f: Fixture) {
    let probes = 0;
    const cleanup = vi.fn(async () => {});
    const leaseGone = () => new JsonRpcCallError({ code: -32002, message: LEASE_GONE } as never);
    const retry = vi.fn(async () => { throw leaseGone(); });
    const connections = aiConnections.aiConnectionService;
    vi.spyOn(aiConnections, "aiConnectionService").mockImplementation(database => ({ ...connections(database),
      select: async () => ({ connection: { credentialSecretRefs: [] }, grant: { id: f.grantId, credentialSecretRefs: [] }, attribution: { grantId: f.grantId, connectionId: f.grantId } }) as never,
    }));
    const tests = environmentTests.agentEnvironmentTestService;
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => {
      const real = tests(database, manager);
      return { ...real,
        resolveAdapterTestEnvironmentId: async (_c: string, environmentId: string | null | undefined) => environmentId ?? null,
        assertAdapterTestEnvironmentForCompany: async () => undefined,
        testManagedEnvironment: async () => {
          probes += 1;
          if (probes === 1) {
            const retired = Promise.reject(leaseGone()); void retired.catch(() => undefined);
            const ingress = Object.assign(new Error("runner ingress refused"), { name: "NativeRunnerIngressAcquisitionError" });
            throw new NativeEnvironmentProbeCleanupError(retired, ingress, [leaseGone()], retry);
          }
          return { adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(),
            checks: [{ code: "pi_hello_probe_passed", level: "info", message: "Fixture Pi hello passed" }] };
        } } as never;
    });
    const port = (aiRuntime as unknown as { retainManagedAiProbeCleanup?: (...args: unknown[]) => never }).retainManagedAiProbeCleanup;
    vi.spyOn(aiRuntime, "withManagedAiProbe").mockImplementation(async (database, input, probe) => {
      const runtime = { config: input.config, attribution: { grantId: f.grantId, connectionId: f.grantId },
        retainedCleanupScope: { companyId: input.companyId, accountKey: f.grantId }, home: undefined as string | undefined, cleanup };
      try { return await probe(runtime as never); }
      catch (error) {
        if (error instanceof NativeEnvironmentProbeCleanupError) {
          if (port) port(database, runtime, input, error);
          // c3c15054 withManagedAiProbe (no export): its inline retention, verbatim.
          const retryCleanup = (error as { retryCleanup?: () => Promise<void> }).retryCleanup;
          retainAiCredentialCleanup({ scope: runtime.retainedCleanupScope!, home: runtime.home && path.join(runtime.home, "provider"), cleanup: runtime.cleanup, retired: error.retired,
            agentId: (input as { agentId?: string }).agentId,
            ...(typeof retryCleanup === "function" ? { retryRetirement: () => retryCleanup.call(error) } : {}) });
          throw unprocessable("The native account test is still cleaning up. Retry after runtime cleanup completes.", { code: "native_probe_cleanup_pending" });
        }
        throw error;
      }
    });
    return { probes: () => probes, cleanup, retry, port: Boolean(port) };
  }

  function lifecycle(f: Fixture) {
    const store = createLifecycleStore(db, createAgentLifecycleEffects());
    const now = () => new Date(Date.now());
    const clockStore = { ...store,
      claim: (id: string, owner: string) => store.claim(id, owner, now()),
      renew: (row: LifecycleAgent, owner: string) => store.renew(row, owner, now()),
      defer: (...args: Parameters<typeof store.defer>) => store.defer(args[0], args[1], args[2], now(), args[4]),
    };
    const verifier = agentHarnessVerificationService(db, f.boat.worker);
    const runHost = vi.fn((agent: LifecycleAgent) => verifier.verify(agent));
    const work = createLifecycleWorker(clockStore, { requiredPluginIds: async () => [], runPlugin: async () => "complete" as const, runHost }, () => {});
    stops.push(() => work.stop());
    return { work, runHost };
  }
  const row = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
  const leases = async (environmentId: string) => db.select().from(environmentLeases).where(eq(environmentLeases.environmentId, environmentId)).orderBy(environmentLeases.createdAt);

  /** Hire A: the probe fails, its box lease is closed and gone at Boat, the
   * retirement is rejected -32002, and the grant's entry stays failed. */
  async function hireAFailsLeaseGone(f: Fixture) {
    const boundary = probeBoundary(f);
    const life = lifecycle(f);
    const a = await f.hire("Hire A");
    await life.work.process(a.id);
    expect(boundary.probes(), "hire A's probe ran once").toBe(1);
    const afterA = await row(a.id);
    expect(afterA.lifecycleState, "hire A is still verifying").toBe("verifying");
    const [probeLease] = await leases(f.environment.id);
    expect(probeLease, "hire A's setup-test lease is closed").toMatchObject({ heartbeatRunId: null, leasePolicy: "ephemeral" });
    expect(probeLease!.releasedAt).toBeTruthy();
    // No same-grant action has run yet: the entry is retained, its retirement rejected -32002.
    expect(boundary.retry, "no retry before the next same-grant action").not.toHaveBeenCalled();
    return { ...life, boundary, a, probeLease: probeLease! };
  }

  for (const state of ["stopped", "destroyed"] as const) {
    it(`FAULT ROW (Boat reads hire A's box ${state}): a second hire B on the SAME grant verifies; the entry leaves through cleanup(), no restart`, async () => {
      const f = await fixture(state);
      const { work, boundary, probeLease } = await hireAFailsLeaseGone(f);
      const b = await f.hire("Hire B");
      await work.process(b.id);
      const afterB = await row(b.id);
      // Friday's per-agent gate already admits B. The new receipt path must
      // settle A's retained entry through the real reconciler, independently.
      await expect(reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.grantId })).resolves.toBeUndefined();
      // Evidence line distinguishes B readiness from A's retirement proof.
      console.info(`[fault-row ${state}] port=${boundary.port} hireB=${JSON.stringify({ state: afterB.lifecycleState, error: afterB.lifecycleError, operation: afterB.lifecycleOperation })}`);
      expect({ state: afterB.lifecycleState, error: afterB.lifecycleError }, "hire B on the same grant is NOT blocked by native_probe_cleanup_pending")
        .toMatchObject({ state: "ready", error: null });
      expect(boundary.probes(), "hire B's own probe ran").toBe(2);
      expect(boundary.retry, "Boat's typed state is read before the -32002 transport retry").not.toHaveBeenCalled();
      expect(boundary.cleanup, "the grant's entry left through cleanup()").toHaveBeenCalledOnce();
      // A and B share a fake timestamp; row order is not lease identity.
      const proved = (await leases(f.environment.id)).find(lease => lease.id === probeLease.id);
      expect(proved!.id).toBe(probeLease.id);
      expect(proved!.metadata?.remoteExecutionTermination, "the receipt on hire A's OWN lease, from Boat's typed state")
        .toMatchObject({ runId: null, leaseId: probeLease.id, providerLeaseId: probeLease.providerLeaseId, state });
      expect(f.boat.calls.filter(c => c.providerLeaseId === probeLease.providerLeaseId && NEVER.includes(c.method)), "nothing started/stopped/destroyed hire A's box").toEqual([]);
      await expect(reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.grantId })).resolves.toBeUndefined();
    });
  }

  it("NEVER HIDE: ACTIVE A keeps its pending cleanup without a receipt; Friday's independent same-grant hire B still verifies", async () => {
    const f = await fixture("active");
    const { work, boundary, probeLease, a } = await hireAFailsLeaseGone(f);
    const b = await f.hire("Hire B");
    await work.process(b.id);
    const afterB = await row(b.id);
    console.info(`[never-hide] port=${boundary.port} hireB=${JSON.stringify({ state: afterB.lifecycleState, error: afterB.lifecycleError, operation: afterB.lifecycleOperation })}`);
    expect(afterB.lifecycleState, "Friday does not gate B on A's retained cleanup").toBe("ready");
    expect(afterB.lifecycleError).toBeNull();
    const afterA = await row(a.id);
    expect(afterA.lifecycleState, "A's actual failure is not hidden").toBe("verifying");
    if (boundary.port) expect(afterA.lifecycleError)
      .toBe("The last account test has not confirmed its test computer stopped; Paperclip will retry automatically.");
    await expect(reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.grantId })).rejects.toMatchObject({ details: { code: "ai_credential_cleanup_pending" } });
    expect(boundary.retry, "no typed proof, so A's -32002 transport retry ran and was refused").toHaveBeenCalled();
    expect(boundary.probes(), "B ran its own independent probe").toBe(2);
    expect(boundary.cleanup).not.toHaveBeenCalled();
    const still = (await leases(f.environment.id)).find(lease => lease.id === probeLease.id);
    expect(still!.metadata?.remoteExecutionTermination, "no receipt from an active box").toBeUndefined();
    await expect(reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.grantId })).rejects.toMatchObject({ details: { code: "ai_credential_cleanup_pending" } });
  });
});
