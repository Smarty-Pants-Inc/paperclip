import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, environmentLeases, environments, heartbeatRunEvents,
  heartbeatRuns, issues, nativeHarnessBackups, nativeRunFinalizations, plugins,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "ref") }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));
// Only the object store is in memory; the verification helper that reads and
// digests the saved copy's bytes is the real one.
const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../storage/index.js", () => ({
  getStorageService: () => ({
    provider: "memory",
    async getObject(companyId: string, objectKey: string) {
      const bytes = objects.get(`${companyId}/${objectKey}`);
      if (!bytes) throw new Error("object not found");
      return { stream: Readable.from([bytes]), contentLength: bytes.length };
    },
  }),
}));

import { heartbeatService } from "../services/heartbeat.ts";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { markNativeHarnessBackupMissing } from "../services/native-runtime/native-harness-backup-missing.js";
import { retiredReusableLeasePredecessors } from "../services/environment-lease-handoff.js";
import { agentRoutes } from "../routes/agents.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { routeApp, type BoardActor } from "./helpers/route-test-harness.js";

// Never-OK: cancelling a person's run must not leave its unsaved box running,
// and a claim-only successor must not hide the predecessor trace on its box.
const support = await getEmbeddedPostgresTestSupport();
const PROVIDER_METHODS = ["environmentAcquireLease", "environmentResumeLease", "environmentExecute", "environmentReleaseLease",
  "environmentDestroyLease", "environmentStopLease"];

describe.skipIf(!support.supported)("allocation custody round 3: real cancel and reusable handoff", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-lease-custody-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  /** A provider that answers stop and destroy with exact receipts; records backups at each call. */
  function provider(pluginId: string, companyId: string, box: string) {
    const calls: Array<{ method: string; providerLeaseId?: string; backupsAtCall: number }> = [];
    const manager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: PROVIDER_METHODS })),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string; config?: Record<string, unknown> }) => {
        const backups = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.companyId, companyId));
        calls.push({ method, providerLeaseId: params.providerLeaseId, backupsAtCall: backups.length });
        if (method === "environmentAcquireLease" || method === "environmentResumeLease")
          return { providerLeaseId: params.providerLeaseId ?? box, metadata: { ...params.config, remoteCwd: "/workspace" } };
        if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
        if (method === "environmentDestroyLease" || method === "environmentReleaseLease")
          return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
        throw new Error(`Unexpected provider method ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    return { manager, calls, destroys: () => calls.filter(c => c.method === "environmentDestroyLease"),
      stops: () => calls.filter(c => c.method === "environmentStopLease") };
  }

  async function seed(opts: { runStatus?: "cancelled" | "running"; runtimeMode?: "native" | "legacy"; started?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const environmentId = randomUUID(), pluginId = randomUUID(), userId = `board-${companyId.slice(0, 8)}`;
    const pluginKey = `paperclip.custody-${pluginId.slice(0, 8)}`;
    // One driver key per fixture: the recorded-teardown path resolves the provider plugin by key.
    const driverKey = `fake-boat-${pluginId.slice(0, 8)}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey, packageName: "@paperclipai/plugin-fake-sandbox", version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: { id: pluginKey, apiVersion: 1, version: "1.0.0", displayName: "Fake Boat", description: "Test provider",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey, kind: "sandbox_provider", displayName: "Fake Boat",
          configSchema: { type: "object" } }] } } as never);
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "Custody", requireBoardApprovalForNewAgents: false,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user",
      status: "active", membershipRole: "owner" });
    const config = { provider: driverKey, image: "fake:test", timeoutMs: 1234, reuseLease: false };
    await db.insert(environments).values({ id: environmentId, name: `Fake Boat ${environmentId}`, driver: "sandbox",
      status: "active", config });
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed Pi", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: { provider: "pi" }, runtimeConfig: {}, permissions: {},
      defaultEnvironmentId: environmentId });
    await db.insert(issues).values({ id: issueId, companyId, title: "Native task", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId });
    const startedAt = new Date(Date.now() - 60_000);
    const runtimeMode = opts.runtimeMode ?? "native";
    const running = opts.runStatus === "running";
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand",
      status: opts.runStatus ?? "cancelled", runtimeMode, runtimeModeResolvedAt: startedAt, issueId,
      nativeIssueId: runtimeMode === "native" ? issueId : null, startedAt,
      finishedAt: running ? null : new Date(Date.now() - 30_000), contextSnapshot: { issueId },
      ...(running ? {} : { errorCode: "operator_interrupted",
        resultJson: { executionCancellation: { state: "requested" }, cancelledByActorType: "user" } }) });
    if (running) {
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
      await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "observed", attempt: 0,
        failureDetail: {}, resultId: null, leaseOwner: null });
    }
    if (opts.started !== false) await db.insert(heartbeatRunEvents).values({ companyId, runId, agentId, seq: 1,
      eventType: "turn.started", stream: "system", level: "info", message: "native turn started" })
      .then(() => db.update(heartbeatRuns).set({ nextEventSeq: 2 }).where(eq(heartbeatRuns.id, runId)));
    const box = `box-${randomUUID()}`;
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId, heartbeatRunId: runId, issueId,
      status: "active", leasePolicy: "ephemeral", provider: driverKey, providerLeaseId: box,
      metadata: { ...config, agentId, driver: "sandbox", pluginId, pluginKey, sandboxProviderPlugin: true,
        remoteCwd: "/workspace", sandboxState: "started", sandboxLeaseAcquisition: { outcome: "created" } } }).returning();
    const actor: BoardActor = { type: "board", userId, companyIds: [companyId], memberships: [{ companyId,
      membershipRole: "owner", status: "active" }], isInstanceAdmin: false, source: "session" } as unknown as BoardActor;
    return { companyId, agentId, issueId, runId, environmentId, pluginId, config, box, leaseId: lease!.id, actor, ...provider(pluginId, companyId, box) };
  }

  /** A saved harness copy row of the run; `withBytes` stores its object bytes. */
  async function saveCopy(f: { companyId: string; issueId: string; runId: string }, withBytes: boolean) {
    const id = randomUUID(), scopeDigest = createHash("sha256").update(`scope-${id}`).digest("hex");
    const bytes = Buffer.from(`harness archive ${id}`);
    const manifestSha256 = `sha256:${createHash("sha256").update(`manifest-${id}`).digest("hex")}`;
    const objectKey = `${f.companyId}/native-harness-backups/${scopeDigest}/${id}.pchn`;
    await db.insert(nativeHarnessBackups).values({ id, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      scopeDigest, manifestSha256, status: "current", reference: { schema: "paperclip.native-harness-object.v1", id,
        companyId: f.companyId, scopeDigest, objectKey, sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length, material: { cipher: "test" }, manifestSha256 } });
    const store = () => objects.set(`${f.companyId}/${objectKey}`, bytes);
    if (withBytes) store();
    return { store };
  }

  const leaseRow = async (id: string) => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, id)))[0]!;
  function expectStoppedAndKept(lease: typeof environmentLeases.$inferSelect, box: string) {
    expect(lease.status).toBe("released");
    expect(lease.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped", providerLeaseId: box });
    // Named: the durable obligation the retained-orphan settle owns.
    expect(lease.metadata?.orphanedRunLeaseRecovery).toMatchObject({ nativeCustodyUnverified: true });
  }

  it("(K) real cancel, pre-existing pending destroy + missing-backup marker: stop before deferral", async () => {
    const f = await seed({ runStatus: "running" });
    const app = routeApp(db, f.actor, d => agentRoutes(d));
    expect((await request(app).post(`/api/heartbeat-runs/${f.runId}/cancel`).send({})).status).toBe(200);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]?.status).toBe("cancelled");
    // Persist the old queued-destroy shape through the real lease-release producer.
    await environmentService(db).releaseLease(f.leaseId, "pending_cleanup", { cleanupStatus: "failed",
      failureReason: "pending_cleanup_retry" });
    await markNativeHarnessBackupMissing(db, { companyId: f.companyId, environmentId: f.environmentId,
      providerLeaseId: f.box, runId: f.runId, leaseId: f.leaseId, sessionId: randomUUID(), reason: "close_failed" });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager });
    await heartbeat.sweepPendingCleanupLeases();
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_K", JSON.stringify({ calls: f.calls, status: lease.status,
      termination: lease.metadata?.remoteExecutionTermination, named: lease.metadata?.orphanedRunLeaseRecovery }));
    expect(f.destroys()).toEqual([]);
    expect(f.stops()).toEqual([{ method: "environmentStopLease", providerLeaseId: f.box, backupsAtCall: 0 }]);
    expectStoppedAndKept(lease, f.box);
    // A later tick does not stop again and does not discharge the missing copy.
    await heartbeat.sweepPendingCleanupLeases();
    expect(f.stops()).toHaveLength(1);
    expect((await leaseRow(f.leaseId)).metadata?.nativeHarnessBackupMissing).toBeDefined();
  }, 30_000);

  async function handoff() {
    const f = await seed({ runStatus: "running" });
    await db.delete(environmentLeases).where(eq(environmentLeases.id, f.leaseId));
    const config = { ...f.config, reuseLease: true };
    await db.update(environments).set({ config }).where(eq(environments.id, f.environmentId));
    const [plugin] = await db.select().from(plugins).where(eq(plugins.id, f.pluginId));
    const manifest = plugin!.manifestJson!;
    await db.update(plugins).set({ manifestJson: { ...manifest,
      environmentDrivers: manifest.environmentDrivers!.map(driver => ({ ...driver, supportsReusableLeases: true })) } })
      .where(eq(plugins.id, f.pluginId));
    const environment = (await environmentService(db).getById(f.environmentId))!;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: f.manager });
    const acquire = (runId: string) => runtime.acquireRunLease({ companyId: f.companyId, environment,
      issueId: f.issueId, agentId: f.agentId, adapterType: "paperclip_runner", heartbeatRunId: runId,
      persistedExecutionWorkspace: null });
    const sessionId = randomUUID();
    await db.update(heartbeatRuns).set({ nativeSessionId: sessionId }).where(eq(heartbeatRuns.id, f.runId));
    const predecessor = await acquire(f.runId);
    await runtime.releaseRunLeases(f.runId, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const successorRunId = randomUUID();
    // Claim fields only: no selected session, process, or turn-start event.
    await db.insert(heartbeatRuns).values({ id: successorRunId, companyId: f.companyId, agentId: f.agentId,
      invocationSource: "on_demand", status: "running", runtimeMode: "native", runtimeModeResolvedAt: new Date(),
      issueId: f.issueId, nativeIssueId: f.issueId });
    const successor = await acquire(successorRunId);
    expect(successor.lease.providerLeaseId).toBe(predecessor.lease.providerLeaseId);
    expect(successor.lease.id).not.toBe(predecessor.lease.id);
    expect(successor.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ outcome: "resumed" });
    const previous = await leaseRow(predecessor.lease.id);
    expect(retiredReusableLeasePredecessors(await leaseRow(successor.lease.id), [previous])?.map(row => row.id))
      .toEqual([predecessor.lease.id]);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, successorRunId));
    return { ...f, environment, runtime, predecessor, successor, successorRunId, sessionId };
  }

  it("(M) real reusable handoff to a claim-only successor: predecessor trace is stopped + named, never destroyed", async () => {
    const f = await handoff();
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager });
    // The real issue-scoped Destroy path, then its ordinary pending-cleanup owner.
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId });
    await heartbeat.sweepPendingCleanupLeases();
    const lease = await leaseRow(f.successor.lease.id);
    console.log("ROW_M", JSON.stringify({ calls: f.calls, predecessor: f.predecessor.lease.id,
      successor: f.successor.lease.id, status: lease.status,
      termination: lease.metadata?.remoteExecutionTermination, named: lease.metadata?.orphanedRunLeaseRecovery }));
    expect(f.destroys()).toEqual([]);
    expect(f.stops()).toEqual([{ method: "environmentStopLease", providerLeaseId: f.box, backupsAtCall: 0 }]);
    expectStoppedAndKept(lease, f.box);
  }, 30_000);

  it.each(["predecessor verified", "successor copy only", "predecessor bytes missing", "second session unsaved",
    "irregular chain"] as const)("allocation custody safety: %s", async scenario => {
    const f = await handoff();
    if (scenario === "predecessor verified" || scenario === "second session unsaved") await saveCopy(f, true);
    if (scenario === "successor copy only") await saveCopy({ ...f, runId: f.successorRunId }, true);
    if (scenario === "predecessor bytes missing") await saveCopy(f, false);
    if (scenario === "second session unsaved") await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() })
      .where(eq(heartbeatRuns.id, f.successorRunId));
    if (scenario === "irregular chain") await db.update(environmentLeases).set({ cleanupStatus: "failed" })
      .where(eq(environmentLeases.id, f.predecessor.lease.id));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId });
    await heartbeatService(db, { pluginWorkerManager: f.manager }).sweepPendingCleanupLeases();
    const lease = await leaseRow(f.successor.lease.id);
    console.log("ROW_M_SAFETY", scenario, JSON.stringify({ calls: f.calls, status: lease.status,
      named: lease.metadata?.orphanedRunLeaseRecovery }));
    if (scenario === "predecessor verified") {
      expect(f.stops()).toEqual([]);
      expect(f.destroys()).toEqual([{ method: "environmentDestroyLease", providerLeaseId: f.box, backupsAtCall: 1 }]);
      expect(lease.status).toBe("expired");
    } else {
      expect(f.destroys()).toEqual([]);
      expect(f.stops()).toHaveLength(1);
      expectStoppedAndKept(lease, f.box);
    }
  }, 30_000);
});
