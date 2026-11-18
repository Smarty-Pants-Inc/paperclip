// probecleanup-f5 (BRIEF-f5; RFL SUPERSEDE-HIRE-PROBE-1118 §C): the retained
// retry re-reads Boat's TYPED state for the probe's OWN closed, non-reusable
// setup-test lease (upstream #20766's confirm shape) and, only on a typed
// stopped/destroyed answer, writes the termination receipt on THAT lease with
// the release's own writer; the existing reader confirms it and the entry
// leaves through cleanup(). No destroy, stop or resume is ever sent. A closed
// setup-test box can never be started again (the server's start fence).
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins, type Db } from "@paperclipai/db";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import type { LifecycleAgent } from "../modules/agent-lifecycle/application/ports.js";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import * as environmentTests from "../services/agent-environment-test.js";
import * as aiConnections from "../services/ai-connections.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { reconcileRetainedAiCleanup } from "../services/retained-ai-credential-cleanup.js";
import { NativeEnvironmentProbeCleanupError } from "../vendor/paperclip-runner/index.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const FIRST_LINE = "The last account test has not confirmed its test computer stopped; Paperclip will retry automatically.";
const PARKED_LINE = "The last account test has not confirmed its test computer stopped. Press Retry after a few minutes; if it stays stuck, tell your operator.";
const BOAT_REFUSAL = "Boat sandbox lease is no longer active.";
const MINUTE = 60_000;

/** Boat 0.1.17-spare.1 release answers: stopSandbox's {state:"stopped"} (gate 3),
 * a void answer that binds no receipt (gate 4's feb8896f row), or a failure. */
type Release = "stopped" | "void" | "throws";
/** Boat's typed onEnvironmentInspectLease answers (plugin.ts:1976-2016). */
type Inspect = "stopped" | "destroyed" | "active" | "unknown" | "throws" | "absent";
const NEVER = ["environmentDestroyLease", "environmentStopLease", "environmentResumeLease", "environmentExecute", "environmentRunnerIngressEndpoint"];

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("hire probe F5: Boat's typed re-read of the probe's own closed box (#20766 shape)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const stops: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-probe-cleanup-f5-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z")); });
  const hired: string[] = [];
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop().catch(() => {});
    for (const id of hired.splice(0)) await db.update(agents).set({ lifecycleState: "terminated", status: "terminated" }).where(eq(agents.id, id));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The Boat sandbox-provider worker shape (driverKey "boat"). Release answers
   * per gate; inspect answers Boat's typed state; anything else after the
   * release is refused by lease-gates.ts:41 with -32002. Every call is recorded. */
  function boatWorker(pluginId: string, mode: { release: Release; inspect: Inspect }) {
    let boxes = 0;
    const calls: Array<{ method: string; providerLeaseId?: string }> = [];
    const methods = ["environmentAcquireLease", "environmentReleaseLease", "environmentDestroyLease", "environmentRealizeWorkspace", "environmentExecute", "environmentInspectLease"];
    const worker = {
      isRunning: (id: string) => id === pluginId,
      getWorker: () => ({ status: "running", supportedMethods: mode.inspect === "absent" ? methods.filter(m => m !== "environmentInspectLease") : methods }),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string; lease?: { providerLeaseId?: string } }) => {
        const providerLeaseId = params.providerLeaseId ?? params.lease?.providerLeaseId;
        calls.push({ method, providerLeaseId });
        if (method === "environmentAcquireLease") return { providerLeaseId: `boat-box-${++boxes}`, metadata: { provider: "boat", remoteCwd: "/home/user/paperclip-workspace" } };
        if (method === "environmentRealizeWorkspace") return { cwd: "/home/user/paperclip-workspace" };
        if (method === "environmentReleaseLease") {
          if (mode.release === "throws") throw new JsonRpcCallError({ code: -32002, message: "Boat stop did not complete" } as never);
          return mode.release === "void" ? undefined : { providerLeaseId, state: "stopped" };
        }
        if (method === "environmentInspectLease") {
          if (mode.inspect === "throws") throw new JsonRpcCallError({ code: -32603, message: "Boat API timed out" } as never);
          return { providerLeaseId, state: mode.inspect, stoppedAt: mode.inspect === "stopped" ? "2026-11-18T09:59:00.000Z" : null, lastRebootAt: null, observedAt: null };
        }
        throw new JsonRpcCallError({ code: -32002, message: BOAT_REFUSAL } as never);
      }),
    };
    return { worker: worker as unknown as PluginWorkerManager, calls };
  }

  async function fixture(input: { release: Release; inspect: Inspect; reuseLease?: boolean }) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "F5 test company", issuePrefix: `F${companyId.slice(0, 7)}` });
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: `paperclipai.plugin-boat.${pluginId.slice(0, 8)}`, packageName: "@paperclipai/plugin-boat",
      version: "0.1.17-spare.1", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1,
      manifestJson: { id: `paperclipai.plugin-boat.${pluginId.slice(0, 8)}`, apiVersion: 1, version: "0.1.17-spare.1", displayName: "Boat", description: "Boat",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", configSchema: { type: "object" } }] },
      updatedAt: new Date() } as never);
    const [environment] = await db.insert(environments).values({ name: `boat-${pluginId.slice(0, 8)}`, driver: "sandbox",
      config: { provider: "boat", reuseLease: input.reuseLease ?? false, timeoutMs: 1234 } }).returning();
    const mode = { release: input.release, inspect: input.inspect };
    const boat = boatWorker(pluginId, mode);
    const accountKey = randomUUID();
    const [agent] = await db.insert(agents).values({ companyId, name: "Pi hire", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", model: "openrouter/fixture-model" }, defaultEnvironmentId: environment!.id,
      status: "paused", lifecycleState: "verifying", lifecycleRequiredPluginIds: [],
      runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "openrouter", method: "api_key" } },
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } }).returning();
    hired.push(agent!.id);
    return { companyId, environment: environment!, agent: agent!, accountKey, mode, boat };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  /** Outside the boundary: credential selection and the Pi transport. The
   * verifier, the setup-test lease acquire/release/inspect through the real
   * runtime and plugin path, the retained owner and the lifecycle are real. The
   * first probe fails like gate 4: runner ingress refused during a Boat
   * slowdown, then the step "releasing original probe authority" fails. */
  function probeBoundary(f: Fixture) {
    let probes = 0;
    const cleanup = vi.fn(async () => {});
    const retry = vi.fn(async () => { throw new Error("Native probe authority release remains unconfirmed"); });
    const connections = aiConnections.aiConnectionService;
    vi.spyOn(aiConnections, "aiConnectionService").mockImplementation(database => ({ ...connections(database),
      select: async () => ({ connection: { credentialSecretRefs: [] }, grant: { id: f.accountKey, credentialSecretRefs: [] }, attribution: { grantId: f.accountKey, connectionId: f.accountKey } }) as never,
    }));
    const tests = environmentTests.agentEnvironmentTestService;
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => {
      const real = tests(database, manager);
      return { ...real,
        resolveAdapterTestEnvironmentId: async (_c: string, environmentId: string | null | undefined) => environmentId ?? null,
        assertAdapterTestEnvironmentForCompany: async () => undefined,
        testManagedEnvironment: async (_type: string, input: { executionTarget?: unknown }) => {
          probes += 1;
          expect(input.executionTarget).toMatchObject({ kind: "remote", transport: "sandbox", leaseId: expect.any(String) });
          if (probes === 1) {
            const retired = Promise.reject(new Error("Native probe authority release remains unconfirmed")); void retired.catch(() => undefined);
            const ingress = Object.assign(new Error("runner ingress refused"), { name: "NativeRunnerIngressAcquisitionError" });
            throw new NativeEnvironmentProbeCleanupError(retired, ingress, [new Error("Native setup probe authority release is unconfirmed; recovery state retained.")], retry);
          }
          return { adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(),
            checks: [{ code: "pi_hello_probe_passed", level: "info", message: "Fixture Pi hello passed" }] };
        } } as never;
    });
    const realWith = aiRuntime.withManagedAiProbe;
    vi.spyOn(aiRuntime, "withManagedAiProbe").mockImplementation(async (database, input, probe) => {
      const runtime = { config: input.config, attribution: { grantId: f.accountKey, connectionId: f.accountKey },
        retainedCleanupScope: { companyId: input.companyId, accountKey: f.accountKey }, home: undefined, cleanup };
      void realWith;
      try { return await probe(runtime as never); }
      catch (error) {
        if (error instanceof NativeEnvironmentProbeCleanupError) aiRuntime.retainManagedAiProbeCleanup(database, runtime, input as never, error);
        throw error;
      }
    });
    return { probes: () => probes, cleanup, retry };
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
  async function untilRetryAt(id: string) {
    const retryAt = (await row(id)).lifecycleOperation?.retryAt;
    expect(retryAt, "a durable retryAt").toEqual(expect.any(String));
    vi.setSystemTime(new Date(Date.parse(retryAt!) + 1));
  }
  const after = (f: Fixture, index: number) => f.boat.calls.slice(index).map(call => call.method);

  /** First lifecycle pass: the probe fails, the verifier releases its lease. */
  async function firstPass(f: Fixture) {
    const boundary = probeBoundary(f);
    const life = lifecycle(f);
    await life.work.process(f.agent.id);
    expect(boundary.probes()).toBe(1);
    expect(await row(f.agent.id)).toMatchObject({ lifecycleState: "verifying", lifecycleError: FIRST_LINE });
    const [probeLease] = await leases(f.environment.id);
    return { ...life, boundary, probeLease: probeLease! };
  }

  async function expectClears(f: Fixture, state: "stopped" | "destroyed") {
    const { work, runHost, boundary, probeLease } = await firstPass(f);
    const mark = f.boat.calls.length;
    await untilRetryAt(f.agent.id);
    await work.process(f.agent.id);
    const [proved, successor] = await leases(f.environment.id);
    expect(proved!.id).toBe(probeLease.id);
    expect(proved!.metadata?.remoteExecutionTermination, "the receipt is written on THAT lease from Boat's typed state")
      .toMatchObject({ schema: "paperclip.remote-termination.v1", runId: null, leaseId: probeLease.id, providerLeaseId: probeLease.providerLeaseId, state });
    expect(proved).toMatchObject({ status: probeLease.status, cleanupStatus: "success" });
    expect(boundary.cleanup, "the entry leaves through cleanup()").toHaveBeenCalledOnce();
    expect(boundary.retry, "the typed proof is read before the transport retry").not.toHaveBeenCalled();
    expect(boundary.probes()).toBe(2);
    expect(runHost).toHaveBeenCalledTimes(2);
    expect((await row(f.agent.id)).lifecycleState, "the hire verifies with no restart").not.toBe("verifying");
    expect(successor?.providerLeaseId, "the successor probe is on ANOTHER box").toBeTruthy();
    expect(successor!.providerLeaseId).not.toBe(probeLease.providerLeaseId);
    const calls = after(f, mark);
    expect(calls.filter(m => m === "environmentInspectLease")).toHaveLength(1);
    expect(f.boat.calls.filter(c => c.providerLeaseId === probeLease.providerLeaseId && NEVER.includes(c.method)), "no destroy/stop/resume/start of the old box").toEqual([]);
    await expect(reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.accountKey })).resolves.toBeUndefined();
  }

  async function expectNoReceipt(f: Fixture, probeLease: { id: string; providerLeaseId: string | null }, boundary: ReturnType<typeof probeBoundary>) {
    const [now] = await leases(f.environment.id);
    expect(now!.id).toBe(probeLease.id);
    expect(now!.metadata?.remoteExecutionTermination?.state === "stopped" && now!.metadata?.remoteExecutionTermination?.confirmedBy === "inspect", "no inspect receipt").toBe(false);
    expect(boundary.cleanup).not.toHaveBeenCalled();
    expect(boundary.probes()).toBe(1);
    expect(f.boat.calls.filter(c => c.providerLeaseId === probeLease.providerLeaseId && NEVER.includes(c.method))).toEqual([]);
  }

  it("RED gate 4 (feb8896f): lease 'failed' (adapter_or_run_failure), released, no receipt, no runnerTaskProbe, box archived per inspect → receipt written, hire verifies, no restart", async () => {
    const f = await fixture({ release: "void", inspect: "stopped" });
    // Pin the exact gate-4 row before the retry.
    const life = await (async () => {
      const boundary = probeBoundary(f);
      const l = lifecycle(f);
      await l.work.process(f.agent.id);
      return { ...l, boundary };
    })();
    const [gate4] = await leases(f.environment.id);
    expect(gate4).toMatchObject({ status: "failed", failureReason: "adapter_or_run_failure", heartbeatRunId: null, issueId: null, leasePolicy: "ephemeral" });
    expect(gate4!.releasedAt).toBeTruthy();
    expect(gate4!.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(gate4!.metadata?.runnerTaskProbe).toBeUndefined();
    await untilRetryAt(f.agent.id);
    await life.work.process(f.agent.id);
    const [proved, successor] = await leases(f.environment.id);
    expect(proved!.metadata?.remoteExecutionTermination).toMatchObject({ runId: null, leaseId: gate4!.id, providerLeaseId: gate4!.providerLeaseId, state: "stopped" });
    expect(proved).toMatchObject({ status: "failed", cleanupStatus: "success" });
    expect(life.boundary.cleanup).toHaveBeenCalledOnce();
    expect(life.boundary.retry).not.toHaveBeenCalled();
    expect((await row(f.agent.id)).lifecycleState).not.toBe("verifying");
    expect(successor!.providerLeaseId).not.toBe(gate4!.providerLeaseId);
    expect(f.boat.calls.filter(c => c.providerLeaseId === gate4!.providerLeaseId && NEVER.includes(c.method))).toEqual([]);
  });

  it("RED gate 3: a 'stopped' release receipt + box archived per inspect → the same (receipt re-written from the typed read; hire verifies)", async () => {
    await expectClears(await fixture({ release: "stopped", inspect: "stopped" }), "stopped");
  });

  it("RED destroyed: Boat reads the box destroyed → receipt 'destroyed', hire verifies", async () => {
    await expectClears(await fixture({ release: "void", inspect: "destroyed" }), "destroyed");
  });

  for (const inspect of ["active", "unknown", "throws"] as const) {
    it(`RED inspect '${inspect}': no receipt, the true line, park at 30 min; nothing touches the box`, async () => {
      const f = await fixture({ release: "void", inspect });
      const { work, boundary, probeLease } = await firstPass(f);
      for (let step = 0; step < 12 && !(await row(f.agent.id)).lifecycleOperation?.retryRequired; step++) {
        await untilRetryAt(f.agent.id);
        await work.process(f.agent.id);
        const current = await row(f.agent.id);
        if (!current.lifecycleOperation?.retryRequired) expect(current.lifecycleError).toBe(FIRST_LINE);
      }
      expect(await row(f.agent.id)).toMatchObject({ lifecycleState: "verifying", lifecycleError: PARKED_LINE, lifecycleOperation: { retryRequired: true } });
      expect(f.boat.calls.filter(c => c.method === "environmentInspectLease").length).toBeGreaterThan(0);
      await expectNoReceipt(f, probeLease, boundary);
      expect((await leases(f.environment.id))[0]!.metadata?.remoteExecutionTermination).toBeUndefined();
    });
  }

  it("RED Boat down: no receipt, the line, park; Retry re-reads Boat once and clears when Boat is back", async () => {
    const f = await fixture({ release: "void", inspect: "throws" });
    const { work, boundary, probeLease } = await firstPass(f);
    for (let step = 0; step < 12 && !(await row(f.agent.id)).lifecycleOperation?.retryRequired; step++) {
      await untilRetryAt(f.agent.id);
      await work.process(f.agent.id);
    }
    expect(await row(f.agent.id)).toMatchObject({ lifecycleError: PARKED_LINE, lifecycleOperation: { retryRequired: true } });
    await expectNoReceipt(f, probeLease, boundary);
    f.mode.inspect = "stopped";
    const mark = f.boat.calls.length;
    await createAgentLifecycle(db).retry(f.agent.id);
    await work.process(f.agent.id);
    expect(after(f, mark).filter(m => m === "environmentInspectLease"), "Retry re-reads Boat once").toHaveLength(1);
    expect((await leases(f.environment.id))[0]!.metadata?.remoteExecutionTermination).toMatchObject({ leaseId: probeLease.id, state: "stopped" });
    expect(boundary.cleanup).toHaveBeenCalledOnce();
    expect((await row(f.agent.id)).lifecycleState).not.toBe("verifying");
  });

  it("RED never on an ACTIVE lease: Boat 'stopped' on the probe's still-open lease writes nothing", async () => {
    const f = await fixture({ release: "void", inspect: "stopped" });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: f.boat.worker });
    const acquired = await runtime.acquireRunLease({ companyId: f.companyId, agentId: f.agent.id, adapterType: "paperclip_runner",
      environment: f.environment as never, configuredEnvironment: f.environment as never, issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null } as never);
    expect(acquired.lease.status).toBe("active");
    expect(await runtime.confirmProbeLeaseTermination({ companyId: f.companyId, leaseId: acquired.lease.id })).toBe(false);
    const [still] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.lease.id));
    expect(still!.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(f.boat.calls.filter(c => c.method === "environmentInspectLease")).toEqual([]);
  });

  it("RED never on a REUSABLE lease, a closed one-off RUN lease of the same company+account, or another company's lease", async () => {
    const f = await fixture({ release: "void", inspect: "stopped" });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: f.boat.worker });
    const acquired = await runtime.acquireRunLease({ companyId: f.companyId, agentId: f.agent.id, adapterType: "paperclip_runner",
      environment: f.environment as never, configuredEnvironment: f.environment as never, issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null } as never);
    await runtime.getDriver("sandbox")!.releaseRunLease({ environment: f.environment as never, lease: acquired.lease, status: "failed" });
    const [closed] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.lease.id));
    expect(closed).toMatchObject({ status: "failed", leasePolicy: "ephemeral", heartbeatRunId: null });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agent.id, invocationSource: "manual", status: "failed" } as never);
    const variants = [
      { name: "reusable", set: { leasePolicy: "reuse_by_environment" } },
      { name: "a closed one-off RUN lease", set: { heartbeatRunId: runId } },
    ] as const;
    for (const variant of variants) {
      await db.update(environmentLeases).set({ leasePolicy: "ephemeral", heartbeatRunId: null }).where(eq(environmentLeases.id, closed!.id));
      await db.update(environmentLeases).set(variant.set as never).where(eq(environmentLeases.id, closed!.id));
      expect(await runtime.confirmProbeLeaseTermination({ companyId: f.companyId, leaseId: closed!.id }), variant.name).toBe(false);
      const [now] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, closed!.id));
      expect(now!.metadata?.remoteExecutionTermination, variant.name).toBeUndefined();
    }
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral", heartbeatRunId: null }).where(eq(environmentLeases.id, closed!.id));
    expect(await runtime.confirmProbeLeaseTermination({ companyId: randomUUID(), leaseId: closed!.id }), "another company").toBe(false);
    expect(f.boat.calls.filter(c => c.method === "environmentInspectLease"), "no read for a refused lease").toEqual([]);
    // The control: the same closed one-off setup-test lease IS proved.
    expect(await runtime.confirmProbeLeaseTermination({ companyId: f.companyId, leaseId: closed!.id })).toBe(true);
  });

  it("RED never for ANOTHER lease: the entry's proof reads only its own lease, never a sibling box's typed state", async () => {
    const f = await fixture({ release: "void", inspect: "active" });
    const { work, boundary, probeLease } = await firstPass(f);
    // A sibling closed setup-test lease on another box that Boat reads stopped.
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: f.boat.worker });
    const sibling = await runtime.acquireRunLease({ companyId: f.companyId, agentId: f.agent.id, adapterType: "paperclip_runner",
      environment: f.environment as never, configuredEnvironment: f.environment as never, issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null } as never);
    await runtime.getDriver("sandbox")!.releaseRunLease({ environment: f.environment as never, lease: sibling.lease, status: "failed" });
    const inspectSpy = f.boat.worker.call as ReturnType<typeof vi.fn>;
    inspectSpy.mockClear();
    await untilRetryAt(f.agent.id);
    await work.process(f.agent.id);
    const inspected = inspectSpy.mock.calls.filter(([, method]) => method === "environmentInspectLease").map(([, , params]) => (params as { providerLeaseId: string }).providerLeaseId);
    expect(inspected).toEqual([probeLease.providerLeaseId]);
    const [sib] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, sibling.lease.id));
    expect(sib!.metadata?.remoteExecutionTermination).toBeUndefined();
    await expectNoReceipt(f, probeLease, boundary);
  });

  it("RED custody: a closed setup-test lease's box can never be started again (execute is denied by the server fence, even after a Boat worker restart)", async () => {
    const f = await fixture({ release: "void", inspect: "stopped" });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: f.boat.worker });
    const acquired = await runtime.acquireRunLease({ companyId: f.companyId, agentId: f.agent.id, adapterType: "paperclip_runner",
      environment: f.environment as never, configuredEnvironment: f.environment as never, issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null } as never);
    await runtime.getDriver("sandbox")!.releaseRunLease({ environment: f.environment as never, lease: acquired.lease, status: "failed" });
    const mark = f.boat.calls.length;
    await expect(runtime.execute({ environment: f.environment as never, lease: acquired.lease, command: "rm", args: ["-rf", "/tmp/x"] } as never))
      .rejects.toMatchObject({ code: "sandbox_lease_start_denied" });
    expect(after(f, mark), "no start reached Boat").toEqual([]);
  });
});
