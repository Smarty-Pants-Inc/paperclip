import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentApiKeys, authUsers, companies, companyMemberships, connectionGrants,
  createDb, principalPermissionGrants, toolApplications, toolConnections, toolConnectionInstalls,
  toolProfiles, toolProfileEntries, toolProfileBindings, toolCatalogEntries, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS, newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { agentPermissionGrantRoutes } from "../routes/agent-permission-grants.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { accessService } from "../services/access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Recorded catch: #20389 pass 3 / SMAA-1169. Trust boundary: real bearer HTTP,
// PostgreSQL grants, an actual hire, and persisted installs/bindings (no auth mocks).
describe("independent v2 escalation review", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("tool-grant-subtree-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture(style: "structured" | "allow" | "unscoped" | "exact-outside" = "structured") {
    const companyId = randomUUID(), userId = randomUUID();
    const ids = { manager: randomUUID(), lead: randomUUID(), peer: randomUUID(), other: randomUUID() };
    await db.insert(companies).values({ id: companyId, name: "Real hire tool regression", issuePrefix: `T${companyId.slice(0, 7)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const access = accessService(db);
    await access.ensureMembership(companyId, "user", userId, "operator", "active");
    await access.ensureRoleDefaultGrants(companyId, userId, "operator", userId);
    for (const name of ["manager", "other", "lead", "peer"] as const) {
      await db.insert(agents).values({ id: ids[name], companyId, name, adapterType: "process", status: "idle", lifecycleState: "ready",
        reportsTo: name === "lead" || name === "peer" ? ids.manager : null,
        permissions: { canCreateAgents: true }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } });
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: ids[name], membershipRole: "member", status: "active" });
    }
    await db.insert(principalPermissionGrants).values(NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map(permissionKey => ({
      companyId, principalType: "agent" as const, principalId: ids.lead, permissionKey,
      scope: permissionKey === "agents:configure" && style !== "structured"
        ? style === "allow" ? { allow: [`subtree:${ids.lead}`] } : style === "exact-outside" ? { agentIds: [ids.other] } : null
        : newStandardAgentGrantScope(permissionKey, ids.lead),
    })));
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId, agentId: ids.lead, name: "Lead key", responsibleUserId: userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const api = express();
    api.use(express.json());
    api.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    api.use("/api", agentPermissionGrantRoutes(db));
    api.use("/api", agentRoutes(db));
    api.use("/api", toolAccessRoutes(db));
    api.use(errorHandler);
    const board = express();
    const memberships = await db.select().from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId)));
    board.use(express.json());
    board.use((req, _res, next) => { req.actor = { type: "board", source: "session", userId, companyIds: [companyId], memberships, isInstanceAdmin: false }; next(); });
    board.use("/api", toolAccessRoutes(db));
    board.use(errorHandler);
    const hire = await request(api).post(`/api/companies/${companyId}/agent-hires`).set("Authorization", `Bearer ${token}`).send({
      name: "Just hired helper", role: "engineer", reportsTo: ids.lead, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    });
    expect(hire.status, hire.text).toBe(201);
    const report = hire.body.agent.id as string;
    expect((await db.select().from(agents).where(eq(agents.id, report)))[0]!.reportsTo).toBe(ids.lead);
    const descendant = randomUUID();
    await db.insert(agents).values({ id: descendant, companyId, name: "Indirect report", reportsTo: report, adapterType: "process", status: "idle", lifecycleState: "ready" });
    const [application] = await db.insert(toolApplications).values({ companyId, name: "Mailbox", type: "mcp_http" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: application.id, name: "Mailbox", uid: randomUUID(), transport: "mcp_remote", status: "active", enabled: true }).returning();
    await db.insert(connectionGrants).values({ companyId, connectionId: connection.id, kind: "organization", status: "active", isDefault: true });
    const retained = [ids.lead, ids.peer, ids.manager, ids.other].map(targetId => ({ targetType: "agent" as const, targetId }));
    await db.insert(toolConnectionInstalls).values(retained.map(target => ({ companyId, connectionId: connection.id, ...target })));
    const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: randomUUID(), name: "Read mailbox", defaultAction: "deny" }).returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile.id, selectorType: "connection", connectionId: connection.id });
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile.id, targetType: "agent", targetId: ids.peer });
    const installUrl = `/api/tool-connections/${connection.id}/installs`;
    const bindingUrl = `/api/companies/${companyId}/tools/profiles/${profile.id}/bind`;
    const put = (targets: Array<{ targetType: "agent"; targetId: string }>) => request(api).put(installUrl).set("Authorization", `Bearer ${token}`).send({ installs: targets });
    const bind = (targetId: string) => request(api).post(bindingUrl).set("Authorization", `Bearer ${token}`).send({ targetType: "agent", targetId });
    const installed = async () => (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).map(row => row.targetId).sort();
    return { companyId, userId, ids, report, descendant, connection, profile, retained, api, board, token, put, bind, installed, installUrl, bindingUrl };
  }

  it("SECURITY: a legacy non-root must not gain cross-root tool authority by detaching itself", async () => {
    const f = await fixture("unscoped");
    const before = await f.bind(f.ids.other);
    expect(before.status).toBe(403);
    const promoted = await request(f.api).patch(`/api/agents/${f.ids.lead}`).set("Authorization", `Bearer ${f.token}`).send({ reportsTo: null });
    const [saved] = await db.select({ reportsTo: agents.reportsTo, role: agents.role }).from(agents).where(eq(agents.id, f.ids.lead));
    const after = await f.bind(f.ids.other);
    const persistedBinding = await db.select({ id: toolProfileBindings.id }).from(toolProfileBindings).where(and(
      eq(toolProfileBindings.profileId, f.profile.id), eq(toolProfileBindings.targetId, f.ids.other)));
    const remove = await f.put(f.retained.filter(row => row.targetId !== f.ids.other));
    const removedPersisted = !(await f.installed()).includes(f.ids.other);
    const install = await f.put(f.retained);
    const restoredPersisted = (await f.installed()).includes(f.ids.other);
    console.log("SELF_PROMOTION", JSON.stringify({ before: before.status, patch: promoted.status, reportsTo: saved.reportsTo, role: saved.role,
      afterBind: after.status, bindingSaved: persistedBinding.length > 0, afterRemove: remove.status, removedPersisted,
      afterInstall: install.status, restoredPersisted }));
    expect(after.status, "An ordinary legacy lead must not self-promote into company-wide tool power").toBe(403);
  }, 60_000);

  it("SECURITY: a subtree-scoped caller can detach but cannot turn its own grant into null", async () => {
    const f = await fixture();
    const promoted = await request(f.api).patch(`/api/agents/${f.ids.lead}`).set("Authorization", `Bearer ${f.token}`).send({ reportsTo: null });
    const widened = await request(f.api).patch(`/api/agents/${f.ids.lead}/permission-grants`).set("Authorization", `Bearer ${f.token}`)
      .send({ permissionKey: "agents:configure", enabled: true, scope: null });
    const after = await f.bind(f.ids.other);
    console.log("SCOPED_SELF_PROMOTION", JSON.stringify({ patch: promoted.status, widen: widened.status, bind: after.status }));
    expect(widened.status).toBe(403); expect(after.status).toBe(403);
  }, 60_000);

  it.each(["agent-hires", "agents"])("SECURITY: %s can create a root but does not inherit the legacy creator's null grant", async route => {
    const f = await fixture("unscoped");
    const response = await request(f.api).post(`/api/companies/${f.companyId}/${route}`).set("Authorization", `Bearer ${f.token}`).send({
      name: "Requested root", role: "engineer", reportsTo: null, adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    });
    expect(response.status, response.text).toBe(201);
    const id = route === "agent-hires" ? response.body.agent.id : response.body.id;
    const [saved] = await db.select({ reportsTo: agents.reportsTo }).from(agents).where(eq(agents.id, id));
    const grants = await db.select({ scope: principalPermissionGrants.scope }).from(principalPermissionGrants).where(and(
      eq(principalPermissionGrants.principalId, id), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    console.log("CREATE_ROOT", JSON.stringify({ route, status: response.status, reportsTo: saved.reportsTo, grants }));
    expect(saved.reportsTo).toBeNull(); expect(grants).toEqual([{ scope: { subtreeRootAgentId: id } }]);
  }, 60_000);

  it.each(["null", "omitted"])("SECURITY: a legacy lead cannot delegate a null configure grant through %s scope", async mode => {
    const f = await fixture("unscoped");
    if (mode === "omitted") await db.update(principalPermissionGrants).set({ scope: null }).where(and(
      eq(principalPermissionGrants.principalId, f.report), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    const response = await request(f.api).patch(`/api/agents/${f.report}/permission-grants`).set("Authorization", `Bearer ${f.token}`)
      .send({ permissionKey: "agents:configure", enabled: true, ...(mode === "null" ? { scope: null } : {}) });
    console.log("NULL_DELEGATION", JSON.stringify({ mode, status: response.status }));
    expect(response.status, response.text).toBe(403);
  }, 60_000);

  it("SECURITY: a lead must not promote a legacy unscoped active descendant into cross-root tool power", async () => {
    const f = await fixture("unscoped");
    // Model an already active legacy descendant. This is not an inherited grant
    // on a new hire (fresh-hire defaults are independently checked above).
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: f.descendant, membershipRole: "member", status: "active" });
    await db.insert(principalPermissionGrants).values(NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS.map(permissionKey => ({
      companyId: f.companyId, principalType: "agent" as const, principalId: f.descendant, permissionKey,
      scope: permissionKey === "agents:configure" ? null : newStandardAgentGrantScope(permissionKey, f.descendant),
    })));
    const token = randomUUID();
    await db.insert(agentApiKeys).values({ companyId: f.companyId, agentId: f.descendant, name: "Legacy descendant key", responsibleUserId: f.userId, keyHash: createHash("sha256").update(token).digest("hex") });
    const bind = () => request(f.api).post(f.bindingUrl).set("Authorization", `Bearer ${token}`).send({ targetType: "agent", targetId: f.ids.other });
    expect((await bind()).status).toBe(403);
    const promoted = await request(f.api).patch(`/api/agents/${f.descendant}`).set("Authorization", `Bearer ${f.token}`).send({ reportsTo: null });
    const after = await bind();
    const [saved] = await db.select({ reportsTo: agents.reportsTo, status: agents.status }).from(agents).where(eq(agents.id, f.descendant));
    console.log("DESCENDANT_PROMOTION", JSON.stringify({ patch: promoted.status, reportsTo: saved.reportsTo, savedStatus: saved.status,
      afterBind: after.status, error: after.body.error }));
    expect(after.status, "Detaching an active legacy subordinate must not elevate its tool authority").toBe(403);
  }, 60_000);

  it("SECURITY: company-wide root remains confined to its own company", async () => {
    const f = await fixture("unscoped"), other = await fixture();
    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, f.ids.lead));
    const wrongCompany = await request(f.api).post(other.bindingUrl).set("Authorization", `Bearer ${f.token}`).send({ targetType: "agent", targetId: other.ids.other });
    const wrongTarget = await f.bind(other.ids.other);
    const wrongInstall = await f.put([...f.retained, { targetType: "agent", targetId: other.ids.other }]);
    console.log("COMPANY_BOUNDARY", JSON.stringify({ wrongCompany: wrongCompany.status, wrongTarget: wrongTarget.status, wrongInstall: wrongInstall.status }));
    for (const response of [wrongCompany, wrongTarget, wrongInstall]) expect([403, 404, 422]).toContain(response.status);
    expect(await f.installed()).toEqual(f.retained.map(row => row.targetId).sort());
  }, 60_000);
});
