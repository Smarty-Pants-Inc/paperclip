import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { hasConfirmedSandboxStopAndRetain, prepareHistoricalSandboxStopVerification } from "./sandbox-stop-and-retain.js";
import { hasBoundRemoteStopReceipt, hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { Environment } from "@paperclipai/shared";

// Keep reason: SEED-B's recorded 18:25:18 follow-up admission rewrote a released
// lease before the follow-up failed. Replay the actual two-receipt contract and
// acquisition entry point; only provider I/O is a controlled peer. Source drift
// is an explicit replay input, not a claim that the pre-follow-up config bytes
// (which were not retained) have been recovered. No live Boat repair is claimed.
const ids = {
  company: "09c3c41e-3b10-4a12-a9bf-cc4fa9c6c8f4",
  environment: "460f0299-36fe-42ab-a3dc-2ed99b3d4903",
  lease: "465b4eb1-e6c7-4107-93a0-a903997ada1c",
  old: "6b482d32-bd45-4109-bd20-75cdb8ff5d47",
  plugin: "f545d693-e9b8-4678-9e62-4972a8650973",
};
const wall = new Date("2026-11-14T18:25:18.029Z");
const release = new Date("2026-11-14T13:37:51.697Z");
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("F1 actual SEED-B released row at follow-up START", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("f1-real-row-start");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    vi.useRealTimers();
    await db.execute(sql`truncate table companies, environments, plugins cascade`);
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(wall);
    const agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: ids.company, name: "SEED-B receipt replay", issuePrefix: "FRS" });
    await db.insert(agents).values({ id: agentId, companyId: ids.company, name: "SEED-B", role: "engineer", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId: ids.company, title: "Remember ALDER-B", status: "in_progress", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ id: ids.environment, name: "Boat", driver: "sandbox", status: "active",
      config: { provider: "boat", image: "boot-source-before-upgrade", reuseLease: true } }).returning();
    await db.insert(plugins).values({ id: ids.plugin, pluginKey: "paperclip.boat", packageName: "@paperclipai/plugin-boat", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["automation"], manifestJson: { id: "paperclip.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Boat replay peer", author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" }, environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true, configSchema: { type: "object" } }] } });
    await db.insert(heartbeatRuns).values({ id: ids.old, companyId: ids.company, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded", createdAt: new Date("2026-11-14T13:22:00.000Z"), finishedAt: release });
    const [followUp] = await db.insert(heartbeatRuns).values({ companyId: ids.company, agentId, issueId, nativeIssueId: issueId, runtimeMode: "native", status: "running", createdAt: wall }).returning();
    const binding = { companyId: ids.company, runId: ids.old, leaseId: ids.lease, provider: "boat", providerLeaseId: "bx_ysh5xvy5", confirmedAt: release.toISOString() };
    const [lease] = await db.insert(environmentLeases).values({ id: ids.lease, companyId: ids.company, environmentId: ids.environment, issueId, heartbeatRunId: ids.old,
      provider: "boat", providerLeaseId: binding.providerLeaseId, leasePolicy: "reuse_by_environment", status: "released", cleanupStatus: "success", failureReason: null,
      acquiredAt: new Date("2026-11-14T13:22:11.225Z"), releasedAt: release, expiresAt: new Date("2026-11-14T21:52:06.972Z"),
      metadata: { driver: "sandbox", sandboxProviderPlugin: true, pluginId: ids.plugin, pluginKey: "paperclip.boat", agentId, ...environment.config,
        leaseController: { pid: 7, bootId: "2126acac-bd09-4502-b4b2-5116b8df3445", hostHash: "ece3ffd4fd550a59334cc49672782bac", processStartedAt: "2026-11-14T11:49:42.560Z" },
        pendingCleanupInFlight: false,
        remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", state: "stopped", ...binding },
        sandboxStopAndRetainReceipt: { schema: "paperclip.sandbox-stop-and-retain-receipt.v1", method: "environmentStopLease", pluginId: ids.plugin, requestId: "de519e8e-0000-4000-8000-000000000001", ...binding },
      } }).returning();
    // Only the requestId prefix was supplied for the historical receipt; its
    // suffix is a fixture. Reader validity depends on a nonempty requestId, not
    // its spelling. Likewise issue/agent IDs and boot-source strings are peers.
    return { agentId, issueId, environment: { ...environment, envVars: {} } as Environment, followUp, lease };
  }
  const row = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids.lease)))[0]!;
  async function record(event: unknown) {
    if (process.env.TASK_OUT) await appendFile(join(process.env.TASK_OUT, "real-row-observations.jsonl"), JSON.stringify(event) + "\n");
  }

  it("accepts both complete bound receipts at 18:25:18, including equality and no kind", async () => {
    const f = await seed();
    const termination = f.lease.metadata!.remoteExecutionTermination as { confirmedAt: string };
    const confirmedAt = Date.parse(termination.confirmedAt);
    const confirmedRelease = hasRemoteTerminationReceipt(f.lease) && Number.isFinite(confirmedAt)
      && confirmedAt >= f.lease.acquiredAt.getTime() && f.lease.releasedAt !== null && confirmedAt <= f.lease.releasedAt.getTime()
      && f.lease.metadata?.pendingCleanupInFlight !== true;
    await record({ test: "predicate", wall, lease: f.lease, hasConfirmedSandboxStopAndRetain: hasConfirmedSandboxStopAndRetain(f.lease), hasRemoteTerminationReceipt: hasRemoteTerminationReceipt(f.lease), confirmedRelease });
    expect(termination).not.toHaveProperty("kind");
    expect(termination.confirmedAt).toBe(f.lease.releasedAt!.toISOString());
    expect(hasBoundRemoteStopReceipt(f.lease)).toBe(true);
    expect(hasRemoteTerminationReceipt(f.lease)).toBe(true);
    expect(hasConfirmedSandboxStopAndRetain(f.lease)).toBe(true);
    expect(confirmedRelease).toBe(true);
    expect(await row()).toEqual(f.lease);
  });

  it("follow-up acquisition with boot-source drift must leave the released receipt row UNCHANGED", async () => {
    const f = await seed();
    const environment: Environment = { ...f.environment, config: { ...f.environment.config, image: "boot-source-after-upgrade" } };
    await db.update(environments).set({ config: environment.config }).where(eq(environments.id, ids.environment));
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentAcquireLease") throw new Error(`A completed stop must not dispatch ${method}`);
      return { providerLeaseId: "bx-fresh", metadata: { ...environment.config, remoteCwd: "/workspace" } };
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
    } as unknown as PluginWorkerManager });
    const acquired = await runtime.acquireRunLease({ companyId: ids.company, environment, issueId: f.issueId, agentId: f.agentId, heartbeatRunId: f.followUp.id, adapterType: "paperclip_runner", persistedExecutionWorkspace: null });
    const after = await row();
    await record({ test: "follow-up-start-source-drift", before: f.lease, after, acquired: acquired.lease, calls: call.mock.calls });
    expect(acquired.lease.providerLeaseId).toBe("bx-fresh");
    expect(after).toEqual(f.lease);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "wrong-lease", "wrong-run", "wrong-allocation", "wrong-schema"])("historical verification still owns genuinely unconfirmed proof: %s", async shape => {
    const f = await seed();
    const metadata = { ...f.lease.metadata };
    if (shape === "missing") delete metadata.remoteExecutionTermination;
    else metadata.remoteExecutionTermination = { ...(metadata.remoteExecutionTermination as Record<string, unknown>),
      ...(shape === "wrong-lease" ? { leaseId: randomUUID() } : {}),
      ...(shape === "wrong-run" ? { runId: randomUUID() } : {}),
      ...(shape === "wrong-allocation" ? { providerLeaseId: "bx-another" } : {}),
      ...(shape === "wrong-schema" ? { schema: "unrecognized" } : {}),
    };
    await db.update(environmentLeases).set({ metadata }).where(eq(environmentLeases.id, ids.lease));
    const before = await row();
    expect(hasRemoteTerminationReceipt(before)).toBe(false);
    expect(await prepareHistoricalSandboxStopVerification(db, before)).toMatchObject({ status: "pending_cleanup", failureReason: "sandbox_stop_pending" });
  });

  it.each(["released", "expired"])("historical verification must not re-prepare a %s complete bound receipt", async status => {
    const f = await seed();
    await db.update(environmentLeases).set({ status }).where(eq(environmentLeases.id, ids.lease));
    const before = await row();
    expect(await prepareHistoricalSandboxStopVerification(db, before)).toBeNull();
    expect(await row()).toEqual(before);
  });
});
