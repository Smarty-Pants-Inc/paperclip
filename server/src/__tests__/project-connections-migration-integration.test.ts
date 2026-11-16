import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, companySecretVersions, createDb, toolConnectionInstalls, toolConnections, toolProfiles } from "@paperclipai/db";
import * as credentials from "../services/connection-credentials.js";
import * as scope from "../services/project-connection-provider-scope.js";
import { projectConnectionFixture, storedConnection, CANARY } from "./helpers/project-connections-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Qualified seeded-candidate integration only, NOT the complete create/human
// handoff journey. Real B admission + A arbitration + D activation/receipt +
// profile/install transaction. Only external credential/provider I/O is synthetic.
describe("integration M01/M02 actual pending finish transaction", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-migration-integration-"); db = createDb(database.connectionString); }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function candidate() {
    const f = await projectConnectionFixture(db, true);
    await db.insert(companySecretVersions).values({ secretId: f.secret.id, version: 1, status: "current",
      material: { synthetic: true }, valueSha256: "synthetic-migration-proof", fingerprintSha256: "synthetic-migration-proof" });
    const legacy = await f.seedConnection(null);
    const pending = await f.seedConnection(f.a, { status: "draft", installed: false, pending: true, legacyId: legacy.connection.id });
    vi.spyOn(credentials, "resolveConnectionGrantSecret").mockResolvedValue({ value: CANARY, latestVersion: 1 });
    vi.spyOn(scope, "verifyProjectConnectionGitHubScope").mockResolvedValue({ identity: { companyId: f.companyId,
      providerHost: "github.com", verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" }, repositoryIds: [101], secretVersion: 1 });
    const finish = () => f.service.finishGalleryAppConnection(f.companyId, pending.connection.id,
      { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [f.leadA.id] } }, f.actor());
    return { f, legacy, pending, finish };
  }

  it("M01/A10: real helper commits exactly one activation receipt with pending=false and explicit install, legacy untouched", async () => {
    const { f, legacy, pending, finish } = await candidate();
    const beforeLegacy = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id));
    const result = await finish();
    expect(result.connection).toMatchObject({ id: pending.connection.id, status: "active", enabled: true, config: { projectScope: { migrationPending: false } } });
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, pending.connection.id)))
      .toMatchObject([{ targetType: "agent", targetId: f.leadA.id }]);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, legacy.connection.id))).toEqual(beforeLegacy);
    const receipts = await db.select().from(activityLog).where(and(eq(activityLog.entityId, pending.connection.id), eq(activityLog.action, "tool_connection.updated")));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.details).toMatchObject({ reason: "migration_activated", verifiedRepositoryIds: [101], targetAgentIds: [f.leadA.id] });
    expect(JSON.stringify({ result, receipts })).not.toContain(CANARY);
  });

  it("M02/A10: actual activation receipt P0001 rolls pending/install/profile back without touching legacy", async () => {
    const { f, legacy, pending, finish } = await candidate();
    const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, f.companyId));
    await db.execute(sql.raw(`CREATE FUNCTION project_migration_int_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.entity_id = '${pending.connection.id}' AND NEW.action = 'tool_connection.updated' THEN RAISE EXCEPTION 'M02 integration receipt fault'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER project_migration_int_fault BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_migration_int_fault()"));
    try { await expect(finish()).rejects.toMatchObject({ cause: { code: "P0001", message: "M02 integration receipt fault" } }); }
    finally {
      await db.execute(sql.raw("DROP TRIGGER project_migration_int_fault ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION project_migration_int_fault()"));
    }
    expect(await storedConnection(db, pending.connection.id)).toEqual(pending.connection);
    expect(await storedConnection(db, legacy.connection.id)).toEqual(legacy.connection);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, f.companyId))).toEqual(before);
    expect(await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, pending.connection.id))).toHaveLength(0);
  });
});
