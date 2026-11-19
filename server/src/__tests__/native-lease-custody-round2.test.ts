import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
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
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { BoardActor } from "./helpers/route-test-harness.js";

// Never-OK, round 2 (rf-3 F2 + F3). (g) A destroy queued in pending_cleanup
// BEFORE the custody check for a native box with no verified copy is turned
// into the stop-only cleanup: stopped (not destroyed), named, and owned by
// the retained-orphan retry. (h) Native for custody is ANY native session
// identity, not only a persisted start event.
const support = await getEmbeddedPostgresTestSupport();
const PROVIDER_METHODS = ["environmentAcquireLease", "environmentExecute", "environmentReleaseLease",
  "environmentDestroyLease", "environmentStopLease"];
const KIND = "environment_retained_orphan_sandbox";

describe.skipIf(!support.supported)("native lease custody round 2: pre-fix pending rows and any native identity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-native-lease-custody-r2-");
    db = createDb(tempDb.connectionString);
  }, 90_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  /** A provider that answers stop and destroy with exact receipts; records backups at each call. */
  function provider(pluginId: string, companyId: string) {
    const calls: Array<{ method: string; providerLeaseId?: string; backupsAtCall: number }> = [];
    const manager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: PROVIDER_METHODS })),
      call: vi.fn(async (_id: string, method: string, params: { providerLeaseId?: string }) => {
        const backups = await db.select().from(nativeHarnessBackups).where(eq(nativeHarnessBackups.companyId, companyId));
        calls.push({ method, providerLeaseId: params.providerLeaseId, backupsAtCall: backups.length });
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
    return { companyId, agentId, issueId, runId, box, leaseId: lease!.id, actor, ...provider(pluginId, companyId) };
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

  /** Plant a destroy queued before the custody check (round 1 left these running). */
  async function plantPreFixPendingDestroy(leaseId: string) {
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed",
      failureReason: "pending_cleanup_retry", releasedAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60 * 60_000),
      metadata: sql`${environmentLeases.metadata} || '{"pendingCleanupInFlight":false,"pendingCleanupRetryAfterMs":0,"pendingCleanupRetryAttempts":0}'::jsonb`,
    }).where(eq(environmentLeases.id, leaseId));
  }

  it("(g) a pre-fix pending_cleanup native lease without a copy: the next sweep STOPS it (never destroys), named, the retry owns it", async () => {
    const f = await seed();
    await plantPreFixPendingDestroy(f.leaseId);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager });
    for (let tick = 0; tick < 3 && f.stops().length === 0; tick += 1) await heartbeat.sweepPendingCleanupLeases();
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_G_PREFIX_PENDING", JSON.stringify({ calls: f.calls, status: lease.status,
      termination: lease.metadata?.remoteExecutionTermination, named: lease.metadata?.orphanedRunLeaseRecovery }));
    expect(f.destroys()).toEqual([]);
    expect(f.stops()).toEqual([{ method: "environmentStopLease", providerLeaseId: f.box, backupsAtCall: 0 }]);
    expectStoppedAndKept(lease, f.box);
    // Owned by the retained-orphan retry: its settle counts the custody attempt and keeps the box.
    const settled = await settleOwnableKind(db, KIND);
    expect(settled.map(r => r.recordId)).not.toContain(f.leaseId);
    const owned = await leaseRow(f.leaseId);
    console.log("ROW_G_OWNED", JSON.stringify({ attempts: owned.metadata?.nativeCustodyAttempts, status: owned.status }));
    expect(owned.metadata?.nativeCustodyAttempts).toBe(1);
    expect(f.destroys()).toEqual([]);
  }, 30_000);

  it("(g2) a pre-fix pending_cleanup native lease WITH a verified copy is destroyed as today", async () => {
    const f = await seed();
    await saveCopy(f, true);
    await plantPreFixPendingDestroy(f.leaseId);
    const heartbeat = heartbeatService(db, { pluginWorkerManager: f.manager });
    for (let tick = 0; tick < 3 && f.destroys().length === 0; tick += 1) await heartbeat.sweepPendingCleanupLeases();
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_G2", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(f.stops()).toEqual([]);
    expect(f.destroys()).toEqual([{ method: "environmentDestroyLease", providerLeaseId: f.box, backupsAtCall: 1 }]);
    expect(lease.status).toBe("expired");
  }, 30_000);

  it("(h) rf-3's row: a native session identity with NO start event -> not destroyed, stopped + named", async () => {
    const f = await seed({ started: false });
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    await sweep(f);
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_H_NO_EVENT", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(f.destroys()).toEqual([]);
    expectStoppedAndKept(lease, f.box);
  }, 30_000);

  it("(h2) the native session id ALONE (no start event, no resolved mode, no native issue id) needs custody", async () => {
    const f = await seed({ started: false });
    await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID(), runtimeModeResolvedAt: null, nativeIssueId: null })
      .where(eq(heartbeatRuns.id, f.runId));
    await sweep(f);
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_H2_SESSION_ONLY", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(f.destroys()).toEqual([]);
    expectStoppedAndKept(lease, f.box);
  }, 30_000);

  it("(h0) claim-time identities only (resolved native mode, native issue id), no session, never launched -> destroyed as today", async () => {
    // The pre-launch release rows (heartbeat-lease-release-before-runner-attach) need this.
    const f = await seed({ started: false });
    await sweep(f);
    const lease = await leaseRow(f.leaseId);
    console.log("ROW_H0_NO_IDENTITY", JSON.stringify({ calls: f.calls, status: lease.status }));
    expect(f.destroys()).toEqual([{ method: "environmentDestroyLease", providerLeaseId: f.box, backupsAtCall: 0 }]);
    expect(lease.status).toBe("expired");
  }, 30_000);
});
