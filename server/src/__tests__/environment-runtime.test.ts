import { prepareConversationTurn } from "../services/agent-conversations.js";
import { buildStrandedRecoveryEscalationNotice } from "../services/recovery/stranded-notice.js";
import { JsonRpcCallError, environmentResumeErrorData } from "@paperclipai/plugin-sdk";
import { collectRunFailureDiagnostics } from "../services/run-failure-diagnostics.js";
import { readTransientLeaseAcquisitionFailure } from "../services/environment-provider-unavailable-error.js";
import { PluginWorkerUnavailableError } from "../services/plugin-worker-unavailable-error.js";
import { createSandboxOrphanCleanupSpool } from "../services/sandbox-orphan-cleanup-spool.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import {
  activityLog,
  agentTaskSessions,
  agentRuntimeState,
  agentWakeupRequests,
  heartbeatRunEvents,
  issueComments,
  workspaceOperations,
  costEvents,
  agents,
  builtInManagedResources,
  companies,
  completionContracts,
  nativeRunResults,
  statusDecisions,
  statusDecisionEffects,
  workAssessments,
  companySecretVersions,
  companySecrets,
  createDb,
  environmentLeases,
  sandboxCreationOperations,
  environments,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resolveEnvironmentDriverConfigForRuntime } from "../services/environment-config.ts";
import {
  SANDBOX_CAPABILITY_KEYS,
  classifyEnvironmentCapabilities,
  environmentRuntimeService,
  findReusableSandboxLeaseId,
} from "../services/environment-runtime.ts";
import * as sandboxProviderRuntime from "../services/sandbox-provider-runtime.ts";
import * as environmentsModule from "../services/environments.ts";
import { logger } from "../middleware/logger.ts";
import { agentEnvironmentTestService } from "../services/agent-environment-test.js";
import { resolveRunnerEnvironmentForRun } from "../services/runner-environment-lifecycle.js";
import { environmentService } from "../services/environments.ts";
import { resumePluginEnvironmentLease } from "../services/plugin-environment-driver.js";
import { remoteExecutionHasStopped } from "../services/remote-execution-termination.ts";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.js";
import { failedPreparationOwnsBoundedRetry } from "../services/failed-preparation-retry.js";
import { hasStopOnlyCleanup } from "../services/sandbox-stop-and-retain.js";
import { closeIdleWarmNativeSessionsForRestart } from "../services/native-runtime/native-session-executor.js";
import type { NativeRunIdentity, NativeSession, PrpEvent } from "@paperclipai/paperclip-runner";
import { secretService } from "../services/secrets.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import type { Environment, EnvironmentDriver, EnvironmentLease, EnvironmentStatus } from "@paperclipai/shared";
import {
  getActiveStepContext,
  runWithRuntimeParent,
  type StartupSpanContext,
} from "@paperclipai/adapter-utils/acpx-engine/startup-timing";
import { traceparentFromContextToken } from "../instrumentation.ts";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { buildNativeHarnessBackupManifest, createRunnerdBackend, nativeSessionWorkspaceScope, providerSessionIdentityFromDurableProviderState, scopedRunnerdStateRoot } from "../services/native-runtime/native-session-executor.ts";
import * as runnerVendor from "../vendor/paperclip-runner/index.js";
import * as runtimeApi from "../runtime-api.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { canonicalProviderPackJson } from "../services/native-runtime/remote-provider-pack-verification.js";
import { createNativeHarnessBackupStamp } from "../services/native-runtime/native-harness-backup-stamp.ts";
import { environmentRunOrchestrator } from "../services/environment-run-orchestrator.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";
import { NATIVE_PREPARATION_FENCING_VERSION } from "../services/native-runtime/native-active-runs.js";
import { createHeartbeatRunState } from "../services/heartbeat/run-state.js";
import { verifyRecoverableNativeHarnessBackup } from "../services/native-runtime/native-harness-backup-storage.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";

import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();
const managedCloudConfig = { v: 1, mode: "cloud", catalogVersion: "test", features: {}, plugins: { autoInstall: ["daytona"] } };

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment runtime tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}) {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

describe("findReusableSandboxLeaseId", () => {
  it("matches reusable plugin-backed sandbox leases by provider", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake-plugin",
        image: "template-b",
        timeoutMs: 300000,
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-template-a",
          metadata: {
            provider: "fake-plugin",
            image: "template-a",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-template-b",
          metadata: {
            provider: "fake-plugin",
            image: "template-b",
            timeoutMs: 300000,
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-template-b");
  });

  it("ignores host-only log streaming when matching a reusable plugin lease", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake-plugin",
        image: "template-b",
        timeoutMs: 300000,
        reuseLease: true,
        streamRunLogs: true,
        runnerLifecycleMode: "warm",
        target: null,
      },
      leases: [
        {
          providerLeaseId: "sandbox-template-b",
          metadata: {
            provider: "fake-plugin",
            image: "template-b",
            timeoutMs: 300000,
            reuseLease: true,
            runnerLifecycleMode: "warm",
            target: "us",
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-template-b");
  });

  it("requires image identity for reusable fake sandbox leases", () => {
    const selected = findReusableSandboxLeaseId({
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
      leases: [
        {
          providerLeaseId: "sandbox-image-a",
          metadata: {
            provider: "fake",
            image: "debian:12",
            reuseLease: true,
          },
        },
        {
          providerLeaseId: "sandbox-image-b",
          metadata: {
            provider: "fake",
            image: "ubuntu:24.04",
            reuseLease: true,
          },
        },
      ],
    });

    expect(selected).toBe("sandbox-image-b");
  });
});

describeEmbeddedPostgres("environmentRuntimeService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;
  let runtime!: ReturnType<typeof environmentRuntimeService>;
  const fixtureRoots: string[] = [];
  // Give each test its own orphan-cleanup spool directory, so a spool file one
  // test writes never leaks into another test's flush. The default runtime reads
  // this env override when a test does not pass an explicit spool directory.
  let orphanCleanupSpoolDir: string | null = null;
  const previousOrphanCleanupSpoolDir = process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("environment-runtime");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });

  beforeEach(async () => {
    orphanCleanupSpoolDir = await mkdtemp(path.join(os.tmpdir(), "orphan-cleanup-spool-"));
    process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR = orphanCleanupSpoolDir;
    db = createDb(connectionString);
    runtime = environmentRuntimeService(db);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (orphanCleanupSpoolDir) {
      await rm(orphanCleanupSpoolDir, { recursive: true, force: true }).catch(() => undefined);
      orphanCleanupSpoolDir = null;
    }
    if (previousOrphanCleanupSpoolDir === undefined) {
      delete process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR;
    } else {
      process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR = previousOrphanCleanupSpoolDir;
    }
    while (fixtureRoots.length > 0) {
      const root = fixtureRoots.pop();
      if (!root) continue;
      await stopSshEnvLabFixture(path.join(root, "state.json")).catch(() => undefined);
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(workspaceOperations);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(agentTaskSessions);
    await db.delete(heartbeatRunEvents);
    await db.delete(issueComments);
    await db.delete(nativeRunFinalizations);
    await db.delete(statusDecisionEffects);
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunResults);
    await db.update(heartbeatRuns).set({ completionContractId: null });
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(projects);
    await db.delete(companies);
    await db.$client.end({ timeout: 1 });
  });

  afterAll(async () => {
    await stopDb?.();
  });

  function insertSandboxProviderPlugin(pluginId: string, input: {
    pluginKey?: string;
    packageName?: string;
    displayName?: string;
    description?: string;
    author?: string;
    environmentDrivers?: Array<Record<string, unknown>>;
    status?: string;
    installOrder?: number;
  } = {}) {
    const pluginKey = input.pluginKey ?? "paperclip.fake-plugin-sandbox-provider";
    return db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: input.packageName ?? "@paperclipai/plugin-fake-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: input.displayName ?? "Fake Plugin Sandbox Provider",
        description: input.description ?? "Test fake plugin provider",
        author: input.author ?? "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: input.environmentDrivers ?? [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin", configSchema: { type: "object" } }],
      },
      status: input.status ?? "ready",
      installOrder: input.installOrder ?? 1,
      updatedAt: new Date(),
    } as any);
  }

  function insertForeignCompanyEnvironmentBinding(otherCompanyId: string, environment: { id: string }) {
    return db.insert(builtInManagedResources).values({
      companyId: otherCompanyId,
      bundleKey: "managed-environment",
      resourceKind: "environment",
      resourceKey: "managed-sandbox",
      resourceId: environment.id,
      stockVersion: "1",
      stockHash: "hash",
    });
  }

  function insertReusableProject(projectId: string, companyId: string) {
    return db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  function createFreshPluginLeaseWorker(pluginId: string) {
    return {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
  }

  it.each(["missing", "stale", "invalidated", "qualified", "provider-failure", "unowned-marker"])("uses the current managed Cloud snapshot with %s qualification", async qualification => {
    vi.stubEnv("PAPERCLIP_MANAGED_CONFIG", JSON.stringify({ ...managedCloudConfig,
      environments: qualification === "unowned-marker" ? [] : [{ name: "Paperclip Sandbox", provider: "daytona", config: {} }] }));
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const config = { provider: "daytona", snapshot: "replacement-snapshot", timeoutMs: 1234 };
    await insertSandboxProviderPlugin(pluginId, { environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", configSchema: { type: "object" } }] });
    const fingerprint = createHash("sha256").update(stableStringify(config)).digest("hex");
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, { ...baseEnvironment, driver: "sandbox", config });
    const runtimeFingerprint = createHash("sha256").update(stableStringify(parsed.config)).digest("hex");
    await db.update(environments).set({ driver: "sandbox", config, metadata: {
      managedByPaperclip: true,
      ...(qualification === "missing" ? {} : { paperclipSandboxPlatformProbes: { [companyId]: {
        v: 2, companyId, snapshot: "previous-snapshot", template: null,
        baseConfigFingerprint: qualification === "qualified" ? fingerprint : "previous-config",
        runtimeConfigFingerprint: qualification === "qualified" ? runtimeFingerprint : "previous-config",
        ...(qualification === "qualified" ? { snapshot: config.snapshot, snapshotIdentity: {
          provider: "daytona", requestedRef: config.snapshot, id: "a6b9e7d0-f886-471a-b461-640dd03e8d0f",
          name: config.snapshot, organizationId: "provider-account", createdAt: "2026-10-07T23:19:57.133Z",
        } } : {}),
        ...(qualification === "invalidated" ? { invalidated: true } : {}),
      } } }),
    } }).where(eq(environments.id, baseEnvironment.id));
    const environment = (await environmentService(db).getById(baseEnvironment.id))!;
    const worker = createFreshPluginLeaseWorker(pluginId);
    vi.mocked(worker.call).mockImplementation(async (_id, method, params: any) => {
      if (method !== "environmentAcquireLease") throw new Error(`Unexpected ${method}`);
      if (qualification === "provider-failure") throw new Error("Provider image startup failed.");
      return { providerLeaseId: "managed-snapshot-lease", metadata: { provider: "daytona", snapshot: params.config.snapshot, remoteCwd: "/workspace" } };
    });
    const acquire = environmentRuntimeService(db, { pluginWorkerManager: worker }).acquireRunLease({
      companyId, environment, issueId: null, heartbeatRunId: runId,
      persistedExecutionWorkspace: null, adapterType: "paperclip_runner",
    });
    if (qualification === "unowned-marker") {
      await expect(acquire).rejects.toThrow("sandbox_snapshot_qualification_required");
      expect(worker.call).not.toHaveBeenCalled();
      return;
    }
    if (qualification === "provider-failure") {
      await expect(acquire).rejects.toThrow("Provider image startup failed.");
      return;
    }
    const acquired = await acquire;
    expect(worker.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      config: expect.objectContaining({ snapshot: config.snapshot }),
    }), expect.any(Number));
    expect(acquired.lease.metadata?.snapshot).toBe(config.snapshot);
  });

  it("forwards the run's warm idle window to the provider worker without changing lease identity", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const config = { provider: "daytona", image: "node:20", timeoutMs: 1234 };
    await insertSandboxProviderPlugin(pluginId, { environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", configSchema: { type: "object" } }] });
    await environmentService(db).update(baseEnvironment.id, { driver: "sandbox", config });
    const environment: Environment = { ...baseEnvironment, driver: "sandbox", config };
    const worker = createFreshPluginLeaseWorker(pluginId);
    vi.mocked(worker.call).mockImplementation(async (_id, method) => {
      if (method !== "environmentAcquireLease") throw new Error(`Unexpected ${method}`);
      return { providerLeaseId: "warm-lease", metadata: { provider: "daytona", image: "node:20", remoteCwd: "/workspace" } };
    });
    const service = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const acquired = await service.acquireRunLease({ companyId,
      environment: resolveRunnerEnvironmentForRun(environment, "paperclip_runner", { lifecycleMode: "warm", idleTimeoutMs: 900_000 }),
      configuredEnvironment: environment, issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null,
      adapterType: "paperclip_runner", warmRunnerIdleTimeoutMs: 900_000 });
    expect(worker.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      config: expect.objectContaining({ reuseLease: true, warmRunnerIdleTimeoutMs: 900_000 }),
    }), expect.any(Number));
    expect(acquired.lease.metadata).not.toHaveProperty("warmRunnerIdleTimeoutMs");
  });

  it("forwards the run's remote runner reconnect grace to the provider worker without changing lease identity", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const config = { provider: "daytona", image: "node:20", timeoutMs: 1234, autoStopInterval: 5 };
    await insertSandboxProviderPlugin(pluginId, { environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", configSchema: { type: "object" } }] });
    await environmentService(db).update(baseEnvironment.id, { driver: "sandbox", config });
    const environment: Environment = { ...baseEnvironment, driver: "sandbox", config };
    const worker = createFreshPluginLeaseWorker(pluginId);
    vi.mocked(worker.call).mockImplementation(async (_id, method) => {
      if (method !== "environmentAcquireLease") throw new Error(`Unexpected ${method}`);
      return { providerLeaseId: "runner-lease", metadata: { provider: "daytona", image: "node:20", remoteCwd: "/workspace" } };
    });
    const service = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const acquired = await service.acquireRunLease({ companyId, environment, configuredEnvironment: environment,
      issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null,
      adapterType: "paperclip_runner", runnerReconnectGraceMs: 420_000 });
    expect(worker.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      config: expect.objectContaining({ autoStopInterval: 5, runnerReconnectGraceMs: 420_000 }),
    }), expect.any(Number));
    expect(acquired.lease.metadata).not.toHaveProperty("runnerReconnectGraceMs");
    expect((await environmentService(db).getById(environment.id))?.config).not.toHaveProperty("runnerReconnectGraceMs");
  });

  it.each([["paperclip_runner", false, false], ["paperclip_runner", true, false], ["paperclip_runner", true, undefined], ["claude_local", false, false], [null, false, false]] as const)("pins qualified snapshots only for native execution (%s, warm=%s, savedReuse=%s)", async (adapterType, warm, savedReuse) => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const config = { provider: "daytona", snapshot: "managed-snapshot", ...(savedReuse === undefined ? {} : { reuseLease: savedReuse }), timeoutMs: 1234 };
    await insertSandboxProviderPlugin(pluginId, { environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", configSchema: { type: "object" } }] });
    await environmentService(db).update(baseEnvironment.id, { driver: "sandbox", config });
    const environment: Environment = { ...baseEnvironment, driver: "sandbox", config };
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);
    const snapshotId = "a6b9e7d0-f886-471a-b461-640dd03e8d0f";
    environment.metadata = { paperclipSandboxPlatformProbes: { [companyId]: {
      v: 2, companyId, snapshot: config.snapshot, template: null,
      baseConfigFingerprint: createHash("sha256").update(stableStringify(config)).digest("hex"),
      runtimeConfigFingerprint: createHash("sha256").update(stableStringify(parsed.config)).digest("hex"),
      snapshotIdentity: { provider: "daytona", requestedRef: config.snapshot, id: snapshotId, name: config.snapshot, organizationId: "provider-account", createdAt: "2026-10-07T23:19:57.133Z" },
    } } };
    const worker = createFreshPluginLeaseWorker(pluginId);
    vi.mocked(worker.call).mockImplementation(async (_id, method, params: any) => {
      if (method !== "environmentAcquireLease") throw new Error(`Unexpected ${method}`);
      return { providerLeaseId: "snapshot-lease", metadata: { provider: "daytona", snapshot: params.config.snapshot, remoteCwd: "/workspace" } };
    });
    const service = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const runtimeEnvironment = warm ? resolveRunnerEnvironmentForRun(environment, "paperclip_runner", { lifecycleMode: "warm" }) : environment;
    const acquired = await service.acquireRunLease({ companyId, environment: runtimeEnvironment, configuredEnvironment: environment, issueId: null, heartbeatRunId: runId,
      persistedExecutionWorkspace: null, adapterType, ...(adapterType === null ? { resolveSnapshotIdentity: true } : {}) });
    const expectedSnapshot = adapterType === "paperclip_runner" ? snapshotId : config.snapshot;
    expect(worker.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      config: expect.objectContaining({ snapshot: expectedSnapshot }),
      ...(adapterType === null ? { resolveSnapshotIdentity: true } : {}),
    }), expect.any(Number));
    expect(acquired.lease.metadata?.snapshot).toBe(expectedSnapshot);
  });

  it.each(["qualified", "changed-base", "changed-runtime"] as const)("validates native setup against saved snapshot qualification (%s)", async state => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment } = await seedEnvironment();
    const config = { provider: "daytona", snapshot: "managed-snapshot", reuseLease: true, archiveOnRelease: false, timeoutMs: 1234 };
    await insertSandboxProviderPlugin(pluginId, { environmentDrivers: [{ driverKey: "daytona", kind: "sandbox_provider", displayName: "Daytona", configSchema: { type: "object" } }] });
    const svc = environmentService(db);
    await svc.update(baseEnvironment.id, { driver: "sandbox", config });
    const environment = (await svc.getById(baseEnvironment.id))!;
    const parsed = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);
    const snapshotId = "a6b9e7d0-f886-471a-b461-640dd03e8d0f";
    const proof = { v: 2, companyId, snapshot: config.snapshot, template: null,
      baseConfigFingerprint: createHash("sha256").update(stableStringify(config)).digest("hex"),
      runtimeConfigFingerprint: state === "changed-runtime" ? "0".repeat(64) : createHash("sha256").update(stableStringify(parsed.config)).digest("hex"),
      snapshotIdentity: { provider: "daytona", requestedRef: config.snapshot, id: snapshotId, name: config.snapshot, organizationId: "provider-account", createdAt: "2000-01-01T00:00:00.000Z" },
    };
    await db.update(environments).set({ metadata: { paperclipSandboxPlatformProbes: { [companyId]: proof } },
      ...(state === "changed-base" ? { config: { ...config, snapshot: "replacement-snapshot" } } : {}) }).where(eq(environments.id, environment.id));
    const worker = createFreshPluginLeaseWorker(pluginId);
    vi.mocked(worker.call).mockImplementation(async (_id, method, params: any) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: "setup-snapshot-lease", metadata: { provider: "daytona", snapshot: params.config.snapshot, remoteCwd: "/workspace" } };
      if (method === "environmentRealizeWorkspace") return { cwd: "/workspace" };
      if (method === "environmentReleaseLease") return { providerLeaseId: params.providerLeaseId, state: "archived" };
      throw new Error(`Unexpected ${method}`);
    });
    const result = await agentEnvironmentTestService(db, worker).resolveAdapterTestExecutionContext({ companyId, environmentId: environment.id, adapterType: "paperclip_runner" });
    if (state !== "qualified") {
      expect(result.executionTarget).toBeNull();
      expect(result.fallbackChecks).toMatchObject([{ code: "environment_lease_acquire_failed", detail: expect.stringContaining("sandbox_snapshot_qualification_required") }]);
      expect(worker.call).not.toHaveBeenCalled();
      return;
    }
    expect(result.fallbackChecks).toEqual([]);
    expect(result.executionTarget).toMatchObject({ kind: "remote", transport: "sandbox" });
    expect(worker.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({ config: expect.objectContaining({ snapshot: snapshotId, reuseLease: false, archiveOnRelease: true }) }), expect.any(Number));
    const leases = await svc.listLeases(environment.id);
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({ leasePolicy: "ephemeral", heartbeatRunId: null, providerLeaseId: "setup-snapshot-lease" });
    expect(leases[0]!.metadata).toMatchObject({ snapshot: snapshotId, reuseLease: false, archiveOnRelease: true });
    await result.release("released");
    expect(worker.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.objectContaining({ config: expect.objectContaining({ archiveOnRelease: true }), providerLeaseId: "setup-snapshot-lease" }), expect.any(Number));
    expect((await svc.getById(environment.id))!.config).toEqual(config);
  });

  it.each([
    { snapshot: "another-snapshot" },
    { image: "another-image" },
    { provider: "another-provider" },
    { env: { DIFFERENT_RUNTIME: "changed" } },
  ])("rejects non-retention run overrides before provider dispatch (%j)", async override => {
    const { companyId, environment: baseEnvironment } = await seedEnvironment();
    const environment: Environment = { ...baseEnvironment, driver: "sandbox", config: { provider: "daytona", snapshot: "managed-snapshot" } };
    const worker = createFreshPluginLeaseWorker(randomUUID());
    const service = environmentRuntimeService(db, { pluginWorkerManager: worker });
    await expect(service.acquireRunLease({ companyId, environment: { ...environment, config: { ...environment.config, ...override, reuseLease: false, archiveOnRelease: true } },
      configuredEnvironment: environment, issueId: null, heartbeatRunId: null, persistedExecutionWorkspace: null, adapterType: "paperclip_runner" }))
      .rejects.toThrow("Run environment does not match its saved configuration.");
    expect(worker.call).not.toHaveBeenCalled();
  });

  it.each(["failed-probe", "config-change", "config-and-metadata-change"] as const)("refuses a mutable snapshot after %s invalidates its proof", async invalidation => {
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const config = { provider: "daytona", snapshot: "managed-snapshot", reuseLease: false };
    const svc = environmentService(db);
    await svc.update(baseEnvironment.id, { driver: "sandbox", config });
    const proof = { v: 2, companyId, snapshot: config.snapshot, template: null,
      snapshotIdentity: { provider: "daytona", requestedRef: config.snapshot,
        id: "a6b9e7d0-f886-471a-b461-640dd03e8d0f", name: config.snapshot,
        organizationId: "provider-account", createdAt: "2026-10-07T23:19:57.133Z" },
    };
    expect(await svc.recordSandboxPlatformProbe({ environmentId: baseEnvironment.id, companyId, config, proof })).toBe(true);
    if (invalidation === "failed-probe") {
      await svc.recordSandboxPlatformProbe({ environmentId: baseEnvironment.id, companyId, config, proof: null });
    } else {
      await svc.update(baseEnvironment.id, { config: { ...config, snapshot: "replacement-name" },
        ...(invalidation === "config-and-metadata-change" ? { metadata: { userNote: "retained" } } : {}) });
    }
    const environment = (await svc.getById(baseEnvironment.id))!;
    expect((environment.metadata?.paperclipSandboxPlatformProbes as Record<string, any>)[companyId]).toMatchObject({ v: 2, invalidated: true });
    const acquire = vi.fn();
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: { call: acquire } as never });
    await expect(runtime.acquireRunLease({ companyId, environment, issueId: null, heartbeatRunId: runId,
      persistedExecutionWorkspace: null, adapterType: "paperclip_runner" })).rejects.toThrow("sandbox_snapshot_qualification_required");
    expect(acquire).not.toHaveBeenCalled();
  });

  function insertReusableExecutionWorkspace(executionWorkspaceId: string, companyId: string, projectId: string) {
    return db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  function insertStaleReusablePluginLease(companyId: string, environment: { id: string }, executionWorkspaceId: string, runId: string, agentId: string, pluginId: string, providerConfig: Record<string, unknown>) {
    return environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.fake-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });
  }

  function createReferencedWorkspaceRealizationRequest(companyId: string, environment: { id: string }, runId: string) {
    return {
      version: 1,
      adapterType: "codex_local",
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      requestedMode: "ephemeral",
      source: {
        kind: "project_primary",
        localPath: "/tmp/anchor",
        projectId: "anchor-project",
        projectWorkspaceId: "anchor-workspace",
        repoUrl: null,
        repoRef: null,
        strategy: "project_primary",
        branchName: null,
        worktreePath: null,
      },
      additionalSources: [
        {
          localPath: "/tmp/referenced-project",
          projectId: "referenced-project-1",
          projectWorkspaceId: "referenced-workspace-1",
          repoUrl: null,
          repoRef: null,
        },
      ],
    };
  }

  function insertOldReusablePluginLease(companyId: string, environment: { id: string }, executionWorkspaceId: string, runId: string, agentId: string, providerConfig: Record<string, unknown>) {
    return environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "old-plugin-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });
  }

  function insertRunningManualRun(nextRunId: string, companyId: string, agentId: string) {
    return db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedEnvironment(input: {
    driver?: EnvironmentDriver;
    name?: string;
    status?: EnvironmentStatus;
    config?: Record<string, unknown>;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    const driver: EnvironmentDriver = input.driver ?? "local";
    const environmentName = input.name ?? `${driver}-${environmentId.slice(0, 8)}`;
    let config = input.config ?? {};

    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (typeof config.privateKey === "string" && config.privateKey.length > 0) {
      const secret = await secretService(db).create(companyId, {
        name: `environment-runtime-private-key-${randomUUID()}`,
        provider: "local_encrypted",
        value: config.privateKey,
      });
      await secretService(db).createBinding({
        companyId,
        secretId: secret.id,
        targetType: "environment",
        targetId: environmentId,
        configPath: "privateKeySecretRef",
      });
      config = {
        ...config,
        privateKey: null,
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: secret.id,
          version: "latest",
        },
      };
    }
    const existingLocalEnvironment = driver === "local"
      ? await db
        .select()
        .from(environments)
        .where(eq(environments.driver, "local"))
        .then((rows) => rows[0] ?? null)
      : null;
    const environmentRecord = existingLocalEnvironment ?? {
      id: environmentId,
      name: environmentName,
      description: null,
      driver,
      status: input.status ?? "active",
      config,
      metadata: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    if (!existingLocalEnvironment) {
      await db.insert(environments).values({
        id: environmentRecord.id,
        name: environmentRecord.name,
        driver: environmentRecord.driver,
        status: environmentRecord.status,
        config: environmentRecord.config,
        createdAt: environmentRecord.createdAt,
        updatedAt: environmentRecord.updatedAt,
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const environment: Environment = {
      id: environmentRecord.id,
      name: environmentRecord.name,
      description: environmentRecord.description,
      driver,
      status: environmentRecord.status as EnvironmentStatus,
      config: environmentRecord.config,
      envVars: {},
      metadata: environmentRecord.metadata,
      createdAt: environmentRecord.createdAt,
      updatedAt: environmentRecord.updatedAt,
    };

    return {
      companyId,
      agentId,
      environment,
      runId,
    };
  }

  async function seedReusablePluginSandboxLease(
    adapterType: string | null = null,
    options: { timeoutMs?: number | null; bridgeRequestTimeoutMs?: number; defaultAcquireTimeoutMs?: number } = {},
  ) {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs ?? 1234 }),
      ...(options.bridgeRequestTimeoutMs === undefined ? {} : { bridgeRequestTimeoutMs: options.bridgeRequestTimeoutMs }),
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.reusable-sandbox-provider",
      packageName: "@acme/reusable-sandbox-provider",
      displayName: "Reusable Sandbox Provider",
      description: "Test provider with reusable lease support",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          supportsReusableLeases: true,
          defaultAcquireTimeoutMs: options.defaultAcquireTimeoutMs,
          configSchema: {
            type: "object",
            properties: {
              image: { type: "string" },
              timeoutMs: { type: "number" },
              bridgeRequestTimeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const reusableLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "reusable-plugin-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.reusable-sandbox-provider",
        sandboxProviderPlugin: true,
        ...providerConfig,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType,
            config: providerConfig,
          }),
        },
      },
    });

    return { pluginId, companyId, agentId, environment, runId, executionWorkspaceId, reusableLease };
  }

  it.each((["syncIn", "syncOut"] as const).flatMap(method =>
    [1234, 1_200_000].map(timeoutMs => ({ method, timeoutMs }))))("uses a per-call $method deadline (configured $timeoutMs) for the provider and its RPC without changing settings", async ({ method, timeoutMs }) => {
    const seeded = await seedReusablePluginSandboxLease(null, { timeoutMs });
    const call = vi.fn(async (..._args: unknown[]) => ({ operations: [] }));
    const workerManager = {
      isRunning: vi.fn(() => true), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentSyncIn", "environmentSyncOut"] })),
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const input = { environment: seeded.environment, lease: seeded.reusableLease, operations: [] };
    await runtime[method]({ ...input, minimumTimeoutMs: 900_000 });
    expect(call.mock.calls[0]?.[1]).toBe(method === "syncIn" ? "environmentSyncIn" : "environmentSyncOut");
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      config: { timeoutMs: method === "syncOut" ? Math.max(timeoutMs, 900_000) : timeoutMs },
      minimumTimeoutMs: 900_000,
    });
    expect(call.mock.calls[0]?.[3]).toBeGreaterThan(Math.max(900_000, timeoutMs));
    await runtime[method](input);
    expect(call.mock.calls[1]?.[2]).toMatchObject({
      config: { timeoutMs: method === "syncOut" ? Math.max(timeoutMs, 300_000) : timeoutMs },
    });
    expect(call.mock.calls[1]?.[2]).not.toHaveProperty("minimumTimeoutMs");
    expect(seeded.environment.config.timeoutMs).toBe(timeoutMs);
    expect((await environmentService(db).getById(seeded.environment.id))?.config.timeoutMs).toBe(timeoutMs);
  });

  it.each([
    { method: "syncOut" as const, label: "no configured timeouts", bridgeRequestTimeoutMs: undefined, minimumTimeoutMs: undefined, configTimeoutMs: 300_000, rpcTimeoutMs: 330_000 },
    { method: "syncOut" as const, label: "a larger bridge budget", bridgeRequestTimeoutMs: 600_000, minimumTimeoutMs: undefined, configTimeoutMs: 600_000, rpcTimeoutMs: 630_000 },
    { method: "syncOut" as const, label: "a larger supplied minimum", bridgeRequestTimeoutMs: undefined, minimumTimeoutMs: 1_800_000, configTimeoutMs: 1_800_000, rpcTimeoutMs: 1_830_000 },
    { method: "syncIn" as const, label: "no configured timeouts", bridgeRequestTimeoutMs: undefined, minimumTimeoutMs: undefined, configTimeoutMs: undefined, rpcTimeoutMs: 30_000 },
  ])("applies the outbound-only timeout floor to $method with $label", async ({ method, bridgeRequestTimeoutMs, minimumTimeoutMs, configTimeoutMs, rpcTimeoutMs }) => {
    const seeded = await seedReusablePluginSandboxLease(null, { timeoutMs: null, bridgeRequestTimeoutMs });
    const call = vi.fn(async (..._args: unknown[]) => ({ operations: [] }));
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: vi.fn(() => true), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentSyncIn", "environmentSyncOut"] })),
    } as unknown as PluginWorkerManager });
    await runtime[method]({ environment: seeded.environment, lease: seeded.reusableLease,
      operations: [], ...(minimumTimeoutMs === undefined ? {} : { minimumTimeoutMs }) });
    const params = call.mock.calls[0]?.[2] as { config: Record<string, unknown> };
    expect(call.mock.calls[0]?.[1]).toBe(method === "syncOut" ? "environmentSyncOut" : "environmentSyncIn");
    expect({
      configTimeoutMs: params.config.timeoutMs,
      // An omitted RPC budget uses plugin-worker-manager's existing 30 s default.
      rpcTimeoutMs: call.mock.calls[0]?.[3] ?? 30_000,
    }).toEqual({ configTimeoutMs, rpcTimeoutMs });
    if (method === "syncIn") expect(call.mock.calls[0]?.[3]).toBeUndefined();
    expect(params.config.bridgeRequestTimeoutMs).toBe(bridgeRequestTimeoutMs);
    expect(seeded.environment.config).not.toHaveProperty("timeoutMs");
    expect((await environmentService(db).getById(seeded.environment.id))?.config).toEqual(seeded.environment.config);
  });

  it.each(["syncIn", "syncOut"] as const)("rejects invalid %s deadlines before a provider call", async method => {
    const seeded = await seedReusablePluginSandboxLease();
    const call = vi.fn();
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: vi.fn(() => true), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentSyncIn", "environmentSyncOut"] })),
    } as unknown as PluginWorkerManager });
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 30 * 60_000 + 1]) {
      await expect(runtime[method]({ environment: seeded.environment, lease: seeded.reusableLease,
        operations: [], minimumTimeoutMs: timeoutMs })).rejects.toThrow("Invalid sandbox sync timeout");
    }
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["active", "released"] as const)("does not select an ephemeral allocation for warm reuse (%s)", async status => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral", status,
      releasedAt: status === "released" ? new Date() : null }).where(eq(environmentLeases.id, seeded.reusableLease.id));
    const workerManager = createFreshPluginLeaseWorker(seeded.pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId, environment: seeded.environment, agentId: seeded.agentId,
      issueId: null, adapterType: "paperclip_runner", heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" },
    });
    expect(seeded.environment.config.reuseLease).toBe(true);
    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.providerLeaseId).not.toBe(seeded.reusableLease.providerLeaseId);
    expect(workerManager.call).toHaveBeenCalledExactlyOnceWith(seeded.pluginId, "environmentAcquireLease", expect.any(Object), expect.any(Number));
  });

  it("gives a bootstrap retry a fresh allocation even when the failed lease was reusable", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    let acquisitions = 0;
    const workerManager = {
      isRunning: () => true,
      call: vi.fn(async (_id: string, method: string) => {
        if (method === "environmentAcquireLease") return { providerLeaseId: `fresh-bootstrap-${++acquisitions}`,
          metadata: { provider: "fake-plugin", reuseLease: true, remoteCwd: "/workspace" } };
        throw new Error(`Unexpected provider operation: ${method}`);
      }),
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const input = { companyId: seeded.companyId, environment: seeded.environment, issueId: null, agentId: seeded.agentId,
      adapterType: "paperclip_runner", heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" as const } };
    const first = await runtime.acquireRunLease(input);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "remote_workspace_prepare_timeout" })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await environmentService(db).releaseLease(first.lease.id, "failed");
    const retryRunId = randomUUID();
    await insertRunningManualRun(retryRunId, seeded.companyId, seeded.agentId);
    const next = await runtime.acquireRunLease({ ...input, heartbeatRunId: retryRunId });
    expect(next.lease.providerLeaseId).toBe("fresh-bootstrap-2");
    expect(next.lease.providerLeaseId).not.toBe(first.lease.providerLeaseId);
    expect(workerManager.call).toHaveBeenCalledTimes(2);
    expect((await environmentService(db).getLeaseById(first.lease.id))?.status).toBe("failed");
  });

  it.each(["succeeded", "failed", "cancelled"])("passes the retained lease's last run outcome on acquisition reuse: %s", async status => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const finishedAt = new Date("2026-01-02T03:04:05.000Z");
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentResumeLease" && method !== "environmentAcquireLease") throw new Error(`Unexpected plugin method: ${method}`);
      return { providerLeaseId: seeded.reusableLease.providerLeaseId, metadata: { remoteCwd: "/workspace" } };
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    // Prime through real acquisition so the stored reuse identity matches the
    // host-resolved runtime config, rather than a hand-constructed fingerprint.
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const input = { companyId: seeded.companyId, environment: seeded.environment,
      issueId: null, agentId: seeded.agentId, adapterType: "paperclip_runner",
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" as const } };
    const first = await runtime.acquireRunLease({ ...input, heartbeatRunId: seeded.runId });
    await db.update(heartbeatRuns).set({ status, finishedAt }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(environmentLeases).set({ status: "retained" }).where(eq(environmentLeases.id, first.lease.id));
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    const acquired = await runtime.acquireRunLease({ ...input, heartbeatRunId: nextRunId });
    expect(acquired.lease.providerLeaseId).toBe(seeded.reusableLease.providerLeaseId);
    expect(call).toHaveBeenCalledWith(seeded.pluginId, "environmentResumeLease", expect.objectContaining({
      leaseStatus: "retained", lastRun: { id: seeded.runId, status, finishedAt: finishedAt.toISOString() },
    }), expect.any(Number));
  });

  it.each(["running", "failed"])("passes the active lease's own run during restart recovery: %s", async status => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const finishedAt = status === "running" ? null : new Date("2026-01-02T03:04:05.000Z");
    await db.update(heartbeatRuns).set({ status, finishedAt }).where(eq(heartbeatRuns.id, seeded.runId));
    const call = vi.fn(async () => ({ providerLeaseId: seeded.reusableLease.providerLeaseId }));
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    await runtime.resumeRunLease({ environment: seeded.environment, lease: seeded.reusableLease });
    expect(call).toHaveBeenCalledWith(seeded.pluginId, "environmentResumeLease", expect.objectContaining({
      leaseStatus: "active", lastRun: { id: seeded.runId, status, finishedAt: finishedAt?.toISOString() ?? null },
    }), expect.any(Number));
    expect((await environmentService(db).getLeaseById(seeded.reusableLease.id))?.status).toBe("active");
  });

  it("passes null lastRun when the resumed lease has no bound heartbeat run", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    await db.update(environmentLeases).set({ heartbeatRunId: null }).where(eq(environmentLeases.id, seeded.reusableLease.id));
    const lease = (await environmentService(db).getLeaseById(seeded.reusableLease.id))!;
    const call = vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId }));
    await environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager }).resumeRunLease({ environment: seeded.environment, lease });
    expect(call).toHaveBeenCalledWith(seeded.pluginId, "environmentResumeLease", expect.objectContaining({
      leaseStatus: "active", lastRun: null,
    }), expect.any(Number));
  });

  it("acquires and resumes a reusable lease after a task changes from per-turn to warm", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const environment = { ...seeded.environment, config: { ...seeded.environment.config, reuseLease: false } };
    await environmentService(db).update(environment.id, { config: environment.config });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: seeded.companyId, title: "Lifecycle switch", status: "in_progress", assigneeAgentId: seeded.agentId });
    let acquisitions = 0;
    let warmProviderLeaseId = "";
    const call = vi.fn(async (_pluginId: string, method: string, input: any) => {
      if (method === "environmentAcquireLease") return {
        providerLeaseId: `lifecycle-${++acquisitions}`, metadata: { remoteCwd: "/workspace" },
      };
      if (method === "environmentResumeLease") return {
        providerLeaseId: warmProviderLeaseId, metadata: { remoteCwd: "/workspace", creationOperationId: randomUUID() },
      };
      if (method === "environmentDestroyLease" || method === "environmentStopLease" || method === "environmentReleaseLease") return {
        providerLeaseId: input.providerLeaseId, state: method === "environmentDestroyLease" ? "destroyed" : "stopped",
      };
      throw new Error(`Unexpected lifecycle method: ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const input = {
      companyId: seeded.companyId, agentId: seeded.agentId, issueId,
      adapterType: "paperclip_runner", persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" as const },
    };
    const cold = await runtime.acquireRunLease({ ...input, environment, heartbeatRunId: seeded.runId });
    expect(cold.lease.leasePolicy).toBe("ephemeral");
    await runtime.releaseRunLeases(seeded.runId, "released");
    const warmEnvironment = resolveRunnerEnvironmentForRun(environment, "paperclip_runner", { lifecycleMode: "warm" }, undefined, "selected-account:generation");
    const warmRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: warmRunId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    const warm = await runtime.acquireRunLease({ ...input, environment: warmEnvironment, heartbeatRunId: warmRunId });
    warmProviderLeaseId = warm.lease.providerLeaseId!;
    expect(warm.lease.leasePolicy).toBe("reuse_by_environment");
    expect(warm.lease.executionWorkspaceId).toBe(seeded.executionWorkspaceId);
    expect((await runtime.resolveCapabilities({ environment: warmEnvironment, lease: warm.lease }))?.reusableLeases).toBe(true);
    await runtime.releaseRunLeases(warmRunId, "released", undefined, "stop_and_retain");
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    const next = await runtime.acquireRunLease({ ...input, environment: warmEnvironment, heartbeatRunId: nextRunId });
    expect(next.lease.providerLeaseId).toBe(warmProviderLeaseId);
    expect(next.lease.heartbeatRunId).toBe(nextRunId);
    expect(next.lease.id).not.toBe(warm.lease.id);
    expect(acquisitions).toBe(2);
    expect((await environmentService(db).getById(environment.id))?.config.reuseLease).toBe(false);
  });

  it.each(["stopped", "missing", "wrong-lease", "error"])(
    "startup cancellation is run-scoped and needs a matching receipt: %s",
    async (outcome) => {
      const { pluginId, companyId, runId, reusableLease, environment } = await seedReusablePluginSandboxLease();
      const other = await environmentService(db).acquireLease({
        companyId, environmentId: environment.id, heartbeatRunId: null,
        leasePolicy: "ephemeral", provider: "fake-plugin", providerLeaseId: "other-sandbox",
      });
      const call = vi.fn(async () => {
        if (outcome === "error") throw new Error("provider unavailable");
        if (outcome === "missing") return undefined;
        return { providerLeaseId: outcome === "wrong-lease" ? "other-sandbox" : reusableLease.providerLeaseId, state: "stopped" };
      });
      const workerManager = {
        isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentStopLease"] }),
      } as unknown as PluginWorkerManager;
      const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
      await runtimeWithPlugin.releaseRunLeases(runId, "released", undefined, "stop_and_retain", true);
      expect(call).toHaveBeenCalledWith(pluginId, "environmentStopLease", expect.objectContaining({
        companyId, providerLeaseId: reusableLease.providerLeaseId, cancelActiveWork: true,
      }), expect.any(Number));
      expect(call).toHaveBeenCalledOnce();
      expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(outcome === "stopped");
      await expect(environmentService(db).getLeaseById(other.id)).resolves.toMatchObject({ status: "active" });
    },
  );

  it.each(["release_only", "stopped", "stop_failed", "unconfirmed", "restart", "competing_owner", "missing_pin", "late_receipt"])(
    "never dispatches destructive release for an untagged stop-and-retain request: %s", async outcome => {
      const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
      const lease = seeded.reusableLease;
      await db.update(environmentLeases).set({ leasePolicy: "ephemeral", metadata: {
        ...lease.metadata, reuseLease: false, ...(outcome === "missing_pin" ? { pluginId: undefined } : {}),
      } }).where(eq(environmentLeases.id, lease.id));
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
      let supported = !["release_only", "restart"].includes(outcome);
      let calls = 0;
      const call = vi.fn(async (_id: string, method: string) => {
        if (method !== "environmentStopLease") return { providerLeaseId: lease.providerLeaseId, state: "destroyed" };
        if (++calls === 1 && outcome === "stop_failed") throw new Error("injected stop failure");
        if (calls === 1 && outcome === "unconfirmed") return undefined;
        if (outcome === "late_receipt") await db.update(environmentLeases).set({
          status: "active", heartbeatRunId: null, cleanupStatus: null, metadata: { newOwner: true },
        }).where(eq(environmentLeases.id, lease.id));
        return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
      });
      const runtime = () => environmentRuntimeService(db, { pluginWorkerManager: {
        isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentReleaseLease", "environmentDestroyLease", ...(supported ? ["environmentStopLease"] : [])] }),
      } as unknown as PluginWorkerManager });
      if (outcome === "competing_owner") await environmentService(db).acquireLease({
        companyId: seeded.companyId, environmentId: seeded.environment.id, heartbeatRunId: null,
        leasePolicy: "ephemeral", provider: lease.provider, providerLeaseId: lease.providerLeaseId,
      });
      await runtime().releaseRunLeases(seeded.runId, "failed", undefined, "stop_and_retain");
      expect(call.mock.calls.every(entry => entry[1] === "environmentStopLease")).toBe(true);
      if (outcome === "late_receipt") {
        expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "active", heartbeatRunId: null, metadata: { newOwner: true } });
        return;
      }
      if (outcome === "missing_pin") {
        expect(call).not.toHaveBeenCalled();
        await heartbeatService(db, { environmentRuntime: runtime() }).sweepPendingCleanupLeases({ backoffMs: 0 });
        expect(call).not.toHaveBeenCalled();
        expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "pending_cleanup" });
        return;
      }
      if (["release_only", "restart", "competing_owner"].includes(outcome)) {
        expect(call).not.toHaveBeenCalled();
        expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "pending_cleanup", metadata: {
          sandboxStopAndRetain: { pluginId: seeded.pluginId, runId: seeded.runId, providerLeaseId: lease.providerLeaseId },
        } });
        await heartbeatService(db, { environmentRuntime: runtime() }).sweepPendingCleanupLeases({ backoffMs: 0 });
        expect(call).not.toHaveBeenCalled();
        if (outcome === "competing_owner") return;
        supported = true;
      }
      if (["release_only", "stop_failed", "unconfirmed", "restart"].includes(outcome)) {
        await heartbeatService(db, { environmentRuntime: runtime() }).sweepPendingCleanupLeases({ backoffMs: 0 });
      }
      expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "released", cleanupStatus: "success", failureReason: null,
        metadata: { remoteExecutionTermination: { state: "stopped", providerLeaseId: lease.providerLeaseId },
          sandboxStopAndRetainReceipt: { method: "environmentStopLease", runId: seeded.runId, pluginId: seeded.pluginId } } });
      expect(call.mock.calls.every(entry => entry[1] === "environmentStopLease")).toBe(true);
    },
  );

  it("settles a plugin stop whose provider reports the sandbox gone (boxd, Daytona not found) through the cleanup sweep", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const lease = seeded.reusableLease;
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral", metadata: { ...lease.metadata, reuseLease: false } })
      .where(eq(environmentLeases.id, lease.id));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
    let gone = false;
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentStopLease") throw new Error(`unexpected ${method}`);
      if (!gone) throw new Error("provider unavailable");
      return { providerLeaseId: lease.providerLeaseId, state: "destroyed" };
    });
    const runtime = () => environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
    } as unknown as PluginWorkerManager });
    await runtime().releaseRunLeases(seeded.runId, "failed", undefined, "stop_and_retain");
    expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "pending_cleanup" });
    gone = true;
    await heartbeatService(db, { environmentRuntime: runtime() }).sweepPendingCleanupLeases({ backoffMs: 0 });
    const settled = (await environmentService(db).getLeaseById(lease.id))!;
    expect(settled).toMatchObject({ status: "released", cleanupStatus: "success", failureReason: "workspace_source_unavailable",
      metadata: { remoteExecutionTermination: { state: "destroyed", providerLeaseId: lease.providerLeaseId } } });
    expect(settled.metadata).not.toHaveProperty("sandboxStopAndRetainReceipt");
    expect(call.mock.calls.every(entry => entry[1] === "environmentStopLease")).toBe(true);
  });

  it("renews the stop-only cleanup claim while the provider stop is still running", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const lease = seeded.reusableLease;
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral", metadata: { ...lease.metadata, reuseLease: false } })
      .where(eq(environmentLeases.id, lease.id));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
    const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    const call = vi.fn(async (_id: string, method: string) => {
      if (method === "environmentStopLease") { started.resolve(); await finish.promise; }
      return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentReleaseLease", "environmentDestroyLease", "environmentStopLease"] }),
    } as unknown as PluginWorkerManager });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const releasing = runtime.releaseRunLeases(seeded.runId, "failed", undefined, "stop_and_retain");
    try {
      await started.promise;
      const expiry = async () => Number((await environmentService(db).getLeaseById(lease.id))?.metadata?.pendingCleanupLeaseExpiresAtMs);
      await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"pendingCleanupLeaseExpiresAtMs":1}'::jsonb` })
        .where(eq(environmentLeases.id, lease.id));
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => expect(await expiry()).toBeGreaterThan(Date.now() + 14 * 60_000));
    } finally { finish.resolve(); await releasing; vi.useRealTimers(); }
    expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "released", cleanupStatus: "success" });
  });

  it("reports an unwired manager separately from a stopped sandbox worker", async () => {
    const { companyId, environment, runId } = await seedReusablePluginSandboxLease();
    const input = {
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    };
    const runtimeWithoutManager = environmentRuntimeService(db);
    await expect(runtimeWithoutManager.acquireRunLease(input))
      .rejects.toThrow("sandbox plugin workers are unavailable in this server process");

    const offlineManager = { isRunning: () => false, call: vi.fn() } as unknown as PluginWorkerManager;
    const runtimeWithStoppedWorker = environmentRuntimeService(db, {
      pluginWorkerManager: offlineManager,
      pluginWorkerReadyTimeoutMs: 0,
    });
    const refusal = await runtimeWithStoppedWorker.acquireRunLease(input).catch(error => error);
    expect(refusal).toBeInstanceOf(PluginWorkerUnavailableError);
    expect((refusal as Error).message).toContain("its worker is not running");
    expect(offlineManager.call).not.toHaveBeenCalled();
  });

  it("treats a sandbox plugin errored by activation timeouts as restarting while it re-activates", async () => {
    const { companyId, environment, runId, pluginId } = await seedReusablePluginSandboxLease();
    const input = { companyId, environment, issueId: null, heartbeatRunId: runId, persistedExecutionWorkspace: null };
    await db.update(plugins).set({ status: "error", lastError: "Activation timed out after 4 retries: Worker initialize failed" })
      .where(eq(plugins.id, pluginId));
    const requestActivationTimeoutRecovery = vi.fn(() => true);
    const manager = { isRunning: () => false, call: vi.fn(), requestActivationTimeoutRecovery } as unknown as PluginWorkerManager;
    const refusal = await environmentRuntimeService(db, { pluginWorkerManager: manager, pluginWorkerReadyTimeoutMs: 0 })
      .acquireRunLease(input).catch(error => error);
    expect(refusal).toBeInstanceOf(PluginWorkerUnavailableError);
    expect(requestActivationTimeoutRecovery).toHaveBeenCalledWith(expect.objectContaining({ id: pluginId, status: "error" }));

    requestActivationTimeoutRecovery.mockReturnValue(false);
    const terminal = await environmentRuntimeService(db, { pluginWorkerManager: manager, pluginWorkerReadyTimeoutMs: 0 })
      .acquireRunLease(input).catch(error => error);
    expect(terminal).not.toBeInstanceOf(PluginWorkerUnavailableError);
    expect((terminal as Error).message).toContain("but that plugin is currently error");
    expect(manager.call).not.toHaveBeenCalled();
  });

  it("retains a successful reusable sandbox lease without stopping the provider resource", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Unexpected plugin method while retaining warm lease: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "released",
      undefined,
      "keep_running",
    );

    expect(released).toHaveLength(1);
    expect(released[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "retained",
      cleanupStatus: "success",
    });
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "retained",
      cleanupStatus: "success",
    });
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("stops a reusable sandbox and keeps its lease resumable", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentStopLease") return { providerLeaseId: reusableLease.providerLeaseId, state: "stopped" };
        throw new Error(`Unexpected plugin method while stopping lease: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentStopLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "failed",
      undefined,
      "stop_and_retain",
    );

    expect(released[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "released",
    });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentStopLease",
      expect.objectContaining({ providerLeaseId: reusableLease.providerLeaseId }),
      expect.any(Number),
    );
  });

  it.each(["handoff", "fresh", "legacy resume"] as const)("preserves the portable task placement on a run retry (%s)", async mode => {
    const resumeSession = mode !== "fresh";
    const pluginId = randomUUID();
    const pluginKey = "paperclip.test-portable-tasks";
    const seeded = await seedEnvironment({ driver: "plugin", config: { pluginKey, driverKey: "tasks", runnerLifecycleMode: "warm" } });
    await insertSandboxProviderPlugin(pluginId, { pluginKey, environmentDrivers: [{
      driverKey: "tasks", kind: "sandbox_provider", supportsTasks: true, warmTaskVersion: 1, sessionHandoffVersion: 1,
    }] });
    const issueId = randomUUID(), sessionId = randomUUID(), nextRunId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: seeded.companyId, title: "Portable session", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    let acquisitions = 0;
    const call = vi.fn(async (_plugin: string, method: string, _params?: unknown) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: `sandbox-${++acquisitions}`,
        metadata: { ownershipGeneration: `generation-${acquisitions}` } };
      if (method === "environmentResumeLease") return { providerLeaseId: "sandbox-1", metadata: {} };
      if (method === "environmentReleaseLease") return { providerLeaseId: "sandbox-1", state: "stopped" };
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentResumeLease"] }),
    } as unknown as PluginWorkerManager });
    const input = { companyId: seeded.companyId, environment: seeded.environment, issueId, agentId: seeded.agentId,
      persistedExecutionWorkspace: null, adapterType: "paperclip_runner" };
    const orchestrator = environmentRunOrchestrator(db, { environmentRuntime: runtime });
    const acquisitionInput = { ...input, selectedEnvironmentId: seeded.environment.id, localEnvironmentId: randomUUID(),
      admittedLifecycleMode: "warm" as const, executionWorkspaceSettings: null };
    const first = await orchestrator.acquireForRun({ ...acquisitionInput, heartbeatRunId: seeded.runId });
    expect(call.mock.calls.find(([, method]) => method === "environmentAcquireLease")?.[2])
      .toMatchObject({ runnerLifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 } });
    expect(first.lease.metadata?.runnerTaskLifecyclePolicy).toEqual({ mode: "warm", idleTimeoutMs: 300_000 });
    await db.update(environmentLeases).set({ status: "retained", metadata: {
      ...first.lease.metadata, runnerTaskIdentity: { sessionId },
      ...(mode === "legacy resume" ? {} : { runnerTaskAccountIdentity: "test-account" }),
    } }).where(eq(environmentLeases.id, first.lease.id));
    const nextInput = { ...acquisitionInput, heartbeatRunId: nextRunId, runnerTaskResumeSessionId: resumeSession ? sessionId : null };
    const next = await orchestrator.acquireForRun(nextInput);
    expect(next.lease.providerLeaseId).toBe(mode === "legacy resume" ? "sandbox-1" : "sandbox-2");
    expect(next.lease.metadata?.portableTaskPreviousLeaseId).toBe(mode === "handoff" ? first.lease.id : undefined);
    await expect(orchestrator.acquireForRun(nextInput)).resolves.toMatchObject({ lease: { id: next.lease.id, providerLeaseId: next.lease.providerLeaseId } });
    if (mode === "handoff") {
      await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, seeded.agentId));
      await db.update(issues).set({ assigneeAgentId: seeded.agentId, executionRunId: nextRunId }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId, nativeIssueId: issueId, runtimeMode: "native",
        nativeSessionId: sessionId, runnerInstanceId: randomUUID(), runnerProfileJson: {
          nativePreparationFencingVersion: NATIVE_PREPARATION_FENCING_VERSION,
          sessionCheckpoint: { identity: { companyId: seeded.companyId, agentId: seeded.agentId, issueId, runId: nextRunId, sessionId },
            providerSessionId: "inherited-provider-session" },
        } }).where(eq(heartbeatRuns.id, nextRunId));
      await db.insert(nativeRunFinalizations).values({ runId: nextRunId, companyId: seeded.companyId, issueId, phase: "observed" });
      try {
        const [claim] = await claimNativeRestartRecoveries({ db, restartKind: "hard", runIds: [nextRunId] });
        expect(claim).toMatchObject({ kind: "bootstrap_incomplete", runId: nextRunId, portablePreparationLeaseId: next.lease.id });
        if (claim.kind !== "bootstrap_incomplete" || !claim.portablePreparationLeaseId) throw new Error("Expected portable bootstrap recovery");
        const preparation = { kind: "plugin_task" as const, leaseId: claim.portablePreparationLeaseId, preparation: true as const };
        await expect(orchestrator.acquireForRun({ ...nextInput, reattachRemoteLease: preparation }))
          .resolves.toMatchObject({ lease: { id: next.lease.id, providerLeaseId: "sandbox-2", heartbeatRunId: nextRunId } });
        await expect(orchestrator.acquireForRun({ ...nextInput, reattachRemoteLease: preparation, issueId: null }))
          .rejects.toThrow("field=lease_scope");
        await expect(orchestrator.acquireForRun({ ...nextInput, reattachRemoteLease: preparation,
          persistedExecutionWorkspace: { id: randomUUID(), mode: "isolated_workspace" } })).rejects.toThrow("field=lease_scope");
        const otherEnvironmentId = randomUUID();
        await db.insert(environments).values({ id: otherEnvironmentId, name: otherEnvironmentId, driver: "plugin",
          status: "active", config: seeded.environment.config });
        await expect(orchestrator.acquireForRun({ ...nextInput, reattachRemoteLease: preparation,
          selectedEnvironmentId: otherEnvironmentId })).rejects.toThrow("field=lease_scope");
      } finally {
        await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, nextRunId));
      }
    }
    await expect(orchestrator.acquireForRun({ ...nextInput, issueId: null })).rejects.toThrow("Active plugin task placement changed");
    expect(call.mock.calls.map(([, method]) => method)).toEqual({
      handoff: ["environmentAcquireLease", "environmentAcquireLease"],
      fresh: ["environmentAcquireLease", "environmentReleaseLease", "environmentAcquireLease"],
      "legacy resume": ["environmentAcquireLease", "environmentResumeLease"],
    }[mode]);
  });

  it.each(["same task", "different task", "different agent", "no task"])(
    "scopes projectless reusable leases to their task and agent: %s", async (scenario) => {
    const seeded = await seedReusablePluginSandboxLease();
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    await db.insert(issues).values([issueId, otherIssueId].map(id => ({
      id, companyId: seeded.companyId, title: "Projectless chat", status: "in_progress",
      assigneeAgentId: seeded.agentId,
    })));
    const nextAgentId = scenario === "different agent" ? randomUUID() : seeded.agentId;
    if (nextAgentId !== seeded.agentId) await db.insert(agents).values({
      id: nextAgentId, companyId: seeded.companyId, name: "Other agent", adapterType: "paperclip_runner",
    });
    let acquisitions = 0;
    const call = vi.fn(async (_pluginId: string, method: string) => {
      if (method === "environmentAcquireLease") return {
        providerLeaseId: `projectless-${++acquisitions}`, metadata: { remoteCwd: "/workspace" },
      };
      if (method === "environmentResumeLease") return {
        providerLeaseId: "projectless-1", metadata: { remoteCwd: "/workspace" },
      };
      if (method === "environmentStopLease") return { providerLeaseId: "projectless-1", state: "stopped" };
      throw new Error(`Unexpected projectless lease method: ${method}`);
    });
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const first = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId, environment: seeded.environment, issueId,
      agentId: seeded.agentId, heartbeatRunId: seeded.runId, persistedExecutionWorkspace: null,
    });
    expect(first.lease.metadata?.reusableSandboxLease).toMatchObject({
      projectlessIssueId: issueId, executionWorkspaceId: null, agentId: seeded.agentId,
    });
    await runtimeWithPlugin.releaseRunLeases(seeded.runId, "released", undefined, "stop_and_retain");
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId, companyId: seeded.companyId, agentId: nextAgentId, status: "running",
    });
    if (scenario === "different task" || scenario === "different agent") {
      await expect(environmentService(db).acquireLease({
        companyId: seeded.companyId, environmentId: seeded.environment.id,
        issueId: scenario === "different task" ? otherIssueId : issueId,
        heartbeatRunId: nextRunId, executionWorkspaceId: null,
        provider: "fake-plugin", providerLeaseId: first.lease.providerLeaseId,
        leasePolicy: "reuse_by_environment", replacesReusableLeaseId: first.lease.id,
        metadata: { agentId: nextAgentId },
      })).rejects.toMatchObject({ status: 409 });
    }
    const next = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId, environment: seeded.environment,
      issueId: scenario === "no task" ? null : scenario === "different task" ? otherIssueId : issueId,
      agentId: nextAgentId, heartbeatRunId: nextRunId, persistedExecutionWorkspace: null,
    });
    const shouldResume = scenario === "same task";
    expect(next.lease.providerLeaseId).toBe(shouldResume ? "projectless-1" : "projectless-2");
    expect(acquisitions).toBe(shouldResume ? 1 : 2);
    expect(call.mock.calls.filter((entry) => entry[1] === "environmentResumeLease")).toHaveLength(shouldResume ? 1 : 0);
  });

  it.each(["pending", "inline", "foreign scope", "foreign environment", "foreign run", "malformed", "deleted environment", "forged error", "invalid diagnostic", "old worker"])("retains uncertain plugin creation for durable cleanup: %s", async (mode) => {
    const seeded = await seedReusablePluginSandboxLease();
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const attemptId = randomUUID();
    const providerLeaseId = `paperclip-create-${attemptId}`;
    const cleanup = {
      providerLeaseId, attemptId, companyId: mode === "foreign scope" ? randomUUID() : seeded.companyId,
      environmentId: mode === "foreign environment" ? randomUUID() : seeded.environment.id,
      runId: mode === "foreign run" ? randomUUID() : seeded.runId,
      accountFingerprint: mode === "malformed" ? "invalid" : "a".repeat(64), labels: { "paperclip-provider": "fake-plugin" },
    };
    const acquisitionDiagnostic = { phase: "shell", elapsedMs: 300_000, budgetMs: 300_000 };
    const data = { schema: "paperclip/environment-creation-cleanup/v1", cleanup,
      ...(mode === "old worker" ? {} : { acquisitionDiagnostic: mode === "invalid diagnostic"
        ? { ...acquisitionDiagnostic, phase: "private-command" } : acquisitionDiagnostic }),
    };
    const failure = mode === "forged error"
      ? Object.assign(new Error("Provider creation cleanup required"), { data })
      : new JsonRpcCallError({ code: -32002, message: "Provider creation cleanup required", data });
    let available = mode === "inline";
    const call = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
      if (method === "environmentAcquireLease") throw failure;
      if (method === "environmentDestroyLease") {
        const pending = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, providerLeaseId));
        expect(pending).toHaveLength(1);
        expect(pending[0].status).toBe("pending_cleanup");
        expect(params).toMatchObject({ providerLeaseId, companyId: seeded.companyId, environmentId: seeded.environment.id, leaseMetadata: { failedCreateCleanup: cleanup } });
        if (!available) throw new Error("provider not visible yet");
        return { providerLeaseId, state: "destroyed" };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }), call } as unknown as PluginWorkerManager;
    const candidate = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const acquisition = candidate.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment,
      issueId: null, heartbeatRunId: seeded.runId, persistedExecutionWorkspace: null });
    const caught = await acquisition.catch(error => error);
    const execution = collectRunFailureDiagnostics({ id: seeded.runId, companyId: seeded.companyId,
      errorCode: "setup_failed", resultJson: null,
    } as typeof heartbeatRuns.$inferSelect, { error: caught, phase: "setup" }).execution;
    if (["pending", "inline", "deleted environment"].includes(mode)) {
      expect(execution).toMatchObject({ environmentAcquisitionPhase: "shell",
        environmentAcquisitionElapsedMs: 300_000, environmentAcquisitionBudgetMs: 300_000 });
    } else expect(execution).not.toHaveProperty("environmentAcquisitionPhase");
    await expect(acquisition).rejects.toBe(failure);
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, providerLeaseId));
    expect(rows).toHaveLength(0);
    expect(call.mock.calls.filter(value => value[1] === "environmentDestroyLease")).toHaveLength(0);
    expect(await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.companyId, seeded.companyId)))
      .toEqual([expect.objectContaining({ state: "pending", originalEnvironmentId: seeded.environment.id, runId: seeded.runId })]);
  });

  it.each(["worker", "forged error", "invalid worker diagnostic"])("records the step of a sandbox the provider could not start and removed: %s", async (mode) => {
    const seeded = await seedReusablePluginSandboxLease();
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const data = { schema: "paperclip/environment-acquire-error/v1",
      acquisitionDiagnostic: { phase: mode === "invalid worker diagnostic" ? "private-command" : "create",
        elapsedMs: 38_000, budgetMs: 90_000, providerState: "error" } };
    const failure = mode === "forged error"
      ? Object.assign(new Error("Daytona could not start the sandbox; it was removed."), { data })
      : new JsonRpcCallError({ code: -32002, message: "Daytona could not start the sandbox; it was removed.", data });
    const call = vi.fn(async (_id: string, method: string) => {
      if (method === "environmentAcquireLease") throw failure;
      throw new Error(`Unexpected method ${method}`);
    });
    const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }), call } as unknown as PluginWorkerManager;
    const caught = await environmentRuntimeService(db, { pluginWorkerManager: worker }).acquireRunLease({
      companyId: seeded.companyId, environment: seeded.environment, issueId: null, heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: null }).catch(error => error);
    expect(caught).toBe(failure);
    const run = { id: seeded.runId, companyId: seeded.companyId };
    const execution = collectRunFailureDiagnostics({ ...run, errorCode: "setup_failed", resultJson: null,
    } as typeof heartbeatRuns.$inferSelect, { error: caught, phase: "setup" }).execution;
    if (mode === "worker") {
      expect(execution).toMatchObject({ environmentAcquisitionPhase: "create", environmentAcquisitionProviderState: "error" });
      expect(readTransientLeaseAcquisitionFailure(caught, run)).toEqual({ reason: "provider_start_failed" });
    } else {
      expect(execution).not.toHaveProperty("environmentAcquisitionPhase");
      expect(readTransientLeaseAcquisitionFailure(caught, run)).toBeNull();
    }
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.status, "pending_cleanup"))).toHaveLength(0);
  });

  it.each(["deleted receipt lost", "observation response lost", "journal write failed", "foreign observation"])(
    "journals observed creation identity before deletion and recovers: %s", async (fault) => {
      const seeded = await seedReusablePluginSandboxLease();
      await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
      const cleanup = {
        providerLeaseId: `paperclip-create-${randomUUID()}`, attemptId: randomUUID(),
        companyId: seeded.companyId, environmentId: seeded.environment.id, runId: seeded.runId,
        accountFingerprint: "a".repeat(64), labels: { "paperclip-provider": "fake-plugin" },
      };
      const observed = { ...cleanup, observedProviderLeaseId: "verified-provider-id" };
      const failure = Object.assign(new Error("Creation uncertain"), {
        data: { schema: "paperclip/environment-creation-cleanup/v1", cleanup },
      });
      let injected = false;
      let deleted = false;
      const call = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") throw failure;
        if (method !== "environmentDestroyLease") throw new Error(`Unexpected ${method}`);
        const evidence = (params.leaseMetadata as { failedCreateCleanup: typeof observed }).failedCreateCleanup;
        if (!evidence.observedProviderLeaseId) {
          expect(deleted).toBe(false);
          if (!injected && fault === "observation response lost") {
            injected = true;
            throw new Error("Lost observation response");
          }
          if (!injected && fault === "foreign observation") {
            injected = true;
            throw Object.assign(new Error("Foreign observation"), {
              data: { schema: "paperclip/environment-creation-cleanup/v1", cleanup: { ...observed, companyId: "another-company" } },
            });
          }
          if (!injected && fault === "journal write failed") {
            injected = true;
            vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("Database unavailable"));
          }
          throw Object.assign(new Error("Persist observed sandbox identity before cleanup"), {
            data: { schema: "paperclip/environment-creation-cleanup/v1", cleanup: observed },
          });
        }
        const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, cleanup.providerLeaseId));
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toMatchObject({ failedCreateCleanup: observed });
        if (!deleted) {
          deleted = true;
          if (fault === "deleted receipt lost") throw new Error("Deletion succeeded but reply lost");
        }
        return { providerLeaseId: cleanup.providerLeaseId, state: "destroyed" };
      });
      const worker = { isRunning: () => true, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }), call } as unknown as PluginWorkerManager;
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
      const pending = await environmentService(db).insertPendingCleanupLease({
        companyId: seeded.companyId, environmentId: seeded.environment.id, heartbeatRunId: seeded.runId,
        provider: "fake-plugin", providerLeaseId: cleanup.providerLeaseId,
        metadata: { ...seeded.environment.config, driver: "sandbox", pluginId: seeded.pluginId, sandboxProviderPlugin: true, failedCreateCleanup: cleanup },
        failureReason: "interrupted_sandbox_creation",
      });
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: pending }).catch(() => {});
      const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, cleanup.providerLeaseId));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("pending_cleanup");
      expect(deleted).toBe(fault === "deleted receipt lost");
      const restarted = environmentRuntimeService(db, { pluginWorkerManager: worker });
      await expect(restarted.retryPendingSandboxTeardown({ environment: null, lease: (await environmentService(db).getLeaseById(rows[0]!.id))! })).resolves.toEqual({ providerLeaseId: cleanup.providerLeaseId, state: "destroyed" });
      expect(deleted).toBe(true);
    },
  );

  it("resumes the same provider lease on the next per-turn run", async () => {
    const seeded = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === seeded.pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-exact-resume",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentStopLease") return { providerLeaseId: "sandbox-exact-resume", state: "stopped" };
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "sandbox-exact-resume",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method during exact resume: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentStopLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const first = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId,
      environment: seeded.environment,
      issueId: null,
      agentId: seeded.agentId,
      heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: {
        id: seeded.executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    const workspaceSyncStamp = {
      schema: "paperclip.native-workspace-stamp/v1",
      workspaceId: seeded.executionWorkspaceId,
      providerLeaseId: "sandbox-exact-resume",
      remoteCwd: "/workspace",
      hostSha256: "a".repeat(64),
      finalizedRunId: seeded.runId,
    };
    await environmentService(db).updateLeaseMetadata(first.lease.id, {
      ...(first.lease.metadata ?? {}),
      nativeWorkspaceSync: workspaceSyncStamp,
    });
    await runtimeWithPlugin.releaseRunLeases(
      seeded.runId,
      "released",
      undefined,
      "stop_and_retain",
    );

    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: nextRunId,
      companyId: seeded.companyId,
      agentId: seeded.agentId,
      invocationSource: "manual",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId,
      environment: seeded.environment,
      issueId: null,
      agentId: seeded.agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: seeded.executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(first.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "created" });
    expect(acquired.lease.providerLeaseId).toBe("sandbox-exact-resume");
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({
      outcome: "resumed",
    });
    expect(acquired.lease.metadata?.nativeWorkspaceSync).toEqual(
      workspaceSyncStamp,
    );
    await expect(
      environmentService(db).getLeaseById(first.lease.id),
    ).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
    expect(
      vi.mocked(workerManager.call).mock.calls.filter(
        (call) => call[1] === "environmentAcquireLease",
      ),
    ).toHaveLength(1);
  });

  it("reacquires one provider lease row idempotently during same-run recovery", async () => {
    const seeded = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === seeded.pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: seeded.reusableLease.providerLeaseId,
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(
          `Unexpected plugin method during same-run reacquisition: ${method}`,
        );
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });

    const reacquired = await runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId,
      environment: seeded.environment,
      issueId: null,
      agentId: seeded.agentId,
      heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: {
        id: seeded.executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(reacquired.lease).toMatchObject({
      id: seeded.reusableLease.id,
      heartbeatRunId: seeded.runId,
      providerLeaseId: seeded.reusableLease.providerLeaseId,
      status: "active",
      cleanupStatus: null,
    });
    const rows = await environmentService(db).listLeases(seeded.environment.id);
    expect(
      rows.filter(
        (lease) =>
          lease.heartbeatRunId === seeded.runId &&
          lease.providerLeaseId === seeded.reusableLease.providerLeaseId,
      ),
    ).toHaveLength(1);
    expect(workerManager.call).toHaveBeenCalledWith(
      seeded.pluginId,
      "environmentResumeLease",
      expect.objectContaining({
        providerLeaseId: seeded.reusableLease.providerLeaseId,
      }),
      expect.any(Number),
    );
  });

  it("destroys a disposable paperclip_runner sandbox after the turn", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") return undefined;
        throw new Error(`Unexpected plugin method while destroying lease: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "released",
      undefined,
      "destroy",
    );

    expect(released[0]?.lease).toMatchObject({
      id: reusableLease.id,
      status: "expired",
    });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({ providerLeaseId: reusableLease.providerLeaseId }),
      expect.any(Number),
    );
  });

  it("does not destroy native sandbox state when its verified backup is missing", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    await environmentService(db).updateLeaseMetadata(reusableLease.id, {
      ...(reusableLease.metadata ?? {}),
      reusableSandboxLease: {
        ...((reusableLease.metadata?.reusableSandboxLease as Record<
          string,
          unknown
        >) ?? {}),
        adapterType: "paperclip_runner",
      },
      sandboxLeaseAcquisition: { outcome: "created" },
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Provider teardown must not run without a backup: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const errors: unknown[] = [];

    const released = await runtimeWithPlugin.releaseRunLeases(
      runId,
      "released",
      (_leaseId, error) => errors.push(error),
      "destroy",
    );

    expect(released).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("runner_harness_backup_unavailable");
    expect(workerManager.call).not.toHaveBeenCalled();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  it("acquires and releases a projectless local run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment();

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.executionWorkspaceId).toBeNull();
    expect(acquired.lease.metadata).toMatchObject({
      driver: "local",
      executionWorkspaceMode: null,
    });
    expect(acquired.leaseContext).toEqual({
      executionWorkspaceId: null,
      executionWorkspaceMode: null,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("local");
    expect(released[0]?.lease.status).toBe("released");

    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, acquired.lease.id));
    expect(rows[0]?.status).toBe("released");
  });

  it("rejects truly unsupported drivers before acquiring a lease", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteWorkspacePath: "/srv/paperclip/workspace",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
    });
    const runtimeWithoutSsh = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async () => {
            throw new Error("should not acquire");
          },
          releaseRunLease: async () => null,
          resolveCapabilities: async () => classifyEnvironmentCapabilities({ supportedCapabilities: new Set() }),
        },
      ],
    });

    await expect(
      runtimeWithoutSsh.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      }),
    ).rejects.toThrow('Environment driver "ssh" is not registered in the environment runtime yet.');

    const rows = await db.select().from(environmentLeases);
    expect(rows).toHaveLength(0);
  });

  it("acquires and releases an SSH run lease through the runtime seam", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(
        `Skipping SSH runtime fixture test: ${sshFixtureSupport.reason ?? "unsupported environment"}`,
      );
      return;
    }

    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-environment-runtime-ssh-"));
    fixtureRoots.push(fixtureRoot);
    const statePath = path.join(fixtureRoot, "state.json");
    const fixture = await startSshEnvLabFixture({ statePath });
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "ssh",
      name: "Fixture SSH",
      config: { ...sshConfig },
    });
    try {
      const acquired = await runtime.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      });

      expect(acquired.lease.status).toBe("active");
      expect(acquired.lease.providerLeaseId).toContain(`ssh://${sshConfig.username}@${sshConfig.host}:${sshConfig.port}`);
      expect(acquired.lease.metadata).toMatchObject({
        driver: "ssh",
        host: sshConfig.host,
        port: sshConfig.port,
        username: sshConfig.username,
        remoteWorkspacePath: sshConfig.remoteWorkspacePath,
        remoteCwd: sshConfig.remoteWorkspacePath,
      });

      const released = await runtime.releaseRunLeases(runId);

      expect(released).toHaveLength(1);
      expect(released[0]?.environment.driver).toBe("ssh");
      expect(released[0]?.lease.status).toBe("released");
    } finally {
    }
  });

  it("acquires and releases a fake sandbox run lease through the runtime seam", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.status).toBe("active");
    expect(acquired.lease.providerLeaseId).toMatch(new RegExp(`^sandbox://fake/${runId}/[0-9a-f-]{36}$`));
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(acquired.lease.metadata).toMatchObject({
      driver: "sandbox",
      provider: "fake",
      image: "ubuntu:24.04",
      reuseLease: true,
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.environment.driver).toBe("sandbox");
    expect(released[0]?.lease.status).toBe("released");
  });

  it.each([false, true])("confirms a built-in fake stop without release or destroy fallback: cancel=%s", async cancel => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox", config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const acquired = await runtime.acquireRunLease({ companyId, environment, issueId: null,
      heartbeatRunId: runId, persistedExecutionWorkspace: null });
    const provider = sandboxProviderRuntime.requireSandboxProvider("fake");
    const release = vi.spyOn(provider, "releaseLease"), destroy = vi.spyOn(provider, "destroyLease");
    const released = await runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain", cancel);
    expect(released).toHaveLength(1);
    expect(released[0]?.lease).toMatchObject({ status: "released", cleanupStatus: "success", failureReason: null,
      metadata: { remoteExecutionTermination: { state: "stopped", providerLeaseId: acquired.lease.providerLeaseId },
        sandboxStopAndRetainReceipt: { method: "builtin.stopLease", builtinProvider: "fake", runId } } });
    expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(true);
    expect(release).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("settles a built-in stop whose provider reports the sandbox gone, without claiming retained files", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox", config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const acquired = await runtime.acquireRunLease({ companyId, environment, issueId: null,
      heartbeatRunId: runId, persistedExecutionWorkspace: null });
    const provider = sandboxProviderRuntime.requireSandboxProvider("fake"), originalStop = provider.stopLease!;
    const destroy = vi.spyOn(provider, "destroyLease");
    try {
      provider.stopLease = vi.fn(async () => ({ providerLeaseId: acquired.lease.providerLeaseId!, state: "destroyed" })) as never;
      await runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain", true);
      const settled = (await environmentService(db).getLeaseById(acquired.lease.id))!;
      expect(settled).toMatchObject({ status: "released", cleanupStatus: "success", failureReason: "workspace_source_unavailable",
        metadata: { remoteExecutionTermination: { state: "destroyed", providerLeaseId: acquired.lease.providerLeaseId } } });
      expect(settled.metadata).not.toHaveProperty("sandboxStopAndRetainReceipt");
      expect(settled.metadata).not.toHaveProperty("sandboxStopAndRetain");
      expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(true);
      expect(destroy).not.toHaveBeenCalled();
    } finally { provider.stopLease = originalStop; }
  });

  it.each(["stop_failed", "wrong_receipt", "missing_capability", "changed_binding"])(
    "preserves a built-in stop through restart without destructive fallback: %s", async outcome => {
      const { companyId, environment, runId } = await seedEnvironment({
        driver: "sandbox", config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
      });
      const acquired = await runtime.acquireRunLease({ companyId, environment, issueId: null,
        heartbeatRunId: runId, persistedExecutionWorkspace: null });
      const provider = sandboxProviderRuntime.requireSandboxProvider("fake"), originalStop = provider.stopLease!;
      const release = vi.spyOn(provider, "releaseLease"), destroy = vi.spyOn(provider, "destroyLease");
      try {
        provider.stopLease = outcome === "missing_capability" ? undefined : vi.fn(async () => {
          if (outcome === "wrong_receipt") return { providerLeaseId: "sandbox://fake/other", state: "stopped" as const };
          throw new Error("injected built-in stop failure");
        });
        await runtime.releaseRunLeases(runId, "released", undefined, "stop_and_retain", true);
        expect(await environmentService(db).getLeaseById(acquired.lease.id)).toMatchObject({ status: "pending_cleanup" });
        expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(false);
        if (outcome === "missing_capability") {
          await heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) }).sweepPendingCleanupLeases({ backoffMs: 0 });
          expect(await environmentService(db).getLeaseById(acquired.lease.id)).toMatchObject({ status: "pending_cleanup" });
        }
        const stop = vi.fn(originalStop.bind(provider));
        provider.stopLease = stop;
        if (outcome === "changed_binding") await db.update(environmentLeases).set({ providerLeaseId: "sandbox://fake/replacement" })
          .where(eq(environmentLeases.id, acquired.lease.id));
        await heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) }).sweepPendingCleanupLeases({ backoffMs: 0 });
        if (outcome === "changed_binding") {
          expect(stop).not.toHaveBeenCalled();
          expect(await environmentService(db).getLeaseById(acquired.lease.id)).toMatchObject({ status: "pending_cleanup" });
        } else {
          expect(stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ providerLeaseId: acquired.lease.providerLeaseId }));
          expect(await environmentService(db).getLeaseById(acquired.lease.id)).toMatchObject({ status: "released", cleanupStatus: "success" });
          expect(await remoteExecutionHasStopped(db, companyId, runId)).toBe(true);
        }
        expect(release).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
      } finally { provider.stopLease = originalStop; }
    },
  );

  it("ingests a replacement orphan appended after startup without duplicate concurrent cleanup", async () => {
    const {companyId,environment,runId}=await seedEnvironment({driver:"sandbox",name:"Late plugin orphan",config:{provider:"fake",image:"ubuntu:24.04",reuseLease:false}});
    let release!:()=>void,entered!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const realEnvironmentService=environmentsModule.environmentService;
    const factory=vi.spyOn(environmentsModule,"environmentService").mockImplementation(database=>{
      const real=realEnvironmentService(database);
      return {...real,insertPendingCleanupLease:async input=>{entered();await pending;return real.insertPendingCleanupLease(input);}};
    });
    try {
      const spool=createSandboxOrphanCleanupSpool(process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR!);
      const active=environmentRuntimeService(db,{orphanCleanupSpool:spool});
      expect(await active.flushDeferredOrphanCleanups()).toEqual({recovered:0,pending:0});
      const record={companyId,environmentId:environment.id,executionWorkspaceId:null,issueId:null,heartbeatRunId:runId,
        provider:"plugin:fixture:tasks",providerLeaseId:"late-task",metadata:{driver:"plugin",runnerTaskDispatched:false}};
      expect(await spool.append(record)).toBe(true);
      const first=active.flushDeferredOrphanCleanups();await started;
      const second=active.flushDeferredOrphanCleanups();
      release();
      expect(await first).toEqual({recovered:1,pending:0});
      expect(await second).toEqual({recovered:1,pending:0});
      expect(await spool.load()).toEqual([]);
      expect(await active.flushDeferredOrphanCleanups()).toEqual({recovered:0,pending:0});
      const rows=await db.select().from(environmentLeases).where(eq(environmentLeases.environmentId,environment.id));
      expect(rows).toEqual([expect.objectContaining({providerLeaseId:"late-task",status:"pending_cleanup"})]);
    } finally {release();factory.mockRestore();}
  });

  it("records the orphan directly in the pending_cleanup state with one atomic insert", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Atomic Pending Cleanup Insert",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });

    const lease = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake",
      providerLeaseId: "sandbox://fake/atomic-orphan",
      metadata: { provider: "fake", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });

    // The returned lease is already in the terminal recovery state. It never
    // passes through the `active` state, so a crash cannot strand the orphan.
    expect(lease.status).toBe("pending_cleanup");
    expect(lease.cleanupStatus).toBe("failed");
    expect(lease.leasePolicy).toBe("ephemeral");
    expect(lease.failureReason).toBe("acquire_rejected_teardown_failed");
    expect(lease.providerLeaseId).toBe("sandbox://fake/atomic-orphan");
    expect(lease.releasedAt).not.toBeNull();

    // One insert created exactly one row, and the sweep reads that row directly.
    const rows = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.environmentId, environment.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending_cleanup");
    expect(rows[0]?.cleanupStatus).toBe("failed");
  });

  it("tears the recorded built-in provider lease down for a pending-cleanup orphan", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Retry Built-in",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Retry Built-in",
      issuePrefix: "OTE",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertForeignCompanyEnvironmentBinding(otherCompanyId, environment);

    // The first teardown fails, so the acquire records a pending-cleanup orphan.
    // The sweep then retries the teardown, which succeeds this time.
    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValueOnce(new Error("teardown failed"))
      .mockResolvedValue(undefined);
    try {
      const pending = await environmentService(db).insertPendingCleanupLease({
        companyId, environmentId: environment.id, heartbeatRunId: runId, provider: "fake", providerLeaseId: `sandbox://fake/${runId}`,
        metadata: { ...environment.config, driver: "sandbox" }, failureReason: "interrupted_sandbox_creation",
      });
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: pending }).catch(() => {});

      const orphan = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id))
        .then((r) => r[0]!);
      expect(orphan.status).toBe("pending_cleanup");
      const providerLeaseId = orphan.providerLeaseId;

      // The teardown accepts a null environment and reads the recorded provider
      // lease, so a delete or a provider change never strands it.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      // The retry called the provider teardown a second time with the orphan
      // provider lease id.
      expect(destroySpy).toHaveBeenCalledTimes(2);
      expect(destroySpy).toHaveBeenLastCalledWith(expect.objectContaining({ providerLeaseId }));
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("throws and keeps the pending-cleanup orphan when the teardown retry fails", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Retry Scope",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Retry Scope",
      issuePrefix: "OTF",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertForeignCompanyEnvironmentBinding(otherCompanyId, environment);

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValue(new Error("teardown failed"));
    try {
      const pending = await environmentService(db).insertPendingCleanupLease({
        companyId, environmentId: environment.id, heartbeatRunId: runId, provider: "fake", providerLeaseId: `sandbox://fake/${runId}`,
        metadata: { ...environment.config, driver: "sandbox" }, failureReason: "interrupted_sandbox_creation",
      });
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: pending }).catch(() => {});

      const orphan = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id))
        .then((r) => r[0]!);
      expect(orphan.status).toBe("pending_cleanup");

      // The teardown retries, but the provider destroy still fails, so the
      // teardown throws. The caller keeps the orphan pending for a later sweep.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await expect(
        runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! }),
      ).rejects.toThrow();

      const still = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.id, orphan.id))
        .then((r) => r[0]!);
      expect(still.status).toBe("pending_cleanup");
      expect(still.cleanupStatus).toBe("failed");
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("tears the recorded provider down after the environment provider changes", async () => {
    // Ordering: an acquire provisions a sandbox with provider A, the lease
    // insert rejects a foreign-company binding, and the compensating teardown
    // fails, so the acquire records an orphan for provider A. A provider change
    // then re-points the environment before the sweep runs. The sweep must tear
    // the orphan down from the recorded provider metadata, not the current
    // environment provider, so the change cannot strand the teardown.
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Provider Change Vs Orphan",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Provider Change",
      issuePrefix: "OTP",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertForeignCompanyEnvironmentBinding(otherCompanyId, environment);

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockRejectedValueOnce(new Error("teardown failed"))
      .mockResolvedValue(undefined);
    try {
      const pending = await environmentService(db).insertPendingCleanupLease({
        companyId, environmentId: environment.id, heartbeatRunId: runId, provider: "fake", providerLeaseId: `sandbox://fake/${runId}`,
        metadata: { ...environment.config, driver: "sandbox" }, failureReason: "interrupted_sandbox_creation",
      });
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: pending }).catch(() => {});

      const orphan = await db
        .select()
        .from(environmentLeases)
        .where(eq(environmentLeases.environmentId, environment.id))
        .then((r) => r[0]!);
      expect(orphan.status).toBe("pending_cleanup");
      expect(orphan.provider).toBe("fake");
      const providerLeaseId = orphan.providerLeaseId;

      // The provider-target mutation re-points the environment to a different
      // driver. The orphan teardown must not depend on this current config.
      await environmentService(db).update(environment.id, { driver: "local", config: {} });

      // The teardown tears the recorded provider lease down, so it never reads
      // the re-pointed environment provider.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      expect(destroySpy).toHaveBeenLastCalledWith(expect.objectContaining({ providerLeaseId }));
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("reports the plugin cleanup worker not ready while its worker is down, then ready after it recovers", async () => {
    // A pending_cleanup orphan targets a plugin-backed provider. The sweep must
    // not consume a finite retry attempt while the plugin worker is briefly down.
    // So the readiness probe reports "not ready" for a down worker and "ready"
    // after the worker recovers. A built-in provider has no worker, so it is
    // always ready.
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Worker Readiness",
      config: { provider: "fake-plugin-ready", image: "fake:test", reuseLease: false },
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "paperclip.fake-plugin-ready-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-ready-sandbox",
      displayName: "Fake Plugin Ready Sandbox Provider",
      description: "Test fake plugin provider readiness",
      environmentDrivers: [
        {
          driverKey: "fake-plugin-ready",
          kind: "sandbox_provider",
          displayName: "Fake Plugin Ready",
          configSchema: { type: "object" },
        },
      ],
    });

    // The worker is down at first, then recovers on the second probe.
    let workerRunning = false;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId && workerRunning),
      call: vi.fn(async () => {
        throw new Error("call must not run during a readiness probe");
      }),
    } as unknown as PluginWorkerManager;

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake-plugin-ready",
      providerLeaseId: "plugin-lease-readiness",
      metadata: { provider: "fake-plugin-ready", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const lease = (await environmentService(db).getLeaseById(orphan.id))!;

    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // A down plugin worker is the transient restart window, so the probe reports
    // not ready. The sweep skips the lease without a claim, so no attempt burns.
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(false);
    // The probe never calls the worker; it only checks the live worker state.
    expect((workerManager.call as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // The worker recovers, so the probe now reports ready and the sweep proceeds.
    workerRunning = true;
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(true);

    // A built-in provider has no plugin worker, so its orphan is always ready.
    const builtinOrphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake",
      providerLeaseId: "builtin-lease-readiness",
      metadata: { provider: "fake", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const builtinLease = (await environmentService(db).getLeaseById(builtinOrphan.id))!;
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease: builtinLease }),
    ).resolves.toBe(true);
  });

  it("probes the plugin that recorded a failed creation when two plugins share its provider key", async () => {
    // An interactive setup can create its sandbox through the second of two
    // plugins with the same provider key, while the first is disabled. The
    // cleanup must follow the recorded plugin, not the first one with the key.
    const disabledPluginId = randomUUID();
    const creatorPluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Shared Provider Key Cleanup",
      config: { provider: "fake-plugin-shared", image: "fake:test", reuseLease: false },
    });
    const sharedDriver = [{ driverKey: "fake-plugin-shared", kind: "sandbox_provider", displayName: "Fake Shared", configSchema: { type: "object" } }];
    await insertSandboxProviderPlugin(disabledPluginId, {
      pluginKey: "paperclip.fake-shared-disabled", packageName: "@paperclipai/plugin-fake-shared-disabled",
      environmentDrivers: sharedDriver, status: "disabled", installOrder: 1,
    });
    await insertSandboxProviderPlugin(creatorPluginId, {
      pluginKey: "paperclip.fake-shared-creator", packageName: "@paperclipai/plugin-fake-shared-creator",
      environmentDrivers: sharedDriver, status: "ready", installOrder: 2,
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === creatorPluginId),
      call: vi.fn(async () => {
        throw new Error("call must not run during a readiness probe");
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const insertOrphan = async (providerLeaseId: string, metadata: Record<string, unknown>) => {
      const orphan = await environmentService(db).insertPendingCleanupLease({
        companyId, environmentId: environment.id, executionWorkspaceId: null, issueId: null, heartbeatRunId: runId,
        provider: "fake-plugin-shared", providerLeaseId,
        metadata: { provider: "fake-plugin-shared", driver: "sandbox", reuseLease: false, ...metadata },
        failureReason: "interrupted_setup_creation",
      });
      return (await environmentService(db).getLeaseById(orphan.id))!;
    };

    const setupLease = await insertOrphan("paperclip-create-shared", {
      pluginId: creatorPluginId,
      failedCreateCleanup: {
        providerLeaseId: "paperclip-create-shared", companyId, environmentId: environment.id,
        attemptId: "attempt-shared", accountFingerprint: "account-shared", labels: {},
      },
    });
    await expect(runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease: setupLease })).resolves.toBe(true);

    // The pinned plugin's worker is down: a transient window, not ready.
    (workerManager.isRunning as ReturnType<typeof vi.fn>).mockReturnValue(false);
    await expect(runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease: setupLease })).resolves.toBe(false);
    expect((workerManager.call as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("reports the plugin cleanup provider not ready while the plugin is not ready, then ready after it recovers", async () => {
    // A pending_cleanup orphan targets a plugin-backed provider. A plugin reload
    // or a plugin reinstall moves the plugin through a "not ready" status. The
    // sweep must not consume a finite retry attempt in that transient window. So
    // the readiness probe reports "not ready" while the plugin status is not
    // "ready", even when its worker runs, and "ready" after the plugin recovers.
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Plugin Readiness",
      config: { provider: "fake-plugin-reload", image: "fake:test", reuseLease: false },
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "paperclip.fake-plugin-reload-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-reload-sandbox",
      displayName: "Fake Plugin Reload Sandbox Provider",
      description: "Test fake plugin provider reload readiness",
      environmentDrivers: [
        {
          driverKey: "fake-plugin-reload",
          kind: "sandbox_provider",
          displayName: "Fake Plugin Reload",
          configSchema: { type: "object" },
        },
      ],
      status: "installing",
    });

    // The worker runs the whole time, so the probe result depends on the plugin
    // status alone, not on a down worker.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => {
        throw new Error("call must not run during a readiness probe");
      }),
    } as unknown as PluginWorkerManager;

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake-plugin-reload",
      providerLeaseId: "plugin-lease-reload",
      metadata: { provider: "fake-plugin-reload", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const lease = (await environmentService(db).getLeaseById(orphan.id))!;

    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // A not-ready plugin is the transient reload window, so the probe reports
    // not ready. The sweep skips the lease without a claim, so no attempt burns.
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(false);
    expect((workerManager.call as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // The plugin becomes ready, so the probe now reports ready and the sweep
    // proceeds.
    await db.update(plugins).set({ status: "ready" }).where(eq(plugins.id, pluginId));
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(true);
  });

  it("reports the plugin cleanup provider not ready while the plugin is missing, then ready after it returns", async () => {
    // A pending_cleanup orphan targets a plugin-backed provider whose plugin row
    // is gone. A plugin reinstall removes and re-adds the plugin row, so the row
    // is missing for a short window. The sweep must not consume a finite retry
    // attempt in that window. So the readiness probe reports "not ready" while no
    // plugin row resolves the provider, and "ready" after the plugin returns.
    const pluginId = randomUUID();
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Cleanup Plugin Missing",
      config: { provider: "fake-plugin-missing", image: "fake:test", reuseLease: false },
    });

    // The worker manager reports the plugin worker as running, so the probe
    // result depends on the missing plugin row alone, not on a down worker.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => {
        throw new Error("call must not run during a readiness probe");
      }),
    } as unknown as PluginWorkerManager;

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: null,
      issueId: null,
      heartbeatRunId: runId,
      provider: "fake-plugin-missing",
      providerLeaseId: "plugin-lease-missing",
      metadata: { provider: "fake-plugin-missing", driver: "sandbox", reuseLease: false },
      failureReason: "acquire_rejected_teardown_failed",
    });
    const lease = (await environmentService(db).getLeaseById(orphan.id))!;

    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // No plugin row resolves the provider, so the probe reports not ready. The
    // sweep skips the lease without a claim, so no attempt burns while the plugin
    // reinstall is in flight.
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(false);
    expect((workerManager.call as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();

    // The plugin reinstall completes, so a ready plugin row now resolves the
    // provider and the probe reports ready.
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "paperclip.fake-plugin-missing-sandbox-provider",
      packageName: "@paperclipai/plugin-fake-missing-sandbox",
      displayName: "Fake Plugin Missing Sandbox Provider",
      description: "Test fake plugin provider missing readiness",
      environmentDrivers: [
        {
          driverKey: "fake-plugin-missing",
          kind: "sandbox_provider",
          displayName: "Fake Plugin Missing",
          configSchema: { type: "object" },
        },
      ],
    });
    await expect(
      runtimeWithPlugin.isPendingCleanupWorkerReady({ environment, lease }),
    ).resolves.toBe(true);
  });

  it("records an orphan with a null reference when a delete already removed the environment", async () => {
    // Ordering: a delete removes the environment before the acquire records the
    // orphan. The environment foreign key must not fail the insert. The record
    // persists with a null reference and its immutable provider metadata, so a
    // later sweep still tears the orphan down.
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Delete Before Orphan Record",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });

    // Remove the environment row first, so the record happens after the delete.
    await environmentService(db).remove(environment.id);

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: "fake",
      providerLeaseId: "sandbox://fake/delete-before-record",
      metadata: { provider: "fake", image: "ubuntu:24.04", driver: "sandbox" },
      failureReason: "acquire_rejected_teardown_failed",
    });
    // The insert kept no environment reference, so the delete did not fail it.
    expect(orphan.environmentId).toBeNull();
    expect(orphan.status).toBe("pending_cleanup");

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockResolvedValue(undefined);
    try {
      // The recorded metadata drives the teardown, so a null environment tears
      // the orphan down.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ providerLeaseId: "sandbox://fake/delete-before-record" }),
      );
    } finally {
      destroySpy.mockRestore();
    }
  });

  it("keeps the orphan and tears it down after the environment is deleted", async () => {
    // Ordering: an orphan is recorded, then the environment is deleted. The
    // foreign key sets the reference null instead of cascading the row away, so
    // the orphan survives. The sweep tears it down from the recorded metadata.
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Delete After Orphan Record",
      config: { provider: "fake", image: "ubuntu:24.04", reuseLease: false },
    });

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: "fake",
      providerLeaseId: "sandbox://fake/delete-after-record",
      metadata: { provider: "fake", image: "ubuntu:24.04", driver: "sandbox" },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBe(environment.id);

    // Delete the environment row directly. The foreign key sets the lease
    // reference null, so the orphan survives instead of being cascaded away.
    await environmentService(db).remove(environment.id);
    const survived = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, orphan.id))
      .then((r) => r[0]!);
    expect(survived.environmentId).toBeNull();
    expect(survived.status).toBe("pending_cleanup");

    const destroySpy = vi
      .spyOn(sandboxProviderRuntime, "destroySandboxProviderLease")
      .mockResolvedValue(undefined);
    try {
      // The recorded metadata drives the teardown, so a null environment tears
      // the orphan down after the delete set the reference null.
      const lease = await environmentService(db).getLeaseById(orphan.id);
      await runtime.retryPendingSandboxTeardown({ environment: null, lease: lease! });
      expect(destroySpy).toHaveBeenCalledWith(
        expect.objectContaining({ providerLeaseId: "sandbox://fake/delete-after-record" }),
      );
    } finally {
      destroySpy.mockRestore();
    }
  });

  // A plugin provider whose config declares an `apiKey` secret-ref field. The
  // orphan teardown must resolve that recorded ref even when the environment
  // binding is gone, so these tests register a provider with a real secret-ref
  // field, unlike the plain `fake-plugin` tests above.
  const SECRET_REF_PLUGIN_KEY = "paperclip.secret-plugin-sandbox-provider";
  const SECRET_REF_PROVIDER = "secret-plugin";

  async function registerSecretRefPluginProvider(): Promise<string> {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: SECRET_REF_PLUGIN_KEY,
      packageName: "@paperclipai/plugin-secret-sandbox",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: SECRET_REF_PLUGIN_KEY,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Secret Plugin Sandbox Provider",
        description: "Test plugin provider with a secret-ref config field",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["environment.drivers.register"],
        entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [
          {
            driverKey: SECRET_REF_PROVIDER,
            kind: "sandbox_provider",
            displayName: "Secret Plugin",
            configSchema: {
              type: "object",
              properties: {
                apiKey: { type: "string", format: "secret-ref" },
              },
            },
          },
        ],
      },
      status: "ready",
      installOrder: 1,
      updatedAt: new Date(),
    } as any);
    return pluginId;
  }

  // A worker manager mock that records the config of each destroy call, so a
  // test can assert the resolved API key reached the provider teardown.
  function createDestroyRecordingWorkerManager(pluginId: string): {
    workerManager: PluginWorkerManager;
    destroyConfigs: Array<Record<string, unknown> | undefined>;
  } {
    const destroyConfigs: Array<Record<string, unknown> | undefined> = [];
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, args: any) => {
        if (method === "environmentDestroyLease") {
          destroyConfigs.push(args?.config as Record<string, unknown> | undefined);
          return {};
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    return { workerManager, destroyConfigs };
  }

  async function createApiKeySecret(companyId: string, value: string): Promise<string> {
    const secret = await secretService(db).create(companyId, {
      name: `sandbox-cleanup-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value,
    });
    return secret.id;
  }

  it("tears down a secret-backed plugin orphan when a delete already removed the environment", async () => {
    // Ordering: a delete removed the environment (and its secret binding) before
    // the acquire recorded the orphan. The recorded config keeps the API-key
    // secret ref, so the teardown must resolve it without the environment
    // binding and send the resolved value to the provider destroy call.
    const pluginId = await registerSecretRefPluginProvider();
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Secret Plugin Delete Before Record",
      config: { provider: SECRET_REF_PROVIDER, reuseLease: false },
    });
    const secretId = await createApiKeySecret(companyId, "old-provider-api-key");
    await secretService(db).createBinding({
      companyId,
      secretId,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });

    // Remove the environment first, so the record happens after the delete.
    await environmentService(db).remove(environment.id);

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: SECRET_REF_PROVIDER,
      providerLeaseId: "secret-plugin-lease-delete-before",
      metadata: {
        provider: SECRET_REF_PROVIDER,
        driver: "sandbox",
        sandboxProviderPlugin: true,
        pluginId,
        pluginKey: SECRET_REF_PLUGIN_KEY,
        apiKey: secretId,
        reuseLease: false,
      },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBeNull();
    expect(orphan.status).toBe("pending_cleanup");

    const { workerManager, destroyConfigs } = createDestroyRecordingWorkerManager(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const lease = await environmentService(db).getLeaseById(orphan.id);
    vi.mocked(workerManager.call).mockImplementationOnce(async (_pluginId, _method, args: any) => {
      destroyConfigs.push(args.config);
      return { providerLeaseId: args.providerLeaseId, state: "destroyed" };
    });
    await expect(runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! }))
      .resolves.toEqual({ providerLeaseId: orphan.providerLeaseId, state: "destroyed" });
    expect(destroyConfigs).toHaveLength(1);
    // The recorded secret ref resolved to the old credential, and the resolved
    // value reached the provider teardown instead of the secret ref.
    expect(destroyConfigs[0]).toMatchObject({ apiKey: "old-provider-api-key" });
    expect(destroyConfigs[0]?.apiKey).not.toBe(secretId);
  });

  it("tears down a secret-backed plugin orphan after the environment is deleted", async () => {
    // Ordering: the orphan is recorded, then a delete removes the environment.
    // The foreign key sets the lease reference null, so the orphan survives. The
    // teardown resolves the recorded API-key ref without the environment.
    const pluginId = await registerSecretRefPluginProvider();
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Secret Plugin Delete After Record",
      config: { provider: SECRET_REF_PROVIDER, reuseLease: false },
    });
    const secretId = await createApiKeySecret(companyId, "old-provider-api-key");
    await secretService(db).createBinding({
      companyId,
      secretId,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: SECRET_REF_PROVIDER,
      providerLeaseId: "secret-plugin-lease-delete-after",
      metadata: {
        provider: SECRET_REF_PROVIDER,
        driver: "sandbox",
        sandboxProviderPlugin: true,
        pluginId,
        pluginKey: SECRET_REF_PLUGIN_KEY,
        apiKey: secretId,
        reuseLease: false,
      },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBe(environment.id);

    // Delete the environment. The foreign key sets the lease reference null, so
    // the orphan survives and the current binding is gone.
    await environmentService(db).remove(environment.id);
    const survived = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, orphan.id))
      .then((r) => r[0]!);
    expect(survived.environmentId).toBeNull();

    const { workerManager, destroyConfigs } = createDestroyRecordingWorkerManager(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const lease = await environmentService(db).getLeaseById(orphan.id);
    await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! });
    expect(destroyConfigs).toHaveLength(1);
    expect(destroyConfigs[0]).toMatchObject({ apiKey: "old-provider-api-key" });
  });

  it("tears down a secret-backed plugin orphan with the recorded credential after the provider is reconfigured", async () => {
    // Ordering: the orphan is recorded for the old credential, then the
    // environment is reconfigured to a new credential. The environment binding
    // now points to a different secret at the same path. The teardown must
    // resolve the OLD recorded ref, not the new binding, so it destroys the
    // sandbox the old credential provisioned.
    const pluginId = await registerSecretRefPluginProvider();
    const { companyId, environment } = await seedEnvironment({
      driver: "sandbox",
      name: "Secret Plugin Reconfigured",
      config: { provider: SECRET_REF_PROVIDER, reuseLease: false },
    });
    const oldSecretId = await createApiKeySecret(companyId, "old-provider-api-key");

    const orphan = await environmentService(db).insertPendingCleanupLease({
      companyId,
      environmentId: environment.id,
      provider: SECRET_REF_PROVIDER,
      providerLeaseId: "secret-plugin-lease-reconfigured",
      metadata: {
        provider: SECRET_REF_PROVIDER,
        driver: "sandbox",
        sandboxProviderPlugin: true,
        pluginId,
        pluginKey: SECRET_REF_PLUGIN_KEY,
        apiKey: oldSecretId,
        reuseLease: false,
      },
      failureReason: "acquire_rejected_teardown_failed",
    });
    expect(orphan.environmentId).toBe(environment.id);

    // Reconfigure the environment: a new secret replaces the binding at the same
    // path. The old recorded ref is no longer bound to the environment.
    const newSecretId = await createApiKeySecret(companyId, "new-provider-api-key");
    await secretService(db).createBinding({
      companyId,
      secretId: newSecretId,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      config: { provider: SECRET_REF_PROVIDER, apiKey: newSecretId, reuseLease: false },
    });

    const { workerManager, destroyConfigs } = createDestroyRecordingWorkerManager(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const lease = await environmentService(db).getLeaseById(orphan.id);
    await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! });
    expect(destroyConfigs).toHaveLength(1);
    // The teardown resolved the OLD recorded credential, not the new binding.
    expect(destroyConfigs[0]).toMatchObject({ apiKey: "old-provider-api-key" });
    expect(destroyConfigs[0]?.apiKey).not.toBe("new-provider-api-key");

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
  });

  it("tears the recorded plugin provider lease down for a pending-cleanup orphan", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const pluginConfig = { provider: "fake-plugin", image: "fake:test", reuseLease: false };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Cleanup Retry Plugin",
      driver: "sandbox",
      config: pluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: pluginConfig,
    });
    await insertSandboxProviderPlugin(pluginId);
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co Retry Plugin",
      issuePrefix: "OTG",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertForeignCompanyEnvironmentBinding(otherCompanyId, environment);

    // The first destroy fails, so the acquire records a pending-cleanup orphan.
    // The sweep retries the destroy, which succeeds this time.
    let destroyAttempts = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentDestroyLease"] })),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-3",
            metadata: { provider: "fake-plugin", image: "fake:test", reuseLease: false },
          };
        }
        if (method === "environmentDestroyLease") {
          destroyAttempts += 1;
          if (destroyAttempts === 1) {
            throw new Error("destroy failed");
          }
          return {};
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

      const pending = await environmentService(db).insertPendingCleanupLease({
        companyId, environmentId: environment.id, heartbeatRunId: runId, provider: "fake-plugin", providerLeaseId: "plugin-lease-3",
        metadata: { ...pluginConfig, driver: "sandbox", pluginId, sandboxProviderPlugin: true }, failureReason: "interrupted_sandbox_creation",
      });
      await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: pending }).catch(() => {});

    const orphan = await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.environmentId, environment.id))
      .then((r) => r[0]!);
    expect(orphan.status).toBe("pending_cleanup");
    expect(orphan.providerLeaseId).toBe("plugin-lease-3");

    const lease = await environmentService(db).getLeaseById(orphan.id);
    await runtimeWithPlugin.retryPendingSandboxTeardown({ environment: null, lease: lease! });
    expect(destroyAttempts).toBe(2);
    const destroyCall = (workerManager.call as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter((callArgs) => callArgs[1] === "environmentDestroyLease")
      .at(-1);
    expect(destroyCall?.[2]).toMatchObject({ providerLeaseId: "plugin-lease-3" });

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
  });

  it("uses plugin-backed sandbox config for execute and release", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const fakePluginConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Fake Plugin Sandbox",
      driver: "sandbox",
      config: fakePluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: fakePluginConfig,
    });
    await insertSandboxProviderPlugin(pluginId);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config).toEqual(expect.objectContaining({
          image: "fake:test",
          timeoutMs: 1234,
          reuseLease: false,
        }));
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          expect(params.config).toEqual({
            image: "fake:test",
            timeoutMs: 1234,
            reuseLease: false,
          });
          expect(params.config).not.toHaveProperty("driver");
          expect(params.config).not.toHaveProperty("executionWorkspaceMode");
          expect(params.config).not.toHaveProperty("pluginId");
          expect(params.config).not.toHaveProperty("pluginKey");
          expect(params.config).not.toHaveProperty("providerMetadata");
          expect(params.config).not.toHaveProperty("provider");
          expect(params.config).not.toHaveProperty("sandboxProviderPlugin");
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      commandTimeoutMs: 900,
      forceSession: true,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    // The execute call carries the optional log sink as the fifth argument; it
    // is undefined when the caller passes no sink.
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      timeoutMs: 1000,
      commandTimeoutMs: 900,
      bypassSession: false,
    }), 31000, undefined);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.anything(), 31234);
  });

  // Build the fake plugin fixture for the run-parent release tests below. A
  // plugin sandbox provider can open a persistent session on the first command
  // and delete it on lease release; the delete emits a provider
  // `session.close` span. The host mints that span's parent from the active
  // step context at the release RPC. So the release must run under the run
  // parent, or the span loses its traceparent and the backend drops it.
  async function seedFakePluginSandbox() {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const fakePluginConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Fake Plugin Sandbox",
      driver: "sandbox",
      config: fakePluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: fakePluginConfig,
    });
    await insertSandboxProviderPlugin(pluginId);
    return { companyId, environment, runId, pluginId };
  }

  it("runs a plugin-backed lease release under the run-time exec parent, so the teardown span keeps a valid traceparent", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    // The active step context observed at the moment the host issues the release
    // RPC. The real worker manager mints the provider-span traceparent from
    // exactly this value, so a non-null context with a valid parent proves the
    // teardown span keeps a host-minted parent.
    let releaseStepContext = null as ReturnType<typeof getActiveStepContext>;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
        }
        if (method === "environmentReleaseLease") {
          releaseStepContext = getActiveStepContext();
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    // Build a real host run-parent context and run the first command under it,
    // exactly as the run drives an exec. The driver records this context for the
    // lease and replays it around the later release RPC.
    const runParent: StartupSpanContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
      isRemote: false,
    });
    await runWithRuntimeParent(runParent, () =>
      runtimeWithPlugin.execute({
        environment,
        lease: acquired.lease,
        command: "printf",
        args: ["ok"],
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
      }),
    );

    await environmentService(db).update(environment.id, { driver: "local", config: {} });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    // The release RPC ran under the recorded run parent, so the host mints a
    // valid W3C traceparent from it. A dropped span would show a null context.
    expect(releaseStepContext).not.toBeNull();
    expect(releaseStepContext?.parentContext).toBe(runParent);
    expect(traceparentFromContextToken(releaseStepContext?.parentContext)).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );
  });

  it("releases a plugin-backed lease with no active step context when the run drove no exec", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    let releaseStepContext = null as ReturnType<typeof getActiveStepContext>;
    let releaseCalled = false;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease") {
          releaseCalled = true;
          releaseStepContext = getActiveStepContext();
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    await environmentService(db).update(environment.id, { driver: "local", config: {} });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    // No command ran, so no session opened and no teardown span is emitted. The
    // release must not invent a parent from an unrelated ambient context; it
    // runs unwrapped, exactly as before the fix.
    expect(releaseCalled).toBe(true);
    expect(releaseStepContext).toBeNull();
  });

  it("forwards the bypassSession flag to the plugin execute RPC so a pre-run command skips the session", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    // Capture the params of each environmentExecute RPC, so the test can assert
    // the host forwards `bypassSession` to the provider unchanged.
    const executeParams: Array<Record<string, unknown>> = [];
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          executeParams.push(params);
          return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    // A pre-run command (the provision command) sets bypassSession explicitly.
    await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "bash",
      args: ["-lc", "true"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      bypassSession: true,
    });
    // An in-run command runs under the run-parent context, so the host does not
    // bypass the session and the provider opens/uses the session.
    const runParent: StartupSpanContext = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
      isRemote: false,
    });
    await runWithRuntimeParent(runParent, () =>
      runtimeWithPlugin.execute({
        environment,
        lease: acquired.lease,
        command: "printf",
        args: ["ok"],
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
      }),
    );

    expect(executeParams).toHaveLength(2);
    expect(executeParams[0]?.bypassSession).toBe(true);
    // An in-run command carries a run parent, so it does not bypass the session.
    expect(executeParams[1]?.bypassSession).toBe(false);
  });

  it("bypasses the session for a context-less command so the setup span keeps a run parent", async () => {
    const { companyId, environment, runId, pluginId } = await seedFakePluginSandbox();

    // Capture the params of each environmentExecute RPC, so the test can assert
    // the host derives `bypassSession` from the active run-parent context.
    const executeParams: Array<Record<string, unknown>> = [];
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          executeParams.push(params);
          return { exitCode: 0, signal: null, timedOut: false, stdout: "ok\n", stderr: "" };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    // A command with no active run-parent context (a pre-run install/probe or
    // the agent process launch) runs before the run trace is active. The host
    // mints no plugin RPC traceparent for it, so a session opened here would drop
    // its setup span. The host bypasses the session for such a command.
    await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "sh",
      args: ["-c", "command -v claude"],
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
    });

    expect(executeParams).toHaveLength(1);
    expect(executeParams[0]?.bypassSession).toBe(true);
  });

  it("builds the workspace-realization record with referenced sources for a plugin-backed sandbox realize", async () => {
    // A provider plugin realize handler returns only its realized cwd and provider metadata; it does
    // not build the workspace-realization record. The server must build that record from the run
    // request, so the referenced (mentioned) project sources reach the adapter through
    // `realization.additional`. Without the record the sandbox agent never receives the mentioned
    // projects. This test drives the plugin-backed sandbox realize path and asserts the referenced
    // source survives into the returned record.
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const fakePluginConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Fake Plugin Sandbox Realize",
      driver: "sandbox",
      config: fakePluginConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: fakePluginConfig,
    });
    await insertSandboxProviderPlugin(pluginId);
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-realize-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentRealizeWorkspace") {
          // Mimic a real provider (for example Daytona): return only the realized cwd and provider
          // metadata, never a `workspaceRealization` record.
          return {
            cwd: "/workspace/project",
            metadata: {
              provider: "fake-plugin",
              remoteCwd: "/workspace/project",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const workspaceRealizationRequest = createReferencedWorkspaceRealizationRequest(companyId, environment, runId);
    const realized = await runtimeWithPlugin.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/anchor",
        mode: "ephemeral",
        metadata: { workspaceRealizationRequest },
      },
    });

    // The provider realized cwd and provider metadata survive.
    expect(realized.cwd).toBe("/workspace/project");
    expect(realized.metadata?.provider).toBe("fake-plugin");
    // The server-built record carries the referenced source through `additional`, so the adapter can
    // stage the mentioned project into the sandbox.
    const realization = realized.metadata?.workspaceRealization as Record<string, unknown> | undefined;
    expect(realization).toBeDefined();
    expect(realization?.additional).toEqual([
      expect.objectContaining({
        path: "/tmp/referenced-project",
        projectId: "referenced-project-1",
      }),
    ]);
  });

  it("builds the workspace-realization record with referenced sources for a built-in sandbox realize", async () => {
    // The sandbox driver `realizeWorkspace` has two exits: a plugin-backed provider and a
    // built-in provider. Both must build the same workspace-realization record, so the
    // referenced (mentioned) project sources reach the adapter through `realization.additional`.
    // The test above covers the plugin exit. This test covers the built-in exit (no provider
    // plugin), so a regression on either exit fails a test.
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox Realize",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    const workspaceRealizationRequest = createReferencedWorkspaceRealizationRequest(companyId, environment, runId);
    const realized = await runtime.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/anchor",
        mode: "ephemeral",
        metadata: { workspaceRealizationRequest },
      },
    });

    // The built-in exit builds the record and carries the referenced source through `additional`,
    // so the adapter can stage the mentioned project into the sandbox.
    const realization = realized.metadata?.workspaceRealization as Record<string, unknown> | undefined;
    expect(realization).toBeDefined();
    expect(realization?.additional).toEqual([
      expect.objectContaining({
        path: "/tmp/referenced-project",
        projectId: "referenced-project-1",
      }),
    ]);
  });

  it("uses resolved secret-ref config for plugin-backed sandbox execute and release", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      displayName: "Secure Sandbox Provider",
      description: "Test schema-driven provider",
      environmentDrivers: [
        {
          driverKey: "secure-plugin",
          kind: "sandbox_provider",
          displayName: "Secure Sandbox",
          configSchema: {
            type: "object",
            properties: {
              template: { type: "string" },
              apiKey: { type: "string", format: "secret-ref" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        expect(params.config.apiKey).toBe("resolved-provider-key");
        expect(params.config).not.toHaveProperty("provider");
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "secure-plugin",
              template: "base",
              apiKey: "resolved-provider-key",
              timeoutMs: 1234,
              reuseLease: false,
              sandboxId: "sandbox-1",
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
          };
        }
        if (method === "environmentReleaseLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const operations = await db.select().from(sandboxCreationOperations).where(eq(sandboxCreationOperations.companyId, companyId));
    expect(JSON.stringify(operations)).not.toContain("resolved-provider-key");
    expect(operations[0]?.metadata.creationCredentialHashes).toEqual({
      apiKey: createHash("sha256").update("resolved-provider-key").digest("hex"),
    });
    expect(acquired.lease.metadata).toMatchObject({
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      sandboxId: "sandbox-1",
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "printf",
      args: ["ok"],
      cwd: "/workspace",
      env: {},
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });
    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(executed.stdout).toBe("ok\n");
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.status).toBe("released");
    // The execute call carries the optional log sink as the fifth argument; it
    // is undefined when the caller passes no sink.
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 31234, undefined);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", expect.objectContaining({
      config: expect.objectContaining({
        apiKey: "resolved-provider-key",
      }),
    }), 31234);
  });

  it("resolves persisted secret_ref binding objects in sandbox provider config at runtime", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: { type: "secret_ref", secretId: apiSecret.id, version: "latest" },
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      displayName: "Secure Sandbox Provider",
      description: "Test schema-driven provider",
      environmentDrivers: [
        {
          driverKey: "secure-plugin",
          kind: "sandbox_provider",
          displayName: "Secure Sandbox",
          configSchema: {
            type: "object",
            properties: {
              template: { type: "string" },
              apiKey: { type: "string", format: "secret-ref" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });

    const resolved = await resolveEnvironmentDriverConfigForRuntime(db, companyId, environment);

    expect(resolved.driver).toBe("sandbox");
    expect(resolved.config).toMatchObject({
      provider: "secure-plugin",
      template: "base",
      apiKey: "resolved-provider-key",
    });
  });

  it("waits briefly for a ready sandbox provider plugin worker to come online", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Eventually Running Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.eventually-running-sandbox-provider",
      packageName: "@acme/eventually-running-sandbox-provider",
      displayName: "Eventually Running Sandbox Provider",
      description: "Test plugin worker startup grace period",
      author: "Acme",
    });

    let runningChecks = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => {
        if (id !== pluginId) return false;
        runningChecks += 1;
        return runningChecks >= 3;
      }),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 25,
      pluginWorkerReadyPollMs: 1,
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.isRunning).toHaveBeenCalledTimes(3);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
  });

  it("throws a worker-not-running error once the readiness deadline is exhausted", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Never Running Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.never-running-sandbox-provider",
      packageName: "@acme/never-running-sandbox-provider",
      displayName: "Never Running Sandbox Provider",
      description: "Test plugin worker that never comes online before the readiness deadline",
      author: "Acme",
    });

    const workerManager = {
      isRunning: vi.fn(() => false),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 25,
      pluginWorkerReadyPollMs: 1,
    });

    await expect(
      runtimeWithPlugin.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: null,
      }),
    ).rejects.toThrow(/worker is not running/);
    // Confirms the loop actually polled repeatedly across the deadline window
    // instead of giving up after a single check.
    expect(vi.mocked(workerManager.isRunning).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps polling across a longer worker restart window and succeeds once the handle registers late", async () => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Registered Late Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.registered-late-sandbox-provider",
      packageName: "@acme/registered-late-sandbox-provider",
      displayName: "Registered Late Sandbox Provider",
      description: "Test plugin worker handle that stays unregistered/starting for most of the readiness window",
      author: "Acme",
    });

    // Simulates a worker process restart: the handle is absent (or "starting")
    // for most of the readiness window and only reports running with several
    // checks left before the deadline. A larger attempt count than the
    // existing "waits briefly" sanity test, to prove the loop is bound by the
    // deadline rather than by a small fixed number of attempts.
    const readyAfterChecks = 8;
    let checks = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => {
        if (id !== pluginId) return false;
        checks += 1;
        return checks >= readyAfterChecks;
      }),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-registered-late",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
      pluginWorkerReadyTimeoutMs: 200,
      pluginWorkerReadyPollMs: 1,
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-registered-late");
    expect(checks).toBe(readyAfterChecks);
  });

  it.each([
    { label: "explicit provider and bridge budgets", config: { timeoutMs: 1_234, bridgeRequestTimeoutMs: 40_000 }, declared: 300_000, expected: 70_000 },
    { label: "declared acquisition default", config: {}, declared: 300_000, expected: 330_000 },
    { label: "explicit shorter provider budget", config: { timeoutMs: 5_000 }, declared: 300_000, expected: 35_000 },
    { label: "bridge budget does not shorten acquisition default", config: { bridgeRequestTimeoutMs: 40_000 }, declared: 300_000, expected: 330_000 },
    { label: "bridge extends the acquisition default", config: { bridgeRequestTimeoutMs: 400_000 }, declared: 300_000, expected: 430_000 },
    { label: "undeclared provider retains worker default", config: {}, declared: undefined, expected: undefined },
  ])("uses $label for plugin-backed sandbox acquisition", async ({ config, declared, expected }) => {
    const pluginId = randomUUID();
    const { companyId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      ...config,
      reuseLease: false,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Long Lease Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.long-lease-sandbox-provider",
      packageName: "@acme/long-lease-sandbox-provider",
      displayName: "Long Lease Sandbox Provider",
      description: "Test plugin worker acquire timeout",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          defaultAcquireTimeoutMs: declared,
          // A timeoutMs schema default can mean lease lifetime (for example
          // E2B). Only the dedicated declaration sets the host RPC budget.
          configSchema: { type: "object", properties: { timeoutMs: { type: "number", default: 3_600_000 } } },
        },
      ],
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "sandbox-1",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              ...config,
              reuseLease: false,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(acquired.lease.providerLeaseId).toBe("sandbox-1");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        config: {
          image: "fake:test",
          ...config,
          reuseLease: false,
        },
      }),
      expected,
    );
  });

  it.each([
    // A run's resume budget is capped at 90s rather than the provider's whole
    // start deadline; a 61s start still fits.
    { label: "declared provider startup budget", timeoutMs: null, defaultAcquireTimeoutMs: 300_000, expectedRpcTimeoutMs: 90_000 },
    { label: "explicit startup budget", timeoutMs: 120_000, defaultAcquireTimeoutMs: 300_000, expectedRpcTimeoutMs: 90_000 },
  ])("resumes the same sandbox after a slow start within its $label", async (options) => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner", options);
    let signalResumeStarted!: () => void;
    const resumeStarted = new Promise<void>(resolve => { signalResumeStarted = resolve; });
    const call = vi.fn(async (_pluginId: string, method: string, _params: unknown, rpcTimeoutMs: number) => {
      if (method !== "environmentResumeLease") throw new Error(`Unexpected plugin method: ${method}`);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Plugin RPC timed out"));
        }, rpcTimeoutMs);
        setTimeout(() => {
          clearTimeout(timeout);
          vi.useRealTimers();
          resolve({ providerLeaseId: seeded.reusableLease.providerLeaseId, metadata: { remoteCwd: "/workspace" } });
        }, 61_000);
      });
      signalResumeStarted();
      return await response;
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const acquisition = runtime.acquireRunLease({
      companyId: seeded.companyId, environment: seeded.environment,
      issueId: null, agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" },
    }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await resumeStarted;
      await vi.advanceTimersByTimeAsync(61_000);
    } finally {
      vi.useRealTimers();
      now.mockRestore();
    }
    const result = await acquisition;
    expect(result.error).toBeNull();
    expect(result.value?.lease).toMatchObject({ id: seeded.reusableLease.id, providerLeaseId: seeded.reusableLease.providerLeaseId });
    expect(call).toHaveBeenCalledOnce();
    expect(call.mock.calls[0]?.[3]).toBe(options.expectedRpcTimeoutMs);
    expect(await environmentService(db).getLeaseById(seeded.reusableLease.id)).toMatchObject({ status: "active", heartbeatRunId: seeded.runId });
  });

  it("preserves the exact lease when plugin-backed sandbox resume throws", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      displayName: "Fake Sandbox Provider",
      description: "Test schema-driven provider",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: {
            type: "object",
            properties: {
              image: { type: "string" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await insertReusableProject(projectId, companyId);
    await insertReusableExecutionWorkspace(executionWorkspaceId, companyId, projectId);
    const staleLease = await insertStaleReusablePluginLease(companyId, environment, executionWorkspaceId, runId, agentId, pluginId, providerConfig);

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          // The real worker RPC path: a message and a numeric RPC code, with the
          // provider status only in the validated resume-error envelope.
          throw new JsonRpcCallError({ code: -32000, message: "stale sandbox /home/daytona/private-path",
            data: environmentResumeErrorData(Object.assign(new Error("private"), { statusCode: 409 })) });
        }
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // Keep the exact configured budget stable across deadline creation and RPC dispatch.
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      await expect(runtimeWithPlugin.acquireRunLease({
        companyId,
        environment,
        issueId: null,
        agentId,
        heartbeatRunId: runId,
        persistedExecutionWorkspace: {
          id: executionWorkspaceId,
          mode: "shared_workspace",
        },
      })).rejects.toThrow(
        // The provider refusal is named by closed labels; its text stays off the record.
        /could not be resumed \(cause=provider_error status=409\); the lease was preserved and no replacement was created\.$/,
      );
    } finally {
      now.mockRestore();
    }

    expect(workerManager.call).toHaveBeenNthCalledWith(1, pluginId, "environmentResumeLease", expect.objectContaining({
      driverKey: "fake-plugin",
      providerLeaseId: "stale-plugin-lease",
    }), 31234);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.anything(),
      expect.anything(),
    );
    await expect(environmentService(db).getLeaseById(staleLease.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  it.each([
    [{ providerLeaseId: null, metadata: { expired: true } }, "RetainedSandboxAbsentError"],
    [{ providerLeaseId: null, metadata: { expired: true, workspaceSentinel: { result: "mismatch" } } }, "RetainedSandboxAbsentError"],
    [{ providerLeaseId: "another-sandbox", metadata: {} }, "Error"],
    [{ providerLeaseId: null, metadata: {} }, "Error"],
  ] as const)("names only a provider-confirmed missing sandbox as absent on exact resume (%j)", async (reply, name) => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner", { timeoutMs: 1234 });
    const lease = (await environmentService(db).getLeaseById(seeded.reusableLease.id))!;
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentResumeLease") throw new Error("Only exact resume is permitted");
      return reply;
    });
    const workerManager = { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const error = await runtime.resumeRunLease({ environment: seeded.environment, lease }).catch(caught => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(call).toHaveBeenCalledOnce();
  });

  it.each(["ready", "error"] as const)("refuses an exact resume as a retryable stopped worker while the %s plugin re-activates", async status => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const lease = (await environmentService(db).getLeaseById(seeded.reusableLease.id))!;
    await db.update(plugins).set({ status, lastError: status === "error" ? "Activation timed out after 4 retries: initialize" : null })
      .where(eq(plugins.id, seeded.pluginId));
    const call = vi.fn();
    const requestActivationTimeoutRecovery = vi.fn(() => true);
    const workerManager = { isRunning: () => false, call, getWorker: () => undefined, requestActivationTimeoutRecovery } as unknown as PluginWorkerManager;
    const error = await environmentRuntimeService(db, { pluginWorkerManager: workerManager, pluginWorkerResumeWaitMs: 50, pluginWorkerReadyPollMs: 5 })
      .resumeRunLease({ environment: seeded.environment, lease }).catch(caught => caught);
    expect(error).toBeInstanceOf(PluginWorkerUnavailableError);
    expect(call).not.toHaveBeenCalled();
    expect(requestActivationTimeoutRecovery).toHaveBeenCalledTimes(status === "error" ? 1 : 0);
  });

  it("resumes the exact lease once a re-activating plugin's worker comes back within the wait", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    await environmentService(db).releaseLease(seeded.reusableLease.id, "released", { cleanupStatus: "success" });
    const lease = (await environmentService(db).getLeaseById(seeded.reusableLease.id))!;
    let checks = 0;
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentResumeLease") throw new Error("Only exact resume is permitted");
      return { providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/workspace" } };
    });
    const workerManager = { isRunning: () => ++checks > 3, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    await expect(environmentRuntimeService(db, { pluginWorkerManager: workerManager, pluginWorkerResumeWaitMs: 5_000, pluginWorkerReadyPollMs: 5 })
      .resumeRunLease({ environment: seeded.environment, lease })).resolves.toMatchObject({ providerLeaseId: lease.providerLeaseId });
    expect(call).toHaveBeenCalledOnce();
  });

  it.each([
    { timeoutMs: 300_000, rpcTimeoutMs: 330_000 },
    { timeoutMs: 1234, rpcTimeoutMs: 31_234 },
    { timeoutMs: null, rpcTimeoutMs: 60_000 },
  ])("resumes only the exact stopped sandbox lifecycle within its recorded budget ($timeoutMs)", async ({ timeoutMs, rpcTimeoutMs }) => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner", { timeoutMs });
    await environmentService(db).releaseLease(seeded.reusableLease.id, "released", { cleanupStatus: "success" });
    const lease = (await environmentService(db).getLeaseById(seeded.reusableLease.id))!;
    const call = vi.fn(async (_id: string, method: string, _input?: unknown) => {
      if (method !== "environmentResumeLease") throw new Error("Only exact resume is permitted");
      return { providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/workspace" } };
    });
    const workerManager = { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    await expect(runtime.resumeRunLease({ environment: seeded.environment, lease })).resolves.toMatchObject({ providerLeaseId: lease.providerLeaseId });
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith(seeded.pluginId, "environmentResumeLease", expect.objectContaining({
      companyId: seeded.companyId, environmentId: seeded.environment.id, providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
    }), rpcTimeoutMs);
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty("requestedCwd");
    expect((await environmentService(db).getLeaseById(lease.id))?.status).toBe("released");
    expect(await db.select().from(environmentLeases)).toHaveLength(1);
  });

  it("caps the exact resume call at the caller's remaining budget", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner", { timeoutMs: 300_000 });
    const lease = (await environmentService(db).getLeaseById(seeded.reusableLease.id))!;
    const call = vi.fn(async () => ({ providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/workspace" } }));
    const workerManager = { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    await environmentRuntimeService(db, { pluginWorkerManager: workerManager })
      .resumeRunLease({ environment: seeded.environment, lease, timeoutMs: 4_321 });
    expect(call).toHaveBeenCalledWith(seeded.pluginId, "environmentResumeLease", expect.anything(), 4_321);
  });

  it("forwards an explicit export directory to the selected generic plugin", async () => {
    const seeded = await seedReusablePluginSandboxLease();
    const requestedCwd = `/workspace/.paperclip-workspaces/${seeded.executionWorkspaceId}`;
    const metadata = { ...seeded.reusableLease.metadata, remoteCwd: requestedCwd };
    const call = vi.fn(async () => ({ providerLeaseId: seeded.reusableLease.providerLeaseId!, metadata }));
    const workerManager = { isRunning: () => true, call } as unknown as PluginWorkerManager;
    const result = await resumePluginEnvironmentLease({ db, workerManager, companyId: seeded.companyId,
      environmentId: seeded.environment.id, config: { pluginKey: "acme.reusable-sandbox-provider", driverKey: "fake-plugin", driverConfig: {} },
      providerLeaseId: seeded.reusableLease.providerLeaseId!, leaseMetadata: metadata, requestedCwd });
    expect(result.metadata?.remoteCwd).toBe(requestedCwd);
    expect(call).toHaveBeenCalledExactlyOnceWith(seeded.pluginId, "environmentResumeLease", expect.objectContaining({
      companyId: seeded.companyId, environmentId: seeded.environment.id,
      providerLeaseId: seeded.reusableLease.providerLeaseId, leaseMetadata: metadata, requestedCwd,
    }));
  });

  it.each(["stopped", "unconfirmed", "foreign_marker", "competing_owner", "retained_owner", "no_stop_capability", "live_request", "late_receipt", "duplicate_key", "owner_stopped", "owner_driver_changed", "owner_missing", "legacy_intent", "foreign_plugin_pin", "v2_missing_pin"])("recovers a pending export resume with stop-only cleanup after restart: %s", async outcome => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const lease = seeded.reusableLease;
    const requestId = randomUUID();
    if (["duplicate_key", "owner_stopped", "owner_driver_changed", "owner_missing", "legacy_intent"].includes(outcome)) {
      const [owner] = await db.select().from(plugins).where(eq(plugins.id, seeded.pluginId));
      await db.insert(plugins).values({ ...owner, id: randomUUID(), pluginKey: "other.same-driver", packageName: "@other/same-driver",
        installOrder: -1, manifestJson: { ...owner.manifestJson, id: "other.same-driver" } });
      if (outcome === "owner_driver_changed") await db.update(plugins).set({ manifestJson: { ...owner.manifestJson, environmentDrivers: [] } }).where(eq(plugins.id, seeded.pluginId));
      if (outcome === "owner_missing") await db.delete(plugins).where(eq(plugins.id, seeded.pluginId));
    }
    await db.update(environmentLeases).set({ status: "pending_cleanup", cleanupStatus: "failed", metadata: {
      ...lease.metadata,
      nativeWorkspaceExportResume: { schema: outcome === "v2_missing_pin" ? "paperclip.workspace-export-resume.v2" : "paperclip.workspace-export-resume.v1", requestId, companyId: seeded.companyId,
        ...(["legacy_intent", "v2_missing_pin"].includes(outcome) ? {} : { pluginId: outcome === "foreign_plugin_pin" ? randomUUID() : seeded.pluginId }),
        runId: outcome === "foreign_marker" ? randomUUID() : lease.heartbeatRunId, leaseId: lease.id,
        provider: lease.provider, providerLeaseId: lease.providerLeaseId, resultId: randomUUID() },
      pendingCleanupAttemptId: requestId, pendingCleanupInFlight: true,
      pendingCleanupLeaseExpiresAtMs: Date.now() + (outcome === "live_request" ? 60_000 : -1),
    } }).where(eq(environmentLeases.id, lease.id));
    if (["competing_owner", "retained_owner"].includes(outcome)) await db.insert(environmentLeases).values({ companyId: seeded.companyId,
      environmentId: seeded.environment.id, status: outcome === "retained_owner" ? "retained" : "active", provider: lease.provider, providerLeaseId: lease.providerLeaseId });
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentStopLease") throw new Error("Saved workspace must never be destroyed");
      if (outcome === "late_receipt") await db.update(environmentLeases).set({ status: "active", heartbeatRunId: null,
        cleanupStatus: null, metadata: { newOwner: true } }).where(eq(environmentLeases.id, lease.id));
      return outcome === "unconfirmed" ? undefined : { providerLeaseId: lease.providerLeaseId, state: "stopped" };
    });
    const workerManager = { isRunning: (id: string) => !(outcome === "owner_stopped" && id === seeded.pluginId), call,
      getWorker: () => ({ supportedMethods: outcome === "no_stop_capability" ? ["environmentReleaseLease", "environmentDestroyLease"] : ["environmentStopLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager;
    const restarted = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    await heartbeatService(db, { environmentRuntime: restarted }).sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(call.mock.calls.some((entry) => entry[1] === "environmentDestroyLease")).toBe(false);
    const persisted = (await environmentService(db).getLeaseById(lease.id))!;
    if (["stopped", "duplicate_key", "legacy_intent"].includes(outcome)) {
      expect(call).toHaveBeenCalledWith(seeded.pluginId, "environmentStopLease", expect.objectContaining({ providerLeaseId: lease.providerLeaseId, cancelActiveWork: true }), expect.any(Number));
      expect(persisted).toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: { state: "stopped", runId: lease.heartbeatRunId } } });
      expect(persisted.metadata?.nativeWorkspaceExportResume).toBeUndefined();
    } else if (outcome === "late_receipt") {
      expect(persisted).toMatchObject({ status: "active", heartbeatRunId: null, cleanupStatus: null, metadata: { newOwner: true } });
    } else {
      expect(persisted).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
      expect(persisted.metadata?.remoteExecutionTermination).toBeUndefined();
      if (["foreign_marker", "foreign_plugin_pin", "v2_missing_pin", "competing_owner", "retained_owner", "no_stop_capability", "live_request", "owner_stopped", "owner_driver_changed", "owner_missing"].includes(outcome)) expect(call).not.toHaveBeenCalled();
      if (["owner_stopped", "owner_driver_changed", "owner_missing"].includes(outcome)) {
        expect(persisted.metadata?.pendingCleanupAttemptId).toBe(requestId);
      }
    }
  });

  it.each(["stopped", "stop_failed", "unconfirmed", "restart", "committed_release", "inflight"])("preserves terminal ephemeral export work through release and restart: %s", async outcome => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const lease = seeded.reusableLease, requestId = randomUUID();
    await db.update(heartbeatRuns).set({ status: outcome === "committed_release" ? "succeeded" : "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
    await db.update(environmentLeases).set({ status: outcome === "committed_release" ? "active" : "pending_cleanup", leasePolicy: "ephemeral", cleanupStatus: "failed", metadata: {
      ...lease.metadata, reuseLease: false,
      nativeWorkspaceExportResume: { schema: "paperclip.workspace-export-resume.v2", purpose: "terminal_export", requestId,
        companyId: seeded.companyId, pluginId: seeded.pluginId, runId: seeded.runId, resultId: randomUUID(),
        leaseId: lease.id, provider: lease.provider, providerLeaseId: lease.providerLeaseId },
      pendingCleanupAttemptId: requestId, pendingCleanupInFlight: outcome === "inflight",
      pendingCleanupLeaseExpiresAtMs: outcome === "inflight" ? Date.now() + 60_000 : 0,
    } }).where(eq(environmentLeases.id, lease.id));
    let calls = 0;
    const call = vi.fn(async (_id: string, method: string, params: any) => {
      expect(method).toBe("environmentStopLease");
      expect(params).toMatchObject({ providerLeaseId: lease.providerLeaseId, resourceDisposition: "stop_and_retain", config: { reuseLease: false } });
      if (++calls === 1 && outcome === "stop_failed") throw new Error("injected stop failure");
      if (calls === 1 && outcome === "unconfirmed") return undefined;
      return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
    });
    const runtime = () => environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentStopLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    if (outcome === "restart") await heartbeatService(db, { environmentRuntime: runtime() }).sweepPendingCleanupLeases({ backoffMs: 0 });
    else await runtime().releaseRunLeases(seeded.runId, "failed", undefined, "stop_and_retain");
    if (outcome === "inflight") { expect(call).not.toHaveBeenCalled(); return; }
    if (["stop_failed", "unconfirmed"].includes(outcome)) {
      expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupInFlight: false } });
      await heartbeatService(db, { environmentRuntime: runtime() }).sweepPendingCleanupLeases({ backoffMs: 0 });
    }
    expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "released", cleanupStatus: "success", metadata: { remoteExecutionTermination: { state: "stopped" } } });
    expect(call.mock.calls.every(entry => entry[1] === "environmentStopLease")).toBe(true);
  });

  it("does not allocate a native-runner replacement without a verified backup", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const workerManager = {
      isRunning: vi.fn((id: string) => id === seeded.pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          return { providerLeaseId: null, metadata: { expired: true } };
        }
        if (method === "environmentDestroyLease") return undefined;
        if (method === "environmentAcquireLease") {
          throw new Error("replacement must not be allocated");
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId: seeded.companyId,
      environment: seeded.environment,
      issueId: null,
      agentId: seeded.agentId,
      adapterType: "paperclip_runner",
      heartbeatRunId: seeded.runId,
      persistedExecutionWorkspace: {
        id: seeded.executionWorkspaceId,
        mode: "shared_workspace",
      },
    })).rejects.toThrow("runner_harness_backup_unavailable");

    expect(workerManager.call).not.toHaveBeenCalledWith(
      seeded.pluginId,
      "environmentAcquireLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).not.toHaveBeenCalledWith(
      seeded.pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
  });

  it("permits native-runner replacement only after verifying the stamped backup", async () => {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    const backupBase = await mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-replacement-"));
    const previousStateDirectory = process.env.PAPERCLIP_RUNNER_STATE_DIR;
    process.env.PAPERCLIP_RUNNER_STATE_DIR = backupBase;
    try {
      const normalizedSessionId = "native-replacement-session";
      const runnerInstanceId = "native-replacement-runner";
      const sessionScopeId = "native-replacement-session-scope-v2";
      const sessionRoot = path.join(
        backupBase,
        createHash("sha256").update(sessionScopeId).digest("hex"),
      );
      const current = path.join(sessionRoot, "failover-backups", "current");
      await mkdir(path.join(current, "runner"), { recursive: true });
      await mkdir(path.join(current, "codex-home", "sessions"), { recursive: true });
      await writeFile(path.join(current, "runner", "runner-state.json"), "runner-state");
      await writeFile(path.join(current, "codex-home", "sessions", "thread.jsonl"), "thread-state");
      const execution = {
        provider: { kind: "codex", model: null, approvalPolicy: "never" },
        binding: {
          companyId: seeded.companyId,
          runId: seeded.runId,
          issueId: "issue",
          agentId: seeded.agentId,
          executionWorkspaceId: seeded.executionWorkspaceId,
        },
        workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        session: {
          normalizedSessionId,
          driverKind: "codex_app_server",
          protocolVersion: 1,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
        },
      } as never;
      const manifest = buildNativeHarnessBackupManifest({
        backupRoot: current,
        execution,
        runnerInstanceId,
        providerSessionIdentity: {
          providerSessionId: "thread-1",
          providerBackendSessionId: "session-1",
          providerSessionIdentity: null,
        },
        sourceProviderLeaseId: seeded.reusableLease.providerLeaseId!,
      });
      const manifestPath = path.join(current, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest));
      const stamp = createNativeHarnessBackupStamp({
        manifestPath,
        sessionScopeId,
        authorizedProviderLeaseId: seeded.reusableLease.providerLeaseId!,
        normalizedSessionId,
        runnerInstanceId,
        completedAt: manifest.completedAt,
      });
      await environmentService(db).updateLeaseMetadata(seeded.reusableLease.id, {
        ...(seeded.reusableLease.metadata ?? {}),
        nativeHarnessBackup: stamp,
      });

      const workerManager = {
        isRunning: vi.fn((id: string) => id === seeded.pluginId),
        call: vi.fn(async (_pluginId: string, method: string) => {
          if (method === "environmentResumeLease") {
            return { providerLeaseId: null, metadata: { expired: true } };
          }
          if (method === "environmentDestroyLease") return undefined;
          if (method === "environmentAcquireLease") {
            return {
              providerLeaseId: "replacement-plugin-lease",
              metadata: {
                provider: "fake-plugin",
                image: "fake:test",
                timeoutMs: 1234,
                reuseLease: true,
                remoteCwd: "/workspace",
              },
            };
          }
          throw new Error(`Unexpected plugin method: ${method}`);
        }),
        getWorker: vi.fn(() => ({
          supportedMethods: [
            "environmentResumeLease",
            "environmentReleaseLease",
            "environmentDestroyLease",
          ],
        })),
      } as unknown as PluginWorkerManager;
      const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
      const acquired = await runtimeWithPlugin.acquireRunLease({
        companyId: seeded.companyId,
        environment: seeded.environment,
        issueId: null,
        agentId: seeded.agentId,
        adapterType: "paperclip_runner",
        heartbeatRunId: seeded.runId,
        persistedExecutionWorkspace: {
          id: seeded.executionWorkspaceId,
          mode: "shared_workspace",
        },
      });

      expect(acquired.lease.providerLeaseId).toBe("replacement-plugin-lease");
      expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({
        outcome: "replacement",
        reason: "not_found",
      });
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.PAPERCLIP_RUNNER_STATE_DIR;
      } else {
        process.env.PAPERCLIP_RUNNER_STATE_DIR = previousStateDirectory;
      }
      await rm(backupBase, { recursive: true, force: true });
    }
  });

  it("fails closed and does not resume when a worker restart drops the resume method after the capability snapshot", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      displayName: "Fake Sandbox Provider",
      description: "Test schema-driven provider",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: {
            type: "object",
            properties: {
              image: { type: "string" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await insertReusableProject(projectId, companyId);
    await insertReusableExecutionWorkspace(executionWorkspaceId, companyId, projectId);
    const staleLease = await insertStaleReusablePluginLease(companyId, environment, executionWorkspaceId, runId, agentId, pluginId, providerConfig);

    // The runtime reads the worker methods once to decide reuse, then does
    // asynchronous database work before the resume dispatch. A worker restart
    // in that window drops `environmentResumeLease`. The first read returns the
    // reuse verbs, so the runtime treats the lease as resumable. Every later
    // read returns the restarted worker's methods, which no longer include
    // `environmentResumeLease`.
    let getWorkerReads = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentResumeLease") {
          // A regression that reads the stale snapshot dispatches the resume
          // RPC and fails here. The live worker cannot serve the method.
          throw new Error("worker no longer advertises environmentResumeLease");
        }
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => {
        getWorkerReads += 1;
        return {
          supportedMethods:
            getWorkerReads === 1
              ? ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"]
              : ["environmentReleaseLease", "environmentDestroyLease"],
        };
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    await expect(runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    })).rejects.toThrow("the lease was preserved and no replacement was created");

    // The runtime re-checks the live worker before the resume dispatch. The
    // restarted worker no longer advertises `environmentResumeLease`, so the
    // runtime must not dispatch the resume RPC.
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    // It preserves the stale reusable lease and does not allocate a replacement.
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentAcquireLease",
      expect.anything(),
      expect.anything(),
    );
    await expect(environmentService(db).getLeaseById(staleLease.id)).resolves.toMatchObject({
      status: "active",
    });
  });

  // Seed a reusable plugin sandbox lease that a worker created under an earlier
  // capability set. The worker restarts and no longer advertises the lifecycle
  // methods. The lease lifecycle paths must verify the live worker before they
  // dispatch a lifecycle RPC, so the runtime fails closed instead of a doomed
  // dispatch.
  async function seedStaleLifecycleReusableLease(
    leasePolicy: "reuse_by_environment" | "retain_on_failure" = "reuse_by_environment",
  ) {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      displayName: "Fake Sandbox Provider",
      description: "Test schema-driven provider",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: { type: "object" },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: `Workspace ${projectId.slice(0, 8)}`,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const lease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy,
      provider: "fake-plugin",
      providerLeaseId: "stale-lifecycle-lease",
      metadata: {
        agentId,
        driver: "sandbox",
        pluginId,
        pluginKey: "acme.fake-sandbox-provider",
        sandboxProviderPlugin: true,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
      },
    });

    // The worker is running, but its discovery list dropped the reusable-lease
    // lifecycle methods. `call` throws on any lifecycle RPC so a regression that
    // dispatches one fails the test through the `not.toHaveBeenCalledWith` check.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentAcquireLease", "environmentExecute"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    return { pluginId, environment, runId, lease, workerManager, runtimeWithPlugin };
  }

  it("routes release to pending_cleanup when the worker no longer advertises the release lifecycle method", async () => {
    const { pluginId, lease, workerManager, runtimeWithPlugin } = await seedStaleLifecycleReusableLease();

    const released = await runtimeWithPlugin.releaseRunLeases(lease.heartbeatRunId!);

    expect(released).toHaveLength(1);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentReleaseLease",
      expect.anything(),
      expect.anything(),
    );
    // The failed release verification must enter the pending-cleanup retry flow.
    // The reaper sweeps only `pending_cleanup` leases, so a `released` status
    // here would strand the still-active provider resource.
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      failureReason: "release_cleanup_failed",
    });
  });

  it("retains a retain_on_failure lease on failed release instead of routing to pending_cleanup", async () => {
    const { lease, runtimeWithPlugin } = await seedStaleLifecycleReusableLease("retain_on_failure");

    const released = await runtimeWithPlugin.releaseRunLeases(lease.heartbeatRunId!, "failed");

    expect(released).toHaveLength(1);
    // A retain_on_failure lease keeps the provider resource for reuse. The
    // reaper destroys `pending_cleanup` leases, so the retained lease must not
    // enter that flow even when the release verification fails.
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "retained",
      cleanupStatus: "failed",
    });
  });

  it("destroys a failed retained lease when the agent stops", async () => {
    const { lease, workerManager, runtimeWithPlugin, runId } = await seedStaleLifecycleReusableLease("retain_on_failure");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await runtimeWithPlugin.releaseRunLeases(runId, "failed");
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({ status: "retained", cleanupStatus: "failed" });
    vi.mocked(workerManager.getWorker).mockReturnValue({ supportedMethods: ["environmentDestroyLease"] } as never);
    vi.mocked(workerManager.call).mockResolvedValue({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    const { heartbeatService } = await import("../services/heartbeat.js");
    const stopped = await heartbeatService(db, { pluginWorkerManager: workerManager })
      .stopInvocationsForAgents([lease.metadata!.agentId as string], "Agent lifecycle stop requested");
    expect(stopped).toBe(true);
    expect(workerManager.call).toHaveBeenCalledWith(expect.any(String), "environmentDestroyLease", expect.objectContaining({ providerLeaseId: lease.providerLeaseId }), expect.any(Number));
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({ status: "expired", cleanupStatus: "success" });
  });

  it("fails closed on expiry destruction when the worker no longer advertises the destroy lifecycle method", async () => {
    const { pluginId, lease, workerManager, runtimeWithPlugin } = await seedStaleLifecycleReusableLease();

    await runtimeWithPlugin.releaseRunLeases(lease.heartbeatRunId!, "expired");

    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.anything(),
      expect.anything(),
    );
    await expect(environmentService(db).getLeaseById(lease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      cleanupStatus: "failed",
    });
  });

  it.each(["provider config", "workspace migration"])("does not resume released reusable plugin sandbox leases after %s drift", async drift => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "template-a",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.fake-sandbox-provider",
      packageName: "@acme/fake-sandbox-provider",
      displayName: "Fake Sandbox Provider",
      description: "Test schema-driven provider",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: {
            type: "object",
            properties: {
              image: { type: "string" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await insertReusableProject(projectId, companyId);
    await insertReusableExecutionWorkspace(executionWorkspaceId, companyId, projectId);

    let acquisitions = 0;
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.image}${++acquisitions > 1 ? "-replacement" : ""}`,
            metadata: {
              provider: "fake-plugin",
              image: params.config.image,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    expect(first.lease.metadata?.reusableSandboxLease).toMatchObject({
      provider: "fake-plugin",
      leaseFingerprint: expect.objectContaining({
        category: "lease",
        fingerprint: expect.stringMatching(/^v1:sha256:[a-f0-9]{64}$/),
      }),
    });
    await runtimeWithPlugin.releaseRunLeases(runId);

    if (drift === "workspace migration") {
      const operationId = randomUUID();
      await db.insert(workspaceOperations).values({ id: operationId, companyId, executionWorkspaceId,
        phase: "remote_workspace_migration", status: "succeeded", metadata: {
          schema: "paperclip.remote-workspace-migration.v1", snapshotId: randomUUID(), nativeSessionContinuity: {
            schema: "paperclip.native-workspace-migration.v1", remoteCwd: "/workspace", sessions: [{
              sourceRunId: runId, agentId, issueId: randomUUID(), sessionId: randomUUID(), logicalCwd: "/old/controller/workspace",
            }],
          },
        } });
      await db.update(executionWorkspaces).set({ metadata: { nativeWorkspaceMigration: {
        schema: "paperclip.native-workspace-migration.v1", operationId,
      } } }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    }
    const nextRunId = randomUUID();
    await insertRunningManualRun(nextRunId, companyId, agentId);
    const updatedEnvironment: Environment = {
      ...environment,
      config: {
        ...providerConfig,
        image: drift === "provider config" ? "template-b" : "template-a",
      },
    };
    await environmentService(db).update(environment.id, {
      config: updatedEnvironment.config,
    });

    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment: updatedEnvironment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe(`lease-${updatedEnvironment.config.image}-replacement`);
    expect(second.lease.metadata?.reusableSandboxLease).not.toEqual(first.lease.metadata?.reusableSandboxLease);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-template-a",
    }), 31234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
  });

  it("does not resume released reusable plugin sandbox leases after secret version drift", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const apiSecret = await secretService(db).create(companyId, {
      name: `secure-plugin-api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "resolved-provider-key",
    });
    const providerConfig = {
      provider: "secure-plugin",
      template: "base",
      apiKey: apiSecret.id,
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Secure Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await secretService(db).createBinding({
      companyId,
      secretId: apiSecret.id,
      targetType: "environment",
      targetId: environment.id,
      configPath: "apiKey",
    });
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.secure-sandbox-provider",
      packageName: "@acme/secure-sandbox-provider",
      displayName: "Secure Sandbox Provider",
      description: "Test schema-driven provider",
      environmentDrivers: [
        {
          driverKey: "secure-plugin",
          kind: "sandbox_provider",
          displayName: "Secure Sandbox",
          supportsReusableLeases: true,
          configSchema: {
            type: "object",
            properties: {
              template: { type: "string" },
              apiKey: { type: "string", format: "secret-ref" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await insertReusableProject(projectId, companyId);
    await insertReusableExecutionWorkspace(executionWorkspaceId, companyId, projectId);

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: `lease-${params.config.apiKey}`,
            metadata: {
              provider: "secure-plugin",
              template: params.config.template,
              apiKey: params.config.apiKey,
              timeoutMs: params.config.timeoutMs,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentReleaseLease" || method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const first = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });
    await runtimeWithPlugin.releaseRunLeases(runId);
    await secretService(db).rotate(apiSecret.id, { value: "rotated-provider-key" });

    const nextRunId = randomUUID();
    await insertRunningManualRun(nextRunId, companyId, agentId);
    const second = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(second.lease.providerLeaseId).toBe("lease-rotated-provider-key");
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.objectContaining({
      providerLeaseId: "lease-resolved-provider-key",
    }), 31234);
    await expect(environmentService(db).getLeaseById(first.lease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
      failureReason: "lease_fingerprint_mismatch",
    });
    const firstMetadata = JSON.stringify(first.lease.metadata);
    expect(firstMetadata).not.toContain("resolved-provider-key");
    expect(firstMetadata).not.toContain("rotated-provider-key");
  });

  it("preserves active reusable sandbox leases held by another running run", async () => {
    const { pluginId, companyId, agentId, environment, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    const nextRunId = randomUUID();
    await insertRunningManualRun(nextRunId, companyId, agentId);
    const workerManager = createFreshPluginLeaseWorker(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: nextRunId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(workerManager.call).toHaveBeenCalledOnce();
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId,
      executionWorkspaceId,
      runId: nextRunId,
    }), 31234);
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "active",
      cleanupStatus: null,
    });
  });

  async function seedSettlingWarmLease(predecessorFinishedAt: Date, predecessorStatus: "succeeded" | "failed" = "succeeded", stopReplyDelayMs = 0) {
    const seeded = await seedReusablePluginSandboxLease("paperclip_runner");
    await environmentService(db).releaseLease(seeded.reusableLease.id, "expired");
    const warmEnvironment = resolveRunnerEnvironmentForRun(seeded.environment, "paperclip_runner", { lifecycleMode: "warm" }, undefined, "selected-account:generation");
    let created = 0;
    const call = vi.fn(async (_pluginId: string, method: string, input: any) => {
      if (method === "environmentResumeLease") return { providerLeaseId: input.providerLeaseId, metadata: { remoteCwd: "/workspace" } };
      if (method === "environmentAcquireLease") return { providerLeaseId: `warm-${++created}`, metadata: { remoteCwd: "/workspace" } };
      if (method === "environmentStopLease") await new Promise(resolve => setTimeout(resolve, stopReplyDelayMs));
      if (method === "environmentDestroyLease" || method === "environmentStopLease" || method === "environmentReleaseLease") return {
        providerLeaseId: input.providerLeaseId, state: method === "environmentDestroyLease" ? "destroyed" : "stopped",
      };
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const input = { companyId: seeded.companyId, agentId: seeded.agentId, issueId: null, adapterType: "paperclip_runner",
      environment: warmEnvironment, persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" as const } };
    const predecessorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: predecessorRunId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    const predecessor = await runtime.acquireRunLease({ ...input, heartbeatRunId: predecessorRunId });
    await db.update(heartbeatRuns).set({ status: predecessorStatus, finishedAt: predecessorFinishedAt }).where(eq(heartbeatRuns.id, predecessorRunId));
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: seeded.companyId, agentId: seeded.agentId, status: "running" });
    return { runtime, call, input, predecessor, predecessorRunId, nextRunId };
  }

  it.each([["succeeded", 0], ["failed", 0], ["failed", 1_500]] as const)("resumes a warm lease that its %s predecessor is still releasing (stop reply after %i ms) instead of creating a fresh sandbox", async (predecessorStatus, stopReplyDelayMs) => {
    const f = await seedSettlingWarmLease(new Date(), predecessorStatus, stopReplyDelayMs);
    const released = new Promise<void>(resolve => setTimeout(() => {
      void f.runtime.releaseRunLeases(f.predecessorRunId, "released", undefined, "stop_and_retain").then(() => resolve());
    }, 400));
    const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId });
    await released;
    expect(next.lease.providerLeaseId).toBe(f.predecessor.lease.providerLeaseId);
    expect(next.lease.heartbeatRunId).toBe(f.nextRunId);
    expect(f.call.mock.calls.filter(call => call[1] === "environmentAcquireLease")).toHaveLength(1);
  });

  it("does not wait for a warm lease that a predecessor finished long ago and never released", async () => {
    const f = await seedSettlingWarmLease(new Date(Date.now() - 10 * 60_000));
    const startedAt = Date.now();
    const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: f.nextRunId });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(next.lease.providerLeaseId).not.toBe(f.predecessor.lease.providerLeaseId);
    await expect(environmentService(db).getLeaseById(f.predecessor.lease.id)).resolves.toMatchObject({ status: "active" });
  });

  it("does not retain or resume plugin-backed sandbox leases unless the provider opts in", async () => {
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Non-reusable Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.non-reusable-sandbox-provider",
      packageName: "@acme/non-reusable-sandbox-provider",
      displayName: "Non-reusable Sandbox Provider",
      description: "Test provider without reusable lease support",
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await insertReusableProject(projectId, companyId);
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Non-reusable workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertOldReusablePluginLease(companyId, environment, executionWorkspaceId, runId, agentId, providerConfig);

    const workerManager = createFreshPluginLeaseWorker(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
  });

  it("does not resume a lease when the nested capability disables reusable leases", async () => {
    // The provider declares the legacy `supportsReusableLeases: true` flag but
    // the nested `sandboxCapabilities.reusableLeases: false`. The nested value
    // wins through the capability contract, so acquisition must acquire a fresh
    // lease and must never resume the existing reusable lease.
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Nested-disabled Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.nested-disabled-sandbox-provider",
      packageName: "@acme/nested-disabled-sandbox-provider",
      displayName: "Nested-disabled Sandbox Provider",
      description: "Test provider with a legacy flag and a disabled nested capability",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          supportsReusableLeases: true,
          sandboxCapabilities: { reusableLeases: false },
          configSchema: {
            type: "object",
            properties: {
              image: { type: "string" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await insertReusableProject(projectId, companyId);
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Nested-disabled workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await insertOldReusablePluginLease(companyId, environment, executionWorkspaceId, runId, agentId, providerConfig);

    const workerManager = createFreshPluginLeaseWorker(pluginId);
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
  });

  it("fails closed and does not resume when the worker does not verify the reuse methods", async () => {
    // The provider declares `reusableLeases: true`, but its worker advertises
    // neither `environmentResumeLease` nor `environmentReleaseLease`. The runtime
    // must not resume or reuse the lease, because it cannot dispatch a resume or
    // a release the worker does not serve. It acquires a fresh ephemeral lease
    // and leaves the old reusable lease untouched.
    const pluginId = randomUUID();
    const { companyId, agentId, environment: baseEnvironment, runId } = await seedEnvironment();
    const providerConfig = {
      provider: "fake-plugin",
      image: "fake:test",
      timeoutMs: 1234,
      reuseLease: true,
    };
    const environment: Environment = {
      ...baseEnvironment,
      name: "Unverified-worker Plugin Sandbox",
      driver: "sandbox",
      config: providerConfig,
    };
    await environmentService(db).update(environment.id, {
      driver: "sandbox",
      name: environment.name,
      config: providerConfig,
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.unverified-worker-sandbox-provider",
      packageName: "@acme/unverified-worker-sandbox-provider",
      displayName: "Unverified-worker Sandbox Provider",
      description: "Test provider that declares reusable leases but whose worker lacks the reuse methods",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          sandboxCapabilities: { reusableLeases: true },
          configSchema: {
            type: "object",
            properties: {
              image: { type: "string" },
              timeoutMs: { type: "number" },
              reuseLease: { type: "boolean" },
            },
          },
        },
      ],
    });
    const executionWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await insertReusableProject(projectId, companyId);
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Unverified-worker workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const existingLease = await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "old-plugin-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        image: "fake:test",
        timeoutMs: 1234,
        reuseLease: true,
        reusableSandboxLease: {
          version: 1,
          companyId,
          environmentId: environment.id,
          executionWorkspaceId,
          agentId,
          adapterType: null,
          provider: "fake-plugin",
          runtimeFingerprint: reusableRuntimeFingerprint({
            provider: "fake-plugin",
            adapterType: null,
            config: providerConfig,
          }),
        },
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-plugin-lease",
            metadata: {
              provider: "fake-plugin",
              image: "fake:test",
              timeoutMs: 1234,
              reuseLease: true,
              remoteCwd: "/workspace",
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      // The worker verifies only `environmentExecute`. It advertises neither
      // reuse verb, so the reusable-lease capability fails closed.
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentExecute"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-plugin-lease");
    expect(acquired.lease.leasePolicy).toBe("ephemeral");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.anything(), 31234);
    expect(workerManager.call).not.toHaveBeenCalledWith(
      pluginId,
      "environmentResumeLease",
      expect.anything(),
      expect.anything(),
    );
    // The runtime leaves the old reusable lease untouched: it neither resumes
    // nor destroys a lease it cannot serve.
    await expect(environmentService(db).getLeaseById(existingLease.id)).resolves.toMatchObject({
      status: "active",
      leasePolicy: "reuse_by_environment",
    });
  });

  // Real PostgreSQL, runtime acquire/release/destroy and authenticated backup
  // bytes. Only the provider's remote process and model I/O are deterministic.
  // Real PostgreSQL regressions for acquisition after terminal stop intent.
  it.each(["undispatched", "stopped"] as const)("R-NULL projectless null-issue finalizer reopens the original conversation (%s)", async phase => {
    const f = await terminalConversationFixture({ projectless: true });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await db.update(environmentLeases).set({ issueId: null, status: "active" }).where(eq(environmentLeases.id, f.lease.id));
    await f.runtime.releaseRunLeases(f.runId, "released", undefined, "destroy");
    const pending = (await environmentService(db).getLeaseById(f.lease.id))!;
    expect(pending.status).toBe("pending_cleanup");
    expect(pending.metadata?.sandboxStopAndRetain).toMatchObject({ terminalPiSandbox: { priorStatus: "released" } });
    if (phase === "stopped") {
      await chSweep(f);
      expect((await environmentService(db).getLeaseById(f.lease.id))!.status).toBe("released");
    }
    const result = await chReopen(f);
    chRow("R-NULL", { phase, originalBox: f.originalBox, answer: f.answer, ...result });
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
    if (result.error) expect(result.error).toBe("reusable_sandbox_terminal_stop_unsettled");
    else { expect(result.box).toBe(f.originalBox); expect(result.reply).toBe(f.answer); }
  });

  it("R-MULTI-OLDER an older durable terminal conversation cannot replace the task source", async () => {
    const f = await terminalConversationFixture();
    const olderRun = randomUUID(), olderSession = randomUUID();
    const olderAt = new Date(f.lease.createdAt.getTime() - 60_000);
    await db.insert(heartbeatRuns).values({ id: olderRun, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: olderSession, runtimeMode: "native",
      status: "succeeded", invocationSource: "on_demand", createdAt: olderAt, finishedAt: olderAt,
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } }, sessionCheckpoint: { sessionId: olderSession } } });
    const [original] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const [older] = await db.insert(environmentLeases).values({ ...original!, id: randomUUID(), heartbeatRunId: olderRun,
      providerLeaseId: "older-terminal-conversation", acquiredAt: olderAt, lastUsedAt: olderAt, createdAt: olderAt,
      status: "released" }).returning();
    await f.runtime.execute({ environment: f.environment, lease: (await environmentService(db).getLeaseById(older!.id))!,
      command: "remember", args: ["older-conversation-only-answer"] });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: olderRun, agentId: f.agentId,
      seq: 1, eventType: "provider.event", createdAt: olderAt, payload: { answer: "older-conversation-only-answer" } });
    await chTerminal(f, "done", 360_000);
    const queued = await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId));
    expect(queued.filter(lease => lease.status === "pending_cleanup" && lease.metadata?.sandboxStopAndRetain)).toHaveLength(2);
    const result = await chReopen(f);
    chRow("R-MULTI-OLDER", { originalBox: f.originalBox, olderBox: older!.providerLeaseId, answer: f.answer, ...result });
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
    if (result.error) expect(result.error).toBe("reusable_sandbox_terminal_stop_unsettled");
    else { expect(result.box).toBe(f.originalBox); expect(result.reply).toBe(f.answer); }
  });

  it.each(["pending", "stopped"] as const)("R-DIFFTASK a new task cannot consume another task's held conversation (%s)", async phase => {
    const f = await terminalConversationFixture();
    await chTerminal(f, "done", 360_000);
    if (phase === "stopped") await chSweep(f);
    const taskB = randomUUID(), runB = randomUUID();
    await db.insert(issues).values({ id: taskB, companyId: f.companyId, title: "A new task", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runB, companyId: f.companyId, agentId: f.agentId, issueId: taskB,
      nativeIssueId: taskB, runtimeMode: "native", status: "running", invocationSource: "on_demand" });
    const next = await f.runtime.acquireRunLease({ ...f.input, issueId: taskB, heartbeatRunId: runB });
    const held = (await environmentService(db).getLeaseById(f.lease.id))!;
    chRow("R-DIFFTASK-B", { phase, originalBox: f.originalBox, selected: next.lease.providerLeaseId,
      heldStatus: held.status, stopIntent: held.metadata?.sandboxStopAndRetain, stopReceipt: held.metadata?.sandboxStopAndRetainReceipt });
    expect(next.lease.providerLeaseId).not.toBe(f.originalBox);
    expect(held.status).toBe(phase === "pending" ? "pending_cleanup" : "released");
    expect(phase === "pending" ? held.metadata?.sandboxStopAndRetain : held.metadata?.sandboxStopAndRetainReceipt).toBeTruthy();
    await f.runtime.releaseRunLeases(runB, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runB));
    const result = await chReopen(f);
    chRow("R-DIFFTASK-A", { phase, originalBox: f.originalBox, answer: f.answer, ...result });
    expect(result.error).toBeNull();
    expect(result.box).toBe(f.originalBox); expect(result.reply).toBe(f.answer);
    expect(chCount(f, "environmentDestroyLease")).toBe(0);
  });

  // Real native harness admission, verification and directory restoration. Only
  // the remote command/file transport and provider/model boundary are controlled.
  async function probeLatestSessionHarness(f: Awaited<ReturnType<typeof terminalConversationFixture>>,
    lease: EnvironmentLease, runId: string, backup: boolean) {
    const root = await mkdtemp(path.join(os.tmpdir(), "latest-session-harness-")); fixtureRoots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", path.join(root, "controller"));
    const execution = runnerVendor.parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v3", executionMode: "default", planningContext: null,
      binding: { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId, executionWorkspaceId: f.executionWorkspaceId },
      provider: { kind: "pi_rpc", model: "fixture/model" },
      task: { identifier: "RECALL", title: "Recall latest conversation", description: null, prompt: "Recall", workMode: "standard" },
      workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: f.sessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 } },
      completionContract: { id: "contract", sha256: "saved", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Recall", criteria: [{ id: "recall", requirement: "Recall" }] } },
      runtimeContext: nativeRuntimeContextFixture(), interactionResponses: [], credentialBindings: [] });
    const sha = `sha256:${"a".repeat(64)}`;
    const artifacts = Object.fromEntries(Object.entries({ grokLauncher: "dist/providers/grok/launcher.cjs",
      nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml", opencodeCommand: "node_modules/.bin/opencode",
      opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe", opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs",
      acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs" }).map(([name, p]) => [name, { path: p, sha256: sha }]));
    const profiles = runnerVendor.QUALIFIED_ACPX_PROFILES;
    const payload = { compatibility: { opencode: 1, acpx: 1, pi_rpc: 1 }, contractDigest: sha,
      target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: "a".repeat(40),
      pins: { nodeMinimum: "24.11.0", codex: profiles.codex.agentRuntimeVersion, opencode: "1.18.34",
        acpx: runnerVendor.QUALIFIED_ACPX_VERSION, grok: profiles.grok.agentRuntimeVersion,
        claudeAcp: profiles.claude.agentServerVersion, codexAcp: profiles.codex.agentServerVersion },
      acpxProfileDigests: Object.fromEntries((["grok", "claude", "codex"] as const).map(agent => [agent, profiles[agent].commandDigest])),
      artifacts, distDigest: sha, bridgeDigest: `sha256:${createHash("sha256").update(`${sha}\n${sha}\n${sha}`).digest("hex")}` };
    const pack = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` };
    await writeFile(path.join(root, "provider-pack.json"), JSON.stringify(pack));
    const binary = path.join(root, "fixture-runnerd"), elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(62, 18); await writeFile(binary, elf);
    const remoteCwd = path.join(root, "remote");
    const copy = async (operations: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>) => {
      for (const operation of operations) for (const file of operation.files) {
        await mkdir(path.dirname(file.targetPath), { recursive: true });
        await cp(file.sourcePath, file.targetPath, { recursive: true });
      }
    };
    const runner = { syncIn: copy, syncOut: copy, async execute(command: { command: string; args?: string[] }) {
      if (command.args?.[0] === "--build-metadata") return { exitCode: 0, timedOut: false, stderr: "", stdout: JSON.stringify({
        schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner",
        binaryContractVersion: 2, durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"], prpTransportModes: ["listen_ws"],
        providerPacks: [{ root: "/opt/paperclip-runner/provider-pack", manifest: pack, immutable: true }],
      }) };
      if (command.args?.[1]?.includes("base64")) {
        try { return { exitCode: 0, timedOut: false, stderr: "", stdout: execFileSync("sh", command.args, { encoding: "utf8" }) }; }
        catch { return { exitCode: 1, timedOut: false, stderr: "", stdout: "" }; }
      }
      return { exitCode: 0, timedOut: false, stderr: "", stdout: "" };
    } };
    let backendOptions: any, transportOptions: any;
    const backendSpy = vi.spyOn(runnerVendor, "createNativeSessionBackend").mockImplementation(((_execution: any, options: any) => {
      backendOptions = options; return {};
    }) as any);
    const transportSpy = vi.spyOn(runnerVendor, "createRunnerdCodexTransport").mockImplementation(((options: any) => {
      transportOptions = options; return { transport: {} };
    }) as any);
    const runtimeApiSpy = vi.spyOn(runtimeApi, "resolveLocalRuntimeApiUrl").mockReturnValue("http://127.0.0.1:3100");
    try {
      // The conversation fixture records provider progress, not a controller
      // checkpoint. Do not misrepresent its minimal display checkpoint as one.
      await db.update(heartbeatRuns).set({ runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} - 'sessionCheckpoint'` })
        .where(eq(heartbeatRuns.id, f.runId));
      await createRunnerdBackend({ db, execution, runnerInstanceId: f.runnerInstanceId,
        restartRecovery: { kind: "bootstrap_incomplete", runId, leaseOwner: "controlled-controller",
          controllerGeneration: 1, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null },
        runnerRemoteBinaryPath: binary, runnerRemoteProviderPackPath: root, runnerIngressAuthorized: true,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd, environmentId: f.environment.id,
          leaseId: lease.id, providerKey: "fake-plugin", reusableLeaseConfigured: true,
          effectiveCapabilities: { runnerWebSocketIngress: true }, runner,
          sandboxLeaseAcquisition: { ...(lease.metadata?.sandboxLeaseAcquisition as Record<string, unknown>), providerLeaseId: lease.providerLeaseId },
        } as never });
      backendOptions.codexTransportFactory();
      if (backup) {
        const backupRoot = path.join(scopedRunnerdStateRoot(execution), "failover-backups/current");
        await mkdir(path.join(backupRoot, "runner"), { recursive: true });
        const providerState = { schema: "paperclip.runner.codex-provider-state.v1", lifecycle: "prepared", threadId: "saved-latest-provider-session",
          providerSessionId: null, activeProviderTurnId: null, config: { provider: "pi_rpc", driver: "pi_rpc" } };
        await writeFile(path.join(backupRoot, "runner/runner-state.json"), JSON.stringify({ schema: "paperclip.runner.durable.state.v1",
          runId: f.runId, normalizedSessionId: f.sessionId, runnerInstanceId: f.runnerInstanceId, lifecycle: "suspended",
          nextSourceSeq: 2, ackedSourceSeq: 0, outbox: [], pendingTerminalDelivery: null }));
        await writeFile(path.join(backupRoot, "runner/codex-provider-state.json"), JSON.stringify(providerState));
        await writeFile(path.join(backupRoot, "runner/conversation.json"), JSON.stringify({ sessionId: f.sessionId, answer: f.answer }));
        const manifest = buildNativeHarnessBackupManifest({ backupRoot, execution, runnerInstanceId: f.runnerInstanceId,
          sourceProviderLeaseId: f.originalBox, providerSessionIdentity: providerSessionIdentityFromDurableProviderState({ execution, providerState }) });
        const manifestPath = path.join(backupRoot, "manifest.json"); await writeFile(manifestPath, JSON.stringify(manifest));
        const stamp = createNativeHarnessBackupStamp({ manifestPath, sessionScopeId: stableStringify({
          schema: "paperclip.native-session-scope.v2", companyId: f.companyId, agentId: f.agentId,
          workspace: nativeSessionWorkspaceScope(execution), provider: { driverKind: "pi_rpc", identity: { kind: "pi_rpc" } },
          normalizedSessionId: f.sessionId,
        }),
          authorizedProviderLeaseId: f.originalBox, normalizedSessionId: f.sessionId, runnerInstanceId: f.runnerInstanceId, completedAt: manifest.completedAt });
        // This is the retired source's verified backup, not the older held box.
        const source = (await environmentService(db).getLeaseById(f.lease.id))!;
        await environmentService(db).updateLeaseMetadata(source.id, { ...source.metadata, nativeHarnessBackup: stamp });
      }
      await transportOptions.prepareExternalRunnerState();
      const remoteSession = path.join(remoteCwd, ".paperclip-runtime/paperclip-runner/sessions", createHash("sha256").update(f.sessionId).digest("hex"));
      // Controlled model reads only the files the PRODUCTION restore staged.
      return JSON.parse(await readFile(path.join(remoteSession, "runner/conversation.json"), "utf8")) as { sessionId: string; answer: string };
    } finally { backendSpy.mockRestore(); transportSpy.mockRestore(); runtimeApiSpy.mockRestore(); }
  }

  it.each((["released", "expired"] as const).flatMap(status => [false, true].map(backup => ({ status, backup }))))(
    "older-session warm stop does not fence the latest missing sandbox ($status, backup=$backup)", async ({ status, backup }) => {
    const f = await terminalConversationFixture({ backup });
    const oldRun = randomUUID(), oldSession = randomUUID(), oldAt = new Date(Date.now() - 600_000);
    await db.insert(heartbeatRuns).values({ id: oldRun, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: oldSession, runtimeMode: "native",
      status: "succeeded", invocationSource: "on_demand", createdAt: oldAt, finishedAt: oldAt,
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: oldRun, agentId: f.agentId,
      seq: 1, eventType: "provider.event", createdAt: oldAt, payload: { answer: "older session" } });
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const metadata = { ...source!.metadata }; delete metadata.nativeHarnessBackup;
    const [old] = await db.insert(environmentLeases).values({ ...source!, id: randomUUID(), heartbeatRunId: oldRun,
      providerLeaseId: "older-warm-box", status: "active", metadata,
      createdAt: oldAt, acquiredAt: oldAt, lastUsedAt: oldAt }).returning();
    // A normal warm-window stop, not a terminal-task stop.
    await f.runtime.releaseRunLeases(oldRun, "released", undefined, "stop_and_retain");
    // Persist the historical ordering: X stopped before the later S2 run on Y.
    await db.update(environmentLeases).set({ lastUsedAt: oldAt, updatedAt: oldAt }).where(eq(environmentLeases.id, old!.id));
    const before = (await environmentService(db).getLeaseById(old!.id))!;
    expect(before.metadata?.sandboxStopAndRetainReceipt).toBeTruthy();
    expect(before.metadata?.terminalPiSandboxOrigin).toBeUndefined();
    await db.update(environmentLeases).set({ status, ...(status === "expired" ? { releasedAt: new Date(), cleanupStatus: "success", metadata: {
      ...f.lease.metadata, remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.originalBox, state: "destroyed" }),
    } } : {}) }).where(eq(environmentLeases.id, f.lease.id));
    const dispatch = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (id: string, method: string, params: any) => {
      if (method === "environmentResumeLease" && params.providerLeaseId === f.originalBox)
        return { providerLeaseId: null, metadata: { expired: true } } as any;
      return dispatch(id, method, params);
    });
    const attempts: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const selected = await createHeartbeatRunState(db).getTaskSession(f.companyId, f.agentId, "paperclip_runner", f.issueId);
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
          issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: selected!.sessionDisplayId,
          runtimeMode: "native", status: "running", invocationSource: "on_demand" });
        const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: runId });
        if (next.lease.providerLeaseId === before.providerLeaseId) {
          attempts.push({ attempt, error: "older_session_box_selected", box: next.lease.providerLeaseId,
            sessionId: selected!.sessionDisplayId, acquisition: next.lease.metadata?.sandboxLeaseAcquisition });
          break;
        }
        const restored = await probeLatestSessionHarness(f, next.lease, runId, backup);
        attempts.push({ attempt, box: next.lease.providerLeaseId, sessionId: selected!.sessionDisplayId,
          restoredSessionId: restored?.sessionId, reply: restored?.answer ?? null, error: null,
          acquisition: next.lease.metadata?.sandboxLeaseAcquisition });
        break;
      } catch (error: any) {
        attempts.push({ attempt, error: error.reason ?? error.code ?? error.message.split(":")[0], code: error.code, words: error.message });
      }
    }
    const after = (await environmentService(db).getLeaseById(old!.id))!;
    chRow("OLDER_SESSION", { status, backup, task: f.issueId, olderSession: oldSession, latestSession: f.sessionId,
      olderBox: before.providerLeaseId, latestMissingBox: f.originalBox, attempts,
      olderUnchanged: JSON.stringify(before) === JSON.stringify(after), order: chOrder(f) });
    expect(after).toEqual(before);
    expect(attempts.every(row => row.error !== "reusable_sandbox_terminal_stop_unsettled")).toBe(true);
    if (backup) {
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ error: null, sessionId: f.sessionId, restoredSessionId: f.sessionId,
        reply: f.answer, acquisition: status === "released" ? { outcome: "replacement", reason: "not_found" } : { outcome: "created" } });
    } else if (status === "released") {
      expect(attempts).toHaveLength(3);
      expect(attempts.every(row => row.error === "runner_harness_backup_unavailable")).toBe(true);
    } else {
      expect(attempts).toHaveLength(3);
      expect(attempts.every(row => row.error === "runner_harness_state_mismatch"
        && row.words === "runner_harness_state_mismatch: created_not_suspended")).toBe(true);
    }
  });

  it.each(["handoff", "same-run", "lost-handoff"] as const)("candidate filtering does not bind an unselected projectless lease (%s)", async mode => {
    const f = await terminalConversationFixture({ projectless: true });
    const oldRun = randomUUID(), oldAt = new Date(Date.now() - 600_000);
    await db.insert(heartbeatRuns).values({ id: oldRun, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "succeeded",
      invocationSource: "on_demand", createdAt: oldAt, finishedAt: oldAt });
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const [old] = await db.insert(environmentLeases).values({ ...source!, id: randomUUID(), issueId: null,
      heartbeatRunId: oldRun, providerLeaseId: "unselected-projectless-box", status: "released",
      createdAt: oldAt, acquiredAt: oldAt, lastUsedAt: oldAt }).returning();
    await db.update(environmentLeases).set({ issueId: null }).where(eq(environmentLeases.id, f.lease.id));
    if (mode === "lost-handoff") {
      const dispatch = f.call.getMockImplementation()!;
      f.call.mockImplementation(async (id: string, method: string, params: any) => {
        if (method === "environmentResumeLease") await db.update(environmentLeases).set({ status: "pending_cleanup" })
          .where(eq(environmentLeases.id, f.lease.id));
        return dispatch(id, method, params);
      });
      await expect(f.reopen()).rejects.toThrow("ownership changed during acquisition");
      const source = (await environmentService(db).getLeaseById(f.lease.id))!;
      const unselected = (await environmentService(db).getLeaseById(old!.id))!;
      chRow("FILTER_WRITE_ROLLBACK", { source: source.id, sourceIssue: source.issueId,
        sourceStatus: source.status, unselected: old!.id, unselectedIssue: unselected.issueId });
      expect(source.issueId).toBeNull(); expect(unselected.issueId).toBeNull();
      return;
    }
    const next = mode === "same-run" ? await f.runtime.acquireRunLease(f.input) : (await f.reopen()).next;
    expect(next.lease.providerLeaseId).toBe(f.originalBox);
    const unselected = (await environmentService(db).getLeaseById(old!.id))!;
    const selectedSource = (await environmentService(db).getLeaseById(f.lease.id))!;
    // This is the issue route's actual selector, not merely a column read.
    const destroyed = await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId,
      failureReason: "issue_terminal_done" });
    const after = (await environmentService(db).getLeaseById(old!.id))!;
    chRow("FILTER_WRITE", { mode, task: f.issueId, selected: next.lease.id, selectedSource: selectedSource.id,
      selectedSourceIssue: selectedSource.issueId, selectedIssue: next.lease.issueId,
      unselected: old!.id, unselectedIssue: unselected.issueId, unselectedBeforeStatus: unselected.status,
      unselectedAfterStatus: after.status, destroyed: destroyed.map(row => row.lease.id) });
    expect(unselected.issueId).toBeNull();
    expect(after).toEqual(unselected);
    expect(selectedSource.issueId).toBe(f.issueId);
    expect(next.lease.issueId).toBe(f.issueId);
  });

  it.each((["done", "cancelled"] as const).flatMap(status => [false, true].map(drain => ({ status, drain }))))(
    "held Pi bootstrap without provider work resumes ($status, drain=$drain)", async ({ status, drain }) => {
      const f = await terminalConversationFixture();
      await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
      await chTerminal(f, status, 360_000);
      if (drain) await chSweep(f);
      const result = await chReopen(f);
      chRow("NO_PROVIDER_WORK", { status, drain, ...result, originalBox: f.originalBox, answer: f.answer });
      expect(result.error).toBeNull(); expect(result.box).toBe(f.originalBox); expect(result.reply).toBe(f.answer);
      expect(chCount(f, "environmentDestroyLease")).toBe(0);
      expect(chCount(f, "environmentAcquireLease")).toBe(0);
  });

  it("real conversation reset clears an older held-session fence without touching its box", async () => {
    const f = await terminalConversationFixture();
    await chTerminal(f, "done", 360_000); await chSweep(f);
    const held = (await environmentService(db).getLeaseById(f.lease.id))!;
    const newer = randomUUID(), now = new Date();
    await db.insert(heartbeatRuns).values({ id: newer, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: randomUUID(), runtimeMode: "native",
      status: "succeeded", invocationSource: "on_demand", createdAt: now, finishedAt: now,
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } } } });
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: newer, agentId: f.agentId,
      seq: 1, eventType: "provider.event", payload: { answer: "gone latest session" } });
    const resetId = randomUUID(), commentId = randomUUID(), userId = randomUUID();
    await db.update(issues).set({ status: "in_progress", conversationAgentId: f.agentId, assigneeAgentId: f.agentId,
      conversationUserId: userId, conversationState: "active" }).where(eq(issues.id, f.issueId));
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorUserId: userId, body: "/new" });
    const [resetRun] = await db.insert(heartbeatRuns).values({ id: resetId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "running", invocationSource: "on_demand",
      contextSnapshot: { issueId: f.issueId, wakeCommentId: commentId } }).returning();
    const reset = await prepareConversationTurn(db, resetRun!);
    expect(reset.reset).toBe(true);
    // Same persistence as heartbeat's /new completion, not a synthetic lease edit.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { ...reset.context, conversationReset: true } }).where(eq(heartbeatRuns.id, resetId));
    const nextId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, status: "running", invocationSource: "on_demand", contextSnapshot: {
        issueId: f.issueId, conversationSessionGeneration: 1 } });
    const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: nextId });
    const after = (await environmentService(db).getLeaseById(f.lease.id))!;
    chRow("REAL_RESET", { reset, box: next.lease.providerLeaseId, heldUnchanged: JSON.stringify(held) === JSON.stringify(after),
      destroys: chCount(f, "environmentDestroyLease") });
    expect(next.lease.providerLeaseId).not.toBe(f.originalBox);
    expect(after).toEqual(held); expect(chCount(f, "environmentDestroyLease")).toBe(0);
  });

  it.each([false, true])("obsolete fingerprint cleanup preserves an unselected conversation (null task=%s)", async nullTask => {
    const f = await terminalConversationFixture({ projectless: true });
    const before = (await environmentService(db).getLeaseById(f.lease.id))!;
    await db.update(environmentLeases).set({ issueId: nullTask ? null : f.issueId, metadata: {
      ...before.metadata, reusableSandboxLease: { ...(before.metadata?.reusableSandboxLease as Record<string, unknown>),
        runtimeFingerprint: "seeded-mismatch", leaseFingerprint: "seeded-mismatch" },
    } }).where(eq(environmentLeases.id, before.id));
    const seeded = (await environmentService(db).getLeaseById(before.id))!;
    const result = await chReopen(f);
    const after = (await environmentService(db).getLeaseById(before.id))!;
    chRow("OBSOLETE_PROTECTION", { nullTask, result, before: seeded, after,
      destroys: chCount(f, "environmentDestroyLease") });
    expect(after).toEqual(seeded);
    expect(chCount(f, "environmentDestroyLease")).toBe(0);
    expect(result.error).not.toBe("reusable_sandbox_terminal_stop_unsettled");
  });

  it("terminal stop without provider work refuses through backoff and task-session reset, then reuses the same box", async () => {
    const f = await terminalConversationFixture();
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    await chTerminal(f, "done", 360_000);
    const dispatch = f.call.getMockImplementation()!;
    let broken = true;
    f.call.mockImplementation(async (id, method, params) => {
      if (broken && method === "environmentStopLease") throw new Error("provider stop unavailable");
      return dispatch(id, method, params);
    });
    await chSweep(f);
    for (let i = 0; i < 2; i++) {
      expect((await chReopen(f)).error).toBe("reusable_sandbox_terminal_stop_unsettled");
    }
    await createHeartbeatRunState(db).resetRuntimeSession(f.agentId, { taskKey: f.issueId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: f.sessionId, runtimeMode: "native",
      status: "running", invocationSource: "on_demand" });
    const input = { ...f.input, heartbeatRunId: runId };
    await expect(f.runtime.acquireRunLease(input)).rejects.toMatchObject({ reason: "reusable_sandbox_terminal_stop_unsettled" });
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
    broken = false;
    await chDue(f); await chSweep(f);
    const next = await f.runtime.acquireRunLease(input);
    const reply = await f.runtime.execute({ environment: f.environment, lease: next.lease, command: "recall" });
    chRow("NO_WORK_STOP_REPAIRED", { originalBox: f.originalBox, selectedBox: next.lease.providerLeaseId,
      answer: f.answer, reply: reply.stdout, creates: chCount(f, "environmentAcquireLease") });
    expect(next.lease.providerLeaseId).toBe(f.originalBox); expect(reply.stdout).toBe(f.answer);
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
  });

  it.each([false, true].flatMap(otherFirst => [false, true].map(sameSession => ({ otherFirst, sameSession }))))(
    "terminal boxes without provider work follow the requested native session (other first=$otherFirst, same session=$sameSession)", async ({ otherFirst, sameSession }) => {
    const f = await terminalConversationFixture();
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    const otherRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: otherRun, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: sameSession ? f.sessionId : randomUUID(), runtimeMode: "native",
      status: "failed", invocationSource: "on_demand", finishedAt: new Date(),
      createdAt: sameSession ? new Date(f.lease.createdAt.getTime() - 60_000) : new Date(),
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } } } });
    const [source] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.insert(environmentLeases).values({ ...source!, id: otherFirst
      ? "00000000-0000-4000-8000-000000000001" : "ffffffff-ffff-4fff-bfff-ffffffffffff",
      heartbeatRunId: otherRun, providerLeaseId: "other-terminal-box" });
    await chTerminal(f, "done", 360_000);
    const result = await chReopen(f);
    expect(result.error).toBeNull(); expect(result.box).toBe(f.originalBox); expect(result.reply).toBe(f.answer);
    await f.runtime.releaseRunLeases(result.runId!, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, result.runId!));
    const again = await chReopen(f);
    chRow("NO_WORK_TWO_BOXES", { otherFirst, sameSession, originalBox: f.originalBox, answer: f.answer, result, again });
    expect(again.error).toBeNull(); expect(again.box).toBe(f.originalBox); expect(again.reply).toBe(f.answer);
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
  });

  it.each(["scheduled_retry", "cancelled", "failed"] as const)(
    "a real fresh blocker retry that never bound a session preserves the saved box (%s)", async status => {
    const f = await terminalConversationFixture();
    await chTerminal(f, "done", 360_000); await chSweep(f);
    const { materializeNativeEnvironmentBlockerRetry } = await import("../services/native-runtime/native-provider-capacity-retry.js");
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "native_environment_blocker", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, f.runId));
    const retryId = await db.transaction(tx => materializeNativeEnvironmentBlockerRetry({ tx: tx as never,
      companyId: f.companyId, issueId: f.issueId, runId: f.runId, agentId: f.agentId }));
    if (status !== "scheduled_retry") await db.update(heartbeatRuns).set({ status, finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, retryId));
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    expect(retry!.contextSnapshot?.explicitFreshSession).toBe(true); expect(retry!.nativeSessionId).toBeNull();
    const result = await chReopen(f);
    chRow("FRESH_RETRY_NO_SESSION", { status, retryId, originalBox: f.originalBox, answer: f.answer, result });
    expect(result.error).toBeNull(); expect(result.box).toBe(f.originalBox); expect(result.reply).toBe(f.answer);
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
  });

  it("a fresh reset that bound a session but failed before provider work fences only its own pending box", async () => {
    const f = await terminalConversationFixture();
    await chTerminal(f, "done", 360_000);
    const dispatch = f.call.getMockImplementation()!;
    let broken = true;
    f.call.mockImplementation(async (id, method, params) => {
      if (broken && method === "environmentStopLease") throw new Error("provider stop unavailable");
      return dispatch(id, method, params);
    });
    await chSweep(f);
    const older = (await environmentService(db).getLeaseById(f.lease.id))!;
    const runId = randomUUID(), sessionId = randomUUID(), answer = `fresh-${randomUUID()}`;
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: sessionId, runtimeMode: "native",
      status: "running", invocationSource: "on_demand", contextSnapshot: { explicitFreshSession: true },
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } } } });
    const fresh = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: runId });
    expect(fresh.lease.providerLeaseId).not.toBe(f.originalBox);
    expect(await environmentService(db).getLeaseById(f.lease.id)).toEqual(older);
    await f.runtime.execute({ environment: f.environment, lease: fresh.lease, command: "remember", args: [answer] });
    await f.runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(0);
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    await chSweep(f);
    const nextId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: sessionId, runtimeMode: "native",
      status: "running", invocationSource: "on_demand" });
    const input = { ...f.input, heartbeatRunId: nextId };
    await expect(f.runtime.acquireRunLease(input)).rejects.toMatchObject({ reason: "reusable_sandbox_terminal_stop_unsettled",
      providerLeaseId: fresh.lease.providerLeaseId });
    broken = false; await chDue(f); await chSweep(f);
    const next = await f.runtime.acquireRunLease(input);
    const reply = await f.runtime.execute({ environment: f.environment, lease: next.lease, command: "recall" });
    chRow("BOUND_RESET_NO_WORK", { oldBox: f.originalBox, freshBox: fresh.lease.providerLeaseId,
      selectedBox: next.lease.providerLeaseId, answer, reply: reply.stdout, creates: chCount(f, "environmentAcquireLease") });
    expect(next.lease.providerLeaseId).toBe(fresh.lease.providerLeaseId); expect(reply.stdout).toBe(answer);
    expect(chCount(f, "environmentAcquireLease")).toBe(1); expect(chCount(f, "environmentDestroyLease")).toBe(0);
  });

  async function terminalConversationFixture(options: { backup?: boolean; session?: boolean; live?: boolean; projectless?: boolean } = {}) {
    const f = await seedReusablePluginSandboxLease("paperclip_runner");
    const issueId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const answer = `remember-${randomUUID()}`;
    const boxes = new Map<string, string>();
    const originalBox = f.reusableLease.providerLeaseId!;
    const call = vi.fn(async (_pluginId: string, method: string, params: any) => {
      if (method === "environmentResumeLease") return { providerLeaseId: params.providerLeaseId, metadata: { remoteCwd: "/workspace" } };
      if (method === "environmentAcquireLease") return { providerLeaseId: "terminal-replacement", metadata: {
        provider: "fake-plugin", image: "fake:test", reuseLease: true, timeoutMs: 1234, remoteCwd: "/workspace" } };
      if (method === "environmentReleaseLease") return undefined;
      if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      if (method === "environmentDestroyLease") { boxes.delete(params.providerLeaseId); return { providerLeaseId: params.providerLeaseId, state: "destroyed" }; }
      if (method === "environmentExecute") {
        const box = params.lease.providerLeaseId;
        if (params.command === "remember") boxes.set(box, params.args[0]);
        if (!boxes.has(box)) throw new Error("PRP provider resume state is unavailable");
        return { exitCode: 0, stdout: boxes.get(box), stderr: "" };
      }
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call, getWorker: () => ({ supportedMethods: [
        "environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease", "environmentStopLease", "environmentExecute" ] }),
    } as unknown as PluginWorkerManager });
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Reopen this conversation", status: "in_progress" });
    await db.update(environmentLeases).set({ issueId, ...(options.projectless ? { executionWorkspaceId: null,
      metadata: { ...f.reusableLease.metadata, reusableSandboxLease: { ...(f.reusableLease.metadata?.reusableSandboxLease as Record<string, unknown>),
        executionWorkspaceId: null, projectlessIssueId: issueId } },
    } : {}) }).where(eq(environmentLeases.id, f.reusableLease.id));
    await db.update(heartbeatRuns).set({ nativeIssueId: issueId, issueId, runtimeMode: "native",
      nativeSessionId: options.session === false ? null : sessionId, runnerInstanceId,
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } }, sessionCheckpoint: { sessionId } },
    }).where(eq(heartbeatRuns.id, f.runId));
    const input = { companyId: f.companyId, environment: f.environment, issueId, agentId: f.agentId,
      adapterType: "paperclip_runner", heartbeatRunId: f.runId,
      persistedExecutionWorkspace: options.projectless ? null : { id: f.executionWorkspaceId, mode: "shared_workspace" as const } };
    const acquired = await runtime.acquireRunLease(input);
    await runtime.execute({ environment: f.environment, lease: acquired.lease, command: "remember", args: [answer] });
    const finishedAt = new Date(Date.now() - 1_000);
    if (options.session !== false) await db.insert(heartbeatRunEvents).values({ companyId: f.companyId,
      runId: f.runId, agentId: f.agentId, seq: 1, eventType: "provider.event", createdAt: new Date(finishedAt.getTime() - 1),
      payload: { answer } });
    await runtime.releaseRunLeases(f.runId, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: options.live ? "running" : "succeeded",
      finishedAt: options.live ? null : finishedAt }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, adapterType: "paperclip_runner",
      taskKey: issueId, lastRunId: f.runId, sessionDisplayId: sessionId, sessionParamsJson: { sessionId } });
    const root = await mkdtemp(path.join(os.tmpdir(), "terminal-conversation-")); fixtureRoots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", root);
    const scopeId = randomUUID(), backupRoot = path.join(root, createHash("sha256").update(scopeId).digest("hex"), "failover-backups", "current");
    async function saveBackup(completedAt = new Date().toISOString(), normalizedSessionId = sessionId) {
      await mkdir(path.join(backupRoot, "runner"), { recursive: true });
      await writeFile(path.join(backupRoot, "runner", "conversation.json"), JSON.stringify({ sessionId: normalizedSessionId, answer }), { mode: 0o600 });
      const manifest = buildNativeHarnessBackupManifest({ backupRoot, execution: { provider: { kind: "pi_rpc" },
        binding: { companyId: f.companyId, issueId, runId: f.runId, agentId: f.agentId, executionWorkspaceId: f.executionWorkspaceId },
        workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "warm", idleTimeoutMs: null } },
      } as never, runnerInstanceId, providerSessionIdentity: { providerSessionId: sessionId }, sourceProviderLeaseId: originalBox, completedAt });
      const manifestPath = path.join(backupRoot, "manifest.json");
      await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
      const stamp = createNativeHarnessBackupStamp({ manifestPath, sessionScopeId: scopeId, authorizedProviderLeaseId: originalBox,
        normalizedSessionId, runnerInstanceId, completedAt });
      const current = (await environmentService(db).getLeaseById(acquired.lease.id))!;
      await environmentService(db).updateLeaseMetadata(current.id, { ...current.metadata, nativeHarnessBackup: stamp });
      return stamp;
    }
    if (options.backup) expect(await verifyRecoverableNativeHarnessBackup({ db, companyId: f.companyId,
      stamp: await saveBackup(), providerLeaseId: originalBox })).toBe(true);
    async function reopen() {
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId, body: "What did I ask you to remember?", authorUserId: "local-board" }).returning();
      const selected = await createHeartbeatRunState(db).getTaskSession(f.companyId, f.agentId, "paperclip_runner", issueId);
      expect(selected?.sessionDisplayId).toBe(sessionId);
      const nextRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId, issueId,
        nativeIssueId: issueId, nativeSessionId: sessionId, runtimeMode: "native", status: "running", invocationSource: "on_demand" });
      const next = await runtime.acquireRunLease({ ...input, heartbeatRunId: nextRunId });
      const reply = await runtime.execute({ environment: f.environment, lease: next.lease, command: "recall" })
        .then(result => result.stdout, error => (error as Error).message);
      return { next, reply, commentId: comment!.id, nextRunId };
    }
    async function drainStop(ownerRunId = f.runId, stopSupported = true) {
      // The terminal branch has made even an idle released lease pending. Use
      // the existing claimed retry/stop/settlement dispatcher, not provider mocks
      // for the host policy. A fresh service proves no in-process warm census.
      const restarted = environmentRuntimeService(db, { pluginWorkerManager: {
        isRunning: () => true, call, getWorker: () => ({ supportedMethods: stopSupported ? ["environmentStopLease"] : [] }),
      } as unknown as PluginWorkerManager });
      await restarted.releaseRunLeases(ownerRunId, "released", undefined, "stop_and_retain", true);
      return (await environmentService(db).getLeaseById(acquired.lease.id))!;
    }
    const lease = (await environmentService(db).getLeaseById(acquired.lease.id))!;
    return { ...f, runtime, call, input, issueId, sessionId, runnerInstanceId, answer, originalBox, lease, finishedAt, backupRoot, saveBackup, reopen, drainStop };
  }

  it.each((["released", "retained"] as const).flatMap(status => [false, true].map(projectless => ({ status, projectless }))))(
    "terminal reopen cancels an undispatched stop from $status and recalls the same box (projectless=$projectless)", async ({ status, projectless }) => {
    const f = await terminalConversationFixture({ projectless });
    await db.update(environmentLeases).set({ status }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    const reopened = await f.reopen();
    expect(reopened.next.lease.providerLeaseId).toBe(f.originalBox);
    expect(reopened.reply).toBe(f.answer);
    expect(f.call.mock.calls.some(([, method]) => ["environmentAcquireLease", "environmentStopLease", "environmentDestroyLease"].includes(method))).toBe(false);
    console.log("TERMINAL_REOPEN_ROW", JSON.stringify({ phase: "before_dispatch", status, projectless, sessionId: f.sessionId,
      originalBox: f.originalBox, reopenedBox: reopened.next.lease.providerLeaseId, answer: f.answer, reply: reopened.reply, newBoxes: 0, stops: 0 }));
  });

  it.each((["settled", "timeout"] as const).flatMap(outcome => [false, true].map(projectless => ({ outcome, projectless }))))(
    "terminal reopen fences an old in-flight stop until $outcome without allocating (projectless=$projectless)", async ({ outcome, projectless }) => {
    const f = await terminalConversationFixture({ projectless });
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    let signalStarted!: () => void, finishStop!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const gate = new Promise<void>(resolve => { finishStop = resolve; });
    f.call.mockImplementationOnce(async (_id, method, params) => {
      expect(method).toBe("environmentStopLease"); signalStarted(); await gate;
      return { providerLeaseId: params.providerLeaseId, state: "stopped" };
    });
    const stop = f.drainStop();
    await started;
    const beforeResume = f.call.mock.calls.filter(([, method]) => method === "environmentResumeLease").length;
    const reopenStartedAt = Date.now();
    const reopening = f.reopen().then(value => ({ value, error: null }), error => ({ value: null, error }));
    try {
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(f.call.mock.calls.filter(([, method]) => method === "environmentResumeLease")).toHaveLength(beforeResume);
      expect(f.call.mock.calls.some(([, method]) => method === "environmentAcquireLease")).toBe(false);
      if (outcome === "timeout") {
        const { error } = await reopening;
        expect(error).toMatchObject({ code: "reusable_sandbox_resume_failed", reason: "reusable_sandbox_terminal_stop_unsettled" });
      }
    } finally { finishStop(); await stop; await reopening; }
    const reopened = await reopening;
    if (outcome === "settled") {
      expect(reopened.error).toBeNull();
      expect(reopened.value!.next.lease.providerLeaseId).toBe(f.originalBox);
      expect(reopened.value!.reply).toBe(f.answer);
    }
    expect(f.call.mock.calls.some(([, method]) => ["environmentAcquireLease", "environmentDestroyLease"].includes(method))).toBe(false);
    console.log("TERMINAL_REOPEN_ROW", JSON.stringify({ phase: "in_flight", outcome, projectless, elapsedMs: Date.now() - reopenStartedAt,
      originalBox: f.originalBox, reopenedBox: reopened.value?.next.lease.providerLeaseId ?? null, sessionId: f.sessionId,
      reply: reopened.value?.reply ?? null, answer: f.answer, reason: reopened.error?.reason ?? null, newBoxes: 0 }));
  }, 45_000);

  it("terminal reopen refuses a failed dispatched stop without cancelling or replacing it", async () => {
    const f = await terminalConversationFixture();
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(heartbeatRuns.id, f.runId));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    f.call.mockRejectedValueOnce(new Error("provider stop failed"));
    await f.drainStop();
    await expect(f.reopen()).rejects.toMatchObject({ code: "reusable_sandbox_resume_failed", reason: "reusable_sandbox_terminal_stop_unsettled" });
    expect((await environmentService(db).getLeaseById(f.lease.id))?.status).toBe("pending_cleanup");
    expect(f.call.mock.calls.some(([, method]) => ["environmentAcquireLease", "environmentDestroyLease"].includes(method))).toBe(false);
  });

  it.each([0, 6 * 60_000])("terminal reopen refuses failed stop backoff when the source ended %s ms ago", async ageMs => {
    const f = await terminalConversationFixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - ageMs) }).where(eq(heartbeatRuns.id, f.runId));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    f.call.mockRejectedValueOnce(new Error("provider stop unavailable"));
    const sweep = await heartbeatService(db, { environmentRuntime: f.runtime }).sweepPendingCleanupLeases({ backoffMs: 0 });
    const pending = (await environmentService(db).getLeaseById(f.lease.id))!;
    expect(pending.status).toBe("pending_cleanup");
    expect(Number(pending.metadata?.pendingCleanupRetryAfterMs)).toBeGreaterThan(Date.now());
    await expect(f.reopen()).rejects.toMatchObject({ code: "reusable_sandbox_resume_failed", reason: "reusable_sandbox_terminal_stop_unsettled" });
    expect(f.call.mock.calls.some(([, method]) => ["environmentAcquireLease", "environmentDestroyLease"].includes(method))).toBe(false);
    console.log("TERMINAL_REOPEN_ROW", JSON.stringify({ phase: "failed_stop_backoff", ageMs, sweep, sessionId: f.sessionId,
      originalBox: f.originalBox, reason: "reusable_sandbox_terminal_stop_unsettled", retryAfter: pending.metadata?.pendingCleanupRetryAfterMs, newBoxes: 0 }));
  }, 40_000);

  it("heartbeat retries terminal stop backoff and answers in the same Pi session and allocation", async () => {
    const f = await seedReusablePluginSandboxLease("paperclip_runner");
    const issueId = randomUUID(), answer = `remember-${randomUUID()}`;
    const root = await mkdtemp(path.join(os.tmpdir(), "terminal-heartbeat-")); fixtureRoots.push(root);
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", root);
    const settings = instanceSettingsService(db), previousSettings = await settings.getExperimental();
    const memories = new Map<string, string>(), submissions: Array<{ runId: string; sessionId: string; box: string; reply: string }> = [];
    const call = vi.fn(async (_pluginId: string, method: string, params: any) => {
      if (method === "environmentResumeLease") return { providerLeaseId: params.providerLeaseId, metadata: { remoteCwd: root } };
      if (method === "environmentAcquireLease") return { providerLeaseId: f.reusableLease.providerLeaseId,
        metadata: { provider: "fake-plugin", image: "fake:test", timeoutMs: 1234, reuseLease: true, remoteCwd: root } };
      if (method === "environmentRealizeWorkspace") return { cwd: root };
      if (method === "environmentExecute") {
        try {
          return await new Promise((resolve, reject) => {
            const child = execFile(params.command, params.args ?? [], { cwd: root,
              env: { PATH: process.env.PATH, HOME: root, ...params.env }, timeout: 15_000 },
              (error, stdout, stderr) => error ? reject(error) : resolve({ exitCode: 0, stdout, stderr }));
            child.stdin?.end(params.stdin ?? "");
          });
        } catch (error: any) { return { exitCode: typeof error.code === "number" ? error.code : 1,
          stdout: error.stdout ?? "", stderr: error.stderr ?? error.message }; }
      }
      if (method === "environmentStopLease") return { providerLeaseId: params.providerLeaseId, state: "stopped" };
      if (method === "environmentReleaseLease") return undefined;
      throw new Error(`Unexpected provider method: ${method}`);
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentRealizeWorkspace",
        "environmentExecute", "environmentStopLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const backendFactory: NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> = execution => {
      let identity: NativeRunIdentity, sourceInstanceId = "", reply = "";
      let turn = Promise.withResolvers<string>(), lastTurnId = "";
      const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      const session: NativeSession = {
        identity: () => identity, capabilities: async () => capabilities,
        attachRun: async input => { identity = input.identity;
          sourceInstanceId = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, identity.runId)))[0]!.runnerInstanceId!; },
        steer: async () => {}, interrupt: async () => {},
        startTurn: async () => {
          const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, identity.runId));
          const lease = leases.find(row => row.status === "active")!;
          expect(lease.providerLeaseId).toBe(f.reusableLease.providerLeaseId);
          const key = `${lease.providerLeaseId}:${identity.sessionId}`;
          if (submissions.length === 0) memories.set(key, answer);
          reply = memories.get(key)!;
          expect(reply).toBe(answer);
          submissions.push({ runId: identity.runId, sessionId: identity.sessionId, box: lease.providerLeaseId!, reply });
          const turnId = randomUUID(); lastTurnId = turnId; turn.resolve(turnId); return { turnId };
        },
        async *events() {
          const turnId = await turn.promise;
          const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
            schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
            sourceEventId: `${identity.runId}:${sourceSeq}`, sourceSeq, runId: identity.runId,
            normalizedSessionId: identity.sessionId, turnId, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
          });
          yield event(1, "turn.started", {});
          yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: reply });
          turn = Promise.withResolvers<string>();
          yield event(3, "turn.completed", { status: "completed" });
        },
        result: async () => {
          const result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
          result.summary = reply;
          result.completionClaim.contractRevision = execution.completionContract.contract.revision;
          return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId: lastTurnId };
        },
        snapshot: async () => ({ backendKind: "mock", sessionId: identity.sessionId, identity,
          providerSessionId: identity.sessionId, cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
        close: async () => {},
      };
      return {
        descriptor: async () => {
          sourceInstanceId = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId)))[0]!.runnerInstanceId!;
          return { kind: "mock", name: "Terminal stop retry provider", version: "1", capabilities,
            runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
        },
        openSession: async input => { identity = input.identity; return session; },
        recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
      };
    };
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime, nativeSessionBackendFactory: backendFactory });
    try {
      await settings.updateExperimental({ enableNativeRunner: true });
      await db.update(companies).set({ defaultResponsibleUserId: "local-board" }).where(eq(companies.id, f.companyId));
      await db.update(agents).set({ adapterType: "paperclip_runner", status: "idle", defaultEnvironmentId: f.environment.id,
        adapterConfig: { provider: "pi_rpc", model: "paperclip/gpt-6.1-sol", sessionContinuity: "continuous", cwd: root,
          lifecycleMode: "warm", idleTimeoutMs: 300_000 },
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
      await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Remember across done and reopen", status: "in_progress",
        assigneeAgentId: f.agentId, responsibleUserId: "local-board", executionWorkspaceId: f.executionWorkspaceId });
      // Start the initial task through heartbeat too: its allocation gets the
      // current runtime fingerprint and its real native checkpoint.
      await db.delete(environmentLeases).where(eq(environmentLeases.id, f.reusableLease.id));
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
      const first = (await heartbeat.invoke(f.agentId, "on_demand", { issueId }, "manual"))!;
      await heartbeat.drainActiveRunExecutions();
      const good = (await heartbeat.getRun(first.id))!;
      expect(good.status, JSON.stringify(good)).toBe("succeeded");
      expect(good.runtimeMode).toBe("native"); expect(good.nativeSessionId).toEqual(expect.any(String));
      expect(submissions).toHaveLength(1);
      expect(call.mock.calls.filter(([, method]) => method === "environmentAcquireLease")).toHaveLength(1);
      const callsBeforeDone = call.mock.calls.length;
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      await runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId, failureReason: "issue_terminal_done" });
      call.mockRejectedValueOnce(new Error("provider stop unavailable"));
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      const pending = (await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, first.id)))[0]!;
      expect(pending).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupInFlight: false } });
      expect(hasStopOnlyCleanup(pending)).toBe(true);
      expect(call.mock.calls.slice(callsBeforeDone).map(([, method]) => method)).toEqual(["environmentStopLease"]);
      expect(Number(pending.metadata?.pendingCleanupRetryAttempts)).toBeGreaterThan(0);
      expect(Number(pending.metadata?.pendingCleanupRetryAfterMs)).toBeGreaterThan(Date.now());
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
      const reopened = (await heartbeat.invoke(f.agentId, "on_demand", { issueId }, "manual"))!;
      await heartbeat.drainActiveRunExecutions();
      const failed = (await heartbeat.getRun(reopened.id))!;
      expect(failed).toMatchObject({ status: "failed", errorCode: "reusable_sandbox_resume_failed", runtimeMode: "legacy",
        nativeSessionId: null, runnerInstanceId: null, resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
      expect(failed.error).toContain("reusable_sandbox_terminal_stop_unsettled");
      expect(submissions).toHaveLength(1);
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, reopened.id));
      expect(retries).toEqual([expect.objectContaining({ status: "scheduled_retry", scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1 })]);
      expect(failedPreparationOwnsBoundedRetry(failed)).toBe(true);
      // Let only the real cleanup owner advance its clock; do not mutate the
      // attempt/in-flight state or settle a receipt by hand.
      await db.update(environmentLeases).set({ metadata: { ...pending.metadata, pendingCleanupRetryAfterMs: 0 } }).where(eq(environmentLeases.id, pending.id));
      await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      const settled = (await environmentService(db).getLeaseById(pending.id))!;
      expect(settled).toMatchObject({ status: "released", cleanupStatus: "success",
        metadata: { remoteExecutionTermination: { state: "stopped", providerLeaseId: pending.providerLeaseId },
          sandboxStopAndRetainReceipt: { method: "environmentStopLease", providerLeaseId: pending.providerLeaseId } } });
      await db.update(heartbeatRuns).set({ scheduledRetryAt: new Date(0) }).where(eq(heartbeatRuns.id, retries[0]!.id));
      expect(await heartbeat.promoteDueScheduledRetries()).toMatchObject({ promoted: 1 });
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      const retried = (await heartbeat.getRun(retries[0]!.id))!;
      expect(retried.status, JSON.stringify(retried)).toBe("succeeded");
      expect(retried.nativeSessionId).toBe(good.nativeSessionId);
      expect(submissions).toEqual([{ runId: first.id, sessionId: good.nativeSessionId, box: pending.providerLeaseId, reply: answer },
        { runId: retried.id, sessionId: good.nativeSessionId, box: pending.providerLeaseId, reply: answer }]);
      // Standard tasks publish their answer in the durable run transcript, not
      // conversation comments. Assert the real event sink received the reply.
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, retried.id));
      const replies = events.filter(event => event.eventType === "item.completed").map(event => event.payload?.prpEvent);
      expect(replies).toEqual([expect.objectContaining({ runId: retried.id, normalizedSessionId: good.nativeSessionId,
        payload: { kind: "agentMessage", channel: "final", text: answer } })]);
      expect(call.mock.calls.slice(callsBeforeDone).some(([, method]) => ["environmentAcquireLease", "environmentDestroyLease"].includes(method))).toBe(false);
      console.log("TERMINAL_HEARTBEAT_RETRY_ROW", JSON.stringify({ firstRunId: first.id, reopenedRunId: failed.id, retryRunId: retried.id,
        pending: { id: pending.id, providerLeaseId: pending.providerLeaseId, status: pending.status, metadata: pending.metadata },
        failed: { id: failed.id, status: failed.status, errorCode: failed.errorCode, error: failed.error, runtimeMode: failed.runtimeMode,
          nativeSessionId: failed.nativeSessionId, runnerInstanceId: failed.runnerInstanceId, executionRecovery: failed.resultJson?.executionRecovery },
        scheduled: { id: retries[0]!.id, status: retries[0]!.status, reason: retries[0]!.scheduledRetryReason, attempt: retries[0]!.scheduledRetryAttempt },
        settled: { status: settled.status, cleanupStatus: settled.cleanupStatus, receipt: settled.metadata?.remoteExecutionTermination,
          stopOnlyReceipt: settled.metadata?.sandboxStopAndRetainReceipt },
        retried: { id: retried.id, status: retried.status, runtimeMode: retried.runtimeMode, nativeSessionId: retried.nativeSessionId },
        failedPreparationOwnsBoundedRetry: failedPreparationOwnsBoundedRetry(failed), submissions, replies, newBoxes: 0 }));
    } finally {
      await heartbeat.drainActiveRunExecutions(); await closeIdleWarmNativeSessionsForRestart(); await settings.updateExperimental(previousSettings);
    }
  }, 90_000);

  it("terminal reopen owns the allocation before provider resume and fences stale terminal cleanup", async () => {
    const f = await terminalConversationFixture();
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    const dispatch = f.call.getMockImplementation()!;
    f.call.mockImplementationOnce(async (id, method, params) => {
      expect(method).toBe("environmentResumeLease");
      const predecessor = (await environmentService(db).getLeaseById(f.lease.id))!;
      const allocation = await db.select().from(environmentLeases).where(eq(environmentLeases.providerLeaseId, f.originalBox));
      const successor = allocation.find(row => row.status === "active")!;
      expect(predecessor).toMatchObject({ status: "expired", heartbeatRunId: f.runId });
      expect(successor.heartbeatRunId).not.toBe(f.runId);
      expect(successor.metadata?.reusableLeasePredecessor).toMatchObject({ previousLeaseId: f.lease.id, previousRunId: f.runId });
      // A stale terminal event racing the provider resume sees the new live
      // allocation owner; it cannot requeue a stop in an unowned release gap.
      expect(await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" })).toEqual([]);
      expect((await environmentService(db).getLeaseById(successor.id))?.status).toBe("active");
      expect(params.lastRun).toMatchObject({ id: f.runId, status: "succeeded" });
      return await dispatch(id, method, params);
    });
    const next = await f.reopen();
    expect(next.next.lease.providerLeaseId).toBe(f.originalBox); expect(next.reply).toBe(f.answer);
    expect(f.call.mock.calls.some(([, method]) => ["environmentAcquireLease", "environmentStopLease", "environmentDestroyLease"].includes(method))).toBe(false);
  }, 40_000);

  it("terminal hold preserves a real pre-existing expiry without inventing a retention deadline", async () => {
    const f = await terminalConversationFixture();
    const priorExpiry = new Date(Date.now() + 86_400_000);
    await db.update(environmentLeases).set({ expiresAt: priorExpiry }).where(eq(environmentLeases.id, f.lease.id));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    const pending = (await environmentService(db).getLeaseById(f.lease.id))!;
    const held = await f.drainStop();
    expect(pending.expiresAt).toEqual(priorExpiry);
    expect(held.expiresAt).toEqual(priorExpiry);
    expect(held.providerLeaseId).toBe(f.originalBox);
    expect((await f.reopen()).reply).toBe(f.answer);
    console.log("TERMINAL_EXPIRY_ROW", JSON.stringify({ leaseId: f.lease.id, priorExpiry: priorExpiry.toISOString(),
      pendingExpiry: pending.expiresAt!.toISOString(), heldExpiry: held.expiresAt!.toISOString() }));
  });

  it.each(["done", "cancelled"] as const)("terminal hold keeps an unsaved Pi conversation on %s and resumes the same session and box after a comment", async status => {
    const f = await terminalConversationFixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    const destroyed = await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId,
      executionWorkspaceId: f.executionWorkspaceId, failureReason: `issue_terminal_${status}` });
    const pending = (await environmentService(db).getLeaseById(f.lease.id))!;
    const held = await f.drainStop();
    const { next, reply, commentId, nextRunId } = await f.reopen();
    const destroys = f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length;
    console.log("TERMINAL_HOLD_ROW", JSON.stringify({ status, runId: f.runId, issueId: f.issueId, sessionId: f.sessionId,
      backupPresent: false, destroys, stops: f.call.mock.calls.filter(([, method]) => method === "environmentStopLease").length,
      heldStatus: held.status, originalBox: f.originalBox, reopenedBox: next.lease.providerLeaseId, reply, answer: f.answer, commentId, nextRunId }));
    expect(destroyed).toEqual([]); expect(destroys).toBe(0);
    expect(pending.status).toBe("pending_cleanup"); expect(pending.failureReason).toBe("sandbox_stop_pending");
    expect(held.status).toBe("released");
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentStopLease")).toHaveLength(1);
    expect(next.lease.providerLeaseId).toBe(f.originalBox); expect(reply).toBe(f.answer);
  });

  it.each(["done", "cancelled"] as const)("terminal hold stops a %s task's box even with a proven backup and reuses its same conversation after a comment", async status => {
    const f = await terminalConversationFixture({ backup: true });
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    const destroyed = await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: `issue_terminal_${status}` });
    expect(destroyed).toHaveLength(0);
    expect((await f.drainStop()).status).toBe("released");
    const { next, reply, commentId } = await f.reopen();
    console.log("TERMINAL_HOLD_ROW", JSON.stringify({ status, issueId: f.issueId, sessionId: f.sessionId, backupPresent: true,
      destroys: f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease").length,
      stops: f.call.mock.calls.filter(([, method]) => method === "environmentStopLease").length,
      originalBox: f.originalBox, reopenedBox: next.lease.providerLeaseId, reply, answer: f.answer, commentId }));
    expect(next.lease.providerLeaseId).toBe(f.originalBox); expect(reply).toBe(f.answer);
  });

  it.each(["no_session", "live_run"] as const)("terminal hold preserves the existing %s behavior", async control => {
    const f = await terminalConversationFixture({ session: control !== "no_session", live: control === "live_run" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const destroyed = await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    expect(destroyed).toHaveLength(control === "no_session" ? 1 : 0);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(control === "no_session" ? 1 : 0);
  });

  it("terminal hold also queues stop-only cleanup from the terminal task finalizer", async () => {
    const f = await terminalConversationFixture();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await db.update(environmentLeases).set({ status: "active" }).where(eq(environmentLeases.id, f.lease.id));
    await f.runtime.releaseRunLeases(f.runId, "released", undefined, "destroy");
    expect((await f.drainStop()).status).toBe("released");
    expect(f.call.mock.calls.some(([, method]) => ["environmentDestroyLease", "environmentReleaseLease"].includes(method))).toBe(false);
    expect((await f.reopen()).reply).toBe(f.answer);
  });

  it.each((["done", "cancelled"] as const).flatMap(status => ["issueId", "nativeIssueId", "context"].map(binding => ({ status, binding }))))(
    "terminal finalizer retains a null-issue lease for a $status run task bound by $binding", async ({ status, binding }) => {
    const f = await terminalConversationFixture();
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    await db.update(environmentLeases).set({ issueId: null, status: "active" }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(heartbeatRuns).set({ issueId: binding === "issueId" ? f.issueId : null,
      nativeIssueId: binding === "nativeIssueId" ? f.issueId : null,
      contextSnapshot: binding === "context" ? { taskId: f.issueId } : null,
    }).where(eq(heartbeatRuns.id, f.runId));
    await f.runtime.releaseRunLeases(f.runId, "released", undefined, "destroy");
    const queued = (await environmentService(db).getLeaseById(f.lease.id))!;
    expect(queued.status).toBe("pending_cleanup");
    expect(queued.metadata?.sandboxStopAndRetain).toMatchObject({ terminalPiSandbox: { priorStatus: "released" } });
    expect((await f.drainStop()).status).toBe("released");
    expect(f.call.mock.calls.some(([, method]) => ["environmentDestroyLease", "environmentReleaseLease"].includes(method))).toBe(false);
    console.log("TERMINAL_NULL_ISSUE_ROW", JSON.stringify({ status, binding, leaseId: f.lease.id, issueId: f.issueId,
      originalBox: f.originalBox, queuedStatus: queued.status, stopIntent: true, destroys: 0 }));
  });

  it.each(["released", "retained"] as const)("terminal hold stops an idle %s box once across repeated cleanup", async status => {
    const f = await terminalConversationFixture();
    await db.update(environmentLeases).set({ status }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    const cleanup = () => f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    expect(await cleanup()).toEqual([]); expect(await cleanup()).toEqual([]);
    const held = await f.drainStop(); expect(held.status).toBe("released");
    expect(await cleanup()).toEqual([]); expect(await cleanup()).toEqual([]);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentStopLease")).toHaveLength(1);
    expect(f.call.mock.calls.some(([, method]) => ["environmentDestroyLease", "environmentReleaseLease"].includes(method))).toBe(false);
    const reopened = await f.reopen(); expect(reopened.next.lease.providerLeaseId).toBe(f.originalBox); expect(reopened.reply).toBe(f.answer);
  });

  it.each(["continuous", "paperclip"] as const)("terminal hold includes Pi %s continuity", async sessionContinuity => {
    const f = await terminalConversationFixture();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc", sessionContinuity } } } }).where(eq(heartbeatRuns.id, f.runId));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    expect((await f.drainStop()).status).toBe("released");
    const reopened = await f.reopen(); expect(reopened.next.lease.providerLeaseId).toBe(f.originalBox); expect(reopened.reply).toBe(f.answer);
  });

  it.each(["failure", "unsupported"] as const)("terminal hold retries %s stop without falling back to delete or release", async fault => {
    const f = await terminalConversationFixture();
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    if (fault === "failure") f.call.mockRejectedValueOnce(new Error("provider stop unavailable"));
    expect((await f.drainStop(f.runId, fault !== "unsupported")).status).toBe("pending_cleanup");
    expect(f.call.mock.calls.some(([, method]) => ["environmentDestroyLease", "environmentReleaseLease"].includes(method))).toBe(false);
    expect((await f.drainStop()).status).toBe("released");
    expect((await f.reopen()).reply).toBe(f.answer);
  });

  it("terminal hold leaves non-Pi sessions on today's destroy path", async () => {
    const f = await terminalConversationFixture();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { provider: { kind: "codex" } } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" })).toHaveLength(1);
    expect(f.call.mock.calls.filter(([, method]) => method === "environmentDestroyLease")).toHaveLength(1);
  });

  it("terminal hold converts an unclaimed terminal-origin retry into stop-only work", async () => {
    const f = await terminalConversationFixture();
    await db.update(environmentLeases).set({ status: "pending_cleanup", failureReason: "issue_terminal_done" }).where(eq(environmentLeases.id, f.lease.id));
    const lease = (await environmentService(db).getLeaseById(f.lease.id))!;
    expect(await f.runtime.isPendingCleanupWorkerReady({ environment: f.environment, lease })).toBe(false);
    const stoppedIntent = (await environmentService(db).getLeaseById(f.lease.id))!;
    expect(await f.runtime.isPendingCleanupWorkerReady({ environment: f.environment, lease: stoppedIntent })).toBe(true);
    expect((await f.drainStop()).status).toBe("released");
    expect(f.call.mock.calls.some(([, method]) => ["environmentDestroyLease", "environmentReleaseLease"].includes(method))).toBe(false);
    expect((await f.reopen()).reply).toBe(f.answer);
  });

  it.each(["stale", "equal_finish", "changed_bytes", "wrong_session", "unfinished"] as const)("terminal hold queues stop without relying on %s backup proof", async fault => {
    const f = await terminalConversationFixture();
    await f.saveBackup(fault === "stale" ? new Date(f.finishedAt.getTime() - 1).toISOString()
      : fault === "equal_finish" ? f.finishedAt.toISOString() : undefined, fault === "wrong_session" ? randomUUID() : undefined);
    if (fault === "changed_bytes") await writeFile(path.join(f.backupRoot, "runner", "conversation.json"), "not the saved conversation");
    if (fault === "unfinished") await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    expect(await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_cancelled" })).toEqual([]);
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  it.each([false, true])("terminal hold does not steal an in-flight terminal cleanup claim (retry=%s)", async retryOwner => {
    const f = await terminalConversationFixture();
    const attemptId = randomUUID();
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await db.update(environmentLeases).set({ status: "pending_cleanup", failureReason: "issue_terminal_done", metadata: { ...f.lease.metadata,
      pendingCleanupAttemptId: attemptId, pendingCleanupInFlight: true, pendingCleanupLeaseExpiresAtMs: Date.now() + 60_000,
    } }).where(eq(environmentLeases.id, f.lease.id));
    const claimed = (await environmentService(db).getLeaseById(f.lease.id))!;
    if (retryOwner) {
      await expect(f.runtime.retryPendingSandboxTeardown({ environment: f.environment, lease: claimed })).rejects.toThrow(/stop-only/);
      const fenced = (await environmentService(db).getLeaseById(f.lease.id))!;
      expect(fenced).toEqual({ ...claimed, metadata: { ...claimed.metadata, terminalPiSandboxOrigin: true } });
      // The old sweep overwrites the reason after a failed attempt; durable
      // provenance must survive that, and must not become ordinary destruction.
      await db.update(environmentLeases).set({ failureReason: "pending_cleanup_retry",
        metadata: { ...fenced.metadata, pendingCleanupInFlight: false } }).where(eq(environmentLeases.id, f.lease.id));
      const retry = (await environmentService(db).getLeaseById(f.lease.id))!;
      expect(await f.runtime.isPendingCleanupWorkerReady({ environment: f.environment, lease: retry })).toBe(false);
      expect((await f.drainStop()).status).toBe("released");
      expect((await f.reopen()).reply).toBe(f.answer);
    } else {
      expect(await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId,
        failureReason: "issue_terminal_done" })).toEqual([]);
      expect(await environmentService(db).getLeaseById(f.lease.id)).toEqual(claimed);
    }
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
  });

  // Regression rows from the terminal-stop review: real PostgreSQL and the
  // production cleanup sweeper; provider/model I/O remains deterministic.
  const chRow = (row: string, data: Record<string, unknown>) => console.log("CH2_ROW", JSON.stringify({ row, ...data }));
  const chCount = (f: any, m: string) => f.call.mock.calls.filter((c: any[]) => c[1] === m).length;
  const chOrder = (f: any) => f.call.mock.calls.map((c: any[]) => String(c[1]).replace("environment", "")).filter((m: string) => m !== "Execute");
  const chSweep = (f: any, rt: any = f.runtime) => heartbeatService(db, { environmentRuntime: rt }).sweepPendingCleanupLeases({ backoffMs: 0 });
  const chReopen = (f: any) => { const t = Date.now(); return f.reopen().then(
    (v: any) => ({ box: v.next.lease.providerLeaseId as string | null, reply: v.reply as string | null, runId: v.nextRunId as string | null, error: null as string | null, ms: Date.now() - t }),
    (e: any) => ({ box: null, reply: null, runId: null, error: String(e?.reason ?? e?.message ?? e), ms: Date.now() - t })); };
  const chLeases = async (f: any) => (await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId)))
    .map(l => ({ id: l.id.slice(0, 8), box: l.providerLeaseId, status: l.status, run: l.heartbeatRunId?.slice(0, 8) ?? null, issue: l.issueId?.slice(0, 8) ?? null,
      stopIntent: !!l.metadata?.sandboxStopAndRetain, inFlight: l.metadata?.pendingCleanupInFlight ?? null,
      attempts: l.metadata?.pendingCleanupRetryAttempts ?? null, attemptIdIsRequestId: l.metadata?.sandboxStopAndRetain ? l.metadata?.pendingCleanupAttemptId === (l.metadata.sandboxStopAndRetain as any).requestId : null, receipt: !!l.metadata?.sandboxStopAndRetainReceipt }));
  const chDue = (f: any) => db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"pendingCleanupRetryAfterMs":0}'::jsonb` })
    .where(eq(environmentLeases.companyId, f.companyId));
  const chTerminal = async (f: any, status: "done" | "cancelled", ageMs: number) => {
    await db.update(issues).set({ status }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ finishedAt: new Date(Date.now() - ageMs) }).where(eq(heartbeatRuns.id, f.runId));
    return await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: `issue_terminal_${status}` });
  };

  it("CH2 PERMFAIL a stop that fails every time: does the task refuse forever?", async () => {
    const f = await terminalConversationFixture();
    await chTerminal(f, "done", 360_000);
    const dispatch = f.call.getMockImplementation()!;
    f.call.mockImplementation(async (id: string, method: string, params: any) => {
      if (method === "environmentStopLease") throw new Error("provider stop permanently failing");
      return await dispatch(id, method, params); });
    const rounds: unknown[] = [];
    for (let i = 0; i < 7; i++) {
      await chDue(f);
      const sweep = await chSweep(f); const r = await chReopen(f);
      rounds.push({ i, sweep, error: r.error, box: r.box, lease: (await chLeases(f)).find(l => l.id === f.lease.id.slice(0, 8)) });
    }
    chRow("PERMFAIL", { originalBox: f.originalBox, rounds, newBoxes: chCount(f, "environmentAcquireLease"), stops: chCount(f, "environmentStopLease"), destroys: chCount(f, "environmentDestroyLease") });
    expect(chCount(f, "environmentAcquireLease")).toBe(0); expect(chCount(f, "environmentDestroyLease")).toBe(0);
    expect(rounds).toHaveLength(7);
    for (const round of rounds as any[]) { expect(round.error).toBe("reusable_sandbox_terminal_stop_unsettled"); expect(round.box).toBeNull(); }
    expect(chCount(f, "environmentStopLease")).toBe(7);
    const notice = buildStrandedRecoveryEscalationNotice({ recoveryActionId: randomUUID(), continuesAutomatically: false, recoveryOwner: null,
      sourceRun: { id: randomUUID(), status: "failed", errorCode: "reusable_sandbox_resume_failed",
        resultJson: { reusableSandboxResumeReason: "reusable_sandbox_terminal_stop_unsettled" } } });
    expect(notice.presentation.title).toBe("Saved sandbox is still being stopped");
    expect(notice.body).toContain("to keep its conversation");
    expect(notice.body).toContain("stop has not finished");
    expect(notice.body).not.toContain("tries again automatically");
  }, 180_000);

  it.each(["undispatched", "backoff"] as const)("CH2 ORDINARY an open task B in the same workspace while done task A's terminal stop is %s", async phase => {
    const f = await terminalConversationFixture();
    await chTerminal(f, "done", 360_000);
    if (phase === "backoff") { f.call.mockRejectedValueOnce(new Error("provider stop unavailable")); await chSweep(f); }
    const issueB = randomUUID(), runB = randomUUID();
    await db.insert(issues).values({ id: issueB, companyId: f.companyId, title: "Ordinary open task B", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: runB, companyId: f.companyId, agentId: f.agentId, issueId: issueB, nativeIssueId: issueB,
      runtimeMode: "native", status: "running", invocationSource: "on_demand" });
    const t = Date.now();
    const r = await f.runtime.acquireRunLease({ ...f.input, issueId: issueB, heartbeatRunId: runB }).then(
      (v: any) => ({ box: v.lease.providerLeaseId, error: null }), (e: any) => ({ box: null, error: String(e?.reason ?? e?.message ?? e) }));
    chRow("ORDINARY", { phase, taskA: f.issueId, taskB: issueB, originalBox: f.originalBox, ...r, ms: Date.now() - t, newBoxes: chCount(f, "environmentAcquireLease"),
      stops: chCount(f, "environmentStopLease"), destroys: chCount(f, "environmentDestroyLease"), leases: await chLeases(f) });
    expect(r.error).toBeNull();
    expect(r.box).not.toBe(f.originalBox);
    const original = (await environmentService(db).getLeaseById(f.lease.id))!;
    expect(original.status).toBe("pending_cleanup");
    expect(original.metadata?.sandboxStopAndRetain).toBeTruthy();
    expect(chCount(f, "environmentDestroyLease")).toBe(0);
  }, 120_000);

  it.each([1, 2, 3])("CH2 TWO one task with two pending terminal stops on two boxes #%s", async () => {
    const f = await terminalConversationFixture();
    const run2 = randomUUID(), lease2 = randomUUID();
    await db.insert(heartbeatRuns).values({ id: run2, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: f.sessionId,
      runtimeMode: "native", status: "succeeded", finishedAt: new Date(Date.now() - 20 * 60_000), invocationSource: "on_demand",
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } }, sessionCheckpoint: { sessionId: f.sessionId } } } as never);
    const [src] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ createdAt: new Date(Date.now() + 1000) }).where(eq(environmentLeases.id, f.lease.id));
    let setup: string | null = null;
    try { await db.insert(environmentLeases).values({ ...src!, id: lease2, heartbeatRunId: run2, providerLeaseId: "second-box-no-conversation", status: "released" }); }
    catch (e) { setup = String((e as Error).message).slice(0, 300); }
    const queued = await chTerminal(f, "done", 360_000);
    const before = await chLeases(f);
    const r1 = await chReopen(f);
    chRow("TWO", { originalBox: f.originalBox, before, r1, exact: r1.reply === f.answer });
    expect(setup).toBeNull(); expect(chCount(f, "environmentAcquireLease")).toBe(0);
    expect(r1.box).toBe(f.originalBox); expect(r1.reply).toBe(f.answer);
  }, 120_000);

  it.each([1, 2, 3])("CH2b TWO clean: two pending terminal stops, reopen, the run ends normally, then a second message #%s", async () => {
    const f = await terminalConversationFixture();
    const run2 = randomUUID(), lease2 = randomUUID();
    await db.insert(heartbeatRuns).values({ id: run2, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, nativeIssueId: f.issueId, nativeSessionId: f.sessionId,
      runtimeMode: "native", status: "succeeded", finishedAt: new Date(Date.now() - 20 * 60_000), invocationSource: "on_demand",
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } }, sessionCheckpoint: { sessionId: f.sessionId } } } as never);
    const [src] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    await db.update(environmentLeases).set({ createdAt: new Date(Date.now() + 1000) }).where(eq(environmentLeases.id, f.lease.id));
    await db.insert(environmentLeases).values({ ...src!, id: lease2, heartbeatRunId: run2, providerLeaseId: "second-box-no-conversation", status: "released" });
    await chTerminal(f, "done", 360_000);
    const before = await chLeases(f);
    const r1 = await chReopen(f);
    await f.runtime.releaseRunLeases(r1.runId!, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, r1.runId!));
    const mid = await chLeases(f);
    const r2 = await chReopen(f);
    chRow("TWO_CLEAN", { originalBox: f.originalBox, sessionId: f.sessionId, before, r1, mid, r2, exact: [r1, r2].map(r => r.reply === f.answer), newBoxes: chCount(f, "environmentAcquireLease"),
      stops: chCount(f, "environmentStopLease"), destroys: chCount(f, "environmentDestroyLease"), order: chOrder(f), leases: await chLeases(f) });
    expect(r1.box).toBe(f.originalBox); expect(r1.reply).toBe(f.answer);
    expect(r2.box).toBe(f.originalBox); expect(r2.reply).toBe(f.answer); expect(chCount(f, "environmentAcquireLease")).toBe(0);
  }, 120_000);


  it.each((["succeeded", "running"] as const).flatMap(status => ["undispatched", "backoff"].map(phase => ({ status, phase }))))(
    "terminal same-run retry fences its own stop ($status, $phase)", async ({ status, phase }) => {
    const f = await terminalConversationFixture();
    await chTerminal(f, "done", 360_000);
    if (phase === "backoff") { f.call.mockRejectedValueOnce(new Error("provider stop unavailable")); await chSweep(f); }
    // Same-run native retry claims reset the finished run to running before
    // workspace preparation, but its pending stop still belongs to that id.
    if (status === "running") await db.update(heartbeatRuns).set({ status, finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    const acquiring = f.runtime.acquireRunLease(f.input);
    if (phase === "backoff") await expect(acquiring).rejects.toMatchObject({ reason: "reusable_sandbox_terminal_stop_unsettled" });
    else {
      const next = await acquiring;
      expect(next.lease.providerLeaseId).toBe(f.originalBox);
      expect((await f.runtime.execute({ environment: f.environment, lease: next.lease, command: "recall" })).stdout).toBe(f.answer);
    }
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
    expect(chCount(f, "environmentDestroyLease")).toBe(0);
  });

  it.each(["missing", "ambiguous"] as const)("terminal reopen refuses a %s durable allocation source", async kind => {
    const f = await terminalConversationFixture();
    if (kind === "missing") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    else {
      const run2 = randomUUID();
      await db.insert(heartbeatRuns).values({ id: run2, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
        nativeIssueId: f.issueId, nativeSessionId: f.sessionId, runtimeMode: "native", status: "succeeded", finishedAt: new Date(),
        invocationSource: "on_demand", runnerProfileJson: { nativeExecutionInput: { provider: { kind: "pi_rpc" } } } } as never);
      const [src] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      const [second] = await db.insert(environmentLeases).values({ ...src!, id: randomUUID(), heartbeatRunId: run2,
        providerLeaseId: "second-durable-box", status: "released" }).returning();
      await f.runtime.execute({ environment: f.environment, lease: (await environmentService(db).getLeaseById(second!.id))!,
        command: "remember", args: ["a different conversation"] });
      await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: run2, agentId: f.agentId,
        seq: 1, eventType: "provider.event", payload: { answer: "a different conversation" } });
    }
    await chTerminal(f, "done", 360_000);
    await chSweep(f);
    const result = await chReopen(f);
    chRow("NON_STOP_CENSUS", { kind, ...result, originalBox: f.originalBox, answer: f.answer });
    // Original names stay for baseline accounting; the required outcome is now
    // the pre-fence path rather than the formerly asserted false refusal.
    expect(result.error).toBeNull();
    expect(result.box).toBe(kind === "missing" ? f.originalBox : "second-durable-box");
    expect(result.reply).toBe(kind === "missing" ? f.answer : "a different conversation");
    expect(chCount(f, "environmentAcquireLease")).toBe(0);
    expect(chCount(f, "environmentDestroyLease")).toBe(0);
  });

  it.each([false, true])("terminal hold rejects an earlier owner's backup after a real lease handoff (same session=%s)", async sameSession => {
    const f = await terminalConversationFixture({ backup: true });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, runtimeMode: "native", status: "running",
      nativeIssueId: f.issueId, nativeSessionId: sameSession ? f.sessionId : randomUUID(), invocationSource: "on_demand" });
    const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: runId });
    expect(next.lease.providerLeaseId).toBe(f.originalBox);
    await f.runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    expect(await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" })).toEqual([]);
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    await f.drainStop(runId);
    const reopened = await f.reopen(); expect(reopened.next.lease.providerLeaseId).toBe(f.originalBox); expect(reopened.reply).toBe(f.answer);
  });

  it.each([false, true])("terminal hold includes earlier allocation sessions after a real lease handoff (new session=%s)", async newSession => {
    const f = await terminalConversationFixture();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, runtimeMode: "native", status: "running",
      nativeIssueId: f.issueId, nativeSessionId: newSession ? randomUUID() : null, invocationSource: "on_demand" });
    const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: runId });
    expect(next.lease.providerLeaseId).toBe(f.originalBox);
    await f.runtime.releaseRunLeases(runId, "released", undefined, "keep_running");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    await f.runtime.destroyReusableSandboxLeases({ companyId: f.companyId, issueId: f.issueId, failureReason: "issue_terminal_done" });
    expect(f.call.mock.calls.some(([, method]) => method === "environmentDestroyLease")).toBe(false);
    await f.drainStop(runId);
    expect((await environmentService(db).getLeaseById(next.lease.id))?.status).toBe("released");
  });

  it.each([
    { status: "active", scope: "workspace" },
    { status: "failed", scope: "workspace" },
    { status: "failed", scope: "issue" },
  ] as const)("destroys $status reusable plugin-backed sandbox leases scoped to an $scope", async ({ status, scope }) => {
    const { pluginId, companyId, runId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    await db
      .update(heartbeatRuns)
      .set({ status: status === "failed" ? "failed" : "succeeded" })
      .where(eq(heartbeatRuns.id, runId));
    if (status === "failed") await environmentService(db).releaseLease(reusableLease.id, "failed");
    const issueId = randomUUID();
    if (scope === "issue") {
      await db.insert(issues).values({ id: issueId, companyId, title: "Failed reusable lease cleanup", status: "done", priority: "medium" });
      await db.update(environmentLeases).set({ issueId }).where(eq(environmentLeases.id, reusableLease.id));
    }
    const selection = scope === "issue" ? { issueId } : { executionWorkspaceId };

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    // A known issue/workspace id does not authorize another company's teardown.
    expect(await runtimeWithPlugin.destroyReusableSandboxLeases({ companyId: randomUUID(), ...selection })).toEqual([]);
    expect(workerManager.call).not.toHaveBeenCalled();
    const destroyed = await runtimeWithPlugin.destroyReusableSandboxLeases({
      companyId,
      ...selection,
      failureReason: "execution_workspace_closed",
    });

    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]?.lease.id).toBe(reusableLease.id);
    expect(destroyed[0]?.lease.status).toBe("expired");
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "success",
    });
  });

  it.each(["active", "failed"] as const)("does not destroy a %s scoped reusable lease while its run is active", async (status) => {
    const { pluginId, companyId, executionWorkspaceId, reusableLease } =
      await seedReusablePluginSandboxLease();
    if (status === "failed") await environmentService(db).releaseLease(reusableLease.id, "failed");
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => undefined),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentDestroyLease",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });

    const destroyed = await runtimeWithPlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "issue_terminal_done",
    });

    expect(destroyed).toEqual([]);
    expect(workerManager.call).not.toHaveBeenCalled();
    await expect(
      environmentService(db).getLeaseById(reusableLease.id),
    ).resolves.toMatchObject({ status });
  });

  it.each(["issue", "workspace", "environment", "run"] as const)(
    "durably claims failed reusable cleanup before %s teardown and recovers a provider failure",
    async (scope) => {
      const seeded = await seedReusablePluginSandboxLease();
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
      if (scope !== "run") await environmentService(db).releaseLease(seeded.reusableLease.id, "failed");
      const issueId = randomUUID();
      if (scope === "issue") {
        await db.insert(issues).values({ id: issueId, companyId: seeded.companyId, title: "Cleanup crash window", status: "done" });
        await db.update(environmentLeases).set({ issueId }).where(eq(environmentLeases.id, seeded.reusableLease.id));
      }
      let enterProvider!: () => void;
      let finishProvider!: () => void;
      const entered = new Promise<void>((resolve) => { enterProvider = resolve; });
      const finish = new Promise<void>((resolve) => { finishProvider = resolve; });
      let unavailable = true;
      const call = vi.fn(async (_id: string, method: string) => {
        if (method !== "environmentDestroyLease") throw new Error(`Unexpected method ${method}`);
        if (unavailable) {
          enterProvider();
          await finish;
          throw new Error("Provider response lost");
        }
        return { providerLeaseId: seeded.reusableLease.providerLeaseId, state: "destroyed" };
      });
      const makeRuntime = () => environmentRuntimeService(db, { pluginWorkerManager: {
        isRunning: () => true, call,
        getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }),
      } as unknown as PluginWorkerManager });
      const runtime = makeRuntime();
      const close = (service: ReturnType<typeof makeRuntime>) => scope === "run"
        ? service.releaseRunLeases(seeded.runId, "released", undefined, "destroy")
        : scope === "environment"
        ? service.destroyReusableSandboxLeasesForEnvironment({ environmentId: seeded.environment.id })
        : service.destroyReusableSandboxLeases({ companyId: seeded.companyId,
          ...(scope === "issue" ? { issueId } : { executionWorkspaceId: seeded.executionWorkspaceId }) });
      const closing = close(runtime);
      try {
        await entered;
        // This independently persisted row is what survives controller loss
        // during the provider call. No provider receipt has arrived yet.
        expect(await environmentService(db).getLeaseById(seeded.reusableLease.id)).toMatchObject({
          status: "pending_cleanup", cleanupStatus: "failed", companyId: seeded.companyId,
          providerLeaseId: seeded.reusableLease.providerLeaseId,
          metadata: { pendingCleanupAttemptId: expect.any(String), pendingCleanupInFlight: true,
            pendingCleanupLeaseExpiresAtMs: expect.any(Number) },
        });
        await close(makeRuntime());
        expect(await heartbeatService(db, { environmentRuntime: makeRuntime() }).sweepPendingCleanupLeases({ backoffMs: 0 }))
          .toEqual({ swept: 0, destroyed: 0, capped: 0 });
        expect(call).toHaveBeenCalledOnce();
      } finally {
        finishProvider();
        await closing;
      }
      expect(await environmentService(db).getLeaseById(seeded.reusableLease.id)).toMatchObject({
        status: "pending_cleanup", metadata: { pendingCleanupInFlight: false },
      });
      unavailable = false;
      expect(await heartbeatService(db, { environmentRuntime: makeRuntime() }).sweepPendingCleanupLeases({ backoffMs: 0 }))
        .toEqual({ swept: 1, destroyed: 1, capped: 0 });
      expect(call).toHaveBeenCalledTimes(2);
      expect(await environmentService(db).getLeaseById(seeded.reusableLease.id)).toMatchObject({
        status: "expired", cleanupStatus: "success", metadata: { remoteExecutionTermination: { state: "destroyed" } },
      });
    },
  );

  it("retries a run-release teardown at the next sweep after the releasing server dies", async () => {
    // Shape of a chaos incident: the run finished, its release claimed the lease
    // and called the provider, and the server was SIGKILLed before the reply.
    const seeded = await seedReusablePluginSandboxLease();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, seeded.runId));
    let enterProvider!: () => void;
    let finishProvider!: () => void;
    const entered = new Promise<void>((resolve) => { enterProvider = resolve; });
    const finish = new Promise<void>((resolve) => { finishProvider = resolve; });
    let serverAlive = true;
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentDestroyLease") throw new Error(`Unexpected method ${method}`);
      if (serverAlive) {
        enterProvider();
        await finish;
        throw new Error("Server stopped");
      }
      return { providerLeaseId: seeded.reusableLease.providerLeaseId, state: "destroyed" };
    });
    const makeRuntime = () => environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call,
      getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const closing = makeRuntime().releaseRunLeases(seeded.runId, "released", undefined, "destroy");
    try {
      await entered;
      const claimed = (await environmentService(db).getLeaseById(seeded.reusableLease.id))!;
      expect(claimed).toMatchObject({ status: "pending_cleanup", metadata: { pendingCleanupInFlight: true } });
      const attemptId = claimed.metadata?.pendingCleanupAttemptId;
      // The releasing server exits: its recorded process is gone. Mark it as an
      // earlier boot whose PID has exited, as a restarted server observes it.
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise(resolve => child.once("exit", resolve));
      const recorded = claimed.metadata?.pendingCleanupController as Record<string, unknown> | undefined;
      expect(recorded).toMatchObject({ attemptId });
      await db.update(environmentLeases).set({ metadata: { ...claimed.metadata,
        pendingCleanupController: { ...recorded, bootId: randomUUID(), pid: child.pid } } })
        .where(eq(environmentLeases.id, claimed.id));
      serverAlive = false;

      const restarted = heartbeatService(db, { environmentRuntime: makeRuntime() });
      expect(await restarted.sweepPendingCleanupLeases({ backoffMs: 0 })).toEqual({ swept: 1, destroyed: 1, capped: 0 });
      const settled = (await environmentService(db).getLeaseById(claimed.id))!;
      expect(settled).toMatchObject({ status: "expired", cleanupStatus: "success" });
      // The interrupted release was not a failed teardown attempt.
      expect(settled.metadata?.pendingCleanupRetryAttempts).toBe(1);
    } finally {
      finishProvider();
      await closing.catch(() => undefined);
    }
  });

  it.each([false, true])("preserves a newer destroy receipt when an old run cleanup returns (failure=%s)", async failure => {
    const seeded = await seedReusablePluginSandboxLease();
    const service = environmentService(db);
    let confirmed: Awaited<ReturnType<typeof service.getLeaseById>>;
    const call = vi.fn(async (_id: string, method: string) => {
      if (method !== "environmentDestroyLease") throw new Error(`Unexpected method ${method}`);


      const current = (await service.getLeaseById(seeded.reusableLease.id))!;
      const attemptId = randomUUID();
      await db.update(environmentLeases).set({ status: "pending_cleanup",
        metadata: { ...current.metadata, pendingCleanupAttemptId: attemptId },
      }).where(eq(environmentLeases.id, current.id));
      confirmed = await service.releaseLease(current.id, "expired", { expectedPendingCleanupAttemptId: attemptId,
        cleanupStatus: "success", remoteExecutionTermination: remoteTerminationReceipt(current,
          { providerLeaseId: current.providerLeaseId, state: "destroyed" }),
      });
      if (failure) throw new Error("Late failure from the old provider request");
      return { providerLeaseId: current.providerLeaseId, state: "destroyed" };
    });
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    await expect(runtime.releaseRunLeases(seeded.runId, "released", undefined, "destroy")).resolves.toEqual([]);
    expect(call).toHaveBeenCalledOnce();
    expect(confirmed!).toMatchObject({ status: "expired", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { state: "destroyed" } } });
    expect(await service.getLeaseById(seeded.reusableLease.id)).toEqual(confirmed!);
  });

  it.each(["queued", "scheduled_retry", "running"] as const)(
    "fences scoped cleanup when its holding run becomes %s after selection", async (status) => {
      const seeded = await seedReusablePluginSandboxLease();
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, seeded.runId));
      await environmentService(db).releaseLease(seeded.reusableLease.id, "failed");
      const originalService = environmentsModule.environmentService;
      const serviceSpy = vi.spyOn(environmentsModule, "environmentService").mockImplementation((client) => {
        const service = originalService(client);
        return { ...service, getById: async (id: string) => {
          const environment = await service.getById(id);
          if (id === seeded.environment.id) {
            await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, seeded.runId));
          }
          return environment;
        } };
      });
      const call = vi.fn(async () => undefined);
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
        isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentDestroyLease"] }),
      } as unknown as PluginWorkerManager });
      try {
        expect(await runtime.destroyReusableSandboxLeases({ companyId: seeded.companyId,
          executionWorkspaceId: seeded.executionWorkspaceId })).toEqual([]);
        expect(call).not.toHaveBeenCalled();
        expect(await originalService(db).getLeaseById(seeded.reusableLease.id)).toMatchObject({ status: "failed" });
      } finally {
        serviceSpy.mockRestore();
      }
    },
  );

  it("destroys reusable plugin-backed sandbox leases scoped to an environment", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    // The holding run is finished, so the reservation is stale and destroyable.
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return { providerLeaseId: reusableLease.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const result = await runtimeWithPlugin.destroyReusableSandboxLeasesForEnvironment({
      environmentId: reusableLease.environmentId!,
      failureReason: "environment_deleted",
    });

    expect(result).toEqual({ destroyed: 1, failed: 0, skippedLiveRun: 0 });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "environment_deleted",
      cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { schema: "paperclip.remote-termination.v1",
        leaseId: reusableLease.id, runId, providerLeaseId: reusableLease.providerLeaseId, state: "destroyed" } },
    });
  });

  it("destroys a retained restore-source sandbox (retain_on_failure) when its environment is deleted", async () => {
    const { pluginId, runId, reusableLease } = await seedReusablePluginSandboxLease();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
    // A failed run's sandbox kept, stopped, as a workspace-restore source. The
    // restore marker protects it from every ordinary teardown.
    await db.update(environmentLeases).set({ leasePolicy: "retain_on_failure", status: "released", cleanupStatus: "success",
      releasedAt: new Date(), metadata: { ...reusableLease.metadata,
        workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", runId } } })
      .where(eq(environmentLeases.id, reusableLease.id));
    expect(await environmentService(db).getDeleteBlastRadius(reusableLease.environmentId!))
      .toMatchObject({ reusableSandboxLeaseCount: 1, canDelete: false,
        reusableSandboxLeaseHolders: [expect.objectContaining({ leasePolicy: "retain_on_failure" })] });
    // The atomic delete guard refuses too, not only the blast-radius pre-check.
    expect(await environmentService(db).removeIfDeletable(reusableLease.environmentId!)).toBeFalsy();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") return { providerLeaseId: reusableLease.providerLeaseId, state: "destroyed" };
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    // The operator consented to deleting the environment and the files only
    // this sandbox holds: that consent releases the restore protection.
    const result = await environmentRuntimeService(db, { pluginWorkerManager: workerManager })
      .destroyReusableSandboxLeasesForEnvironment({ environmentId: reusableLease.environmentId!, failureReason: "environment_deleted",
        consentedBy: "board-user" });
    expect(result).toEqual({ destroyed: 1, failed: 0, skippedLiveRun: 0 });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", expect.anything(), expect.anything());
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired", failureReason: "environment_deleted", cleanupStatus: "success" });
  });

  it("destroys a failed reusable sandbox after successful release before deleting its environment", async () => {
    const { pluginId, companyId, runId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentReleaseLease") {
          return { providerLeaseId: reusableLease.providerLeaseId, state: "stopped" };
        }
        if (method === "environmentDestroyLease") {
          // The provider call must already have a durable cleanup reference.
          expect(await environmentService(db).getLeaseById(reusableLease.id)).toMatchObject({
            status: "pending_cleanup", environmentId: environment.id,
          });
          return { providerLeaseId: reusableLease.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));

    const released = await runtimeWithPlugin.releaseRunLeases(runId, "failed", undefined, undefined, true);
    expect(released[0]?.lease).toMatchObject({
      id: reusableLease.id, status: "failed", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { state: "stopped" } },
    });
    const result = await runtimeWithPlugin.destroyReusableSandboxLeasesForEnvironment({
      environmentId: environment.id, failureReason: "environment_deleted",
    });
    expect(result).toEqual({ destroyed: 1, failed: 0, skippedLiveRun: 0 });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease",
      expect.objectContaining({ companyId, environmentId: environment.id, providerLeaseId: reusableLease.providerLeaseId }),
      31234);
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired", cleanupStatus: "success",
      metadata: { remoteExecutionTermination: { state: "destroyed" } },
    });
    expect((await environmentService(db).removeIfDeletable(environment.id))?.id).toBe(environment.id);
  });

  it.each(["active", "failed"] as const)("keeps a %s reusable lease held by an in-flight run out of the environment-scoped destroy", async (status) => {
    const { pluginId, reusableLease } = await seedReusablePluginSandboxLease();
    // seedEnvironment leaves the holding run in `running` status.
    if (status === "failed") await environmentService(db).releaseLease(reusableLease.id, "failed");

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async () => undefined),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const result = await runtimeWithPlugin.destroyReusableSandboxLeasesForEnvironment({
      environmentId: reusableLease.environmentId!,
      failureReason: "environment_deleted",
    });

    expect(result).toEqual({ destroyed: 0, failed: 0, skippedLiveRun: 1 });
    expect(workerManager.call).not.toHaveBeenCalled();
    // The lease keeps its reusable status, so the delete guard still blocks.
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status,
      leasePolicy: "reuse_by_environment",
    });
  });

  it("sweeps reusable cleanup with the configuration recorded on the lease", async () => {
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    const environmentsSvc = environmentService(db);
    await environmentsSvc.releaseLease(reusableLease.id, "pending_cleanup", {
      failureReason: "release_cleanup_failed",
      cleanupStatus: "failed",
    });

    // Re-point the environment after the reusable sandbox was provisioned.
    // The pending-cleanup sweep still enters destroyRunLease because the
    // environment exists, but destroy must target the provider and config
    // captured on the lease rather than this current configuration.
    await environmentsSvc.update(environment.id, {
      config: {
        provider: "replacement-provider",
        image: "replacement:test",
        timeoutMs: 9999,
        reuseLease: true,
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") return undefined;
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({
        supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const heartbeat = heartbeatService(db, { environmentRuntime: runtimeWithPlugin });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toEqual({ swept: 1, destroyed: 1, capped: 0 });
    expect(workerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        environmentId: environment.id,
        providerLeaseId: "reusable-plugin-lease",
        config: expect.objectContaining({
          image: "fake:test",
          timeoutMs: 1234,
          reuseLease: true,
        }),
      }),
      31234,
    );
    const destroyInput = vi.mocked(workerManager.call).mock.calls[0]?.[2] as {
      config?: Record<string, unknown>;
    };
    expect(destroyInput.config).not.toMatchObject({
      image: "replacement:test",
      timeoutMs: 9999,
    });
    await expect(environmentsSvc.getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      cleanupStatus: "success",
    });
  });

  it("retries reusable plugin-backed sandbox destroy when the worker is unavailable", async () => {
    const { pluginId, companyId, executionWorkspaceId, runId, reusableLease } =
      await seedReusablePluginSandboxLease();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const offlineWorkerManager = {
      isRunning: vi.fn(() => false),
      call: vi.fn(),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithOfflinePlugin = environmentRuntimeService(db, {
      pluginWorkerManager: offlineWorkerManager,
    });

    const pending = await runtimeWithOfflinePlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "execution_workspace_closed",
    });

    expect(pending).toHaveLength(1);
    expect(pending[0]?.lease.id).toBe(reusableLease.id);
    expect(pending[0]?.lease.status).toBe("pending_cleanup");
    expect(offlineWorkerManager.call).not.toHaveBeenCalled();
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "pending_cleanup",
      failureReason: "execution_workspace_closed",
      cleanupStatus: "failed",
    });

    const recoveredWorkerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentDestroyLease") {
          return undefined;
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithRecoveredPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: recoveredWorkerManager,
    });

    const retried = await runtimeWithRecoveredPlugin.destroyReusableSandboxLeases({
      companyId,
      executionWorkspaceId,
      failureReason: "cleanup_retry",
    });

    expect(retried).toHaveLength(1);
    expect(retried[0]?.lease.id).toBe(reusableLease.id);
    expect(retried[0]?.lease.status).toBe("expired");
    expect(recoveredWorkerManager.call).toHaveBeenCalledWith(
      pluginId,
      "environmentDestroyLease",
      expect.objectContaining({
        driverKey: "fake-plugin",
        providerLeaseId: "reusable-plugin-lease",
      }),
      31234,
    );
    await expect(environmentService(db).getLeaseById(reusableLease.id)).resolves.toMatchObject({
      status: "expired",
      failureReason: "cleanup_retry",
      cleanupStatus: "success",
    });
  });

  it("resolves effective capabilities from the lease's exact plugin, not an earlier plugin that shares the driver key", async () => {
    // The helper seeds the plugin that owns the lease. Pin it to `pluginId`
    // through the lease metadata and give it a lower-priority sibling.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();

    // Rewrite the owner plugin so it DENIES reusable leases through the nested
    // capability declaration.
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "acme.reusable-sandbox-provider",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Reusable Sandbox Provider",
          description: "Owner plugin that denies reusable leases",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [
            {
              driverKey: "fake-plugin",
              kind: "sandbox_provider",
              displayName: "Fake Plugin",
              sandboxCapabilities: { reusableLeases: false },
              configSchema: { type: "object", properties: {} },
            },
          ],
        },
        updatedAt: new Date(),
      } as any)
      .where(eq(plugins.id, pluginId));

    // Install an EARLIER plugin that shares the driver key and grants reusable
    // leases. It is not ready and never acquired this lease. A resolver keyed by
    // driver key alone would read this declaration and grant a capability the
    // owner plugin denied.
    const collidingPluginId = randomUUID();
    await insertSandboxProviderPlugin(collidingPluginId, {
      pluginKey: "acme.colliding-sandbox-provider",
      packageName: "@acme/colliding-sandbox-provider",
      displayName: "Colliding Sandbox Provider",
      description: "Earlier plugin that shares the driver key",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          kind: "sandbox_provider",
          displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: { type: "object", properties: {} },
        },
      ],
      status: "installed",
      installOrder: 0,
    });

    // The owner worker verifies the reuse verbs and the sync verbs, so every
    // capability is verified. Only the owner's declaration can narrow one.
    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(),
      getWorker: vi.fn((id: string) =>
        id === pluginId
          ? {
              supportedMethods: [
                "environmentResumeLease",
                "environmentReleaseLease",
                "environmentSyncIn",
                "environmentSyncOut",
              ],
            }
          : undefined,
      ),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    expect(reusableLease.metadata?.pluginId).toBe(pluginId);

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    // The runtime read the owner plugin's declaration, so it denies reusable
    // leases even though the earlier plugin grants them.
    expect(effective?.reusableLeases).toBe(false);
    // The owner plugin does not restrict native sync, and its worker verifies
    // the sync verbs, so those stay granted. This proves the resolver read the
    // owner declaration and did not fail every capability closed.
    expect(effective?.nativeSyncIn).toBe(true);
    expect(effective?.nativeSyncOut).toBe(true);
  });

  it("fails every effective capability closed when the pinned plugin id is absent from the registry", async () => {
    // The lease pins a plugin id, but that plugin record is gone. A stale worker
    // entry still advertises every method. The runtime must not read the stale
    // methods; it must fail closed because the exact-plugin identity is gone.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    await db.delete(plugins).where(eq(plugins.id, pluginId));

    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentExecute",
          "environmentSyncIn",
          "environmentSyncOut",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    for (const key of SANDBOX_CAPABILITY_KEYS) {
      expect(effective?.[key]).toBe(false);
    }
  });

  it("fails every effective capability closed when the pinned plugin no longer declares this provider key", async () => {
    // The pinned plugin still exists, but it no longer declares a
    // `sandbox_provider` driver with this key (here it changed the driver kind).
    // A running worker still advertises every method. The runtime must fail
    // closed because the exact-plugin declaration is gone.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "acme.reusable-sandbox-provider",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Reusable Sandbox Provider",
          description: "Owner plugin that no longer declares the provider key",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [
            {
              driverKey: "fake-plugin",
              // The key exists, but the kind is now a plain environment driver,
              // not a sandbox provider. The by-id resolver fails closed.
              kind: "environment_driver",
              displayName: "Fake Plugin",
              configSchema: { type: "object", properties: {} },
            },
          ],
        },
        updatedAt: new Date(),
      } as any)
      .where(eq(plugins.id, pluginId));

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(),
      getWorker: vi.fn(() => ({
        supportedMethods: [
          "environmentResumeLease",
          "environmentReleaseLease",
          "environmentExecute",
          "environmentSyncIn",
          "environmentSyncOut",
        ],
      })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    for (const key of SANDBOX_CAPABILITY_KEYS) {
      expect(effective?.[key]).toBe(false);
    }
  });

  it("defers to verified worker discovery for a valid pinned plugin that omits sandboxCapabilities", async () => {
    // A valid, identified plugin whose manifest declares no `sandboxCapabilities`
    // and no legacy reuse flag. Its worker verifies the sync verbs. An omitted
    // declaration is NOT an identity failure: the runtime defers to the verified
    // baseline, so native sync stays granted while unverified capabilities stay
    // false.
    const { pluginId, environment, reusableLease } = await seedReusablePluginSandboxLease();
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "acme.reusable-sandbox-provider",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Reusable Sandbox Provider",
          description: "Owner plugin that omits the capability declaration",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["environment.drivers.register"],
          entrypoints: { worker: "dist/worker.js" },
          environmentDrivers: [
            {
              driverKey: "fake-plugin",
              kind: "sandbox_provider",
              displayName: "Fake Plugin",
              configSchema: { type: "object", properties: {} },
            },
          ],
        },
        updatedAt: new Date(),
      } as any)
      .where(eq(plugins.id, pluginId));

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(),
      getWorker: vi.fn((id: string) =>
        id === pluginId
          ? { supportedMethods: ["environmentSyncIn", "environmentSyncOut"] }
          : undefined,
      ),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const effective = await runtimeWithPlugin.resolveCapabilities({
      environment,
      lease: reusableLease,
    });

    // The worker verified the sync verbs and the omitted declaration adds no
    // restriction, so native sync stays granted.
    expect(effective?.nativeSyncIn).toBe(true);
    expect(effective?.nativeSyncOut).toBe(true);
    // The worker did not verify the reuse verbs, so reusable leases stay false.
    expect(effective?.reusableLeases).toBe(false);
  });

  it("releases a sandbox run lease from metadata after the environment config changes", async () => {
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "sandbox",
      name: "Fake Sandbox",
      config: {
        provider: "fake",
        image: "ubuntu:24.04",
        reuseLease: true,
      },
    });

    const acquired = await runtime.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtime.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(released[0]?.lease.id).toBe(acquired.lease.id);
    expect(released[0]?.lease.status).toBe("released");
  });

  it("does not reuse a sandbox lease owned by a different agent for the same execution workspace", async () => {
    const { companyId, agentId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });
    const otherAgentId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const pluginId = randomUUID();
    const projectId = randomUUID();

    await insertReusableProject(projectId, companyId);
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Existing workspace",
      status: "active",
      providerType: "local_fs",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      displayName: "Acme Environments",
      description: "Test plugin environment driver",
      author: "Acme",
    });

    await environmentService(db).acquireLease({
      companyId,
      environmentId: environment.id,
      executionWorkspaceId,
      heartbeatRunId: runId,
      leasePolicy: "reuse_by_environment",
      provider: "fake-plugin",
      providerLeaseId: "other-agent-lease",
      metadata: {
        agentId,
        provider: "fake-plugin",
        template: "base",
        reuseLease: true,
      },
    });

    const workerManager = {
      isRunning: vi.fn((id: string) => id === pluginId),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "fresh-agent-lease",
            metadata: {
              provider: "fake-plugin",
              template: "base",
              reuseLease: true,
            },
          };
        }
        throw new Error(`Unexpected plugin method: ${method}`);
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      agentId: otherAgentId,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: {
        id: executionWorkspaceId,
        mode: "shared_workspace",
      },
    });

    expect(acquired.lease.providerLeaseId).toBe("fresh-agent-lease");
    expect(workerManager.call).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      agentId: otherAgentId,
      executionWorkspaceId,
    }));
  });

  it.each([undefined, 300_000])("delegates plugin environment leases with acquisition budget %s", async (defaultAcquireTimeoutMs) => {
    const pluginId = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-1",
            expiresAt,
            metadata: {
              driver: "local",
              pluginId: "provider-plugin-id",
              pluginKey: "provider.plugin",
              driverKey: "provider-driver",
              executionWorkspaceMode: "provider-mode",
              provider: "test-provider",
              remoteCwd: "/workspace",
            },
          };
        }
        return undefined;
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      displayName: "Acme Environments",
      description: "Test plugin environment driver",
      author: "Acme",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          displayName: "Fake plugin",
          defaultAcquireTimeoutMs,
          configSchema: { type: "object" },
        },
      ],
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", {
      creationOperationId: expect.any(String),
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      executionWorkspaceId: undefined,
      executionWorkspaceSettings: null,
      issueId: null,
      config: { template: "base" },
      agentId: undefined,
      adapterType: undefined,
      runId,
      workspaceMode: undefined,
    }, ...(defaultAcquireTimeoutMs === undefined ? [] : [330_000]));
    expect(vi.mocked(workerManager.call).mock.calls.find(([, method]) => method === "environmentAcquireLease")?.[2])
      .not.toHaveProperty("runnerLifecyclePolicy");
    expect(acquired.lease.providerLeaseId).toBe("plugin-lease-1");
    expect(acquired.lease.expiresAt?.toISOString()).toBe(expiresAt);
    expect(acquired.lease.metadata).toMatchObject({
      driver: "plugin",
      pluginId,
      pluginKey: "acme.environments",
      driverKey: "fake-plugin",
      executionWorkspaceMode: null,
      providerMetadata: {
        driver: "local",
        pluginId: "provider-plugin-id",
        pluginKey: "provider.plugin",
        driverKey: "provider-driver",
        executionWorkspaceMode: "provider-mode",
        provider: "test-provider",
        remoteCwd: "/workspace",
      },
    });

    await db.delete(environments).where(eq(environments.driver, "local"));
    await environmentService(db).update(environment.id, {
      driver: "local",
      config: {},
    });

    const released = await runtimeWithPlugin.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentReleaseLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: {},
      providerLeaseId: "plugin-lease-1",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
        providerMetadata: expect.objectContaining({
          driver: "local",
        }),
      }),
    });
    expect(released[0]?.lease).toMatchObject({ status: "released", cleanupStatus: "success" });
  });

  async function seedPluginDriverEnvironment(pluginId: string) {
    const seeded = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Fake plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: { template: "base" },
      },
    });
    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      displayName: "Acme Environments",
      description: "Test plugin environment driver",
      author: "Acme",
      environmentDrivers: [
        { driverKey: "fake-plugin", displayName: "Fake plugin", configSchema: { type: "object" } },
      ],
    });
    return seeded;
  }

  it("forwards a requested expiry to the acquire RPC and records only a provider-attested expiry", async () => {
    const pluginId = randomUUID();
    let receivedRequestedExpiresAt: unknown;
    let receivedPurpose: unknown, receivedCommand: unknown;
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string, params: Record<string, unknown>) => {
        if (method === "environmentAcquireLease") {
          receivedRequestedExpiresAt = params.requestedExpiresAt;
          receivedPurpose = params.purpose; receivedCommand = params.loginCommandKey;
          // The provider grants no expiry.
          return { providerLeaseId: "plugin-lease-no-expiry", metadata: { remoteCwd: "/workspace" } };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { companyId, environment, runId } = await seedPluginDriverEnvironment(pluginId);

    const requestedExpiresAt = new Date(Date.now() + 60_000);
    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
      requestedExpiresAt,
      purpose: "login", loginCommandKey: "codex",
    });

    // The acquire RPC receives the requested expiry as an ISO 8601 string.
    expect(receivedRequestedExpiresAt).toBe(requestedExpiresAt.toISOString());
    expect(receivedPurpose).toBe("login"); expect(receivedCommand).toBe("codex");
    // The provider gave no expiry, so the lease row records no expiry. The runtime
    // never synthesizes the requested deadline as evidence of provider enforcement.
    expect(acquired.lease.expiresAt ?? null).toBeNull();
  });

  it("records the real provider expiry when the provider grants one later than the requested deadline", async () => {
    const pluginId = randomUUID();
    const providerExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-later",
            expiresAt: providerExpiresAt,
            metadata: { remoteCwd: "/workspace" },
          };
        }
        return undefined;
      }),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, { pluginWorkerManager: workerManager });
    const { companyId, environment, runId } = await seedPluginDriverEnvironment(pluginId);

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
      requestedExpiresAt: new Date(Date.now() + 60_000),
    });

    // The lease row records the real provider expiry, not the requested deadline.
    // The caller then verifies the expiry bounds its deadline and fails closed.
    expect(acquired.lease.expiresAt?.toISOString()).toBe(providerExpiresAt);
  });

  it("delegates the full plugin environment lifecycle through the worker manager", async () => {
    const pluginId = randomUUID();
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string) => {
        if (method === "environmentAcquireLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              remoteCwd: "/workspace",
            },
          };
        }
        if (method === "environmentResumeLease") {
          return {
            providerLeaseId: "plugin-lease-full",
            metadata: {
              resumed: true,
            },
          };
        }
        if (method === "environmentRealizeWorkspace") {
          return {
            cwd: "/workspace/project",
            metadata: {
              realized: true,
            },
          };
        }
        if (method === "environmentExecute") {
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "ok\n",
            stderr: "",
            metadata: {
              commandId: "cmd-1",
            },
          };
        }
        return undefined;
      }),
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    const runtimeWithPlugin = environmentRuntimeService(db, {
      pluginWorkerManager: workerManager,
    });
    const { companyId, environment, runId } = await seedEnvironment({
      driver: "plugin",
      name: "Plugin Full Lifecycle",
      config: {
        pluginKey: "acme.environments",
        driverKey: "fake-plugin",
        driverConfig: {
          template: "base",
        },
      },
    });

    await insertSandboxProviderPlugin(pluginId, {
      pluginKey: "acme.environments",
      packageName: "@acme/paperclip-environments",
      displayName: "Acme Environments",
      description: "Test plugin environment driver",
      author: "Acme",
      environmentDrivers: [
        {
          driverKey: "fake-plugin",
          displayName: "Fake plugin",
          configSchema: { type: "object" },
        },
      ],
    });

    const acquired = await runtimeWithPlugin.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });
    const resumed = await runtimeWithPlugin.resumeRunLease({
      environment,
      lease: acquired.lease,
    });
    const realized = await runtimeWithPlugin.realizeWorkspace({
      environment,
      lease: acquired.lease,
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    });
    const executed = await runtimeWithPlugin.execute({
      environment,
      lease: acquired.lease,
      command: "echo",
      args: ["ok"],
      cwd: realized.cwd,
      env: { FOO: "bar" },
      stdin: "",
      timeoutMs: 1000,
    });
    const destroyed = await runtimeWithPlugin.destroyRunLease({
      environment,
      lease: acquired.lease,
    });

    expect(resumed).toMatchObject({
      providerLeaseId: "plugin-lease-full",
      metadata: {
        resumed: true,
      },
    });
    expect(realized).toEqual({
      cwd: "/workspace/project",
      metadata: {
        realized: true,
      },
    });
    expect(executed).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "ok\n",
    });
    expect(destroyed).toMatchObject({ status: "failed", cleanupStatus: "success" });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentResumeLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentRealizeWorkspace", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      config: { template: "base" },
      workspace: {
        localPath: "/tmp/project",
        mode: "ephemeral",
      },
    }));
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentExecute", expect.objectContaining({
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      command: "echo",
      args: ["ok"],
      cwd: "/workspace/project",
      env: { FOO: "bar" },
    }), 31000);
    expect(workerManager.call).toHaveBeenCalledWith(pluginId, "environmentDestroyLease", {
      driverKey: "fake-plugin",
      companyId,
      environmentId: environment.id,
      issueId: null,
      config: { template: "base" },
      providerLeaseId: "plugin-lease-full",
      leaseMetadata: expect.objectContaining({
        driver: "plugin",
        pluginId,
      }),
    });
  });

  it("releases with the driver captured on the lease even if the environment driver changes later", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);
    const localRelease = vi.fn(async ({ lease, status }: { lease: { id: string }; status: "released" | "expired" | "failed" }) =>
      await environmentsSvc.releaseLease(lease.id, status)
    );
    const sshRelease = vi.fn(async () => {
      throw new Error("ssh release should not be called");
    });
    const runtimeWithSpies = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async (input) => await environmentsSvc.acquireLease({
            companyId: input.companyId,
            environmentId: input.environment.id,
            executionWorkspaceId: input.executionWorkspaceId,
            issueId: input.issueId,
            heartbeatRunId: input.heartbeatRunId,
            metadata: {
              driver: input.environment.driver,
              executionWorkspaceMode: input.executionWorkspaceMode,
            },
          }),
          releaseRunLease: localRelease,
          resolveCapabilities: async () => classifyEnvironmentCapabilities({ supportedCapabilities: new Set() }),
        },
        {
          driver: "ssh",
          acquireRunLease: async () => {
            throw new Error("ssh acquire should not be called");
          },
          releaseRunLease: sshRelease,
          resolveCapabilities: async () => classifyEnvironmentCapabilities({ supportedCapabilities: new Set() }),
        },
      ],
    });

    const acquired = await runtimeWithSpies.acquireRunLease({
      companyId,
      environment,
      issueId: null,
      heartbeatRunId: runId,
      persistedExecutionWorkspace: null,
    });

    await environmentsSvc.update(environment.id, { driver: "ssh" });

    const released = await runtimeWithSpies.releaseRunLeases(runId);

    expect(released).toHaveLength(1);
    expect(localRelease).toHaveBeenCalledTimes(1);
    expect(sshRelease).not.toHaveBeenCalled();
    expect(acquired.lease.metadata?.driver).toBe("local");
  });

  it("test_release_run_leases_continues_after_first_release_fails", async () => {
    const { companyId, environment, runId } = await seedEnvironment();
    const environmentsSvc = environmentService(db);

    // Seed two active leases for one run. The first driver release throws; the
    // second must still release.
    const failingLease = await environmentsSvc.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      provider: "local",
      providerLeaseId: "fail-release",
      metadata: { driver: "local" },
    });
    const healthyLease = await environmentsSvc.acquireLease({
      companyId,
      environmentId: environment.id,
      heartbeatRunId: runId,
      provider: "local",
      providerLeaseId: "healthy-release",
      metadata: { driver: "local" },
    });

    const runtimeWithFailingDriver = environmentRuntimeService(db, {
      drivers: [
        {
          driver: "local",
          acquireRunLease: async () => {
            throw new Error("acquire should not be called");
          },
          releaseRunLease: async ({ lease, status }) => {
            if (lease.providerLeaseId === "fail-release") {
              throw new Error("driver release failed");
            }
            return await environmentsSvc.releaseLease(lease.id, status);
          },
          resolveCapabilities: async () => classifyEnvironmentCapabilities({ supportedCapabilities: new Set() }),
        },
      ],
    });

    const errors: Array<{ leaseId: string; error: unknown }> = [];
    const released = await runtimeWithFailingDriver.releaseRunLeases(
      runId,
      "released",
      (leaseId, error) => errors.push({ leaseId, error }),
    );

    // The healthy lease released even though the first release failed.
    expect(released).toHaveLength(1);
    expect(released[0]?.lease.id).toBe(healthyLease.id);
    expect(released[0]?.lease.status).toBe("released");

    // The failed release reported one lease-specific error.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.leaseId).toBe(failingLease.id);
    expect((errors[0]?.error as Error).message).toBe("driver release failed");

    // The database confirms the isolation. The healthy lease released; the
    // failing lease stayed active.
    const rows = await db.select().from(environmentLeases);
    expect(rows.find((row) => row.id === healthyLease.id)?.status).toBe("released");
    expect(rows.find((row) => row.id === failingLease.id)?.status).toBe("active");
  });
});
