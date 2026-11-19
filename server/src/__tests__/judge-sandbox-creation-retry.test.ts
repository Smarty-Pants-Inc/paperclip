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
import { attachSandboxCreation, environmentService } from "../services/environments.js";
import { createOwnedSandbox, recoverSandboxCreations } from "../services/sandbox-creation-operations.js";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, environmentAcquireErrorData } from "@paperclipai/plugin-sdk";
import { getEnvironmentAcquisitionDiagnostic } from "../services/environment-acquisition-diagnostics.js";
import { readTransientLeaseAcquisitionFailure } from "../services/environment-provider-unavailable-error.js";
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
  // SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: a scripted create outcome. `before`
  // fails with nothing made; `after` fails once the box exists (a lost reply).
  // A key whose box is stopped replays as box_stopped; `bodyChanged` replays a
  // known key as Boat's 409 idempotency_key_reused (the plugin's F1 body drift).
  let script: { before?: () => Error; after?: () => Error } | null, bodyChanged: boolean;
  const stopped = new Set<string>();
  const running = () => [...boxes.values()].filter(box => !stopped.has(box) && !destroyed.includes(box));
  const boatError = (status: number, code?: string) => Object.assign(new Error(`Boat create failed (HTTP ${status})`), { status, ...(code ? { code } : {}) });
  // Over the worker RPC boundary, as the plugin SDK's acquire envelope carries it.
  const rpcBoatError = (status: number, code: string) => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
    message: `Boat create failed (HTTP ${status})`, data: { schema: "paperclip/environment-acquire-error/v1",
      providerDiagnostic: { httpStatus: status }, creationIdempotencyCode: code } });
  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("sandbox-creation-retry-");
    db = createDb(external ?? database!.connectionString, { maxConnections: 4, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 90_000);
  beforeEach(async () => {
    await db.execute(sql`truncate sandbox_creation_operations, companies, environments, plugins cascade`);
    companyId = randomUUID(); environmentId = randomUUID(); agentId = randomUUID();
    timeOut = false; failBeforeBox = false; keys.length = 0; destroyed.length = 0; boxes.clear();
    script = null; bodyChanged = false; stopped.clear();
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
          if (script?.before) throw script.before();
          if (boxes.has(key) && bodyChanged) throw rpcBoatError(409, "idempotency_key_reused");
          if (boxes.has(key) && stopped.has(boxes.get(key)!)) throw rpcBoatError(409, "boat_idempotency_box_stopped");
          if (!boxes.has(key)) boxes.set(key, `box-${boxes.size + 1}`);
          if (timeOut) throw Object.assign(new Error("Provider create timed out"), { code: "ETIMEDOUT" });
          if (script?.after) throw script.after();
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

  it("J1 config equality: changing the image before retry makes a fresh key and box", async () => {
    const { retry } = await timedOutThenRetry();
    await db.update(environments).set({ config: { provider: "creation-fixture", image: "changed", reuseLease: false } }).where(eq(environments.id, environmentId));
    await acquire(retry);
    expect(new Set(keys).size).toBe(2);
    expect(boxes.size).toBe(2);
  });

  it("J2 money: a second invocation of the SAME retry cannot create another key after its own timeout", async () => {
    const { retry } = await timedOutThenRetry();
    timeOut = true;
    await expect(acquire(retry)).rejects.toThrow("timed out");
    timeOut = false;
    // Like a same-run recovery/re-entry, this must either reconcile or return
    // the same box. A new key while the original is unresolved is never OK.
    const keysBeforeReentry = new Set(keys).size, boxesBeforeReentry = boxes.size;
    await acquire(retry).catch(() => undefined);
    console.log("J2_MONEY", JSON.stringify({ keysBeforeReentry, keysAfterReentry: new Set(keys).size,
      boxesBeforeReentry, boxesAfterReentry: boxes.size, keys }));
    expect(new Set(keys).size).toBe(keysBeforeReentry);
    expect(boxes.size).toBe(boxesBeforeReentry);
  });

  it("J3 ownership: original live run cannot attach after the retry moves its pending creation", async () => {
    const { first, retry } = await timedOutThenRetry();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, first));
    const existing = (await db.select().from(sandboxCreationOperations))[0];
    // Move ownership without attaching, through the actual server primitive.
    await createOwnedSandbox(db, { companyId, environmentId, heartbeatRunId: retry,
      provider: existing.provider, driverKey: existing.driverKey, config: existing.config,
      requestKey: existing.requestKey, metadata: existing.metadata }, async () => ({ providerLeaseId: "box-1" }));
    let oldWasAdmitted = false;
    await attachSandboxCreation(db, existing.id, { companyId, environmentId, heartbeatRunId: first }, async () => {
      oldWasAdmitted = true;
      throw new Error("judge callback reached: original owner admitted");
    }).catch(() => undefined);
    expect(oldWasAdmitted).toBe(false);
  });

  it("J4 durability: move then callback failure preserves identity, moved owner and new deadline", async () => {
    const { first, retry } = await timedOutThenRetry();
    const existing = (await db.select().from(sandboxCreationOperations))[0];
    await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0),
      metadata: { ...existing.metadata, creationSettleAt: "2000-01-01T00:00:00Z", creationController: { stale: true } } });
    const beforeSend = Date.now();
    await expect(createOwnedSandbox(db, { companyId, environmentId, heartbeatRunId: retry,
      provider: existing.provider, driverKey: existing.driverKey, config: existing.config,
      requestKey: existing.requestKey, metadata: existing.metadata }, async identity => {
      expect(identity).toEqual({ id: existing.id, runId: first });
      throw new Error("judge failure after move before sending");
    })).rejects.toThrow("judge failure");
    const [moved] = await db.select().from(sandboxCreationOperations);
    expect(moved).toMatchObject({ id: existing.id, runId: first, state: "pending", leaseId: null,
      metadata: { creationHeartbeatRunId: retry } });
    expect(moved.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(beforeSend + 30 * 60_000);
    expect(Date.parse(String(moved.metadata.creationSettleAt))).toBe(moved.nextAttemptAt.getTime());
    expect(moved.metadata.creationController).not.toEqual({ stale: true });
  });

  it("J5 recovery race: stale inspect can take the moved creation; retry visibly rejects without a second box", async () => {
    const { retry } = await timedOutThenRetry();
    await db.update(sandboxCreationOperations).set({ nextAttemptAt: new Date(0) });
    let inspected!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { inspected = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const sweep = recoverSandboxCreations(db, async operation => {
      inspected(); await resume;
      return { providerLeaseId: "box-1", state: "active", creationCleanup: {
        providerLeaseId: "box-1", observedProviderLeaseId: "box-1", companyId, environmentId,
        runId: operation.runId, attemptId: operation.id, accountFingerprint: "a".repeat(64),
        labels: { "paperclip-create-attempt": operation.id } } };
    });
    await entered;
    const originalCall = workers.call.bind(workers);
    workers.call = (async (...args: any[]) => {
      if (args[1] === "environmentAcquireLease") { release(); await sweep; }
      return (originalCall as any)(...args);
    }) as typeof workers.call;
    try {
      await expect(acquire(retry)).rejects.toThrow("ownership has already transferred");
      expect(new Set(keys).size).toBe(1);
      expect(boxes.size).toBe(1);
      expect((await db.select().from(sandboxCreationOperations))[0]).toMatchObject({ state: "cleanup_pending", metadata: { creationHeartbeatRunId: retry } });
      const cleanupRow = (await db.select().from(environmentLeases))[0];
      const cleanupLease = (await environmentService(db).getLeaseById(cleanupRow.id))!;
      await runtime().retryPendingSandboxTeardown({ environment: (await environmentService(db).getById(environmentId))!, lease: cleanupLease });
      expect(destroyed).toEqual(["box-1"]);
      console.log("J5_RECOVERY_RACE", JSON.stringify({ keys, boxes: boxes.size, destroyed, retryRejected: true }));
    } finally { release(); await sweep; }
  });

  it("J6 trace/retry: a carried provider-start diagnostic belongs to the retry, not only the original run", async () => {
    const { first, retry } = await timedOutThenRetry();
    const originalCall = workers.call.bind(workers);
    workers.call = (async (...args: any[]) => {
      if (args[1] !== "environmentAcquireLease") return (originalCall as any)(...args);
      const input = args[2];
      throw new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
        message: "Boat could not start the provisional box; cleanup pending",
        data: { schema: "paperclip/environment-creation-cleanup/v1",
          cleanup: { companyId, environmentId, runId: input.runId, attemptId: input.creationOperationId,
            providerLeaseId: "box-1", accountFingerprint: "a".repeat(64), labels: {} },
          acquisitionDiagnostic: { phase: "create", providerState: "error", elapsedMs: 12_000, budgetMs: 180_000 } } });
    }) as typeof workers.call;
    const error = await acquire(retry).catch(error => error);
    console.log("J6_DIAGNOSTIC", JSON.stringify({ first, retry,
      original: getEnvironmentAcquisitionDiagnostic(error, { id: first, companyId }),
      retryDiagnostic: getEnvironmentAcquisitionDiagnostic(error, { id: retry, companyId }),
      retryClassification: readTransientLeaseAcquisitionFailure(error, { id: retry, companyId }) }));
    expect(getEnvironmentAcquisitionDiagnostic(error, { id: retry, companyId })).toMatchObject({ phase: "create", providerState: "error" });
    expect(readTransientLeaseAcquisitionFailure(error, { id: retry, companyId })).toEqual({ reason: "acquisition_incomplete" });
  });

  // SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: review-fleet-4's J7 pinned a refused
  // creation as carried. The final rules (review-fleet-4 + RFL, 03:11-03:13Z)
  // spend a FIRM refusal and carry every timeout, transient or unknown outcome.
  /** The first run's create fails as scripted; the host fails it and schedules a retry run. */
  async function failedThenRetry(outcome: { before?: () => Error; after?: () => Error }) {
    const first = await run(); script = outcome;
    await expect(acquire(first)).rejects.toThrow(); script = null;
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, first));
    return { first, retry: await run(first) };
  }

  it.each([false, true])("SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: J7a a firm refusal (422) is spent; the retry uses a FRESH key (config changed=%s)", async changed => {
    const { retry } = await failedThenRetry({ before: () => boatError(422) });
    const [refused] = await db.select().from(sandboxCreationOperations);
    expect(refused).toMatchObject({ id: keys[0], state: "resolved", leaseId: null, metadata: { creationReconciliationReason: "provider_refused_create" } });
    if (changed) await db.update(environments).set({ config: { provider: "creation-fixture", image: "changed", reuseLease: false } }).where(eq(environments.id, environmentId));
    const { lease } = await acquire(retry);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
    expect(new Set(keys).size).toBe(2);
    expect(boxes.size).toBe(1);
    expect(lease.providerLeaseId).toBe("box-1");
  });

  it.each([
    ["429", () => boatError(429), false], ["503 after the box was made", () => boatError(503), true],
  ] as const)("SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: J7b a transient %s is carried; the retry re-sends the SAME key", async (_name, error, made) => {
    const { retry } = await failedThenRetry(made ? { after: error } : { before: error });
    const { lease } = await acquire(retry);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(boxes.size).toBe(1);
    expect(lease.providerLeaseId).toBe("box-1");
  });

  it.each([
    ["a 408", () => boatError(408)],
    ["a plugin RPC timeout", () => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: "environmentAcquireLease timed out" })],
    ["an unknown outcome", () => new Error("socket hang up")],
  ] as const)("SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: GUARD %s is STILL carried: same key, one box", async (_name, error) => {
    const { retry } = await failedThenRetry({ after: error });
    expect((await db.select().from(sandboxCreationOperations))[0]).toMatchObject({ state: "pending" });
    const { lease } = await acquire(retry);
    expect(new Set(keys).size).toBe(1);
    expect(boxes.size).toBe(1);
    expect(lease.providerLeaseId).toBe("box-1");
  });

  it("SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: in_progress a 409 idempotency_in_progress is carried, never spent", async () => {
    const { retry } = await failedThenRetry({ after: () => rpcBoatError(409, "idempotency_in_progress") });
    expect((await db.select().from(sandboxCreationOperations))[0]).toMatchObject({ state: "pending" });
    const { lease } = await acquire(retry);
    expect(new Set(keys).size).toBe(1);
    expect(boxes.size).toBe(1);
    expect(lease.providerLeaseId).toBe("box-1");
  });

  // SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119 (judges' final key_reused rule, RFL +
  // review-fleet-4, 03:13-03:15Z): Boat's 409 idempotency_key_reused SPENDS the
  // creation like a firm refusal, is reported as its own named error, and that
  // key is NEVER sent again: the host's next retry mints a fresh key. There is no
  // find-and-hand-to-cleanup step; the earlier attempt's box (if any) self-stops
  // at its ttl, so ONLY in this bug case may the run have up to 2 boxes.
  it("SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: key_reused is its own named error, SPENT, and the next retry gets a FRESH key (<= 2 boxes only here)", async () => {
    const { retry } = await timedOutThenRetry();
    bodyChanged = true;
    const error = await acquire(retry).catch(error => error);
    expect(error).toMatchObject({ name: "SandboxCreationKeyReusedError", code: "sandbox_creation_key_reused" });
    expect(readTransientLeaseAcquisitionFailure(error, { id: retry, companyId })).toEqual({ reason: "creation_key_reused" });
    const [spent] = await db.select().from(sandboxCreationOperations);
    expect(spent).toMatchObject({ id: keys[0], state: "resolved", leaseId: null,
      metadata: { creationReconciliationReason: "provider_key_reused" } });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, retry));
    const { lease } = await acquire(await run(retry));
    // The reused key went out twice (the timed-out create, the refused re-send) and never again.
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys.filter(key => key === keys[0])).toHaveLength(2);
    expect(lease.providerLeaseId).toBe("box-2");
    expect(boxes.size).toBeLessThanOrEqual(2);
    expect(running()).toEqual(["box-1", "box-2"]);
    expect(destroyed).toEqual([]);
    expect((await db.select().from(sandboxCreationOperations)).find(op => op.id === keys[0])).toMatchObject({ state: "resolved" });
  });

  it("SUPERSEDE-RF4-J7-REFUSAL-SPENT-1119: box_stopped spends the creation; the next retry gets a FRESH key and ONE running box", async () => {
    const { retry } = await timedOutThenRetry();
    stopped.add("box-1");
    await expect(acquire(retry)).rejects.toThrow("HTTP 409");
    expect((await db.select().from(sandboxCreationOperations))[0]).toMatchObject({ state: "resolved",
      metadata: { creationReconciliationReason: "provider_box_stopped" } });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, retry));
    const { lease } = await acquire(await run(retry));
    expect(new Set(keys).size).toBe(2);
    expect(lease).toMatchObject({ providerLeaseId: "box-2", status: "active" });
    expect(running()).toEqual(["box-2"]);
    expect([...stopped]).toEqual(["box-1"]);
  });

  // review-fleet-4 F1 (money): a timeout errno beats a client status. A create
  // that failed with a timeout-shaped 4xx (HTTP 422 + the closed transient
  // ETIMEDOUT) may have made the box, so it is CARRIED: the retry re-sends the
  // same key and runs on that one box. A plain 422 is still a firm refusal.
  const acquireRpcError = (fields: { status: number; code?: string }) => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
    message: `Boat create failed (HTTP ${fields.status})`, data: environmentAcquireErrorData(Object.assign(new Error("Boat create failed"), fields)) });
  it.each([
    ["a 422 + ETIMEDOUT across the worker RPC", () => acquireRpcError({ status: 422, code: "ETIMEDOUT" })],
    ["an in-process 422 + ETIMEDOUT", () => boatError(422, "ETIMEDOUT")],
    ["a 408 across the worker RPC", () => acquireRpcError({ status: 408 })],
  ] as const)("F1-TIMEOUT-ERRNO-CARRIED: %s after the box was made is CARRIED: ONE key, ONE running box", async (_name, error) => {
    const { retry } = await failedThenRetry({ after: error });
    expect((await db.select().from(sandboxCreationOperations))[0]).toMatchObject({ id: keys[0], state: "pending" });
    const { lease } = await acquire(retry);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(boxes.size).toBe(1);
    expect(running()).toEqual(["box-1"]);
    expect(lease).toMatchObject({ providerLeaseId: "box-1", status: "active" });
  });

  it("F1-TIMEOUT-ERRNO-CARRIED: GUARD a plain 422 across the worker RPC is still SPENT; the retry uses a FRESH key", async () => {
    const { retry } = await failedThenRetry({ before: () => acquireRpcError({ status: 422 }) });
    expect((await db.select().from(sandboxCreationOperations))[0]).toMatchObject({ id: keys[0], state: "resolved", leaseId: null,
      metadata: { creationReconciliationReason: "provider_refused_create" } });
    const { lease } = await acquire(retry);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
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
