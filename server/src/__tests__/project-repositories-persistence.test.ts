import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { projectRoutes } from "../routes/projects.js";
import { errorHandler } from "../middleware/index.js";
import { agents, companies, companyMemberships, companySecrets, connectionGrants, connectionGrantMembers, toolApplications, toolConnections, toolConnectionInstalls, createDb, projects as projectTable, userSecretDefinitions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { toolAccessService } from "../services/tool-access.js";
import { projectService } from "../services/projects.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const personalTokens = vi.hoisted(() => new Map<string, string>());
vi.mock("../services/secrets.js", () => ({ secretService: () => ({
  resolveSecretValue: async (_companyId: string, secretId: string) => secretId,
  resolveUserSecretValue: async (_companyId: string, input: { definitionId: string }) => ({ value: personalTokens.get(input.definitionId) }),
}) }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("project repository persistence", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  const repo = (id: string) => ({ id, fullName: `org/repo-${id}`, url: `https://github.com/org/repo-${id}`, connections: [] });
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-repositories-");
    db = createDb(temp.connectionString);
    [companyId] = (await db.insert(companies).values({ name: "Repositories", issuePrefix: "REPO" }).returning()).map((company) => company.id);
  }, 20_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(() => { vi.unstubAllGlobals(); personalTokens.clear(); });

  it("creates multiple source repos atomically and persists them across reads", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Multi" }, [repo("1"), repo("2")]);
    const fetched = await svc.getById(created.id);
    expect(fetched?.workspaces.map((workspace) => workspace.repoUrl).sort()).toEqual([repo("1").url, repo("2").url]);
    expect(fetched?.workspaces.filter((workspace) => workspace.isPrimary)).toHaveLength(1);
    expect(fetched?.workspaces.every((workspace) => workspace.companyId === companyId)).toBe(true);
  });
  it("retains and refreshes repository visibility without replacing the workspace", async () => {
    const svc = projectService(db);
    const source = { ...repo("30"), private: true };
    const created = await svc.createWithRepositories(companyId, { name: "Visibility" }, [source]);
    expect(created.workspaces[0].metadata).toMatchObject({ githubRepositoryPrivate: true, githubRepositoryUrl: source.url });
    const updated = await svc.replaceRepositories(created.id, [{ ...source, private: false }]);
    expect(updated?.workspaces[0]).toMatchObject({ id: created.workspaces[0].id, metadata: { githubRepositoryPrivate: false, githubRepositoryUrl: source.url } });
  });
  it("adds/removes repos, promotes the remaining primary, and preserves legacy and local config", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Edit" }, [repo("3"), repo("4")]);
    const legacy = await svc.createWorkspace(created.id, { repoUrl: "https://git.example/legacy/repo" });
    const local = await svc.createWorkspace(created.id, { cwd: "/tmp/local-project", repoUrl: repo("5").url, metadata: { githubRepositoryId: "5", retained: true } });
    const updated = await svc.replaceRepositories(created.id, [repo("4"), repo("6")]);
    expect(updated?.workspaces.find((workspace) => workspace.id === legacy!.id)?.repoUrl).toBe("https://git.example/legacy/repo");
    expect(updated?.workspaces.find((workspace) => workspace.id === local!.id)).toMatchObject({ cwd: "/tmp/local-project", repoUrl: null, metadata: { retained: true } });
    expect(updated?.workspaces.some((workspace) => workspace.repoUrl === repo("3").url)).toBe(false);
    expect(updated?.workspaces.filter((workspace) => workspace.isPrimary)).toHaveLength(1);
    const repeated = await svc.replaceRepositories(created.id, [repo("4"), repo("6")]);
    expect(repeated?.workspaces).toHaveLength(updated!.workspaces.length);
  });
  it("handles a repo recreated at the same URL with a new GitHub identity", async () => {
    const svc = projectService(db);
    const original = repo("20");
    const created = await svc.createWithRepositories(companyId, { name: "Recreated" }, [original]);
    const updated = await svc.replaceRepositories(created.id, [{ ...original, id: "21" }]);
    expect(updated?.workspaces).toHaveLength(1);
    expect(updated?.workspaces[0]?.metadata?.githubRepositoryId).toBe("21");
  });

  it("refreshes renamed and transferred repositories without replacing workspace identity or configuration", async () => {
    const svc = projectService(db);
    const created = await svc.createWithRepositories(companyId, { name: "Renamed" }, [repo("22")]);
    const workspace = created.workspaces[0];
    await svc.updateWorkspace(created.id, workspace.id, { cwd: "/tmp/renamed-project", repoRef: "release", metadata: { ...workspace.metadata, retained: true } });
    const renamed = { ...repo("22"), fullName: "new-owner/new-name", url: "https://github.com/new-owner/new-name" };
    const updated = await svc.replaceRepositories(created.id, [renamed]);
    expect(updated?.workspaces).toHaveLength(1);
    expect(updated?.workspaces[0]).toMatchObject({ id: workspace.id, name: renamed.fullName, repoUrl: renamed.url, cwd: "/tmp/renamed-project", repoRef: "release", isPrimary: true, metadata: { githubRepositoryId: "22", retained: true } });
    expect(updated?.codebase.repoUrl).toBe(renamed.url);
  });

  it("loads only usable connection grants, deduplicates repos, and reports partial provider failures", async () => {
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "alice", membershipRole: "admin" });
    const [otherCompany] = await db.insert(companies).values({ name: "Other", issuePrefix: "OTHER" }).returning();
    const tokenRepos = new Map<string, Array<{ id: number; full_name: string }>>();
    async function connection(name: string, kind: "user" | "organization", owner: string | null, audience: string[] = [], targetCompanyId = companyId, legacyCompanyCredential = false) {
      const [app] = await db.insert(toolApplications).values({ companyId: targetCompanyId, name, type: "mcp_http" }).returning();
      const definition = kind === "user" && !legacyCompanyCredential
        ? (await db.insert(userSecretDefinitions).values({ companyId: targetCompanyId, name, key: name }).returning())[0]
        : undefined;
      const [secret] = await db.insert(companySecrets).values({ companyId: targetCompanyId, name, key: name,
        scope: definition ? "user" : "company", ownerUserId: definition ? owner : null,
        userSecretDefinitionId: definition?.id }).returning();
      if (definition) personalTokens.set(definition.id, secret.id);
      const [conn] = await db.insert(toolConnections).values({ companyId: targetCompanyId, applicationId: app.id, name, uid: name, status: "active", enabled: true,
        transport: "mcp_remote", authKind: "api_key", credentialPolicy: kind === "user" ? "per_user" : "shared", config: { sourceTemplateKey: "github" } }).returning();
      const [grant] = await db.insert(connectionGrants).values({ companyId: targetCompanyId, connectionId: conn.id, kind, subjectUserId: owner,
        credentialSecretRefs: [{ secretId: secret.id, configPath: "credentials.authorization", versionSelector: "latest" }] }).returning();
      for (const subjectId of audience) await db.insert(connectionGrantMembers).values({ companyId: targetCompanyId, grantId: grant.id, subjectType: "user", subjectId });
      return secret.id;
    }
    const personal = await connection("personal", "user", "alice");
    const shared = await connection("shared", "organization", null);
    const otherPerson = await connection("other-person", "user", "bob");
    const restricted = await connection("restricted", "organization", null, ["bob"]);
    const crossCompany = await connection("cross-company", "organization", null, [], otherCompany.id);
    const broken = await connection("broken", "organization", null);
    const legacyPersonal = await connection("legacy-personal", "user", "alice", [], companyId, true);
    tokenRepos.set(personal, [{ id: 10, full_name: "org/common" }, { id: 11, full_name: "alice/private" }]);
    tokenRepos.set(shared, [{ id: 10, full_name: "org/common" }, { id: 12, full_name: "org/shared" }]);
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      if (token === broken) return new Response("secret-provider-error", { status: 503 });
      expect([otherPerson, restricted, crossCompany, legacyPersonal]).not.toContain(token);
      return Response.json(tokenRepos.get(token) ?? []);
    });
    vi.stubGlobal("fetch", request);
    const result = await toolAccessService(db).listProjectRepositories(companyId, "alice");
    expect(result.connectionCount).toBe(4);
    expect(result.failedConnectionCount).toBe(2);
    expect(result.repositories.map((repo) => repo.id).sort()).toEqual(["10", "11", "12"]);
    expect(result.repositories.find((repo) => repo.id === "10")?.connections.sort()).toEqual(["personal", "shared"]);
    expect(JSON.stringify(result)).not.toContain("secret-provider-error");
    expect(request).toHaveBeenCalledTimes(3);
    const savedConnections = await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId));
    const automatic = await toolAccessService(db).githubReadConnectionIds(companyId, "alice");
    expect(savedConnections.filter(connection => automatic.includes(connection.id)).map(connection => connection.name).sort()).toEqual(["broken", "personal", "shared"]);
    expect(await toolAccessService(db).githubReadConnectionIds(otherCompany.id, "alice")).toEqual([]);
    const ownConnection = savedConnections.find(connection => connection.name === "personal")!;
    expect(await toolAccessService(db).githubReadHeaders(companyId, ownConnection.id, "alice")).toEqual({ Authorization: `Bearer ${personal}` });
    for (const name of ["other-person", "restricted", "legacy-personal"]) {
      await expect(toolAccessService(db).githubReadHeaders(companyId, savedConnections.find(connection => connection.name === name)!.id, "alice")).rejects.toThrow(/authorization/);
    }
    await expect(toolAccessService(db).githubReadHeaders(otherCompany.id, ownConnection.id, "alice", true)).rejects.toThrow(/unavailable/);
    const sharedConnection = savedConnections.find(connection => connection.name === "shared")!;
    const [ownGrant, otherGrant] = await db.insert(connectionGrants).values([
      { companyId, connectionId: sharedConnection.id, kind: "user", subjectUserId: "alice", credentialSecretRefs: [{ secretId: personal, configPath: "credentials.authorization", versionSelector: "latest" }] },
      { companyId, connectionId: sharedConnection.id, kind: "user", subjectUserId: "bob", credentialSecretRefs: [{ secretId: otherPerson, configPath: "credentials.authorization", versionSelector: "latest" }] },
    ]).returning();
    const ids = await toolAccessService(db).githubReadGrantIds(companyId, sharedConnection.id, "alice");
    expect(ids).toHaveLength(2);
    expect(ids).toContain(ownGrant!.id);
    expect(ids).not.toContain(otherGrant!.id);
    expect(await toolAccessService(db).githubReadHeaders(companyId, sharedConnection.id, "alice", false, false, ownGrant!.id)).toEqual({ Authorization: `Bearer ${personal}` });
    await expect(toolAccessService(db).githubReadHeaders(companyId, sharedConnection.id, "alice", false, false, otherGrant!.id)).rejects.toThrow(/authorization/);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.connectionId, ownConnection.id));
    await expect(toolAccessService(db).githubReadHeaders(companyId, ownConnection.id, "alice")).rejects.toThrow(/authorization/);
    expect(await toolAccessService(db).githubReadConnectionIds(companyId, "alice")).not.toContain(ownConnection.id);
    const revokedMembership = await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, "alice")).returning();
    expect(revokedMembership).toHaveLength(1);
    expect(await toolAccessService(db).githubReadConnectionIds(companyId, "alice")).toEqual([]);
    expect((await toolAccessService(db).listProjectRepositories(companyId, "alice")).repositories).toEqual([]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("lists only installed App connections, keeps PAT and OAuth discovery, and attaches an agent-installed private repository", async () => {
    const [company] = await db.insert(companies).values({ name: "App repositories", issuePrefix: "APPREPO" }).returning();
    const owner = randomUUID();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: owner, membershipRole: "admin" });
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const connectionIds = new Map<string, string>();
    for (const [index, name] of ["example-org", "second-org", "pat", "oauth"].entries()) {
      const app = index < 2;
      const [application] = await db.insert(toolApplications).values({ companyId: company.id, name, type: "mcp_http" }).returning();
      const [definition] = await db.insert(userSecretDefinitions).values({ companyId: company.id, name, key: name }).returning();
      const [secret] = await db.insert(companySecrets).values({ companyId: company.id, name, key: name, scope: "user", ownerUserId: owner, userSecretDefinitionId: definition.id }).returning();
      personalTokens.set(definition.id, app ? privateKey : `${name}-token`);
      const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id,
        uid: randomUUID(), name, status: "active", enabled: true, transport: "mcp_remote", authKind: app || name === "oauth" ? "oauth" : "api_key", credentialPolicy: "per_user",
        config: { sourceTemplateKey: "github", ...(app ? { connectionMethodKey: "app-installation", methodConfig: {
          appId: "123", installationId: String(index + 1), repositories: `${name}/private`, permissionProfile: "read",
        } } : {}) } }).returning();
      await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "user", subjectUserId: owner,
        credentialSecretRefs: [{ secretId: secret.id, configPath: app ? "credentials.privateKey" : name === "oauth" ? "oauth.access_token" : "credentials.authorization", versionSelector: "latest" }] });
      connectionIds.set(name, connection.id);
    }
    await db.insert(toolConnectionInstalls).values({ companyId: company.id, connectionId: connectionIds.get("example-org")!, targetType: "company", targetId: company.id });
    const calls: Array<{ path: string; token: string }> = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
      const parsed = new URL(String(url));
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
      calls.push({ path: parsed.pathname, token });
      const installation = parsed.pathname.match(/^\/app\/installations\/([12])(\/access_tokens)?$/);
      if (installation) return Response.json(installation[2]
        ? { token: `installation-${installation[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }
        : { account: { login: installation[1] === "1" ? "example-org" : "second-org" }, repository_selection: "selected", suspended_at: null });
      if (parsed.pathname === "/user/repos") {
        if (token.startsWith("installation-")) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
        expect(["pat-token", "oauth-token"]).toContain(token);
        return Response.json([{ id: token === "pat-token" ? 30 : 40, full_name: `${token === "pat-token" ? "pat" : "oauth"}/repo`, private: false }]);
      }
      expect(parsed.pathname).toBe("/installation/repositories");
      expect(parsed.searchParams.get("per_page")).toBe("100");
      expect(["installation-1", "installation-2"]).toContain(token);
      const name = token === "installation-1" ? "example-org" : "second-org";
      return Response.json({ total_count: 1, repositories: [{ id: token === "installation-1" ? 10 : 20, full_name: `${name}/private`, private: true, owner: { type: "Organization" } }] });
    }));
    const beforeAgentInstall = await toolAccessService(db).listProjectRepositories(company.id, owner);
    expect(beforeAgentInstall.repositories.map(repository => repository.fullName)).toEqual(["example-org/private", "oauth/repo", "pat/repo"]);
    expect(beforeAgentInstall).toMatchObject({ connectionCount: 3, failedConnectionCount: 0 });
    expect(beforeAgentInstall.connections.map(connection => connection.name).sort()).toEqual(["example-org", "oauth", "pat"]);
    expect(calls.some(call => call.path.startsWith("/app/installations/2") || call.token === "installation-2")).toBe(false);
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Repository reader", adapterType: "process" }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId: company.id, connectionId: connectionIds.get("second-org")!, targetType: "agent", targetId: agent.id });
    const catalog = await toolAccessService(db).listGitHubRepositories(company.id, owner, false, { requiredRepositoryIds: ["20"] });
    expect(catalog).toMatchObject({ connectionCount: 4, failedConnectionCount: 0 });
    expect(catalog.repositories.map(repository => repository.fullName).sort()).toEqual(["example-org/private", "oauth/repo", "pat/repo", "second-org/private"]);
    expect(catalog.repositories.filter(repository => repository.private)).toHaveLength(2);
    const project = await projectService(db).create(company.id, { name: "Private attachment" });
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => { req.actor = { type: "board", userId: owner, companyIds: [company.id], source: "local_implicit", isInstanceAdmin: false }; next(); });
    api.use("/api", projectRoutes(db));
    api.use(errorHandler);
    const attached = await request(api).put(`/api/projects/${project.id}/repositories`).send({ repositoryIds: ["20"] });
    expect(attached.status, JSON.stringify(attached.body)).toBe(200);
    expect((await projectService(db).getById(project.id))?.workspaces).toEqual([expect.objectContaining({
      repoUrl: "https://github.com/second-org/private", metadata: expect.objectContaining({ githubRepositoryId: "20", githubRepositoryPrivate: true }),
    })]);
    expect(calls.filter(call => call.token.startsWith("installation-")).every(call => call.path === "/installation/repositories")).toBe(true);
    for (const token of ["pat-token", "oauth-token"]) expect(calls.filter(call => call.token === token).map(call => call.path)).toEqual(["/user/repos", "/user/repos", "/user/repos"]);
  });

  it("rolls back the project if a later repository insert fails", async () => {
    const svc = projectService(db);
    await expect(svc.createWithRepositories(companyId, { name: "Rollback" }, [repo("7"), { ...repo("8"), fullName: "invalid" + String.fromCharCode(0) + "name" }])).rejects.toThrow();
    expect(await db.select().from(projectTable).where(eq(projectTable.name, "Rollback"))).toEqual([]);
  });
});
