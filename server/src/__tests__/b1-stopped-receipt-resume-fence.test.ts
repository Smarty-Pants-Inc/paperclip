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
  issues,
  plugins,
  projects,
} from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";

// B1 fence (a), the judges' JOINT line (smarty-dev#4605 comment 6992985316):
// Boat resumes a box stopped for less than ~10 minutes with memory and
// processes alive (environment-execution-target.ts:79-84). When a run P ended
// NOT succeeded (a person's Stop = cancelled, failed, timed_out, interrupted)
// and its lease carries a typed 'stopped' or 'destroyed' receipt, NO other run
// (a different issue's, or the same conversation's later run) may resume P's
// box until PREDECESSOR_LONG_STOP_MS (15 min) after the receipt was confirmed.
// Only P's own run is exempt. A SUCCEEDED P's box stays warm for its successor.

vi.mock("../services/native-runtime/native-harness-backup-storage.js", () => ({
  verifyRecoverableNativeHarnessBackup: vi.fn(async (input: { stamp: unknown; providerLeaseId: string }) =>
    Boolean(input.stamp && (input.stamp as { authorizedProviderLeaseId?: unknown }).authorizedProviderLeaseId === input.providerLeaseId)),
}));

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const MINUTE = 60_000;

describeEmbeddedPostgres("B1 fence (a): a box a stopped or failed run left is not resumed by another run within the long-stop window", () => {
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
  // Every row uses its own company, environment and runs: no cross-row cleanup.
  afterEach(async () => { vi.restoreAllMocks(); await db.$client.end({ timeout: 1 }); });
  afterAll(async () => { await stopDb?.(); });

  // P's box B: a fresh provider id per row (the runtime keeps per-box state).
  let providerLeaseId = "";
  const providerConfig = { provider: "fake-plugin", image: "fake:test", timeoutMs: 300_000, reuseLease: true };
  const supportedMethods = ["environmentResumeLease", "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"];

  /** A fake Boat worker. Resume returns the asked box; acquire makes a fresh
   * box; release/stop/destroy reply with the typed receipt the real release
   * path binds into remoteExecutionTermination. */
  function worker(pluginId: string) {
    const call = vi.fn(async (_pluginId: string, method: string, params: unknown) => {
      const asked = (params as { providerLeaseId?: string }).providerLeaseId;
      if (method === "environmentResumeLease") {
        return { providerLeaseId: asked, metadata: { ...providerConfig, remoteCwd: "/home/boat/paperclip-workspace" } };
      }
      if (method === "environmentAcquireLease") {
        const fresh = call.mock.calls.filter(([, m]) => m === "environmentAcquireLease").length === 1 ? providerLeaseId : `fresh-box-${randomUUID()}`;
        return { providerLeaseId: fresh, metadata: { ...providerConfig, sandboxId: fresh, remoteCwd: "/home/boat/paperclip-workspace" } };
      }
      if (method === "environmentReleaseLease" || method === "environmentStopLease") return { providerLeaseId: asked, state: "stopped" };
      if (method === "environmentDestroyLease") return { providerLeaseId: asked, state: "destroyed" };
      throw new Error(`Unexpected plugin method: ${method}`);
    });
    const manager = { isRunning: vi.fn((id: string) => id === pluginId), call,
      getWorker: vi.fn(() => ({ supportedMethods })) } as unknown as PluginWorkerManager;
    return { call, manager, runtime: environmentRuntimeService(db, { pluginWorkerManager: manager }) };
  }

  /** P's box B: P (on issue A) creates it through the real acquisition path.
   * Q is a later run on issue B (a different issue: same agent and shared
   * workspace, so selection can reach B). */
  async function setup() {
    providerLeaseId = `b1-box-${randomUUID()}`;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const pluginId = randomUUID();
    const pRunId = randomUUID();
    const qRunId = randomUUID();
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issueA = randomUUID();
    const issueB = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", status: "active",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "active",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(environments).values({ id: environmentId, name: `Boat ${environmentId}`, driver: "sandbox", status: "active",
      config: providerConfig });
    await db.insert(plugins).values({
      id: pluginId, pluginKey: `acme.reusable-sandbox-provider-${pluginId}`, packageName: `@acme/reusable-sandbox-provider-${pluginId}`,
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, updatedAt: new Date(),
      manifestJson: {
        id: `acme.reusable-sandbox-provider-${pluginId}`, apiVersion: 1, version: "1.0.0", displayName: "Reusable Sandbox Provider",
        description: "Test provider", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: "fake-plugin", kind: "sandbox_provider", displayName: "Fake Plugin",
          supportsReusableLeases: true,
          configSchema: { type: "object", properties: { image: { type: "string" }, timeoutMs: { type: "number" }, reuseLease: { type: "boolean" } } } }],
      },
    } as never);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await db.insert(issues).values([
      { id: issueA, companyId, title: "P's task", status: "in_progress", priority: "medium" },
      { id: issueB, companyId, title: "Q's task", status: "in_progress", priority: "medium" },
    ]);
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, mode: "shared_workspace",
      strategyType: "project_primary", name: "Shared workspace", status: "active", providerType: "cloud_sandbox",
      cwd: `/workspaces/${executionWorkspaceId}` });
    await db.insert(heartbeatRuns).values([
      { id: pRunId, companyId, agentId, issueId: issueA, invocationSource: "assignment", status: "running" },
      { id: qRunId, companyId, agentId, issueId: issueB, invocationSource: "assignment", status: "running" },
    ]);
    const environment: Environment = { id: environmentId, name: `Boat ${environmentId}`, description: null, driver: "sandbox",
      status: "active", config: providerConfig, envVars: {}, metadata: null, createdAt: new Date(), updatedAt: new Date() };
    const w = worker(pluginId);
    const created = await w.runtime.acquireRunLease({ companyId, environment, issueId: issueA, agentId, adapterType: "paperclip_runner",
      heartbeatRunId: pRunId, persistedExecutionWorkspace: { id: executionWorkspaceId, mode: "shared_workspace" } });
    expect(created.lease.providerLeaseId).toBe(providerLeaseId);
    return { companyId, agentId, environment, pluginId, pRunId, qRunId, issueA, issueB, executionWorkspaceId,
      leaseId: created.lease.id, ...w };
  }
  type Seeded = Awaited<ReturnType<typeof setup>>;

  /** PLANTED: P's end and its lease's receipt written by hand (each planted
   * shape has a REAL-producer twin below, built by the real Stop/release). */
  async function plant(seeded: Seeded, opts: { pStatus: string; state: "stopped" | "destroyed"; confirmedAt: number;
    leaseStatus?: "released" | "retained" }) {
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    const { sandboxLeaseAcquisition: _outcome, ...metadata } = lease!.metadata ?? {};
    await environmentService(db).updateLeaseMetadata(seeded.leaseId, {
      ...metadata,
      // P's own-lease typed termination receipt (remoteTerminationReceipt's shape).
      remoteExecutionTermination: { schema: "paperclip.remote-termination.v1", companyId: seeded.companyId, runId: seeded.pRunId,
        leaseId: seeded.leaseId, provider: "fake-plugin", providerLeaseId, state: opts.state,
        confirmedAt: new Date(opts.confirmedAt).toISOString() },
    });
    await db.update(environmentLeases).set({ status: opts.leaseStatus ?? "released", releasedAt: new Date(opts.confirmedAt), cleanupStatus: "success" })
      .where(eq(environmentLeases.id, seeded.leaseId));
    await db.update(heartbeatRuns).set({ status: opts.pStatus, finishedAt: new Date(opts.confirmedAt) }).where(eq(heartbeatRuns.id, seeded.pRunId));
  }

  async function newRun(seeded: Seeded, issueId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: seeded.companyId, agentId: seeded.agentId, issueId,
      invocationSource: "assignment", status: "running" });
    return id;
  }

  function acquire(seeded: Seeded, runId: string, issueId: string) {
    return seeded.runtime.acquireRunLease({ companyId: seeded.companyId, environment: seeded.environment, issueId,
      agentId: seeded.agentId, adapterType: "paperclip_runner", heartbeatRunId: runId,
      persistedExecutionWorkspace: { id: seeded.executionWorkspaceId, mode: "shared_workspace" } });
  }

  /** The injected clock: "now" is the receipt's confirmedAt plus `offset`. */
  function clockAt(confirmedAt: number, offset: number) {
    vi.spyOn(Date, "now").mockImplementation(() => confirmedAt + offset);
  }

  const resumedB = (seeded: Seeded) => seeded.call.mock.calls.filter(([, method, params]) =>
    method === "environmentResumeLease" && (params as { providerLeaseId?: string }).providerLeaseId === providerLeaseId);

  async function expectRefused(seeded: Seeded, acquired: Awaited<ReturnType<typeof acquire>>, state = "stopped") {
    expect(resumedB(seeded)).toHaveLength(0);
    expect(acquired.lease.providerLeaseId).not.toBe(providerLeaseId);
    expect(acquired.lease.providerLeaseId).toMatch(/^fresh-box-/);
    // B is not stranded: its row and receipt are kept for later.
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(["released", "retained"]).toContain(kept?.status);
    expect((kept?.metadata?.remoteExecutionTermination as { state?: string })?.state).toBe(state);
  }
  function expectResumed(seeded: Seeded, acquired: Awaited<ReturnType<typeof acquire>>) {
    expect(resumedB(seeded)).toHaveLength(1);
    expect(acquired.lease.providerLeaseId).toBe(providerLeaseId);
  }

  // ---------------- REFUSED (RED at c1b, GREEN at the head) ----------------

  // PLANTED twin of "REAL: a person's Stop ..." below.
  for (const minutes of [9, 11]) {
    it(`refused: a different issue's run at + ${minutes} min after a person-STOPPED P (cancelled) gets a fresh box`, async () => {
      const seeded = await setup();
      const confirmedAt = Date.now() - 30 * MINUTE;
      await plant(seeded, { pStatus: "cancelled", state: "stopped", confirmedAt });
      clockAt(confirmedAt, minutes * MINUTE);
      await expectRefused(seeded, await acquire(seeded, seeded.qRunId, seeded.issueB));
    });

    // Paul's d2f6b4fd shape: a FAILED P whose box was kept (retained) with a 'stopped' receipt.
    it(`refused: a different issue's run at + ${minutes} min after a FAILED P (box retained) gets a fresh box`, async () => {
      const seeded = await setup();
      const confirmedAt = Date.now() - 30 * MINUTE;
      await plant(seeded, { pStatus: "failed", state: "stopped", confirmedAt, leaseStatus: "retained" });
      clockAt(confirmedAt, minutes * MINUTE);
      await expectRefused(seeded, await acquire(seeded, seeded.qRunId, seeded.issueB));
    });

    it(`refused: a different issue's run at + ${minutes} min after a stopped P whose receipt is 'destroyed' gets a fresh box`, async () => {
      const seeded = await setup();
      const confirmedAt = Date.now() - 30 * MINUTE;
      await plant(seeded, { pStatus: "cancelled", state: "destroyed", confirmedAt });
      clockAt(confirmedAt, minutes * MINUTE);
      await expectRefused(seeded, await acquire(seeded, seeded.qRunId, seeded.issueB), "destroyed");
    });
  }

  it("refused: the SAME issue's successor (Send after Stop) at + 2 min gets a fresh box", async () => {
    const seeded = await setup();
    const confirmedAt = Date.now() - 30 * MINUTE;
    await plant(seeded, { pStatus: "cancelled", state: "stopped", confirmedAt });
    clockAt(confirmedAt, 2 * MINUTE);
    const successor = await newRun(seeded, seeded.issueA);
    await expectRefused(seeded, await acquire(seeded, successor, seeded.issueA));
  });

  // REAL producers: P is stopped by the real cancel service (heartbeat
  // cancelRun, the person-Stop route's service) and its lease is released by
  // the real teardown release (run-control releaseEnvironmentLeasesForRun ->
  // releaseRunLeases -> stop-and-retain -> remoteTerminationReceipt). No
  // hand-written row.
  it("REAL: a person's Stop of P (real cancelRun + real release) refuses a different issue's run right after; + 16 min resumes", async () => {
    const seeded = await setup();
    const heartbeat = heartbeatService(db, { pluginWorkerManager: seeded.manager, environmentRuntime: seeded.runtime });
    await heartbeat.cancelRun(seeded.pRunId, "Stopped by a person");
    const [pRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.pRunId));
    expect(pRun?.status).toBe("cancelled");
    // The run's real teardown release: P was a warm run (keep_running asked);
    // run-control turns a person's Stop into stop_and_retain, and the real
    // release path binds the provider's 'stopped' reply into P's receipt.
    await heartbeat.releaseEnvironmentLeasesForRun({ runId: seeded.pRunId, companyId: seeded.companyId,
      agentId: seeded.agentId, status: pRun!.status, providerResourceDisposition: "keep_running" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    const receipt = lease?.metadata?.remoteExecutionTermination as { state?: string; runId?: string; confirmedAt?: string };
    expect(receipt?.state).toBe("stopped");
    expect(receipt?.runId).toBe(seeded.pRunId);
    expect(["released", "retained"]).toContain(lease?.status);

    await expectRefused(seeded, await acquire(seeded, seeded.qRunId, seeded.issueB));

    clockAt(Date.parse(receipt.confirmedAt!), 16 * MINUTE);
    const later = await newRun(seeded, seeded.issueB);
    expectResumed(seeded, await acquire(seeded, later, seeded.issueB));
  });

  // ---------------- ALLOWED ----------------

  // PLANTED twin of the REAL +16 min resume above.
  it("allowed: at + 16 min (past the fifteen-minute long-stop threshold) a different issue's run resumes B", async () => {
    const seeded = await setup();
    const confirmedAt = Date.now() - 30 * MINUTE;
    await plant(seeded, { pStatus: "cancelled", state: "stopped", confirmedAt });
    clockAt(confirmedAt, 16 * MINUTE);
    expectResumed(seeded, await acquire(seeded, seeded.qRunId, seeded.issueB));
  });

  // PLANTED twin of "REAL: a SUCCEEDED P ..." below.
  it("allowed: a SUCCEEDED P's box is resumed by a different issue's run at + 2 min (warm reuse)", async () => {
    const seeded = await setup();
    const confirmedAt = Date.now() - 30 * MINUTE;
    await plant(seeded, { pStatus: "succeeded", state: "stopped", confirmedAt });
    clockAt(confirmedAt, 2 * MINUTE);
    expectResumed(seeded, await acquire(seeded, seeded.qRunId, seeded.issueB));
  });

  it("REAL: a SUCCEEDED P released by the real release path (stop_and_retain receipt) is resumed by a different issue's run right after", async () => {
    const seeded = await setup();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, seeded.pRunId));
    // The run's real teardown release (a per-turn run stops and keeps its box).
    await heartbeatService(db, { pluginWorkerManager: seeded.manager, environmentRuntime: seeded.runtime })
      .releaseEnvironmentLeasesForRun({ runId: seeded.pRunId, companyId: seeded.companyId, agentId: seeded.agentId,
        status: "succeeded", providerResourceDisposition: "stop_and_retain" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect((lease?.metadata?.remoteExecutionTermination as { state?: string })?.state).toBe("stopped");
    expectResumed(seeded, await acquire(seeded, seeded.qRunId, seeded.issueB));
  });

  // The keep-warm codes (runner-environment-lifecycle.ts :29): a failed turn
  // with adapter_failed / adapter_error / native_session_interrupted keeps its
  // box RUNNING for the same conversation. The real release writes NO receipt
  // for keep_running (environment-runtime.ts releaseRunLeases, 'retained' with
  // cleanupStatus only), so this fence does not touch that continuation.
  it("REAL: a keep-warm failure (adapter_error) leaves no receipt; the same conversation's next run still resumes the warm box", async () => {
    const seeded = await setup();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_error", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, seeded.pRunId));
    await heartbeatService(db, { pluginWorkerManager: seeded.manager, environmentRuntime: seeded.runtime })
      .releaseEnvironmentLeasesForRun({ runId: seeded.pRunId, companyId: seeded.companyId, agentId: seeded.agentId,
        status: "failed", providerResourceDisposition: "keep_running" });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(lease?.status).toBe("retained");
    expect(lease?.metadata?.remoteExecutionTermination).toBeUndefined();
    const next = await newRun(seeded, seeded.issueA);
    expectResumed(seeded, await acquire(seeded, next, seeded.issueA));
  });

  it("allowed: P's OWN run resumes its box at + 2 min", async () => {
    const seeded = await setup();
    const confirmedAt = Date.now() - 30 * MINUTE;
    await plant(seeded, { pStatus: "cancelled", state: "stopped", confirmedAt });
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, seeded.pRunId));
    clockAt(confirmedAt, 2 * MINUTE);
    expectResumed(seeded, await acquire(seeded, seeded.pRunId, seeded.issueA));
  });

  // ---------------- The handoff mirror ----------------
  // A resume that slipped past selection is still refused when the handoff
  // re-checks eligibility in its transaction; the takeover is rolled back.
  it("mirror: the handoff refuses a different issue's takeover of B at + 9 min after a Stopped P (conflict, rolled back), and admits it at + 16 min", async () => {
    const seeded = await setup();
    const confirmedAt = Date.now() - 30 * MINUTE;
    await plant(seeded, { pStatus: "cancelled", state: "stopped", confirmedAt });
    const handoff = () => environmentService(db).acquireLease({
      companyId: seeded.companyId, environmentId: seeded.environment.id, executionWorkspaceId: seeded.executionWorkspaceId,
      issueId: seeded.issueB, heartbeatRunId: seeded.qRunId, leasePolicy: "reuse_by_environment", provider: "fake-plugin",
      providerLeaseId, metadata: { agentId: seeded.agentId }, replacesReusableLeaseId: seeded.leaseId,
    });

    clockAt(confirmedAt, 9 * MINUTE);
    await expect(handoff()).rejects.toThrow(/long-stop window/);
    const [kept] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(kept?.status).toBe("released");
    expect(kept?.metadata?.reusableLeaseSuccessor).toBeUndefined();

    vi.restoreAllMocks();
    clockAt(confirmedAt, 16 * MINUTE);
    const taken = await handoff();
    expect(taken.heartbeatRunId).toBe(seeded.qRunId);
    const [retired] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(retired?.status).toBe("expired");
  });
});
