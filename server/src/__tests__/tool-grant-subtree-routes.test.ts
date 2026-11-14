import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentApiKeys, authUsers, companies, companyMemberships, connectionGrants,
  createDb, principalPermissionGrants, toolApplications, toolConnections, toolConnectionInstalls,
  toolProfiles, toolProfileEntries, toolProfileBindings, toolCatalogEntries, toolPolicies, toolMcpGateways, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
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

  it.each(["empty", "catalog_entry", "connection", "tool_name"] as const)("repair: finish scopes a new %s capability to the hire and preserves every saved row", async selector => {
    const f = await finishFixture();
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    if (selector !== "empty") await db.insert(toolProfileEntries).values({
      companyId: f.companyId, profileId: f.profile.id, selectorType: selector, effect: "exclude",
      connectionId: selector === "tool_name" ? null : f.connection.id,
      catalogEntryId: selector === "catalog_entry" ? f.entry.id : null,
      toolName: selector === "tool_name" ? "read_mailbox" : null,
      conditions: { preserved: "exactly" },
    });
    await db.update(toolProfileBindings).set({ priority: 700, metadata: { preserved: "all columns" } })
      .where(eq(toolProfileBindings.profileId, f.profile.id));
    const savedBindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id)).orderBy(toolProfileBindings.id);
    const savedEntries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id)).orderBy(toolProfileEntries.id);
    const effective = async (agentId: string) => {
      const result = await request(f.board).get(`/api/companies/${f.companyId}/tools/profiles/effective/agents/${agentId}`);
      expect(result.status, result.text).toBe(200);
      return result.body.allowedToolNames as string[];
    };
    const outsideBefore = await effective(f.ids.other);
    expect(outsideBefore).not.toContain("read_mailbox");
    const response = await f.finish([f.ids.peer, f.report]);
    expect(response.status, response.text).toBe(200);
    expect(await effective(f.ids.other)).toEqual(outsideBefore);
    expect(await effective(f.ids.peer)).not.toContain("read_mailbox");
    expect(await effective(f.report)).toContain("read_mailbox");
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id)).orderBy(toolProfileEntries.id)).toEqual(savedEntries);
    const afterBindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id)).orderBy(toolProfileBindings.id);
    expect(afterBindings.filter(binding => binding.targetId !== f.report)).toEqual(savedBindings);
    // A replay must not reset any shared or recipient-specific binding either.
    const allBindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId)).orderBy(toolProfileBindings.id);
    const replay = await f.finish([f.ids.peer, f.report]);
    expect(replay.status, replay.text).toBe(200);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId)).orderBy(toolProfileBindings.id)).toEqual(allBindings);
    console.log("FINISH REPAIR", JSON.stringify({ selector, status: response.status, retainedBindingsExact: true, sharedEntriesExact: true, outsideBefore, outsideAfter: await effective(f.ids.other), hireAfter: await effective(f.report) }));
  }, 60_000);

  it("repair: finish grants actions to an already-bound hire without rewriting the install-created binding", async () => {
    const f = await finishFixture();
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    const installed = await request(f.api).put(f.installUrl).set("Authorization", `Bearer ${f.token}`).send({
      installs: [...f.retained, { targetType: "company", targetId: f.companyId }, { targetType: "agent", targetId: f.report }],
    });
    expect(installed.status, installed.text).toBe(200);
    const before = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id)).orderBy(toolProfileBindings.id);
    const response = await f.finish([f.report]);
    expect(response.status, response.text).toBe(200);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id)).orderBy(toolProfileBindings.id)).toEqual(before);
    const effective = await request(f.board).get(`/api/companies/${f.companyId}/tools/profiles/effective/agents/${f.report}`);
    expect(effective.status, effective.text).toBe(200);
    expect(effective.body.allowedToolNames).toContain("read_mailbox");
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id))).toEqual([]);
  }, 60_000);

  it("repair: ask-first finish writes a hire-scoped policy, not a company-wide policy", async () => {
    const f = await finishFixture();
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    const finish = () => request(f.api).post(`/api/companies/${f.companyId}/tools/apps/${f.connection.id}/finish`)
      .set("Authorization", `Bearer ${f.token}`).send({ access: { agentIds: [f.ids.peer, f.report] }, preserveExistingAccess: true,
        enabledCatalogEntryIds: [f.entry.id], askFirstCatalogEntryIds: [f.entry.id] });
    const response = await finish();
    expect(response.status, response.text).toBe(200);
    const policies = await db.select().from(toolPolicies).where(eq(toolPolicies.companyId, f.companyId));
    expect(policies).toEqual([expect.objectContaining({ enabled: true, policyType: "require_approval",
      selectors: { connectionId: f.connection.id, catalogEntryId: f.entry.id }, conditions: { actor: { agentId: f.report } } })]);
    await db.update(toolPolicies).set({ enabled: false }).where(eq(toolPolicies.id, policies[0].id));
    const replay = await finish();
    expect(replay.status, replay.text).toBe(200);
    expect((await db.select().from(toolPolicies).where(eq(toolPolicies.id, policies[0].id)))[0].enabled).toBe(true);
  }, 60_000);

  it.each(["binding", "gateway"] as const)("repair: a recipient-specific profile shared through a %s cannot be edited by finish", async sharedThrough => {
    const f = await finishFixture();
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    const profileKey = `connection-intent:${f.connection.id}:${f.report}`;
    const [shared] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey, name: profileKey,
      metadata: { source: "connection_intent", connectionId: f.connection.id, agentId: f.report } }).returning();
    if (sharedThrough === "binding") await db.insert(toolProfileBindings).values({ companyId: f.companyId, profileId: shared.id, targetType: "agent", targetId: f.ids.other });
    else await db.insert(toolMcpGateways).values({ companyId: f.companyId, profileId: shared.id, name: "Previously shared gateway", slug: `shared-${shared.id}` });
    const bindingsBefore = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId)).orderBy(toolProfileBindings.id);
    const installsBefore = await f.installed();
    const response = await f.finish([f.report]);
    expect(response.status, response.text).toBe(403);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, shared.id))).toEqual([]);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId)).orderBy(toolProfileBindings.id)).toEqual(bindingsBefore);
    expect(await f.installed()).toEqual(installsBefore);
  }, 60_000);

  it("repair: non-preserving finish cannot bypass shared-consumer authority with an unchanged company recipient", async () => {
    const f = await finishFixture();
    await db.delete(toolProfileBindings).where(and(eq(toolProfileBindings.profileId, f.profile.id), eq(toolProfileBindings.targetType, "agent")));
    await db.delete(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.connectionId, f.connection.id), eq(toolConnectionInstalls.targetType, "agent")));
    const before = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    const response = await request(f.api).post(`/api/companies/${f.companyId}/tools/apps/${f.connection.id}/finish`)
      .set("Authorization", `Bearer ${f.token}`).send({ access: "all_agents", preserveExistingAccess: false, enabledCatalogEntryIds: [f.entry.id] });
    expect(response.status, response.text).toBe(403);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id))).toEqual(before);
  }, 60_000);

  it.each([false, true])("repair: a preserving finish can still activate a hire-only draft connection (remote reconnect: %s)", async remoteReconnect => {
    const f = await finishFixture();
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.connection.id));
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    await db.insert(toolProfileBindings).values({ companyId: f.companyId, profileId: f.profile.id, targetType: "agent", targetId: f.report });
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "agent", targetId: f.report });
    const config = remoteReconnect ? { sourceTemplateKey: "zapier", connectionMethodKey: "generated-url", mcpPreserveAccess: true } : {};
    await db.update(toolConnections).set({ status: "draft", enabled: false, config, transportConfig: config }).where(eq(toolConnections.id, f.connection.id));
    const response = await f.finish([f.report]);
    expect(response.status, response.text).toBe(200);
    expect(response.body.connection).toMatchObject({ status: "active", enabled: true });
    const effective = await request(f.board).get(`/api/companies/${f.companyId}/tools/profiles/effective/agents/${f.report}`);
    expect(effective.status, effective.text).toBe(200);
    expect(effective.body.allowedToolNames).toContain("read_mailbox");
  }, 60_000);

  it.each([false, true])("repair: remote reconnect grants only the hire access without rewriting shared state (ask first: %s)", async askFirst => {
    const f = await finishFixture();
    const config = { sourceTemplateKey: "zapier", connectionMethodKey: "generated-url", mcpPreserveAccess: true };
    await db.update(toolConnections).set({ config, transportConfig: config, agentInstructions: { enabled: true, text: "Board-owned instructions" } })
      .where(eq(toolConnections.id, f.connection.id));
    await db.delete(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    await db.insert(toolProfileEntries).values({ companyId: f.companyId, profileId: f.profile.id,
      selectorType: "catalog_entry", effect: "exclude", catalogEntryId: f.entry.id });
    const snapshot = async () => ({
      connections: await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)),
      applications: await db.select().from(toolApplications).where(eq(toolApplications.id, f.connection.applicationId)),
      profiles: await db.select().from(toolProfiles).where(eq(toolProfiles.id, f.profile.id)),
      entries: await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id)).orderBy(toolProfileEntries.id),
      bindings: await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, f.companyId)).orderBy(toolProfileBindings.id),
      installs: await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.connection.id)).orderBy(toolConnectionInstalls.id),
      policies: await db.select().from(toolPolicies).where(eq(toolPolicies.companyId, f.companyId)).orderBy(toolPolicies.id),
      catalog: await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, f.connection.id)).orderBy(toolCatalogEntries.id),
    });
    const before = await snapshot();
    const finish = () => request(f.api).post(`/api/companies/${f.companyId}/tools/apps/${f.connection.id}/finish`)
      .set("Authorization", `Bearer ${f.token}`).send({ access: { agentIds: [f.report] }, preserveExistingAccess: true,
        enabledCatalogEntryIds: [f.entry.id], askFirstCatalogEntryIds: askFirst ? [f.entry.id] : [] });
    const response = await finish();
    expect(response.status, response.text).toBe(200);
    const after = await snapshot();
    expect(after).toMatchObject({ connections: before.connections, applications: before.applications,
      profiles: before.profiles, entries: before.entries, catalog: before.catalog });
    expect(after.bindings.filter(binding => binding.targetId !== f.report)).toEqual(before.bindings);
    expect(after.installs.filter(install => install.targetId !== f.report)).toEqual(before.installs);
    expect(after.bindings.filter(binding => binding.profileId === f.profile.id && binding.targetId === f.report)).toHaveLength(1);
    expect(after.installs.filter(install => install.targetId === f.report)).toHaveLength(1);
    if (askFirst) expect(after.policies).toEqual([expect.objectContaining({ enabled: true, policyType: "require_approval",
      conditions: { actor: { agentId: f.report } } })]);
    else expect(after.policies).toEqual(before.policies);
    for (const [agentId, allowed] of [[f.report, true], [f.ids.other, false]] as const) {
      const effective = await request(f.board).get(`/api/companies/${f.companyId}/tools/profiles/effective/agents/${agentId}`);
      expect(effective.status, effective.text).toBe(200);
      expect(effective.body.allowedToolNames.includes("read_mailbox")).toBe(allowed);
    }
    const replay = await finish();
    expect(replay.status, replay.text).toBe(200);
    expect(await snapshot()).toEqual(after);
  }, 60_000);

  it("repair: remote reconnect cannot activate a disabled shared profile", async () => {
    const f = await finishFixture();
    const config = { sourceTemplateKey: "zapier", connectionMethodKey: "generated-url", mcpPreserveAccess: true };
    await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, f.connection.id));
    await db.update(toolProfiles).set({ status: "disabled" }).where(eq(toolProfiles.id, f.profile.id));
    const before = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    const response = await f.finish([f.report]);
    expect(response.status, response.text).toBe(403);
    expect(await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id))).toEqual(before);
    expect((await db.select().from(toolProfiles).where(eq(toolProfiles.id, f.profile.id)))[0].status).toBe("disabled");
    expect(await f.bindings()).not.toContain(`agent:${f.report}`);
    expect(await f.installed()).not.toContain(f.report);
  }, 60_000);

  it("repair: board remote reconnect keeps its saved-access shortcut", async () => {
    const f = await finishFixture();
    const config = { sourceTemplateKey: "zapier", connectionMethodKey: "generated-url", mcpPreserveAccess: true };
    await db.update(toolConnections).set({ status: "draft", enabled: false, config, transportConfig: config }).where(eq(toolConnections.id, f.connection.id));
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.connection.id));
    const response = await request(f.board).post(`/api/companies/${f.companyId}/tools/apps/${f.connection.id}/finish`)
      .send({ access: { agentIds: [f.report] }, preserveExistingAccess: true, enabledCatalogEntryIds: [],
        agentInstructions: { enabled: true, text: "Board reconnect instructions" } });
    expect(response.status, response.text).toBe(200);
    expect(response.body.connection).toMatchObject({ status: "active", enabled: true,
      agentInstructions: { enabled: true, text: "Board reconnect instructions" } });
    const [saved] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    expect(saved.config).toEqual({ sourceTemplateKey: "zapier", connectionMethodKey: "generated-url" });
    expect(saved.transportConfig).toEqual(saved.config);
    expect(await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id))).toEqual(entries);
    expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id))).toEqual(bindings);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.connection.id))).toEqual(installs);
  }, 60_000);

  it.each([false, true])("finish preserves root/company access while enabling its own hire (already installed: %s)", async alreadyInstalled => {
    const f = await finishFixture();
    if (alreadyInstalled) {
      // The production sequence saves installs successfully before finishing app actions.
      const put = await request(f.api).put(f.installUrl).set("Authorization", `Bearer ${f.token}`).send({
        installs: [...f.retained, { targetType: "company", targetId: f.companyId }, { targetType: "agent", targetId: f.report }],
      });
      expect(put.status, put.text).toBe(200);
    }
    const before = await f.bindings();
    const response = await f.finish([f.report]);
    expect(response.status, response.text).toBe(200);
    // Install PUT may already have created the hire's binding; finish retains
    // that one row rather than creating a duplicate.
    expect(await f.bindings()).toEqual([...new Set([...before, `agent:${f.report}`])].sort());
    expect(await f.installed()).toEqual([...f.retained.map(row => row.targetId), f.companyId, f.report].sort());
    const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, f.profile.id));
    expect(entries.some(row => row.catalogEntryId === f.entry.id)).toBe(true);
    expect(entries.some(row => row.selectorType === "connection" && row.connectionId === f.connection.id)).toBe(true);
  }, 60_000);

  it("finish does not reauthorize explicitly requested recipients retained in both bindings and installs", async () => {
    const f = await finishFixture();
    const before = await f.bindings();
    const response = await f.finish([f.ids.manager, f.ids.peer, f.report]);
    expect(response.status, response.text).toBe(200);
    expect(await f.bindings()).toEqual([...before, `agent:${f.report}`].sort());
  }, 60_000);

  it("finish retains company-wide access without expanding an unchanged company recipient", async () => {
    const f = await finishFixture();
    const before = { installs: await f.installed(), bindings: await f.bindings() };
    const response = await request(f.api).post(`/api/companies/${f.companyId}/tools/apps/${f.connection.id}/finish`)
      .set("Authorization", `Bearer ${f.token}`)
      .send({ access: "all_agents", preserveExistingAccess: true, enabledCatalogEntryIds: [f.entry.id] });
    expect(response.status, response.text).toBe(200);
    expect(await f.installed()).toEqual(before.installs);
    expect(await f.bindings()).toEqual(before.bindings);
  }, 60_000);

  it.each(["unscoped", "exact-outside"] as const)("finish keeps %s grants inside the current subtree even for an already installed outside agent", async style => {
    const f = await finishFixture(style);
    const before = { installs: await f.installed(), bindings: await f.bindings() };
    // The install already exists, but this would add an outside profile binding.
    const response = await f.finish([f.ids.other]);
    expect(response.status, response.text).toBe(403);
    expect(await f.installed()).toEqual(before.installs);
    expect(await f.bindings()).toEqual(before.bindings);
  }, 60_000);

  it("finish authorizes a new app profile even when the hire is already installed", async () => {
    const f = await finishFixture();
    await db.update(toolProfiles).set({ profileKey: randomUUID() }).where(eq(toolProfiles.id, f.profile.id));
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "agent", targetId: f.report });
    const response = await f.finish([f.report]);
    expect(response.status, response.text).toBe(200);
    expect(response.body.profileBindings).toEqual([expect.objectContaining({ targetType: "agent", targetId: f.report })]);
  }, 60_000);

  it.each(["structured", "unscoped", "exact-outside"] as const)("finish checks %s authority for a new app profile's already installed outside target", async style => {
    const f = await finishFixture(style);
    await db.update(toolProfiles).set({ profileKey: randomUUID() }).where(eq(toolProfiles.id, f.profile.id));
    const before = await f.installed();
    const response = await f.finish([f.ids.other]);
    expect(response.status, response.text).toBe(403);
    expect(await f.installed()).toEqual(before);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${f.connection.id}`))).toEqual([]);
  }, 60_000);

  it("finish still refuses adding an outside agent with preserved access", async () => {
    const f = await finishFixture();
    const [outside] = await db.insert(agents).values({ companyId: f.companyId, name: "Outside finish target", adapterType: "process", status: "idle", lifecycleState: "ready" }).returning();
    const before = { installs: await f.installed(), bindings: await f.bindings() };
    const response = await f.finish([outside.id]);
    expect(response.status, response.text).toBe(403);
    expect(response.body).toMatchObject({ error: "Permission agents:configure does not cover the requested scope.", details: { reason: "deny_scope" } });
    expect(await f.installed()).toEqual(before.installs);
    expect(await f.bindings()).toEqual(before.bindings);
  }, 60_000);

  it("finish still refuses removing outside recipients when preserveExistingAccess is false", async () => {
    const f = await finishFixture();
    const before = { installs: await f.installed(), bindings: await f.bindings() };
    const response = await f.finish([f.report], false);
    expect(response.status, response.text).toBe(403);
    expect(response.body).toMatchObject({ error: "Permission agents:configure does not cover the requested scope.", details: { reason: "deny_scope" } });
    expect(await f.installed()).toEqual(before.installs);
    expect(await f.bindings()).toEqual(before.bindings);
  }, 60_000);

  for (const style of ["structured", "allow"] as const) {
    it(`${style}: installs a tool on its just-hired report without authority over retained targets`, async () => {
      const f = await fixture(style);
      const response = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
      expect(response.status, response.text).toBe(200);
      expect(await f.installed()).toEqual([...f.retained.map(row => row.targetId), f.report].sort());
      const indirect = await f.put([...f.retained, { targetType: "agent", targetId: f.report }, { targetType: "agent", targetId: f.descendant }]);
      expect(indirect.status, indirect.text).toBe(200);
      expect(await f.installed()).toContain(f.descendant);
      const removeOwn = await f.put(f.retained);
      expect(removeOwn.status, removeOwn.text).toBe(200);
      expect(await f.installed()).toEqual(f.retained.map(row => row.targetId).sort());
      const noChange = await f.put(f.retained);
      expect(noChange.status, noChange.text).toBe(200);
    }, 60_000);

    it(`${style}: binds a shared profile to direct and indirect reports, preserving outside bindings`, async () => {
      const f = await fixture(style);
      for (const id of [f.report, f.descendant]) {
        const response = await f.bind(id);
        expect(response.status, response.text).toBe(201);
      }
      const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
      expect(bindings.map(row => row.targetId).sort()).toEqual([f.ids.peer, f.report, f.descendant].sort());
    }, 60_000);
  }

  it.each(["peer", "manager", "other"] as const)("refuses adding, removing or binding an outside %s", async target => {
    const f = await fixture();
    const before = await f.installed();
    // An unchanged outside target must not require authority; removing it must.
    const remove = await f.put(f.retained.filter(row => row.targetId !== f.ids[target]));
    expect(remove.status, remove.text).toBe(403);
    expect(await f.installed()).toEqual(before);
    const binding = await f.bind(f.ids[target]);
    expect(binding.status, binding.text).toBe(403);
    // Remove through the board, then prove a forbidden addition is a true delta.
    const saved = f.retained.filter(row => row.targetId !== f.ids[target]);
    const boardRemove = await request(f.board).put(f.installUrl).send({ installs: saved });
    expect(boardRemove.status, boardRemove.text).toBe(200);
    const add = await f.put(f.retained);
    expect(add.status, add.text).toBe(403);
    expect(await f.installed()).toEqual(saved.map(row => row.targetId).sort());
  }, 60_000);

  it.each(["unscoped", "exact-outside"] as const)("%s configure cannot widen tool assignments beyond the current subtree", async style => {
    const f = await fixture(style);
    const response = await f.bind(f.ids.other);
    expect(response.status, response.text).toBe(403);
    const remove = await f.put(f.retained.filter(row => row.targetId !== f.ids.other));
    expect(remove.status, remove.text).toBe(403);
  }, 60_000);

  it("intersects strict descendants with a narrower explicit configure grant", async () => {
    const f = await fixture();
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [f.report] } }).where(and(
      eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure"),
    ));
    const direct = await f.bind(f.report);
    expect(direct.status, direct.text).toBe(201);
    const indirect = await f.bind(f.descendant);
    expect(indirect.status, indirect.text).toBe(403);
    const install = await f.put([...f.retained, { targetType: "agent", targetId: f.descendant }]);
    expect(install.status, install.text).toBe(403);
  }, 60_000);

  it("leaves shared profile/connection mutations subject to all affected consumers", async () => {
    const f = await fixture();
    const connection = await request(f.api).patch(`/api/tool-connections/${f.connection.id}`).set("Authorization", `Bearer ${f.token}`).send({ name: "Cannot change peers' connection" });
    expect(connection.status, connection.text).toBe(403);
    const profile = await request(f.api).patch(`/api/tool-profiles/${f.profile.id}`).set("Authorization", `Bearer ${f.token}`).send({ name: "Cannot change peers' profile" });
    expect(profile.status, profile.text).toBe(403);
  }, 60_000);

  it("preserves unchanged company sharing without allowing the lead to remove it", async () => {
    const f = await fixture();
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "company", targetId: f.companyId });
    const installs = [...f.retained, { targetType: "company", targetId: f.companyId }, { targetType: "agent", targetId: f.report }];
    const own = await request(f.api).put(f.installUrl).set("Authorization", `Bearer ${f.token}`).send({ installs });
    expect(own.status, own.text).toBe(200);
    const removeCompany = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
    expect(removeCompany.status, removeCompany.text).toBe(403);
    expect(await f.installed()).toContain(f.companyId);
  }, 60_000);

  it("recomputes the install delta after a concurrent board writer adds an outside recipient", async () => {
    const f = await fixture();
    const [outside] = await db.insert(agents).values({ companyId: f.companyId, name: "New outside recipient", adapterType: "process", status: "idle", lifecycleState: "ready" }).returning();
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const boardWrite = db.transaction(async tx => {
      await tx.select({ id: toolConnections.id }).from(toolConnections).where(eq(toolConnections.id, f.connection.id)).for("update");
      await tx.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: f.connection.id, targetType: "agent", targetId: outside.id });
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
      ready(Number(row!.pid));
      await gate;
    });
    let mutation: Promise<request.Response> | undefined;
    try {
      const pid = await locked;
      mutation = f.put([...f.retained, { targetType: "agent", targetId: f.report }]).then(response => response);
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and ${pid} = any(pg_blocking_pids(pid))`);
        expect(rows.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 20 });
    } finally {
      release();
      await boardWrite;
      await mutation;
    }
    const response = await mutation!;
    expect(response.status, response.text).toBe(403);
    expect(await f.installed()).toEqual([...f.retained.map(row => row.targetId), outside.id].sort());
  }, 60_000);

  it("rechecks the current tree after a report is moved; board access is unchanged", async () => {
    const f = await fixture();
    await db.update(agents).set({ reportsTo: f.ids.other }).where(eq(agents.id, f.report));
    const response = await f.bind(f.descendant);
    expect(response.status, response.text).toBe(403);
    const install = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
    expect(install.status, install.text).toBe(403);
    const boardBind = await request(f.board).post(f.bindingUrl).send({ targetType: "agent", targetId: f.descendant });
    expect(boardBind.status, boardBind.text).toBe(201);
    const boardPut = await request(f.board).put(f.installUrl).send({ installs: [{ targetType: "agent", targetId: f.ids.manager }] });
    expect(boardPut.status, boardPut.text).toBe(200);
    expect(await f.installed()).toEqual([f.ids.manager]);
  }, 60_000);

  it("unbinds only its own report without changing outside recipients", async () => {
    const f = await fixture();
    const bound = await f.bind(f.report);
    expect(bound.status, bound.text).toBe(201);
    const url = f.bindingUrl.replace(/\/bind$/, "/unbind");
    const own = await request(f.api).post(url).set("Authorization", `Bearer ${f.token}`).send({ targetType: "agent", targetId: f.report });
    expect(own.status, own.text).toBe(200);
    const outside = await request(f.api).post(url).set("Authorization", `Bearer ${f.token}`).send({ targetType: "agent", targetId: f.ids.peer });
    expect(outside.status, outside.text).toBe(403);
    const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
    expect(bindings.map(row => row.targetId)).toEqual([f.ids.peer]);
  }, 60_000);

  for (const style of ["structured", "unscoped"] as const) {
    for (const operation of ["install", "bind", "unbind"] as const) {
      it(`${style}: ${operation} waits on the company lock and revalidates an intermediate-manager reparent`, async () => {
        const f = await fixture(style);
        if (operation === "unbind") {
          const bound = await f.bind(f.descendant);
          expect(bound.status, bound.text).toBe(201);
        }
        const installsBefore = await f.installed();
        const bindingsBefore = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id));
        let release!: () => void, ready!: (pid: number) => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const locked = new Promise<number>(resolve => { ready = resolve; });
        const reparent = withAccountingTransaction(db, f.companyId, async tx => {
          await updateAgentConfigurationInTransaction(tx, f.report, { reportsTo: f.ids.other });
          const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
          ready(Number(row!.pid));
          await gate;
        });
        let mutation: Promise<request.Response> | undefined;
        try {
          const pid = await locked;
          const call = operation === "install" ? f.put([...f.retained, { targetType: "agent", targetId: f.descendant }])
            : operation === "bind" ? f.bind(f.descendant)
              : request(f.api).post(f.bindingUrl.replace(/\/bind$/, "/unbind")).set("Authorization", `Bearer ${f.token}`).send({ targetType: "agent", targetId: f.descendant });
          mutation = call.then(response => response);
          // Event-based proof of actual overlap: the writer must wait on the
          // reporting-tree mutex, not merely recheck a previously moved row.
          await vi.waitFor(async () => {
            const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
              and ${pid} = any(pg_blocking_pids(pid))`);
            expect(rows.length).toBeGreaterThan(0);
          }, { timeout: 5_000, interval: 20 });
        } finally {
          release();
          await reparent;
          await mutation;
        }
        const response = await mutation!;
        expect(response.status, response.text).toBe(403);
        expect(await f.installed()).toEqual(installsBefore);
        expect(await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, f.profile.id))).toEqual(bindingsBefore);
      }, 60_000);
    }
  }

  it("does not substitute a suggestion grant for revoked direct configure", async () => {
    const f = await fixture();
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.principalId, f.ids.lead), eq(principalPermissionGrants.permissionKey, "agents:configure")));
    const response = await f.bind(f.report);
    expect(response.status, response.text).toBe(403);
    const install = await f.put([...f.retained, { targetType: "agent", targetId: f.report }]);
    expect(install.status, install.text).toBe(403);
    // Existing self-service is independent of cross-agent configure grants.
    const self = await f.bind(f.ids.lead);
    expect(self.status, self.text).toBe(201);
  }, 60_000);
});
