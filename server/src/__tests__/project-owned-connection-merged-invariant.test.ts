// Never-company-wide invariant on the merged #20717 reader+writer tree. For
// each seam the reader guard refused outright (S1-S7, F1), an agent in ANOTHER
// project is refused (with the reader's SAME guard code where the seam returns
// one) and the owning project's admitted agent is allowed through #20717's
// real admission (approved lead + recipient team, explicit install,
// migrationPending, project match). Rows are approved through the writer's
// genuine fixtures (H-session approval, custody), not hand-written envelopes.
import "./helpers/project-connections-approval-http.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents, companyMemberships, connectionGrants, createDb, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolPolicies, userCompanyPreferences,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

const provider = vi.hoisted(() => ({
  secret: vi.fn(async () => ({ value: "synthetic-project-key-never-return-this", latestVersion: 2 })),
  acquire: vi.fn(async () => ({ token: "synthetic-restricted-token", expiresAt: Date.now() + 3600000, verifiedRegistrationId: "123",
    github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected" as const,
      installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "101", fullName: "owner/A", installationId: "456", private: true }] },
  })),
}));
vi.mock("../services/connection-credentials.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/connection-credentials.js")>();
  return { ...actual, resolveConnectionGrantSecret: (...args: Parameters<typeof actual.resolveConnectionGrantSecret>) =>
    (args[1] as { projectId?: string | null }).projectId == null ? actual.resolveConnectionGrantSecret(...args) : provider.secret() };
});
vi.mock("../services/github-app-client.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/github-app-client.js")>();
  return { ...actual, createGitHubAppClient: (...options: Parameters<typeof actual.createGitHubAppClient>) => {
    const client = actual.createGitHubAppClient(...options);
    return { acquire: (...args: Parameters<typeof client.acquire>) =>
      args[0].includes(":approval:") || args[0].includes(":connection-create:")
        ? client.acquire(...args) : (provider.acquire as unknown as typeof client.acquire)(...args) };
  } };
});
import { resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { initializeAgentHire } from "../services/agent-hiring.js";

const OWNED_CODE = "project_connection_not_supported_by_this_server";

describe("merged #20717 reader+writer: a project-owned connection is never company-wide", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-projconn-merged-"); db = createDb(database.connectionString); }, 60_000);
  beforeEach(() => { provider.secret.mockClear(); provider.acquire.mockClear(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  /** An approved project-A App installed for A's lead, plus the widest stray
   * reach the reader feared: a company install and a company allow policy. */
  async function owned(options: { strayCompanyReach?: boolean } = {}) {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection(f.a);
    await db.update(toolConnections).set({ healthStatus: "ok" }).where(eq(toolConnections.id, connection.id));
    if (options.strayCompanyReach !== false) {
      await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "company", targetId: f.companyId });
    }
    const [entry] = await db.insert(toolCatalogEntries).values({ companyId: f.companyId, applicationId: connection.applicationId, connectionId: connection.id,
      name: "List repos", toolName: "list_repos", versionHash: "fixture" }).returning();
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Company allow", policyType: "allow", selectors: {}, priority: 0 });
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
    return { f, connection: row!, grant, entry: entry! };
  }

  const envelopeOf = async (id: string) => (await db.execute(sql`SELECT project_id, config ? 'projectScope' AS c_scope, transport_config ? 'projectScope' AS t_scope FROM tool_connections WHERE id = ${id}`))[0];

  it("S1 token mint: another project's agent (even with a stray company and agent install) is refused by name; A's admitted lead gets a token", async () => {
    const { f, connection, grant } = await owned();
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id, targetType: "agent", targetId: f.outsider.id });
    for (const agentId of [f.outsider.id, f.leadB.id, null]) {
      await expect(resolveGitHubAppCredential(db, connection, grant, false, false, agentId)).rejects.toMatchObject({ status: 403, details: { code: OWNED_CODE } });
    }
    expect(provider.secret).not.toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
    expect((await resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).token).toBe("synthetic-restricted-token");
  });

  it("S1: an A team member WITHOUT an explicit install is not admitted by a company install", async () => {
    const { f, connection, grant } = await owned();
    await expect(resolveGitHubAppCredential(db, connection, grant, false, false, f.worker.id)).rejects.toMatchObject({ details: { code: "github_app_access_unavailable" } });
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("S2 Git identity: never another project's (or a taskless outsider's) identity; A's lead in an A run selects it", async () => {
    const { f, connection } = await owned();
    const outsideRun = await f.run(f.b, f.outsider.id);
    for (const context of [{ agentId: f.outsider.id, heartbeatRunId: outsideRun.run.id, issueId: outsideRun.issue.id }, { agentId: f.outsider.id }]) {
      const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
      expect(selected.connection?.id).not.toBe(connection.id);
      expect(selected.grant?.connectionId).not.toBe(connection.id);
    }
    const insideRun = await f.run(f.a, f.leadA.id);
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: insideRun.run.id, issueId: insideRun.issue.id });
    expect(selected).toMatchObject({ configured: true, connection: { id: connection.id } });
    expect(selected.error).toBeUndefined();
  });

  it("S3 discovery: another project's agent lists no tool of it; A's admitted lead does", async () => {
    const { f, connection } = await owned();
    const gateway = createToolGatewayService(db, { toolActionSigningSecret: "projconn-merged-fixture" });
    const tools = async (agentId: string) => (await gateway.summarizeConnectionAccessForAgent({ companyId: f.companyId, connectionId: connection.id, agentId })).tools;
    expect(await tools(f.outsider.id)).toEqual([]);
    expect(await tools(f.leadB.id)).toEqual([]);
    expect((await tools(f.leadA.id)).map(tool => tool.toolName)).toEqual(["list_repos"]);
  });

  it("S4 tool call: denied by name to another project's agent despite a company allow policy; allowed for A's admitted lead in an A run", async () => {
    const { f, connection, entry } = await owned();
    const policy = toolAccessPolicyService(db);
    const outsideRun = await f.run(f.b, f.outsider.id);
    for (const [agentId, runContext] of [[f.outsider.id, { heartbeatRunId: outsideRun.run.id, issueId: outsideRun.issue.id, projectId: f.b.id }], [f.outsider.id, {}], [f.leadB.id, {}]] as const) {
      const denied = await policy.decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: agentId, agentId }, runContext,
        request: { connectionId: connection.id, catalogEntryId: entry.id, toolName: "list_repos", arguments: {} } });
      expect(denied).toMatchObject({ allowed: false, reasonCode: "deny_project_owned_connection" });
    }
    const insideRun = await f.run(f.a, f.leadA.id);
    const allowed = await policy.decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: f.leadA.id, agentId: f.leadA.id },
      runContext: { heartbeatRunId: insideRun.run.id, issueId: insideRun.issue.id },
      request: { connectionId: connection.id, catalogEntryId: entry.id, toolName: "list_repos", arguments: {} } });
    expect(allowed).toMatchObject({ allowed: true });
  });

  it("S5 installed connections: absent for another project's agent (stray company install ignored); present for A's admitted lead", async () => {
    const { f, connection } = await owned();
    const installed = async (agentId: string) => (await toolAccessService(db).getEffectiveProfilesForAgent(f.companyId, agentId)).installedConnections.map(c => c.id);
    expect(await installed(f.outsider.id)).not.toContain(connection.id);
    expect(await installed(f.worker.id)).not.toContain(connection.id);
    expect(await installed(f.leadA.id)).toContain(connection.id);
  });

  it("S6 explicit install: another project's recipient is refused by name; A's lead installs A's worker", async () => {
    const { f, connection } = await owned({ strayCompanyReach: false });
    await expect(f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.leadA.id }, { targetType: "agent", targetId: f.outsider.id }] }, f.actor()))
      .rejects.toMatchObject({ status: 403, details: { code: OWNED_CODE, connectionId: connection.id } });
    await expect(f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "company", targetId: f.companyId }] }, f.actor()))
      .rejects.toMatchObject({ status: 403, details: { code: OWNED_CODE } });
    // An actor from another project cannot grant it either.
    await expect(f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.leadA.id }] }, f.actor(f.leadB.id)))
      .rejects.toMatchObject({ status: 403, details: { code: OWNED_CODE } });
    const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    expect(before.map(install => install.targetId)).toEqual([f.leadA.id]);
    await f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.leadA.id }, { targetType: "agent", targetId: f.worker.id }] }, f.actor());
    const after = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    expect(after.map(install => install.targetId).sort()).toEqual([f.leadA.id, f.worker.id].sort());
  });

  it("S7 hire: never installs it, for another project's hire or A's own (A is reached only by explicit install, S6)", async () => {
    const { f, connection } = await owned({ strayCompanyReach: false });
    for (const reportsTo of [f.leadB.id, f.leadA.id]) {
      const [hired] = await db.insert(agents).values({ companyId: f.companyId, name: `Hire ${randomUUID()}`, role: "engineer", adapterType: "process", status: "active", reportsTo }).returning();
      await expect(db.transaction(tx => initializeAgentHire(tx as never, hired as never, { setupOnly: true,
        aiConnectionInstall: { connectionId: connection.id, createdByUserId: f.human } } as never)))
        .rejects.toMatchObject({ details: { code: OWNED_CODE, connectionId: connection.id } });
    }
    expect((await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).map(i => i.targetId)).toEqual([f.leadA.id]);
    // The admitted path for A's new team member: an explicit install by A's lead.
    const [member] = await db.insert(agents).values({ companyId: f.companyId, name: `A hire ${randomUUID()}`, role: "engineer", adapterType: "process", status: "active", reportsTo: f.leadA.id }).returning();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: member!.id, membershipRole: "member", status: "active" });
    await f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.leadA.id }, { targetType: "agent", targetId: member!.id }] }, f.actor());
    expect((await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).map(i => i.targetId).sort()).toEqual([f.leadA.id, member!.id].sort());
  });

  it("F1 reconnect/resume/finish: another project's actor or recipient is refused by name and the envelope survives; A's admitted actor reconnects with the envelope kept", async () => {
    const { f, connection, grant, entry } = await owned({ strayCompanyReach: false });
    const refused = { status: 403, details: { code: OWNED_CODE, connectionId: connection.id } };
    const outsider = f.actor(f.leadB.id);
    // (The writer fixture seeds config.projectScope only; compare against it.)
    const envelope = await envelopeOf(connection.id);
    expect(envelope).toMatchObject({ project_id: f.a.id, c_scope: true });
    await expect(f.service.connectGalleryApp(f.companyId, { galleryKey: "github", connectionMethodKey: "app-installation",
      reconnectConnectionId: connection.id, credentialValues: {} } as never, outsider)).rejects.toMatchObject(refused);
    await expect(f.service.reconnectGalleryApp(connection.id, f.companyId, { credentialValues: {} }, outsider)).rejects.toMatchObject(refused);
    await expect(f.service.finishGalleryAppConnection(f.companyId, connection.id, { enabledCatalogEntryIds: [entry.id], askFirstCatalogEntryIds: [],
      access: { agentIds: [f.leadA.id] } } as never, outsider)).rejects.toMatchObject(refused);
    // A's admitted primary may not hand it to another project's agent either.
    await expect(f.service.finishGalleryAppConnection(f.companyId, connection.id, { enabledCatalogEntryIds: [entry.id], askFirstCatalogEntryIds: [],
      access: { agentIds: [f.leadA.id, f.outsider.id] } } as never, f.actor())).rejects.toMatchObject(refused);
    // Gallery reconnect never rebuilds an owned row, even for A's admitted primary.
    await expect(f.service.connectGalleryApp(f.companyId, { galleryKey: "github", connectionMethodKey: "app-installation",
      reconnectConnectionId: connection.id, credentialValues: {} } as never, f.actor())).rejects.toMatchObject({ status: 409, details: { code: "project_connection_scope_protected" } });
    expect(await envelopeOf(connection.id)).toEqual(envelope);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0]).toEqual(grant);
    // A's admitted primary PASSES the F1 admission (no guard refusal); only
    // the writer's reference-only rules apply after it, and the envelope stays.
    // (The admitted finish positive is admission suite "J02/J03: approved lead
    // finishes an explicit worker with fresh verification ...".)
    await expect(f.service.reconnectGalleryApp(connection.id, f.companyId, { credentialValues: {} }, f.actor()))
      .rejects.toMatchObject({ status: 400, message: "Enter a replacement credential to reconnect this app" });
    await expect(f.service.reconnectGalleryApp(connection.id, f.companyId, { credentialValues: { "credentials.privateKey": "synthetic-raw-replacement" } }, f.actor()))
      .rejects.toMatchObject({ status: 403, details: { code: "project_connection_reference_not_approved" } });
    expect(await envelopeOf(connection.id)).toEqual(envelope);
    const [row] = await db.select().from(toolConnections).where(and(eq(toolConnections.id, connection.id), eq(toolConnections.companyId, f.companyId)));
    const [current] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connection.id));
    await expect(resolveGitHubAppCredential(db, row!, current!, false, false, f.outsider.id)).rejects.toMatchObject({ details: { code: OWNED_CODE } });
  });

  // RFL #20717 N1 (judge stale-admission probes, adopted): full admission is
  // the only guard that sees a changed primary approval at these two seams.
  it("N1 token full admission (github-app-credentials.ts S1): a stale primary approval is refused before any key read or provider acquisition", async () => {
    const { f, connection, grant } = await owned({ strayCompanyReach: false });
    await db.update(userCompanyPreferences).set({ primaryAgentId: f.leadB.id })
      .where(and(eq(userCompanyPreferences.companyId, f.companyId), eq(userCompanyPreferences.userId, f.human)));
    await expect(resolveGitHubAppCredential(db, connection, grant, false, false, f.leadA.id)).rejects.toBeDefined();
    expect(provider.secret).not.toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("N1 policy full admission (tool-access-policy.ts S4): an own-team installed agent with a stale primary approval gets no allowed decision", async () => {
    const { f, connection, entry } = await owned({ strayCompanyReach: false });
    const run = await f.run(f.a, f.leadA.id);
    await db.update(userCompanyPreferences).set({ primaryAgentId: f.leadB.id })
      .where(and(eq(userCompanyPreferences.companyId, f.companyId), eq(userCompanyPreferences.userId, f.human)));
    const decided = await toolAccessPolicyService(db).decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: f.leadA.id, agentId: f.leadA.id },
      runContext: { heartbeatRunId: run.run.id, issueId: run.issue.id },
      request: { connectionId: connection.id, catalogEntryId: entry.id, toolName: "list_repos", arguments: {} } }).catch((error: unknown) => error);
    // The seam either returns a denied decision or throws its typed 403; never an allowed decision.
    if (decided instanceof Error) expect(decided).toMatchObject({ status: 403 });
    else expect(decided).toMatchObject({ allowed: false });
  });

  it("N1 policy run match (tool-access-policy.ts S4): A's installed, admitted lead is denied in a run bound to project B", async () => {
    const { f, connection, entry } = await owned({ strayCompanyReach: false });
    const otherRun = await f.run(f.b, f.leadA.id);
    const denied = await toolAccessPolicyService(db).decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: f.leadA.id, agentId: f.leadA.id },
      runContext: { heartbeatRunId: otherRun.run.id, issueId: otherRun.issue.id },
      request: { connectionId: connection.id, catalogEntryId: entry.id, toolName: "list_repos", arguments: {} } });
    expect(denied).toMatchObject({ allowed: false, reasonCode: "deny_run_context_mismatch" });
  });

  it("N1 policy explicit install (tool-access-policy.ts S4): A's own-team worker in an A run is denied without an explicit agent install, despite a company install", async () => {
    const { f, connection, entry } = await owned();
    const run = await f.run(f.a, f.worker.id);
    const denied = await toolAccessPolicyService(db).decide({ companyId: f.companyId, actor: { actorType: "agent", actorId: f.worker.id, agentId: f.worker.id },
      runContext: { heartbeatRunId: run.run.id, issueId: run.issue.id },
      request: { connectionId: connection.id, catalogEntryId: entry.id, toolName: "list_repos", arguments: {} } });
    expect(denied).toMatchObject({ allowed: false, reasonCode: "deny_not_installed_for_agent" });
  });

  it("N1 Git envelope (git-credentials.ts S2): a row carrying a project envelope but no project_id is never a run identity, even with an agent install", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(null);
    await db.update(toolConnections).set({ config: { ...connection.config, projectScope: f.scope(f.a) } }).where(eq(toolConnections.id, connection.id));
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human });
    expect(selected.connection?.id).not.toBe(connection.id);
    expect(selected.grant?.connectionId).not.toBe(connection.id);
  });

  it("N1 Git full admission (git-credentials.ts S2): A's installed lead in an A run gets no identity once the primary approval is stale", async () => {
    const { f, connection } = await owned({ strayCompanyReach: false });
    const run = await f.run(f.a, f.leadA.id);
    await db.update(userCompanyPreferences).set({ primaryAgentId: f.leadB.id })
      .where(and(eq(userCompanyPreferences.companyId, f.companyId), eq(userCompanyPreferences.userId, f.human)));
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: run.run.id, issueId: run.issue.id });
    expect(selected.connection?.id).not.toBe(connection.id);
    expect(selected.grant?.connectionId).not.toBe(connection.id);
    expect(selected.error).toMatch(/^project_connection_use_denied/);
  });

  /** Hold the owning project's lifecycle lock, start `write`, wait until it is
   * BLOCKED on that lock (so its pre-lock admission already passed), make the
   * primary approval stale, release. Only the in-transaction recheck can refuse. */
  async function staleWhileBlocked<T>(f: Awaited<ReturnType<typeof owned>>["f"], write: () => Promise<T>) {
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const lockHeld = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM projects WHERE id = ${f.a.id} FOR UPDATE`);
      locked();
      await released;
      await tx.update(userCompanyPreferences).set({ primaryAgentId: f.leadB.id })
        .where(and(eq(userCompanyPreferences.companyId, f.companyId), eq(userCompanyPreferences.userId, f.human)));
    });
    await lockHeld;
    const outcome = write().then(value => ({ value }), (error: unknown) => ({ error }));
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      const [row] = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
      blocked = Number((row as { n: number }).n) > 0;
      if (!blocked) await new Promise(resolve => setTimeout(resolve, 50));
    }
    release();
    await holder;
    expect(blocked).toBe(true);
    return outcome;
  }

  it("N1 install race (installs.ts S6 transaction admission): approval made stale while the install waits for the project lock is refused; no install is written", async () => {
    const { f, connection } = await owned({ strayCompanyReach: false });
    const outcome = await staleWhileBlocked(f, () => f.service.putConnectionInstalls(connection.id,
      { installs: [{ targetType: "agent", targetId: f.leadA.id }, { targetType: "agent", targetId: f.worker.id }] }, f.actor(f.leadA.id)));
    expect(outcome).toMatchObject({ error: { status: 403 } });
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
    expect(installs.map(install => install.targetId)).toEqual([f.leadA.id]);
  });

  it("N1 update race (tool-access.ts update transaction admission): approval made stale while the update waits for the project lock is refused; the row is unchanged", async () => {
    const { f, connection } = await owned({ strayCompanyReach: false });
    const context = await f.management(connection.id, f.leadA.id);
    const outcome = await staleWhileBlocked(f, () => f.service.updateConnection(connection.id, { name: `renamed-${randomUUID()}` }, context));
    expect(outcome).toMatchObject({ error: { status: 403 } });
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id));
    expect(row!.name).toBe(connection.name);
  });
});
