import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, toolConnections, toolConnectionInstalls } from "@paperclipai/db";
import { lockProjectConnectionLifecycle, stageProjectConnectionMigration } from "../services/project-connection-retirement.js";
import { projectConnectionFixture, storedConnection } from "./helpers/project-connections-fixture.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Keep reason: data safety of the narrowly bounded first-migration exception.
// D's existing suite separately proves real session approval -> create ->
// restart/legacy push -> verified finish/install. These PG probes exercise the
// history/no-reach branches without replacing any admission or custody reader.
describe("INT3 make-before-break staging cannot reset retained history", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-int3-staging-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function fixture(installed = true) {
    const f = await projectConnectionFixture(db);
    const source = await f.seedConnection(null, { installed });
    const stage = (status = "draft", enabled = false) => db.transaction(async tx => {
      await lockProjectConnectionLifecycle(tx, { companyId: f.companyId, projectId: f.a.id });
      return stageProjectConnectionMigration(tx, { companyId: f.companyId, projectId: f.a.id,
        sourceConnectionId: source.connection.id, config: f.config(), status, enabled });
    });
    return { f, source, stage };
  }

  it("first draft gets the exact installed source reference without changing legacy reach", async () => {
    const { f, source, stage } = await fixture();
    const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, source.connection.id));
    expect(await stage()).toMatchObject({ projectScope: { migrationPending: true, legacyConnectionId: source.connection.id } });
    expect(await storedConnection(db, source.connection.id)).toEqual(source.connection);
    expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, source.connection.id))).toEqual(installs);
    expect(await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.projectId, f.a.id)))).toHaveLength(0);
  });

  it.each(["draft", "disabled", "archived"] as const)("retained %s ownership never resets the pending exception", async status => {
    const { f, stage } = await fixture();
    await f.seedConnection(f.a, { status, installed: false });
    expect(await stage()).toEqual(f.config());
  });

  it("an approved source without runtime installs is ordinary first binding, not a legacy migration", async () => {
    const { f, stage } = await fixture(false);
    expect(await stage()).toEqual(f.config());
  });

  it("an active installed source cannot skip the non-serving draft by requesting active/enabled", async () => {
    const { f, stage } = await fixture();
    await expect(stage("active", true)).rejects.toMatchObject({ status: 409, details: { code: "project_connection_verification_required" } });
    expect(await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.projectId, f.a.id)))).toHaveLength(0);
  });
});
