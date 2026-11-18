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

// B1 (c1c): Boat resumes a box stopped for less than ~10 minutes with memory
// and processes alive (environment-execution-target.ts:79-84). A run P whose
// lease was released with a typed 'stopped' receipt may still have provider or
// tool processes frozen on that box. A DIFFERENT run must not resume it until
// the server's own long-stop threshold (fifteen minutes) has passed since the
// receipt was confirmed. P's own resume is unaffected.

vi.mock("../services/native-runtime/native-harness-backup-storage.js", () => ({
  verifyRecoverableNativeHarnessBackup: vi.fn(async (input: { stamp: unknown; providerLeaseId: string }) =>
    Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)),
}));

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MINUTE = 60_000;

describeEmbeddedPostgres("B1: a different run cannot resume a box another run's 'stopped' receipt left within the memory window", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let connectionString: string;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) connectionString = externalTestDatabaseUrl;
    else {
      const started = await startEmbeddedPostgresTestDatabase("b1-stopped-receipt-resume-fence");
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

  const providerLeaseId = "b0a7b0a7-0000-4000-8000-00000000b1b1";
  const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 300_000, reuseLease: true };

  /** P's box B: created by P through the real acquisition path, then released
   * with a typed termination receipt of `state`, confirmed at `confirmedAt`. */
  async function seed(state: "stopped" | "destroyed", confirmedAt: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const previousRunId = randomUUID();
    const runId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: "Boat", driver: "sandbox", status: "active",
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
    const environment: Environment = { id: environmentId, name: "Boat", description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    const priming = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      call: async (_pluginId: string, method: string) => {
        if (method !== "environmentAcquireLease") throw new Error(`Unexpected plugin method: ${method}`);
        return { providerLeaseId, metadata: { ...providerConfig, sandboxId: providerLeaseId, remoteCwd: "/home/boat/paperclip-workspace" } };
      },
      getWorker: () => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] }),
    } as unknown as PluginWorkerManager });
    const created = await priming.acquireRunLease({ companyId, environment, issueId: null, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: previousRunId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "isolated_workspace" } });
    const confirmed = new Date(confirmedAt).toISOString();
    const { sandboxLeaseAcquisition: _outcome, ...metadata } = created.lease.metadata ?? {};
    await environmentService(db).updateLeaseMetadata(created.lease.id, {
      ...metadata,
      remoteWorkspaceId: executionWorkspaceId,
      nativeHarnessBackup: { schema: "paperclip.native-harness-backup-stamp.v2", sourceProviderLeaseId: providerLeaseId,
        authorizedProviderLeaseId: providerLeaseId },
      // P's own-lease typed termination receipt (remoteTerminationReceipt's shape).
      remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId, runId: previousRunId,
        leaseId: created.lease.id, provider: "fake-plugin", providerLeaseId, state, confirmedAt: confirmed },
    });
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(confirmedAt), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, created.lease.id));
    // P stopped; it is no longer running.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(confirmedAt) }).where(eq(heartbeatRuns.id, previousRunId));
    const snapshotId = randomUUID();
    await db.insert(executionWorkspaceSnapshots).values({ id: snapshotId, companyId, executionWorkspaceId,
      sourceOperationId: randomUUID(), sourceRunId: previousRunId, generation: 1, epoch: 1, status: "committed" });
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: {
      schema: "paperclip.remote-workspace.v1", epoch: 2, snapshotId, source: { kind: "empty" }, writerRunId: runId, dirty: false,
      location: { environmentId, leaseId: created.lease.id, providerLeaseId, remoteCwd: "/home/boat/paperclip-workspace/.paperclip-workspaces/w" },
    } } }).where(eq(executionWorkspaces.id, executionWorkspaceId));
    return { companyId, agentId, environment, pluginId, runId, previousRunId, executionWorkspaceId, leaseId: created.lease.id };
  }

  function worker(seeded: Awaited<ReturnType<typeof seed>>) {
    const call = vi.fn(async (_pluginId: string, method: string, params: unknown) => {
      if (method === "environmentResumeLease") {
        return { providerLeaseId: (params as { providerLeaseId: string }).providerLeaseId,
          metadata: { ...providerConfig, remoteCwd: "/home/boat/paperclip-workspace" } };
      }
      if (method === "environmentAcquireLease") {
        return { providerLeaseId: "fresh-box", metadata: { ...providerConfig, remoteCwd: "/home/boat/paperclip-workspace" } };
      }
      if (method === "environmentDestroyLease" || method === "environmentReleaseLease" || method === "environmentStopLease") return {};
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === seeded.pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods: ["environmentResumeLease", "environmentReleaseLease", "environmentDestroyLease"] })),
    } as unknown as PluginWorkerManager;
    return { call, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  function acquire(seeded: Awaited<ReturnType<typeof seed>>, runtime: ReturnType<typeof environmentRuntimeService>, runId: string) {
    return runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId: null,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "isolated_workspace" } });
  }

  /** The injected clock: "now" is the receipt's confirmedAt plus `offset`. */
  function clockAt(confirmedAt: number, offset: number) {
    vi.spyOn(Date, "now").mockImplementation(() => confirmedAt + offset);
  }

  const resumedB = (call: ReturnType<typeof worker>["call"]) => call.mock.calls.filter(([, method, params]) =>
    method === "environmentResumeLease" && (params as { providerLeaseId?: string }).providerLeaseId === providerLeaseId);

  // Rows 1 and 2: a different run at +9 and +11 minutes is refused (skipped):
  // no environmentResumeLease with B's id, a fresh box is used, no error.
  for (const minutes of [9, 11]) {
    it(`row 1/2: a different run at confirmedAt + ${minutes} min does not resume B; a fresh box is used`, async () => {
      const confirmedAt = Date.now() - 30 * MINUTE;
      const seeded = await seed("stopped", confirmedAt);
      clockAt(confirmedAt, minutes * MINUTE);
      const { call, runtime } = worker(seeded);

      const acquired = await acquire(seeded, runtime, seeded.runId);

      expect(resumedB(call)).toHaveLength(0);
      expect(acquired.lease.providerLeaseId).toBe("fresh-box");
      // B is not stranded: its released row and receipt are kept for later.
      const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
      expect(kept?.status).toBe("released");
      expect((kept?.metadata?.remoteExecutionTermination as { state?: string })?.state).toBe("stopped");
    });
  }

  it("row 2: at confirmedAt + 16 min (past the fifteen-minute long-stop threshold) the different run may resume B", async () => {
    const confirmedAt = Date.now() - 30 * MINUTE;
    const seeded = await seed("stopped", confirmedAt);
    clockAt(confirmedAt, 16 * MINUTE);
    const { call, runtime } = worker(seeded);

    const acquired = await acquire(seeded, runtime, seeded.runId);

    expect(resumedB(call)).toHaveLength(1);
    expect(acquired.lease.providerLeaseId).toBe(providerLeaseId);
  });

  // Row 3 dropped: c1 has no typed, lease-bound proof that P's Runner was gone
  // before the box froze, so the fence is window-only.

  it("row 4: the SAME run's own resume at confirmedAt + 2 min is unaffected", async () => {
    const confirmedAt = Date.now() - 30 * MINUTE;
    const seeded = await seed("stopped", confirmedAt);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, seeded.previousRunId));
    clockAt(confirmedAt, 2 * MINUTE);
    const { call, runtime } = worker(seeded);

    const acquired = await acquire(seeded, runtime, seeded.previousRunId);

    expect(resumedB(call)).toHaveLength(1);
    expect(acquired.lease.providerLeaseId).toBe(providerLeaseId);
  });

  it("row 5: a 'destroyed' receipt is not the stopped case: behaviour unchanged from c1", async () => {
    const confirmedAt = Date.now() - 30 * MINUTE;
    const seeded = await seed("destroyed", confirmedAt);
    clockAt(confirmedAt, 2 * MINUTE);
    const { call, runtime } = worker(seeded);

    const acquired = await acquire(seeded, runtime, seeded.runId);

    // c1: the released reusable row is selected and resumed regardless of a destroyed receipt.
    expect(resumedB(call)).toHaveLength(1);
    expect(acquired.lease.providerLeaseId).toBe(providerLeaseId);
  });

  // Row 6: the handoff mirror. A resume that slipped past selection is still
  // refused when the handoff re-checks eligibility in its transaction.
  it("row 6: the handoff refuses a different run's takeover of B at confirmedAt + 9 min, and admits it at + 16 min", async () => {
    const confirmedAt = Date.now() - 30 * MINUTE;
    const seeded = await seed("stopped", confirmedAt);
    const handoff = () => environmentService(db).acquireLease({
      companyId: seeded.companyId, environmentId: seeded.environment.id, executionWorkspaceId: seeded.executionWorkspaceId,
      issueId: null, heartbeatRunId: seeded.runId, leasePolicy: "reuse_by_environment", provider: "fake-plugin",
      providerLeaseId, metadata: { agentId: seeded.agentId }, replacesReusableLeaseId: seeded.leaseId,
    });

    clockAt(confirmedAt, 9 * MINUTE);
    await expect(handoff()).rejects.toThrow();
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(kept?.status).toBe("released");
    expect(kept?.metadata?.reusableLeaseSuccessor).toBeUndefined();

    vi.restoreAllMocks();
    clockAt(confirmedAt, 16 * MINUTE);
    const taken = await handoff();
    expect(taken.heartbeatRunId).toBe(seeded.runId);
    const [retired] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(retired?.status).toBe("expired");
  });
});
