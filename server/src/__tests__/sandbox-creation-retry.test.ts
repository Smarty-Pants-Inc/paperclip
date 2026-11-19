import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, environments, heartbeatRuns, plugins, sandboxCreationOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// rf-4 U3 C2 (money): a host retry after a timed-out sandbox create must not
// mint a second billable box. The scripted provider dedupes by creation key,
// as Boat does with Idempotency-Key, and a timed-out create still materializes.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_HISTORY_TEST_DATABASE_URL");
describe("a run retry and its predecessor's pending sandbox creation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let companyId: string, environmentId: string, agentId: string, spool: string, workers: PluginWorkerManager;
  let timeOut: boolean, failBeforeBox: boolean;
  const keys: string[] = [], destroyed: string[] = [];
  const boxes = new Map<string, string>();
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("sandbox-creation-retry-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`truncate sandbox_creation_operations, companies, environments, plugins cascade`);
    companyId = randomUUID(); environmentId = randomUUID(); agentId = randomUUID();
    timeOut = false; failBeforeBox = false; keys.length = 0; destroyed.length = 0; boxes.clear();
    spool = await mkdtemp(join(tmpdir(), "sandbox-creation-retry-"));
    await db.insert(companies).values({ id: companyId, name: "Retry fixture", issuePrefix: "RTY" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox", config: { provider: "creation-fixture", image: "fixture", reuseLease: false } });
    await db.insert(plugins).values({ id: randomUUID(), pluginKey: "paperclip.creation-fixture", packageName: "creation-fixture", version: "1.0.0", apiVersion: 1,
      status: "ready", categories: ["automation"], manifestJson: { id: "paperclip.creation-fixture", version: "1.0.0", apiVersion: 1,
      displayName: "Creation fixture", description: "Idempotent provider", author: "Paperclip", categories: ["automation"],
      capabilities: ["environment.drivers.register"], entrypoints: { worker: "fixture.js" }, environmentDrivers: [{
        driverKey: "creation-fixture", kind: "sandbox_provider", displayName: "Fixture", creationOperationVersion: 1, configSchema: { type: "object" },
      }] } });
    workers = {
      isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentAcquireLease", "environmentInspectLease", "environmentDestroyLease"] }),
      call: vi.fn(async (_pluginId: string, method: string, input: any) => {
        if (method === "environmentAcquireLease") {
          const key = input.creationOperationId;
          keys.push(key);
          if (failBeforeBox) throw Object.assign(new Error("Provider refused the create"), { code: "EPROVIDER" });
          if (!boxes.has(key)) boxes.set(key, `box-${boxes.size + 1}`);
          if (timeOut) throw Object.assign(new Error("Provider create timed out"), { code: "ETIMEDOUT" });
          return { providerLeaseId: boxes.get(key), metadata: { remoteCwd: "/workspace" } };
        }
        if (method === "environmentInspectLease") {
          const id = input.creationOperation.id, box = boxes.get(id);
          if (!box) return { providerLeaseId: id, state: "destroyed" };
          return { providerLeaseId: box, state: "active", creationCleanup: { providerLeaseId: box, observedProviderLeaseId: box,
            companyId, environmentId, runId: input.creationOperation.runId, attemptId: id,
            accountFingerprint: "a".repeat(64), labels: { "paperclip-create-attempt": id } } };
        }
        if (method === "environmentDestroyLease") {
          destroyed.push(input.providerLeaseId);
          return { providerLeaseId: input.providerLeaseId, state: "destroyed" };
        }
        throw new Error(`Unexpected fixture method ${method}`);
      }),
    } as unknown as PluginWorkerManager;
  });
  afterEach(async () => { await rm(spool, { recursive: true, force: true }); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  const runtime = () => environmentRuntimeService(db, { pluginWorkerManager: workers, orphanCleanupSpoolDir: spool });
  async function run(retryOfRunId?: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running", invocationSource: "manual", retryOfRunId });
    return id;
  }
  async function acquire(heartbeatRunId: string) {
    return runtime().acquireRunLease({ companyId, environment: (await environmentService(db).getById(environmentId))!,
      heartbeatRunId, issueId: null, persistedExecutionWorkspace: null, assertCompanyBinding: true });
  }
  /** The first run's create times out; the host fails it and schedules a retry run. */
  async function timedOutThenRetry() {
    const first = await run();
    timeOut = true;
    await expect(acquire(first)).rejects.toThrow("timed out");
    timeOut = false;
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, first));
    return { first, retry: await run(first) };
  }
  async function recover() {
    await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0),
      metadata: sql`metadata || '{"creationSettleAt":"2000-01-01T00:00:00Z"}'::jsonb` });
    await runtime().flushDeferredOrphanCleanups();
  }

  it("R1: a retry after a timed-out create makes ONE create key and ONE box, and runs on it", async () => {
    const { retry } = await timedOutThenRetry();
    const { lease } = await acquire(retry);
    expect(new Set(keys).size).toBe(1);
    expect(boxes.size).toBe(1);
    expect(lease).toMatchObject({ providerLeaseId: "box-1", heartbeatRunId: retry, status: "active" });
    const [operation] = await db.select().from(sandboxCreationOperations);
    expect(operation).toMatchObject({ id: keys[0], state: "attached", leaseId: lease.id, metadata: { creationHeartbeatRunId: retry } });
  });

  it("R2: the old operation's recovery never stops the box the retry adopted", async () => {
    const { retry } = await timedOutThenRetry();
    const { lease } = await acquire(retry);
    await recover();
    expect(destroyed).toEqual([]);
    expect(await environmentService(db).getLeaseById(lease.id)).toMatchObject({ status: "active", providerLeaseId: "box-1" });
    expect(await db.select().from(sandboxCreationOperations)).toEqual([expect.objectContaining({ state: "attached", leaseId: lease.id })]);
    expect(await db.select().from(environmentLeases)).toHaveLength(1);
  });

  it("R3: when the first create truly failed and recovery resolved it absent, the retry creates fresh", async () => {
    const first = await run();
    failBeforeBox = true;
    await expect(acquire(first)).rejects.toThrow("refused");
    failBeforeBox = false;
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, first));
    await recover();
    expect((await db.select().from(sandboxCreationOperations))[0]).toMatchObject({ state: "resolved",
      metadata: { creationReconciliationReason: "provider_absent_after_bounded_recovery" } });
    const { lease } = await acquire(await run(first));
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(boxes.size).toBe(1);
    expect(lease.providerLeaseId).toBe("box-1");
  });

  it("R4: an ordinary first create is unchanged", async () => {
    const first = await run();
    const { lease } = await acquire(first);
    expect(keys).toHaveLength(1);
    const [operation] = await db.select().from(sandboxCreationOperations);
    expect(operation).toMatchObject({ id: keys[0], runId: first, state: "attached", leaseId: lease.id, metadata: { creationHeartbeatRunId: first } });
  });
});
