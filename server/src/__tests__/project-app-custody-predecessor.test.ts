import "./helpers/project-connections-approval-http.js";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, createDb } from "@paperclipai/db";
import { consumeProjectAppApproval, readProjectAppCustody } from "../services/project-app-custody.js";
import { assertKnownProjectConnectionCreateAliases, assertProjectConnectionAvailability } from "../services/project-connection-arbitration.js";
import { refreshGitHubAppAccess, resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { storedConnection } from "./helpers/project-connections-fixture.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

// N6 compatibility at the judged consumption seam. Genuine C4/source/H receipt
// through real routes, then D's server-owned pending candidate fixture calls the
// real atomic consumption seam exactly as e057cf786 does. This does NOT claim
// integration of D's staging/completion/abort writers or its later 55-test suite.
describe("RFL 06:40Z N6: consumed live predecessor compatibility", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-custody-predecessor-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);
  async function fixture(fault = false) {
    const f = await projectConnectionFixture(db); const { sourceId } = await f.approve();
    const { connection, grant } = await f.seedConnection(f.a, { status: "draft", pending: true, legacyId: sourceId, installed: false });
    const before = await storedConnection(db, sourceId);
    const receipt = await readProjectAppCustody(db, { companyId: f.companyId, projectId: f.a.id, config: connection.config, refs: connection.credentialSecretRefs, registrationId: "123", repositoryIds: [101] });
    const consume = () => db.transaction(async tx => {
      await consumeProjectAppApproval(tx, { companyId: f.companyId, projectId: f.a.id, connectionId: connection.id,
        sourceConnectionId: sourceId, receiptId: receipt.receipt.id, actorType: "agent", actorId: f.primary.id, retainAsPredecessor: true });
      if (fault) throw new Error("N6 consume rollback fault");
    });
    return { ...f, sourceId, connection, grant, before, consume };
  }
  type F = Awaited<ReturnType<typeof fixture>>;
  const route = (f: F, action: "approve" | "revoke") => request(f.route("board")).post(`/api/companies/${f.companyId}/tools/connections/${f.sourceId}/project-app-approval`)
    .set("Origin", "http://127.0.0.1").send({ action, projectId: f.a.id });
  const identity = (f: F) => ({ companyId: f.companyId, providerHost: "github.com", verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" });

  it("N6 RED: retain S live, linked and readable only by its consumer; consume the receipt once", async () => {
    const f = await fixture(); await f.consume();
    const source = await storedConnection(db, f.sourceId);
    expect(source).toMatchObject({ status: f.before.status, enabled: f.before.enabled, config: { projectAppApprovalConsumedBy: f.connection.id } });
    expect(source.config.projectAppApproval).toEqual(f.before.config.projectAppApproval);
    const read = (connectionId?: string) => readProjectAppCustody(db, { companyId: f.companyId, projectId: f.a.id,
      config: f.connection.config, refs: f.connection.credentialSecretRefs, registrationId: "123", repositoryIds: [101], connectionId });
    await expect(read(f.connection.id)).resolves.toMatchObject({ sourceConnectionId: f.sourceId });
    await expect(read()).rejects.toMatchObject({ status: 409, details: { code: "project_installation_in_use" } });
    const http = vi.mocked(fetch); const calls = http.mock.calls.length;
    const approval = await route(f, "approve");
    expect(approval.status).toBe(409);
    expect(approval.body.details?.code ?? approval.body.code).toBe("project_app_approval_consumed");
    expect(http.mock.calls.length).toBe(calls);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_app_approval_consumed"))))
      .toMatchObject([{ details: { disposition: "predecessor" } }]);
  });

  it("N6 RED: a consumed live predecessor reserves nothing against ordinary or receipt-citing creates", async () => {
    const f = await fixture(); await f.consume();
    // Exclude the pending OWNED candidate to isolate the predecessor's own
    // reservation; owned-row exclusivity remains governed by the same arbiter.
    await expect(assertProjectConnectionAvailability(db, { identity: identity(f), projectId: f.a.id, exclusive: false, excludeConnectionId: f.connection.id })).resolves.toBeUndefined();
    await expect(assertKnownProjectConnectionCreateAliases(db, { companyId: f.companyId, projectId: f.a.id,
      config: f.input().config!, exclusive: true, excludeConnectionId: f.connection.id })).resolves.toBeUndefined();
  });

  it("N6/RF2 4b: revoke of the live consumed predecessor stops release and refresh without unarchiving or a later mint", async () => {
    const f = await fixture(); await f.consume();
    expect((await route(f, "revoke")).status).toBe(200);
    const source = await storedConnection(db, f.sourceId);
    expect(source.status).toBe(f.before.status);
    expect(source.config.projectAppApprovalConsumedBy).toBe(f.connection.id);
    const http = vi.mocked(fetch); const calls = http.mock.calls.length;
    await expect(resolveGitHubAppCredential(db, f.connection, f.grant, true, true, f.leadA.id))
      .rejects.toMatchObject({ details: { code: "project_app_approval_required" } });
    for (const force of [false, true]) await expect(refreshGitHubAppAccess(db, f.connection, force))
      .rejects.toMatchObject({ details: { code: "project_app_approval_required" } });
    expect(http.mock.calls.length).toBe(calls);
  });

  it("N6: a mid-consumption failure leaves the source and receipt unchanged and no consumption activity", async () => {
    const f = await fixture(true);
    await expect(f.consume()).rejects.toThrow("N6 consume rollback fault");
    expect(await storedConnection(db, f.sourceId)).toEqual(f.before);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_app_approval_consumed")))).toHaveLength(0);
  });
});
