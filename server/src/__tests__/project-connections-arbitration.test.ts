import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, connectionGrants, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { INSTALLATION, projectConnectionFixture, type OwnedConnectionRow } from "./helpers/project-connections-fixture.js";

function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => { if (++arrived === parties) release(); await ready; };
}

describe("project connection PostgreSQL uniqueness and EXCLUSIVE (round-4 A)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-arbiter-"); db = createDb(database.connectionString, { maxConnections: 6 }); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  it("J14: normal null/null remains compatible, but a null alias cannot join EXCLUSIVE", async () => {
    const f = await projectConnectionFixture(db);
    await f.service.createConnection(f.companyId, f.input(f.a, { projectId: null, config: { sourceTemplateKey: "github" } }), f.actor());
    await f.service.createConnection(f.companyId, f.input(f.a, { projectId: null, config: { sourceTemplateKey: "github" } }), f.actor());
    await f.seedConnection(f.a, { exclusive: true });
    await expect(f.service.createConnection(f.companyId, f.input(f.a, { projectId: null }), f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
  });

  it("J07: a new project cannot attach after EXCLUSIVE, even through alternate App spelling", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { exclusive: true });
    const proposed = f.input(f.b);
    proposed.config = { ...proposed.config, methodConfig: { ...f.config(f.b).methodConfig, appId: "Iv1ProjectClient1234" } };
    await expect(f.service.createConnection(f.companyId, proposed, f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
  });

  it("J04: two independent transactions at a barrier cannot commit duplicate live project/installation rows", async () => {
    const f = await projectConnectionFixture(db);
    const [app] = await db.insert(toolApplications).values({ companyId: f.companyId, name: randomUUID(), type: "rest_api" }).returning();
    const wait = barrier(2);
    const results = await Promise.allSettled([0, 1].map(() => db.transaction(async tx => {
      const row: OwnedConnectionRow = { companyId: f.companyId, projectId: f.a.id, applicationId: app!.id, name: randomUUID(), uid: randomUUID(), transport: "rest_api", status: "draft", config: f.config() };
      await wait();
      return tx.insert(toolConnections).values(row).returning();
    })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { cause: { code: "23505", constraint_name: "tool_connections_project_live_installation_uq" } } });
    const rows = await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId));
    expect(rows).toHaveLength(1);
  });

  it("J04/A10: duplicate service creates map one conflict and leave one application/grant/take receipt", async () => {
    const f = await projectConnectionFixture(db);
    const wait = barrier(2);
    const results = await Promise.allSettled([0, 1].map(async () => {
      await wait();
      return f.service.createConnection(f.companyId, f.input(), f.actor());
    }));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_taken")))).toHaveLength(1);
  });

  it("J05: A+B may share installation I without losing each row's distinct project owner", async () => {
    const f = await projectConnectionFixture(db);
    const results = await Promise.all([f.a, f.b].map(project => f.service.createConnection(f.companyId, f.input(project), f.actor())));
    expect(results.map(result => (result as unknown as { projectId: string }).projectId).sort()).toEqual([f.a.id, f.b.id].sort());
    expect(results[0]!.config?.projectScope).toMatchObject(f.scope(f.a));
    expect(results[1]!.config?.projectScope).toMatchObject(f.scope(f.b));
  });

  it.each(["draft", "active"] as const)("J06: %s shared row still reserves installation against another project's EXCLUSIVE take", async status => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { status, installed: false });
    await expect(f.service.createConnection(f.companyId, f.input(f.b, { config: f.config(f.b, true) }), f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
  });

  it("J08: concurrent shared and EXCLUSIVE writers cannot both commit", async () => {
    const f = await projectConnectionFixture(db);
    const wait = barrier(2);
    const outcomes = await Promise.allSettled([false, true].map(async exclusive => {
      await wait();
      const project = exclusive ? f.b : f.a;
      return f.service.createConnection(f.companyId, f.input(project, { config: f.config(project, exclusive) }), f.actor());
    }));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const receipts = await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_taken")));
    expect(receipts).toHaveLength(1);
  });

  it("J09: first EXCLUSIVE registration bind serializes even when installation aliases differ", async () => {
    const f = await projectConnectionFixture(db);
    const wait = barrier(2);
    const outcomes = await Promise.allSettled([f.a, f.b].map(async (project, index) => {
      const config = f.config(project, true);
      const alias = { ...config, methodConfig: { ...config.methodConfig, installationId: String(456 + index) }, projectScope: { ...config.projectScope, installationKey: `github.com/github-app-installation/${456 + index}` } };
      await wait();
      return f.service.createConnection(f.companyId, f.input(project, { config: alias }), f.actor());
    }));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("J13: additive schema is exactly nullable owner plus the live expression uniqueness backstop", async () => {
    const columns = await db.execute<{ column_name: string; is_nullable: string }>(sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tool_connections' AND column_name = 'project_id'`);
    expect([...columns]).toEqual([{ column_name: "project_id", is_nullable: "YES" }]);
    const indexes = await db.execute<{ indexdef: string }>(sql`SELECT indexdef FROM pg_indexes WHERE tablename = 'tool_connections' AND indexname = 'tool_connections_project_live_installation_uq'`);
    expect(indexes).toHaveLength(1);
    expect(indexes[0]!.indexdef).toContain("UNIQUE INDEX");
    expect(indexes[0]!.indexdef).toContain("project_id");
    expect(indexes[0]!.indexdef).toContain("projectScope,installationKey");
    expect(indexes[0]!.indexdef).toContain("archived");
    const constraints = await db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid = 'tool_connections'::regclass AND contype = 'f' AND pg_get_constraintdef(oid) LIKE '%project_id%'`);
    expect(constraints).toHaveLength(0);
    expect(INSTALLATION).toBe("github.com/github-app-installation/456");
  });
});
