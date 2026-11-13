import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, agentApiKeys, authUsers, companies, companyMemberships, createDb,
  principalPermissionGrants, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { configureAgentLifecycle, createAgentLifecycle } from "../services/agent-lifecycle.js";

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
