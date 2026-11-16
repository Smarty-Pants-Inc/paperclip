import "./helpers/project-connections-approval-http.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { assertProjectConnectionAvailability } from "../services/project-connection-arbitration.js";
import { refreshGitHubAppAccess, resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { storedConnection } from "./helpers/project-connections-fixture.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

// Data safety/trust-boundary proof: real session routes, first bind, finish,
// vault, source consumption and credential owners; only provider HTTP is stubbed.
describe("RFL 05:56Z + RF2: consumed-source revoke is H's off switch", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-custody-revoke-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function fixture() {
    const f = await projectConnectionFixture(db); const { sourceId } = await f.approve();
    const created = await f.service.createConnection(f.companyId, f.input(f.a, { exclusive: true }), f.actor());
    await f.service.finishGalleryAppConnection(f.companyId, created.id, { access: { agentIds: [f.leadA.id] }, enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] }, f.actor(f.leadA.id));
    const connection = await storedConnection(db, created.id);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, created.id));
    return { ...f, sourceId, connection, grant: grant! };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  const url = (f: F) => `/api/companies/${f.companyId}/tools/connections/${f.sourceId}/project-app-approval`;
  const revoke = (f: F, app = f.route("board"), projectId = f.a.id) => request(app).post(url(f)).set("Origin", "http://127.0.0.1").send({ action: "revoke", projectId });
  const events = (companyId: string) => db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id);
  const release = (f: F, force = false) => resolveGitHubAppCredential(db, f.connection, f.grant, false, force, f.leadA.id);
  const identity = (f: F) => ({ companyId: f.companyId, providerHost: "github.com", verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" });

  it("RED: H revokes consumed S; every later release, forced mint and restarted owner refuses, with S archived and readable", async () => {
    const f = await fixture();
    const first = await release(f); expect(first.token).toBeTruthy();
    const http = vi.mocked(fetch); const requests = http.mock.calls.length;
    expect((await release(f)).token).toBe(first.token);
    expect(http.mock.calls.length).toBe(requests); // actual cache hit control
    const before = await storedConnection(db, f.sourceId);
    const response = await revoke(f);
    expect(response.status).toBe(200);
    const source = await storedConnection(db, f.sourceId);
    expect(source).toMatchObject({ id: f.sourceId, status: "archived", enabled: false, projectId: null,
      config: { projectAppApprovalConsumedBy: f.connection.id, projectAppApproval: { revokedAt: expect.any(String) } } });
    expect(source.credentialSecretRefs).toEqual(before.credentialSecretRefs);
    expect(source.config.projectAppApprovalConsumedBy).toBe(before.config.projectAppApprovalConsumedBy);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_app_revoked"))))
      .toMatchObject([{ entityId: f.sourceId, actorId: f.human, details: { projectId: f.a.id } }]);
    const afterRevokeRequests = http.mock.calls.length;
    for (const force of [false, true, true]) await expect(release(f, force))
      .rejects.toMatchObject({ status: 403, details: { code: "project_app_approval_required" } });
    const restarted = createDb(database.connectionString);
    try { await expect(resolveGitHubAppCredential(restarted, f.connection, f.grant, false, true, f.leadA.id))
      .rejects.toMatchObject({ status: 403, details: { code: "project_app_approval_required" } }); }
    finally { await restarted.$client.end({ timeout: 1 }); }
    expect(http.mock.calls.length).toBe(afterRevokeRequests); // no later provider mint
    const activity = await events(f.companyId);
    expect((await revoke(f)).status).toBe(200); // idempotent, no second activity
    expect(await events(f.companyId)).toEqual(activity);
  });

  it("RF2 4b RED: refresh after consumed-source revoke is refused with the named code and no mint or write", async () => {
    const f = await fixture(); expect((await release(f)).token).toBeTruthy();
    expect((await revoke(f)).status).toBe(200);
    const before = { source: await storedConnection(db, f.sourceId), activity: await events(f.companyId), grant: await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)) };
    const http = vi.mocked(fetch); const calls = http.mock.calls.length;
    for (const force of [false, true]) await expect(refreshGitHubAppAccess(db, f.connection, force))
      .rejects.toMatchObject({ status: 403, details: { code: "project_app_approval_required" } });
    expect(http.mock.calls.length).toBe(calls);
    expect({ source: await storedConnection(db, f.sourceId), activity: await events(f.companyId), grant: await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)) }).toEqual(before);
  });

  it("RED: revoke never reopens S's reservation; after board retirement only archived history remains", async () => {
    const f = await fixture(); expect((await revoke(f)).status).toBe(200);
    const retired = await request(f.route("board")).delete(`/api/tool-connections/${f.connection.id}`)
      .send({ projectDoneConfirmation: { projectId: f.a.id, connectionId: f.connection.id } });
    expect(retired.status).toBe(200);
    expect((await storedConnection(db, f.sourceId)).status).toBe("archived");
    expect(await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.projectId, f.a.id)))).toHaveLength(1);
    await expect(assertProjectConnectionAvailability(db, { identity: identity(f), projectId: f.b.id, exclusive: true })).resolves.toBeUndefined();
    // Re-approval of an archived consumed source cannot resurrect the reservation.
    const approval = await request(f.route("board")).post(url(f)).set("Origin", "http://127.0.0.1").send({ action: "approve", projectId: f.a.id });
    expect(approval.status).toBe(404);
  });

  it.each(["primary-agent", "other-project-agent", "foreign-board", "wrong-project-tuple"] as const)("RF2 4a: %s cannot revoke consumed S, 403 and nothing written", async actor => {
    const f = await fixture(); const foreign = actor === "foreign-board" ? await projectConnectionFixture(db) : null;
    const before = { source: await storedConnection(db, f.sourceId), activity: await events(f.companyId) };
    const app = actor === "foreign-board" ? foreign!.route("board") : actor === "wrong-project-tuple" ? f.route("board") : f.route(actor === "primary-agent" ? f.primary.id : f.leadB.id);
    const response = await revoke(f, app, actor === "wrong-project-tuple" ? f.b.id : f.a.id);
    expect(response.status).toBe(403);
    expect({ source: await storedConnection(db, f.sourceId), activity: await events(f.companyId) }).toEqual(before);
  });
});
