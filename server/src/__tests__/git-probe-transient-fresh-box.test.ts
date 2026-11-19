import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, issues, plugins, type Db } from "@paperclipai/db";
import type { Environment } from "@paperclipai/shared";
import { heartbeatService } from "../services/heartbeat.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Boat storage incident (smarty-dev#21249), review-fleet-4's one-box row: a
// legacy run whose final Git probe failed ends `environment_provider_unavailable`
// before the runtime selection sets a resource disposition, so the executor's
// finally releases its lease with none. Real DB lease rows and real runtime
// dispatch; only the external provider is a stateful fixture with one id per box.
describe("a final Git probe failure retries on a fresh box", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_ENVIRONMENT_RUNTIME_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("git-probe-fresh-box-");
    db = createDb(external ?? temporary!.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  it("GP-R2: releases and stops the failed run's box, and the retry acquires a different box; one live box remains", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), pluginId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Git probe fresh box", issuePrefix: `GP${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Legacy worker", adapterType: "claude_local", adapterConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retry on a fresh box", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy", status: "running" });
    const provider = `git-probe-${pluginId}`;
    await db.insert(plugins).values({ id: pluginId, pluginKey: provider, packageName: "git-probe-provider",
      version: "1.0.0", apiVersion: 1, categories: ["automation"], status: "ready",
      manifestJson: { id: provider, apiVersion: 1, version: "1.0.0", displayName: "Git probe provider",
        description: "Stateful external sandbox boundary", author: "Paperclip", categories: ["automation"],
        capabilities: ["environment.drivers.register"], entrypoints: { worker: "dist/worker.js" },
        environmentDrivers: [{ driverKey: provider, kind: "sandbox_provider", displayName: "Git probe",
          supportsReusableLeases: true, configSchema: { type: "object", properties: {
            image: { type: "string" }, reuseLease: { type: "boolean" },
          } } }] } });
    const [environment] = await db.insert(environments).values({ name: "Boat", driver: "sandbox", status: "active",
      config: { provider, image: "fake:test", reuseLease: true } }).returning();
    const live = new Set<string>();
    let boxes = 0;
    const call = vi.fn(async (_pluginId: string, method: string, input: Record<string, unknown>) => {
      if (method === "environmentAcquireLease") {
        const providerLeaseId = `box-${++boxes}`;
        live.add(providerLeaseId);
        return { providerLeaseId, metadata: { remoteCwd: "/work" } };
      }
      if (method === "environmentResumeLease") {
        live.add(String(input.providerLeaseId));
        return { providerLeaseId: input.providerLeaseId, metadata: { remoteCwd: "/work" } };
      }
      if (["environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"].includes(method)) {
        live.delete(String(input.providerLeaseId));
        return { providerLeaseId: input.providerLeaseId, state: method === "environmentDestroyLease" ? "destroyed" : "stopped" };
      }
      throw new Error(`Unexpected provider call: ${method}`);
    });
    const worker = { isRunning: () => true, call, getWorker: () => ({ supportedMethods: ["environmentResumeLease",
      "environmentReleaseLease", "environmentStopLease", "environmentDestroyLease"] }) } as unknown as PluginWorkerManager;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: worker });
    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });
    const input = { companyId, agentId, issueId, environment: environment as unknown as Environment,
      heartbeatRunId: runId, persistedExecutionWorkspace: null, adapterType: "claude_local" };
    const first = await runtime.acquireRunLease(input);
    expect(first.lease.leasePolicy).toBe("reuse_by_environment");

    // The setup path recorded the transient failure before the run's lease release.
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "environment_provider_unavailable", finishedAt: new Date(),
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, runId));
    await heartbeat.releaseEnvironmentLeasesForRun({ runId, companyId, agentId, status: "failed",
      failureReason: "Could not read execution-target Git context: the probe timed out (attempts=2)" });
    expect(call.mock.calls.map(entry => entry[1])).toEqual(["environmentAcquireLease", "environmentReleaseLease"]);
    expect(await environmentService(db).getLeaseById(first.lease.id)).toMatchObject({ status: "failed", cleanupStatus: "success" });

    const retryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId, agentId, issueId, runtimeMode: "legacy", status: "running",
      retryOfRunId: runId });
    const retry = await runtime.acquireRunLease({ ...input, heartbeatRunId: retryRunId });
    expect(retry.lease.providerLeaseId).not.toBe(first.lease.providerLeaseId);
    expect(call.mock.calls.some(entry => entry[1] === "environmentResumeLease")).toBe(false);
    expect([...live]).toEqual([retry.lease.providerLeaseId]);
    const activeForIssue = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, companyId), eq(environmentLeases.issueId, issueId),
      inArray(environmentLeases.status, ["active", "retained", "released", "pending_cleanup"])));
    expect(activeForIssue.map(row => row.id)).toEqual([retry.lease.id]);
  });
});
