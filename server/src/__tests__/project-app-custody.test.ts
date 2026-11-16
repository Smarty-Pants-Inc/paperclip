import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, companies, companyMemberships, companySecrets, connectionGrants, createDb, pluginConfig, plugins, projects, toolConnections } from "@paperclipai/db";

// Only the provider HTTP boundary is replaced. Admission, vault, transactions,
// custody, JWT signing and all production writers/readers remain real.
const provider = vi.hoisted(() => {
  const state = { now: Date.now(), appId: 123, suspended: false, repoId: 101, unavailable: false, token: "custody-http-installation-token", requests: [] as string[] };
  vi.spyOn(Date, "now").mockImplementation(() => state.now);
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    state.requests.push(url.pathname);
    if (state.unavailable) return Response.json({ message: "provider unavailable" }, { status: 503 });
    if (url.pathname === "/app") return Response.json({ id: state.appId, client_id: "Iv1projectclient", slug: "custody-fixture" });
    if (/^\/app\/installations\/\d+$/.test(url.pathname)) return Response.json({ id: Number(url.pathname.split("/").at(-1)), app_id: state.appId,
      suspended_at: state.suspended ? "2026-11-16T00:00:00Z" : null, account: { login: "owner" }, permissions: { contents: "write", pull_requests: "write", issues: "read" } });
    if (url.pathname.endsWith("/access_tokens")) {
      const scope = JSON.parse(String(init?.body));
      expect(scope.repositories).toEqual(["a"]);
      return Response.json({ token: state.token, expires_at: new Date(state.now + 3600_000).toISOString() });
    }
    if (url.pathname.startsWith("/users/")) return Response.json({ id: 321, login: "custody-fixture[bot]", type: "Bot" });
    if (url.pathname === "/installation/repositories") return Response.json({ repositories: [{ id: state.repoId, full_name: "owner/a", private: true }] });
    throw new Error(`Unexpected provider HTTP path: ${url.pathname}`);
  });
  vi.stubGlobal("fetch", http);
  return { state, http };
});
import { toolAccessRoutes } from "../routes/tool-access.js";
import { pluginRoutes } from "../routes/plugins.js";
import { errorHandler } from "../middleware/index.js";
import { secretService } from "../services/secrets.js";
import { assertProjectConnectionAdmission } from "../services/project-connection-admission.js";
import { resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { resolveManagedGitHubCredential } from "../services/git-credentials.js";
import { projectConnectionFixture, storedConnection } from "./helpers/project-connections-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Fixture = Awaited<ReturnType<typeof projectConnectionFixture>>;
const managerPluginId = randomUUID();
const managerPluginKey = "paperclipai.plugin-row12-installer";
const approvalField = "projectAppApproval";

describe("judged option-B project App custody CB01-CB08 + E1-E4", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let privateKey: string;
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-custody-b-");
    db = createDb(database.connectionString);
    privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await db.insert(plugins).values({ id: managerPluginId, pluginKey: managerPluginKey, packageName: "@paperclipai/plugin-row12-installer", version: "0.1.0", status: "ready",
      manifestJson: { id: managerPluginKey, capabilities: ["projects.instance-secrets"], instanceSecretKeys: ["manager_private_key"] } as never });
  }, 90_000);
  beforeEach(() => {
    provider.state.appId = 123; provider.state.repoId = 101; provider.state.suspended = false; provider.state.unavailable = false;
    provider.state.requests.length = 0; provider.http.mockClear();
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); }, 60_000);

  async function fixture() {
    const f = await projectConnectionFixture(db);
    await secretService(db).rotate(f.secret.id, { value: privateKey });
    const [anchor] = await db.insert(projects).values({ companyId: f.companyId, name: "github-manager-key" }).returning();
    const [managerKey] = await db.insert(companySecrets).values({ companyId: f.companyId, key: "manager_private_key", name: "Manager PEM anchor", scope: "instance", ownerPluginId: managerPluginId, ownerProjectId: anchor!.id }).returning();
    await db.insert(pluginConfig).values({ pluginId: managerPluginId, companyId: f.companyId, configJson: { managerAppId: "999", managerKeyAnchorProjectId: anchor!.id } });
    const source = await f.seedConnection(null, { status: "draft", installed: false });
    return { ...f, source, anchor: anchor!, managerKey: managerKey! };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  function app(f: Fixture, overrides: Record<string, unknown> = {}, withPlugins = false) {
    const a = express(); a.use(express.json());
    a.use((req, _res, next) => { req.actor = { type: "board", source: "session", sessionId: "custody-session", userId: f.human, isInstanceAdmin: true,
      companyIds: [f.companyId], memberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }], ...overrides } as typeof req.actor; next(); });
    a.use("/api", toolAccessRoutes(db));
    if (withPlugins) a.use("/api", pluginRoutes(db, {} as never));
    a.use(errorHandler); return a;
  }
  const path = (f: F) => `/api/companies/${f.companyId}/tools/connections/${f.source.connection.id}/project-app-approval`;
  const approve = (f: F, overrides: Record<string, unknown> = {}) => request(app(f, overrides)).post(path(f)).set("Origin", "http://127.0.0.1").send({ action: "approve", projectId: f.a.id });
  const revoke = (f: F) => request(app(f)).post(path(f)).set("Origin", "http://127.0.0.1").send({ action: "revoke", projectId: f.a.id });
  const events = (f: F) => db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_app_approved")));
  function receipt(f: F, overrides: Record<string, unknown> = {}) {
    return { version: 1, id: randomUUID(), companyId: f.companyId, humanUserId: f.human, projectId: f.a.id, appId: "123", installationId: "456", repositoryIds: [101],
      secretRef: { secretId: f.secret.id, configPath: "credentials.privateKey" }, verifiedAt: new Date(provider.state.now).toISOString(), revokedAt: null, ...overrides };
  }
  async function seedReceipt(f: F, overrides: Record<string, unknown> = {}) {
    const config = { ...f.source.connection.config, [approvalField]: receipt(f, overrides) };
    await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, f.source.connection.id));
  }
  async function seedOwned(f: F, receiptOverrides: Record<string, unknown> = {}) {
    await seedReceipt(f, receiptOverrides);
    const owned = await f.seedConnection();
    const config = { ...owned.connection.config, projectAppApprovalSourceId: f.source.connection.id };
    const [connection] = await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, owned.connection.id)).returning();
    return { connection: connection!, grant: owned.grant };
  }
  const admission = (f: F, connection: typeof toolConnections.$inferSelect) => assertProjectConnectionAdmission(db, {
    companyId: f.companyId, projectId: f.a.id, connection, operation: "finish", actor: f.actor(f.leadA.id), targetAgentIds: [f.leadA.id],
  });
  const release = (f: F, c: Awaited<ReturnType<typeof seedOwned>>) => resolveGitHubAppCredential(db, c.connection, c.grant, false, false, f.leadA.id);

  it.each(["board-key", "agent", "plugin-tool"])("CB01: %s cannot approve; H's board session is the control", async kind => {
    const f = await fixture();
    const actor = kind === "board-key" ? { source: "api_key" } : { type: "agent", source: kind === "agent" ? "agent_key" : "plugin", agentId: f.primary.id, companyId: f.companyId };
    const refused = await approve(f, actor);
    expect(refused.status).toBe(403);
    expect(refused.body.details?.code ?? refused.body.code).toBe("project_app_board_session_required");
    expect((await storedConnection(db, f.source.connection.id)).config[approvalField]).toBeUndefined();
    expect(await events(f)).toHaveLength(0);
    expect((await approve(f)).status).toBe(200);
  });
  it.each(["missing", "foreign"])("CB01: %s browser origin is refused", async kind => {
    const f = await fixture(); let req = request(app(f)).post(path(f));
    if (kind === "foreign") req = req.set("Origin", "https://attacker.invalid");
    const response = await req.send({ action: "approve", projectId: f.a.id });
    expect(response.status).toBe(403);
    expect((await storedConnection(db, f.source.connection.id)).config[approvalField]).toBeUndefined();
  });
  it.each(["config", "transportConfig"])("CB01: generic create/import/plugin writer cannot mint %s receipt", async key => {
    const f = await fixture(); const input = f.input(); input.projectId = null;
    await expect(f.service.createConnection(f.companyId, { ...input, [key]: { ...input.config, [approvalField]: receipt(f) } }, f.actor())).rejects.toMatchObject({ status: 403, details: { code: "project_app_receipt_protected" } });
    expect(await events(f)).toHaveLength(0);
  });
  it("CB01: generic PATCH cannot mint, erase or replace the protected receipt", async () => {
    const f = await fixture();
    await expect(f.service.updateConnection(f.source.connection.id, { config: { ...f.source.connection.config, [approvalField]: receipt(f) } })).rejects.toMatchObject({ status: 403, details: { code: "project_app_receipt_protected" } });
    expect(await events(f)).toHaveLength(0);
  });
  it("CB02: another current owner/admin is not H and cannot approve", async () => {
    const f = await fixture(); const other = `other-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: other, status: "active", membershipRole: "owner" });
    const response = await approve(f, { userId: other });
    expect(response.status).toBe(403);
    expect(response.body.details?.code ?? response.body.code).toBe("project_app_approver_not_responsible_human");
    expect(await events(f)).toHaveLength(0);
  });
  it.each([
    { appId: "124" }, { installationId: "457" }, { repositoryIds: [202] }, { secretRef: { secretId: "11111111-1111-4111-8111-111111111111", configPath: "credentials.privateKey" } },
    { projectId: "11111111-1111-4111-8111-111111111111" }, { companyId: "11111111-1111-4111-8111-111111111111" },
  ])("CB03: receipt tuple mismatch %j cannot admit the unchanged valid project scope", async mismatch => {
    const f = await fixture(); const c = await seedOwned(f, mismatch);
    await expect(admission(f, c.connection)).rejects.toMatchObject({ details: { code: "project_app_approval_required" } });
  });
  it.each(["suspended", "repo-removed"])("CB04: provider %s after approval refuses the next fresh release", async change => {
    const f = await fixture(); const c = await seedOwned(f);
    expect((await release(f, c)).token).toBe(provider.state.token);
    provider.state.now += 60_001;
    if (change === "suspended") provider.state.suspended = true; else provider.state.repoId = 202;
    await expect(release(f, c)).rejects.toThrow();
  });
  it("CB05: revoked receipt refuses admission and release including an actual cache hit and a new service instance", async () => {
    const f = await fixture(); const c = await seedOwned(f);
    expect((await release(f, c)).token).toBe(provider.state.token);
    const requests = provider.state.requests.length;
    expect((await release(f, c)).token).toBe(provider.state.token);
    expect(provider.state.requests).toHaveLength(requests);
    expect((await revoke(f)).status).toBe(200);
    await expect(admission(f, c.connection)).rejects.toMatchObject({ details: { code: "project_app_approval_required" } });
    await expect(release(f, c)).rejects.toThrow();
    const restarted = createDb(database.connectionString);
    try { await expect(resolveGitHubAppCredential(restarted, c.connection, c.grant, false, false, f.leadA.id)).rejects.toThrow(); }
    finally { await restarted.$client.end({ timeout: 1 }); }
  });
  it.each(["ref", "numeric", "client-alias", "missing-config", "malformed-config"])("CB06: manager %s is excluded before approval or project create", async mode => {
    const f = await fixture(); const input = f.input();
    if (mode === "ref") input.credentialSecretRefs = [{ secretId: f.managerKey.id, configPath: "credentials.privateKey" }];
    if (mode === "numeric") input.config = { ...input.config, methodConfig: { ...f.config().methodConfig, appId: "999" } };
    if (mode === "client-alias") { input.config = { ...input.config, methodConfig: { ...f.config().methodConfig, appId: "Iv1projectclient" } }; provider.state.appId = 999; }
    if (mode === "missing-config") await db.delete(pluginConfig).where(eq(pluginConfig.companyId, f.companyId));
    if (mode === "malformed-config") await db.update(pluginConfig).set({ configJson: { managerAppId: "oops", managerKeyAnchorProjectId: f.anchor.id } }).where(eq(pluginConfig.companyId, f.companyId));
    await expect(f.service.createConnection(f.companyId, input, f.actor())).rejects.toMatchObject({ details: { code: mode.includes("config") ? "project_app_manager_classification_unavailable" : "project_app_manager_forbidden" } });
  });
  it.each(["numeric", "client-alias", "missing-config"])("CB06: manager %s cannot escape by direct credential release (git/gh/MCP owner)", async mode => {
    const f = await fixture(); const c = await seedOwned(f);
    if (mode === "missing-config") await db.delete(pluginConfig).where(eq(pluginConfig.companyId, f.companyId));
    else {
      provider.state.appId = 999;
      const config = { ...c.connection.config, methodConfig: { ...f.config().methodConfig, appId: mode === "numeric" ? "999" : "Iv1projectclient" }, projectScope: { ...f.scope(), registrationId: "999" } };
      [c.connection] = await db.update(toolConnections).set({ config }).where(eq(toolConnections.id, c.connection.id)).returning() as [typeof c.connection];
      await seedReceipt(f, { appId: "999" });
    }
    await expect(release(f, c)).rejects.toMatchObject({ details: { code: mode === "missing-config" ? "project_app_manager_classification_unavailable" : "project_app_manager_forbidden" } });
  });
  it("CB06/E4: native config writer refuses board-KEY managerAppId changes, session control works", async () => {
    const f = await fixture(); const url = `/api/plugins/${managerPluginId}/config`;
    const configJson = { managerAppId: "998", managerKeyAnchorProjectId: f.anchor.id };
    const key = await request(app(f, { source: "api_key" }, true)).post(url).send({ companyId: f.companyId, configJson });
    expect(key.status).toBe(403);
    expect((await db.select().from(pluginConfig).where(eq(pluginConfig.companyId, f.companyId)))[0]!.configJson.managerAppId).toBe("999");
    const session = await request(app(f, {}, true)).post(url).send({ companyId: f.companyId, configJson });
    expect(session.status).toBe(200);
  });
  it("CB07/E3: activity insert failure rolls back the approval and both rows contain IDs only", async () => {
    const f = await fixture();
    await db.execute(sql.raw(`CREATE FUNCTION custody_activity_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${f.companyId}' AND NEW.action = 'tool_connection.project_app_approved' THEN RAISE EXCEPTION 'custody activity fault'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER custody_activity_fault BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION custody_activity_fault()"));
    try { expect((await approve(f)).status).toBe(500); }
    finally { await db.execute(sql.raw("DROP TRIGGER custody_activity_fault ON activity_log")); await db.execute(sql.raw("DROP FUNCTION custody_activity_fault()")); }
    expect((await storedConnection(db, f.source.connection.id)).config[approvalField]).toBeUndefined();
    expect(await events(f)).toHaveLength(0);
    expect((await approve(f)).status).toBe(200);
    const rows = { receipt: (await storedConnection(db, f.source.connection.id)).config[approvalField], activity: await events(f) };
    expect(rows.activity).toHaveLength(1);
    expect(rows.receipt).toMatchObject({ humanUserId: f.human, appId: "123", projectId: f.a.id, repositoryIds: [101] });
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(privateKey); expect(serialized).not.toContain(provider.state.token); expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("Authorization");
  });
  it("CB07: replayed approval is idempotent, with one durable receipt and one activity", async () => {
    const f = await fixture(); const first = await approve(f); expect(first.status).toBe(200);
    const saved = (await storedConnection(db, f.source.connection.id)).config[approvalField];
    const replay = await approve(f); expect(replay.status).toBe(200);
    expect((await storedConnection(db, f.source.connection.id)).config[approvalField]).toEqual(saved);
    expect(await events(f)).toHaveLength(1);
  });
  it("E1: changing companies.defaultResponsibleUserId refuses old-H admission and cached release", async () => {
    const f = await fixture(); const c = await seedOwned(f);
    expect((await release(f, c)).token).toBe(provider.state.token);
    await db.update(companies).set({ defaultResponsibleUserId: "replacement-H" }).where(eq(companies.id, f.companyId));
    await expect(admission(f, c.connection)).rejects.toThrow();
    await expect(release(f, c)).rejects.toMatchObject({ details: { code: "project_app_approval_required" } });
  });
  it("E1: H changes during provider approval; no stale-H receipt or activity can commit", async () => {
    const f = await fixture(); const original = provider.http.getMockImplementation()!; let changed = false;
    provider.http.mockImplementation(async (...args) => { if (!changed) { changed = true; await db.update(companies).set({ defaultResponsibleUserId: "replacement-H" }).where(eq(companies.id, f.companyId)); } return original(...args); });
    try { expect((await approve(f)).status).toBe(403); }
    finally { provider.http.mockImplementation(original); }
    expect((await storedConnection(db, f.source.connection.id)).config[approvalField]).toBeUndefined();
    expect(await events(f)).toHaveLength(0);
  });
  it("E2: a release verdict is cached for at most 60 seconds, not the ordinary 5-minute token cache", async () => {
    const f = await fixture(); const c = await seedOwned(f);
    expect((await release(f, c)).token).toBe(provider.state.token); const first = provider.state.requests.length;
    provider.state.now += 59_999; expect((await release(f, c)).token).toBe(provider.state.token); expect(provider.state.requests).toHaveLength(first);
    provider.state.now += 2; expect((await release(f, c)).token).toBe(provider.state.token); expect(provider.state.requests.length).toBeGreaterThan(first);
  });
  it("E2: provider failure at release fails closed with project_app_verification_unavailable, never silent 403", async () => {
    const f = await fixture(); const c = await seedOwned(f); provider.state.unavailable = true;
    await expect(release(f, c)).rejects.toMatchObject({ status: 503, details: { code: "project_app_verification_unavailable" } });
  });
  it("CB08/J03/J19/INT-A2/A3 positive: H approves, primary first-binds, lead finishes and recipient git/gh receives only the project token", async () => {
    const f = await fixture(); expect((await approve(f)).status).toBe(200);
    const connection = await f.service.createConnection(f.companyId, f.input(), f.actor());
    expect(connection.projectId).toBe(f.a.id);
    await f.service.finishGalleryAppConnection(f.companyId, connection.id, { access: { agentIds: [f.leadA.id] }, enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] }, f.actor(f.leadA.id));
    const { issue, run } = await f.run(f.a, f.leadA.id);
    const credential = await resolveManagedGitHubCredential(db, secretService(db), f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human, issueId: issue.id, heartbeatRunId: run.id });
    expect(credential.credential?.token).toBe(provider.state.token);
    expect(credential.credential?.connectionId).toBe(connection.id);
    expect(JSON.stringify(credential)).not.toContain(privateKey);
  });
});
