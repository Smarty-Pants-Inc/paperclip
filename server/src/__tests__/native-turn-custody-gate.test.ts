import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns,
  issues, nativeHarnessBackups, plugins, projects, workspaceOperations,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import { buildNativeHarnessBackupManifest } from "../services/native-runtime/native-session-executor.ts";
import { createNativeHarnessBackupStamp } from "../services/native-runtime/native-harness-backup-stamp.ts";
import { publishNativeHarnessBackup } from "../services/native-runtime/native-harness-backup-publication.ts";
import { escalateExpiredNativeTurnCustodyKeeps, NATIVE_TURN_CUSTODY_KEPT_KEY } from "../services/native-turn-custody.ts";

/*
 * Custody gate (BRIEF backup-gate): a sandbox box that held a native turn is
 * destroyed (or released-to-delete) ONLY IF the server holds that turn's
 * backup (stamp matches the backup) and its workspace copy-out succeeded.
 * Otherwise it is KEPT via stop-and-retain. Rows go through the real destroy
 * paths of environmentRuntimeService. Real producers: the lease comes from
 * acquireRunLease; the backup copy from buildNativeHarnessBackupManifest +
 * publishNativeHarnessBackup + createNativeHarnessBackupStamp (exec:20079-20129).
 * PLANTED (named): the stamp write onto lease metadata (the executor's
 * closure recordHarnessBackupStampForCurrentLease is not exported), the
 * workspace_operations finalize rows, the nativeWorkspaceSync reference and,
 * in S3 mode, native_harness_backups rows.
 */

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const support = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const ERASING = ["environmentReleaseLease", "environmentDestroyLease"];

describeEmbeddedPostgres("native turn custody gate", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let connectionString = "";
  let db!: ReturnType<typeof createDb>;
  let stateBase = "";
  const previousStateDir = process.env.PAPERCLIP_RUNNER_STATE_DIR;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("native-turn-custody-gate");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });
  beforeEach(async () => {
    db = createDb(connectionString);
    stateBase = await mkdtemp(path.join(os.tmpdir(), "native-turn-custody-"));
    process.env.PAPERCLIP_RUNNER_STATE_DIR = stateBase;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (previousStateDir === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
    else process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDir;
    await rm(stateBase, { recursive: true, force: true });
    await db.delete(workspaceOperations);
    await db.delete(nativeHarnessBackups);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(plugins);
    await db.delete(companies);
    await db.$client.end({ timeout: 1 });
  });
  afterAll(async () => { await stopDb?.(); });

  function fakeWorker() {
    const call = vi.fn(async (_pluginId: string, method: string, params: any) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: `box-${randomUUID()}`, metadata: { provider: "fake-plugin", remoteCwd: "/workspace" } };
      if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      if (method === "environmentReleaseLease" || method === "environmentDestroyLease") return { providerLeaseId: params.providerLeaseId, state: "destroyed" };
      throw new Error(`Unexpected provider method: ${method}`);
    });
    const manager = {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    const methods = () => call.mock.calls.map(entry => entry[1]);
    return { manager, call, methods, erased: () => methods().filter(method => ERASING.includes(method)) };
  }

  async function seedBox(input: {
    runStatus?: string; runtimeMode?: "native" | "legacy"; launched?: boolean; reuse?: boolean;
    runnerProfileJson?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), environmentId = randomUUID(), runId = randomUUID();
    const pluginId = randomUUID(), projectId = randomUUID(), executionWorkspaceId = randomUUID(), issueId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Custody", status: "active", createdAt: now, updatedAt: now });
    await db.insert(agents).values({ id: agentId, companyId, name: "Pi", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {}, createdAt: now, updatedAt: now });
    const config = { provider: "fake-plugin", image: "fake:test", timeoutMs: 1234, reuseLease: input.reuse === true };
    await db.insert(environments).values({ id: environmentId, name: `custody-${environmentId.slice(0, 8)}`, driver: "sandbox",
      status: "active", config, createdAt: now, updatedAt: now });
    await db.insert(plugins).values({ id: pluginId, pluginKey: "acme.custody-sandbox", packageName: "@acme/custody-sandbox",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], manifestJson: {
        id: "acme.custody-sandbox", apiVersion: 1, version: "1.0.0", displayName: "Custody Sandbox", description: "test",
        author: "Paperclip", categories: ["automation"], capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin",
          supportsReusableLeases: true, configSchema: { type: "object" } }],
      }, status: "ready", installOrder: 1, updatedAt: now } as any);
    await db.insert(projects).values({ id: projectId, companyId, name: "Custody", status: "active", createdAt: now, updatedAt: now });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, mode: "shared_workspace",
      strategyType: "project_primary", name: "Custody workspace", status: "active", providerType: "local_fs", createdAt: now, updatedAt: now });
    await db.insert(issues).values({ id: issueId, companyId, title: "Custody", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running",
      createdAt: now, updatedAt: now });
    const worker = fakeWorker();
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker.manager });
    const environment = (await environmentService(db).getById(environmentId)) as Environment;
    const acquired = await runtime.acquireRunLease({ companyId, environment, issueId, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: runId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "shared_workspace" } });
    await db.update(heartbeatRuns).set({
      status: input.runStatus ?? "succeeded", finishedAt: new Date(), runtimeMode: input.runtimeMode ?? "native",
      processPid: input.launched === false ? null : 4242,
      ...(input.runnerProfileJson ? { runnerProfileJson: input.runnerProfileJson } : {}),
    }).where(eq(heartbeatRuns.id, runId));
    worker.call.mockClear();
    return { companyId, agentId, environmentId, runId, issueId, executionWorkspaceId, environment, lease: acquired.lease, worker, runtime };
  }

  /** Real producers of the local backup copy and its stamp (exec:20079-20129). */
  async function produceBackup(box: { companyId: string; runId: string; issueId: string; agentId: string; executionWorkspaceId: string; lease: { id: string } },
    options: { stampManifestOf?: string } = {}) {
    const lease = (await environmentService(db).getLeaseById(box.lease.id))!;
    const sessionScopeId = `custody-scope-${randomUUID()}`;
    const scopeDigest = createHash("sha256").update(sessionScopeId).digest("hex");
    const backupRoot = path.join(stateBase, scopeDigest, "failover-backups");
    const pendingRoot = path.join(backupRoot, `.pending-${randomUUID()}`);
    await mkdir(path.join(pendingRoot, "pi-agent", "sessions"), { recursive: true });
    await mkdir(path.join(pendingRoot, "runner"), { recursive: true });
    await mkdir(path.join(pendingRoot, "pi"), { recursive: true });
    await writeFile(path.join(pendingRoot, "pi-agent", "sessions", "paul.jsonl"), `{"turn":"${box.runId}"}\n`);
    await writeFile(path.join(pendingRoot, "pi", "conversation.jsonl"), `{"turn":"${box.runId}"}\n`);
    await writeFile(path.join(pendingRoot, "runner", "runner-state.json"), JSON.stringify({ runId: box.runId }));
    const normalizedSessionId = randomUUID(), runnerInstanceId = randomUUID();
    const execution = {
      provider: { kind: "pi_rpc", model: null },
      binding: { companyId: box.companyId, runId: box.runId, issueId: box.issueId, agentId: box.agentId, executionWorkspaceId: box.executionWorkspaceId },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    } as never;
    const manifest = buildNativeHarnessBackupManifest({ backupRoot: pendingRoot, execution, runnerInstanceId,
      providerSessionIdentity: { providerSessionId: "pi-session-1", providerBackendSessionId: null, providerSessionIdentity: null },
      sourceProviderLeaseId: lease.providerLeaseId! });
    await writeFile(path.join(pendingRoot, "manifest.json"), JSON.stringify(manifest));
    let stamp: ReturnType<typeof createNativeHarnessBackupStamp> | null = null;
    await publishNativeHarnessBackup({ db, companyId: box.companyId, scopeDigest, backupRoot, pendingRoot,
      stamp: async currentRoot => {
        stamp = createNativeHarnessBackupStamp({ manifestPath: path.join(currentRoot, "manifest.json"), sessionScopeId,
          authorizedProviderLeaseId: lease.providerLeaseId!, normalizedSessionId, runnerInstanceId, completedAt: manifest.completedAt });
      } });
    const written = { ...stamp!, ...(options.stampManifestOf ? { manifestSha256: options.stampManifestOf } : {}) };
    // PLANTED: the executor writes this exact key (exec:19518-19540).
    await environmentService(db).updateLeaseMetadata(lease.id, { ...(lease.metadata ?? {}), nativeHarnessBackup: written });
    return { stamp: stamp!, scopeDigest };
  }

  async function workspace(box: { companyId: string; runId: string; issueId: string; executionWorkspaceId: string; lease: { id: string; providerLeaseId: string | null } },
    status: "succeeded" | "failed" | null) {
    // PLANTED: the run's sync reference names this box; the finalizer's row.
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, box.runId));
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...(run!.runnerProfileJson ?? {}),
      nativeWorkspaceSync: { leaseId: box.lease.id, providerLeaseId: box.lease.providerLeaseId, workspaceId: box.executionWorkspaceId, state: status === "succeeded" ? "finalized" : "custody-test" } } })
      .where(eq(heartbeatRuns.id, box.runId));
    if (status) await db.insert(workspaceOperations).values({ companyId: box.companyId, heartbeatRunId: box.runId, issueId: box.issueId,
      executionWorkspaceId: box.executionWorkspaceId, phase: "workspace_finalize", status, metadata: { owningService: "native_workspace_finalizer" } } as any);
  }

  const leaseOf = async (id: string) => (await environmentService(db).getLeaseById(id))!;
  const keptViaStopAndRetain = (lease: { metadata: Record<string, unknown> | null }) =>
    lease.metadata?.sandboxStopAndRetainReceipt !== undefined || lease.metadata?.sandboxStopAndRetain !== undefined;

  it("R1: a real turn's box with backup + matching stamp + finalize succeeded is destroyed at turn end", async () => {
    const box = await seedBox();
    await produceBackup(box);
    await workspace(box, "succeeded");
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual(["environmentReleaseLease"]);
    expect((await leaseOf(box.lease.id)).metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY]).toBeUndefined();
  });

  it("R1b: a no-workspace native run needs only the backup clause", async () => {
    const box = await seedBox();
    await produceBackup(box);
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual(["environmentReleaseLease"]);
  });

  it("R2: no backup -> the per-turn (non-reusable) box is KEPT via stop-and-retain, never erased", async () => {
    const box = await seedBox();
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual([]);
    expect(box.worker.methods()).toContain("environmentStopLease");
    const lease = await leaseOf(box.lease.id);
    expect(keptViaStopAndRetain(lease)).toBe(true);
    expect(lease.metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY]).toMatchObject({ schema: "paperclip.native-turn-custody-kept.v1",
      reason: "native_backup_stamp_missing", owner: { companyId: box.companyId, runId: box.runId } });
  });

  it("R2 (site claimLeaseForDestroyUnlessHeld): a direct driver release of a native box without backup is refused", async () => {
    const box = await seedBox();
    const driver = box.runtime.getDriver("sandbox")!;
    await driver.releaseRunLease({ environment: box.environment, lease: await leaseOf(box.lease.id), status: "released" });
    expect(box.worker.erased()).toEqual([]);
  });

  it("R3: a FAILED run without its backup is KEPT until the backup lands, then destroy is allowed", async () => {
    const box = await seedBox({ runStatus: "failed" });
    await box.runtime.releaseRunLeases(box.runId, "failed");
    expect(box.worker.erased()).toEqual([]);
    expect(keptViaStopAndRetain(await leaseOf(box.lease.id))).toBe(true);
    await produceBackup(box);
    const driver = box.runtime.getDriver("sandbox")!;
    await driver.destroyRunLease!({ environment: box.environment, lease: await leaseOf(box.lease.id), failureReason: "custody_test" });
    expect(box.worker.erased()).toEqual(["environmentDestroyLease"]);
  });

  it("R3b: a CANCELLED run whose warm checkpoint failed is gated the same way (run-control :484 reversed)", async () => {
    const box = await seedBox({ runStatus: "cancelled" });
    await box.runtime.releaseRunLeases(box.runId, "failed", undefined, "destroy");
    expect(box.worker.erased()).toEqual([]);
    expect((await leaseOf(box.lease.id)).metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY]).toBeTruthy();
  });

  it("R4: a stamp whose manifest sha does not match the held backup -> KEPT", async () => {
    const box = await seedBox();
    await produceBackup(box, { stampManifestOf: `sha256:${"ab".repeat(32)}` });
    await workspace(box, "succeeded");
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual([]);
    expect((await leaseOf(box.lease.id)).metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY]).toMatchObject({ reason: "native_backup_local_copy_unverified" });
  });

  it("R4 (S3): no row / row sha mismatch -> KEPT; matching current row -> destroyed", async () => {
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    const box = await seedBox();
    const { stamp, scopeDigest } = await produceBackup(box);
    const driver = box.runtime.getDriver("sandbox")!;
    await driver.releaseRunLease({ environment: box.environment, lease: await leaseOf(box.lease.id), status: "released" });
    expect(box.worker.erased()).toEqual([]);
    // PLANTED rows beside the real local backup above.
    const row = { companyId: box.companyId, issueId: box.issueId, runId: box.runId, scopeDigest, reference: { planted: true } };
    await db.insert(nativeHarnessBackups).values({ ...row, manifestSha256: `sha256:${"cd".repeat(32)}`, status: "current" });
    await driver.releaseRunLease({ environment: box.environment, lease: await leaseOf(box.lease.id), status: "released" });
    expect(box.worker.erased()).toEqual([]);
    await db.insert(nativeHarnessBackups).values({ ...row, manifestSha256: stamp.manifestSha256, status: "superseded" });
    await driver.releaseRunLease({ environment: box.environment, lease: await leaseOf(box.lease.id), status: "released" });
    expect(box.worker.erased()).toEqual(["environmentReleaseLease"]);
  });

  it("R5: a failed copy-out -> KEPT even with a verified backup", async () => {
    const box = await seedBox();
    await produceBackup(box);
    await workspace(box, "failed");
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual([]);
    expect((await leaseOf(box.lease.id)).metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY]).toMatchObject({ reason: "workspace_copy_out_not_succeeded" });
  });

  it("R6a (exemption control): a probe/setup-test lease (no run, no stamp) is destroyed", async () => {
    const box = await seedBox();
    const probe = await environmentService(db).acquireLease({ companyId: box.companyId, environmentId: box.environmentId,
      heartbeatRunId: null, leasePolicy: "ephemeral", provider: "fake-plugin", providerLeaseId: `probe-${randomUUID()}`,
      metadata: (await leaseOf(box.lease.id)).metadata ?? {} } as any);
    await box.runtime.getDriver("sandbox")!.releaseRunLease({ environment: box.environment, lease: probe, status: "released" });
    expect(box.worker.erased()).toEqual(["environmentReleaseLease"]);
  });

  it("R6b (exemption control): a native run whose runner never launched is destroyed", async () => {
    const box = await seedBox({ runStatus: "failed", launched: false });
    await box.runtime.releaseRunLeases(box.runId, "failed");
    expect(box.worker.erased()).toEqual(["environmentReleaseLease"]);
  });

  it("R6c (exemption control): a non-native, non-conversation adapter run is destroyed", async () => {
    const box = await seedBox({ runtimeMode: "legacy", runnerProfileJson: { adapterDispatch: { adapterType: "process" } } });
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual(["environmentReleaseLease"]);
  });

  it("R6d (not exempt): a non-native conversation adapter keeps its CLI session in the box -> KEPT", async () => {
    const box = await seedBox({ runtimeMode: "legacy", runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } });
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual([]);
  });

  it("R6e (not exempt): a preconfigured Codex home is not backed up (exec:8584) -> KEPT", async () => {
    const box = await seedBox({ runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" }, homeMode: "preconfigured" } } });
    await produceBackup(box);
    await box.runtime.releaseRunLeases(box.runId, "released");
    expect(box.worker.erased()).toEqual([]);
  });

  it("R7: a kept box's expiry escalates once (typed record), never destroys", async () => {
    const box = await seedBox();
    await box.runtime.releaseRunLeases(box.runId, "released");
    const before = await leaseOf(box.lease.id);
    expect(await escalateExpiredNativeTurnCustodyKeeps(db, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))).toBe(1);
    expect(await escalateExpiredNativeTurnCustodyKeeps(db, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))).toBe(0);
    const after = await leaseOf(box.lease.id);
    expect(after.status).toBe(before.status);
    expect((after.metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY] as Record<string, unknown>).escalatedAt).toEqual(expect.any(String));
    expect(box.worker.erased()).toEqual([]);
  });

  it("site destroyClaimedSandboxLease: an environment-delete destroy of a warm native box without backup keeps it (no destroy claimed)", async () => {
    const box = await seedBox({ reuse: true });
    await box.runtime.releaseRunLeases(box.runId, "released", undefined, "keep_running");
    expect((await leaseOf(box.lease.id)).status).toBe("retained");
    await box.runtime.destroyReusableSandboxLeasesForEnvironment({ environmentId: box.environmentId, failureReason: "custody_test" } as any);
    expect(box.worker.erased()).toEqual([]);
    const lease = await leaseOf(box.lease.id);
    expect(lease.metadata?.[NATIVE_TURN_CUSTODY_KEPT_KEY]).toBeTruthy();
    // Kept, not queued for a later destroy: no destroy claim was recorded.
    expect(lease.failureReason).not.toBe("custody_test");
  });

  it("site retryPendingSandboxTeardown: a pending destroy of a native box without backup is refused by the custody gate", async () => {
    const box = await seedBox();
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed" }).where(eq(environmentLeases.id, box.lease.id));
    await expect(box.runtime.retryPendingSandboxTeardown({ environment: null, lease: await leaseOf(box.lease.id) }))
      .rejects.toThrow("native_turn_custody_missing");
    expect(box.worker.erased()).toEqual([]);
  });
});
