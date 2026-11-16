import "./helpers/project-connections-approval-http.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, companySecretBindings, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { readProjectAppCustody } from "../services/project-app-custody.js";
import { resolveGitHubAppCredential } from "../services/github-app-credentials.js";
import { assertProjectConnectionAvailability, lockProjectConnectionIdentities } from "../services/project-connection-arbitration.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { storedConnection } from "./helpers/project-connections-fixture.js";
import { projectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";

// RFL ruling ~04:5xZ (FINDINGS-CUSTODY-RFL.md): a project create citing a valid
// receipt for source S CONSUMES S's reservation, make-before-break. Approvals are
// genuine (C4 config + H receipt through their board-session routes; GitHub
// stubbed only at HTTP). No receipt, config or reservation state is hand-written.
describe("receipt-citing create consumes its source's reservation (RFL 04:5xZ)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-custody-consume-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  const consumedEvents = (companyId: string) => db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "tool_connection.project_app_approval_consumed")));
  const owned = (companyId: string) => db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), sql`${toolConnections.projectId} is not null`));

  it("RED 1: the receipt's own create wins EXCLUSIVE over its own source's reservation", async () => {
    const f = await projectConnectionFixture(db);
    const { sourceId } = await f.approve(f.a);
    const created = await f.service.createConnection(f.companyId, f.input(f.a, { exclusive: true }), f.actor());
    expect(created).toMatchObject({ projectId: f.a.id });
    expect((await storedConnection(db, created.id)).config.projectScope).toMatchObject({ exclusive: true });
    expect((await storedConnection(db, sourceId)).status).toBe("archived");
  });

  it("RED 2 (05:56Z replacement): an ordinary non-receipt EXCLUSIVE create still collides with both live sources, named code, nothing written", async () => {
    const f = await projectConnectionFixture(db);
    const a = await f.approve(f.a);
    await f.approve(f.b, "456");
    const before = await storedConnection(db, a.sourceId);
    // No consumedSourceConnectionId: this is the ordinary arbiter entry, not a
    // receipt-citing create. Both projects still see the live S reservations.
    for (const project of [f.a, f.b]) await expect(assertProjectConnectionAvailability(db, {
      identity: { companyId: f.companyId, providerHost: "github.com", verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" },
      projectId: project.id, exclusive: true,
    })).rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    expect(await storedConnection(db, a.sourceId)).toEqual(before);
    expect(await owned(f.companyId)).toHaveLength(0);
    expect(await consumedEvents(f.companyId)).toHaveLength(0);
  });

  it.each(["exclusive-first", "exclusive-alias-A-first", "exclusive-alias-B-first"] as const)("05:56Z RED: %s receipt-citing race has one EXCLUSIVE owner and leaves the loser's S live and unused", async order => {
    const f = await projectConnectionFixture(db);
    const a = await f.approve(f.a);
    const b = await f.approve(f.b, order === "exclusive-first" ? "456" : "457");
    const sources = new Map([[f.a.id, a.sourceId], [f.b.id, b.sourceId]]);
    const before = new Map(await Promise.all([...sources].map(async ([projectId, id]) => [projectId, await storedConnection(db, id)] as const)));
    const inputs = order === "exclusive-first" ? [f.input(f.b, { exclusive: true }), f.input(f.a)]
      : [f.a, f.b].map((project, i) => f.input(project, { exclusive: true,
        config: { ...f.input(project).config, methodConfig: { ...f.config(project).methodConfig, installationId: String(456 + i) } } }));
    if (order === "exclusive-alias-B-first") inputs.reverse();
    let release!: () => void; let locked!: () => void;
    const held = new Promise<void>(done => { locked = done; });
    const proceed = new Promise<void>(done => { release = done; });
    const holder = db.transaction(async tx => {
      await lockProjectConnectionIdentities(tx, [{ companyId: f.companyId, providerHost: "github.com", verifiedRegistrationId: "123", canonicalInstallationKey: "github.com/github-app-installation/456" }]);
      locked(); await proceed;
    });
    await held;
    let done = false;
    const first = f.service.createConnection(f.companyId, inputs[0]!, f.actor()).then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason })).finally(() => { done = true; });
    let reachedLock = false;
    let second!: ReturnType<typeof Promise.allSettled>;
    try {
      const deadline = Date.now() + 5_000;
      while (!done && Date.now() < deadline) {
        const waiting = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`);
        if (waiting.length) { reachedLock = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      second = Promise.allSettled([f.service.createConnection(f.companyId, inputs[1]!, f.actor())]);
    } finally { release(); await holder; }
    const outcomes = [await first, ...await second];
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(reachedLock).toBe(true);
    expect(outcomes.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409, details: { code: "installation_not_exclusive" } } });
    const rows = await owned(f.companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.config.projectScope).toMatchObject({ exclusive: true });
    const loserProject = rows[0]!.projectId === f.a.id ? f.b : f.a;
    const loser = await storedConnection(db, sources.get(loserProject.id)!);
    expect(loser).toEqual(before.get(loserProject.id));
    expect(loser.status).not.toBe("archived");
    expect(loser.config.projectAppApprovalConsumedBy).toBeUndefined();
    expect(await consumedEvents(f.companyId)).toHaveLength(1);
    // A ruled winner must remain usable: saved receipt-citing writers must not
    // mistake the loser's still-live S for an ordinary owned reservation.
    const winner = rows[0]!;
    const lead = winner.projectId === f.a.id ? f.leadA : f.leadB;
    await f.service.finishGalleryAppConnection(f.companyId, winner.id, { access: { agentIds: [lead.id] }, enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [] }, f.actor(lead.id));
    const current = await storedConnection(db, winner.id);
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, winner.id));
    expect((await resolveGitHubAppCredential(db, current, grant!, false, false, lead.id)).token).toBeTruthy();
    expect(await storedConnection(db, loser.id)).toEqual(loser);
  });

  it("RED 3: a replayed receipt is single-use and refused with a named code", async () => {
    const f = await projectConnectionFixture(db);
    await f.approve(f.a);
    const first = await f.service.createConnection(f.companyId, f.input(f.a), f.actor());
    // While the consumer is live, the replay is the existing named duplicate.
    await expect(f.service.createConnection(f.companyId, f.input(f.a), f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "project_installation_in_use" } });
    // After the consumer is retired through the real archive path, the old
    // receipt is spent: no second connection without a new H approval.
    await f.service.archiveConnection(first.id, f.companyId, { ...f.actor(), projectDoneConfirmation: { projectId: f.a.id, connectionId: first.id } });
    await expect(f.service.createConnection(f.companyId, f.input(f.a), f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "project_app_approval_consumed" } });
    expect(await owned(f.companyId)).toHaveLength(1);
    expect(await consumedEvents(f.companyId)).toHaveLength(1);
  });

  it("RED 4: a forced failure mid-create leaves S unchanged, still reserved, and the receipt unconsumed", async () => {
    const f = await projectConnectionFixture(db);
    const { sourceId } = await f.approve(f.a);
    const before = await storedConnection(db, sourceId);
    await db.execute(sql.raw(`CREATE FUNCTION custody_consume_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id = '${f.companyId}' AND NEW.action = 'tool_connection.project_taken' THEN RAISE EXCEPTION 'consume fault'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw("CREATE TRIGGER custody_consume_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION custody_consume_failure()"));
    try {
      await expect(f.service.createConnection(f.companyId, f.input(f.a, { exclusive: true }), f.actor())).rejects.toThrow();
    } finally {
      await db.execute(sql.raw("DROP TRIGGER custody_consume_failure ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION custody_consume_failure()"));
    }
    expect(await storedConnection(db, sourceId)).toEqual(before);
    expect(await owned(f.companyId)).toHaveLength(0);
    expect(await consumedEvents(f.companyId)).toHaveLength(0);
    // Unconsumed: the same receipt still makes exactly one later create.
    const created = await f.service.createConnection(f.companyId, f.input(f.a, { exclusive: true }), f.actor());
    expect(created).toMatchObject({ projectId: f.a.id });
  });

  it("RED 5: S is archived and readable, never deleted; its binding and receipt stay for audit and the consumer's custody", async () => {
    const f = await projectConnectionFixture(db);
    const { sourceId } = await f.approve(f.a);
    const bindingsBefore = await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, sourceId));
    const receipt = (await storedConnection(db, sourceId)).config.projectAppApproval;
    const created = await f.service.createConnection(f.companyId, f.input(f.a), f.actor());
    const source = await storedConnection(db, sourceId);
    expect(source).toMatchObject({ status: "archived", enabled: false, projectId: null });
    expect(source.config.projectAppApproval).toEqual(receipt);
    expect(source.config.projectAppApprovalConsumedBy).toBe(created.id);
    expect(await db.select().from(companySecretBindings).where(eq(companySecretBindings.targetId, sourceId))).toEqual(bindingsBefore);
    expect(await consumedEvents(f.companyId)).toMatchObject([{ entityId: sourceId, details: { connectionId: created.id, projectId: f.a.id } }]);
    // Only the consuming connection may read custody from the archived source.
    const row = await storedConnection(db, created.id);
    const read = (connectionId?: string) => readProjectAppCustody(db, { companyId: f.companyId, projectId: f.a.id, config: row.config,
      refs: row.credentialSecretRefs, registrationId: "123", repositoryIds: [101], connectionId });
    await expect(read(created.id)).resolves.toMatchObject({ sourceConnectionId: sourceId });
    // Any other reader (a first bind, another connection) is refused while the
    // consumer is live with the existing named duplicate code.
    await expect(read()).rejects.toMatchObject({ status: 409, details: { code: "project_installation_in_use" } });
  });
});
