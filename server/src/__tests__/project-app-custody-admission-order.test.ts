import "./helpers/project-connections-approval-http.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companySecretBindings, connectionGrants, createDb, toolConnections, toolConnectionInstalls } from "@paperclipai/db";
import { assertProjectConnectionAdmission, type ProjectConnectionOperation } from "../services/project-connection-admission.js";
import { resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture as seedFixture } from "./helpers/project-connections-fixture.js";
import { configureProjectFixture, projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

// Trust boundary + data safety: real admission/credential owners, vault, SQL and
// session approval routes. Only GitHub HTTP is replaced. These are new refusal
// cases; no old admission or provider expectation is repurposed.
describe("RFL 05:56Z custody admission order and acquire-only remap", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let http: ReturnType<typeof vi.mocked<typeof fetch>>;
  let original: typeof fetch;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-custody-order-"); db = createDb(database.connectionString);
    http = vi.mocked(fetch); original = http.getMockImplementation()!;
  }, 60_000);
  afterEach(() => { http.mockImplementation(original); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  const operations: ProjectConnectionOperation[] = ["create", "finish", "install", "update", "disable", "retire", "use", "project_update", "reconnect"];
  it.each(operations)("custody remains required on the %s owned admission path after valid repository/reference checks", async operation => {
    const f = await seedFixture(db);
    await configureProjectFixture(db, f); // real C4 write, deliberately NO approval
    const { connection } = await f.seedConnection();
    await expect(assertProjectConnectionAdmission(db, { companyId: f.companyId, projectId: f.a.id,
      connection, operation, actor: f.actor(), targetAgentIds: [f.leadA.id] }))
      .rejects.toMatchObject({ status: 403, details: { code: "project_app_approval_required" } });
  });

  it.each(["repository", "reference"] as const)("the original %s refusal precedes missing custody without authorizing the path", async boundary => {
    const f = await seedFixture(db); await configureProjectFixture(db, f);
    const { connection } = await f.seedConnection();
    await expect(assertProjectConnectionAdmission(db, { companyId: f.companyId, projectId: f.a.id, connection,
      operation: "finish", actor: f.actor(), targetAgentIds: [f.leadA.id],
      ...(boundary === "repository" ? { proposedRepositoryIds: [999] } : { proposedSecretRefs: [] }) }))
      .rejects.toMatchObject({ status: 403, details: { code: boundary === "repository" ? "project_connection_repository_not_approved" : "project_connection_reference_not_approved" } });
  });

  async function snapshot(companyId: string) {
    return {
      connections: await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId)),
      grants: await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
      bindings: await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId)),
      installs: await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
    };
  }

  it("RF2 3a RED: provider acquire failure before first-bind writes no connection, consumption or activity", async () => {
    const f = await projectConnectionFixture(db); await f.approve();
    const before = await snapshot(f.companyId);
    http.mockImplementation(async () => Response.json({ message: "unavailable" }, { status: 503 }));
    await expect(f.service.createConnection(f.companyId, f.input(), f.actor()))
      .rejects.toMatchObject({ status: 503, details: { code: "project_app_verification_unavailable" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("RF2 3a: provider acquire failure at release writes nothing and returns no credential", async () => {
    const f = await projectConnectionFixture(db); const c = await f.seedConnection();
    const before = await snapshot(f.companyId);
    http.mockImplementation(async () => Response.json({ message: "unavailable" }, { status: 503 }));
    await expect(resolveGitHubAppCredential(db, c.connection, c.grant, false, true, f.leadA.id))
      .rejects.toMatchObject({ status: 503, details: { code: "project_app_verification_unavailable" } });
    expect(await snapshot(f.companyId)).toEqual(before);
  });

  it("local grant denial is github_app_access_unavailable, never a provider 503", async () => {
    const f = await projectConnectionFixture(db); const c = await f.seedConnection();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, c.grant.id));
    const before = await snapshot(f.companyId);
    const calls = http.mock.calls.length;
    await expect(resolveGitHubAppCredential(db, c.connection, c.grant, false, true, f.leadA.id))
      .rejects.toMatchObject({ status: 422, details: { code: "github_app_access_unavailable" } });
    expect(http.mock.calls.length).toBe(calls);
    expect(await snapshot(f.companyId)).toEqual(before);
  });
});
