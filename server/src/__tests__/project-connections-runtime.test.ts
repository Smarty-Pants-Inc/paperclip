import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { connectionGrants, createDb, heartbeatRuns, issues, projects, userCompanyPreferences, toolCatalogEntries, toolPolicies, toolGatewaySessions, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture as seedProjectConnectionFixture } from "./helpers/project-connections-fixture.js";

const provider = vi.hoisted(() => ({ acquire: vi.fn(async (_db: unknown, connection: { id: string }) => ({
  token: `synthetic-installation-token-${connection.id}`, expiresAt: Date.now() + 3_600_000,
  github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] },
})) }));
vi.mock("../services/github-app-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-app-credentials.js")>(), resolveGitHubAppCredential: provider.acquire,
}));
import { createGitRemoteAuthProvider, resolveManagedGitHubCredential, resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { prepareHeartbeatGitHubEnvironment, prepareHeartbeatGitHubLaunchers } from "../services/heartbeat-github-launchers.js";
import { captureProjectConnectionRunContext, readProjectConnectionRunContext, revalidateProjectConnectionRunContext, isProjectConnectionManagedRequired, projectConnectionRunSnapshot } from "../services/project-connection-run-context.js";

function detectableFallback() {
  return { getByName: vi.fn(async () => ({ id: "synthetic-legacy-secret" })), resolveSecretValue: vi.fn(async () => "synthetic-legacy-token") };
}

describe("project connection task-derived selection and no legacy fallback (round-4 C)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-runtime-"); db = createDb(database.connectionString); }, 60_000);
  beforeEach(() => { provider.acquire.mockClear(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  // Credential-level fixtures start from a server-admitted pair. This is seed
  // state (like seedConnection), NOT proof that the outside-C queue captures it.
  async function projectConnectionFixture(_db: typeof db, sharedLead = false) {
    const f = await seedProjectConnectionFixture(db, sharedLead);
    return { ...f, run: async (...args: Parameters<typeof f.run>) => {
      const bound = await f.run(...args);
      const [task] = await db.select({ projectId: issues.projectId }).from(issues).where(and(
        eq(issues.id, bound.issue.id), eq(issues.companyId, f.companyId),
      ));
      const contextSnapshot = { ...bound.run.contextSnapshot,
        projectConnectionRunContext: { version: 1, issueId: bound.issue.id, projectId: task!.projectId } };
      await db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, bound.run.id));
      return { ...bound, run: { ...bound.run, contextSnapshot } };
    } };
  }

  async function shared() {
    const f = await projectConnectionFixture(db, true);
    const a = await f.seedConnection(f.a);
    const b = await f.seedConnection(f.b);
    // Same installation/account, deliberately make B rank first in BASE.
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, b.connection.id));
    await db.update(connectionGrants).set({ createdAt: new Date(Date.now() + 10000) }).where(eq(connectionGrants.id, b.grant.id));
    const bound = await f.run(f.a);
    const context = { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id, issueId: bound.issue.id };
    return { f, a, b, bound, context };
  }

  it.each(["archived", "disabled", "revoked"] as const)("RFL-C1/J12: agent_env launcher cannot export legacy/host tokens for %s owned access", async state => {
    const f = await projectConnectionFixture(db);
    const owned = await f.seedConnection(f.a, { status: state === "revoked" ? "active" : state, installed: state !== "archived" });
    if (state === "revoked") await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, owned.grant.id));
    const bound = await f.run();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: bound.issue.id,
      projectConnectionRunContext: { version: 1, issueId: bound.issue.id, projectId: f.a.id } } }).where(eq(heartbeatRuns.id, bound.run.id));
    const prepare = vi.fn(async (input: { env: Record<string, string> }) => input.env);
    const broker = vi.fn(() => "synthetic-broker-capability");
    const result = await prepareHeartbeatGitHubLaunchers({
      runId: bound.run.id, target: null, cwd: process.env.TMPDIR!, native: false, githubConfigured: false,
      agentId: f.leadA.id, brokerUrl: "http://synthetic.invalid/broker", createBrokerToken: broker,
      env: { PATH: "/synthetic/bin", PAPERCLIP_GITHUB_AUTH_MODE: "agent_env", GH_TOKEN: "synthetic-agent-token", GITHUB_TOKEN: "synthetic-host-token" },
      projectAuthority: { db, companyId: f.companyId },
    }, prepare);
    expect(result.env.GH_TOKEN).not.toBe("synthetic-agent-token");
    expect(result.env.GITHUB_TOKEN).not.toBe("synthetic-host-token");
    expect(result.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("managed");
    expect(prepare).toHaveBeenCalled();
    expect(broker).toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
    await expect(prepareHeartbeatGitHubEnvironment({ runId: bound.run.id, agentId: f.leadA.id,
      projectAuthority: { db, companyId: f.companyId }, cwd: process.env.TMPDIR!,
      target: null, networkAccess: true, defer: false, hostCredentials: true, env: { GH_TOKEN: "synthetic-host-token" },
    })).rejects.toThrow("project_connection_unavailable");
  });

  it("RFL-C2/J18: first credential use cannot lazily admit an unadmitted taskless run", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(null);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id,
      status: "running", contextSnapshot: { projectId: f.b.id } }).returning();
    const result = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, {
      agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: run!.id,
    });
    expect(result).toMatchObject({ configured: true, error: "project_connection_run_context_invalid" });
    expect(result.credential).toBeUndefined();
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(stored!.contextSnapshot).not.toHaveProperty("projectConnectionRunContext");
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("RFL-C2/A05: admission pair A survives snapshot replacement and a task move before first use refuses", async () => {
    const f = await projectConnectionFixture(db);
    const bound = await f.run();
    const saved = { version: 1, issueId: bound.issue.id, projectId: f.a.id };
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: bound.issue.id, projectConnectionRunContext: saved } })
      .where(eq(heartbeatRuns.id, bound.run.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: projectConnectionRunSnapshot({ issueId: bound.issue.id,
      projectId: f.b.id, projectConnectionRunContext: { version: 1, issueId: bound.issue.id, projectId: f.b.id } }) })
      .where(eq(heartbeatRuns.id, bound.run.id));
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, bound.run.id));
    expect(stored!.contextSnapshot?.projectConnectionRunContext).toEqual(saved);
    await db.update(issues).set({ projectId: f.b.id }).where(eq(issues.id, bound.issue.id));
    await expect(readProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: bound.run.id }))
      .rejects.toMatchObject({ status: 403, details: { code: "project_connection_run_context_invalid" } });
    const result = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, {
      agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id,
    });
    expect(result).toMatchObject({ configured: true, error: "project_connection_run_context_invalid" });
    expect(result.credential).toBeUndefined();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it.each(["legacy_oauth", "null_agent_app"] as const)("RFL-C3/A05/M03: ownership activates during %s acquisition; stale legacy token is refused", async kind => {
    const f = await projectConnectionFixture(db);
    const legacy = await f.seedConnection(null);
    await db.update(toolConnections).set({ credentialPolicy: "per_agent",
      ...(kind === "legacy_oauth" ? { config: { sourceTemplateKey: "github" } } : {}) }).where(eq(toolConnections.id, legacy.connection.id));
    await db.update(connectionGrants).set({ kind: "agent", isDefault: false, subjectAgentId: f.leadA.id,
      ...(kind === "legacy_oauth" ? { credentialSecretRefs: [{ configPath: "oauth.access_token", secretId: f.secret.id }] } : {}),
    }).where(eq(connectionGrants.id, legacy.grant.id));
    const bound = await f.run();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: bound.issue.id,
      projectConnectionRunContext: { version: 1, issueId: bound.issue.id, projectId: f.a.id } } }).where(eq(heartbeatRuns.id, bound.run.id));
    const activate = async () => { await f.seedConnection(f.a, { status: "active", installed: false }); };
    const secrets = detectableFallback();
    if (kind === "legacy_oauth") secrets.resolveSecretValue.mockImplementationOnce(async () => { await activate(); return "synthetic-stale-legacy-token"; });
    else provider.acquire.mockImplementationOnce(async (_db, connection) => {
      await activate();
      return { token: `synthetic-installation-token-${connection.id}`, expiresAt: Date.now() + 3600000,
        github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] } };
    });
    const result = await resolveManagedGitHubCredential(db, secrets, f.companyId, {
      agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id,
    });
    expect(result.credential).toBeUndefined();
    expect(result.configured).toBe(true);
    expect(result.error).toContain("project_connection_unavailable");
    if (kind === "legacy_oauth") expect(secrets.resolveSecretValue).toHaveBeenCalledTimes(1);
    else expect(provider.acquire).toHaveBeenCalledTimes(1);
    expect(secrets.getByName).not.toHaveBeenCalled();
  });

  it("RFL-C4/J14: unrelated owned project cannot break a working personal null MCP connection", async () => {
    const f = await projectConnectionFixture(db);
    const legacy = await f.seedConnection(null);
    await db.update(toolConnections).set({ credentialPolicy: "per_user", healthStatus: "ok" }).where(eq(toolConnections.id, legacy.connection.id));
    await db.update(connectionGrants).set({ kind: "user", isDefault: false, subjectUserId: f.human }).where(eq(connectionGrants.id, legacy.grant.id));
    await db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: legacy.connection.applicationId,
      connectionId: legacy.connection.id, name: "get_file_contents", toolName: "get_file_contents", riskLevel: "read", isReadOnly: true,
      inputSchema: { type: "object", properties: { repository: { type: "string" } } }, versionHash: "personal-null-v1" });
    const bound = await f.run(f.b);
    await db.update(heartbeatRuns).set({ responsibleUserId: f.human, contextSnapshot: { issueId: bound.issue.id,
      projectConnectionRunContext: { version: 1, issueId: bound.issue.id, projectId: f.b.id } } }).where(eq(heartbeatRuns.id, bound.run.id));
    const dispatch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: string | number; method: string };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "synthetic-personal-mcp", version: "1" } }
        : { content: [{ type: "text", text: "synthetic personal read" }] } });
    });
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow fixture read", policyType: "allow", selectors: { riskLevel: "read" } });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, bound.issue.id));
    const gateway = createToolGatewayService(db, { remoteHttpRequest: dispatch });
    const session = await gateway.createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: bound.run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find(item => item.connectionId === legacy.connection.id);
    expect(tool).toBeDefined();
    expect((await gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: { repository: "owner/B" } })).status).toBe("completed");
    await f.seedConnection(f.a, { status: "archived", installed: false });
    provider.acquire.mockClear(); dispatch.mockClear();
    expect((await gateway.executeTool({ sessionToken: session.token, tool: tool!.name, parameters: { repository: "owner/B" } })).status).toBe("completed");
    expect(provider.acquire).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalled();
    expect(dispatch.mock.calls.some(([, init]) => new Headers(init?.headers).get("authorization") === `Bearer synthetic-installation-token-${legacy.connection.id}`)).toBe(true);
  });

  it("A07: persists a projectless admission pair, ignoring a taskless snapshot project", async () => {
    const f = await projectConnectionFixture(db);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, status: "running", contextSnapshot: { projectId: f.b.id } }).returning();
    const captured = await captureProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: run!.id });
    expect(captured).toMatchObject({ issueId: null, projectId: null });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    expect(stored!.contextSnapshot?.projectConnectionRunContext).toEqual({ version: 1, issueId: null, projectId: null });
    await expect(revalidateProjectConnectionRunContext(db, captured)).resolves.toBeUndefined();
  });

  it("A07: caller issue cannot attach a task to an authenticated taskless run", async () => {
    const f = await projectConnectionFixture(db);
    const bound = await f.run(null);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, status: "running" }).returning();
    await expect(captureProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id,
      heartbeatRunId: run!.id, issueId: bound.issue.id })).rejects.toMatchObject({ status: 403, details: { code: "project_connection_run_context_invalid" } });
  });

  it("A05: conflicting stored task bindings refuse before provider use", async () => {
    const f = await projectConnectionFixture(db);
    const first = await f.run(null);
    const second = await f.run(null);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: second.issue.id } }).where(eq(heartbeatRuns.id, first.run.id));
    const result = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, {
      agentId: f.leadA.id, heartbeatRunId: first.run.id,
    });
    expect(result).toMatchObject({ configured: true, error: "project_connection_run_context_invalid" });
    expect(result.credential).toBeUndefined();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("A05/A12: deletion of the same bound task invalidates a captured projectless context", async () => {
    const f = await projectConnectionFixture(db);
    const bound = await f.run(null);
    const captured = await captureProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: bound.run.id });
    await db.delete(issues).where(eq(issues.id, bound.issue.id));
    await expect(revalidateProjectConnectionRunContext(db, captured)).rejects.toMatchObject({ status: 403, details: { code: "project_connection_run_context_invalid" } });
  });

  it.each(["archived", "disabled", "draft"] as const)("M03/J12: retained %s ownership with no runtime installs engages C2", async status => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { status, installed: false });
    expect(await isProjectConnectionManagedRequired(db, { companyId: f.companyId, projectId: f.a.id })).toBe(true);
    expect(await isProjectConnectionManagedRequired(db, { companyId: f.companyId, projectId: f.b.id })).toBe(false);
  });

  it("J10/null compatibility: an unowned row retains existing selection behavior", async () => {
    const f = await projectConnectionFixture(db);
    const legacy = await f.seedConnection(null);
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human });
    expect(selected.connection?.id).toBe(legacy.connection.id);
    expect(selected.grant?.id).toBe(legacy.grant.id);
  });

  it("J10: taskless use with exactly one eligible owned project remains available", async () => {
    const f = await projectConnectionFixture(db);
    const owned = await f.seedConnection(f.a);
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human });
    expect(selected.connection?.id).toBe(owned.connection.id);
    expect(selected.grant?.id).toBe(owned.grant.id);
  });

  it.each(["lead_removed", "lead_replaced", "primary_replaced", "project_archived"] as const)("J02/J03: stale approval after %s cannot release a credential", async change => {
    const f = await projectConnectionFixture(db);
    const owned = await f.seedConnection(f.a);
    const bound = await f.run();
    const before = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, {
      agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id,
    });
    expect(before.credential?.connectionId).toBe(owned.connection.id);
    provider.acquire.mockClear();
    if (change === "lead_removed") await db.update(projects).set({ leadAgentId: null }).where(eq(projects.id, f.a.id));
    if (change === "lead_replaced") await db.update(projects).set({ leadAgentId: f.leadB.id }).where(eq(projects.id, f.a.id));
    if (change === "primary_replaced") await db.update(userCompanyPreferences).set({ primaryAgentId: f.leadB.id }).where(and(eq(userCompanyPreferences.companyId, f.companyId), eq(userCompanyPreferences.userId, f.human)));
    if (change === "project_archived") await db.update(projects).set({ status: "completed", archivedAt: new Date() }).where(eq(projects.id, f.a.id));
    const selected = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id, issueId: bound.issue.id });
    expect(selected.credential).toBeUndefined();
    expect(selected.configured).toBe(true);
    expect(selected.error).toBeTruthy();
    expect(selected.error).toContain("project_connection_use_denied");
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("J17: shared lead's A-task selects A before B's health/newness ranking", async () => {
    const { f, a, b, context } = await shared();
    const chosen = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(chosen.connection?.id).toBe(a.connection.id);
    expect(chosen.grant?.id).toBe(a.grant.id);
    const credential = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, context);
    expect(credential.credential?.connectionId).toBe(a.connection.id);
    expect(provider.acquire).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: b.connection.id }), expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });

  it("J17: task A overrides a conflicting snapshot B and a forged persisted MCP session B", async () => {
    const { f, a, b, bound, context } = await shared();
    await db.update(heartbeatRuns).set({ contextSnapshot: projectConnectionRunSnapshot({ issueId: bound.issue.id, projectId: f.b.id,
      paperclipIssue: { id: bound.issue.id, projectId: f.b.id } }) }).where(eq(heartbeatRuns.id, bound.run.id));
    const captured = await captureProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: bound.run.id });
    expect(captured.projectId).toBe(f.a.id);
    const selected = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, context);
    expect(selected.credential?.connectionId).toBe(a.connection.id);
    const gateway = createToolGatewayService(db);
    const session = await gateway.createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: bound.run.id });
    expect(session.projectId).toBe(f.a.id);
    await db.update(toolGatewaySessions).set({ projectId: f.b.id }).where(eq(toolGatewaySessions.id, session.id));
    const selectedAgain = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, context);
    expect(selectedAgain.credential?.connectionId).toBe(a.connection.id);
    expect(provider.acquire.mock.calls.every(([, connection]) => connection.id !== b.connection.id)).toBe(true);
  });

  it("J17/J18: actual MCP-dispatched B descriptor and input never acquire B for task A", async () => {
    const { f, a, b, bound } = await shared();
    for (const owned of [a, b]) {
      await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, owned.connection.id));
      await db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: owned.connection.applicationId,
        connectionId: owned.connection.id, name: "get_file_contents", toolName: "get_file_contents", riskLevel: "read", isReadOnly: true,
        inputSchema: { type: "object", properties: { projectId: { type: "string" }, grantId: { type: "string" }, repository: { type: "string" } } },
        versionHash: "project-fixture-v1" });
    }
    const dispatch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: string | number; method: string };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "synthetic-project-mcp", version: "1" } }
        : { content: [{ type: "text", text: "synthetic project read" }] } });
    });
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow project fixture read", policyType: "allow", selectors: { riskLevel: "read" } });
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, bound.issue.id));
    const gateway = createToolGatewayService(db, { remoteHttpRequest: dispatch });
    const boundB = await f.run(f.b);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, boundB.issue.id));
    const bSession = await gateway.createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: boundB.run.id });
    const bDescriptor = (await gateway.listToolsForSession(bSession.token)).find(tool => tool.connectionId === b.connection.id);
    expect(bDescriptor).toBeDefined();
    const session = await gateway.createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: bound.run.id });
    // Saved session state is deliberately misleading as well as the input/descriptor.
    await db.update(toolGatewaySessions).set({ projectId: f.b.id }).where(eq(toolGatewaySessions.id, session.id));
    let outcome: Awaited<ReturnType<typeof gateway.executeTool>> | undefined;
    let refusal: unknown;
    try {
      outcome = await gateway.executeTool({ sessionToken: session.token, tool: bDescriptor!.name,
        parameters: { projectId: f.b.id, grantId: b.grant.id, repository: "owner/B" } });
    } catch (error) { refusal = error; }
    expect(outcome?.status === "completed" || Boolean(refusal)).toBe(true);
    expect(provider.acquire.mock.calls.every(([, connection]) => connection.id !== b.connection.id)).toBe(true);
    for (const [, init] of dispatch.mock.calls) {
      const header = new Headers(init?.headers).get("authorization");
      expect(header).not.toContain(`synthetic-installation-token-${b.connection.id}`);
    }
    // This checks a real positive dispatch too; an early stub/policy refusal is NOT a green J17.
    const tools = await gateway.listToolsForSession(session.token);
    const aDescriptor = tools.find(tool => tool.connectionId === a.connection.id);
    expect(aDescriptor).toBeDefined();
    const positive = await gateway.executeTool({ sessionToken: session.token, tool: aDescriptor!.name, parameters: { repository: "owner/A" } });
    expect(positive.status).toBe("completed");
    expect(dispatch).toHaveBeenCalled();
  });

  it.each(["capture_first", "revoke_first"] as const)("J17/A05: fresh reads after lifecycle lock-wait revocation (%s)", async order => {
    const { f, a, bound, context } = await shared();
    const reader = createDb(database.connectionString, { maxConnections: 1 });
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { locked = resolve; });
    let writer: Promise<void> | undefined;
    let waiting: Promise<Awaited<ReturnType<typeof resolveManagedGitHubCredential>>> | undefined;
    try {
      await reader.execute(sql`select set_config('application_name', ${`projconn-${bound.run.id}`}, false)`);
      if (order === "capture_first") {
        const captured = await captureProjectConnectionRunContext(reader, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: bound.run.id });
        expect(captured.projectId).toBe(f.a.id);
      }
      writer = db.transaction(async tx => {
        await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, f.a.id)).for("update");
        locked(); await gate;
        await tx.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, a.grant.id));
        await tx.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, a.connection.id));
      });
      await ready;
      waiting = captureProjectConnectionRunContext(reader, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: bound.run.id })
        .then(() => resolveManagedGitHubCredential(reader, detectableFallback(), f.companyId, context));
      void waiting.catch(() => undefined); // retain rejection for the intended assertion, not an unhandled promise
      await vi.waitFor(async () => {
        const result = await db.execute(sql`select count(*)::int as n from pg_stat_activity
          where application_name = ${`projconn-${bound.run.id}`} and wait_event_type = 'Lock'`);
        expect(Number(result[0]?.n)).toBe(1);
      }, { timeout: 3000, interval: 10 });
      expect(provider.acquire).not.toHaveBeenCalled();
      release(); await writer;
      const result = await waiting;
      expect(result.configured).toBe(true);
      expect(result.credential).toBeUndefined();
      expect(result.error).toContain("project_connection_unavailable");
      expect(provider.acquire).not.toHaveBeenCalled();
    } finally {
      release?.();
      await Promise.allSettled([writer, waiting]);
      await reader.$client.end({ timeout: 1 });
    }
  });

  it("J18: explicit project B/grant input cannot redirect a task-bound A run", async () => {
    const { f, a, b, context } = await shared();
    const lied = { ...context, projectId: f.b.id, explicitGrantId: b.grant.id };
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, lied);
    expect(selected.connection?.id).not.toBe(b.connection.id);
    expect(selected.connection?.id === a.connection.id || Boolean(selected.error)).toBe(true);
    expect(selected.error).toContain("project_connection_unavailable");
    const result = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, lied);
    expect(result.credential?.connectionId).not.toBe(b.connection.id);
    expect(result.error).toContain("project_connection_unavailable");
  });

  it("J10: taskless snapshot/workspace B cannot cure two-project ambiguity", async () => {
    const { f, b } = await shared();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, status: "running", contextSnapshot: { projectId: f.b.id } }).returning();
    await captureProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: run!.id });
    const context = { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: run!.id, projectId: f.b.id, explicitGrantId: b.grant.id };
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.configured).toBe(true);
    expect(selected.grant).toBeUndefined();
    expect(selected.error).toContain("project_connection_scope_ambiguous");
    expect(selected.error).toContain(f.a.id);
    expect(selected.error).toContain(f.b.id);
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("A07: bound task with null project remains projectless despite snapshot B", async () => {
    const { f } = await shared();
    const bound = await f.run(null, f.leadA.id, { projectId: f.b.id });
    const context = { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id, issueId: bound.issue.id };
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.grant).toBeUndefined();
    expect(selected.error).toContain("project_connection_scope_ambiguous");
  });

  it.each(["taskless", "null_task_project"] as const)("A07/J18 MCP: %s cannot convert snapshot B into an authoritative session project", async mode => {
    const f = await projectConnectionFixture(db, true);
    const run = mode === "taskless"
      ? (await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, status: "running", contextSnapshot: { projectId: f.b.id } }).returning())[0]!
      : (await f.run(null, f.leadA.id, { projectId: f.b.id })).run;
    if (mode === "taskless") await captureProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: run.id });
    const session = await createToolGatewayService(db).createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: run.id });
    expect(session.projectId).toBeNull();
  });

  it("J18 MCP: taskless explicit session body project B cannot select a project", async () => {
    const f = await projectConnectionFixture(db, true);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, status: "running", contextSnapshot: {} }).returning();
    await captureProjectConnectionRunContext(db, { companyId: f.companyId, agentId: f.leadA.id, heartbeatRunId: run!.id });
    let session;
    try { session = await createToolGatewayService(db).createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: run!.id, projectId: f.b.id }); }
    catch (error) { expect(error).toMatchObject({ status: 403 }); expect(error).toMatchObject({ status: 403, reasonCode: "run_context_mismatch" }); return; }
    expect(session.projectId).toBeNull();
  });

  it("J12: retained archived ownership alone denies the next bound-project push before any fallback lookup", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { status: "archived", installed: false });
    const bound = await f.run();
    const secrets = detectableFallback();
    const context = { agentId: f.leadA.id, responsibleUserId: f.human, issueId: bound.issue.id, heartbeatRunId: bound.run.id };
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.configured).toBe(true);
    expect(selected.grant).toBeUndefined();
    expect(selected.error).toContain("project_connection_unavailable");
    const git = createGitRemoteAuthProvider(db, f.companyId, context, { secrets, env: { GITHUB_TOKEN: "synthetic-env-token" } });
    await expect(git("https://github.com/owner/A.git")).rejects.toThrow("project_connection_unavailable");
    expect(secrets.getByName).not.toHaveBeenCalled();
    expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("J12: a TRUE child-process restart after successful use and retire refuses legacy/env/helper fallback", async () => {
    const { f, a, context } = await shared();
    await f.seedConnection(null); // Leftover managed legacy reach must not reopen fallback.
    const before = createGitRemoteAuthProvider(db, f.companyId, context, { secrets: detectableFallback() });
    expect((await before("https://github.com/owner/A.git"))?.source).toBe("managed_connection");
    await db.update(toolConnections).set({ status: "archived", enabled: false }).where(eq(toolConnections.id, a.connection.id));
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, a.connection.id));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, a.grant.id));
    provider.acquire.mockClear();
    const require = createRequire(import.meta.url);
    const script = `
      import { createDb } from ${JSON.stringify(new URL("../../../packages/db/src/index.ts", import.meta.url).href)};
      import { createGitRemoteAuthProvider, isGitHubHttpsRemoteUrl } from ${JSON.stringify(new URL("../services/git-credentials.ts", import.meta.url).href)};
      const db = createDb(process.env.PROJECT_TEST_DATABASE_URL);
      let fallbackLookups = 0, providerCalls = 0;
      globalThis.fetch = async () => { providerCalls++; throw new Error("forbidden synthetic provider request"); };
      const secrets = { getByName: async () => { fallbackLookups++; return { id: "synthetic-legacy" }; },
        resolveSecretValue: async () => { fallbackLookups++; return "synthetic-legacy-token"; } };
      try {
        const git = createGitRemoteAuthProvider(db, ${JSON.stringify(f.companyId)}, ${JSON.stringify(context)}, { secrets,
          env: { GITHUB_TOKEN: "synthetic-env-canary", GH_TOKEN: "synthetic-host-canary", SSH_AUTH_SOCK: "synthetic-ssh-agent" } });
        const refused = [], reasons = [];
        for (const remote of ["https://github.com/owner/A.git", "git@github.com:owner/A.git", "ssh://git@github.com/owner/A.git",
          "https://inline:synthetic-inline-canary@github.com/owner/A.git"]) {
          try { await git(remote); refused.push(false); } catch (error) { refused.push(true); reasons.push(error.message); }
        }
        console.log(JSON.stringify({ pid: process.pid, refused, reasons, fallbackLookups, providerCalls }));
      } finally { await db.$client.end({ timeout: 1 }); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath,
      ["--import", require.resolve("tsx"), "--input-type=module", "-e", script], {
        timeout: 30_000, maxBuffer: 100_000,
        env: { ...process.env, PROJECT_TEST_DATABASE_URL: database.connectionString, GH_TOKEN: "", GITHUB_TOKEN: "" },
      });
    const restarted = JSON.parse(stdout.trim().split("\n").at(-1)!) as { pid: number; refused: boolean[]; reasons: string[]; fallbackLookups: number; providerCalls: number };
    expect(restarted.pid).not.toBe(process.pid);
    expect(restarted.refused).toEqual([true, true, true, true]);
    expect(restarted.reasons).toHaveLength(4);
    expect(restarted.reasons.every(reason => reason.startsWith("project_connection_unavailable"))).toBe(true);
    expect(restarted.fallbackLookups).toBe(0);
    expect(restarted.providerCalls).toBe(0);
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("J17-disabled: unavailable A never substitutes the healthy B scope", async () => {
    const { f, a, b, context } = await shared();
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, a.connection.id));
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.connection?.id).not.toBe(b.connection.id);
    expect(selected.grant).toBeUndefined();
    expect(selected.configured).toBe(true);
    expect(selected.error).toContain("project_connection_unavailable");
  });

  it("A05: project movement during provider acquisition discards the stale token", async () => {
    const { f, b, bound, context } = await shared();
    provider.acquire.mockImplementationOnce(async (_db, connection) => {
      await db.update(issues).set({ projectId: f.b.id }).where(eq(issues.id, bound.issue.id));
      return { token: `synthetic-installation-token-${connection.id}`, expiresAt: Date.now() + 3600000,
        github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] } };
    });
    const selected = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, context);
    expect(provider.acquire).toHaveBeenCalledTimes(1);
    expect(selected.credential).toBeUndefined();
    expect(selected.error).toBeTruthy();
    expect(selected.error).toBe("project_connection_run_context_invalid");
    expect(selected.credential?.connectionId).not.toBe(b.connection.id);
  });

  it("A11: retiring shared A denies A while B still acquires its own scope", async () => {
    const { f, a, b, context } = await shared();
    await db.update(toolConnections).set({ status: "archived", enabled: false }).where(eq(toolConnections.id, a.connection.id));
    await db.delete(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, f.companyId), eq(toolConnectionInstalls.connectionId, a.connection.id)));
    const denied = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(denied.grant).toBeUndefined();
    expect(denied.configured).toBe(true);
    expect(denied.error).toContain("project_connection_unavailable");
    const boundB = await f.run(f.b);
    const bContext = { ...context, heartbeatRunId: boundB.run.id, issueId: boundB.issue.id };
    const allowed = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, bContext);
    expect(allowed.credential?.connectionId).toBe(b.connection.id);
  });
});
