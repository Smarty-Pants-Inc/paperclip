import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, connectionGrants, createDb, toolConnectionInstalls, toolConnections, userCompanyPreferences } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture, storedConnection } from "./helpers/project-connections-fixture.js";

const provider = vi.hoisted(() => ({ verify: vi.fn(async () => ({ token: "synthetic-verified-project-token", expiresAt: Date.now() + 3600000,
  github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"], repositories: [{ id: "101", fullName: "owner/A", installationId: "456", private: true }] },
})), acquire: vi.fn(async (_db: unknown, connection: { id: string }) => ({
  token: `synthetic-project-token-${connection.id}`, expiresAt: Date.now() + 3600000,
  github: { userId: "123", login: "project-fixture[bot]", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["456"], installationOwnerLogins: ["owner"] },
})) }));
vi.mock("../services/github-app-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/github-app-credentials.js")>(),
  refreshGitHubAppAccess: provider.verify, resolveGitHubAppCredential: provider.acquire,
}));
import { resolveManagedGitHubCredential, resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";

// Receipt failure is injected at the actual PostgreSQL insert boundary, not in
// a fake service. This trigger exists only in this disposable test database.
async function failReceipt(db: ReturnType<typeof createDb>, id: string) {
  await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id = '${id}' THEN RAISE EXCEPTION 'synthetic receipt persistence failure'; END IF; RETURN NEW; END $$`));
  await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
}
async function restoreReceipt(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw("DROP TRIGGER IF EXISTS project_red_receipt_failure ON activity_log"));
}

describe("project connection make-before-break and local retirement (round-4 D)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-retire-"); db = createDb(database.connectionString); }, 60_000);
  beforeEach(() => { provider.verify.mockClear(); provider.acquire.mockClear(); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function pending() {
    const f = await projectConnectionFixture(db, true);
    const legacy = await f.seedConnection(null);
    const candidate = await f.seedConnection(f.a, { status: "draft", installed: false, pending: true, legacyId: legacy.connection.id });
    const bound = await f.run();
    const context = { agentId: f.leadA.id, responsibleUserId: f.human, heartbeatRunId: bound.run.id, issueId: bound.issue.id };
    const finish = () => f.service.finishGalleryAppConnection(f.companyId, candidate.connection.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.leadA.id] } }, f.actor());
    return { f, legacy, candidate, bound, context, finish };
  }

  it("M01: verified finish clears pending atomically, selects A during legacy overlap and preserves unconverted B", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    const before = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(before.connection?.id).toBe(legacy.connection.id);
    await finish();
    expect(provider.verify).toHaveBeenCalledTimes(1);
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: false });
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.connection?.id).toBe(candidate.connection.id);
    const b = await f.run(f.b);
    const bContext = { ...context, issueId: b.issue.id, heartbeatRunId: b.run.id };
    const unconverted = await resolveManagedGitHubIdentitySelection(db, f.companyId, bContext);
    expect(unconverted.connection?.id).toBe(legacy.connection.id);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id))).toHaveLength(1);
  });

  it("M02: second-operation receipt failure leaves candidate pending/non-serving and legacy use intact", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id));
    await failReceipt(db, candidate.connection.id);
    try { await expect(finish()).rejects.toThrow(); }
    finally { await restoreReceipt(db); }
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: true });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.connection.id))).toHaveLength(0);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id))).toEqual(installs);
    const selected = await resolveManagedGitHubCredential(db, { getByName: vi.fn(async () => null), resolveSecretValue: vi.fn(async () => "") }, f.companyId, context);
    expect(selected.credential?.connectionId).toBe(legacy.connection.id);
  });

  it("M02: failed token mint is not a health-only activation, and legacy remains usable after retry/restart", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    provider.verify.mockRejectedValueOnce(new Error("synthetic provider token mint failed"));
    await expect(finish()).rejects.toThrow();
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: true });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, candidate.connection.id))).toHaveLength(0);
    for (let restart = 0; restart < 2; restart++) {
      const selected = await resolveManagedGitHubCredential(db, { getByName: vi.fn(async () => null), resolveSecretValue: vi.fn(async () => "") }, f.companyId, context);
      expect(selected.credential?.connectionId).toBe(legacy.connection.id);
    }
  });

  it("M03/A04: resetting migrationPending on an activated row is refused without altering its history", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    await expect(f.management(connection.id).then(context => f.service.updateConnection(connection.id, { config: { ...connection.config, projectScope: { ...f.scope(), migrationPending: true, legacyConnectionId: connection.id } } }, context)))
      .rejects.toMatchObject({ status: 409 });
    expect((await storedConnection(db, connection.id)).config).toEqual(connection.config);
  });

  it("M03: activated then retired project cannot borrow leftover legacy reach or reset pending", async () => {
    const { f, legacy, candidate, context, finish } = await pending();
    await finish();
    const confirmedActor = { actorType: "user" as const, actorId: f.human, projectDoneConfirmation: { projectId: f.a.id, connectionId: candidate.connection.id } };
    await f.service.archiveConnection(candidate.connection.id, f.companyId, confirmedActor);
    const selected = await resolveManagedGitHubIdentitySelection(db, f.companyId, context);
    expect(selected.configured).toBe(true);
    expect(selected.grant).toBeUndefined();
    expect(selected.connection?.id).not.toBe(legacy.connection.id);
    expect((await storedConnection(db, candidate.connection.id)).status).toBe("archived");
  });

  it("A06a: board owner with dead lead/no primary uses existing DELETE; receipt failure rolls back", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.leadA.id));
    await db.update(userCompanyPreferences).set({ primaryAgentId: null }).where(eq(userCompanyPreferences.companyId, f.companyId));
    const success = await request(f.route()).delete(`/api/tool-connections/${connection.id}`);
    expect(success.status).toBe(200);
    expect(await storedConnection(db, connection.id)).toMatchObject({ status: "archived", enabled: false });
    const receipts = await db.select().from(activityLog).where(and(eq(activityLog.entityId, connection.id), eq(activityLog.action, "tool_connection.archived")));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ actorType: "user", actorId: f.human });
    const next = await f.seedConnection(f.a, { installed: false });
    await failReceipt(db, next.connection.id);
    try {
      const failed = await request(f.route()).delete(`/api/tool-connections/${next.connection.id}`);
      expect(failed.status).toBe(500);
      expect(await storedConnection(db, next.connection.id)).toMatchObject({ status: "active", enabled: true });
    } finally { await restoreReceipt(db); }
  });

  it("A06b: B lead acting for the same human gets readable 403, not board removal authority", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    const result = await request(f.route(f.leadB.id)).delete(`/api/tool-connections/${connection.id}`);
    expect(result.status).toBe(403);
    expect(result.body.code).toBe("project_connection_actor_required");
    expect(await storedConnection(db, connection.id)).toMatchObject({ status: "active", enabled: true });
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, connection.id))).toHaveLength(0);
  });

  it("A06b: board remove-only preservation does not authorize a mixed disable/rescope PATCH", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.leadA.id));
    await db.update(userCompanyPreferences).set({ primaryAgentId: null }).where(eq(userCompanyPreferences.companyId, f.companyId));
    const changed = await request(f.route()).patch(`/api/tool-connections/${connection.id}`).send({ enabled: false, name: "mixed removal and rescope" });
    expect(changed.status).toBe(403);
    expect(await storedConnection(db, connection.id)).toMatchObject({ enabled: true, name: connection.name });
  });

  it("A08/W2: continuation after the approving actor terminates refuses before provider verification", async () => {
    const { f, candidate, finish } = await pending();
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.primary.id));
    await expect(finish()).rejects.toMatchObject({ status: 403 });
    expect(provider.verify).not.toHaveBeenCalled();
    expect((await storedConnection(db, candidate.connection.id)).config.projectScope).toMatchObject({ migrationPending: true });
  });

  it("J11: running work blocks archive before any grant/install cleanup", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    await f.run();
    await expect(f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human }))
      .rejects.toMatchObject({ status: 409, details: { code: "project_connection_in_use" } });
    expect(await storedConnection(db, connection.id)).toMatchObject({ status: "active", enabled: true });
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))[0]!.status).toBe("active");
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id))).toHaveLength(1);
  });

  it("A10: archive receipt is in the same transaction; retry does not write a second success", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await failReceipt(db, connection.id);
    try { await expect(f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human })).rejects.toThrow(); }
    finally { await restoreReceipt(db); }
    expect(await storedConnection(db, connection.id)).toMatchObject({ enabled: true, status: "active" });
    await f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human });
    await f.service.archiveConnection(connection.id, f.companyId, { actorType: "user", actorId: f.human });
    expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, connection.id), eq(activityLog.action, "tool_connection.archived")))).toHaveLength(1);
  });

  it("A10: take receipt failure rolls back applications, grants and reservation on the actual transaction", async () => {
    const f = await projectConnectionFixture(db);
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION project_red_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'synthetic take receipt persistence failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER project_red_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_red_receipt_failure()"));
    try { await expect(f.service.createConnection(f.companyId, f.input(), f.actor())).rejects.toThrow(); }
    finally { await restoreReceipt(db); }
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))).toHaveLength(0);
  });

  it("A03/W2: explicit finish of archived owner returns terminal typed conflict, never revival", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { status: "archived", installed: false });
    await expect(f.service.finishGalleryAppConnection(f.companyId, connection.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.leadA.id] } }, f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "project_connection_archived" } });
    expect((await storedConnection(db, connection.id)).status).toBe("archived");
    expect(provider.verify).not.toHaveBeenCalled();
  });
});
