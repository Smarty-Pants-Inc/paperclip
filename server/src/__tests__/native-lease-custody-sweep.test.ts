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
import { settleOwnableKind } from "../services/recovery/ownership-invariant-report.js";
import { logger } from "../middleware/logger.js";
import { agentRoutes } from "../routes/agents.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { routeApp, type BoardActor } from "./helpers/route-test-harness.js";

// Never-OK (rf-4 F2, RFL 05:59Z): a native lease's box is never destroyed
// without a VERIFIED saved harness copy. No copy: it is stopped and kept,
// named, owned by the retained-orphan settle, retried, and escalated after
// the cleanup cap. Released-box cleanup also requires its stop receipt and a
// completed provider snapshot read back for the exact allocation.
const support = await getEmbeddedPostgresTestSupport();
const PROVIDER_METHODS = ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease",
  "environmentDestroyLease", "environmentStopLease", "environmentInspectLease"];
const KIND = "environment_retained_orphan_sandbox";

describe.skipIf(!support.supported)("native lease custody before any destructive cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-lease-custody-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  /** Exact stop/destroy receipts and optional completed snapshot read-back at the provider boundary. */
  function provider(pluginId: string, companyId: string, withSnapshot: boolean) {
    const calls: Array<{ method: string; providerLeaseId?: string; backupsAtCall: number }> = [];
    const manager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: PROVIDER_METHODS })),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string }) => {
        const backups = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.companyId, companyId));
        calls.push({ method, providerLeaseId: params.providerLeaseId, backupsAtCall: backups.length });
        if (method === "environmentInspectLease") return { providerLeaseId: params.providerLeaseId, state: "stopped",
          ...(withSnapshot ? { snapshot: { id: `snapshot-${params.providerLeaseId}`, state: "completed" } } : {}) };
        if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
        if (method === "environmentDestroyLease" || method === "environmentReleaseLease")
          return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
        throw new Error(`Unexpected provider method ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    return { manager, calls, destroys: () => calls.filter(c => c.method === "environmentDestroyLease"),
      stops: () => calls.filter(c => c.method === "environmentStopLease"),
      inspections: () => calls.filter(c => c.method === "environmentInspectLease") };
  }

  async function seed(opts: { runStatus?: "cancelled" | "running"; runtimeMode?: "native" | "legacy"; started?: boolean;
    completedSnapshot?: boolean } = {}) {
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
    return { companyId, agentId, issueId, runId, box, leaseId: lease!.id, actor,
      ...provider(pluginId, companyId, opts.completedSnapshot ?? false) };
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
  async function sweep(f: Awaited<ReturnType<typeof seed>>) {
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager });
    await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0, leaseId: f.leaseId });
    await heartbeat.sweepPendingCleanupLeases();
    return heartbeat;
  }
  function expectStoppedAndKept(lease: typeof environmentLeases.$inferSelect, box: string) {
    expect(lease.status).toBe("released");
    expect(lease.metadata?.remoteExecutionTermination).toMatchObject({ state: "stopped", providerLeaseId: box });
    // Named: the durable obligation the retained-orphan settle owns.
    expect(lease.metadata?.orphanedRunLeaseRecovery).toMatchObject({ nativeCustodyUnverified: true });
  }

  it("(a) real-route cancel of a native run, then the sweep: no copy -> box stopped + named, never destroyed", async () => {
    const f = await seed({ runStatus: "running" });
    const app = routeApp(db, f.actor, (d) => agentRoutes(d));
    const cancel = await request(app).post(`/api/heartbeat-runs/${f.runId}/cancel`).send({});
    expect(cancel.status).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run!.status).toBe("cancelled");
    await sweep(f);
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_A_REAL_ROUTE", JSON.stringify({ calls: f.calls, status: lease.status,
      termination: lease.metadata?.remoteExecutionTermination, named: lease.metadata?.orphanedRunLeaseRecovery }));
    expect(f.destroys()).toEqual([]);
    expect(f.stops()).toHaveLength(1);
    expectStoppedAndKept(lease, f.box);
  }, 30_000);

  it("(b) a verified saved copy -> destroyed as today", async () => {
    const f = await seed();
    await saveCopy(f, true);
    await sweep(f);
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_B", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(f.destroys()).toEqual([{ method: "environmentDestroyLease", providerLeaseId: f.box, backupsAtCall: 1 }]);
    expect(lease.status).toBe("expired");
  }, 30_000);

  it("(c) a copy row whose bytes are missing is not custody -> NOT destroyed, stopped + named", async () => {
    const f = await seed();
    await saveCopy(f, false);
    await sweep(f);
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_C", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(f.destroys()).toEqual([]);
    expectStoppedAndKept(lease, f.box);
  }, 30_000);

  it("(d) retry: the copy becomes verified later -> destroyed on the next sweep with stop receipt and completed snapshot", async () => {
    const f = await seed({ completedSnapshot: true });
    const copy = await saveCopy(f, false);
    const heartbeat = await sweep(f);
    expectStoppedAndKept(await leaseRow(f.leaseId), f.box);
    const held = await settleOwnableKind(db, KIND);
    expect(held.filter(r => r.recordId === f.leaseId)).toEqual([]);
    expect(f.destroys()).toEqual([]);
    copy.store();
    const settled = await settleOwnableKind(db, KIND);
    expect(settled.map(r => r.recordId)).toContain(f.leaseId);
    // Sweep ticks: rows of other fixtures (other provider workers) are deferred to the back.
    for (let tick = 0; tick < 3 && (await leaseRow(f.leaseId)).status === "pending_cleanup"; tick += 1)
      await heartbeat.sweepPendingCleanupLeases();
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_D", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(lease.metadata?.workspaceRecoveryCleanup).toMatchObject({ stopReceipt: {
      companyId: f.companyId, runId: f.runId, leaseId: f.leaseId, providerLeaseId: f.box, state: "stopped",
    } });
    expect(f.inspections()).toEqual([{ method: "environmentInspectLease", providerLeaseId: f.box, backupsAtCall: 1 }]);
    expect(f.destroys()).toEqual([{ method: "environmentDestroyLease", providerLeaseId: f.box, backupsAtCall: 1 }]);
    expect(lease.status).toBe("expired");
  }, 30_000);

  it("(d sibling) retry: verified copy and stop receipt without a completed snapshot -> held, never destroyed", async () => {
    const f = await seed({ completedSnapshot: false });
    const copy = await saveCopy(f, false);
    const heartbeat = await sweep(f);
    expectStoppedAndKept(await leaseRow(f.leaseId), f.box);
    expect(f.destroys()).toEqual([]);
    copy.store();
    const settled = await settleOwnableKind(db, KIND);
    expect(settled.map(r => r.recordId)).toContain(f.leaseId);
    for (let tick = 0; tick < 3 && f.inspections().length === 0; tick += 1)
      await heartbeat.sweepPendingCleanupLeases();
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_D_WITHOUT_SNAPSHOT", JSON.stringify({ calls: f.calls, status: lease.status,
      holdReason: lease.metadata?.pendingCleanupHoldReason }));
    expect(lease.metadata?.workspaceRecoveryCleanup).toMatchObject({ stopReceipt: {
      companyId: f.companyId, runId: f.runId, leaseId: f.leaseId, providerLeaseId: f.box, state: "stopped",
    } });
    expect(f.inspections()).toEqual([{ method: "environmentInspectLease", providerLeaseId: f.box, backupsAtCall: 1 }]);
    expect(f.destroys()).toHaveLength(0);
    expect(lease).toMatchObject({ status: "pending_cleanup", metadata: {
      pendingCleanupHoldReason: "completed_provider_snapshot_missing",
    } });
  }, 30_000);

  it("(e) a copy that never verifies: kept stopped, counted, escalated once after the cleanup cap", async () => {
    const f = await seed();
    await sweep(f);
    const warn = vi.spyOn(logger, "warn");
    for (let attempt = 0; attempt < 7; attempt += 1) await settleOwnableKind(db, KIND);
    const lease = await leaseRow(f.leaseId);
    const escalations = warn.mock.calls.filter(([fields, message]) => typeof message === "string"
      && message.startsWith("environment lease needs operator attention")
      && (fields as { leaseId?: string }).leaseId === f.leaseId);
    warn.mockRestore();
    console.log("ROW_E", JSON.stringify({ calls: f.calls, status: lease.status,
      attempts: lease.metadata?.nativeCustodyAttempts, escalated: lease.metadata?.nativeCustodyEscalated }));
    expect(f.destroys()).toEqual([]);
    expectStoppedAndKept(lease, f.box);
    expect(lease.metadata?.nativeCustodyAttempts).toBe(7);
    expect(lease.metadata?.nativeCustodyEscalated).toBe(true);
    expect(escalations).toHaveLength(1);
    // Visible count: the ownership report lists the kept box under its run owner.
    const [{ kept }] = await db.execute<{ kept: number }>(sql`select count(*)::int as kept from environment_leases
      where metadata->'orphanedRunLeaseRecovery'->>'nativeCustodyUnverified' = 'true' and status = 'released'
      and company_id = ${f.companyId}`) as unknown as Array<{ kept: number }>;
    expect(kept).toBe(1);
  }, 30_000);

  it("(f) a legacy (non-native) lease keeps today's behaviour: destroyed without a copy", async () => {
    const f = await seed({ runtimeMode: "legacy", started: false });
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager });
    await heartbeat.releaseEnvironmentLeasesForRun?.({ runId: f.runId, companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", providerResourceDisposition: "destroy" } as never);
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_F", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(f.destroys()).toEqual([{ method: "environmentDestroyLease", providerLeaseId: f.box, backupsAtCall: 0 }]);
    expect(lease.status).toBe("expired");
  }, 30_000);
});
