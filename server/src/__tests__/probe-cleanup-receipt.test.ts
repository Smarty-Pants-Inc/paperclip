// probecleanup-build2 (UNIFIED.md §6): a hire's setup probe whose remote close
// was refused (-32002 "Boat sandbox lease is no longer active.") after the
// verifier's own release stopped/destroyed its box. The only new proof is the
// typed receipt the release writes on the probe's EXACT lease; no error code or
// text is ever read as proof. Without a receipt the hire shows one true line,
// parks at 30 minutes and never cleans up on time alone.
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins, type Db } from "@paperclipai/db";
import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { startAgentLifecycle } from "../modules/agent-lifecycle/index.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { createLifecycleWorker } from "../modules/agent-lifecycle/application/worker.js";
import type { LifecycleAgent } from "../modules/agent-lifecycle/application/ports.js";
import { agentHarnessVerificationService } from "../services/agent-harness-verification.js";
import * as environmentTests from "../services/agent-environment-test.js";
import * as aiConnections from "../services/ai-connections.js";
import * as aiRuntime from "../services/ai-connection-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import * as termination from "../services/remote-execution-termination.js";
import { reconcileRetainedAiCleanup } from "../services/retained-ai-credential-cleanup.js";
import { NativeEnvironmentProbeCleanupError } from "../vendor/paperclip-runner/index.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

const FIRST_LINE = "The last account test has not confirmed its test computer stopped; Paperclip will retry automatically.";
const PARKED_LINE = "The last account test has not confirmed its test computer stopped. Press Retry after a few minutes; if it stays stuck, tell your operator.";
const BOAT_REFUSAL = "Boat sandbox lease is no longer active.";
const MINUTE = 60_000;

type Release = "stopped" | "destroyed" | "throws";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("hire probe cleanup: the probe lease's own receipt (UNIFIED §6)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const stops: Array<() => Promise<void>> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-probe-cleanup-receipt-");
    db = createDb(database.connectionString, { maxConnections: 4 });
  }, 120_000);
  afterAll(async () => { await database?.cleanup(); });
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-18T10:00:00.000Z")); });
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop().catch(() => {});
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The real Boat sandbox-provider shape (driverKey "boat", 0.1.17-spare.1 hook
   * names) as a worker double: release answers with Boat's stopSandbox receipt
   * (plugin.ts:969-980 → {state:"stopped"}) or a destroy; a later probe close is
   * refused by lease-gates.ts:41 with the generic -32002. */
  function boatWorker(pluginId: string, release: { mode: Release }) {
    let boxes = 0;
    const calls: Array<{ method: string; providerLeaseId?: string }> = [];
    const worker = {
      isRunning: (id: string) => id === pluginId,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentReleaseLease", "environmentDestroyLease", "environmentRealizeWorkspace", "environmentExecute"] }),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string }) => {
        calls.push({ method, providerLeaseId: params.providerLeaseId });
        if (method === "environmentAcquireLease") return { providerLeaseId: `boat-box-${++boxes}`, metadata: { provider: "boat", remoteCwd: "/home/user/paperclip-workspace" } };
        if (method === "environmentRealizeWorkspace") return { cwd: "/home/user/paperclip-workspace" };
        if (method === "environmentReleaseLease") {
          if (release.mode === "throws") throw new JsonRpcCallError({ code: -32002, message: "Boat stop did not complete" } as never);
          return { providerLeaseId: params.providerLeaseId, state: release.mode };
        }
        throw new JsonRpcCallError({ code: -32002, message: BOAT_REFUSAL } as never);
      }),
    };
    return { worker: worker as unknown as PluginWorkerManager, calls };
  }

  async function fixture(input: { release: Release; companyId?: string; accountKey?: string }) {
    const companyId = input.companyId ?? randomUUID();
    if (!input.companyId) await db.insert(companies).values({ id: companyId, name: "Probe cleanup", issuePrefix: `P${companyId.slice(0, 7)}` });
    const pluginId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: `paperclipai.plugin-boat.${pluginId.slice(0, 8)}`, packageName: "@paperclipai/plugin-boat",
      version: "0.1.17-spare.1", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1,
      manifestJson: { id: `paperclipai.plugin-boat.${pluginId.slice(0, 8)}`, apiVersion: 1, version: "0.1.17-spare.1", displayName: "Boat", description: "Boat",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", configSchema: { type: "object" } }] },
      updatedAt: new Date() } as never);
    const [environment] = await db.insert(environments).values({ name: `boat-${pluginId.slice(0, 8)}`, driver: "sandbox",
      config: { provider: "boat", reuseLease: false, timeoutMs: 1234 } }).returning();
    const release = { mode: input.release };
    const boat = boatWorker(pluginId, release);
    const accountKey = input.accountKey ?? randomUUID();
    const [agent] = await db.insert(agents).values({ companyId, name: "Pi hire", adapterType: "paperclip_runner",
      adapterConfig: { provider: "pi_rpc", model: "openrouter/fixture-model" }, defaultEnvironmentId: environment!.id,
      status: "paused", lifecycleState: "verifying", lifecycleRequiredPluginIds: [],
      runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "openrouter", method: "api_key" } },
      lifecycleOperation: { id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0 } }).returning();
    return { companyId, environment: environment!, agent: agent!, accountKey, release, boat };
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  /** Outside the boundary: credential selection and the Pi transport. The
   * verifier, the setup-test lease acquire/release through the real runtime and
   * plugin path, the retained owner, and the lifecycle worker/store are real. */
  function probeBoundary(fixtures: Fixture[]) {
    const byAgent = new Map(fixtures.map(f => [f.agent.id, f]));
    const probes = new Map<string, number>();
    const cleanups = new Map<string, ReturnType<typeof vi.fn>>();
    const retries = new Map<string, ReturnType<typeof vi.fn>>();
    const connections = aiConnections.aiConnectionService;
    vi.spyOn(aiConnections, "aiConnectionService").mockImplementation(database => ({ ...connections(database),
      select: async (input: { agentId?: string }) => {
        const key = byAgent.get(input.agentId!)!.accountKey;
        return { connection: { credentialSecretRefs: [] }, grant: { id: key, credentialSecretRefs: [] }, attribution: { grantId: key, connectionId: key } } as never;
      },
    }));
    const tests = environmentTests.agentEnvironmentTestService;
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation((database, manager) => {
      const real = tests(database, manager);
      return { ...real,
        resolveAdapterTestEnvironmentId: async (_companyId: string, environmentId: string | null | undefined) => environmentId ?? null,
        assertAdapterTestEnvironmentForCompany: async () => undefined,
        testManagedEnvironment: async (_type: string, input: { executionTarget?: unknown }, _binding: unknown, _managed: unknown, agentId?: string) => {
          const count = (probes.get(agentId!) ?? 0) + 1; probes.set(agentId!, count);
          const target = input.executionTarget as { kind?: string; transport?: string; leaseId?: string; runnerTask?: unknown } | null;
          // The real Pi probe shape: a remote sandbox target with its lease id and NO runnerTask (pi-runner-probe.ts:168).
          expect(target).toMatchObject({ kind: "remote", transport: "sandbox", leaseId: expect.any(String) });
          expect(target?.runnerTask).toBeUndefined();
          if (count === 1) {
            // The remote close after the verifier's own release is refused with the
            // generic WORKER_ERROR; the transport's R2 retry throws locally (runnerd-codex-transport.ts:5835-5836).
            const retired = Promise.reject(new Error("Native probe remote retirement remains unconfirmed")); void retired.catch(() => undefined);
            const retry = vi.fn(async () => { throw new Error("Native probe remote retirement remains unconfirmed"); });
            retries.set(agentId!, retry);
            throw new NativeEnvironmentProbeCleanupError(retired, undefined,
              [new JsonRpcCallError({ code: -32002, message: BOAT_REFUSAL } as never)], retry);
          }
          return { adapterType: "paperclip_runner", status: "pass", testedAt: new Date().toISOString(),
            checks: [{ code: "pi_hello_probe_passed", level: "info", message: "Fixture Pi hello passed" }] };
        } } as never;
    });
    vi.spyOn(aiRuntime, "withManagedAiProbe").mockImplementation(async (database, input, probe) => {
      const agentId = (input as { agentId: string }).agentId;
      const accountKey = byAgent.get(agentId)!.accountKey;
      const cleanup = cleanups.get(agentId) ?? vi.fn(async () => {}); cleanups.set(agentId, cleanup);
      const runtime = { config: input.config, attribution: { grantId: accountKey, connectionId: accountKey },
        retainedCleanupScope: { companyId: input.companyId, accountKey }, home: undefined, cleanup };
      // The real retention (and, at head, the proveRetired closure) of withManagedAiProbe.
      const retain = (aiRuntime as unknown as { retainManagedAiProbeCleanup?: Function }).retainManagedAiProbeCleanup;
      try { return await probe(runtime as never); }
      catch (error) {
        if (error instanceof NativeEnvironmentProbeCleanupError && retain) retain(database, runtime, input, error);
        else if (error instanceof NativeEnvironmentProbeCleanupError) {
          const { retainAiCredentialCleanup } = await import("../services/retained-ai-credential-cleanup.js");
          retainAiCredentialCleanup({ scope: runtime.retainedCleanupScope, cleanup, retired: error.retired, agentId,
            retryRetirement: () => error.retryCleanup!.call(error) });
          const { unprocessable } = await import("../errors.js");
          throw unprocessable("The native account test is still cleaning up. Retry after runtime cleanup completes.", { code: "native_probe_cleanup_pending" });
        }
        throw error;
      }
    });
    return { probes, cleanups, retries };
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
  const advance = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));
  async function untilRetryAt(id: string) {
    const retryAt = (await row(id)).lifecycleOperation?.retryAt;
    expect(retryAt, "a durable retryAt").toEqual(expect.any(String));
    vi.setSystemTime(new Date(Date.parse(retryAt!) + 1));
  }

  it("H: the verifier's own release writes a receipt bound to the probe's exact lease; the next lifecycle retry clears the entry, cleanup runs once, the hire leaves verifying with no restart", async () => {
    const f = await fixture({ release: "destroyed" });
    const boundary = probeBoundary([f]);
    const { work, runHost } = lifecycle(f);
    await work.process(f.agent.id);
    expect(boundary.probes.get(f.agent.id)).toBe(1);
    const [probeLease] = await leases(f.environment.id);
    expect(probeLease).toMatchObject({ heartbeatRunId: null, leasePolicy: "ephemeral", providerLeaseId: "boat-box-1", cleanupStatus: "success" });
    expect(probeLease!.metadata?.runnerTaskProbe, "C2: the Pi probe's lease carries no runnerTaskProbe").toBeUndefined();
    expect(probeLease!.metadata?.remoteExecutionTermination, "a receipt bound to the probe's exact lease")
      .toMatchObject({ schema: "paperclip.remote-termination.v1", runId: null, leaseId: probeLease!.id, providerLeaseId: "boat-box-1", state: "destroyed" });
    expect(await row(f.agent.id)).toMatchObject({ lifecycleState: "verifying", lifecycleError: FIRST_LINE });
    await untilRetryAt(f.agent.id);
    await work.process(f.agent.id);
    expect(boundary.cleanups.get(f.agent.id)).toHaveBeenCalledOnce();
    expect(boundary.retries.get(f.agent.id), "the receipt is read before R2").not.toHaveBeenCalled();
    expect(boundary.probes.get(f.agent.id)).toBe(2);
    expect(runHost).toHaveBeenCalledTimes(2);
    expect((await row(f.agent.id)).lifecycleState).not.toBe("verifying");
    await expect(reconcileRetainedAiCleanup({ companyId: f.companyId, accountKey: f.accountKey })).resolves.toBeUndefined();
  });

  it("C3: Boat's real release receipt 'stopped' (stop-and-archive; an archived box can be resumed) is NOT proof for a probe: no cleanup, the entry stays", async () => {
    const f = await fixture({ release: "stopped" });
    const boundary = probeBoundary([f]);
    const { work } = lifecycle(f);
    await work.process(f.agent.id);
    await untilRetryAt(f.agent.id);
    await work.process(f.agent.id);
    expect(boundary.cleanups.get(f.agent.id)).not.toHaveBeenCalled();
    expect(boundary.probes.get(f.agent.id)).toBe(1);
    expect(await row(f.agent.id)).toMatchObject({ lifecycleState: "verifying", lifecycleError: FIRST_LINE });
  });

  it("H-bind / C4: a null-run lease released without the probe holder's exact id gets no receipt, and no run-keyed reader ever reads a probe lease", async () => {
    const f = await fixture({ release: "destroyed" });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: f.boat.worker });
    const acquire = () => runtime.acquireRunLease({ companyId: f.companyId, agentId: f.agent.id, adapterType: "paperclip_runner",
      environment: { ...f.environment, config: { ...f.environment.config, reuseLease: false, archiveOnRelease: true } } as never,
      configuredEnvironment: f.environment as never, issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null } as never);
    const plain = await acquire();
    await runtime.getDriver("sandbox")!.releaseRunLease({ environment: f.environment as never, lease: plain.lease, status: "released" });
    const [plainRow] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, plain.lease.id));
    expect(plainRow).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect(plainRow!.metadata?.remoteExecutionTermination, "no probe holder named it: no receipt").toBeUndefined();
    // A probe receipt (held by its exact id) is invisible to every run-keyed reader.
    const probe = await acquire();
    await runtime.getDriver("sandbox")!.releaseRunLease({ environment: f.environment as never, lease: probe.lease, status: "failed", probeLeaseId: probe.lease.id } as never);
    const [probeRow] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, probe.lease.id));
    expect(probeRow!.metadata?.remoteExecutionTermination, "the probe holder's exact id binds it")
      .toMatchObject({ runId: null, leaseId: probe.lease.id, state: "destroyed" });
    expect((termination.hasRemoteTerminationReceipt as Function)(probeRow!, probe.lease.id), "read by its exact id").toBe(true);
    expect(termination.hasRemoteTerminationReceipt(probeRow!), "the shared reader without the exact id refuses it").toBe(false);
    expect((termination.hasRemoteTerminationReceipt as Function)(probeRow!, plain.lease.id), "another lease's id never reads it").toBe(false);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agent.id, invocationSource: "manual", status: "running" } as never);
    const [runLease] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, heartbeatRunId: runId,
      provider: "boat", providerLeaseId: "boat-run-box", status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: termination.remoteTerminationReceipt(runLease!, { providerLeaseId: "boat-run-box", state: "destroyed" }) } })
      .where(eq(environmentLeases.id, runLease!.id));
    expect(await termination.remoteExecutionHasReleased(db, f.companyId, runId)).toBe(true);
    expect(await termination.stoppedRemoteCleanupScopes(db, f.companyId, runId)).not.toBeNull();
    expect(await termination.remoteExecutionHasStopped(db, f.companyId, runId)).toBe(true);
  });

  it("N1: no receipt (the release failed: pending_cleanup): the true line from the first deferral, the durable retryAt bound parks at 30 minutes with the parked line, AI_CREDENTIAL_CLEANUP_EXPIRED once, cleanup never called", async () => {
    const f = await fixture({ release: "throws" });
    const boundary = probeBoundary([f]);
    const warn = vi.spyOn(logger, "warn");
    const { work, runHost } = lifecycle(f);
    await work.process(f.agent.id);
    const [probeLease] = await leases(f.environment.id);
    expect(probeLease).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
    expect(await row(f.agent.id)).toMatchObject({ lifecycleState: "verifying", lifecycleError: FIRST_LINE });
    for (let step = 0; step < 12 && !(await row(f.agent.id)).lifecycleOperation?.retryRequired; step++) {
      await untilRetryAt(f.agent.id);
      await work.process(f.agent.id);
      const current = await row(f.agent.id);
      if (!current.lifecycleOperation?.retryRequired) expect(current.lifecycleError).toBe(FIRST_LINE);
    }
    const parked = await row(f.agent.id);
    expect(parked).toMatchObject({ lifecycleState: "verifying", lifecycleError: PARKED_LINE, lifecycleOperation: { retryRequired: true } });
    expect(parked.lifecycleOperation).not.toHaveProperty("retryAt");
    expect(parked.lifecycleError).not.toContain("will retry");
    const since = Date.parse(parked.updatedAt as unknown as string ?? "") || Date.now();
    expect(since - Date.parse("2026-11-18T10:00:00.000Z")).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(since - Date.parse("2026-11-18T10:00:00.000Z")).toBeLessThan(46 * MINUTE);
    expect(runHost.mock.calls.length).toBeLessThanOrEqual(7);
    expect(boundary.cleanups.get(f.agent.id)).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([fields]) => (fields as { code?: string })?.code === "AI_CREDENTIAL_CLEANUP_EXPIRED")).toHaveLength(1);
    expect(f.boat.calls.filter(call => call.method !== "environmentAcquireLease" && call.method !== "environmentRealizeWorkspace")
      .map(call => call.method), "expiry touched no box").toEqual(["environmentReleaseLease"]);
  });

  it("N2: -32002 alone (no receipt: the lease is still active) is unproven", async () => {
    const f = await fixture({ release: "destroyed" });
    const boundary = probeBoundary([f]);
    const verifier = agentHarnessVerificationService(db, f.boat.worker);
    // The release has not run yet: the probe's close was refused with -32002.
    const realTests = environmentTests.agentEnvironmentTestService(db, f.boat.worker);
    const real = realTests.resolveAdapterTestExecutionContext;
    let held: Awaited<ReturnType<typeof real>> | undefined;
    vi.spyOn(environmentTests, "agentEnvironmentTestService").mockImplementation(() => ({ ...realTests,
      resolveAdapterTestEnvironmentId: async () => f.environment.id, assertAdapterTestEnvironmentForCompany: async () => undefined,
      resolveAdapterTestExecutionContext: async (input: never) => { held = await real(input); return { ...held, release: async () => {} }; },
      testManagedEnvironment: async () => { throw new NativeEnvironmentProbeCleanupError(Promise.reject(new Error("unconfirmed")).catch(() => { throw new Error("unconfirmed"); }) as Promise<void>,
        undefined, [new JsonRpcCallError({ code: -32002, message: BOAT_REFUSAL } as never)], async () => { throw new Error("Native probe remote retirement remains unconfirmed"); }); },
    }) as never);
    await expect(verifier.verify(f.agent as never)).rejects.toMatchObject({ details: { code: "native_probe_cleanup_pending" } });
    await new Promise(resolve => setImmediate(resolve));
    await expect(verifier.verify(f.agent as never)).rejects.toMatchObject({ details: { code: "native_probe_cleanup_pending" } });
    expect(boundary.cleanups.get(f.agent.id)).not.toHaveBeenCalled();
    const [probeLease] = await leases(f.environment.id);
    expect(probeLease).toMatchObject({ status: "active" });
    await held?.release("failed");
  });

  it("N3: a receipt on ANOTHER lease of the same box (another probe, another run) is not proof", async () => {
    const f = await fixture({ release: "throws" });
    const boundary = probeBoundary([f]);
    const { work } = lifecycle(f);
    await work.process(f.agent.id);
    const [probeLease] = await leases(f.environment.id);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agent.id, invocationSource: "manual", status: "running" } as never);
    for (const heartbeatRunId of [null, runId]) {
      const [other] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, heartbeatRunId,
        provider: "boat", providerLeaseId: probeLease!.providerLeaseId, status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
      const receipt = (termination.remoteTerminationReceipt as Function)(other!, { providerLeaseId: other!.providerLeaseId, state: "destroyed" }, other!.id);
      expect(receipt).toBeTruthy();
      await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: receipt } }).where(eq(environmentLeases.id, other!.id));
    }
    await untilRetryAt(f.agent.id);
    await work.process(f.agent.id);
    expect(boundary.cleanups.get(f.agent.id)).not.toHaveBeenCalled();
    expect(boundary.probes.get(f.agent.id)).toBe(1);
    expect((await row(f.agent.id)).lifecycleError).toBe(FIRST_LINE);
  });

  it("N4: I with the successor on the same box and only 'stopped' is not proof; on another box it is (the unchanged I/S verdict through the helper)", async () => {
    const f = await fixture({ release: "stopped" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agent.id, invocationSource: "manual", status: "running" } as never);
    const [own] = await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id, heartbeatRunId: runId,
      provider: "boat", providerLeaseId: "boat-box-X", status: "released", cleanupStatus: "success", releasedAt: new Date() }).returning();
    await db.update(environmentLeases).set({ metadata: { remoteExecutionTermination: termination.remoteTerminationReceipt(own!, { providerLeaseId: "boat-box-X", state: "stopped" }) } })
      .where(eq(environmentLeases.id, own!.id));
    const owner = { companyId: f.companyId, environmentId: f.environment.id, providerLeaseId: "boat-box-X", runId };
    const helper = (termination as unknown as { ownLeaseTerminated: Function }).ownLeaseTerminated;
    expect(typeof helper).toBe("function");
    expect(await helper(db, owner, { successorOnOwnerSandbox: true, ownLeaseOnly: true })).toBe(false);
    expect(await helper(db, owner, { successorOnOwnerSandbox: false, ownLeaseOnly: true })).toBe(true);
  });

  it("isolation: another company and another account of the same company verify while one account's cleanup is pending", async () => {
    const pending = await fixture({ release: "throws" });
    const sameCompany = await fixture({ release: "destroyed", companyId: pending.companyId });
    const otherCompany = await fixture({ release: "destroyed", accountKey: pending.accountKey });
    const boundary = probeBoundary([pending, sameCompany, otherCompany]);
    const blocked = lifecycle(pending);
    await blocked.work.process(pending.agent.id);
    expect((await row(pending.agent.id)).lifecycleError).toBe(FIRST_LINE);
    for (const f of [sameCompany, otherCompany]) {
      boundary.probes.set(f.agent.id, 1); // their probes pass first time
      const { work } = lifecycle(f);
      await work.process(f.agent.id);
      expect((await row(f.agent.id)).lifecycleState, f === sameCompany ? "same company, other account" : "other company").not.toBe("verifying");
    }
    expect((await row(pending.agent.id)).lifecycleState).toBe("verifying");
  });

  it("restart + RED 6: the parked row survives a restart; Retry with the lease still open shows the same parked line once (no 'will retry', no loop); Retry once a receipt exists verifies once", async () => {
    const f = await fixture({ release: "throws" });
    const boundary = probeBoundary([f]);
    const { work } = lifecycle(f);
    await work.process(f.agent.id);
    for (let step = 0; step < 12 && !(await row(f.agent.id)).lifecycleOperation?.retryRequired; step++) {
      await untilRetryAt(f.agent.id);
      await work.process(f.agent.id);
    }
    expect(await row(f.agent.id)).toMatchObject({ lifecycleError: PARKED_LINE, lifecycleOperation: { retryRequired: true } });
    await work.stop();
    // Restart: a new lifecycle instance never auto-runs the parked hire.
    const verifier = agentHarnessVerificationService(db, f.boat.worker);
    const runHost = vi.fn((agent: LifecycleAgent) => verifier.verify(agent));
    const restarted = startAgentLifecycle(db, createAgentLifecycleEffects(), { requiredPluginIds: async () => [], runPlugin: async () => "complete" as const, runHost }, () => true);
    stops.push(() => restarted.stop());
    advance(60 * MINUTE);
    expect(await restarted.hasPending()).toBe(false);
    await restarted.sweep();
    expect(runHost).not.toHaveBeenCalled();
    expect(await row(f.agent.id)).toMatchObject({ lifecycleError: PARKED_LINE, lifecycleOperation: { retryRequired: true } });
    // Retry with the lease still open (no receipt): the same parked line at once, no automatic retry.
    await createAgentLifecycle(db).retry(f.agent.id);
    await restarted.process(f.agent.id);
    const again = await row(f.agent.id);
    expect(again).toMatchObject({ lifecycleError: PARKED_LINE, lifecycleOperation: { retryRequired: true } });
    expect(again.lifecycleOperation).not.toHaveProperty("retryAt");
    expect(again.lifecycleError).not.toContain("will retry");
    expect(runHost).toHaveBeenCalledOnce();
    expect(boundary.cleanups.get(f.agent.id)).not.toHaveBeenCalled();
    // The release later completes with a receipt bound to the probe's exact lease.
    const [probeLease] = await leases(f.environment.id);
    const receipt = (termination.remoteTerminationReceipt as Function)(probeLease!, { providerLeaseId: probeLease!.providerLeaseId, state: "destroyed" }, probeLease!.id);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { ...probeLease!.metadata, remoteExecutionTermination: receipt } }).where(and(eq(environmentLeases.id, probeLease!.id)));
    await createAgentLifecycle(db).retry(f.agent.id);
    await restarted.process(f.agent.id);
    expect(runHost).toHaveBeenCalledTimes(2);
    expect(boundary.cleanups.get(f.agent.id)).toHaveBeenCalledOnce();
    expect(boundary.probes.get(f.agent.id)).toBe(2);
    expect((await row(f.agent.id)).lifecycleState).not.toBe("verifying");
  });
});
