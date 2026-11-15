import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins, type Db } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { heartbeatService } from "./heartbeat.js";
import { hasBoundRemoteStopReceipt } from "./remote-execution-termination.js";
import { prepareHistoricalSandboxStopVerification, readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

// Keep reason: RFL's c1 acquisition finding on the recorded SEED-B lease shape.
// Exercise real acquisition, DB snapshot/CAS, and the existing cleanup owner;
// only the external provider is a peer. No live Boat repair is claimed.
const wall = new Date("2026-11-14T18:25:18.029Z");
const release = new Date("2026-11-14T13:37:51.697Z");
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("historical sandbox acquisition uses the inspected stop owner", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("historical-sandbox-acquisition");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    await db.execute(sql`truncate table companies, environments, plugins cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(wall);
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), pluginId = randomUUID();
    const environmentId = randomUUID(), oldRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "SEED-B historical acquisition", issuePrefix: "HSA" });
    await db.insert(agents).values({ id: agentId, companyId, name: "SEED-B", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Remember ALDER-B", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(environments).values({ id: environmentId, name: "Boat", driver: "sandbox", status: "active",
      config: { provider: "boat", image: "boot-source-before-upgrade", reuseLease: true } });
    await db.insert(plugins).values({ id: pluginId, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["automation"], manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat replay peer", author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true, configSchema: { type: "object" } }] } });
    await db.insert(heartbeatRuns).values({ id: oldRunId, companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded", createdAt: new Date("2026-11-14T13:22:00.000Z"), finishedAt: release });
    const [followUp] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "running", createdAt: wall }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId, issueId, heartbeatRunId: oldRunId,
      provider: "boat", providerLeaseId: "bx_ysh5xvy5", leasePolicy: "reuse_by_environment", status: "released", cleanupStatus: "success", failureReason: null,
      acquiredAt: new Date("2026-11-14T13:22:11.225Z"), releasedAt: release, expiresAt: new Date("2026-11-14T21:52:06.972Z"),
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId, pluginKey: "paperclip.boat", agentId,
        provider: "boat", image: "boot-source-before-upgrade", reuseLease: true, historicalEvidence: "must survive",
        leaseController: { pid: 7, bootId: "2126acac-bd09-4502-b4b2-5116b8df3445", hostHash: "ece3ffd4fd550a59334cc49672782bac", processStartedAt: "2026-11-14T11:49:42.560Z" }, pendingCleanupInFlight: false },
    }).returning();
    const [changedEnvironment] = await db.update(environments).set({ config: { provider: "boat", image: "boot-source-after-upgrade", reuseLease: true } }).where(eq(environments.id, environmentId)).returning();
    const environment = { ...changedEnvironment, envVars: {} } as Environment;
    const read = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)))[0]!;
    function runtime(inspect: () => Promise<unknown>, inspectSupported = true) {
      const call = vi.fn(async (_id: string, method: string) => {
        if (method === "environmentInspectLease") return inspect();
        if (method === "environmentAcquireLease") return { providerLeaseId: "bx-fresh", metadata: { ...environment.config, remoteCwd: "/workspace" } };
        throw new Error(`Unexpected provider dispatch: ${method}`);
      });
      const service = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease", ...(inspectSupported ? ["environmentInspectLease"] : [])] }),
      } as unknown as PluginWorkerManager });
      const acquire = () => service.acquireRunLease({ companyId, environment, issueId, agentId, heartbeatRunId: followUp.id,
        adapterType: "paperclip_runner", persistedExecutionWorkspace: null });
      return { service, call, acquire };
    }
    async function assertReadOutsideLocks() {
      expect(await read()).toEqual(lease);
      await db.transaction(async tx => {
        await tx.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id)).for("update", { noWait: true });
        await tx.select().from(environments).where(eq(environments.id, environmentId)).for("update", { noWait: true });
        await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, oldRunId)).for("update", { noWait: true });
        await tx.select().from(issues).where(eq(issues.id, issueId)).for("update", { noWait: true });
      });
    }
    return { companyId, followUp, lease, environment, read, runtime, assertReadOutsideLocks };
  }

  it.each(["absent", "error", "unknown", "foreign", "stopped", "destroyed", "unsupported"] as const)("%s read preserves the original row and never arms cleanup", async mode => {
    const f = await fixture();
    const inspect = vi.fn(async () => {
      await f.assertReadOutsideLocks();
      if (mode === "error") throw new Error("Provider unavailable");
      if (mode === "absent") return undefined;
      return { providerLeaseId: mode === "foreign" ? "another-allocation" : f.lease.providerLeaseId, state: mode === "foreign" ? "running" : mode };
    });
    const runtime = f.runtime(inspect, mode !== "unsupported");
    expect((await runtime.acquire()).lease.providerLeaseId).toBe("bx-fresh");
    expect(await f.read()).toEqual(f.lease);
    expect(inspect).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
    expect(runtime.call.mock.calls.map(call => call[1])).toEqual(mode === "unsupported"
      ? ["environmentAcquireLease"] : ["environmentInspectLease", "environmentAcquireLease"]);
    const stop = vi.fn(async () => undefined), laterInspect = vi.fn(async () => undefined);
    const hb = heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop, inspectLeaseResource: laterInspect } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
    for (let n = 0; n < 8; n++) { vi.setSystemTime(wall.getTime() + n * 3600000); await hb.sweepPendingCleanupLeases(); }
    expect(await f.read()).toEqual(f.lease);
    expect(stop).not.toHaveBeenCalled();
    expect(laterInspect).not.toHaveBeenCalled();
    await hb.drainActiveRunExecutions();
  });

  it.each(["released", "expired"] as const)("%s bound receipt is immutable even when cleanup failed", async status => {
    const f = await fixture();
    await db.update(environmentLeases).set({ status, cleanupStatus: "failed", metadata: { ...f.lease.metadata,
      remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped", companyId: f.companyId,
        runId: f.lease.heartbeatRunId, leaseId: f.lease.id, provider: f.lease.provider, providerLeaseId: f.lease.providerLeaseId, confirmedAt: release.toISOString() },
    } }).where(eq(environmentLeases.id, f.lease.id));
    const before = await f.read();
    expect(hasBoundRemoteStopReceipt(before)).toBe(true);
    expect(await prepareHistoricalSandboxStopVerification(db, before)).toBeNull();
    const inspect = vi.fn(async () => { throw new Error("Bound proof must not be inspected"); });
    await f.runtime(inspect).acquire();
    expect(inspect).not.toHaveBeenCalled();
    expect(await f.read()).toEqual(before);
  });

  it.each(["active", "running"] as const)("exact %s GET snapshots before one stop, then restores the complete original plus receipt", async state => {
    const f = await fixture();
    const inspect = vi.fn(async () => { await f.assertReadOutsideLocks(); return { providerLeaseId: f.lease.providerLeaseId, state }; });
    const runtime = f.runtime(inspect);
    await runtime.acquire();
    const pending = await f.read();
    expect(pending.status).toBe("pending_cleanup");
    const intent = readStopOnlyCleanup(pending)!;
    expect(intent.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    expect(pending.metadata?.endedLeaseEvidence).toEqual(JSON.parse(JSON.stringify(f.lease)));
    expect(runtime.call.mock.calls.map(call => call[1])).toEqual(["environmentInspectLease", "environmentAcquireLease"]);
    const stop = vi.fn(async () => undefined), laterInspect = vi.fn(async () => undefined as unknown);
    const hb = () => heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop, inspectLeaseResource: laterInspect } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
    // Recreate the service between passes: durable evidence/counters, not a
    // process-local latch, must bound stop dispatch after a worker restart.
    for (let n = 0; n < 2; n++) {
      vi.setSystemTime(wall.getTime() + n * 3600000);
      const service = hb(); await service.sweepPendingCleanupLeases(); await service.drainActiveRunExecutions();
      expect(readStopOnlyCleanup(await f.read())?.requestId).toBe(intent.requestId);
    }
    expect(stop).toHaveBeenCalledOnce();
    laterInspect.mockResolvedValue({ providerLeaseId: f.lease.providerLeaseId, state: "stopped" });
    vi.setSystemTime(wall.getTime() + 2 * 3600000);
    const service = hb(); await service.sweepPendingCleanupLeases(); await service.drainActiveRunExecutions();
    const restored = await f.read();
    expect(hasBoundRemoteStopReceipt(restored)).toBe(true);
    expect(readStopOnlyCleanup(restored)).toBeNull();
    expect(restored).toEqual({ ...f.lease, metadata: { ...f.lease.metadata, remoteExecutionTermination: expect.objectContaining({
      state: "stopped", leaseId: f.lease.id, providerLeaseId: f.lease.providerLeaseId, endedLeaseEvidence: JSON.parse(JSON.stringify(f.lease)),
    }) } });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("absent receipts after a positive GET cap later inspections and never repeat the stop", async () => {
    const f = await fixture();
    await f.runtime(async () => ({ providerLeaseId: f.lease.providerLeaseId, state: "running" })).acquire();
    const stop = vi.fn(async () => undefined), inspect = vi.fn(async () => undefined);
    for (let n = 0; n < 12; n++) {
      vi.setSystemTime(wall.getTime() + n * 3600000);
      const service = heartbeatService(db, { environmentRuntime: { retryPendingSandboxTeardown: stop, inspectLeaseResource: inspect } as unknown as NonNullable<Parameters<typeof heartbeatService>[1]>["environmentRuntime"] });
      await service.sweepPendingCleanupLeases(); await service.drainActiveRunExecutions();
    }
    expect(stop).toHaveBeenCalledOnce();
    expect(inspect.mock.calls.length).toBeGreaterThan(0);
    expect(inspect.mock.calls.length).toBeLessThanOrEqual(5);
    expect((await f.read()).metadata?.sandboxStopAndRetain).toMatchObject({ endedLeaseEvidence: JSON.parse(JSON.stringify(f.lease)) });
  });

  it.each(["snapshot-changed", "other-holder"] as const)("positive GET cannot overwrite %s", async race => {
    const f = await fixture();
    let expected = f.lease;
    const runtime = f.runtime(async () => {
      await f.assertReadOutsideLocks();
      if (race === "snapshot-changed") {
        await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, concurrentEvidence: "new" } }).where(eq(environmentLeases.id, f.lease.id));
        expected = await f.read();
      } else {
        await db.insert(environmentLeases).values({ companyId: f.companyId, environmentId: f.environment.id,
          heartbeatRunId: f.followUp.id, provider: f.lease.provider, providerLeaseId: f.lease.providerLeaseId, status: "active" });
      }
      return { providerLeaseId: f.lease.providerLeaseId, state: "running" };
    });
    await runtime.acquire();
    expect(await f.read()).toEqual(expected);
    expect(readStopOnlyCleanup(await f.read())).toBeNull();
  });
});
