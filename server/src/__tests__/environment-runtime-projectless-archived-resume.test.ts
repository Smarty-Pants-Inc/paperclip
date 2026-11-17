// adopt-s4c (P0 S4, "after an idle close of more than 5 minutes"): a person's
// projectless chat (issue-only reusable lease, no execution workspace) whose
// warm Boat box was archived while idle. The person sends one message. Its
// FIRST run must either resume the archived box (waiting, bounded and
// invisibly, while Boat reports it is still resuming) or rotate inside the same
// run to a NEW box that carries the chat's verified harness backup (history),
// never fail with "the lease was preserved and no replacement was created".
// Real rows (gate 5, N23b): chat A b46e6cfd/f95280ad box bx_gc4xxpck, chat B
// 4e3b0d59/95b8426d box bx_6p4s2x4m: first runs 4add9c0c and 8e9d53f6 failed
// reusable_sandbox_resume_failed cause=provider_error; Boat finished resuming
// bx_gc4xxpck ~3 min after the server gave up.
// Boat's documented resume refusals (POST /sandboxes/{id}/resume): 409
// sandbox_stopping / sandbox_starting / sandbox_not_ready / machine_not_running,
// 502 sandbox_restoring, 503 (retryAfterSeconds), 429; terminal:
// snapshot_data_expired / resume_failed. The frozen7 plugin reports them as
// "Boat POST /sandboxes/<id>/resume failed (<status>): http_error (<words>)"
// with the safe status/errno in the resume-error envelope; frozen4 sends text only.
import { JsonRpcCallError, environmentResumeErrorData } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, plugins } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// Durable harness-backup verification has its own tests. Here it is a boundary:
// a lease-bound stamp verifies, a missing stamp does not.
vi.mock("../services/native-runtime/native-harness-backup-storage.js", () => ({
  verifyRecoverableNativeHarnessBackup: vi.fn(async (input: { stamp: unknown; providerLeaseId: string }) =>
    Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)),
}));

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const BOX = "bx_gc4xxpck";
const SESSION = "cc9ea4e2-0000-4000-8000-000000000001";

function boatRefusal(status: number | null, words: string | null, options: { envelope?: boolean; errno?: string } = {}) {
  const message = status === null
    ? `Boat POST /sandboxes/${BOX}/resume failed: network_error`
    : `Boat POST /sandboxes/${BOX}/resume failed (${status}): http_error${words ? ` (${words})` : ""}`;
  const source = Object.assign(new Error("private"), status === null ? { code: options.errno } : { statusCode: status });
  return new JsonRpcCallError({ code: -32000, message,
    ...(options.envelope === false ? {} : { data: environmentResumeErrorData(source) }) });
}

describeEmbeddedPostgres("archived projectless chat: the first run resumes or rotates with history (S4)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("environment-runtime-projectless-archived-resume");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });
  beforeEach(() => { db = createDb(connectionString); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(companies);
    await db.$client.end({ timeout: 1 });
  });
  afterAll(async () => { await stopDb?.(); });

  type Shape = { backupStamp?: boolean; previousRunStatus?: "succeeded" | "running"; laterProviderWork?: boolean };

  async function seed(shape: Shape = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const issueId = randomUUID();
    const previousRunId = randomUUID();
    const runId = randomUUID();
    const providerConfig = { provider: "boat", image: "boat:test", timeoutMs: 300_000, reuseLease: true };
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Smarty", role: "general", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Boat", driver: "sandbox", status: "active", config: providerConfig });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "acme.boat", packageName: "@acme/boat", version: "1.0.0", apiVersion: 1,
      categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: {
        id: "acme.boat", apiVersion: 1, version: "1.0.0", displayName: "Boat", description: "Test provider", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "boat", kind: "sandbox_provider", displayName: "Boat", supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, timeoutMs: { type: "number" }, reuseLease: { type: "boolean" } } } }],
      },
    } as never);
    // A person's chat: an issue with no project, so no execution workspace.
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat with Smarty", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values([
      { id: previousRunId, companyId, agentId, invocationSource: "assignment", status: "running", nativeSessionId: SESSION },
      { id: runId, companyId, agentId, invocationSource: "assignment", status: "running" },
    ]);
    const environment: Environment = { id: environmentId, name: "Boat", description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    // The previous turn created the box through the real acquisition path.
    const priming = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      call: async (_pluginId: string, method: string) => {
        if (method !== "environmentAcquireLease") throw new Error(`Unexpected plugin method: ${method}`);
        return { providerLeaseId: BOX, metadata: { ...providerConfig, sandboxId: BOX, remoteCwd: "/home/boat/paperclip-workspace" } };
      },
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const created = await priming.acquireRunLease({ companyId, environment, issueId, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: previousRunId, persistedExecutionWorkspace: null });
    expect(created.lease.executionWorkspaceId).toBeNull();
    const completedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    // The turn ended with a lease-bound harness backup of the chat's session.
    const lease = (await environmentService(db).updateLeaseMetadata(created.lease.id, {
      ...created.lease.metadata,
      ...(shape.backupStamp === false ? {} : { nativeHarnessBackup: {
        schema: "paperclip.native-harness-backup-stamp.v2", normalizedSessionId: SESSION, runnerInstanceId: "runner-1",
        sessionScopeSha256: "a".repeat(64), sourceProviderLeaseId: BOX, authorizedProviderLeaseId: BOX,
        manifestSha256: `sha256:${"b".repeat(64)}`, completedAt,
      } }),
    }))!;
    // Idle close: Boat stopped and archived the box; the lease is retained.
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, lease.id));
    await db.update(heartbeatRuns).set({ status: shape.previousRunStatus ?? "succeeded" }).where(eq(heartbeatRuns.id, previousRunId));
    if (shape.laterProviderWork) {
      await db.insert(heartbeatRunEvents).values({ companyId, runId: previousRunId, agentId, seq: 1, eventType: "turn.started",
        createdAt: new Date() } as never);
    }
    return { companyId, agentId, environment, pluginId, issueId, runId, previousRunId, lease };
  }

  function worker(seeded: Awaited<ReturnType<typeof seed>>, resume: (attempt: number, timeoutMs: number) => Promise<unknown>,
    options: { acquireFails?: boolean } = {}) {
    let attempts = 0;
    const call = vi.fn(async (_pluginId: string, method: string, _params: unknown, timeoutMs?: number) => {
      if (method === "environmentResumeLease") return await resume(++attempts, timeoutMs ?? 0);
      if (method === "environmentAcquireLease") {
        if (options.acquireFails) throw new JsonRpcCallError({ code: -32000, message: "create refused" });
        return { providerLeaseId: "bx_new", metadata: { provider: "boat", image: "boat:test", timeoutMs: 300_000, reuseLease: true,
          remoteCwd: "/home/boat/paperclip-workspace" } };
      }
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === seeded.pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    return { call, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  const acquire = (seeded: Awaited<ReturnType<typeof seed>>, runtime: ReturnType<typeof environmentRuntimeService>) =>
    runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId: seeded.issueId,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: seeded.runId, persistedExecutionWorkspace: null });

  // Every refused resume advances the run's clock (never past the call's own
  // RPC timeout), so budgets run without waiting.
  function clock(stepMs: number) {
    let now = Date.now();
    const startedAt = now;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    return { step: (timeoutMs = stepMs) => { now += Math.min(stepMs, timeoutMs); }, elapsed: () => now - startedAt };
  }

  const resumed = (seeded: Awaited<ReturnType<typeof seed>>) =>
    ({ providerLeaseId: BOX, metadata: { remoteCwd: "/home/boat/paperclip-workspace" } });

  const destroyCalls = (call: ReturnType<typeof worker>["call"]) =>
    call.mock.calls.filter(([, method]) => method === "environmentDestroyLease");

  it.each([
    ["409 sandbox_stopping", () => boatRefusal(409, "sandbox_stopping")],
    ["409 sandbox_starting", () => boatRefusal(409, "sandbox_starting")],
    ["409 sandbox_not_ready", () => boatRefusal(409, "sandbox_not_ready")],
    ["409 machine_not_running", () => boatRefusal(409, "machine_not_running")],
    ["409 sandbox_resuming", () => boatRefusal(409, "sandbox_resuming")],
    ["502 sandbox_restoring", () => boatRefusal(502, "sandbox_restoring")],
    ["503 (envelope only)", () => boatRefusal(503, null)],
    ["429 (envelope only)", () => boatRefusal(429, null)],
    ["network ECONNRESET (envelope only)", () => boatRefusal(null, null, { errno: "ECONNRESET" })],
  ])("waits out Boat's %s and resumes the same box in the first run", async (_label, refusal) => {
    const seeded = await seed();
    const { call, runtime } = worker(seeded, async (attempt) => {
      if (attempt <= 2) throw refusal();
      return resumed(seeded);
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe(BOX);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(3);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(destroyCalls(call)).toHaveLength(0);
  });

  it("keeps waiting past 90 s while Boat still reports the archived box resuming, then resumes it (06:21:33Z shape)", async () => {
    const seeded = await seed();
    const time = clock(60_000);
    // Boat finished resuming ~3 min after the first attempt.
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => {
      time.step(timeoutMs);
      if (time.elapsed() < 180_000) throw boatRefusal(409, "sandbox_starting");
      return resumed(seeded);
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe(BOX);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    expect(time.elapsed()).toBeGreaterThan(90_000);
    expect(time.elapsed()).toBeLessThanOrEqual(330_000);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
  });

  it("rotates inside the first run to a new box with the chat's history when Boat is still resuming past the budget", async () => {
    const seeded = await seed();
    const time = clock(60_000);
    const { call, runtime } = worker(seeded, async (_attempt, timeoutMs) => {
      time.step(timeoutMs);
      throw boatRefusal(409, "sandbox_starting");
    });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("bx_new");
    expect(acquired.lease.executionWorkspaceId).toBeNull();
    expect(acquired.lease.issueId).toBe(seeded.issueId);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed", previousProviderLeaseId: BOX });
    // The new box carries the verified backup, so the executor restores the
    // chat's session (history) into it.
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: BOX, normalizedSessionId: SESSION });
    expect(time.elapsed()).toBeLessThanOrEqual(330_000);
    // Stop-and-keep: nothing on the archived box is deleted.
    expect(destroyCalls(call)).toHaveLength(0);
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "retained", providerLeaseId: BOX, cleanupStatus: null });
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toMatchObject({ runId: seeded.runId, replacementLeaseId: acquired.lease.id });
  });

  it.each([
    ["410 snapshot_data_expired", () => boatRefusal(410, "snapshot_data_expired")],
    ["500 resume_failed", () => boatRefusal(500, "resume_failed")],
    ["frozen4 text-only provider_error", () => boatRefusal(409, null, { envelope: false })],
  ])("rotates at once to a new box with history on Boat's terminal %s, keeping the old box", async (_label, refusal) => {
    const seeded = await seed();
    const { call, runtime } = worker(seeded, async () => { throw refusal(); });

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("bx_new");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "resume_failed", previousProviderLeaseId: BOX });
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: BOX });
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(1);
    expect(destroyCalls(call)).toHaveLength(0);
    await expect(environmentService(db).getLeaseById(seeded.lease.id)).resolves.toMatchObject({ status: "retained", providerLeaseId: BOX });
  });

  it("continues on a new box with history when Boat no longer has the box (404 -> expired)", async () => {
    const seeded = await seed();
    const { runtime } = worker(seeded, async () => ({ providerLeaseId: null, metadata: { expired: true } }));
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe("bx_new");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toMatchObject({ outcome: "replacement" });
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: BOX });
  });

  it.each([
    ["no verified harness backup", { backupStamp: false }, () => boatRefusal(410, "snapshot_data_expired")],
    ["provider work after the backup", { laterProviderWork: true }, () => boatRefusal(410, "snapshot_data_expired")],
    ["a live owner", { previousRunStatus: "running" }, () => boatRefusal(410, "snapshot_data_expired")],
    ["a provider access refusal", {}, () => boatRefusal(403, "forbidden")],
  ] as Array<[string, Shape, () => JsonRpcCallError]>)("keeps the box and fails strictly with %s", async (_label, shape, refusal) => {
    const seeded = await seed(shape);
    const { call, runtime } = worker(seeded, async () => { throw refusal(); });
    await expect(acquire(seeded, runtime)).rejects.toThrow(/the lease was preserved and no replacement was created\.$/);
    expect(call).not.toHaveBeenCalledWith(seeded.pluginId, "environmentAcquireLease", expect.anything(), expect.anything());
    expect(destroyCalls(call)).toHaveLength(0);
    const lease = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(lease).toMatchObject({ status: "retained", providerLeaseId: BOX });
    expect(lease?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  it("leaves the archived box eligible for the next attempt when the new box cannot be created", async () => {
    const seeded = await seed();
    const { call, runtime } = worker(seeded, async () => { throw boatRefusal(410, "snapshot_data_expired"); }, { acquireFails: true });
    await expect(acquire(seeded, runtime)).rejects.toThrow();
    expect(destroyCalls(call)).toHaveLength(0);
    const lease = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(lease).toMatchObject({ status: "retained", providerLeaseId: BOX });
    expect(lease?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });
});
