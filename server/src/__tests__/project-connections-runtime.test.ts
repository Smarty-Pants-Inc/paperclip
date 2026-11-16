import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { connectionGrants, createDb, heartbeatRuns, issues, projects, userCompanyPreferences, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-fixture.js";

const provider = vi.hoisted(() => ({ acquire: vi.fn(async (_db: unknown, connection: { id: string }) => ({
  token: `synthetic-installation-token-${connection.id}`, expiresAt: Date.now() + 3_600_000,
  github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] },
})) }));
vi.mock("../services/github-app-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-app-credentials.js")>(), resolveGitHubAppCredential: provider.acquire,
}));
import { createGitRemoteAuthProvider, resolveManagedGitHubCredential, resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { createToolGatewayService } from "../services/tool-gateway.js";

function detectableFallback() {
  return { getByName: vi.fn(async () => ({ id: "synthetic-legacy-secret" })), resolveSecretValue: vi.fn(async () => "synthetic-legacy-token") };
}

describe("project connection task-derived selection and no legacy fallback (round-4 C)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-runtime-"); db = createDb(database.connectionString); }, 60_000);
  beforeEach(() => provider.acquire.mockClear());
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

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
    await f.seedConnection(f.a);
    const bound = await f.run();
    if (change === "lead_removed") await db.update(projects).set({ leadAgentId: null }).where(eq(projects.id, f.a.id));
    if (change === "lead_replaced") await db.update(projects).set({ leadAgentId: f.leadB.id }).where(eq(projects.id, f.a.id));
    if (change === "primary_replaced") await db.update(userCompanyPreferences).set({ primaryAgentId: f.leadB.id }).where(and(eq(userCompanyPreferences.companyId, f.companyId), eq(userCompanyPreferences.userId, f.human)));
    if (change === "project_archived") await db.update(projects).set({ status: "completed", archivedAt: new Date() }).where(eq(projects.id, f.a.id));
    const selected = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id, issueId: bound.issue.id });
    expect(selected.credential).toBeUndefined();
    expect(selected.configured).toBe(true);
    expect(selected.error).toBeTruthy();
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

  it("J18: explicit project B/grant input cannot redirect a task-bound A run", async () => {
    const { f, a, b, context } = await shared();
    const lied = { ...context, projectId: f.b.id, explicitGrantId: b.grant.id };
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, lied);
    expect(selected.connection?.id).not.toBe(b.connection.id);
    expect(selected.connection?.id === a.connection.id || Boolean(selected.error)).toBe(true);
    const result = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, lied);
    expect(result.credential?.connectionId).not.toBe(b.connection.id);
  });

  it("J10: taskless snapshot/workspace B cannot cure two-project ambiguity", async () => {
    const { f, b } = await shared();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, status: "running", contextSnapshot: { projectId: f.b.id } }).returning();
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
    const session = await createToolGatewayService(db).createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: run.id });
    expect(session.projectId).toBeNull();
  });

  it("J18 MCP: taskless explicit session body project B cannot select a project", async () => {
    const f = await projectConnectionFixture(db, true);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.leadA.id, status: "running", contextSnapshot: {} }).returning();
    let session;
    try { session = await createToolGatewayService(db).createSession({ companyId: f.companyId, agentId: f.leadA.id, runId: run!.id, projectId: f.b.id }); }
    catch (error) { expect(error).toMatchObject({ status: 403 }); return; }
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
    // A new factory models a process restart: no process-local ownership memory.
    for (let restart = 0; restart < 2; restart++) {
      const git = createGitRemoteAuthProvider(db, f.companyId, context, { secrets, env: { GITHUB_TOKEN: "synthetic-env-token" } });
      await expect(git("https://github.com/owner/A.git")).rejects.toThrow();
    }
    expect(secrets.getByName).not.toHaveBeenCalled();
    expect(secrets.resolveSecretValue).not.toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("J17-disabled: unavailable A never substitutes the healthy B scope", async () => {
    const { f, a, b, context } = await shared();
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, a.connection.id));
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.connection?.id).not.toBe(b.connection.id);
    expect(selected.grant).toBeUndefined();
    expect(selected.configured).toBe(true);
  });

  it("A05: project movement during provider acquisition discards the stale token", async () => {
    const { f, b, bound, context } = await shared();
    provider.acquire.mockImplementationOnce(async (_db, connection) => {
      await db.update(issues).set({ projectId: f.b.id }).where(eq(issues.id, bound.issue.id));
      return { token: `synthetic-installation-token-${connection.id}`, expiresAt: Date.now() + 3600000,
        github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] } };
    });
    const selected = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, context);
    expect(selected.credential).toBeUndefined();
    expect(selected.error).toBeTruthy();
    expect(selected.credential?.connectionId).not.toBe(b.connection.id);
  });

  it("A11: retiring shared A denies A while B still acquires its own scope", async () => {
    const { f, a, b, context } = await shared();
    await db.update(toolConnections).set({ status: "archived", enabled: false }).where(eq(toolConnections.id, a.connection.id));
    await db.delete(toolConnectionInstalls).where(and(eq(toolConnectionInstalls.companyId, f.companyId), eq(toolConnectionInstalls.connectionId, a.connection.id)));
    const denied = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(denied.grant).toBeUndefined();
    expect(denied.configured).toBe(true);
    const boundB = await f.run(f.b);
    const bContext = { ...context, heartbeatRunId: boundB.run.id, issueId: boundB.issue.id };
    const allowed = await resolveManagedGitHubCredential(db, detectableFallback(), f.companyId, bContext);
    expect(allowed.credential?.connectionId).toBe(b.connection.id);
  });
});
