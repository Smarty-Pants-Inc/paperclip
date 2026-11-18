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
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, nativeHarnessBackups, plugins } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

import * as backupStorage from "../services/native-runtime/native-harness-backup-storage.js";
import * as config from "../config.js";
import * as storage from "../storage/index.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { findReusableSandboxResumeError, REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_INSTRUCTION,
  ReusableSandboxBackupUnrestorableError } from "../services/reusable-sandbox-resume-error.js";
import { ReusableSandboxKeptFencedError } from "../services/reusable-sandbox-kept-marker.js";
import { stopWarmSandboxesPastWindow } from "../services/warm-sandbox-expiry.js";
import { releasableRetainedOrphanCondition } from "../services/environment-retained-orphan-settlement.js";

// The original resume-policy cases stub this boundary in beforeEach. The
// never-OK cases below restore the real verifier and exercise durable storage.

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
  const ownedStores: string[] = [];

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("environment-runtime-projectless-archived-resume");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });
  beforeEach(() => {
    db = createDb(connectionString);
    vi.spyOn(backupStorage, "verifyRecoverableNativeHarnessBackup").mockImplementation(async input =>
      Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const root of ownedStores.splice(0)) await rm(root, { recursive: true, force: true });
    await db.delete(nativeHarnessBackups);
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
    options: { acquireFails?: boolean; destroySucceeds?: boolean } = {}) {
    let attempts = 0;
    const call = vi.fn(async (_pluginId: string, method: string, _params: unknown, timeoutMs?: number) => {
      if (method === "environmentResumeLease") return await resume(++attempts, timeoutMs ?? 0);
      if (method === "environmentDestroyLease" && options.destroySucceeds) return {};
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

  // Data-safety/trust-boundary regression: a syntactically lease-bound stamp
  // alone must never authorize rotation away from the only copy of history.
  // B fix (i): each real verifier failure is typed and reaches the person as
  // ONE true instruction, never the generic "did not start in time".
  it.each([
    ["CORRUPT", "backup_missing"],
    ["PARTIAL", "backup_missing"],
    ["OBJECT_CORRUPT", "hash_mismatch"],
    ["OBJECT_MISSING", "object_missing"],
    ["ROW_MISSING", "backup_missing"],
  ] as const)("never rotates the archived box with a %s durable harness backup (real verifier)", async (failure, reason) => {
    vi.mocked(backupStorage.verifyRecoverableNativeHarnessBackup).mockRestore();
    expect(vi.isMockFunction(backupStorage.verifyRecoverableNativeHarnessBackup)).toBe(false);
    const seeded = await seed();
    const root = await mkdtemp(join(tmpdir(), "s4-real-backup-"));
    ownedStores.push(root);
    const store = createStorageService(createLocalDiskStorageProvider(root));
    vi.spyOn(config, "loadConfig").mockReturnValue({ ...config.loadConfig(), storageProvider: "s3" });
    vi.spyOn(storage, "getStorageService").mockReturnValue(store);
    // The cloud path requires durable custody, not an incidental local copy.
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", "true");
    const stamp = seeded.lease.metadata!.nativeHarnessBackup as {
      sessionScopeSha256: string; manifestSha256: string;
    };
    const backupId = randomUUID();
    const objectKey = `${seeded.companyId}/native-harness-backups/${stamp.sessionScopeSha256}/${backupId}.pchn`;
    const body = Buffer.from("saved provider-session history");
    await store.putFile({ companyId: seeded.companyId, namespace: "native-harness-backups", objectKey,
      originalFilename: null, contentType: "application/octet-stream", body });
    await db.insert(nativeHarnessBackups).values({ id: backupId, companyId: seeded.companyId,
      scopeDigest: stamp.sessionScopeSha256, issueId: seeded.issueId, runId: seeded.previousRunId,
      manifestSha256: stamp.manifestSha256, status: "current", reference: {
        schema: "paperclip.native-harness-object.v1", id: backupId, companyId: seeded.companyId,
        scopeDigest: stamp.sessionScopeSha256, manifestSha256: stamp.manifestSha256, objectKey,
        sha256: createHash("sha256").update(body).digest("hex"), byteSize: body.length, material: {},
      } });
    // Prove the real store/row is accepted before injecting the fault. This is
    // a verifier test, not an archive restore test (the payload is opaque here).
    await expect(backupStorage.verifyRecoverableNativeHarnessBackup({ db, companyId: seeded.companyId,
      stamp, providerLeaseId: BOX })).resolves.toBe(true);
    if (failure === "CORRUPT") {
      await environmentService(db).updateLeaseMetadata(seeded.lease.id, { ...seeded.lease.metadata,
        nativeHarnessBackup: { ...stamp, manifestSha256: `sha256:${"c".repeat(64)}` } });
    } else if (failure === "OBJECT_CORRUPT") {
      await store.putFile({ companyId: seeded.companyId, namespace: "native-harness-backups", objectKey,
        originalFilename: null, contentType: "application/octet-stream", body: Buffer.from("saved provider-session histor!") });
    } else if (failure === "OBJECT_MISSING") {
      await store.deleteObject(seeded.companyId, objectKey);
    } else if (failure === "ROW_MISSING") {
      await db.delete(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, backupId));
    } else {
      // A valid stamp survived, but its durable publication/copy did not.
      await db.delete(nativeHarnessBackups).where(eq(nativeHarnessBackups.id, backupId));
      await store.deleteObject(seeded.companyId, objectKey);
    }
    const { call, runtime } = worker(seeded, async () => { throw boatRefusal(410, "snapshot_data_expired"); });

    // One strict, typed refusal with one true instruction: not a promise of
    // automatic recovery, not "did not start in time", no history discarded.
    const refusal = await acquire(seeded, runtime).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ReusableSandboxBackupUnrestorableError);
    expect(refusal).toMatchObject({ code: "reusable_sandbox_backup_unrestorable", reason, providerLeaseId: BOX });
    expect((refusal as Error).message.endsWith(REUSABLE_SANDBOX_BACKUP_UNRESTORABLE_INSTRUCTION)).toBe(true);
    expect(findReusableSandboxResumeError(refusal)).toBeNull();
    expect(call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(1);
    expect(call.mock.calls.filter(([, method]) => method === "environmentAcquireLease")).toHaveLength(0);
    expect(destroyCalls(call)).toHaveLength(0);
    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, seeded.companyId));
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ id: seeded.lease.id, status: "retained", providerLeaseId: BOX, cleanupStatus: null });
    expect(leases[0].metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  // B fix (ii): Boat resumed a box at that id whose workspace sentinel does not
  // match. The box exists, so it is never destroyed: kept and fenced, and the
  // chat continues on a new box with its verified history.
  it("never destroys a box whose identity does not match; keeps it and continues on a new box with history", async () => {
    const seeded = await seed();
    const { call, runtime } = worker(seeded, async () => ({ providerLeaseId: null,
      metadata: { workspaceSentinel: { result: "mismatched" } } }));

    const acquired = await acquire(seeded, runtime);

    expect(acquired.lease.providerLeaseId).toBe("bx_new");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "replacement", reason: "identity_mismatch" });
    expect(acquired.lease.metadata?.nativeHarnessBackup).toMatchObject({ authorizedProviderLeaseId: BOX });
    expect(destroyCalls(call)).toHaveLength(0);
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "retained", providerLeaseId: BOX, cleanupStatus: null, failureReason: null });
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toMatchObject({ runId: seeded.runId, replacementLeaseId: acquired.lease.id,
      reason: "identity_mismatch" });
  });

  // step 2e (1): the mismatch block is recorded ON THE LEASE with its reason and
  // nothing automatic clears it: not a sweep tick, not a Retry (the Retry's run
  // acquires through this same path). Only a person's consented environment
  // delete (DELETE /api/environments/:id?destroyReusableSandboxLeases=true,
  // routes/environments.ts) destroys the box and removes the block.
  it("keeps the mismatch block across a sweep tick and a Retry; only the operator's consented environment delete clears it", async () => {
    const seeded = await seed();
    const first = worker(seeded, async () => ({ providerLeaseId: null, metadata: { workspaceSentinel: { result: "mismatched" } } }));
    const rotated = await acquire(seeded, first.runtime);
    expect(rotated.lease.providerLeaseId).toBe("bx_new");
    const blocked = (await environmentService(db).getLeaseById(seeded.lease.id))!;
    const block = blocked.metadata?.reusableSandboxKeptAfterReplacement;
    expect(block).toMatchObject({ reason: "identity_mismatch", runId: seeded.runId, replacementLeaseId: rotated.lease.id });

    // The run ends and a sweep tick a year later finds nothing to stop or release.
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, rotated.lease.id));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
    const later = new Date(Date.now() + 365 * 24 * 60 * 60_000);
    await stopWarmSandboxesPastWindow(db, later);
    const releasable = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(releasableRetainedOrphanCondition(later));
    expect(releasable.map(row => row.id)).not.toContain(seeded.lease.id);
    await first.runtime.flushDeferredOrphanCleanups();
    expect(await environmentService(db).getLeaseById(seeded.lease.id)).toMatchObject({ status: "retained", cleanupStatus: null,
      metadata: expect.objectContaining({ reusableSandboxKeptAfterReplacement: block }) });

    // Retry: the person's Retry starts a run whose acquisition takes this path.
    const retryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "on_demand", status: "running", retryOfRunId: seeded.runId });
    const retry = worker(seeded, async () => ({ providerLeaseId: "bx_new", metadata: { remoteCwd: "/home/boat/paperclip-workspace" } }));
    const retried = await retry.runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment,
      issueId: seeded.issueId, agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: retryRunId,
      persistedExecutionWorkspace: null });
    expect(retried.lease.providerLeaseId).toBe("bx_new");
    expect(retry.call.mock.calls.filter(([, , params]) => JSON.stringify(params ?? null).includes(`"providerLeaseId":"${BOX}"`))).toEqual([]);
    expect(await environmentService(db).getLeaseById(seeded.lease.id)).toMatchObject({ status: "retained", cleanupStatus: null,
      metadata: expect.objectContaining({ reusableSandboxKeptAfterReplacement: block }) });

    // The operator action: the consented environment delete's teardown.
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, retried.lease.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, retryRunId));
    const operator = worker(seeded, async () => { throw new Error("no resume"); }, { destroySucceeds: true });
    const torn = await operator.runtime.destroyReusableSandboxLeasesForEnvironment({ environmentId: seeded.environment.id,
      failureReason: "environment_deleted", consentedBy: "operator-user" });
    expect(torn.skippedLiveRun).toBe(0);
    expect(destroyCalls(operator.call).map(([, , params]) => (params as { providerLeaseId?: string }).providerLeaseId)).toContain(BOX);
    const cleared = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(cleared?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
    expect(cleared?.status).not.toBe("retained");
  });

  // step 2e (2): the write fence. A Runner may survive on the kept box (Boat:
  // a resume within ~10 minutes may return the same machine "with memory and
  // programs"). Paperclip refuses every channel to it by lease identity, even
  // through a stale lease object an older controller still holds, and records
  // each refusal on the kept lease. The provider is never called for it.
  it("refuses and records every write, callback and checkpoint channel from the kept box after the switch", async () => {
    const seeded = await seed();
    const first = worker(seeded, async () => { throw boatRefusal(410, "snapshot_data_expired"); });
    const rotated = await acquire(seeded, first.runtime);
    expect(rotated.lease.providerLeaseId).toBe("bx_new");
    const switchedAt = first.call.mock.calls.length;
    const staleKeptLease = seeded.lease; // read before the switch: carries no block
    expect(staleKeptLease.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
    const { environment } = seeded;
    const channels: Array<[string, () => Promise<unknown>]> = [
      ["runner_ingress", () => first.runtime.getRunnerIngressEndpoint({ environment, lease: staleKeptLease, port: 7777, path: "/api/runner/v1/connect/x" })],
      ["duplex_channel", () => first.runtime.openDuplexChannel({ environment, lease: staleKeptLease, command: ["paperclip-callback-bridge"] })],
      ["execute", () => first.runtime.execute({ environment, lease: staleKeptLease, command: "true" })],
      ["sync_out", () => first.runtime.syncOut({ environment, lease: staleKeptLease, operations: [] })],
      ["resume", () => first.runtime.resumeRunLease({ environment, lease: staleKeptLease })],
    ];
    const refusals: unknown[] = [];
    for (const [, open] of channels) refusals.push(await open().then(() => null, (error: unknown) => error));
    // Nothing reached the provider for the kept box after the switch.
    expect(first.call.mock.calls.slice(switchedAt).map(([, method]) => method)).toEqual([]);
    channels.forEach(([channel], index) => {
      expect(refusals[index]).toMatchObject({ code: "reusable_sandbox_kept_fenced", providerLeaseId: BOX, channel });
      expect(refusals[index]).toBeInstanceOf(ReusableSandboxKeptFencedError);
    });
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "retained", providerLeaseId: BOX, cleanupStatus: null });
    expect(kept?.metadata?.reusableSandboxKeptAfterReplacement).toMatchObject({ reason: "resume_failed",
      replacementLeaseId: rotated.lease.id, fenceRefusals: channels.length, lastFenceRefusal: { channel: "resume" } });

    // The new box is not fenced: its channel goes on to the provider checks.
    const own = await first.runtime.getRunnerIngressEndpoint({ environment, lease: rotated.lease, port: 7777,
      path: "/api/runner/v1/connect/x" }).then(() => null, (error: unknown) => error);
    expect(own).not.toBeInstanceOf(ReusableSandboxKeptFencedError);
    const after = await environmentService(db).getLeaseById(rotated.lease.id);
    expect(after?.metadata?.reusableSandboxKeptAfterReplacement).toBeUndefined();
  });

  // B fix (iv): the kept old box has a selection fence, not a provider write
  // fence. Boat's docs (docs.boat.dev, fetched 2026-11-17) do not prove its
  // runnerd is gone: long-running-tasks/background-commands.md:222 "Detached
  // processes do not continue after a stop, resume or fork", but
  // snapshots.md:15 and snapshots/stop.md:82-83 say a resume within 10 minutes
  // of a stop usually gets the same machine back "with memory and programs".
  // So Paperclip must never select, resume, release, stop or destroy the kept
  // box again after the rotation.
  it("never selects or writes the kept old box after the rotation (negative)", async () => {
    const seeded = await seed();
    const first = worker(seeded, async () => { throw boatRefusal(410, "snapshot_data_expired"); });
    const rotated = await acquire(seeded, first.runtime);
    expect(rotated.lease.providerLeaseId).toBe("bx_new");

    // The rotated run ends; its new box is retained for the next message.
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, rotated.lease.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "assignment", status: "running" });
    const next = worker(seeded, async () => ({ providerLeaseId: "bx_new", metadata: { remoteCwd: "/home/boat/paperclip-workspace" } }));
    const resumed = await next.runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment,
      issueId: seeded.issueId, agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: null });

    expect(resumed.lease.providerLeaseId).toBe("bx_new");
    expect(resumed.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed" });
    // No provider call after the rotation names the kept box.
    const namesKeptBox = (params: unknown) => JSON.stringify(params ?? null).includes(`"providerLeaseId":"${BOX}"`);
    expect(next.call.mock.calls.filter(([, , params]) => namesKeptBox(params))).toEqual([]);
    expect(next.call.mock.calls.filter(([, method]) => method === "environmentAcquireLease")).toHaveLength(0);

    // Even when the new box is gone too, the kept box is not a candidate: the
    // next run gets a new box and still never names the kept one.
    await db.update(environmentLeases).set({ status: "expired" }).where(eq(environmentLeases.providerLeaseId, "bx_new"));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, nextRunId));
    const thirdRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: thirdRunId, companyId: seeded.companyId, agentId: seeded.agentId,
      invocationSource: "assignment", status: "running" });
    const third = worker(seeded, async () => ({ providerLeaseId: BOX, metadata: { remoteCwd: "/home/boat/paperclip-workspace" } }));
    const fresh = await third.runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment,
      issueId: seeded.issueId, agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: thirdRunId,
      persistedExecutionWorkspace: null });
    expect(fresh.lease.providerLeaseId).toBe("bx_new");
    expect(third.call.mock.calls.filter(([, , params]) => namesKeptBox(params))).toEqual([]);
    expect(third.call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(0);
    const kept = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(kept).toMatchObject({ status: "retained", providerLeaseId: BOX, cleanupStatus: null, heartbeatRunId: seeded.previousRunId });
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
