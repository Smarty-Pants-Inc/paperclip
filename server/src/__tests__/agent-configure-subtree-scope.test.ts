import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentApiKeys, authUsers, companies, companyMemberships, createDb,
  principalPermissionGrants, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { agentPermissionGrantRoutes } from "../routes/agent-permission-grants.js";
import { accessRoutes } from "../routes/access.js";
import { authorizationService } from "../services/authorization.js";
import { builtInAgentService } from "../services/built-in-agents.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Trust boundary: exercise authenticated HTTP writes and persisted state, not mocked authorization calls.
describe("subtree-scoped agent configuration", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "configure-subtree-home-"));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("configure-subtree-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function seed(scopeStyle: "structured" | "allow" | "unscoped" = "structured") {
    const companyId = randomUUID(), userId = randomUUID();
    const ids = { lead: randomUUID(), report: randomUUID(), descendant: randomUUID(), sibling: randomUUID(), manager: randomUUID(), unrelated: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Subtree boundary", issuePrefix: `S${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Board owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    for (const name of ["manager", "unrelated", "lead", "sibling", "report", "descendant"] as const) {
      const reportsTo = name === "lead" || name === "sibling" ? ids.manager : name === "report" ? ids.lead : name === "descendant" ? ids.report : null;
      await db.insert(agents).values({ id: ids[name], companyId, name, reportsTo, adapterType: "process", status: "idle", lifecycleState: "ready", permissions: { canCreateAgents: true }, runtimeConfig: { heartbeat: { enabled: false } } });
    }
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" },
      ...Object.values(ids).map(principalId => ({ companyId, principalType: "agent" as const, principalId, membershipRole: "member", status: "active" as const })),
    ]);
    const scope = scopeStyle === "unscoped" ? null : scopeStyle === "allow" ? { allow: [`subtree:${ids.lead}`] } : { subtreeRootAgentId: ids.lead };
    await db.insert(principalPermissionGrants).values([
      ...(["agents:configure", "agents:read", "agents:create", "users:manage_permissions"] as const).map(permissionKey => ({ companyId, principalType: "user" as const, principalId: userId, permissionKey })),
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "agents:configure", scope },
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "agents:read" },
      // Reproduce the live legacy lead: suggest remains unscoped, so out-of-tree refusals enter consent.
      { companyId, principalType: "agent", principalId: ids.lead, permissionKey: "agents:suggest-changes" },
    ]);
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: ids.lead, name: "Lead", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express();
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentPermissionGrantRoutes(db));
    api.use("/api", agentRoutes(db));
    api.use(errorHandler);
    const board = express();
    board.use(express.json());
    board.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], isInstanceAdmin: false }; next(); });
    board.use("/api", accessRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
    board.use("/api", agentPermissionGrantRoutes(db));
    board.use("/api", agentRoutes(db));
    board.use(errorHandler);
    const patch = (id: string, body: Record<string, unknown>) => request(api).patch(`/api/agents/${id}`).set("Authorization", `Bearer ${token}`).send(body);
    return { companyId, userId, ids, token, api, board, patch };
  }

  for (const style of ["structured", "allow"] as const) {
    it(`${style}: lead configures self, reports and transitive descendants, never sibling, manager or an unrelated agent`, async () => {
      const f = await seed(style);
      for (const id of [f.ids.lead, f.ids.report, f.ids.descendant]) {
        for (const body of [{ runtimeConfig: { heartbeat: { enabled: false, maxConcurrentRuns: 2 } } }, { title: "Scoped update" }]) {
          const response = await f.patch(id, body);
          expect(response.status, `${id}: ${response.text}`).toBe(200);
          const [saved] = await db.select().from(agents).where(eq(agents.id, id));
          expect(saved).toMatchObject(body);
        }
      }
      for (const id of [f.ids.sibling, f.ids.manager, f.ids.unrelated]) {
        for (const body of [{ title: "Forbidden update" }, { runtimeConfig: { heartbeat: { maxConcurrentRuns: 3 } } }]) {
          const response = await f.patch(id, body);
          expect(response.status, response.text).toBe(403);
        }
        expect((await db.select().from(agents).where(eq(agents.id, id)))[0]!.title).toBeNull();
      }
    }, 60_000);

    it(`${style}: instruction file edits allow a report but refuse an unrelated target`, async () => {
      const f = await seed(style);
      for (const [id, expected] of [[f.ids.report, 200], [f.ids.unrelated, 403]] as const) {
        const url = `/api/agents/${id}/instructions-bundle/file`;
        const initial = await request(f.board).put(url).send({ path: "AGENTS.md", content: "Original instructions", baseRevisionId: null });
        expect(initial.status, initial.text).toBe(200);
        const response = await request(f.api).put(url).set("Authorization", `Bearer ${f.token}`).send({ path: "AGENTS.md", content: "Lead instructions", baseRevisionId: initial.body.revision.id });
        expect(response.status, response.text).toBe(expected);
        const read = await request(f.board).get(`${url}?path=AGENTS.md`);
        expect(read.status, read.text).toBe(200);
        expect(read.body.content).toBe(expected === 200 ? "Lead instructions" : "Original instructions");
      }
    }, 60_000);
  }

  it("keeps existing unscoped configure and board writes working outside the actor's subtree", async () => {
    const f = await seed("unscoped");
    expect((await f.patch(f.ids.unrelated, { title: "Legacy configure" })).status).toBe(200);
    const response = await request(f.board).patch(`/api/agents/${f.ids.manager}`).send({ title: "Board configure" });
    expect(response.status, response.text).toBe(200);
  }, 60_000);

  it("agent hire starts with self-subtree configure and suggest grants, with no consent bypass outside it", async () => {
    const f = await seed();
    const response = await request(f.api).post(`/api/companies/${f.companyId}/agent-hires`).set("Authorization", `Bearer ${f.token}`).send({ name: "Hired lead", role: "engineer", reportsTo: f.ids.lead, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } });
    expect(response.status, response.text).toBe(201);
    const id = response.body.agent.id;
    const read = await request(f.board).get(`/api/agents/${id}`);
    expect(read.status, read.text).toBe(200);
    for (const permissionKey of ["agents:configure", "agents:suggest-changes"]) {
      expect(read.body.access.grants.filter((g: { permissionKey: string }) => g.permissionKey === permissionKey)).toEqual([
        expect.objectContaining({ scope: { subtreeRootAgentId: id } }),
      ]);
    }
    const decision = await authorizationService(db).decide({ actor: { type: "agent", companyId: f.companyId, agentId: id, source: "agent_key", onBehalfOfUserId: f.userId }, action: "agent_config:update", resource: { type: "agent", companyId: f.companyId, agentId: f.ids.unrelated }, scope: { targetAgentId: f.ids.unrelated, requiresChangeGrant: true, consentedChange: true } });
    expect(decision).toMatchObject({ allowed: false, reason: "deny_scope" });
  }, 60_000);

  it("board can persist/replace a scope, toggle without widening it, and explicitly reset to unscoped", async () => {
    const f = await seed();
    const url = `/api/agents/${f.ids.lead}/permission-grants`;
    const body = { permissionKey: "agents:configure", enabled: true };
    const readScope = async () => {
      const read = await request(f.board).get(`/api/agents/${f.ids.lead}`);
      expect(read.status, read.text).toBe(200);
      return read.body.access.grants.find((g: { permissionKey: string }) => g.permissionKey === body.permissionKey).scope;
    };
    const toggle = await request(f.board).patch(url).send(body);
    expect(toggle.status, toggle.text).toBe(200);
    expect(await readScope()).toEqual({ subtreeRootAgentId: f.ids.lead });
    for (const scope of [{ subtreeRootAgentId: f.ids.report }, { allow: [`subtree:${f.ids.lead}`] }, null]) {
      const response = await request(f.board).patch(url).send({ ...body, scope });
      expect(response.status, response.text).toBe(200);
      expect(await readScope()).toEqual(scope);
    }
    const agentWrite = await request(f.api).patch(url).set("Authorization", `Bearer ${f.token}`).send({ ...body, scope: { subtreeRootAgentId: f.ids.lead } });
    expect(agentWrite.status).toBe(403);
  }, 60_000);

  it("directs board users from the human-member permission route to the agent grant route", async () => {
    const f = await seed();
    const [membership] = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, f.ids.lead)));
    const response = await request(f.board).patch(`/api/companies/${f.companyId}/members/${membership!.id}/permissions`).send({ grants: [{ permissionKey: "agents:configure", scope: { subtreeRootAgentId: f.ids.lead } }] });
    expect(response.status, response.text).toBe(403);
    expect(response.body.error).toContain("/api/agents/:id/permission-grants");
    expect(response.body.error).not.toContain("removed");
  }, 60_000);

  it("requires target-scoped configure for CEO permission writes even without a hiring change", async () => {
    const f = await seed();
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, f.ids.lead));
    const before = (await db.select().from(agents).where(eq(agents.id, f.ids.unrelated)))[0]!.permissions;
    const denied = await request(f.api).patch(`/api/agents/${f.ids.unrelated}/permissions`).set("Authorization", `Bearer ${f.token}`).send({ canCreateAgents: true, canAssignTasks: true });
    expect(denied.status, denied.text).toBe(403);
    expect((await db.select().from(agents).where(eq(agents.id, f.ids.unrelated)))[0]!.permissions).toEqual(before);
    const allowed = await request(f.api).patch(`/api/agents/${f.ids.report}/permissions`).set("Authorization", `Bearer ${f.token}`).send({ canCreateAgents: true, canAssignTasks: true });
    expect(allowed.status, allowed.text).toBe(200);
    expect((await db.select().from(agents).where(eq(agents.id, f.ids.report)))[0]!.permissions).toMatchObject({ canAssignTasks: true });
  }, 60_000);

  for (const style of ["structured", "allow", "unscoped"] as const) {
    it(`${style}: startup and direct-create reconciliation never widen a root CEO's existing configure grant`, async () => {
      const f = await seed(style);
      await db.update(agents).set({ role: "ceo", reportsTo: null }).where(eq(agents.id, f.ids.lead));
      const readScope = async () => (await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure"))))[0]!.scope;
      const before = await readScope();
      await builtInAgentService(db).ensureCompanyDefaultAgentGrants(f.companyId);
      expect(await readScope()).toEqual(before);
      const created = await request(f.board).post(`/api/companies/${f.companyId}/agents`).send({ name: "Another agent", role: "engineer", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } } });
      expect(created.status, created.text).toBe(201);
      expect(await readScope()).toEqual(before);
    }, 60_000);
  }

  it("reconciles a missing root CEO configure grant as subtree-scoped, not unscoped", async () => {
    const f = await seed();
    await db.update(agents).set({ role: "ceo", reportsTo: null }).where(eq(agents.id, f.ids.lead));
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    await builtInAgentService(db).ensureCompanyDefaultAgentGrants(f.companyId);
    const [grant] = await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    expect(grant!.scope).toEqual({ subtreeRootAgentId: f.ids.lead });
  }, 60_000);

  it("rejects malformed, empty or unknown scope constraints without changing the grant", async () => {
    const f = await seed();
    for (const scope of [{}, [], "all", { subtreeRootAgentId: "invalid" }, { subtreeRootAgentId: null }, { companyId: f.companyId }, { allow: ["anything"] }, { allow: [] }, { subtreeRootAgentId: f.ids.lead, typo: true }]) {
      const response = await request(f.board).patch(`/api/agents/${f.ids.lead}/permission-grants`).send({ permissionKey: "agents:configure", enabled: true, scope });
      expect(response.status, JSON.stringify(scope)).toBe(400);
    }
    const [grant] = await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    expect(grant!.scope).toEqual({ subtreeRootAgentId: f.ids.lead });
  }, 60_000);
});
