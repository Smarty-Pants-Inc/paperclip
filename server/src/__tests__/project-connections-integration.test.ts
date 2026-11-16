import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, companySecretBindings, connectionGrants, createDb, toolApplications, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { lockProjectConnectionIdentities } from "../services/project-connection-arbitration.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture } from "./helpers/project-connections-fixture.js";

// Judge-added production-writer qualification. No admission, custody, provider,
// arbitration, lifecycle or receipt implementation is replaced. Missing trusted
// human handoff must remain RED, not become an artificial winner or rollback pass.
describe("integration INT-A2/INT-A3 real create transactions", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-integration-"); db = createDb(database.connectionString, { maxConnections: 8 }); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  async function counts(companyId: string) {
    return {
      applications: (await db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId))).length,
      connections: (await db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId))).length,
      grants: (await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId))).length,
      bindings: (await db.select().from(companySecretBindings).where(eq(companySecretBindings.companyId, companyId))).length,
      installs: (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId))).length,
      receipts: (await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "tool_connection.project_taken")))).length,
    };
  }

  it.each(["duplicate", "shared-first", "exclusive-first", "exclusive-alias-A-first", "exclusive-alias-B-first"] as const)(
    "INT-A2/J04/J08/J09: %s has one real service winner, named conflict, and one atomic result", async order => {
      const f = await projectConnectionFixture(db);
      const inputs = order === "duplicate" ? [f.input(), f.input()]
        : order.startsWith("exclusive-alias") ? [f.a, f.b].map((project, i) => f.input(project, { exclusive: true,
          config: { ...f.input(project).config, methodConfig: { ...f.config(project).methodConfig, installationId: String(456 + i) } } }))
        : [f.input(f.a), f.input(f.b, { exclusive: true })];
      if (order === "exclusive-first" || order === "exclusive-alias-B-first") inputs.reverse();
      let release!: () => void;
      let locked!: () => void;
      const held = new Promise<void>(done => { locked = done; });
      const proceed = new Promise<void>(done => { release = done; });
      const holder = db.transaction(async tx => {
        await lockProjectConnectionIdentities(tx, [{ companyId: f.companyId, providerHost: "github.com", verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" }]);
        locked(); await proceed;
      });
      await held;
      const first = f.service.createConnection(f.companyId, inputs[0]!, f.actor());
      // Observe a REAL advisory wait before starting the second writer. If the
      // first writer refuses preflight, preserve that result and fail the
      // winner assertion rather than claim either lock order was exercised.
      let firstDone = false;
      const settledFirst = first.then(value => { firstDone = true; return { status: "fulfilled" as const, value }; }, reason => { firstDone = true; return { status: "rejected" as const, reason }; });
      let reachedLock = false;
      let settledSecond!: ReturnType<typeof Promise.allSettled>;
      try {
        const deadline = Date.now() + 5_000;
        while (!firstDone && Date.now() < deadline) {
          const waiting = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`);
          if (waiting.length) { reachedLock = true; break; }
          await new Promise(done => setTimeout(done, 10));
        }
        settledSecond = Promise.allSettled([f.service.createConnection(f.companyId, inputs[1]!, f.actor())]);
      } finally { release(); await holder; }
      const outcomes = [await settledFirst, ...(await settledSecond)];
      expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
      expect(reachedLock, "first real create must reach the registration/installation lock, not refuse at an unrelated prerequisite").toBe(true);
      expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { status: 409, details: {
        code: order === "duplicate" ? "project_installation_in_use" : "installation_not_exclusive",
      } } });
      expect(await counts(f.companyId)).toMatchObject({ applications: 1, connections: 1, grants: 1, receipts: 1 });
    },
  );

  it("INT-A3/A10: same successful production create is the control for the injected receipt failure", async () => {
    const f = await projectConnectionFixture(db);
    const result = await f.service.createConnection(f.companyId, f.input(), f.actor());
    expect(result.projectId).toBe(f.a.id);
    expect(await counts(f.companyId)).toMatchObject({ applications: 1, connections: 1, grants: 1, receipts: 1 });
  });

  it("INT-A3/A10: actual receipt P0001 is required, with zero application/connection/grant/binding/install/receipt residue", async () => {
    const f = await projectConnectionFixture(db);
    await db.execute(sql.raw(`CREATE FUNCTION project_int_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'INT-A3 receipt fault'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER project_int_receipt_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION project_int_receipt_failure()"));
    try {
      await expect(f.service.createConnection(f.companyId, f.input(), f.actor())).rejects.toMatchObject({ cause: { code: "P0001", message: "INT-A3 receipt fault" } });
    } finally {
      await db.execute(sql.raw("DROP TRIGGER project_int_receipt_failure ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION project_int_receipt_failure()"));
    }
    expect(await counts(f.companyId)).toEqual({ applications: 0, connections: 0, grants: 0, bindings: 0, installs: 0, receipts: 0 });
  });
});
