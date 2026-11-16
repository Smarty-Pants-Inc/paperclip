import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentApiKeys, authUsers, companies, companyMemberships, createDb,
  principalPermissionGrants, approvals, issues, budgetPolicies, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, type Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";
import { issueService } from "../services/issues.js";
import { agentHandoverService } from "../services/agent-handover.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Trust boundary/data safety: real agent-key HTTP requests, persisted grants,
// lifecycle commands and audit rows. Only external host/plugin work is simulated.
describe("subtree-scoped agent lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const workers: ReturnType<typeof configureAgentLifecycle>[] = [];
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "lifecycle-subtree-home-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("lifecycle-subtree-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    for (const worker of workers) await worker.stop();
    // The database owner closes registered clients, including lifecycle listeners.
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed(style: "structured" | "allow" = "structured") {
    const companyId = randomUUID(), userId = randomUUID();
    const ids = { manager: randomUUID(), sibling: randomUUID(), unrelated: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Lifecycle boundary", issuePrefix: `L${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Board owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    for (const name of ["manager", "sibling", "unrelated"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, reportsTo: name === "sibling" ? ids.manager : null, adapterType: "process", status: "idle", lifecycleState: "ready", runtimeConfig: { heartbeat: { enabled: false } } });
    }
    await workers.at(-1)?.stop();
    const worker = configureAgentLifecycle(db, {
      requiredPluginIds: async () => [],
      runHost: async () => "complete" as const,
      runPlugin: async () => "complete" as const,
    });
    workers.push(worker);
    const lead = await createAgentLifecycle(db).requestHire(companyId, {
      name: "Lead", role: "engineer", reportsTo: ids.manager, adapterType: "process", adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: false } }, permissions: { canCreateAgents: true },
    }, { responsibleUserId: userId, createdByUserId: userId });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...[lead.id, ...Object.values(ids)].map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]).onConflictDoNothing();
    await db.insert(principalPermissionGrants).values(
      (["agents:configure", "agents:read", "agents:create"] as const).map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
    );
    const [grant] = await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, lead.id), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    expect(grant!.scope).toEqual({ subtreeRootAgentId: lead.id });
    if (style === "allow") {
      await db.update(principalPermissionGrants).set({ scope: { allow: [`subtree:${lead.id}`] } }).where(eq(principalPermissionGrants.id, grant!.id));
    }
    await worker.process(lead.id);
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: lead.id, name: "Lead", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
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
    const hire = async (reportsTo = lead.id) => {
      const response = await request(api).post(`/api/companies/${companyId}/agent-hires`).set("Authorization", `Bearer ${token}`).send({ name: "Hired worker", role: "engineer", reportsTo, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } });
      expect(response.status, response.text).toBe(201);
      await worker.process(response.body.agent.id);
      return response.body.agent.id as string;
    };
    const post = (id: string, command: string) => request(api).post(`/api/agents/${id}/${command}`).set("Authorization", `Bearer ${token}`).send({});
    const current = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;
    return { companyId, userId, ids: { ...ids, lead: lead.id }, token, api, board, worker, hire, post, current };
  }

  for (const style of ["structured", "allow"] as const) {
    it(`${style}: lead hires and pauses, resumes and terminates its worker with its agent key`, async () => {
      const f = await seed(style);
      const workerId = await f.hire();
      expect(await f.current(workerId)).toMatchObject({ reportsTo: f.ids.lead, lifecycleState: "ready" });
      for (const [command, state] of [["pause", "paused"], ["resume", "ready"], ["terminate", "terminated"]] as const) {
        const response = await f.post(workerId, command);
        expect.soft(response.status, `${command}: ${response.text}`).toBe(200);
        await f.worker.process(workerId);
        expect.soft((await f.current(workerId)).lifecycleState).toBe(state);
      }
      const events = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.entityId, workerId)));
      for (const action of ["agent.paused", "agent.resumed", "agent.terminated"]) {
        expect.soft(events.filter(event => event.action === action)).toEqual([
          expect.objectContaining({ actorType: "agent", actorId: f.ids.lead, agentId: f.ids.lead }),
        ]);
      }
    }, 60_000);

    it(`${style}: refuses all three commands outside its subtree and on itself without writes`, async () => {
      const f = await seed(style);
      for (const id of [f.ids.lead, f.ids.manager, f.ids.sibling, f.ids.unrelated]) {
        const before = await f.current(id);
        for (const command of ["pause", "resume", "terminate"]) {
          const response = await f.post(id, command);
          expect(response.status, `${command} ${id}: ${response.text}`).toBe(403);
        }
        expect(await f.current(id)).toEqual(before);
        const events = await db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.actorType, "agent")));
        expect(events.filter(event => ["agent.paused", "agent.resumed", "agent.terminated"].includes(event.action))).toEqual([]);
      }
    }, 60_000);
  }

  for (const grant of ["unscoped", "peer-worker"] as const) {
    for (const command of ["pause", "resume", "terminate"] as const) {
      it(`${grant}: denies ${command} on a peer's worker through POST and PATCH without writes`, async () => {
        const f = await seed();
        const workerId = await f.hire();
        await db.update(agents).set({ reportsTo: f.ids.sibling }).where(eq(agents.id, workerId));
        if (command === "resume") {
          await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"] })
            .where(eq(agents.id, workerId));
        }
        await db.update(principalPermissionGrants).set({ scope: grant === "unscoped" ? null : { agentIds: [workerId] } })
          .where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
        const before = await f.current(workerId);
        const events = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
        const post = await f.post(workerId, command);
        const patch = await request(f.api).patch(`/api/agents/${workerId}`).set("Authorization", `Bearer ${f.token}`)
          .send({ status: command === "pause" ? "paused" : command === "resume" ? "idle" : "terminated" });
        expect.soft(post.status, post.text).toBe(403);
        expect.soft(patch.status, patch.text).toBe(403);
        expect.soft(await f.current(workerId)).toEqual(before);
        expect.soft(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual(events);
      }, 60_000);
    }
  }

  for (const via of ["POST", "PATCH"] as const) {
    // superseded by replacement: RFL FINAL S2/S3 + CTL6-RF2-0505 W1/W3/W5/W6.
    // Original intent: retire through the lead's real agent key, returning only its open tasks and preserving all unrelated rows.
    it(`#20389 gate row: retire via ${via} releases holds and returns open tasks, never another subtree (current contract: frozen holds and per-item handover)`, async () => {
      const f = await seed();
      const workerId = await f.hire();
      await db.update(agents).set({ status: "paused", lifecycleState: "paused", lifecycleHolds: ["budget"], pauseReason: "budget" })
        .where(eq(agents.id, workerId));
      const task = await issueService(db).create(f.companyId, { title: "Unfinished worker task", status: "blocked", assigneeAgentId: workerId });
      const done = await issueService(db).create(f.companyId, { title: "Completed worker task", status: "done", assigneeAgentId: workerId });
      const active = await issueService(db).create(f.companyId, { title: "Active worker task", status: "in_progress", assigneeAgentId: workerId });
      const other = await issueService(db).create(f.companyId, { title: "Other subtree task", status: "blocked", assigneeAgentId: f.ids.unrelated });
      const otherBefore = (await db.select().from(issues).where(eq(issues.id, other.id)))[0];
      const [policy] = await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: workerId,
        windowKind: "calendar_month_utc", amount: 100 }).returning();
      const company = (await db.select().from(companies).where(eq(companies.id, f.companyId)))[0];
      const unrelated = await f.current(f.ids.unrelated);
      const denied = await f.post(f.ids.unrelated, "terminate");
      expect(denied.status, denied.text).toBe(403);
      expect(await f.current(f.ids.unrelated)).toEqual(unrelated);
      // agentctl's stated retire sequence is pause then terminate, not DELETE.
      const pause = await f.post(workerId, "pause");
      expect(pause.status, pause.text).toBe(200);
      await f.worker.process(workerId);
      const beforeAgent = await f.current(workerId);
      expect(beforeAgent.lifecycleHolds).toEqual(["budget", "manual"]);
      const beforeTasks = await db.select().from(issues).where(eq(issues.companyId, f.companyId)).orderBy(issues.id);
      const beforeActivity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)).orderBy(activityLog.id);
      const events: { action: unknown; entityId: unknown }[] = [];
      const unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => {
        if (event.type === "activity.logged") events.push({ action: event.payload.action, entityId: event.payload.entityId });
      });
      try {
      // The real request's first transaction rolls back once. There is no hidden
      // second attempt: neither the agent, task rows nor live activity may change.
      let attempts = 0;
      const rollbackDb = new Proxy(db, { get(target, key, receiver) {
        if (key === "transaction") return (async (work, options) => target.transaction(async tx => {
          attempts++;
          const value = await work(tx);
          if (attempts === 1) await tx.execute(sql`DO $$ BEGIN RAISE EXCEPTION 'forced scoped retire rollback' USING ERRCODE = '40P01'; END $$`);
          return value;
        }, options)) as Db["transaction"];
        return Reflect.get(target, key, receiver);
      } });
      const rollbackApi = express();
      rollbackApi.use(express.json());
      rollbackApi.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
      rollbackApi.use("/api", agentRoutes(rollbackDb));
      rollbackApi.use(errorHandler);
      const failed = via === "POST"
        ? await request(rollbackApi).post(`/api/agents/${workerId}/terminate`).set("Authorization", `Bearer ${f.token}`).send({})
        : await request(rollbackApi).patch(`/api/agents/${workerId}`).set("Authorization", `Bearer ${f.token}`).send({ status: "terminated" });
      expect(failed.status, failed.text).toBe(503);
      expect(attempts).toBe(1);
      expect(await f.current(workerId)).toEqual(beforeAgent);
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId)).orderBy(issues.id)).toEqual(beforeTasks);
      expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)).orderBy(activityLog.id)).toEqual(beforeActivity);
      expect(events).toEqual([]);

      const response = via === "POST" ? await f.post(workerId, "terminate")
        : await request(f.api).patch(`/api/agents/${workerId}`).set("Authorization", `Bearer ${f.token}`).send({ status: "terminated" });
      expect(response.status, response.text).toBe(200);
      await f.worker.process(workerId);
      // Mirrors agent-retirement-handover's gate row replacement: completion
      // freezes holds and leaves ALL task rows byte-identical under one marker.
      expect(await f.current(workerId)).toMatchObject({ status: "terminated", lifecycleState: "terminated",
        lifecycleHolds: beforeAgent.lifecycleHolds, pauseReason: beforeAgent.pauseReason,
        lifecycleOperation: { handover: { code: "agent_handover_pending" } } });
      expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId)).orderBy(issues.id)).toEqual(beforeTasks);
      const visible = await request(f.board).get(`/api/agents/${workerId}`);
      expect(visible.status, visible.text).toBe(200);
      expect(visible.body.handover).toMatchObject({ code: "agent_handover_pending" });
      const recovery = agentHandoverService(db);
      expect(await recovery.processAgent(workerId)).toMatchObject({ tasks: expect.arrayContaining([task.id, active.id]), cleared: true, blocked: [] });
      expect((await f.current(workerId)).lifecycleOperation?.handover).toBeUndefined();
      const current = (await db.select().from(issues).where(eq(issues.id, task.id)))[0]!;
      expect.soft(current).toMatchObject({ assigneeAgentId: f.ids.lead });
      // Preserve real task blockers and terminal history; retirement is not completion.
      expect.soft(current.status).toBe("blocked");
      expect.soft((await db.select().from(issues).where(eq(issues.id, active.id)))[0]).toMatchObject({ assigneeAgentId: f.ids.lead, status: "todo", executionRunId: null, checkoutRunId: null });
      expect.soft((await db.select().from(issues).where(eq(issues.id, done.id)))[0]).toMatchObject({ assigneeAgentId: workerId, status: "done" });
      expect.soft((await db.select().from(issues).where(eq(issues.id, other.id)))[0]).toEqual(otherBefore);
      expect.soft((await db.select().from(budgetPolicies).where(eq(budgetPolicies.id, policy!.id)))[0]).toEqual(policy);
      expect.soft((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]).toEqual(company);
      expect.soft(await f.current(f.ids.unrelated)).toEqual(unrelated);
      const repeated = await f.post(workerId, "terminate");
      expect(repeated.status, repeated.text).toBe(200);
      await f.worker.process(workerId);
      await recovery.processAgent(workerId);
      for (const id of [task.id, active.id]) {
        const moves = await db.select().from(activityLog).where(and(eq(activityLog.entityId, id), eq(activityLog.action, "issue.reassigned")));
        expect(moves).toEqual([expect.objectContaining({ details: expect.objectContaining({
          previousAssigneeAgentId: workerId, assigneeAgentId: f.ids.lead, reason: "agent_terminated",
        }) })]);
      }
      const rows = (await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)))
        .filter(row => !beforeActivity.some(before => before.id === row.id));
      expect(rows.filter(row => row.action === "agent.terminated")).toEqual([expect.objectContaining({
        entityId: workerId, actorType: "agent", actorId: f.ids.lead,
      })]);
      expect(rows.filter(row => row.action === "agent.handover_completed")).toEqual([expect.objectContaining({ entityId: workerId })]);
      // Identity-key revocation is a separate durable-only receipt (postgres.ts
      // uses persistActivity, not the publication buffer). Keep its row exactly
      // once; match live publications for the route/terminal/per-item activities.
      expect(rows.filter(row => row.action === "agent.identity.revoked")).toEqual([expect.objectContaining({ entityId: workerId })]);
      const publishedRows = rows.filter(row => row.action !== "agent.identity.revoked");
      expect(events).toHaveLength(publishedRows.length);
      for (const row of publishedRows) expect(events.filter(event => event.action === row.action && event.entityId === row.entityId)).toHaveLength(1);
      expect((await f.current(workerId)).lifecycleHolds).toEqual(beforeAgent.lifecycleHolds);
      } finally { unsubscribe(); }
    }, 60_000);
  }

  it("retirement cleanup still works after the reporting manager was terminated", async () => {
    const f = await seed();
    const workerId = await f.hire();
    const task = await issueService(db).create(f.companyId, { title: "Existing recovery retains ownership", status: "blocked", assigneeAgentId: workerId });
    const parent = await request(f.board).post(`/api/agents/${f.ids.lead}/terminate`).send({});
    expect(parent.status, parent.text).toBe(200);
    await f.worker.process(f.ids.lead);
    const report = await request(f.board).post(`/api/agents/${workerId}/terminate`).send({});
    expect(report.status, report.text).toBe(200);
    await f.worker.process(workerId);
    expect(await f.current(workerId)).toMatchObject({ lifecycleState: "terminated", lifecycleHolds: [] });
    expect((await db.select().from(issues).where(eq(issues.id, task.id)))[0]).toMatchObject({ assigneeAgentId: workerId, status: "blocked" });
  }, 60_000);

  it("allows transitive descendants, but loses lifecycle authority after a worker leaves the subtree", async () => {
    const f = await seed();
    const workerId = await f.hire();
    const descendantId = await f.hire(workerId);
    for (const command of ["pause", "resume", "terminate"]) {
      const response = await f.post(descendantId, command);
      expect(response.status, response.text).toBe(200);
      await f.worker.process(descendantId);
    }
    await db.update(agents).set({ reportsTo: f.ids.sibling }).where(eq(agents.id, workerId));
    for (const command of ["pause", "resume", "terminate"]) {
      const response = await f.post(workerId, command);
      expect(response.status, response.text).toBe(403);
    }
    expect((await f.current(workerId)).lifecycleState).toBe("ready");
  }, 60_000);

  it("preserves board lifecycle control outside the lead's subtree", async () => {
    const f = await seed();
    for (const [command, state] of [["pause", "paused"], ["resume", "ready"], ["terminate", "terminated"]] as const) {
      const response = await request(f.board).post(`/api/agents/${f.ids.unrelated}/${command}`).send({});
      expect(response.status, response.text).toBe(200);
      await f.worker.process(f.ids.unrelated);
      expect((await f.current(f.ids.unrelated)).lifecycleState).toBe(state);
    }
    const events = await db.select().from(activityLog).where(eq(activityLog.entityId, f.ids.unrelated));
    for (const action of ["agent.paused", "agent.resumed", "agent.terminated"]) {
      expect(events.filter(event => event.action === action)).toEqual([expect.objectContaining({ actorType: "user", actorId: f.userId })]);
    }
  }, 60_000);

  it("requires a direct configure grant, not suggest-only or read access", async () => {
    const f = await seed();
    const workerId = await f.hire();
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    for (const command of ["pause", "resume", "terminate"]) {
      const response = await f.post(workerId, command);
      expect(response.status, response.text).toBe(403);
    }
    expect((await f.current(workerId)).lifecycleState).toBe("ready");
  }, 60_000);

  it("denies agent rejection of a pending hire without a false board decider, but records the real board user", async () => {
    const f = await seed();
    await db.update(companies).set({ requireBoardApprovalForNewAgents: true }).where(eq(companies.id, f.companyId));
    const workerId = await f.hire();
    expect((await f.current(workerId)).status).toBe("pending_approval");
    const before = await db.select().from(approvals).where(eq(approvals.companyId, f.companyId));
    expect(before).toHaveLength(1);
    const denied = await f.post(workerId, "terminate");
    expect(denied.status, denied.text).toBe(403);
    expect(denied.body.error).toContain("board user");
    expect(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toEqual(before);
    expect((await f.current(workerId)).status).toBe("pending_approval");
    const pending = await f.current(workerId);
    const events = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)).orderBy(activityLog.id);
    const patch = await request(f.api).patch(`/api/agents/${workerId}`).set("Authorization", `Bearer ${f.token}`)
      .send({ status: "terminated" });
    expect.soft(patch.status, patch.text).toBe(403);
    expect.soft(patch.body.error).toContain("board user");
    expect.soft(await f.current(workerId)).toEqual(pending);
    expect.soft(await db.select().from(approvals).where(eq(approvals.companyId, f.companyId))).toEqual(before);
    expect.soft(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)).orderBy(activityLog.id)).toEqual(events);
    const allowed = await request(f.board).post(`/api/agents/${workerId}/terminate`).send({});
    expect(allowed.status, allowed.text).toBe(200);
    const [decided] = await db.select().from(approvals).where(eq(approvals.companyId, f.companyId));
    expect(decided).toMatchObject({ status: "rejected", decidedByUserId: f.userId });
  }, 60_000);

  it("applies the same subtree and self boundary through PATCH status", async () => {
    const f = await seed();
    const workerId = await f.hire();
    for (const [status, state] of [["paused", "paused"], ["idle", "ready"], ["terminated", "terminated"]] as const) {
      const response = await request(f.api).patch(`/api/agents/${workerId}`).set("Authorization", `Bearer ${f.token}`).send({ status });
      expect(response.status, response.text).toBe(200);
      await f.worker.process(workerId);
      expect((await f.current(workerId)).lifecycleState).toBe(state);
      for (const id of [f.ids.lead, f.ids.manager, f.ids.sibling, f.ids.unrelated]) {
        const denied = await request(f.api).patch(`/api/agents/${id}`).set("Authorization", `Bearer ${f.token}`).send({ status });
        expect(denied.status, denied.text).toBe(403);
      }
    }
  }, 60_000);
});
