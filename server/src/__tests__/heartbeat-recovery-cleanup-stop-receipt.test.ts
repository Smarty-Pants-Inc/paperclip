import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins } from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { environmentRoutes } from "../routes/environments.js";
import { errorHandler } from "../middleware/index.js";
import { hasRecoveredCleanupStopReceipt } from "../services/remote-execution-termination.js";
import { ORPHANED_SANDBOX_RECOVERY_KEY } from "../services/sandbox-stop-and-retain.js";
import { createOwnershipReportState, runOwnershipReconciliationPass } from "../services/recovery/ownership-invariant-report.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("recovery cleanup recorded stopped sandbox", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("recovery-cleanup-stop-receipt-");
    db = createDb(temporary.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await temporary?.cleanup(); });

  async function seed(withReceipt = true, withSnapshot = true) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), leaseId = randomUUID();
    const pluginId = randomUUID(), provider = `boat-${pluginId}`, providerLeaseId = `box-${leaseId}`;
    await db.insert(companies).values({ id: companyId, name: "Cleanup", issuePrefix: `RC${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "process", status: "idle" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "failed", finishedAt: new Date() });
    await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: provider, version: "1.0.0",
      apiVersion: 1, categories: ["automation"], status: "ready", manifestJson: { id: provider, apiVersion: 1,
        version: "1.0.0", displayName: "Boat recording provider", description: "External boundary fixture", author: "Paperclip",
        categories: ["automation"], capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Boat",
          supportsReusableLeases: true, configSchema: { type: "object", properties: { image: { type: "string" } } } }] } });
    const config = { provider, image: "fixture:test", reuseLease: true };
    const [environment] = await db.insert(environments).values({ name: provider, driver: "sandbox", config }).returning();
    const stopReceipt = { schema: "paperclip.remote-termination.v1", companyId, runId, leaseId, provider,
      providerLeaseId, state: "stopped", confirmedAt: new Date().toISOString() };
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId: environment!.id, heartbeatRunId: runId,
      provider, providerLeaseId, leasePolicy: "reuse_by_environment", status: "pending_cleanup", cleanupStatus: "failed",
      failureReason: "retained_orphan_sandbox_released", acquiredAt: new Date(Date.now() - 120_000), releasedAt: new Date(),
      // Historical provider leases can retain recorded config without the
      // sandboxProviderPlugin discriminator. Recorded teardown must not depend
      // on that old dispatch marker or on the current reuse policy.
      updatedAt: new Date(Date.now() - 60_000), metadata: { driver: "sandbox", ...config, pluginId,
        pendingCleanupRetryAttempts: 6, pendingCleanupRetryCapWarned: true,
        pendingCleanupInFlight: false, pendingCleanupRetryAfterMs: 0, pendingCleanupLeaseExpiresAtMs: 0,
        workspaceRecoveryCleanup: { runId, reason: "retained_orphan_sandbox_released", ownerProof: "owner_run_terminal",
          releasedAt: new Date().toISOString(), ...(withReceipt ? { stopReceipt } : {}) } } });
    let outcome: "destroyed" | "not_found" | "archived" | "transient" = "destroyed";
    const inspections = vi.fn(async (input: Record<string, unknown>) => {
      expect(input.providerLeaseId).toBe(providerLeaseId);
      // Boat's adapter normalizes exact absence/archival to destroyed on GET,
      // not by making a destroy RPC. Transport errors prove neither absence nor custody.
      return { providerLeaseId, state: outcome === "not_found" || outcome === "archived" ? "destroyed" : "stopped",
        ...(withSnapshot ? { snapshot: { id: `snapshot-${leaseId}`, state: "completed" } } : {}) };
    });
    const call = vi.fn(async (_plugin: string, method: string, input: Record<string, unknown>) => {
      expect(input.providerLeaseId).toBe(providerLeaseId);
      if (method !== "environmentDestroyLease") throw new Error(`Unexpected provider call: ${method}`);
      if (outcome === "transient") throw new Error("provider temporarily unavailable");
      return { providerLeaseId, state: "destroyed" };
    });
    const worker = { isRunning: (id: string) => id === pluginId,
      call: (id: string, method: string, input: Record<string, unknown>) => method === "environmentValidateConfig"
        ? Promise.resolve({ ok: true, normalizedConfig: input.config })
        : method === "environmentInspectLease" ? inspections(input) : call(id, method, input),
      getWorker: (id: string) => id === pluginId ? { supportedMethods: ["environmentDestroyLease", "environmentStopLease", "environmentInspectLease"] } : undefined } as unknown as PluginWorkerManager;
    const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db, { pluginWorkerManager: worker }) });
    const row = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { actor: unknown }).actor = {
      type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true, companyIds: [companyId],
    }; next(); });
    app.use("/api", environmentRoutes(db, { pluginWorkerManager: worker }));
    app.use(errorHandler);
    const patch = () => request(app).patch(`/api/environments/${environment!.id}?companyId=${companyId}`).send({ config: { image: "fixture:updated" } });
    return { companyId, runId, leaseId, providerLeaseId, stopReceipt, row, call, inspections, heartbeat, patch,
      answer: (value: typeof outcome) => { outcome = value; } };
  }

  it.each(["destroyed", "not_found", "archived"] as const)("gate row: recorded destroy settles %s and unblocks environment PATCH", async outcome => {
    const f = await seed();
    f.answer(outcome);
    const blocked = await f.patch();
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toEqual({ code: "environment_pending_sandbox_cleanup" });
    expect(hasRecoveredCleanupStopReceipt(await f.row())).toBe(true);
    const result = await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    console.log("RECOVERY_CLEANUP", JSON.stringify({ outcome, result, calls: f.call.mock.calls.map(c => c[1]), row: await f.row() }));
    expect(f.inspections).toHaveBeenCalledTimes(1);
    expect(f.call).toHaveBeenCalledTimes(outcome === "destroyed" ? 1 : 0);
    expect(result.destroyed).toBe(1);
    expect(await f.row()).toMatchObject({ status: "expired", cleanupStatus: "success", metadata: {
      workspaceRecoveryCleanup: { stopReceipt: f.stopReceipt }, remoteExecutionTermination: { state: "destroyed", providerLeaseId: f.providerLeaseId } } });
    const updated = await f.patch();
    console.log("ENVIRONMENT_PATCH", updated.status, updated.body);
    expect(updated.status).toBe(200);
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).toHaveBeenCalledTimes(outcome === "destroyed" ? 1 : 0);
    expect(f.inspections).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "cancelled", "interrupted", "stopped"])(
    "holds a %s run's prepared workspace without final SHA even with receipt and snapshot", async status => {
      const f = await seed();
      await db.update(heartbeatRuns).set({ status, runnerProfileJson: { nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: randomUUID(), leaseId: f.leaseId, providerLeaseId: f.providerLeaseId,
        remoteCwd: "/workspace", resourceDisposition: "destroy",
      } } }).where(eq(heartbeatRuns.id, f.runId));
      await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(f.call).not.toHaveBeenCalled();
      expect(await f.row()).toMatchObject({ status: "pending_cleanup", metadata: {
        pendingCleanupHoldReason: "prepared_workspace_without_final_sha",
      } });
      expect((await f.patch()).status).toBe(409);
      // A completed export, not elapsed time or a later terminal kind, releases the hold.
      await db.update(heartbeatRuns).set({ runnerProfileJson: sql`jsonb_set(${heartbeatRuns.runnerProfileJson},
        '{nativeWorkspaceSync,finalHostSha256}', to_jsonb(${'c'.repeat(64)}::text))` }).where(eq(heartbeatRuns.id, f.runId));
      await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(f.call).toHaveBeenCalledTimes(1);
      expect(await f.row()).toMatchObject({ status: "expired", cleanupStatus: "success" });
    });

  it.each([[true, false, "receipt only"], [false, true, "snapshot only"], [false, false, "neither"]] as const)(
    "holds the gate row with %s receipt / %s snapshot (%s)", async (receipt, snapshot) => {
      const f = await seed(receipt, snapshot);
      await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(f.call).not.toHaveBeenCalled();
      expect(await f.row()).toMatchObject({ status: "pending_cleanup" });
      if (receipt) expect(await f.row()).toMatchObject({ metadata: {
        pendingCleanupHoldReason: "completed_provider_snapshot_missing",
      } });
      expect((await f.patch()).status).toBe(409);
    });

  it("destroys the handoff produced by the real retained-orphan settlement", async () => {
    const f = await seed();
    const original = await f.row();
    const { workspaceRecoveryCleanup: _cleanup, ...metadata } = original.metadata!;
    await db.update(environmentLeases).set({ status: "failed", cleanupStatus: "success",
      metadata: { ...metadata, remoteExecutionTermination: f.stopReceipt,
        [ORPHANED_SANDBOX_RECOVERY_KEY]: { recoveredOrphanedRunLease: true, runId: f.stopReceipt.runId } },
    }).where(eq(environmentLeases.id, f.leaseId));
    const report = await runOwnershipReconciliationPass(db, { state: createOwnershipReportState(), record: true });
    expect(report.kinds.find(kind => kind.kind === "environment_retained_orphan_sandbox")?.settled).toBe(1);
    expect(await f.row()).toMatchObject({ status: "pending_cleanup", failureReason: "retained_orphan_sandbox_released" });
    expect(hasRecoveredCleanupStopReceipt(await f.row())).toBe(true);
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(await f.row()).toMatchObject({ status: "expired", cleanupStatus: "success", metadata: {
      workspaceRecoveryCleanup: { stopReceipt: f.stopReceipt } } });
  });

  it.each([0, 6])("counts a transient provider failure at attempt %s, backs off, and retries", async startingAttempts => {
    const f = await seed(); f.answer("transient");
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || ${JSON.stringify({ pendingCleanupRetryAttempts: startingAttempts })}::jsonb` }).where(eq(environmentLeases.id, f.leaseId));
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).toHaveBeenCalledTimes(1);
    const failed = await f.row();
    expect(failed).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed", metadata: {
      pendingCleanupRetryAttempts: Math.min(startingAttempts, 5) + 1, pendingCleanupInFlight: false, workspaceRecoveryCleanup: { stopReceipt: f.stopReceipt } } });
    expect(Number(failed.metadata?.pendingCleanupRetryAfterMs)).toBeGreaterThan(Date.now());
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).toHaveBeenCalledTimes(1);
    await db.update(environmentLeases).set({ metadata: sql`${environmentLeases.metadata} || '{"pendingCleanupRetryAfterMs":0}'::jsonb` }).where(eq(environmentLeases.id, f.leaseId));
    f.answer("destroyed");
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(await f.row()).toMatchObject({ status: "expired", cleanupStatus: "success" });
  });

  it("never destroys a released-for-cleanup row without its stop receipt", async () => {
    const f = await seed(false);
    await db.update(environmentLeases).set({ leasePolicy: "ephemeral" }).where(eq(environmentLeases.id, f.leaseId));
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).not.toHaveBeenCalled();
    expect(await f.row()).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
  });

  it.each(["companyId", "runId", "leaseId", "provider", "providerLeaseId", "schema", "state"] as const)(
    "never destroys with a mismatched stop receipt %s", async field => {
      const f = await seed();
      const lease = await f.row();
      const cleanup = lease.metadata!.workspaceRecoveryCleanup as Record<string, unknown>;
      await db.update(environmentLeases).set({ leasePolicy: "ephemeral", metadata: { ...lease.metadata,
        workspaceRecoveryCleanup: { ...cleanup, stopReceipt: { ...f.stopReceipt, [field]: "foreign-or-invalid" } },
      } }).where(eq(environmentLeases.id, f.leaseId));
      await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
      expect(f.call).not.toHaveBeenCalled();
      expect(await f.row()).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
    });
});
