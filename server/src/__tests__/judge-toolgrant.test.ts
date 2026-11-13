import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentApiKeys, authUsers, companies, companyMemberships, connectionGrants,
  createDb, principalPermissionGrants, toolApplications, toolConnections, toolConnectionInstalls,
  toolProfiles, toolProfileEntries, toolProfileBindings, toolCatalogEntries, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { NEW_STANDARD_AGENT_DEFAULT_GRANT_KEYS, newStandardAgentGrantScope } from "../lib/agent-permissions.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { accessService } from "../services/access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("independent judge adversarial tool assignments", () => {
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

  it("JUDGE: reordering and exact duplicate recipients neither remove outside agents nor add duplicate rows", async () => {
    const f = await fixture();
    const response = await f.put([...[...f.retained].reverse(), f.retained[1], { targetType: "agent", targetId: f.report }, { targetType: "agent", targetId: f.report }]);
    expect(response.status, response.text).toBe(200);
    expect(await f.installed()).toEqual([...f.retained.map(row => row.targetId), f.report].sort());
  }, 60_000);

  it("JUDGE: duplicates cannot conceal a forbidden removal in a replacement set", async () => {
    const f = await fixture();
    const before = await f.installed();
    const response = await f.put([...f.retained.filter(row => row.targetId !== f.ids.peer), f.retained[0], { targetType: "agent", targetId: f.report }]);
    expect(response.status, response.text).toBe(403);
    expect(await f.installed()).toEqual(before);
  }, 60_000);

  it.each(["upper", "whitespace"] as const)("JUDGE: %s variant of outside retained ID fails closed without removing access", async variant => {
    const f = await fixture();
    const before = await f.installed();
    const response = await f.put(f.retained.map(row => row.targetId === f.ids.peer ? { ...row, targetId: variant === "upper" ? row.targetId.toUpperCase() : ` ${row.targetId} ` } : row));
    expect([400, 403, 422], response.text).toContain(response.status);
    expect(await f.installed()).toEqual(before);
  }, 60_000);

  it("JUDGE: shared profile binds never change outside binding rows", async () => {
    const f = await fixture();
    const before = await db.select().from(toolProfileBindings).where(and(eq(toolProfileBindings.profileId, f.profile.id), eq(toolProfileBindings.targetId, f.ids.peer)));
    const response = await f.bind(f.report);
    expect(response.status, response.text).toBe(201);
    expect(await db.select().from(toolProfileBindings).where(and(eq(toolProfileBindings.profileId, f.profile.id), eq(toolProfileBindings.targetId, f.ids.peer)))).toEqual(before);
  }, 60_000);

  it.each(["same-list", "add-own-hire"] as const)("JUDGE: %s must not silently revoke an outside peer's shared legacy profile tool", async change => {
    const f = await fixture();
    await db.update(toolProfiles).set({ profileKey: `app:${f.connection.id}` }).where(eq(toolProfiles.id, f.profile.id));
    const [catalog] = await db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: f.connection.applicationId,
      connectionId: f.connection.id, name: "read_mail", toolName: "read_mail", versionHash: "judge-v1", riskLevel: "read", isReadOnly: true, isWrite: false }).returning();
    const policy = toolAccessPolicyService(db);
    const decide = () => policy.decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: f.ids.peer, agentId: f.ids.peer },
      request: { connectionId: f.connection.id, catalogEntryId: catalog.id, toolName: "read_mail", arguments: {} } });
    const before = await decide();
    expect(before).toMatchObject({ decision: "allow", reasonCode: "allow_profile" });
    const beforeEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    const response = await f.put(change === "same-list" ? f.retained : [...f.retained, { targetType: "agent", targetId: f.report }]);
    expect(response.status, response.text).toBe(200);
    const after = await decide();
    const afterEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    console.log("JUDGE_SHARED_MUTATION", JSON.stringify({ change, status: response.status, before: before.decision, after: after.decision,
      beforeEntries: beforeEntries.length, afterEntries: afterEntries.length }));
    expect(after, "A retained, out-of-scope peer must not lose its tool through an assignment-only write").toMatchObject({ decision: "allow", reasonCode: "allow_profile" });
    expect(afterEntries).toEqual(beforeEntries);
  }, 60_000);

  it("board install PUT still cleans the legacy connection-wide include", async () => {
    const f = await fixture();
    await db.update(toolProfiles).set({ profileKey: `app:${f.connection.id}` }).where(eq(toolProfiles.id, f.profile.id));
    const response = await request(f.board).put(f.installUrl).send({ installs: f.retained });
    expect(response.status, response.text).toBe(200);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id))).toEqual([]);
  }, 60_000);

  it("a scoped board cannot clean a shared legacy profile through an unchanged list", async () => {
    const f = await fixture();
    await db.update(toolProfiles).set({ profileKey: `app:${f.connection.id}` }).where(eq(toolProfiles.id, f.profile.id));
    const before = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    await db.update(principalPermissionGrants).set({ scope: { subtreeRootAgentId: f.ids.lead } }).where(and(
      eq(principalPermissionGrants.companyId, f.companyId), eq(principalPermissionGrants.principalId, f.userId),
      eq(principalPermissionGrants.permissionKey, "agents:configure"),
    ));
    const response = await request(f.board).put(f.installUrl).send({ installs: f.retained });
    expect(response.status, response.text).toBe(403);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id))).toEqual(before);
  }, 60_000);

  it("a root without a direct configure grant cannot assign across roots", async () => {
    const f = await fixture("unscoped");
    await db.update(agents).set({ reportsTo: null, role: "ceo" }).where(eq(agents.id, f.ids.lead));
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead),
      eq(principalPermissionGrants.permissionKey, "agents:configure")));
    expect((await f.bind(f.ids.other)).status).toBe(403);
  }, 60_000);

  it("a top-level principal with company-wide configure can install into another root's subtree", async () => {
    const f = await fixture("unscoped");
    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, f.ids.lead));
    const [outsideReport] = await db.insert(agents).values({ companyId: f.companyId, name: "Other root report",
      reportsTo: f.ids.other, adapterType: "process", status: "idle", lifecycleState: "ready" }).returning();
    const response = await f.put([...f.retained, { targetType: "agent", targetId: outsideReport.id }]);
    expect(response.status, response.text).toBe(200);
    expect(await f.installed()).toContain(outsideReport.id);
  }, 60_000);

  it.each(["structured", "exact-outside"] as const)("a root's %s configure grant cannot become company-wide", async style => {
    const f = await fixture(style);
    await db.update(agents).set({ reportsTo: null, role: "ceo" }).where(eq(agents.id, f.ids.lead));
    expect((await f.bind(f.ids.other)).status).toBe(403);
  }, 60_000);

  it("JUDGE: root CEO with unscoped configure must retain cross-root profile assignment (brief rule 4)", async () => {
    const f = await fixture("unscoped");
    await db.update(agents).set({ reportsTo: null, role: "ceo" }).where(eq(agents.id, f.ids.lead));
    const own = await f.bind(f.report);
    expect(own.status, own.text).toBe(201);
    const outside = await f.bind(f.ids.other);
    expect(outside.status, outside.text).toBe(201);
  }, 60_000);

  it("JUDGE: root CEO with unscoped configure must retain cross-root install removal (brief rule 4)", async () => {
    const f = await fixture("unscoped");
    await db.update(agents).set({ reportsTo: null, role: "ceo" }).where(eq(agents.id, f.ids.lead));
    const response = await f.put(f.retained.filter(row => row.targetId !== f.ids.other));
    expect(response.status, response.text).toBe(200);
  }, 60_000);
});
