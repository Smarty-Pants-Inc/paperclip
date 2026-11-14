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
import { toolAccessRoutes } from "../routes/tool-access.js";
import { accessService } from "../services/access.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { updateAgentConfigurationInTransaction } from "../services/agent-configuration-transaction.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Recorded catch: #20389 pass 3 / SMAA-1169. Trust boundary: real bearer HTTP,
// PostgreSQL grants, an actual hire, and persisted installs/bindings (no auth mocks).
describe("tool grants to a manager's current reporting subtree", () => {
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

  async function finishFixture(style: "structured" | "allow" | "unscoped" | "exact-outside" = "structured") {
    const f = await fixture(style);
    await db.update(toolProfiles).set({ profileKey: `app:${f.connection.id}` }).where(eq(toolProfiles.id, f.profile.id));
    await db.insert(toolProfileBindings).values([
      { companyId: f.companyId, profileId: f.profile.id, targetType: "agent", targetId: f.ids.manager },
      { companyId: f.companyId, profileId: f.profile.id, targetType: "company", targetId: f.companyId },
    ]);
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "company", targetId: f.companyId });
    const [entry] = await db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: f.connection.applicationId,
      connectionId: f.connection.id, name: "Read mailbox", toolName: "read_mailbox", versionHash: "finish-scope" }).returning();
    const finish = (agentIds: string[], preserveExistingAccess = true) => request(f.api)
      .post(`/api/companies/${f.companyId}/tools/apps/${f.connection.id}/finish`)
      .set("Authorization", `Bearer ${f.token}`)
      .send({ access: { agentIds }, preserveExistingAccess, enabledCatalogEntryIds: [entry.id] });
    const bindings = async () => (await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id)))
      .map(row => `${row.targetType}:${row.targetId}`).sort();
    return { ...f, entry, finish, bindings };
  }

  it.each([
    { mutation: "instructions", shortcut: false }, { mutation: "activation", shortcut: false },
    { mutation: "instructions", shortcut: true }, { mutation: "activation", shortcut: true },
  ] as const)("R4 SHORTCUT: retained remote MCP reconnect cannot bypass shared authorization: %j", async ({ mutation, shortcut }) => {
    const f = await finishFixture();
    const config = { sourceTemplateKey: "zapier", connectionMethodKey: "generated-url", mcpPreserveAccess: shortcut };
    await db.update(toolConnections).set({ config, transportConfig: config, agentInstructions: { enabled: true, text: "Board-owned shared instructions" }, ...(mutation === "activation" ? { status: "draft", enabled: false } : {}) }).where(eq(toolConnections.id, f.connection.id));
    const before = (await db.select({ status: toolConnections.status, enabled: toolConnections.enabled, agentInstructions: toolConnections.agentInstructions }).from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0];
    const response = await request(f.api).post(`/api/companies/${f.companyId}/tools/apps/${f.connection.id}/finish`)
      .set("Authorization", `Bearer ${f.token}`).send({ access: { agentIds: [f.report] }, preserveExistingAccess: true, enabledCatalogEntryIds: [f.entry.id], ...(mutation === "instructions" ? { agentInstructions: { enabled: true, text: "Changed by scoped lead" } } : {}) });
    const after = (await db.select({ status: toolConnections.status, enabled: toolConnections.enabled, agentInstructions: toolConnections.agentInstructions }).from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0];
    console.log("R4 remote MCP shortcut", JSON.stringify({ mutation, shortcut, status: response.status, before, after }));
    expect(response.status, response.text).toBe(403);
    expect(after).toEqual(before);
  }, 60_000);
});
