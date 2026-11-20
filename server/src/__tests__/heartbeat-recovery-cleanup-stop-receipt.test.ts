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

  async function seed(withReceipt = true) {
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
      updatedAt: new Date(Date.now() - 60_000), metadata: { driver: "sandbox", ...config, pluginId,
        pendingCleanupRetryAttempts: 6, pendingCleanupRetryCapWarned: true,
        pendingCleanupInFlight: false, pendingCleanupRetryAfterMs: 0, pendingCleanupLeaseExpiresAtMs: 0,
        workspaceRecoveryCleanup: { runId, reason: "retained_orphan_sandbox_released", ownerProof: "owner_run_terminal",
          releasedAt: new Date().toISOString(), ...(withReceipt ? { stopReceipt } : {}) } } });
    let outcome: "destroyed" | "not_found" | "archived" | "transient" = "destroyed";
    const call = vi.fn(async (_plugin: string, method: string, input: Record<string, unknown>) => {
      expect(input.providerLeaseId).toBe(providerLeaseId);
      if (method !== "environmentDestroyLease") throw new Error(`Unexpected provider call: ${method}`);
      if (outcome === "transient") throw new Error("provider temporarily unavailable");
      // The provider's lifecycle contract normalizes exact not-found and archived
      // allocations to a destroyed receipt; these are not guessed from errors.
      return { providerLeaseId, state: "destroyed", providerState: outcome };
    });
    const worker = { isRunning: (id: string) => id === pluginId, call,
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
    return { companyId, leaseId, providerLeaseId, stopReceipt, row, call, heartbeat, patch,
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
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(result.destroyed).toBe(1);
    expect(await f.row()).toMatchObject({ status: "expired", cleanupStatus: "success", metadata: {
      workspaceRecoveryCleanup: { stopReceipt: f.stopReceipt }, remoteExecutionTermination: { state: "destroyed", providerLeaseId: f.providerLeaseId } } });
    const updated = await f.patch();
    console.log("ENVIRONMENT_PATCH", updated.status, updated.body);
    expect(updated.status).toBe(200);
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).toHaveBeenCalledTimes(1);
  });

  it("counts a transient provider failure, backs off, and retries", async () => {
    const f = await seed(); f.answer("transient");
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).toHaveBeenCalledTimes(1);
    const failed = await f.row();
    expect(failed).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed", metadata: {
      pendingCleanupRetryAttempts: 7, pendingCleanupInFlight: false, workspaceRecoveryCleanup: { stopReceipt: f.stopReceipt } } });
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
    await f.heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });
    expect(f.call).not.toHaveBeenCalled();
    expect(await f.row()).toMatchObject({ status: "pending_cleanup", cleanupStatus: "failed" });
  });
});
