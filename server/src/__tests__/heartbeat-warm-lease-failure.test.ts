import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins, type Db } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { heartbeatService, resolveNativeSandboxLifecycle } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: the production incident's failed-turn cleanup crosses the
// heartbeat/resource ownership trust boundary. Exercise real DB handoff and
// runtime dispatch; only the external provider is a stateful fixture.
describe("heartbeat warm sandbox failure settlement", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("heartbeat-warm-failure-");
    db = createDb(external ?? temporary!.connectionString);
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), pluginId = randomUUID();
    const idleTimeoutMs = 8 * 60 * 60_000;
    await db.insert(companies).values({ id: companyId, name: "Warm failure retention", issuePrefix: `WF${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Warm worker", adapterType: "paperclip_runner",
      adapterConfig: { lifecycleMode: "warm", idleTimeoutMs } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retry in the same sandbox", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", runnerProfileJson: { nativeResourceDisposition: "keep_running" } });
    const provider = `warm-failure-${pluginId}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: "warm-failure-provider",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready",
      manifestJson: { id: provider, apiVersion: 1, version: "1.0.0", displayName: "Warm failure provider",
        description: "Stateful external sandbox boundary", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Warm failure",
          supportsReusableLeases: true, configSchema: { type: "object", properties: {
            image: { type: "string" }, reuseLease: { type: "boolean" },
          } } }] } });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox", status: "active",
      config: { provider, image: "fake:test", reuseLease: true, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: idleTimeoutMs } }).returning();
    const providerLeaseId = randomUUID();
    const expiresAt = new Date(Date.now() + idleTimeoutMs + 30 * 60_000).toISOString();
    let running = false, starts = 0;
    const call = vi.fn(async (_pluginId: string, method: string, input: Record<string, unknown>) => {
      if (method === "environmentAcquireLease") { running = true; starts++; }
      else if (method === "environmentResumeLease") {
        expect(input.providerLeaseId).toBe(providerLeaseId);
        // The runtime's existing resume RPC also verifies an already-running
        // allocation. Only a stopped allocation pays an actual provider resume.
        if (!running) { running = true; starts++; }
      } else if (["environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"].includes(method)) {
        running = false;
        return { providerLeaseId, state: method === "environmentDestroyLease" ? "destroyed" : "stopped" };
      } else throw new Error(`Unexpected provider call: ${method}`);
      return { providerLeaseId, expiresAt, metadata: { remoteCwd: "/work" } };
    });
    const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentResumeLease",
      "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const input = { companyId, agentId, issueId, environment: environment as unknown as Environment,
      heartbeatRunId: runId, persistedExecutionWorkspace: null, adapterType: "paperclip_runner", warmRunnerIdleTimeoutMs: idleTimeoutMs };
    const acquired = await runtime.acquireRunLease(input);
    expect(acquired.lease.leasePolicy).toBe("reuse_by_environment");
    expect(call).toHaveBeenCalledWith(pluginId, "environmentAcquireLease", expect.objectContaining({
      config: expect.objectContaining({ warmRunnerIdleTimeoutMs: idleTimeoutMs }),
    }), undefined);
    const disposition = resolveNativeSandboxLifecycle({ adapterType: "paperclip_runner",
      lifecyclePolicy: { mode: "warm", idleTimeoutMs }, target: { kind: "remote", transport: "sandbox",
        reusableLeaseConfigured: true, effectiveCapabilities: { reusableLeases: true } } })!.sandboxResource;
    expect(disposition).toBe("keep_running");
    return { companyId, agentId, issueId, runId, runtime, input, acquired, call,
      heartbeat: heartbeatService(db, { environmentRuntime: runtime }), state: () => ({ running, starts }) };
  }

  it.each([
    { status: "failed", errorCode: "adapter_failed" },
    { status: "failed", errorCode: "native_session_interrupted" },
    { status: "cancelled", errorCode: "cancelled" },
    { status: "interrupted", errorCode: null },
    { status: "succeeded", errorCode: null },
  ] as const)("hands off a warm sandbox after $status/$errorCode without stopping or physically resuming it", async ({ status, errorCode }) => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status, errorCode, finishedAt: new Date(),
      ...(status === "cancelled" ? { resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-operator" } } : {}),
    }).where(eq(heartbeatRuns.id, f.runId));
    await f.heartbeat.releaseEnvironmentLeasesForRun({ runId: f.runId, companyId: f.companyId,
      agentId: f.agentId, status, providerResourceDisposition: "keep_running" });
    expect(await environmentService(db).getLeaseById(f.acquired.lease.id)).toMatchObject({ status: "retained", cleanupStatus: "success" });
    expect(f.state()).toEqual({ running: true, starts: 1 });
    expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentAcquireLease"]);
    const nextRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running" });
    const next = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: nextRunId });
    expect(next.lease).toMatchObject({ providerLeaseId: f.acquired.lease.providerLeaseId,
      heartbeatRunId: nextRunId, status: "active", leasePolicy: "reuse_by_environment" });
    expect(next.lease.id).not.toBe(f.acquired.lease.id);
    expect(next.lease.metadata?.reusableLeasePredecessor).toMatchObject({
      schema: "paperclip.reusable-lease-handoff.v1", previousLeaseId: f.acquired.lease.id, successorLeaseId: next.lease.id,
    });
    expect(await environmentService(db).getLeaseById(f.acquired.lease.id)).toMatchObject({ status: "expired", cleanupStatus: "success" });
    expect(f.state()).toEqual({ running: true, starts: 1 });
    expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentAcquireLease", "environmentResumeLease"]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toMatchObject({ status, errorCode });
  });

  it.each(["native_restart_recovery_blocked", "native_continuation_requires_reconciliation", "native_event_replay_conflict",
    "native_session_cleanup_quarantined", "lease_released_before_terminal"])("still stops an untrusted failed sandbox: %s", async errorCode => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "failed", errorCode, finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    await f.heartbeat.releaseEnvironmentLeasesForRun({ runId: f.runId, companyId: f.companyId,
      agentId: f.agentId, status: "failed", providerResourceDisposition: "keep_running" });
    expect(f.state()).toEqual({ running: false, starts: 1 });
    expect(f.call.mock.calls.map(call => call[1])).toEqual(["environmentAcquireLease", "environmentStopLease"]);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.acquired.lease.id));
    expect(lease).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect(lease.metadata?.sandboxStopAndRetainReceipt).toBeTruthy();
  });
});
