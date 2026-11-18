// rf-4 C1 (RFL 22:20Z YES for c1c): the 8 real-producer B1 rows, committed from rfl-verdicts/rf4/b1-fix2/judge-real-producer-b1.test.ts.txt unchanged below this line.
// Independent B1 producer reachability checks. Not a live Boat/person journey.
// Leases: environmentRuntimeService.acquireRunLease and its actual environmentService writer.
// Stop receipts: exported production prepareSandboxStopAndRetain + settleStopOnlyCleanup.
// Only provider RPC is scripted. Deliberately planted overlap is explicitly named.
import { randomUUID } from "node:crypto";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";
import { ownLeaseTerminated } from "../services/remote-execution-termination.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

describe("judge B1 exported real producers (PostgreSQL, scripted provider boundary)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("judge-b1-real-"); db = createDb(database.connectionString, { maxConnections: 4 }); }, 120000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function world() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), pluginId = randomUUID();
    const runP = randomUUID(), runQ = randomUUID(), runS = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "judge B1", issuePrefix: `J${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "B1 exported producer reachability", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values([runP, runQ, runS].map(id => ({ id, companyId, agentId, issueId, status: "running", runtimeMode: "native" })));
    await db.insert(plugins).values({ id: pluginId, pluginKey: `judge.boat.${pluginId}`, packageName: "@paperclipai/judge-boat", version: "0.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", installOrder: 1,
      manifestJson: { id: `judge.boat.${pluginId}`, apiVersion: 1, version: "0.0.0", displayName: "judge provider", description: "scripted boundary", author: "judge", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true, sandboxCapabilities: { reusableLeases: true }, configSchema: { type: "object" } }] }, updatedAt: new Date() } as never);
    const [env] = await db.insert(environments).values({ name: `judge-${pluginId}`, driver: "sandbox", config: { provider: "boat", reuseLease: true } }).returning();
    let boxes = 0;
    const methods = ["environmentAcquireLease", "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease", "environmentInspectLease"];
    const call = vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string }) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: `judge-box-${companyId}-${++boxes}`, metadata: {} };
      if (method === "environmentResumeLease") return { providerLeaseId: params.providerLeaseId, metadata: {} };
      return { providerLeaseId: params.providerLeaseId, state: method === "environmentDestroyLease" ? "destroyed" : "stopped" };
    });
    const manager = { isRunning: (id: string) => id === pluginId, getWorker: () => ({ status: "running", supportedMethods: methods }), call } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager });
    const svc = environmentService(db);
    const acquire = (runId: string, fresh = false) => runtime.acquireRunLease({ companyId, environment: fresh ? { ...env!, config: { ...env!.config, reuseLease: false } } : env!,
      configuredEnvironment: fresh ? env! : undefined, issueId, agentId, heartbeatRunId: runId, persistedExecutionWorkspace: null });
    const read = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
    const stop = async (id: string, state: "stopped" | "destroyed" = "stopped") => {
      const prepared = await prepareSandboxStopAndRetain(db, await read(id));
      expect(prepared).toBeTruthy();
      return settleStopOnlyCleanup(db, prepared!, { attemptId: prepared!.metadata!.pendingCleanupAttemptId as string,
        receipt: { providerLeaseId: prepared!.providerLeaseId, state } });
    };
    const proof = (box: string) => ownLeaseTerminated(db, { companyId, environmentId: env!.id, providerLeaseId: box, runId: runP }, { ownLeaseOnly: true, successorOnOwnerSandbox: false });
    return { companyId, agentId, issueId, env: env!, runP, runQ, runS, acquire, read, stop, proof, svc, call };
  }
  it("real Stop producer creates no peer; successor on NEW B does not invalidate P on A", async () => {
    const w = await world(), p = await w.acquire(w.runP), stopped = await w.stop(p.lease.id);
    expect(stopped?.metadata?.remoteExecutionTermination).toMatchObject({ leaseId: p.lease.id, state: "stopped" });
    const s = await w.acquire(w.runS, true);
    expect(s.lease.providerLeaseId).not.toBe(p.lease.providerLeaseId);
    expect(await w.proof(p.lease.providerLeaseId!)).toBe(true);
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, w.companyId));
    expect(rows).toHaveLength(2);
  });
  it("real past Q -> P handoff with P Stop receipt remains proven", async () => {
    const w = await world(), q = await w.acquire(w.runQ); await w.stop(q.lease.id);
    const p = await w.acquire(w.runP); expect(p.lease.providerLeaseId).toBe(q.lease.providerLeaseId);
    await w.stop(p.lease.id);
    expect((await w.read(q.lease.id)).releasedAt).toBeTruthy();
    expect(await w.proof(p.lease.providerLeaseId!)).toBe(true);
  });
  it("real Stop then Q resume and Q stop is B1-unproven despite Q now CLOSED", async () => {
    const w = await world(), p = await w.acquire(w.runP); await w.stop(p.lease.id);
    const q = await w.acquire(w.runQ); expect(q.lease.providerLeaseId).toBe(p.lease.providerLeaseId);
    await w.stop(q.lease.id);
    expect((await w.read(q.lease.id)).releasedAt).toBeTruthy();
    expect(await w.proof(p.lease.providerLeaseId!)).toBe(false);
  });
  it("real producer Q handoff exactly at receipt confirmedAt (frozen Date only) invalidates P", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T12:00:00.000Z"));
    try {
      const w = await world(), p = await w.acquire(w.runP); const stopped = await w.stop(p.lease.id);
      const q = await w.acquire(w.runQ); await w.stop(q.lease.id);
      const receipt = stopped!.metadata!.remoteExecutionTermination as { confirmedAt: string };
      expect(new Date((await w.read(q.lease.id)).acquiredAt).getTime()).toBe(Date.parse(receipt.confirmedAt));
      expect(await w.proof(p.lease.providerLeaseId!)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("real destroyed stop-only settlement alone stays proven for successor on new B", async () => {
    const w = await world(), p = await w.acquire(w.runP); const destroyed = await w.stop(p.lease.id, "destroyed");
    expect(destroyed?.metadata?.remoteExecutionTermination).toMatchObject({ state: "destroyed", leaseId: p.lease.id });
    const s = await w.acquire(w.runS, true); expect(s.lease.providerLeaseId).not.toBe(p.lease.providerLeaseId);
    expect(await w.proof(p.lease.providerLeaseId!)).toBe(true);
  });
  it("real Q reusable warm hold on resumed A is another OPEN holder", async () => {
    const w = await world(), p = await w.acquire(w.runP); await w.stop(p.lease.id);
    const q = await w.acquire(w.runQ); expect(q.lease.providerLeaseId).toBe(p.lease.providerLeaseId);
    await w.svc.releaseLease(q.lease.id, "retained", { cleanupStatus: "success" });
    expect((await w.read(q.lease.id)).releasedAt).toBeNull();
    expect(await w.proof(p.lease.providerLeaseId!)).toBe(false);
  });
  it("real same-run P reacquisition reuses its row and INVALIDATES old stop receipt", async () => {
    const w = await world(), p = await w.acquire(w.runP); await w.stop(p.lease.id);
    const p2 = await w.acquire(w.runP);
    expect(p2.lease.id).toBe(p.lease.id);
    expect(p2.lease.metadata?.remoteExecutionTermination).toBeUndefined();
    expect(await w.proof(p.lease.providerLeaseId!)).toBe(false);
  });
  it("planted earlier OPEN overlap: beside real Stop rows; real stop settlement REFUSES to publish P receipt", async () => {
    const w = await world(), p = await w.acquire(w.runP);
    await w.svc.acquireLease({ companyId: w.companyId, environmentId: w.env.id, issueId: w.issueId, heartbeatRunId: w.runQ,
      provider: "boat", providerLeaseId: p.lease.providerLeaseId, leasePolicy: "reuse_by_environment", metadata: { agentId: w.agentId } });
    expect(await w.stop(p.lease.id)).toBeNull();
    expect((await w.read(p.lease.id)).metadata?.remoteExecutionTermination).toBeUndefined();
    expect(await w.proof(p.lease.providerLeaseId!)).toBe(false);
  });
});
