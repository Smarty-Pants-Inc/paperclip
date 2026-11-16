// RFL C3 (smarty-dev#20717 rollback hazard): an image WITHOUT #20717's writer
// must never treat a project-owned tool connection as company-wide. The rows
// below are written directly, exactly as #20717 writes them: migration 0493's
// nullable project_id column, and the server-written config.projectScope
// envelope mirrored into transportConfig (fl/projconn-next 916712112bc7,
// project-app-custody.ts:357 and tool-access.ts:4844/4948/4965).
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, companySecrets, connectionGrants, createDb, heartbeatRuns, issues, projects,
  toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolPolicies,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const app = vi.hoisted(() => ({
  secret: vi.fn(async () => ({ value: "fixture-private-key", latestVersion: 1 })),
  acquire: vi.fn(async (key: string) => ({ token: `app-token:${key.split(":")[1]}`, expiresAt: Date.now() + 3_600_000,
    github: { userId: "123", login: "fixture[bot]", installationCount: 1, repositoryCount: 1,
      repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] } })),
}));
vi.mock("../services/connection-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/connection-credentials.js")>(),
  resolveConnectionGrantSecret: app.secret,
}));
vi.mock("../services/github-app-client.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-app-client.js")>(),
  createGitHubAppClient: () => ({ acquire: app.acquire }),
}));
import { resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { createGitRemoteAuthProvider, resolveManagedGitHubIdentitySelection, GIT_CREDENTIAL_TOKEN_ENV_KEY } from "../services/git-credentials.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { initializeAgentHire } from "../services/agent-hiring.js";
import { isProjectOwnedToolConnection } from "../services/project-owned-connection-guard.js";

const OWNED_CODE = "project_connection_not_supported_by_this_server";
// 0493_furry_the_watchers.sql (fl/projconn-next 916712112bc7), verbatim.
const MIGRATION_0493 = [
  `ALTER TABLE "tool_connections" ADD COLUMN "project_id" uuid`,
  `CREATE UNIQUE INDEX "tool_connections_project_live_installation_uq" ON "tool_connections" USING btree ("company_id","project_id",("config" #>> '{projectScope,installationKey}')) WHERE "tool_connections"."project_id" IS NOT NULL AND "tool_connections"."status" <> 'archived' AND ("tool_connections"."config" #>> '{projectScope,installationKey}') IS NOT NULL`,
];

describe("project-owned tool connections on an image without the #20717 writer (RFL C3)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-projconn-reader-");
    db = createDb(database.connectionString);
    // Harness only (merged #20717 tree): the schema already applies 0493, so
    // replay it verbatim only where the column is still missing.
    const [{ present }] = await db.execute(sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tool_connections' AND column_name = 'project_id') AS present`) as unknown as Array<{ present: boolean }>;
    if (!present) for (const statement of MIGRATION_0493) await db.execute(sql.raw(statement));
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), projectA = randomUUID(), projectB = randomUUID();
    const lead = randomUUID(), other = randomUUID(), loose = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "C3", issuePrefix: companyId.slice(0, 8) });
    await db.insert(projects).values([{ id: projectA, companyId, name: "Project A", status: "active" },
      { id: projectB, companyId, name: "Project B", status: "active" }]);
    await db.insert(agents).values([lead, other, loose].map((id, index) => ({ id, companyId, name: `Agent ${index}`, role: "engineer", adapterType: "codex_local" })));
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "owner", status: "active", membershipRole: "owner" });
    // The other agent works a task in project B; the loose agent has no project.
    const issueB = randomUUID(), runB = randomUUID();
    await db.insert(issues).values({ id: issueB, companyId, projectId: projectB, title: "B work", assigneeAgentId: other });
    await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId: other, status: "running", contextSnapshot: { issueId: issueB, projectId: projectB } });
    return { companyId, projectA, projectB, lead, other, loose, issueB, runB };
  }

  async function seedApp(f: Awaited<ReturnType<typeof seed>>, owned: boolean) {
    const applicationId = randomUUID(), connectionId = randomUUID(), secretId = randomUUID(), grantId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId: f.companyId, name: `GitHub ${connectionId}`, applicationKey: `github-${connectionId}`, type: "rest_api" });
    await db.insert(companySecrets).values({ id: secretId, companyId: f.companyId, key: secretId, name: `App key ${secretId}`, scope: "company" });
    const config: Record<string, unknown> = { sourceTemplateKey: "github", connectionMethodKey: "app-installation",
      methodConfig: { appId: "1", installationId: "456", repositories: "owner/repo", permissionProfile: "read" } };
    if (owned) config.projectScope = { version: 1, installationKey: "github.com/github-app-installation/456", registrationId: "1",
      exclusive: false, approvedLeadAgentId: f.lead, approvedByAgentId: f.lead, responsibleUserId: "owner",
      approvedRepositoryIds: [42], approvedSecretRefs: [{ secretId, configPath: "credentials.privateKey" }] };
    await db.insert(toolConnections).values({ id: connectionId, companyId: f.companyId, applicationId, name: owned ? "Project A App" : "Company App",
      uid: connectionId, transport: "rest_api", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared",
      credentialSource: "paperclip_vault", config, transportConfig: config,
      credentialSecretRefs: [{ secretId, configPath: "credentials.privateKey", versionSelector: "latest" }] });
    if (owned) await db.execute(sql`UPDATE tool_connections SET project_id = ${f.projectA} WHERE id = ${connectionId}`);
    await db.insert(connectionGrants).values({ id: grantId, companyId: f.companyId, connectionId, kind: "organization", isDefault: true, status: "active",
      credentialSecretRefs: [{ secretId, configPath: "credentials.privateKey", versionSelector: "latest" }],
      providerTenant: { github: { userId: owned ? "app-owned" : "app-company", login: "app[bot]", installationCount: 1, repositoryCount: 1,
        repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] } } });
    // #20717 installs an owned App for named agents only; a company install is
    // the widest reach this image could misread.
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId, targetType: "company", targetId: f.companyId });
    const [entry] = await db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId, connectionId, name: "List repos",
      toolName: "list_repos", versionHash: "fixture" }).returning();
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    return { connection: connection!, grant: grant!, entry: entry! };
  }

  it("seeds the rows the way #20717 does (project_id set and config.projectScope present)", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    const [row] = await db.execute(sql`SELECT project_id, config ? 'projectScope' AS scoped FROM tool_connections WHERE id = ${owned.connection.id}`);
    expect(row).toMatchObject({ project_id: f.projectA, scoped: true });
  });

  it("(1) never mints the project-owned App token for an agent in another project or with no project; a company App still works", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    const company = await seedApp(f, false);
    app.secret.mockClear();
    app.acquire.mockClear();
    for (const agentId of [f.other, f.loose, f.lead, null]) {
      await expect(resolveGitHubAppCredential(db, owned.connection, owned.grant, false, false, agentId))
        .rejects.toMatchObject({ details: { code: OWNED_CODE } });
    }
    expect(app.secret).not.toHaveBeenCalled();
    expect(app.acquire).not.toHaveBeenCalled();
    await expect(resolveGitHubAppCredential(db, company.connection, company.grant, false, false, f.other))
      .resolves.toMatchObject({ token: `app-token:${company.connection.id}` });
  });

  it("(1) a run's Git identity never falls through to the project-owned App", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    for (const agentId of [f.other, f.loose]) {
      expect(await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId })).toEqual({ configured: false });
      const provider = createGitRemoteAuthProvider(db, f.companyId, { agentId },
        { secrets: { getByName: vi.fn(async () => null), resolveSecretValue: vi.fn(async () => "") }, env: {} });
      await expect(provider("https://github.com/owner/repo.git")).resolves.toBeNull();
    }
    const company = await seedApp(f, false);
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId: f.other });
    expect(selected.grant?.id).toBe(company.grant.id);
    expect(selected.grant?.id).not.toBe(owned.grant.id);
    const provider = createGitRemoteAuthProvider(db, f.companyId, { agentId: f.other },
      { secrets: { getByName: vi.fn(async () => null), resolveSecretValue: vi.fn(async () => "") }, env: {} });
    expect((await provider("https://github.com/owner/repo.git"))?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe(`app-token:${company.connection.id}`);
  });

  it("(1) a tool call on the project-owned connection is denied by name; a company connection is not", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    const company = await seedApp(f, false);
    // A company-wide allow policy (no connection selector) is exactly the
    // company-default reach a project-owned row must never inherit.
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Company allow", policyType: "allow", selectors: {}, priority: 0 });
    const policy = toolAccessPolicyService(db);
    for (const [agentId, run] of [[f.other, { heartbeatRunId: f.runB, issueId: f.issueB, projectId: f.projectB }], [f.loose, {}]] as const) {
      const denied = await policy.decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: agentId, agentId }, runContext: run,
        request: { connectionId: owned.connection.id, catalogEntryId: owned.entry.id, toolName: "list_repos", arguments: {} } });
      expect(denied).toMatchObject({ allowed: false, reasonCode: "deny_project_owned_connection" });
      const ordinary = await policy.decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: agentId, agentId },
        request: { connectionId: company.connection.id, catalogEntryId: company.entry.id, toolName: "list_repos", arguments: {} } });
      expect(ordinary).toMatchObject({ allowed: true });
    }
  });

  it("(2) discovery and an agent's installed-connection list exclude it; the company connection stays listed", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    const company = await seedApp(f, false);
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "projconn-reader-fixture" });
    const tools = async (connectionId: string) => (await gateway.summarizeConnectionAccessForAgent({ companyId: f.companyId, connectionId, agentId: f.other })).tools;
    expect(await tools(owned.connection.id)).toEqual([]);
    expect((await tools(company.connection.id)).map(tool => tool.toolName)).toEqual(["list_repos"]);
    const installed = (await toolAccessService(db).getEffectiveProfilesForAgent(f.companyId, f.other)).installedConnections.map(c => c.id);
    expect(installed).toContain(company.connection.id);
    expect(installed).not.toContain(owned.connection.id);
  });

  it("(2) this image cannot grant it: installs and hire-time installs are refused by name", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    await expect(toolAccessService(db).putConnectionInstalls(owned.connection.id, { installs: [{ targetType: "agent", targetId: f.other }] }))
      .rejects.toMatchObject({ details: { code: OWNED_CODE } });
    const [hired] = await db.insert(agents).values({ companyId: f.companyId, name: "Hire", role: "engineer", adapterType: "codex_local", status: "idle" }).returning();
    await expect(db.transaction(tx => initializeAgentHire(tx as never, hired as never, { setupOnly: true,
      aiConnectionInstall: { connectionId: owned.connection.id, createdByUserId: "owner" } } as never)))
      .rejects.toMatchObject({ details: { code: OWNED_CODE } });
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, owned.connection.id));
    expect(installs.map(install => install.targetType)).toEqual(["company"]);
  });

  it("J4 board reconnect (connectGalleryApp reconnectConnectionId) on THIS image rewrites a project-owned row's config without projectScope", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    const methodConfig = { version: "1", appId: "1", installationId: "456", repositories: "owner/repo", permissionProfile: "read" };
    const cfg = { ...(owned.connection.config as Record<string, unknown>), methodConfig };
    await db.update(toolConnections).set({ config: cfg, transportConfig: cfg, transport: "mcp_remote" }).where(eq(toolConnections.id, owned.connection.id));
    await db.update(toolApplications).set({ type: "mcp_http" }).where(eq(toolApplications.id, owned.connection.applicationId));
    console.log("J4 before owned?", isProjectOwnedToolConnection((await db.select().from(toolConnections).where(eq(toolConnections.id, owned.connection.id)))[0]));
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      console.log("J4 fetch", String(url)); if (String(url).startsWith("https://api.githubcopilot.com/")) {
        const rpc = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "list_issues", description: "x", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] } });
      }
      return Response.json({}, { status: 404 });
    });
    const svc = toolAccessService(db, { remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }], remoteHttpRequest: async (url: string, init: RequestInit) => fetch(url, init) } as never);
    let err: unknown = null;
    let wizard: { catalog: Array<{ id: string }> } | null = null;
    try {
      wizard = await svc.connectGalleryApp(f.companyId, { galleryKey: "github", connectionMethodKey: "app-installation",
        reconnectConnectionId: owned.connection.id, grantKind: "organization", configValues: methodConfig, credentialValues: {} } as never,
        { actorType: "user", actorId: "owner" } as never);
    } catch (e) { err = e; }
    console.log("J4 connectGalleryApp error:", err ? String((err as Error).message).slice(0, 200) + " " + JSON.stringify((err as { details?: unknown }).details ?? null).slice(0, 200) : "none");
    const [after] = await db.execute(sql`SELECT project_id, status, enabled, config ? 'projectScope' AS c_scope, transport_config ? 'projectScope' AS t_scope FROM tool_connections WHERE id = ${owned.connection.id}`);
    console.log("J4 after connect", JSON.stringify(after));
    if (wizard) {
      try {
        await svc.finishGalleryAppConnection(f.companyId, owned.connection.id, { enabledCatalogEntryIds: wizard.catalog.map(e => e.id),
          askFirstCatalogEntryIds: [], access: { agentIds: [f.other, f.loose] } } as never, { actorType: "user", actorId: "owner" } as never);
        console.log("J4 finish ok");
      } catch (e) { console.log("J4 finish error", String((e as Error).message).slice(0, 200), JSON.stringify((e as { details?: unknown }).details ?? null).slice(0, 200)); }
      const [fin] = await db.execute(sql`SELECT project_id, status, enabled, config ? 'projectScope' AS c_scope, transport_config ? 'projectScope' AS t_scope FROM tool_connections WHERE id = ${owned.connection.id}`);
      console.log("J4 after finish", JSON.stringify(fin));
      const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, owned.connection.id));
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, owned.connection.id));
      try { const t = await resolveGitHubAppCredential(db, row!, grant!, false, false, f.other); console.log("J4 token minted for agent in project B:", t.token); }
      catch (e) { console.log("J4 mint error", String((e as Error).message).slice(0, 150)); }
      const sel = await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId: f.loose });
      console.log("J4 loose-agent git identity grant is owned row's:", sel.grant?.connectionId === owned.connection.id);
    }
    spy.mockRestore();
    // Contract: this image must never strip the envelope from a project-owned row.
    expect(after).toMatchObject({ c_scope: true, t_scope: true });
  });

  it("refuses project-owned setup resume, reconnect, replacement key and finish before writes or credential use", async () => {
    const f = await seed();
    const owned = await seedApp(f, true);
    const svc = toolAccessService(db);
    const actor = { actorType: "user", actorId: "owner" } as const;
    app.secret.mockClear();
    app.acquire.mockClear();
    const refused = { status: 403, details: { code: OWNED_CODE, connectionId: owned.connection.id } };
    await expect(svc.connectGalleryApp(f.companyId, {
      galleryKey: "github", connectionMethodKey: "app-installation",
      reconnectConnectionId: owned.connection.id, credentialValues: {},
    } as never, actor)).rejects.toMatchObject(refused);
    await expect(svc.reconnectGalleryApp(owned.connection.id, f.companyId, {
      credentialValues: { "credentials.privateKey": "replacement-fixture-private-key" },
    }, actor)).rejects.toMatchObject(refused);
    await expect(svc.finishGalleryAppConnection(f.companyId, owned.connection.id, {
      enabledCatalogEntryIds: [owned.entry.id], askFirstCatalogEntryIds: [],
      access: { agentIds: [f.other, f.loose] },
    }, actor)).rejects.toMatchObject(refused);
    await db.update(toolConnections).set({ status: "draft" }).where(eq(toolConnections.id, owned.connection.id));
    const [draft] = await db.select().from(toolConnections).where(eq(toolConnections.id, owned.connection.id));
    await expect(svc.connectGalleryApp(f.companyId, {
      galleryKey: "github", connectionMethodKey: "app-installation",
      resumeConnectionId: owned.connection.id, credentialValues: {},
    } as never, actor)).rejects.toMatchObject(refused);
    const [after] = await db.select().from(toolConnections).where(eq(toolConnections.id, owned.connection.id));
    expect(after).toEqual(draft);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, owned.grant.id));
    expect(grant).toEqual(owned.grant);
    expect(app.secret).not.toHaveBeenCalled();
    expect(app.acquire).not.toHaveBeenCalled();
  });

  it("detects ownership from the envelope alone, in either config, whatever its value (no schema read)", () => {
    expect(isProjectOwnedToolConnection({ config: { projectScope: { version: 1 } }, transportConfig: {} })).toBe(true);
    expect(isProjectOwnedToolConnection({ config: {}, transportConfig: { projectScope: { version: 1 } } })).toBe(true);
    expect(isProjectOwnedToolConnection({ config: { projectScope: null }, transportConfig: {} })).toBe(true);
    expect(isProjectOwnedToolConnection({ config: { sourceTemplateKey: "github" }, transportConfig: { sourceTemplateKey: "github" } })).toBe(false);
    expect(isProjectOwnedToolConnection(null)).toBe(false);
  });
});
