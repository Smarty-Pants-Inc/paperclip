// pl/warm-reuse-owed: after a person's mid-turn Stop of a warm (keep_running)
// turn, the next message's run must reuse the SAME retained lease and box (same
// provider lease, so the provider thread continues), with or without an
// unsynced box-only file. Live rows (gate 1, 'without'): 25eaaef3 -> bea2f893
// (bx_e2vc87w7 -> bx_w6ummje5) and c2ebc3ab -> ff302c12 (bx_xpbag98s ->
// bx_6u5bz37j); the stopped run's lease stayed retained, its v3 export PREPARED.
// CAUSE: the stopped run's Runner had launched, so its PREPARED reference on the
// candidate lease reads as a pending export (nativeWorkspaceSourcePending) and
// the acquisition drops the lease. A Stop before Runner launch is not pending
// (cancelledBeforeRunnerLaunch), which is why an earlier harness reused the box.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, plugins, projects } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { classifyNativeWorkspaceInbound } from "../services/native-runtime/native-workspace-sync.ts";
import { nativeWorkspaceExportPendingForResource } from "../services/native-runtime/native-workspace-finalization-state.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

const proof = vi.hoisted(() => ({ exited: true, asked: [] as Array<{ runId: string; providerLeaseId: string | null }> }));
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The s3 fence's proof needs a live Runner; the real proof has its own rows (pl/s3-fence).
  handedOffWarmOwnerRunnerExited: vi.fn(async (input: { runId: string; providerLeaseId: string | null }) => {
    proof.asked.push(input);
    return proof.exited;
  }),
}));

const support = await getEmbeddedPostgresTestSupport();
const describeEmbedded = support.supported ? describe : describe.skip;
const FILE_SHA = "5e1f".repeat(16);

describeEmbedded("pl/warm-reuse-owed: the direct successor of a handed-off warm Stop reuses the box", () => {
  let db: ReturnType<typeof createDb>;
  let stopDb: (() => Promise<void>) | null = null;
  let connectionString = "";
  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("warm-reuse-owed");
    stopDb = started.cleanup;
    connectionString = started.connectionString;
  });
  beforeEach(() => { db = createDb(connectionString); proof.exited = true; proof.asked = []; });
  afterEach(() => vi.clearAllMocks());
  afterAll(async () => { await stopDb?.(); });

  type Options = { file?: boolean; runnerLaunched?: boolean; stop?: "acknowledged" | "pending"; disposition?: string };

  async function seed(options: Options = {}) {
    const { file = false, runnerLaunched = true, stop = "acknowledged", disposition = "keep_running" } = options;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const pluginId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const otherWorkspaceId = randomUUID();
    const box = `bx_${companyId.slice(0, 8)}`;
    const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 1234, reuseLease: true };
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active", issuePrefix: `W${companyId.slice(0, 6).toUpperCase()}` });
    for (const id of [agentId, otherAgentId]) await db.insert(agents).values({ id, companyId, name: `Pi ${id.slice(0, 6)}`,
      role: "engineer", status: "active", adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const [environmentRow] = await db.insert(environments).values({ id: randomUUID(), name: `Warm box ${companyId}`, driver: "sandbox",
      status: "active", config: providerConfig }).returning();
    const environment = { ...environmentRow, envVars: {} } as unknown as Environment;
    const pluginKey = `acme.warm.${companyId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: `@acme/warm-${companyId.slice(0, 8)}`, version: "1.0.0", apiVersion: 1,
      categories: ["automation"], manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Warm", description: "warm",
        author: "t", categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake", supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, timeoutMs: { type: "number" }, reuseLease: { type: "boolean" } } } }] },
      status: "ready", installOrder: 1 } as any);
    await db.insert(projects).values({ id: projectId, companyId, name: "Chat", status: "active" });
    for (const id of [executionWorkspaceId, otherWorkspaceId]) await db.insert(executionWorkspaces).values({ id, companyId, projectId,
      mode: "shared_workspace", strategyType: "project_primary", name: `Chat ${id.slice(0, 6)}`, status: "active", providerType: "local_fs" });
    // The provider's boxes: each box's workspace files (path -> sha256). A fresh box starts at the host baseline (no box-only file).
    const boxes = new Map<string, Map<string, string>>();
    let fresh = 0;
    const lease = (providerLeaseId: string) => ({ providerLeaseId, metadata: { ...providerConfig, remoteCwd: "/workspace" } });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_id: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          const id = fresh++ === 0 ? box : `bx_fresh_${fresh}_${companyId.slice(0, 4)}`;
          boxes.set(id, new Map());
          return lease(id);
        }
        if (method === "environmentResumeLease") return lease(params.providerLeaseId);
        if (["environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"].includes(method)) return { providerLeaseId: params.providerLeaseId, state: "stopped" };
        throw new Error(`unexpected ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const acquire = (runId: string, agent = agentId, workspaceId = executionWorkspaceId) => runtime.acquireRunLease({ companyId, environment,
      issueId: null, agentId: agent, heartbeatRunId: runId, persistedExecutionWorkspace: { id: workspaceId, mode: "shared_workspace" } });
    let clock = Date.now() - 10 * 60_000;
    const newRun = async (agent = agentId) => {
      const id = randomUUID();
      clock += 10_000;
      await db.insert(heartbeatRuns).values({ id, companyId, agentId: agent, invocationSource: "on_demand", status: "running",
        runtimeMode: "native", createdAt: new Date(clock), updatedAt: new Date(clock) });
      return id;
    };

    /** A warm turn on its lease, Stopped mid-turn by a person: its v3 export stays PREPARED (shaped like 25eaaef3 / c2ebc3ab). */
    async function stopMidTurn(runId: string, leaseRow: typeof environmentLeases.$inferSelect, writeFile: boolean) {
      if (writeFile) boxes.get(leaseRow.providerLeaseId!)!.set("notes.txt", FILE_SHA);
      await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, leaseRow.id));
      const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "d".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: executionWorkspaceId, leaseId: leaseRow.id,
        providerLeaseId: leaseRow.providerLeaseId, remoteCwd: "/workspace", resourceDisposition: disposition };
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(clock + 5_000), errorCode: "cancelled",
        // The live rows' Runner had launched (process identity recorded); a Stop before launch owes no export.
        ...(runnerLaunched ? { processPid: 4242, processGroupId: 4242, startedAt: new Date(clock) } : {}),
        runnerProfileJson: { nativeWorkspaceSync: reference },
        resultJson: { nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId, companyId, issueId: null,
          scope: "run", reasonCode: "cancellation_run_only", dispatchState: stop, dispatched: true,
          intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID() } } }).where(eq(heartbeatRuns.id, runId));
    }

    const stoppedRunId = await newRun();
    const first = await acquire(stoppedRunId);
    expect(first.lease.providerLeaseId).toBe(box);
    await stopMidTurn(stoppedRunId, first.lease, file);
    const leaseRow = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
    return { companyId, agentId, otherAgentId, otherWorkspaceId, box, boxes, stoppedRunId, firstLease: first.lease, acquire, newRun,
      stopMidTurn, leaseRow };
  }

  for (const file of [false, true]) {
    it(`the direct successor reuses the SAME lease and box, adopt_remote (${file ? "remote-only unsynced file" : "no file"})`, async () => {
      const s = await seed({ file });
      // The successor's acquire time: the predecessor's lease is shaped like 377ef66c / a6d821a1.
      const before = await s.leaseRow(s.firstLease.id);
      expect(before).toMatchObject({ status: "retained", leasePolicy: "reuse_by_environment", releasedAt: null, heartbeatRunId: s.stoppedRunId });
      const successorRunId = await s.newRun();
      const next = await s.acquire(successorRunId);
      expect(next.lease.providerLeaseId).toBe(s.box);
      expect(next.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
      expect(classifyNativeWorkspaceInbound({ kind: "new_run", acquisition: "resumed", hasPriorStamp: true })).toBe("adopt_remote");
      expect(proof.asked).toContainEqual({ runId: s.stoppedRunId, providerLeaseId: s.box });
      if (file) expect(s.boxes.get(next.lease.providerLeaseId!)!.get("notes.txt")).toBe(FILE_SHA);
      // W3: the box stays protected for anyone else while the predecessor's export is owed.
      expect(await nativeWorkspaceExportPendingForResource(db, next.lease, null)).toBe(true);
    });
  }

  it("probe: a Stop before the Runner launched owes no export, so even base reuses the box", async () => {
    const s = await seed({ runnerLaunched: false });
    const next = await s.acquire(await s.newRun());
    expect(next.lease.providerLeaseId).toBe(s.box);
  });

  it("W2: another agent never adopts the box holding owed bytes", async () => {
    const s = await seed({ file: true });
    const next = await s.acquire(await s.newRun(s.otherAgentId), s.otherAgentId);
    expect(next.lease.providerLeaseId).not.toBe(s.box);
    expect((await s.leaseRow(s.firstLease.id)).status).toBe("retained");
    expect(await nativeWorkspaceExportPendingForResource(db, await s.leaseRow(s.firstLease.id), null)).toBe(true);
  });

  it("W2: another chat (execution workspace) never adopts the box holding owed bytes", async () => {
    const s = await seed({ file: true });
    const next = await s.acquire(await s.newRun(), s.agentId, s.otherWorkspaceId);
    expect(next.lease.providerLeaseId).not.toBe(s.box);
    expect((await s.leaseRow(s.firstLease.id)).status).toBe("retained");
  });

  it.each([
    ["the Runner is not proven exited", { exited: false }],
    ["the Stop is not acknowledged", { stop: "pending" as const }],
    ["the turn was not keep_running", { disposition: "stop_and_retain" }],
  ])("keeps the box excluded when %s", async (_name, variant) => {
    const s = await seed({ file: true, ...("stop" in variant ? { stop: variant.stop } : {}),
      ...("disposition" in variant ? { disposition: variant.disposition } : {}) });
    if ("exited" in variant) proof.exited = variant.exited;
    const next = await s.acquire(await s.newRun());
    expect(next.lease.providerLeaseId).not.toBe(s.box);
    expect(await nativeWorkspaceExportPendingForResource(db, await s.leaseRow(s.firstLease.id), null)).toBe(true);
  });

  it("W2: a later, not direct, run of the agent never adopts the owed box", async () => {
    const s = await seed({ file: true });
    // Another run of the same agent sits between the Stop and this message (on another chat).
    await s.acquire(await s.newRun(), s.agentId, s.otherWorkspaceId);
    const next = await s.acquire(await s.newRun());
    expect(next.lease.providerLeaseId).not.toBe(s.box);
    expect((await s.leaseRow(s.firstLease.id)).status).toBe("retained");
  });

  it("W6: exactly one successor adopts; a second wake of the same agent never takes the adopted box", async () => {
    const s = await seed({ file: true });
    const b = await s.newRun();
    const c = await s.newRun();
    // c is not the direct successor of the Stop (b is): c cannot adopt even first.
    expect((await s.acquire(c)).lease.providerLeaseId).not.toBe(s.box);
    const s2 = await seed({ file: true });
    const b2 = await s2.newRun();
    expect((await s2.acquire(b2)).lease.providerLeaseId).toBe(s2.box);
    expect((await s2.leaseRow(s2.firstLease.id)).status).not.toBe("retained");
    const c2 = await s2.newRun();
    expect((await s2.acquire(c2)).lease.providerLeaseId).not.toBe(s2.box);
    void b;
  });

  it("W3/W8: a successor Stopped before its finalize keeps the protection; two Stops in a row never free the box", async () => {
    const s = await seed({ file: true });
    const b = await s.newRun();
    const bLease = await s.acquire(b);
    expect(bLease.lease.providerLeaseId).toBe(s.box);
    await s.stopMidTurn(b, bLease.lease, false);
    // The predecessor's owed bytes and B's own prepared export both still protect the box.
    expect(await nativeWorkspaceExportPendingForResource(db, await s.leaseRow(bLease.lease.id), null)).toBe(true);
    expect(await nativeWorkspaceExportPendingForResource(db, await s.leaseRow(s.firstLease.id), null)).toBe(true);
    // Another agent never takes the box after the second Stop.
    const other = await s.acquire(await s.newRun(s.otherAgentId), s.otherAgentId);
    expect(other.lease.providerLeaseId).not.toBe(s.box);
    expect(s.boxes.get(s.box)!.get("notes.txt")).toBe(FILE_SHA);
  });
});
