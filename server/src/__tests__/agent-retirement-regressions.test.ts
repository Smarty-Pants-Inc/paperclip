import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentApiKeys, agentWakeupRequests, authUsers, companies,
  companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { configureAgentLifecycle, createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createAgentLifecycle as lifecycleWithEffects } from "../modules/agent-lifecycle/index.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { assertAgentInteraction } from "../services/agent-interaction-policy.js";
import { issueService } from "../services/issues.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Only the external Stop delivery boundary is suspended. Production HTTP,
// authorization, lifecycle transactions, worker and checkout use real PostgreSQL.
const stopBoundary = vi.hoisted(() => ({ deliver: undefined as undefined | (() => Promise<void>) }));
vi.mock("../services/heartbeat.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return { ...actual, heartbeatService: (...args: Parameters<typeof actual.heartbeatService>) => {
    const service = actual.heartbeatService(...args);
    return { ...service, cancelInvocationsForAgents: async (...input: Parameters<typeof service.cancelInvocationsForAgents>) => {
      if (!stopBoundary.deliver) return service.cancelInvocationsForAgents(...input);
      await stopBoundary.deliver();
      return { agentIds: input[0], runsCancelled: 0, wakeupsCancelled: 0 };
    } };
  } };
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("#20389 RFL retirement regressions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "retirement-regressions-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("retirement-regressions-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    stopBoundary.deliver = undefined;
    for (const worker of workers) await worker.stop();
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed() {
    for (const worker of workers) await worker.stop();
    const companyId = randomUUID(), userId = randomUUID(), managerId = randomUUID(), workerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retirement regression", issuePrefix: `R${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(agents).values({ id: managerId, companyId, name: "Manager", adapterType: "process", status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { enabled: false } } });
    await db.insert(agents).values({ id: workerId, companyId, name: "Worker", reportsTo: managerId, adapterType: "process", status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { enabled: false } } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...[managerId, workerId].map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: managerId, permissionKey: "agents:configure", scope: { subtreeRootAgentId: managerId } },
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" },
    ]);
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: managerId, name: "Manager", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express();
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(db));
    api.use(errorHandler);
    const task = await issueService(db).create(companyId, { title: "Unfinished task", status: "in_progress", assigneeAgentId: workerId });
    const currentTask = async () => (await db.select().from(issues).where(eq(issues.id, task.id)))[0]!;
    const currentAgent = async () => (await db.select().from(agents).where(eq(agents.id, workerId)))[0]!;
    const terminate = (via: "PATCH" | "POST") => via === "PATCH"
      ? request(api).patch(`/api/agents/${workerId}`).set("Authorization", `Bearer ${token}`).send({ status: "terminated" })
      : request(api).post(`/api/agents/${workerId}/terminate`).set("Authorization", `Bearer ${token}`).send({});
    return { companyId, userId, managerId, workerId, task, currentTask, currentAgent, terminate };
  }

  it("PATCH with an unconfirmed stop must not permit a second task checkout", async () => {
    const f = await seed();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.workerId, status: "running", startedAt: new Date(), contextSnapshot: { issueId: f.task.id } });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, f.task.id));
    const response = await f.terminate("PATCH");
    expect(response.status, response.text).toBe(200);
    expect(await f.currentAgent()).toMatchObject({ lifecycleState: "terminating" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "running", finishedAt: null });
    // A real contender row is required: checkoutRunId has a run foreign key.
    const managerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: managerRunId, companyId: f.companyId, agentId: f.managerId, status: "running", contextSnapshot: { issueId: f.task.id } });
    await expect(issueService(db).checkout(f.task.id, f.managerId, ["todo", "in_progress"], managerRunId)).rejects.toMatchObject({ status: 409 });
    // Attempt the competing checkout before inspecting the old exclusion fields.
    await expect(issueService(db).checkout(f.task.id, f.managerId, ["todo", "in_progress"], randomUUID())).rejects.toThrow();
    expect(await f.currentTask()).toMatchObject({ assigneeAgentId: f.workerId, status: "in_progress", executionRunId: runId, checkoutRunId: runId });
  }, 60_000);

  it("POST terminate preserves execution exclusion throughout delayed Stop delivery", async () => {
    const f = await seed();
    const runId = randomUUID(), delivering = barrier(), deliver = barrier();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.workerId, status: "running", startedAt: new Date() });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, f.task.id));
    stopBoundary.deliver = async () => { delivering.release(); await deliver.promise; };
    const response = f.terminate("POST").then(value => value);
    try {
      await delivering.promise;
      const managerRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: managerRunId, companyId: f.companyId, agentId: f.managerId, status: "running", contextSnapshot: { issueId: f.task.id } });
      await expect(issueService(db).checkout(f.task.id, f.managerId, ["todo", "in_progress"], managerRunId)).rejects.toMatchObject({ status: 409 });
      expect(await f.currentAgent()).toMatchObject({ lifecycleState: "terminating" });
      await expect(issueService(db).checkout(f.task.id, f.managerId, ["todo", "in_progress"], randomUUID())).rejects.toThrow();
      expect(await f.currentTask()).toMatchObject({ assigneeAgentId: f.workerId, executionRunId: runId, checkoutRunId: runId });
    } finally {
      deliver.release();
      await response;
      stopBoundary.deliver = undefined;
    }
  }, 60_000);

  for (const order of ["task-first", "agent-first"] as const) {
    it(`terminate and checkout must not deadlock on opposite lock order (${order})`, async () => {
      const f = await seed();
      const taskLocked = barrier(), agentLocked = barrier(), runCheckout = barrier(), runTermination = barrier();
      const effects = createAgentLifecycleEffects();
      const transaction = effects.transaction;
      let first = true;
      effects.transaction = (database, companyId, work) => transaction(database, companyId, async (tx, publications) => {
        await tx.execute(sql`set local deadlock_timeout = '100ms'`);
        await tx.execute(sql`set local statement_timeout = '15s'`);
        // Instrument the same agent lock the production store immediately takes.
        await tx.select().from(agents).where(eq(agents.id, f.workerId)).for("update");
        if (first) { first = false; agentLocked.release(); await runTermination.promise; }
        return work(tx, publications);
      });
      const checkout = () => db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        await tx.execute(sql`set local deadlock_timeout = '10s'`);
        await tx.execute(sql`set local statement_timeout = '15s'`);
        await tx.select().from(issues).where(eq(issues.id, f.task.id)).for("update");
        taskLocked.release();
        await runCheckout.promise;
        return issueService(tx).checkout(f.task.id, f.workerId, ["in_progress"], null);
      });
      let termination: Promise<unknown> | undefined, competing: Promise<unknown> | undefined;
      const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), error => ({ error }));
      if (order === "task-first") {
        competing = settle(checkout()); await taskLocked.promise;
        termination = settle(lifecycleWithEffects(db, effects).terminateAgent(f.workerId)); await agentLocked.promise;
      } else {
        termination = settle(lifecycleWithEffects(db, effects).terminateAgent(f.workerId)); await agentLocked.promise;
        competing = settle(checkout()); await taskLocked.promise;
      }
      try {
        runCheckout.release();
        // Wait for the real checkout query to block on the already held agent.
        await vi.waitFor(async () => {
          const waiting = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock' and query like '%from "agents"%'`);
          expect(waiting.length).toBeGreaterThan(0);
        }, { timeout: 5_000, interval: 10 });
      } finally {
        runCheckout.release(); runTermination.release();
      }
      const results = await Promise.all([termination, competing]);
      expect(results, "both transactions must commit; 40P01 is not an acceptable API outcome").toEqual([
        { value: expect.anything() }, { value: expect.anything() },
      ]);
    }, 60_000);
  }

  it("retirement preserves a completed human wake receipt on an unfinished task", async () => {
    const f = await seed();
    const finishedAt = new Date("2026-11-01T12:00:00.000Z"), runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.workerId, status: "succeeded", finishedAt, contextSnapshot: { issueId: f.task.id } }).returning();
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.workerId, source: "on_demand", status: "completed", runId,
      requestedByActorType: "user", requestedByActorId: f.userId, payload: { issueId: f.task.id }, finishedAt }).returning();
    const response = await f.terminate("PATCH");
    expect(response.status, response.text).toBe(200);
    // Finish real lifecycle work too: a fix must not merely move the rewrite later.
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete", runPlugin: async () => "complete" });
    workers.push(worker);
    await worker.process(f.workerId);
    expect(await f.currentAgent()).toMatchObject({ lifecycleState: "terminated" });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id)))[0]).toEqual(receipt);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toEqual(run);
  }, 60_000);

  it("retirement retains holds and task ownership until durable Stop and cleanup completion", async () => {
    const f = await seed(), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.workerId, status: "running", startedAt: new Date() });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, f.task.id));
    await db.update(agents).set({ lifecycleHolds: ["budget"], pauseReason: "budget" }).where(eq(agents.id, f.workerId));
    let cleanupConfirmed = false;
    const worker = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [],
      runHost: async agent => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        if (agent.lifecycleState === "terminating") return run?.status === "cancelled" && run.finishedAt ? "complete" : "pending";
        return cleanupConfirmed ? "complete" : "pending";
      },
      runPlugin: async () => "complete",
    });
    workers.push(worker);
    const response = await f.terminate("PATCH");
    expect(response.status, response.text).toBe(200);
    await worker.process(f.workerId);
    expect(await f.currentAgent()).toMatchObject({ lifecycleState: "terminating", lifecycleHolds: ["budget"], pauseReason: "budget" });
    expect(await f.currentTask()).toMatchObject({ assigneeAgentId: f.workerId, checkoutRunId: runId, executionRunId: runId });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await createAgentLifecycle(db).retry(f.workerId);
    await worker.process(f.workerId);
    expect(await f.currentAgent()).toMatchObject({ lifecycleState: "cleaning_up", lifecycleHolds: ["budget"], pauseReason: "budget" });
    expect(await f.currentTask()).toMatchObject({ assigneeAgentId: f.workerId });
    cleanupConfirmed = true;
    await createAgentLifecycle(db).retry(f.workerId);
    await worker.process(f.workerId);
    expect(await f.currentAgent()).toMatchObject({ lifecycleState: "terminated", lifecycleHolds: [], pauseReason: null });
    expect(await f.currentTask()).toMatchObject({ assigneeAgentId: f.managerId, status: "todo", checkoutRunId: null, executionRunId: null });
    const managerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: managerRunId, companyId: f.companyId, agentId: f.managerId, status: "running" });
    await expect(issueService(db).checkout(f.task.id, f.managerId, ["todo"], managerRunId)).resolves.toMatchObject({ executionRunId: managerRunId });
  }, 60_000);

  it("durable termination completion retries the real checkout lock cycle and commits one transfer", async () => {
    const f = await seed();
    const owner = randomUUID();
    await db.update(agents).set({ status: "terminated", lifecycleState: "cleaning_up", lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: true, completedPluginIds: [], attempts: 1, leaseOwner: owner,
        leaseUntil: new Date(Date.now() + 120_000).toISOString() } }).where(eq(agents.id, f.workerId));
    const taskLocked = barrier(), agentLocked = barrier(), runCheckout = barrier(), runTermination = barrier();
    const effects = createAgentLifecycleEffects(), transaction = effects.transaction;
    let attempts = 0;
    effects.transaction = (database, companyId, work) => transaction(database, companyId, async (tx, publications) => {
      await tx.execute(sql`set local deadlock_timeout = '100ms'`);
      await tx.execute(sql`set local statement_timeout = '15s'`);
      await tx.select().from(agents).where(eq(agents.id, f.workerId)).for("update");
      if (++attempts === 1) { agentLocked.release(); await runTermination.promise; }
      return work(tx, publications);
    });
    const settle = (promise: Promise<unknown>) => promise.then(value => ({ value }), error => ({ error }));
    const checkout = settle(db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await tx.execute(sql`set local deadlock_timeout = '10s'`);
      await tx.execute(sql`set local statement_timeout = '15s'`);
      await tx.select().from(issues).where(eq(issues.id, f.task.id)).for("update");
      taskLocked.release(); await runCheckout.promise;
      await assertAgentInteraction(tx, { companyId: f.companyId, actorAgentId: f.managerId,
        targetAgentId: f.managerId, issueId: f.task.id, operation: "assign", lock: true });
      return true;
    }));
    await taskLocked.promise;
    const completion = settle(createLifecycleStore(db, effects).change(f.workerId, "complete", { version: (await f.currentAgent()).lifecycleVersion, owner }));
    await agentLocked.promise;
    try {
      runCheckout.release();
      await vi.waitFor(async () => {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and wait_event_type = 'Lock' and query like '%from "agents"%'`);
        expect(waiting.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 10 });
    } finally { runCheckout.release(); runTermination.release(); }
    expect(await completion).toMatchObject({ value: { lifecycleState: "terminated" } });
    expect(await checkout).toEqual({ value: true });
    expect(attempts).toBe(2);
    expect(await f.currentTask()).toMatchObject({ assigneeAgentId: f.managerId, status: "todo" });
    const moves = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.task.id), eq(activityLog.action, "issue.reassigned")));
    expect(moves).toHaveLength(1);
  }, 60_000);

  it("a rolled-back lifecycle transaction rechecks authorization before retrying PATCH", async () => {
    const f = await seed();
    let transactions = 0, authorizations = 0;
    const wrappedDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return ((work, options) => target.transaction(async tx => {
        const value = await work(tx);
        if (++transactions === 1) throw Object.assign(new Error("forced transaction rollback"), { code: "40P01" });
        return value;
      }, options)) as Db["transaction"];
      return Reflect.get(target, key, receiver);
    } });
    const before = await f.currentAgent();
    const lifecycle = createAgentLifecycle(wrappedDb, {}, async tx => {
      if ((tx as unknown as { nestedIndex: number }).nestedIndex > 0) return;
      if (++authorizations > 1) throw new Error("scope revoked before retry");
    });
    await expect(lifecycle.updateAndTransition(f.workerId, "terminate", { title: "Must roll back" })).rejects.toThrow("scope revoked before retry");
    expect(authorizations).toBe(2);
    expect(transactions).toBe(1);
    expect(await f.currentAgent()).toEqual(before);
    expect(await f.currentTask()).toMatchObject({ assigneeAgentId: f.workerId });
  }, 60_000);

  it("ordinary assignment preserves all finished human receipts while cancelling pending direction", async () => {
    const f = await seed(), finishedAt = new Date("2026-11-01T12:00:00.000Z"), runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.workerId, status: "succeeded", finishedAt });
    const finished = await db.insert(agentWakeupRequests).values(
      ["completed", "failed", "cancelled", "skipped", "timed_out", "coalesced"].map(status => ({
        companyId: f.companyId, agentId: f.workerId, source: "on_demand", status, runId, finishedAt,
        requestedByActorType: "user", requestedByActorId: f.userId, payload: { issueId: f.task.id },
      })),
    ).returning();
    const pending = await db.insert(agentWakeupRequests).values(
      ["queued", "claimed", "deferred_issue_execution"].map(status => ({
        companyId: f.companyId, agentId: f.workerId, source: "on_demand", status,
        requestedByActorType: "user", requestedByActorId: f.userId, payload: { issueId: f.task.id },
      })),
    ).returning();
    await issueService(db).update(f.task.id, { assigneeAgentId: f.managerId, assigneeUserId: null });
    for (const receipt of finished) {
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0]).toEqual(receipt);
    }
    for (const receipt of pending) {
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id)))[0]).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
    }
  }, 60_000);
});
