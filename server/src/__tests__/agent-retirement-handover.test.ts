import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentApiKeys, approvals, authUsers, budgetIncidents, budgetPolicies, companies,
  companyMemberships, createDb, heartbeatRuns, issues, principalPermissionGrants, routineRuns, routineTriggers, routines as routinesTable,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { configureAgentLifecycle, createAgentLifecycle, createAgentLifecycleEffects } from "../services/agent-lifecycle.js";
import { createLifecycleStore } from "../modules/agent-lifecycle/adapters/postgres.js";
import { issueService } from "../services/issues.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { routineService } from "../services/routines.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// #20389 B6, the Paperclip way (RFL FINAL for S2/S3 + CTL6-RF2-0505 W1-W7 + CTL6-RF2-0510).
// The terminal step writes the terminated state, ONE durable hand-over marker and the
// agent.terminated audit row in one transaction. A per-item recovery worker re-homes each open
// task and each live report in its own transaction. Real PostgreSQL, real HTTP routes, real
// authorization, real lifecycle store/worker and the real checkout. Only external Stop delivery
// is replaceable, and failures are forced by database triggers, never by changing the code under test.
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

// The recovery worker is new in this change: load it per test, so every other RED fails on its own assertion.
const handoverModule = () => import("../services/agent-handover.js");

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
type Settled = { value?: any; error?: any };
const settle = (promise: Promise<unknown>): Promise<Settled> => promise.then(value => ({ value }), error => ({ error }));
function sqlStates(error: unknown): string[] {
  const codes: string[] = [];
  for (let cause = error as any, depth = 0; cause && typeof cause === "object" && depth < 6; cause = cause.cause, depth++) {
    if (typeof cause.code === "string") codes.push(cause.code);
  }
  return codes;
}
const OPEN = ["backlog", "todo", "in_progress", "in_review", "blocked"];

describe("#20389 B6 retire the Paperclip way: marker + per-item recovery worker", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "retirement-handover-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("retirement-handover-");
    db = createDb(database.connectionString);
    // One forced-failure switch for the whole file: a row here makes the matching write raise in PostgreSQL.
    await db.execute(sql`create table b6_forced_failures (kind text not null, id text not null)`);
    await db.execute(sql`create function b6_fail_activity() returns trigger language plpgsql as $$ begin
      if exists (select 1 from b6_forced_failures where kind = new.action and id = new.entity_id)
      then raise exception 'forced % failure for %', new.action, new.entity_id; end if; return new; end $$`);
    await db.execute(sql`create trigger b6_fail_activity before insert on activity_log for each row execute function b6_fail_activity()`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    stopBoundary.deliver = undefined;
    for (const worker of workers) await worker.stop();
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  /** root <- lead (holds the agent key) <- worker (retires) <- reports. Ids ascend in that order. */
  async function seed(options: { reports?: number } = {}) {
    for (const worker of workers.splice(0)) await worker.stop();
    stopBoundary.deliver = undefined;
    await db.execute(sql`delete from b6_forced_failures`);
    const companyId = randomUUID(), userId = randomUUID();
    const [rootId, leadId, workerId, ...reportIds] = Array.from({ length: 3 + (options.reports ?? 0) }, () => randomUUID()).sort() as [string, string, string, ...string[]];
    await db.insert(companies).values({ id: companyId, name: "Retire the Paperclip way", issuePrefix: `H${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const agent = (id: string, name: string, reportsTo: string | null) => ({ id, companyId, name, reportsTo, adapterType: "process",
      status: "idle", lifecycleState: "ready" as const, runtimeConfig: { heartbeat: { enabled: false } } });
    await db.insert(agents).values(agent(rootId, "Root", null));
    await db.insert(agents).values(agent(leadId, "Lead", rootId));
    await db.insert(agents).values(agent(workerId, "Worker", leadId));
    for (const [index, id] of reportIds.entries()) await db.insert(agents).values(agent(id, `Report ${index + 1}`, workerId));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...[rootId, leadId, workerId, ...reportIds].map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "agent", principalId: leadId, permissionKey: "agents:configure", scope: { subtreeRootAgentId: leadId } },
      ...(["agents:configure", "agents:read", "agents:create"] as const).map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
    ]);
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: leadId, name: "Lead", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express();
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentRoutes(db));
    api.use(errorHandler);
    const board = express();
    board.use(express.json());
    board.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false }; next(); });
    board.use("/api", agentRoutes(db));
    board.use(errorHandler);
    const worker = configureAgentLifecycle(db, { requiredPluginIds: async () => [], runHost: async () => "complete" as const, runPlugin: async () => "complete" as const });
    workers.push(worker);
    const terminate = (via: "POST" | "PATCH", id = workerId, app = api) => {
      const call = via === "POST" ? request(app).post(`/api/agents/${id}/terminate`) : request(app).patch(`/api/agents/${id}`);
      return (app === api ? call.set("Authorization", `Bearer ${token}`) : call).send(via === "POST" ? {} : { status: "terminated" });
    };
    /** Request through the real route, then let the real lifecycle worker prove Stop and cleanup. */
    const retire = async (via: "POST" | "PATCH" = "POST", id = workerId, app = api) => {
      const response = await terminate(via, id, app);
      expect(response.status, response.text).toBe(200);
      await worker.process(id);
      expect(await current(id)).toMatchObject({ status: "terminated", lifecycleState: "terminated" });
      return response;
    };
    const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
    const roster = () => db.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(agents.id);
    const activity = (action?: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId),
      action ? eq(activityLog.action, action) : undefined)).orderBy(activityLog.createdAt, activityLog.id);
    const authority = async () => ({
      grants: await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId)).orderBy(principalPermissionGrants.id),
      memberships: await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, companyId)).orderBy(companyMemberships.id),
    });
    const task = (title: string, status: string, assigneeAgentId = workerId) =>
      issueService(db).create(companyId, { title, status, assigneeAgentId });
    const currentTask = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;
    const events: { action: unknown; entityId: unknown }[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, event => {
      if (event.type === "activity.logged") events.push({ action: event.payload.action, entityId: event.payload.entityId });
    });
    const handover = async (options?: { now?: () => Date; repairUnmarked?: boolean }) =>
      (await handoverModule()).agentHandoverService(db, options);
    return { companyId, userId, rootId, leadId, workerId, reportIds, api, board, worker, terminate, retire, current, roster,
      activity, authority, task, currentTask, events, unsubscribe, handover, token };
  }

  // A row-lock waiter holds (or waits for) the tuple lock on that table; long query texts are truncated.
  const lockWaits = async (table: string) => (await db.execute(sql`select a.pid, a.query from pg_stat_activity a
    where a.datname = current_database() and a.wait_event_type = 'Lock' and (a.query like ${`%from "${table}"%`}
      or exists (select 1 from pg_locks l where l.pid = a.pid and l.locktype = 'tuple' and l.relation = ${table}::regclass))`)) as unknown as { pid: number; query: string }[];
  const messages = (error: unknown) => {
    const all: string[] = [];
    for (let cause = error as any, depth = 0; cause && typeof cause === "object" && depth < 6; cause = cause.cause, depth++) all.push(String(cause.message));
    return all.join(" <- ");
  };
  async function until(check: () => Promise<boolean>, settled?: Promise<unknown>) {
    let stopped = false;
    void settled?.then(() => { stopped = true; });
    for (const deadline = Date.now() + 10_000; !stopped && Date.now() < deadline;) {
      if (await check()) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }
  const deadlocks = async () => Number(((await db.execute(sql`select deadlocks from pg_stat_database
    where datname = current_database()`)) as unknown as { deadlocks: string }[])[0]!.deadlocks);
  /** Production effects; the wrapper only counts transaction attempts. It takes no lock. */
  function countedEffects() {
    const effects = createAgentLifecycleEffects(), transaction = effects.transaction;
    const counter = { attempts: 0 };
    effects.transaction = (database, companyId, work) => transaction(database, companyId, (tx, publications) => {
      counter.attempts++;
      return work(tx, publications);
    });
    return { effects, counter };
  }
  const duplicates = (rows: { action: string; entityId: string }[]) => {
    const seen = new Map<string, number>();
    for (const row of rows) seen.set(`${row.action} ${row.entityId}`, (seen.get(`${row.action} ${row.entityId}`) ?? 0) + 1);
    return [...seen].filter(([, count]) => count > 1);
  };
  const marker = (agent: { lifecycleOperation: unknown }) => (agent.lifecycleOperation as { handover?: any } | null)?.handover;
  /** The saved state the lifecycle worker reaches once Stop and plugin cleanup are proven. */
  async function cleaningUp(agentId: string) {
    const owner = randomUUID();
    const [row] = await db.update(agents).set({ status: "terminated", lifecycleState: "cleaning_up", lifecycleRequiredPluginIds: [],
      lifecycleOperation: { id: randomUUID(), hostComplete: true, completedPluginIds: [], attempts: 1, leaseOwner: owner,
        leaseUntil: new Date(Date.now() + 120_000).toISOString() } }).where(eq(agents.id, agentId)).returning();
    return { owner, version: row!.lifecycleVersion };
  }
  /** Every agent still reaches a root with no repeated manager. */
  function assertNoCycle(rows: { id: string; reportsTo: string | null }[]) {
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const start of rows) {
      const seen = new Set<string>();
      for (let at: string | null = start.id; at; at = byId.get(at)?.reportsTo ?? null) {
        expect(seen.has(at), `cycle through ${at}`).toBe(false);
        seen.add(at);
      }
    }
  }

  // ---- Condition 1: refusals at REQUEST time, before any mutation -----------------------------
  for (const via of ["POST", "PATCH"] as const) {
    it(`refusal ${via}: a root agent with live reports gets 409 agent_has_live_reports naming them; nothing changes`, async () => {
      const f = await seed();
      const before = await f.roster(), activity = await f.activity();
      const response = await f.terminate(via, f.rootId, f.board);
      expect(response.status, response.text).toBe(409);
      expect(response.text).toContain("agent_has_live_reports");
      expect(response.text).toContain(f.leadId);
      expect(await f.roster()).toEqual(before);
      expect(await f.activity()).toEqual(activity);
      f.unsubscribe();
    }, 60_000);

    it(`refusal ${via}: an actor without authority over the reports gets 409; the ACTIVE agent is byte-identical`, async () => {
      const f = await seed({ reports: 2 });
      // The lead may configure (and so retire) the worker, but not the worker's reports.
      await db.update(principalPermissionGrants).set({ scope: { agentIds: [f.workerId] } })
        .where(and(eq(principalPermissionGrants.principalId, f.leadId), eq(principalPermissionGrants.permissionKey, "agents:configure")));
      const before = await f.roster(), activity = await f.activity(), authority = await f.authority();
      const response = await f.terminate(via);
      expect(response.status, response.text).toBe(409);
      expect(response.text).toContain("agent_has_live_reports");
      for (const id of f.reportIds) expect(response.text).toContain(id);
      expect(await f.roster()).toEqual(before);
      expect(await f.activity()).toEqual(activity);
      expect(await f.authority()).toEqual(authority);
      f.unsubscribe();
    }, 60_000);
  }

  // ---- W1 + condition 2: the marker, written with the terminal state, visible, then cleared ----
  for (const via of ["POST", "PATCH"] as const) {
    it(`W1/W6 ${via}: terminal step writes terminated + marker + one agent.terminated; worker re-homes to the MANAGER and clears it`, async () => {
      const f = await seed({ reports: 1 });
      await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["budget"], pauseReason: "budget" })
        .where(eq(agents.id, f.workerId));
      const blocked = await f.task("Blocked task", "blocked");
      const active = await f.task("Active task", "in_progress");
      const done = await f.task("Done task", "done");
      const authority = await f.authority();
      const response = await f.terminate(via);
      expect(response.status, response.text).toBe(200);
      // Requested, not complete: nothing terminal is recorded yet and nothing moves before Stop is proven.
      expect(marker(await f.current(f.workerId))).toBeUndefined();
      expect(await f.activity("agent.terminated")).toEqual([]);
      await f.worker.process(f.workerId);
      const retired = await f.current(f.workerId);
      // 'Holds cleared' is DROPPED: upstream freezes holds on a terminated row (AGENT-LIFECYCLE.md:84-86).
      expect(retired).toMatchObject({ status: "terminated", lifecycleState: "terminated", lifecycleHolds: ["budget"] });
      expect(marker(retired)).toMatchObject({ code: "agent_handover_pending" });
      // FABLE-P2: PATCH writes the same terminal audit row as POST, naming the caller that asked.
      expect(await f.activity("agent.terminated")).toEqual([expect.objectContaining({ entityType: "agent", entityId: f.workerId,
        actorType: "agent", actorId: f.leadId, agentId: f.leadId })]);
      // The pending code is VISIBLE on the agent read, and the work has not moved inside the lifecycle transaction.
      const visible = await request(f.board).get(`/api/agents/${f.workerId}`);
      expect(visible.status, visible.text).toBe(200);
      expect(visible.body.handover).toMatchObject({ code: "agent_handover_pending" });
      expect(await f.currentTask(blocked.id)).toMatchObject({ assigneeAgentId: f.workerId });
      expect(await f.current(f.reportIds[0]!)).toMatchObject({ reportsTo: f.workerId });

      await (await f.handover()).processAgent(f.workerId);
      expect(await f.currentTask(blocked.id)).toMatchObject({ assigneeAgentId: f.leadId, status: "blocked" });
      expect(await f.currentTask(active.id)).toMatchObject({ assigneeAgentId: f.leadId, status: "todo", checkoutRunId: null, executionRunId: null });
      expect(await f.currentTask(done.id)).toMatchObject({ assigneeAgentId: f.workerId, status: "done" });
      const report = await f.current(f.reportIds[0]!);
      expect(report.reportsTo).toBe(f.leadId);
      for (const id of [blocked.id, active.id]) {
        expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "issue.reassigned"))))
          .toEqual([expect.objectContaining({ actorType: "system", details: expect.objectContaining({ reason: "agent_terminated",
            previousAssigneeAgentId: f.workerId, assigneeAgentId: f.leadId }) })]);
      }
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, report.id), eq(activityLog.action, "agent.reports_to_changed"))))
        .toEqual([expect.objectContaining({ details: expect.objectContaining({ retiredAgentId: f.workerId,
          previousManagerAgentId: f.workerId, managerAgentId: f.leadId }) })]);
      // The new manager is told once, listing who arrived.
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.leadId), eq(activityLog.action, "agent.reports_received"))))
        .toEqual([expect.objectContaining({ details: expect.objectContaining({ retiredAgentId: f.workerId, reportAgentIds: [report.id] }) })]);
      // Only reportsTo changed: no grant or membership copied or widened.
      expect(await f.authority()).toEqual(authority);
      const cleared = await f.current(f.workerId);
      expect(marker(cleared)).toBeUndefined();
      expect((await request(f.board).get(`/api/agents/${f.workerId}`)).body.handover).toBeUndefined();
      assertNoCycle(await f.roster());
      await vi.waitFor(() => expect(f.events.filter(event => event.action === "agent.terminated")).toHaveLength(1));
      expect(duplicates(await f.activity())).toEqual([]);
      f.unsubscribe();
    }, 60_000);
  }

  // Replacement for agent-lifecycle-subtree-scope.test.ts "#20389 gate row: retire via POST|PATCH" (holds-cleared and the
  // in-transaction return are superseded by the ruling): every other assertion of that test, with the recovery worker.
  for (const via of ["POST", "PATCH"] as const) {
    it(`gate row replacement ${via}: retire returns open tasks to the lead through the worker, never another subtree; holds stay frozen`, async () => {
      const f = await seed();
      const otherId = randomUUID();
      await db.insert(agents).values({ id: otherId, companyId: f.companyId, name: "Unrelated", reportsTo: f.rootId, adapterType: "process",
        status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { enabled: false } } });
      await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["budget"], pauseReason: "budget" })
        .where(eq(agents.id, f.workerId));
      const blocked = await f.task("Unfinished worker task", "blocked");
      const done = await f.task("Completed worker task", "done");
      const active = await f.task("Active worker task", "in_progress");
      const other = await f.task("Other subtree task", "blocked", otherId);
      const otherBefore = await f.currentTask(other.id);
      const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: f.workerId,
        windowKind: "calendar_month_utc", amount: 100 }).returning();
      const company = (await db.select().from(companies).where(eq(companies.id, f.companyId)))[0];
      const unrelated = await f.current(otherId);
      const denied = await f.terminate("POST", otherId);
      expect(denied.status, denied.text).toBe(403);
      expect(await f.current(otherId)).toEqual(unrelated);
      await f.retire(via);
      await (await f.handover()).processAgent(f.workerId);
      expect(await f.current(f.workerId)).toMatchObject({ status: "terminated", lifecycleState: "terminated", lifecycleHolds: ["budget"], pauseReason: "budget" });
      expect(await f.currentTask(blocked.id)).toMatchObject({ assigneeAgentId: f.leadId, status: "blocked" });
      expect(await f.currentTask(active.id)).toMatchObject({ assigneeAgentId: f.leadId, status: "todo", executionRunId: null, checkoutRunId: null });
      expect(await f.currentTask(done.id)).toMatchObject({ assigneeAgentId: f.workerId, status: "done" });
      expect(await f.currentTask(other.id)).toEqual(otherBefore);
      expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id)))[0]).toEqual(policy);
      expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]).toEqual(company);
      expect(await f.current(otherId)).toEqual(unrelated);
      const repeated = await f.terminate("POST");
      expect(repeated.status, repeated.text).toBe(200);
      await f.worker.process(f.workerId);
      await (await f.handover()).processAgent(f.workerId);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, blocked.id), eq(activityLog.action, "issue.reassigned")))).toHaveLength(1);
      expect(await f.activity("agent.terminated")).toHaveLength(1);
      f.unsubscribe();
    }, 60_000);
  }

  it("W1: a failure in the terminal step commits neither terminated nor the marker nor the audit row; the worker's next attempt completes once", async () => {
    const f = await seed();
    const { owner, version } = await cleaningUp(f.workerId);
    await db.execute(sql`insert into b6_forced_failures values ('agent.terminated', ${f.workerId})`);
    const { effects, counter } = countedEffects();
    const failed = await settle(createLifecycleStore(db, effects).change(f.workerId, "complete", { version, owner }));
    expect(messages(failed.error)).toContain("forced agent.terminated failure");
    // No internal retry: one attempt, and the pre-completion state is exactly kept.
    expect(counter.attempts).toBe(1);
    const after = await f.current(f.workerId);
    expect(after).toMatchObject({ status: "terminated", lifecycleState: "cleaning_up", lifecycleVersion: version });
    expect(marker(after)).toBeUndefined();
    expect(await f.activity("agent.terminated")).toEqual([]);
    expect(f.events).toEqual([]);
    await db.execute(sql`delete from b6_forced_failures`);
    const completed = await createLifecycleStore(db, effects).change(f.workerId, "complete", { version, owner });
    expect(completed).toMatchObject({ lifecycleState: "terminated" });
    expect(marker(completed!)).toMatchObject({ code: "agent_handover_pending" });
    expect(await f.activity("agent.terminated")).toHaveLength(1);
    await vi.waitFor(() => expect(f.events.filter(event => event.action === "agent.terminated")).toHaveLength(1));
    f.unsubscribe();
  }, 60_000);

  // ---- F4 replacements (supersede by REPLACEMENT): one failed transaction publishes nothing; an explicit retry rechecks authority
  it("F4 replacement: a rolled-back lifecycle transaction publishes nothing; a separate explicit retry rechecks authority and publishes committed effects once", async () => {
    const f = await seed();
    let transactions = 0, authorizations = 0, allow = true;
    let rootTransaction: unknown;
    const wrappedDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return ((work, options) => target.transaction(async tx => {
        rootTransaction = tx;
        const value = await work(tx);
        if (++transactions === 1) throw Object.assign(new Error("forced transaction rollback"), { code: "40P01" });
        return value;
      }, options)) as Db["transaction"];
      return Reflect.get(target, key, receiver);
    } });
    const before = await f.current(f.workerId), activity = await f.activity();
    // Count the request's own (root) authorization; the nested store savepoint re-runs the same check.
    const lifecycle = createAgentLifecycle(wrappedDb, {}, async tx => {
      if (tx !== rootTransaction) return;
      authorizations++;
      if (!allow) throw new Error("scope revoked before the explicit retry");
    });
    const first = await settle(lifecycle.updateAndTransition(f.workerId, "terminate", { title: "Must roll back" }));
    expect(sqlStates(first.error)).toContain("40P01");
    // No internal retry: one transaction, one authorization, nothing written or published.
    expect({ transactions, authorizations }).toEqual({ transactions: 1, authorizations: 1 });
    expect(await f.current(f.workerId)).toEqual(before);
    expect(await f.activity()).toEqual(activity);
    allow = false;
    await expect(lifecycle.updateAndTransition(f.workerId, "terminate", { title: "Denied" })).rejects.toThrow("scope revoked before the explicit retry");
    expect(authorizations).toBe(2);
    expect(await f.current(f.workerId)).toEqual(before);
    allow = true;
    const committed = await lifecycle.updateAndTransition(f.workerId, "terminate", { title: "Committed once" });
    expect(committed).toMatchObject({ status: "terminated", title: "Committed once" });
    expect(authorizations).toBe(3);
    await f.worker.process(f.workerId);
    expect(await f.activity("agent.terminated")).toHaveLength(1);
    await vi.waitFor(() => expect(f.events.filter(event => event.action === "agent.terminated")).toHaveLength(1));
    expect(duplicates(await f.activity())).toEqual([]);
    f.unsubscribe();
  }, 60_000);

  // ---- Condition 4 / W3: no lock inversion; PRODUCTION terminal step vs PRODUCTION checkout (replaces :281) ----
  it("race A (replaces :281): checkout holds the task first; the PRODUCTION terminal step commits in ONE attempt, no 40P01; the worker then returns the task once", async () => {
    const f = await seed();
    const task = await f.task("Unfinished task", "in_progress");
    const { owner, version } = await cleaningUp(f.workerId);
    const leadRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: leadRunId, companyId: f.companyId, agentId: f.leadId, status: "running", contextSnapshot: { issueId: task.id } });
    const deadlocksBefore = await deadlocks();
    const held = barrier(), release = barrier();
    // Park the checkout after its task lock: it locks the lead's row before the worker's (id order).
    const blocker = db.transaction(async tx => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.leadId)).for("update");
      held.release(); await release.promise;
    });
    await held.promise;
    const { effects, counter } = countedEffects();
    let checkout: Promise<Settled> | undefined, completion: Promise<Settled> | undefined;
    try {
      checkout = settle(issueService(db).checkout(task.id, f.leadId, ["todo", "in_progress"], leadRunId));
      expect(await until(async () => (await lockWaits("agents")).length > 0, checkout), "the checkout holds the task and waits for an agent row").toBe(true);
      completion = settle(createLifecycleStore(db, effects).change(f.workerId, "complete", { version, owner }));
      // The terminal step touches no task row, so it commits while the checkout is still parked.
      await Promise.race([completion, new Promise(resolve => setTimeout(resolve, 10_000))]);
    } finally { release.release(); await blocker; }
    const [completed, checkedOut] = await Promise.all([completion!, checkout!]);
    expect({ attempts: counter.attempts, error: completed.error?.message, sqlStates: sqlStates(completed.error) })
      .toEqual({ attempts: 1, error: undefined, sqlStates: [] });
    expect(completed.value).toMatchObject({ lifecycleState: "terminated" });
    expect(sqlStates(checkedOut.error)).not.toContain("40P01");
    if (checkedOut.error) expect(checkedOut.error).toMatchObject({ status: 409 });
    await (await f.handover()).processAgent(f.workerId);
    expect(await deadlocks()).toBe(deadlocksBefore);
    // The old two-attempt end state, without holds-cleared (dropped): terminated, task returned to the manager, once.
    expect(await f.current(f.workerId)).toMatchObject({ status: "terminated", lifecycleState: "terminated" });
    expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.leadId });
    expect(await f.activity("agent.terminated")).toHaveLength(1);
    expect(duplicates(await f.activity())).toEqual([]);
    f.unsubscribe();
  }, 60_000);

  it("race B (replaces :281): the PRODUCTION terminal step holds the agent first; the checkout waits; both commit in ONE attempt, no 40P01", async () => {
    const f = await seed();
    const task = await f.task("Unfinished task", "in_progress");
    const { owner, version } = await cleaningUp(f.workerId);
    const leadRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: leadRunId, companyId: f.companyId, agentId: f.leadId, status: "running", contextSnapshot: { issueId: task.id } });
    const deadlocksBefore = await deadlocks();
    const held = barrier(), release = barrier();
    // Park the completion on the retiring agent's own row.
    const blocker = db.transaction(async tx => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.workerId)).for("update");
      held.release(); await release.promise;
    });
    await held.promise;
    const { effects, counter } = countedEffects();
    let checkout: Promise<Settled> | undefined, completion: Promise<Settled> | undefined;
    try {
      completion = settle(createLifecycleStore(db, effects).change(f.workerId, "complete", { version, owner }));
      expect(await until(async () => (await lockWaits("agents")).length > 0, completion), "the completion waits for the retiring agent's row").toBe(true);
      checkout = settle(issueService(db).checkout(task.id, f.leadId, ["todo", "in_progress"], leadRunId));
      await until(async () => (await lockWaits("agents")).length >= 2, Promise.race([completion, checkout]));
    } finally { release.release(); await blocker; }
    const [completed, checkedOut] = await Promise.all([completion!, checkout!]);
    expect({ attempts: counter.attempts, error: completed.error?.message, sqlStates: sqlStates(completed.error) })
      .toEqual({ attempts: 1, error: undefined, sqlStates: [] });
    expect(completed.value).toMatchObject({ lifecycleState: "terminated" });
    expect(sqlStates(checkedOut.error)).not.toContain("40P01");
    if (checkedOut.error) expect(checkedOut.error).toMatchObject({ status: 409 });
    await (await f.handover()).processAgent(f.workerId);
    expect(await deadlocks()).toBe(deadlocksBefore);
    expect(await f.current(f.workerId)).toMatchObject({ status: "terminated", lifecycleState: "terminated" });
    expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.leadId });
    expect(await f.activity("agent.terminated")).toHaveLength(1);
    expect(duplicates(await f.activity())).toEqual([]);
    f.unsubscribe();
  }, 60_000);

  // ---- W3: the recovery worker's item vs PRODUCTION checkout, both schedules, one attempt each ----
  it("W3 schedule A: checkout holds the task; the worker's item waits on the task (checkout's order), re-reads, and does not move it twice", async () => {
    const f = await seed();
    const task = await f.task("Unfinished task", "todo");
    await f.retire();
    // The lead takes the task through the ordinary route first: assignment, then checkout.
    const deadlocksBefore = await deadlocks();
    // The contender run first: its foreign key takes a key-share lock on the lead's row.
    const leadRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: leadRunId, companyId: f.companyId, agentId: f.leadId, status: "running", contextSnapshot: { issueId: task.id } });
    const held = barrier(), release = barrier();
    const blocker = db.transaction(async tx => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.leadId)).for("update");
      held.release(); await release.promise;
    });
    await held.promise;
    let checkout: Promise<Settled> | undefined, item: Promise<Settled> | undefined;
    try {
      checkout = settle(issueService(db).checkout(task.id, f.leadId, ["todo", "in_progress"], leadRunId));
      expect(await until(async () => (await lockWaits("agents")).length > 0, checkout)).toBe(true);
      item = settle((await f.handover()).processAgent(f.workerId));
      expect(await until(async () => (await lockWaits("issues")).length > 0, item), "the worker's item waits on the task row first").toBe(true);
    } finally { release.release(); await blocker; }
    const [checkedOut, processed] = await Promise.all([checkout!, item!]);
    expect(processed.error?.message).toBeUndefined();
    expect(sqlStates(checkedOut.error)).not.toContain("40P01");
    if (checkedOut.error) expect(checkedOut.error).toMatchObject({ status: 409 });
    expect(await deadlocks()).toBe(deadlocksBefore);
    // Whatever won, the task has ONE new owner, moved at most once by the worker.
    expect((await f.currentTask(task.id)).assigneeAgentId).toBe(f.leadId);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.reassigned")))).toHaveLength(1);
    expect(duplicates(await f.activity())).toEqual([]);
    f.unsubscribe();
  }, 60_000);

  it("W3 schedule B: the worker's item holds the task first; the checkout waits and then checks out the re-homed task; one attempt each", async () => {
    const f = await seed();
    const task = await f.task("Unfinished task", "todo");
    await f.retire();
    const deadlocksBefore = await deadlocks();
    const held = barrier(), release = barrier();
    // Park the item after its task lock: it then needs the manager's row.
    const leadRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: leadRunId, companyId: f.companyId, agentId: f.leadId, status: "running", contextSnapshot: { issueId: task.id } });
    const blocker = db.transaction(async tx => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, f.leadId)).for("update");
      held.release(); await release.promise;
    });
    await held.promise;
    let checkout: Promise<Settled> | undefined, item: Promise<Settled> | undefined;
    try {
      item = settle((await f.handover()).processAgent(f.workerId));
      expect(await until(async () => (await lockWaits("agents")).length > 0, item), "the item holds the task and waits for an agent row").toBe(true);
      checkout = settle(issueService(db).checkout(task.id, f.leadId, ["todo", "in_progress"], leadRunId));
      expect(await until(async () => (await lockWaits("issues")).length > 0, checkout), "the checkout waits on the task row").toBe(true);
    } finally { release.release(); await blocker; }
    const [processed, checkedOut] = await Promise.all([item!, checkout!]);
    expect(processed.error?.message).toBeUndefined();
    expect(checkedOut.error?.message).toBeUndefined();
    expect(checkedOut.value).toMatchObject({ assigneeAgentId: f.leadId, status: "in_progress", executionRunId: leadRunId });
    expect(await deadlocks()).toBe(deadlocksBefore);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.reassigned")))).toHaveLength(1);
    expect(duplicates(await f.activity())).toEqual([]);
    f.unsubscribe();
  }, 60_000);

  // ---- W5 / condition 3: killed mid-batch, then re-run: exactly one reassignment + one activity row per item ----
  it("W5: a worker killed mid-batch and re-run moves each task and report exactly once, with one audit row and one publication each", async () => {
    const f = await seed({ reports: 2 });
    const tasks = [await f.task("T1", "todo"), await f.task("T2", "todo"), await f.task("T3", "blocked")]
      .sort((a, b) => a.id.localeCompare(b.id));
    await f.retire();
    const held = barrier(), release = barrier();
    // Hold the second task so the first pass is mid-batch when its connection is killed.
    const blocker = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, tasks[1]!.id)).for("update");
      held.release(); await release.promise;
    });
    await held.promise;
    const service = await f.handover({ now: () => new Date() });
    const firstPass = settle(service.processAgent(f.workerId));
    try {
      expect(await until(async () => (await lockWaits("issues")).length > 0, firstPass)).toBe(true);
      expect(await f.currentTask(tasks[0]!.id)).toMatchObject({ assigneeAgentId: f.leadId });
      for (const waiting of await lockWaits("issues")) await db.execute(sql`select pg_terminate_backend(${waiting.pid})`);
    } finally { release.release(); await blocker; }
    await firstPass;
    expect(marker(await f.current(f.workerId))).toMatchObject({ code: "agent_handover_pending" });
    // Re-run (after any backoff) until done, then once more: nothing changes the second time.
    const later = await f.handover({ now: () => new Date(Date.now() + 24 * 3600_000) });
    await later.processAgent(f.workerId);
    const settledActivity = await f.activity();
    await later.processAgent(f.workerId);
    expect(await f.activity()).toEqual(settledActivity);
    for (const task of tasks) {
      expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.leadId });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.reassigned")))).toHaveLength(1);
    }
    for (const id of f.reportIds) {
      expect(await f.current(id)).toMatchObject({ reportsTo: f.leadId });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "agent.reports_to_changed")))).toHaveLength(1);
    }
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.leadId), eq(activityLog.action, "agent.reports_received")))).toHaveLength(1);
    expect(marker(await f.current(f.workerId))).toBeUndefined();
    await vi.waitFor(() => {
      for (const task of tasks) expect(f.events.filter(event => event.action === "issue.reassigned" && event.entityId === task.id)).toHaveLength(1);
    });
    expect(duplicates(await f.activity())).toEqual([]);
    f.unsubscribe();
  }, 60_000);

  // ---- W4: per-item target re-check; walk up to the nearest ACTIVE manager; none -> stays put, never null, never a cycle
  it("W4: the manager is already retired: items walk up to the nearest ACTIVE manager", async () => {
    const f = await seed({ reports: 1 });
    const task = await f.task("Unfinished", "todo");
    await f.retire();
    // Then the lead is retired too (its only report, the worker, is no longer live).
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, f.leadId));
    await (await f.handover()).processAgent(f.workerId);
    expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.rootId });
    expect(await f.current(f.reportIds[0]!)).toMatchObject({ reportsTo: f.rootId });
    expect(marker(await f.current(f.workerId))).toBeUndefined();
    assertNoCycle(await f.roster());
    f.unsubscribe();
  }, 60_000);

  it("W4: the target is re-checked PER ITEM: a manager retired between items sends the rest further up", async () => {
    const f = await seed({ reports: 1 });
    const tasks = [await f.task("T1", "todo"), await f.task("T2", "todo")].sort((a, b) => a.id.localeCompare(b.id));
    await f.retire();
    // When the first task lands on the lead, the lead is retired in that same committed item.
    await db.execute(sql.raw(`create or replace function b6_retire_lead() returns trigger language plpgsql as $$ begin
      if new.action = 'issue.reassigned' and new.entity_id = '${tasks[0]!.id}' then
        update agents set status = 'terminated', lifecycle_state = 'terminated' where id = '${f.leadId}'; end if; return new; end $$`));
    await db.execute(sql`create trigger b6_retire_lead after insert on activity_log for each row execute function b6_retire_lead()`);
    try {
      await (await f.handover()).processAgent(f.workerId);
    } finally { await db.execute(sql`drop trigger b6_retire_lead on activity_log`); }
    expect(await f.currentTask(tasks[0]!.id)).toMatchObject({ assigneeAgentId: f.leadId });
    expect(await f.currentTask(tasks[1]!.id)).toMatchObject({ assigneeAgentId: f.rootId });
    expect(await f.current(f.reportIds[0]!)).toMatchObject({ reportsTo: f.rootId });
    assertNoCycle(await f.roster());
    f.unsubscribe();
  }, 60_000);

  it("W4: no ACTIVE manager anywhere: items stay put under the named pending code, never null", async () => {
    const f = await seed({ reports: 1 });
    const task = await f.task("Unfinished", "todo");
    await f.retire();
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(inArray(agents.id, [f.leadId, f.rootId]));
    await (await f.handover()).processAgent(f.workerId);
    expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.workerId });
    expect(await f.current(f.reportIds[0]!)).toMatchObject({ reportsTo: f.workerId });
    const pending = marker(await f.current(f.workerId));
    expect(pending).toMatchObject({ code: "agent_handover_pending", blocked: expect.arrayContaining([
      expect.objectContaining({ kind: "task", id: task.id, reason: "no_active_manager" }),
      expect.objectContaining({ kind: "report", id: f.reportIds[0], reason: "no_active_manager" }),
    ]) });
    expect(await f.activity("issue.reassigned")).toEqual([]);
    f.unsubscribe();
  }, 60_000);

  it("W4: never a cycle: a report that is an ancestor of the target stays put under the pending code", async () => {
    const f = await seed({ reports: 1 });
    await f.retire();
    // A pre-existing loop through the report: the lead reports to the worker's report.
    await db.update(agents).set({ reportsTo: f.reportIds[0]! }).where(eq(agents.id, f.leadId));
    await (await f.handover()).processAgent(f.workerId);
    expect(await f.current(f.reportIds[0]!)).toMatchObject({ reportsTo: f.workerId });
    expect(marker(await f.current(f.workerId))).toMatchObject({ code: "agent_handover_pending",
      blocked: [expect.objectContaining({ kind: "report", id: f.reportIds[0], reason: "cycle" })] });
    f.unsubscribe();
  }, 60_000);

  // ---- RF2-0510 row 13: a failing task is left assigned, named, retried with bounded backoff, never a silent loop
  it("row 13: a task whose reassignment fails stays assigned and named under the marker; retry is bounded by backoff", async () => {
    const f = await seed();
    const failing = await f.task("Failing", "todo"), fine = await f.task("Fine", "todo");
    await f.retire();
    await db.execute(sql`insert into b6_forced_failures values ('issue.reassigned', ${failing.id})`);
    let now = new Date();
    const service = await f.handover({ now: () => now });
    await service.processAgent(f.workerId);
    expect(await f.currentTask(fine.id)).toMatchObject({ assigneeAgentId: f.leadId });
    expect(await f.currentTask(failing.id)).toMatchObject({ assigneeAgentId: f.workerId });
    const first = marker(await f.current(f.workerId));
    expect(first).toMatchObject({ code: "agent_handover_pending", blocked: [expect.objectContaining({ kind: "task", id: failing.id, attempts: 1 })] });
    expect(first.blocked[0].reason).toContain("forced issue.reassigned failure");
    expect(Date.parse(first.blocked[0].retryAt)).toBeGreaterThan(now.getTime());
    // Before the backoff deadline, another pass does not retry it.
    await service.processAgent(f.workerId);
    expect(marker(await f.current(f.workerId)).blocked[0].attempts).toBe(1);
    await db.execute(sql`delete from b6_forced_failures`);
    now = new Date(Date.parse(first.blocked[0].retryAt) + 1);
    await service.processAgent(f.workerId);
    expect(await f.currentTask(failing.id)).toMatchObject({ assigneeAgentId: f.leadId });
    expect(marker(await f.current(f.workerId))).toBeUndefined();
    f.unsubscribe();
  }, 60_000);

  // ---- Condition 5 / W2: commit-bound wake drains a normal retire within 60 s (the gate row) ----
  it("gate row: a normal retire by the lead drains within 60 s through the commit-bound delivery queue", async () => {
    const f = await seed({ reports: 1 });
    const task = await f.task("Unfinished", "in_progress");
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    const recovery = (await handoverModule()).startAgentHandoverRecovery(db, coordinator);
    try {
      await recovery.ready;
      const response = await f.terminate("POST");
      expect(response.status, response.text).toBe(200);
      await f.worker.process(f.workerId);
      const committedAt = Date.now();
      await vi.waitFor(async () => expect(marker(await f.current(f.workerId))).toBeUndefined(), { timeout: 60_000, interval: 50 });
      expect(Date.now() - committedAt).toBeLessThan(60_000);
      expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.leadId, status: "todo" });
      expect(await f.current(f.reportIds[0]!)).toMatchObject({ reportsTo: f.leadId });
      expect(errors).toEqual([]);
    } finally { await coordinator.stop(); }
    f.unsubscribe();
  }, 90_000);

  // ---- W2 + condition 6: agents retired BEFORE the fix: a DRY LIST first, repair only on explicit enable ----
  it("pre-fix retirements (default): the reconcile scan only produces a DRY LIST of counts and ids; nothing is repaired", async () => {
    const f = await seed({ reports: 1 });
    const tasks = [await f.task("T1", "todo"), await f.task("T2", "blocked")];
    // Retired before the fix: terminated, no marker, work and a live report left behind.
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, f.workerId));
    const before = await f.roster(), activity = await f.activity();
    const dry = await (await f.handover()).dryList({ companyId: f.companyId });
    expect(dry).toEqual({ agents: 1, tasks: 2, reports: 1, agentIds: [f.workerId],
      taskIds: tasks.map(task => task.id).sort(), reportIds: [f.reportIds[0]] });
    await (await f.handover()).processPending();
    expect(await f.roster()).toEqual(before);
    for (const task of tasks) expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.workerId });
    expect(await f.activity()).toEqual(activity);
    f.unsubscribe();
  }, 60_000);

  it("pre-fix retirements (repair explicitly enabled): a terminated agent with 2 open tasks and 1 live report is repaired on the FIRST pass", async () => {
    const f = await seed({ reports: 1 });
    const tasks = [await f.task("T1", "todo"), await f.task("T2", "blocked")];
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, f.workerId));
    await (await f.handover({ repairUnmarked: true })).processPending();
    for (const task of tasks) expect(await f.currentTask(task.id)).toMatchObject({ assigneeAgentId: f.leadId });
    expect(await f.current(f.reportIds[0]!)).toMatchObject({ reportsTo: f.leadId });
    expect(await f.activity("issue.reassigned")).toHaveLength(2);
    expect(await f.activity("agent.reports_to_changed")).toHaveLength(1);
    expect(marker(await f.current(f.workerId))).toBeUndefined();
    expect(await (await f.handover()).dryList({ companyId: f.companyId })).toMatchObject({ agents: 0, tasks: 0, reports: 0 });
    f.unsubscribe();
  }, 60_000);

  it("routines (RF2-0510 row 15): the recovery worker PAUSES a retired agent's active routine with one activity row, never re-homes it", async () => {
    const f = await seed();
    const routines = routineService(db, { heartbeat: { wakeup: async () => null }, runtimeEnv: {} } as never);
    const routine = await routines.create(f.companyId, { title: "Retired agent's routine", assigneeAgentId: f.workerId, priority: "medium",
      status: "active", concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed", variables: [] }, {});
    await f.retire();
    const service = await f.handover();
    await service.processAgent(f.workerId);
    await service.processAgent(f.workerId);
    const [after] = await db.select().from(routinesTable).where(eq(routinesTable.id, routine.id));
    expect(after).toMatchObject({ status: "paused", assigneeAgentId: f.workerId });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, routine.id), eq(activityLog.action, "routine.paused"))))
      .toEqual([expect.objectContaining({ actorType: "system", details: expect.objectContaining({ reason: "agent_terminated", retiredAgentId: f.workerId }) })]);
    f.unsubscribe();
  }, 60_000);

  // ---- W7: the assigned-work sweep no longer excludes terminated assignees ----
  it("W7: the assigned-work sweep sees the pre-fix row and hands it to the recovery worker", async () => {
    const f = await seed();
    const task = await f.task("Stranded on a retired agent", "todo");
    await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" }).where(eq(agents.id, f.workerId));
    const enqueueWakeup = vi.fn(async () => null);
    const sweep = assignedWorkSweep(db, { enqueueWakeup });
    const suspects = await sweep.listSuspects({ companyId: f.companyId }, null, 100);
    expect(suspects.map(row => row.id)).toContain(task.id);
    const check = await sweep.checkIssue({ companyId: f.companyId, issueId: task.id });
    expect(check?.outcome).toBe("left_to_handover");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    f.unsubscribe();
  }, 60_000);

  // ---- 'holds cleared' dropped; an OPEN budget incident / approval for the retired agent is closed with an audit row
  it("budget: an open budget incident and its pending override approval for the retired agent are closed with one audit row", async () => {
    const f = await seed();
    const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: f.workerId,
      windowKind: "calendar_month_utc", amount: 100 }).returning();
    const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "budget_override_required", status: "pending", payload: {} }).returning();
    const [incident] = await db.insert(budgetIncidents).values({ companyId: f.companyId, policyId: policy!.id, scopeType: "agent", scopeId: f.workerId,
      metric: policy!.metric, windowKind: "calendar_month_utc", windowStart: new Date("2026-11-01T00:00:00Z"), windowEnd: new Date("2026-12-01T00:00:00Z"),
      thresholdType: "hard", amountLimit: 100, amountObserved: 120, status: "open", approvalId: approval!.id }).returning();
    await f.retire();
    await (await f.handover()).processAgent(f.workerId);
    expect((await db.select().from(budgetIncidents).where(eq(budgetIncidents.id, incident!.id)))[0]).toMatchObject({ status: "dismissed", resolvedAt: expect.any(Date) });
    expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0]).toMatchObject({ status: "rejected" });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, incident!.id), eq(activityLog.action, "budget.incident_resolved"))))
      .toEqual([expect.objectContaining({ actorType: "system", details: expect.objectContaining({ reason: "agent_terminated", scopeId: f.workerId }) })]);
    // The budget policy itself and the frozen holds are left alone.
    expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id)))[0]).toEqual(policy);
    f.unsubscribe();
  }, 60_000);

  // ---- S4: the post-commit cancel tail is best-effort; a failed Stop delivery never turns a committed terminate into a 500
  it("S4: a failing post-commit Stop delivery still returns the committed terminate", async () => {
    const f = await seed();
    stopBoundary.deliver = async () => { throw new Error("stop delivery unavailable"); };
    try {
      const response = await f.terminate("POST");
      expect(response.status, response.text).toBe(200);
      expect(response.body).toMatchObject({ id: f.workerId, status: "terminated" });
      expect(await f.current(f.workerId)).toMatchObject({ status: "terminated", lifecycleState: "terminating" });
    } finally { stopBoundary.deliver = undefined; }
    f.unsubscribe();
  }, 60_000);

  // ---- Section 6 / #11407 (no upstream fix merged): the routine dispatcher skips retired agents ----
  it("routines: a retired agent's schedule no longer fires, and does not stop other due routines", async () => {
    const f = await seed();
    const routines = routineService(db, { heartbeat: { wakeup: async () => null }, runtimeEnv: {} } as never);
    const make = async (assigneeAgentId: string, title: string) => {
      const routine = await routines.create(f.companyId, { title, assigneeAgentId, priority: "medium", status: "active",
        concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed", variables: [] }, {});
      const { trigger } = await routines.createTrigger(routine.id, { kind: "schedule", enabled: true, cronExpression: "0 * * * *", timezone: "UTC" }, {});
      return { routine, trigger };
    };
    const retired = await make(f.workerId, "Retired agent's routine");
    const live = await make(f.leadId, "Lead's routine");
    await f.retire();
    const due = new Date(Date.now() - 60_000);
    await db.update(routineTriggers).set({ nextRunAt: due }).where(inArray(routineTriggers.id, [retired.trigger.id, live.trigger.id]));
    const before = (await db.select().from(routineTriggers).where(eq(routineTriggers.id, retired.trigger.id)))[0]!;
    const tick = await settle(routines.tickScheduledTriggers(new Date()));
    expect(tick.error?.message).toBeUndefined();
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, retired.routine.id))).toEqual([]);
    expect(await db.select().from(issues).where(and(eq(issues.companyId, f.companyId), eq(issues.assigneeAgentId, f.workerId), inArray(issues.status, OPEN)))).toEqual([]);
    expect((await db.select().from(routineTriggers).where(eq(routineTriggers.id, retired.trigger.id)))[0]).toEqual(before);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, live.routine.id))).toHaveLength(1);
    f.unsubscribe();
  }, 60_000);
});
