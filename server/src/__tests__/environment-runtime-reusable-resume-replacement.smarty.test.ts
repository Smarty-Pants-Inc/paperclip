import { JsonRpcCallError } from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaceSnapshots,
  executionWorkspaces,
  heartbeatRuns,
  plugins,
  projects,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// Durable harness-backup verification has its own tests. Here it is a boundary:
// a lease-bound stamp verifies, a missing stamp (an older release's lease) does not.
vi.mock("../services/native-runtime/native-harness-backup-storage.js", () => ({
  verifyRecoverableNativeHarnessBackup: vi.fn(async (input: { stamp: unknown; providerLeaseId: string }) =>
    Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)),
}));

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The staging failure: Daytona kept the idle sandbox in a state transition past
// its five-minute start deadline, and the worker reported it with no status.

describeEmbeddedPostgres("reusable sandbox resume failure replacement", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("environment-runtime-resume-replacement");
      stopDb = started.cleanup;
      connectionString = started.connectionString;
    }
  });
  beforeEach(() => { db = createDb(connectionString); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(executionWorkspaceSnapshots);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(executionWorkspaces);
    await db.delete(plugins);
    await db.delete(projects);
    await db.delete(companies);
    await db.$client.end({ timeout: 1 });
  });
  afterAll(async () => { await stopDb?.(); });

  type Shape = {
    leaseStatus?: "retained" | "released";
    previousRunStatus?: "succeeded" | "running";
    dirty?: boolean;
    snapshot?: "committed" | "pending" | null;
    backupStamp?: boolean;
  };

  async function seed(shape: Shape = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const previousRunId = randomUUID();
    const runId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const providerLeaseId = "0f6c1e52-3d1a-4b7e-9c2a-5e8f7a1b2c3d";
    // The staging environment's provider settings, including its 300s start deadline.
    const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 300_000, reuseLease: true };
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Paperclip Sandbox", driver: "sandbox", status: "active",
      config: providerConfig });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: "acme.reusable-sandbox-provider", packageName: "@acme/reusable-sandbox-provider",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: {
        id: "acme.reusable-sandbox-provider", apiVersion: 1, version: "1.0.0", displayName: "Reusable Sandbox Provider",
        description: "Test provider", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, timeoutMs: { type: "number" }, reuseLease: { type: "boolean" } } } }],
      },
    } as never);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, mode: "isolated_workspace",
      strategyType: "project_primary", name: "Task workspace", status: "active", providerType: "cloud_sandbox",
      cwd: `/workspaces/${executionWorkspaceId}` });
    await db.insert(heartbeatRuns).values([
      { id: previousRunId, companyId, agentId, invocationSource: "assignment", status: "running" },
      { id: runId, companyId, agentId, invocationSource: "assignment", status: "running" },
    ]);
    const environment: Environment = { id: environmentId, name: "Paperclip Sandbox", description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    // The previous run creates the sandbox through the real acquisition path,
    // so the preserved lease carries exactly the identity production records.
    const priming = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      call: async (_pluginId: string, method: string) => {
        if (method !== "environmentAcquireLease") throw new Error(`Unexpected plugin method: ${method}`);
        return { providerLeaseId, metadata: { ...providerConfig, sandboxId: providerLeaseId, remoteCwd: "/home/daytona/paperclip-workspace" } };
      },
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const created = await priming.acquireRunLease({ companyId, environment, issueId: null, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: previousRunId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "isolated_workspace" } });
    // The run then ended after a clean final save and left its lease-bound
    // harness backup stamp. A lease saved by an older release has no
    // acquisition outcome and may predate the backup stamp.
    const { sandboxLeaseAcquisition: _outcome, ...metadata } = created.lease.metadata ?? {};
    const lease = (await environmentService(db).updateLeaseMetadata(created.lease.id, {
      ...(shape.leaseStatus === "released" ? metadata : created.lease.metadata),
      remoteWorkspaceId: executionWorkspaceId,
      ...(shape.backupStamp === false ? {} : { nativeHarnessBackup: {
        schema: "paperclip.native-harness-backup-stamp.v2", sourceProviderLeaseId: providerLeaseId,
        authorizedProviderLeaseId: providerLeaseId,
      } }),
    }))!;
    await db.update(environmentLeases).set({ status: shape.leaseStatus ?? "retained" }).where(eq(environmentLeases.id, lease.id));
    await db.update(heartbeatRuns).set({ status: shape.previousRunStatus ?? "succeeded" }).where(eq(heartbeatRuns.id, previousRunId));
    const snapshotId = randomUUID();
    if (shape.snapshot !== null) {
      await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId,
        sourceOperationId: randomUUID(), sourceRunId: previousRunId, generation: 1, epoch: 1, status: shape.snapshot ?? "committed" });
    }
    // This run already holds the workspace writer slot (reserved before the
    // environment is acquired); the saved version is the previous run's save.
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
      schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId: shape.snapshot === null ? null : snapshotId,
      source: { kind: "empty" }, writerRunId: runId, dirty: shape.dirty ?? false,
      location: { environmentId, leaseId: lease.id, providerLeaseId, remoteCwd: "/home/daytona/paperclip-workspace/.paperclip-workspaces/w" },
    } } }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { companyId, agentId, environment, pluginId, runId, executionWorkspaceId, lease, providerLeaseId };
  }

  function worker(seeded: Awaited<ReturnType<typeof seed>>, resume: (attempt: number, timeoutMs: number) => Promise<unknown>,
    options: { acquireFails?: boolean } = {}) {
    let attempts = 0;
    const call = vi.fn(async (_pluginId: string, method: string, _params: unknown, timeoutMs?: number) => {
      if (method === "environmentResumeLease") return await resume(++attempts, timeoutMs ?? 0);
      if (method === "environmentAcquireLease") {
        if (options.acquireFails) throw new JsonRpcCallError({ code: -32000, message: "create refused" });
        return { providerLeaseId: "replacement-sandbox", metadata: { provider: "fake-plugin", image: "fake:test",
          timeoutMs: 300_000, reuseLease: true, remoteCwd: "/home/daytona/paperclip-workspace" } };
      }
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === seeded.pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    return { call, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  function acquire(seeded: Awaited<ReturnType<typeof seed>>, runtime: ReturnType<typeof environmentRuntimeService>,
    runId = seeded.runId) {
    return runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId: null,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "isolated_workspace" } });
  }

  // Each refused resume consumes 40s of the run's clock, so the in-run retry
  // budget is exercised without real waiting.

  // Staging: a run could not retire its predecessor's warm
  // Runner on this sandbox, did no provider work, and asked for a fresh one.

  it.each([
    ["reply", "restoredFromSnapshotAt"], ["metadata", "restoredFromSnapshotAt"], ["lease", "restoredFromSnapshotAt"],
    ["metadata", "rebootedAt"], ["lease", "rebootedAt"],
  ] as const)("records process loss from %s.%s at both resume doors without replacing the disk", async (source, marker) => {
    const seeded = await seed();
    const restoredFromSnapshotAt = "2026-11-25T12:00:00.000Z";
    const signal = { [marker]: restoredFromSnapshotAt };
    if (source === "lease") seeded.lease.metadata = { ...seeded.lease.metadata, ...signal };
    const { call, runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      ...(source === "reply" ? { restoredFromSnapshotAt } : {}),
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace", ...(source === "metadata" ? signal : {}) } }));
    if (source === "lease") await environmentService(db).updateLeaseMetadata(seeded.lease.id, seeded.lease.metadata!);
    const expected = { outcome: "resumed", ...signal };
    const resumed = await runtime.resumeRunLease({ environment: seeded.environment, lease: seeded.lease });
    expect(resumed).toMatchObject({ providerLeaseId: seeded.providerLeaseId, metadata: signal });
    const recorded = await environmentService(db).getLeaseById(seeded.lease.id);
    expect(recorded?.metadata).toMatchObject({ ...seeded.lease.metadata, ...signal });
    // Repeated notification keeps the same provenance, workspace and backup.
    await runtime.resumeRunLease({ environment: seeded.environment, lease: recorded! });
    expect((await environmentService(db).getLeaseById(seeded.lease.id))?.metadata).toEqual(recorded?.metadata);
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.providerLeaseId).toBe(seeded.providerLeaseId);
    expect(acquired.lease.metadata).toMatchObject({ ...signal, sandboxLeaseAcquisition: expected,
      nativeHarnessBackup: seeded.lease.metadata!.nativeHarnessBackup });
    expect(call.mock.calls.every(([, method]) => method === "environmentResumeLease")).toBe(true);
  });

  it.each(["restoredFromSnapshotAt", "rebootedAt"] as const)("carries handled %s through a later reusable lease and recognizes the next loss", async marker => {
    const seeded = await seed();
    const first = "2026-11-25T12:00:00.000Z";
    const handledProcessRestartKey = JSON.stringify(marker === "rebootedAt" ? [null, first] : [first, null]);
    seeded.lease.metadata = { ...seeded.lease.metadata, [marker]: first, handledProcessRestartKey };
    await environmentService(db).updateLeaseMetadata(seeded.lease.id, seeded.lease.metadata);
    let current = first;
    const { runtime } = worker(seeded, async () => ({ providerLeaseId: seeded.providerLeaseId,
      ...(marker === "restoredFromSnapshotAt" ? { restoredFromSnapshotAt: current } : {}),
      metadata: { remoteCwd: "/home/daytona/paperclip-workspace", [marker]: current } }));
    const acquired = await acquire(seeded, runtime);
    expect(acquired.lease.metadata?.handledProcessRestartKey).toBe(handledProcessRestartKey);
    expect(acquired.lease.metadata?.sandboxLeaseAcquisition).toEqual({ outcome: "resumed", handledProcessRestartKey });
    current = "2026-11-25T13:00:00.000Z";
    const resumed = await runtime.resumeRunLease({ environment: seeded.environment, lease: acquired.lease });
    expect(resumed?.metadata).toMatchObject({ [marker]: current, handledProcessRestartKey });
    expect((await environmentService(db).getLeaseById(acquired.lease.id))?.metadata).toMatchObject({ [marker]: current, handledProcessRestartKey });
  });

});
