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
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function seed(providerMetadata: Record<string, unknown> = {}) {
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
      return { providerLeaseId, expiresAt, metadata: { remoteCwd: "/work", ...providerMetadata } };
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
      createRuntime: () => environmentRuntimeService(db, { pluginWorkerManager: worker }),
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

  async function finish(f: Awaited<ReturnType<typeof seed>>, runId: string, status: "failed" | "succeeded") {
    await db.update(heartbeatRuns).set({ status, errorCode: status === "failed" ? "adapter_failed" : null,
      finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await f.heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId: f.companyId,
      agentId: f.agentId, status, providerResourceDisposition: "keep_running" });
  }

  async function nextTurn(f: Awaited<ReturnType<typeof seed>>) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      issueId: f.issueId, nativeIssueId: f.issueId, runtimeMode: "native", status: "running",
      runnerProfileJson: { nativeResourceDisposition: "keep_running" } });
    const acquired = await f.runtime.acquireRunLease({ ...f.input, heartbeatRunId: runId });
    expect(acquired.lease.providerLeaseId).toBe(f.acquired.lease.providerLeaseId);
    return { runId, leaseId: acquired.lease.id };
  }

  it("stops the same warm allocation on its second consecutive ordinary failure, including after service restart", async () => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    const firstLease = await environmentService(db).getLeaseById(f.acquired.lease.id);
    const next = await nextTurn(f);
    const nextLease = await environmentService(db).getLeaseById(next.leaseId);
    // No process-local counter may be required by terminal settlement.
    f.runtime = f.createRuntime();
    f.heartbeat = heartbeatService(db, { environmentRuntime: f.runtime });
    await finish(f, next.runId, "failed");
    expect(f.state()).toEqual({ running: false, starts: 1 });
    expect(firstLease).toMatchObject({ status: "retained", metadata: { warmFailureStreak: 1 } });
    expect(nextLease).toMatchObject({ metadata: { warmFailureStreak: 1 } });
    expect(f.call.mock.calls.map(call => call[1])).toEqual([
      "environmentAcquireLease", "environmentResumeLease", "environmentStopLease",
    ]);
    expect(await environmentService(db).getLeaseById(next.leaseId)).toMatchObject({ status: "released",
      cleanupStatus: "success", metadata: { warmFailureStreak: 2,
        warmRetentionReasonCode: "warm_retention_failure_limit", sandboxStopAndRetainReceipt: expect.any(Object) } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId)))[0]?.resultJson)
      .toMatchObject({ warmRetentionReasonCode: "warm_retention_failure_limit" });
  });

  it("resets the persisted streak on success: fail, success, fail stays warm", async () => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    const success = await nextTurn(f);
    await finish(f, success.runId, "succeeded");
    expect(await environmentService(db).getLeaseById(success.leaseId)).toMatchObject({
      status: "retained", metadata: { warmFailureStreak: 0 } });
    const retry = await nextTurn(f);
    await finish(f, retry.runId, "failed");
    expect(await environmentService(db).getLeaseById(retry.leaseId)).toMatchObject({
      status: "retained", metadata: { warmFailureStreak: 1 } });
    expect(f.state()).toEqual({ running: true, starts: 1 });
    expect(f.call.mock.calls.some(call => call[1] === "environmentStopLease")).toBe(false);
  });

  it.each([
    { status: "failed", errorCode: "native_session_interrupted" },
    { status: "cancelled", errorCode: "cancelled" },
    { status: "interrupted", errorCode: null },
  ] as const)("also counts ordinary $status/$errorCode as the second non-successful turn", async ({ status, errorCode }) => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    const next = await nextTurn(f);
    await db.update(heartbeatRuns).set({ status, errorCode, finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, next.runId));
    await f.heartbeat.releaseEnvironmentLeasesForRun({ runId: next.runId, companyId: f.companyId,
      agentId: f.agentId, status, providerResourceDisposition: "keep_running" });
    expect(f.state()).toEqual({ running: false, starts: 1 });
    expect(await environmentService(db).getLeaseById(next.leaseId)).toMatchObject({ status: "released",
      metadata: { warmFailureStreak: 2, warmRetentionReasonCode: "warm_retention_failure_limit" } });
  });

  it("clears a capped streak after a stopped allocation resumes and succeeds", async () => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    const second = await nextTurn(f);
    await finish(f, second.runId, "failed");
    const success = await nextTurn(f);
    expect(f.state()).toEqual({ running: true, starts: 2 });
    await finish(f, success.runId, "succeeded");
    const lease = await environmentService(db).getLeaseById(success.leaseId);
    expect(lease).toMatchObject({ status: "retained", metadata: { warmFailureStreak: 0 } });
    expect(lease?.metadata?.warmRetentionReasonCode).toBeUndefined();
    const retry = await nextTurn(f);
    await finish(f, retry.runId, "failed");
    expect(f.state()).toEqual({ running: true, starts: 2 });
    expect(await environmentService(db).getLeaseById(retry.leaseId)).toMatchObject({ status: "retained",
      metadata: { warmFailureStreak: 1 } });
  });

  it("enforces the same limit through runtime recovery without heartbeat's release wrapper", async () => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    const next = await nextTurn(f);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date(),
      resultJson: { existingResult: "preserved" } }).where(eq(heartbeatRuns.id, next.runId));
    const errors = vi.fn();
    await f.createRuntime().releaseRunLeases(next.runId, "failed", errors, "keep_running");
    expect(errors).not.toHaveBeenCalled();
    expect(f.state()).toEqual({ running: false, starts: 1 });
    expect(await environmentService(db).getLeaseById(next.leaseId)).toMatchObject({ status: "released",
      metadata: { warmFailureStreak: 2, warmRetentionReasonCode: "warm_retention_failure_limit" } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId)))[0]?.resultJson)
      .toEqual({ existingResult: "preserved", warmRetentionReasonCode: "warm_retention_failure_limit" });
  });

  it("retries a failed provider stop without counting the same failed turn again", async () => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    const next = await nextTurn(f);
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, next.runId));
    f.call.mockImplementationOnce(async () => { throw new Error("temporary provider stop failure"); });
    const errors = vi.fn();
    await f.runtime.releaseRunLeases(next.runId, "failed", errors, "keep_running");
    expect(errors).toHaveBeenCalledOnce();
    expect(await environmentService(db).getLeaseById(next.leaseId)).toMatchObject({ status: "pending_cleanup",
      metadata: { warmFailureStreak: 2, warmRetentionReasonCode: "warm_retention_failure_limit" } });
    await f.createRuntime().releaseRunLeases(next.runId, "failed", errors, "keep_running");
    expect(errors).toHaveBeenCalledOnce();
    expect(await environmentService(db).getLeaseById(next.leaseId)).toMatchObject({ status: "released",
      metadata: { warmFailureStreak: 2, warmRetentionReasonCode: "warm_retention_failure_limit" } });
    expect(f.state()).toEqual({ running: false, starts: 1 });
  });

  it("does not let provider metadata reset or forge the persisted allocation streak", async () => {
    const f = await seed({ warmFailureStreak: 0, warmFailureRunId: "provider-supplied",
      warmRetentionReasonCode: "provider-supplied" });
    expect(f.acquired.lease.metadata?.warmFailureStreak).toBeUndefined();
    expect(f.acquired.lease.metadata?.warmFailureRunId).toBeUndefined();
    expect(f.acquired.lease.metadata?.warmRetentionReasonCode).toBeUndefined();
    await finish(f, f.runId, "failed");
    const next = await nextTurn(f);
    expect(await environmentService(db).getLeaseById(next.leaseId)).toMatchObject({ metadata: { warmFailureStreak: 1 } });
    await finish(f, next.runId, "failed");
    expect(f.state()).toEqual({ running: false, starts: 1 });
  });

  it("preserves the streak through same-run reacquisition without counting that run twice", async () => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    const acquired = await f.runtime.acquireRunLease(f.input);
    expect(acquired.lease.id).toBe(f.acquired.lease.id);
    expect(acquired.lease.metadata?.warmFailureStreak).toBe(1);
    await finish(f, f.runId, "failed");
    expect(await environmentService(db).getLeaseById(acquired.lease.id)).toMatchObject({ status: "retained",
      metadata: { warmFailureStreak: 1 } });
    expect(f.state()).toEqual({ running: true, starts: 1 });
  });

  it("does not count duplicate terminal release as another failure or share streaks across allocations", async () => {
    const f = await seed();
    await finish(f, f.runId, "failed");
    await finish(f, f.runId, "failed");
    expect(await environmentService(db).getLeaseById(f.acquired.lease.id)).toMatchObject({
      status: "retained", metadata: { warmFailureStreak: 1 } });
    const other = await seed();
    await finish(other, other.runId, "failed");
    expect(await environmentService(db).getLeaseById(other.acquired.lease.id)).toMatchObject({
      status: "retained", metadata: { warmFailureStreak: 1 } });
    expect(other.state()).toEqual({ running: true, starts: 1 });
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
