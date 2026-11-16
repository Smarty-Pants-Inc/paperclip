import "./helpers/project-connections-approval-http.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, connectionGrants, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { INSTALLATION, projectConnectionFixture, type OwnedConnectionRow } from "./helpers/project-connections-fixture.js";
import { projectConnectionFixture as approvedProjectConnectionFixture } from "./helpers/project-connections-approved-fixture.js";
import {
  assertProjectConnectionAvailability,
  lockProjectConnectionIdentities,
  mapProjectConnectionUniquenessError,
  type ProjectConnectionIdentity,
} from "../services/project-connection-arbitration.js";

function identity(companyId: string, installationId = "456", registrationId = "123"): ProjectConnectionIdentity {
  return { companyId, providerHost: "github.com", verifiedRegistrationId: registrationId,
    canonicalInstallationKey: `github.com/github-app-installation/${installationId}` };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

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
    const f = await approvedProjectConnectionFixture(db);
    await f.approve(f.b); // Both genuine receipts precede the EXCLUSIVE row.
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

  // RFL 11:41Z 11-16: full rows retain generated ids/timestamps, while the
  // explicit binding fields below name S, its application/grant and audit rows.
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  async function approvalSnapshot(f: Awaited<ReturnType<typeof approvedProjectConnectionFixture>>, project = f.a) {
    const { sourceId, applicationId } = await f.approve(project);
    const [source] = await db.select().from(toolConnections).where(eq(toolConnections.id, sourceId));
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, applicationId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, sourceId));
    const receipt = { version: 1, id: expect.any(String), companyId: f.companyId, humanUserId: f.human,
      projectId: project.id, appId: "123", installationId: "456", repositoryIds: [project.id === f.a.id ? 101 : 202],
      secretRef: { secretId: f.secret.id, configPath: "credentials.privateKey" }, verifiedAt: expect.any(String), revokedAt: null };
    expect(source!.config.projectAppApproval).toEqual(receipt);
    const config = { sourceTemplateKey: "github", connectionMethodKey: "app-installation",
      methodConfig: f.config(project).methodConfig, projectAppApproval: source!.config.projectAppApproval };
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId)))
      .toEqual([{ ...source!, id: sourceId, companyId: f.companyId, applicationId, projectId: null,
        status: "draft", enabled: false, config, transportConfig: config,
        credentialSecretRefs: f.input(project).credentialSecretRefs, createdByUserId: f.human }]);
    expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId)))
      .toEqual([{ ...application!, id: applicationId, companyId: f.companyId, name: source!.name, type: "mcp_stdio", status: "active" }]);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId)))
      .toEqual([{ ...grant!, companyId: f.companyId, connectionId: sourceId, kind: "organization", status: "active",
        isDefault: true, credentialSecretRefs: source!.credentialSecretRefs }]);
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    const configActivity = activity.find(row => row.action === "plugin.config.updated")!;
    const created = activity.find(row => row.action === "tool_connection.created")!;
    const approved = activity.find(row => row.action === "tool_connection.project_app_approved")!;
    expect(byId(activity)).toEqual(byId([
      { ...configActivity, companyId: f.companyId, action: "plugin.config.updated", entityType: "plugin", actorType: "user", actorId: f.human },
      { ...created, companyId: f.companyId, action: "tool_connection.created", entityType: "tool_connection", entityId: sourceId, actorType: "user", actorId: f.human },
      { ...approved, companyId: f.companyId, action: "tool_connection.project_app_approved", entityType: "tool_connection", entityId: sourceId, actorType: "user", actorId: f.human },
    ]));
    return { source: source!, application: application!, grant: grant! };
  }

  it("J04/A10: duplicate service creates map one conflict and leave one application/grant/take receipt", async () => {
    const f = await approvedProjectConnectionFixture(db);
    const setup = await approvalSnapshot(f); // Genuine prerequisites, before the unchanged race.
    const wait = barrier(2);
    const results = await Promise.allSettled([0, 1].map(async () => {
      await wait();
      return f.service.createConnection(f.companyId, f.input(), f.actor());
    }));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    const winner = results.find(result => result.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw new Error("Expected the one winning create");
    const connection = winner.value;
    const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, connection.applicationId));
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connection.id));
    // Exactly snapshot + ONE new row per table; S's only allowed changes are
    // its atomic archive/consumer link and write timestamp. No rows filtered out.
    expect(byId(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))), "J04 connection delta exactly 1")
      .toEqual(byId([{ ...setup.source, status: "archived", enabled: false, updatedAt: expect.any(Date),
        config: { ...setup.source.config, projectAppApprovalConsumedBy: connection.id },
        transportConfig: { ...setup.source.transportConfig, projectAppApprovalConsumedBy: connection.id } }, connection]));
    expect(byId(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId))), "J04 application delta exactly 1")
      .toEqual(byId([setup.application, { ...application!, id: connection.applicationId, companyId: f.companyId,
        name: connection.name, type: "mcp_stdio", status: "active" }]));
    expect(byId(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))), "J04 grant delta exactly 1")
      .toEqual(byId([setup.grant, { ...grant!, companyId: f.companyId, connectionId: connection.id, kind: "organization", status: "active",
        isDefault: true, credentialSecretRefs: connection.credentialSecretRefs }]));
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_taken")))).toHaveLength(1);
  });

  it("J05: A+B may share installation I without losing each row's distinct project owner", async () => {
    const f = await approvedProjectConnectionFixture(db);
    await f.approve(f.a); await f.approve(f.b);
    const results = await Promise.all([f.a, f.b].map(project => f.service.createConnection(f.companyId, f.input(project), f.actor())));
    expect(results.map(result => (result as unknown as { projectId: string }).projectId).sort()).toEqual([f.a.id, f.b.id].sort());
    expect(results[0]!.config?.projectScope).toMatchObject(f.scope(f.a));
    expect(results[1]!.config?.projectScope).toMatchObject(f.scope(f.b));
  });

  it.each(["draft", "active"] as const)("J06: %s shared row still reserves installation against another project's EXCLUSIVE take", async status => {
    const f = await approvedProjectConnectionFixture(db);
    await f.approve(f.b);
    await f.seedConnection(f.a, { status, installed: false });
    await expect(f.service.createConnection(f.companyId, f.input(f.b, { config: f.config(f.b, true) }), f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
  });

  it("J08: concurrent shared and EXCLUSIVE writers cannot both commit", async () => {
    const f = await approvedProjectConnectionFixture(db);
    await f.approve(f.a); await f.approve(f.b);
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
    const f = await approvedProjectConnectionFixture(db);
    await f.approve(f.a); await f.approve(f.b, "457");
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

  it.each(["draft", "disabled"] as const)("J06 production: %s null alias blocks an EXCLUSIVE request before any application/grant write", async status => {
    const f = await approvedProjectConnectionFixture(db);
    const setup = await approvalSnapshot(f, f.b);
    const ordinary = await f.seedConnection(null, { status, installed: false });
    const beforeApplications = await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId));
    const beforeGrants = await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId));
    const [ordinaryApplication] = await db.select().from(toolApplications).where(eq(toolApplications.id, ordinary.connection.applicationId));
    expect(byId(beforeApplications)).toEqual(byId([setup.application, { ...ordinaryApplication!,
      id: ordinary.connection.applicationId, companyId: f.companyId, type: "rest_api", status: "active" }]));
    // Exactly S's grant plus the original conflicting ordinary null alias.
    expect(byId(beforeGrants)).toEqual(byId([setup.grant, ordinary.grant]));
    expect(byId(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))))
      .toEqual(byId([setup.source, ordinary.connection]));
    await expect(f.service.createConnection(f.companyId, f.input(f.b, { exclusive: true }), f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId))).toEqual(beforeApplications);
    expect(byId(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))), `J06 ${status} grant delta exactly 0`)
      .toEqual(byId(beforeGrants));
    expect(await db.select().from(toolConnections).where(eq(toolConnections.id, setup.source.id))).toEqual([setup.source]);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId), eq(activityLog.action, "tool_connection.project_taken")))).toHaveLength(0);
  });

  it("J07 production: a numeric-registration null alias on a different installation cannot join EXCLUSIVE", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { exclusive: true });
    const proposed = f.input(f.a, { projectId: null });
    proposed.config = { ...proposed.config, methodConfig: { ...f.config().methodConfig, installationId: "457" } };
    await expect(f.service.createConnection(f.companyId, proposed, f.actor()))
      .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId))).toHaveLength(1);
  });

  // Direct seam qualification is additional to (not a substitute for) the
  // existing full create-writer cases above. Keep reasons: trust boundary and
  // data safety; races use independent real PostgreSQL transactions.
  it.each(["draft", "active", "disabled"] as const)("J06/J14: arbiter counts %s shared reservations, regardless of enabled/install state", async status => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { status, installed: false });
    await db.transaction(async tx => {
      const key = identity(f.companyId);
      await lockProjectConnectionIdentities(tx, [key]);
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.b.id, exclusive: true }))
        .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.a.id, exclusive: false }))
        .rejects.toMatchObject({ status: 409, details: { code: "project_installation_in_use" } });
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.b.id, exclusive: false })).resolves.toBeUndefined();
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: null, exclusive: false })).resolves.toBeUndefined();
    });
  });

  it("J14: a saved null/client-ID alias blocks EXCLUSIVE without adopting ownership", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(null, { installed: false });
    await db.update(toolConnections).set({ config: { ...connection.config,
      methodConfig: { ...f.config().methodConfig, appId: "Iv1ProjectClient1234" } } }).where(eq(toolConnections.id, connection.id));
    await db.transaction(async tx => {
      const key = identity(f.companyId);
      await lockProjectConnectionIdentities(tx, [key]);
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.b.id, exclusive: true }))
        .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    });
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, connection.id)))[0]!.projectId).toBeNull();
  });

  it.each([null, "other-project", "same-project"])("J07/J09: EXCLUSIVE registration refuses %s including a different installation alias", async target => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { exclusive: true, installed: false });
    const projectId = target === null ? null : target === "same-project" ? f.a.id : f.b.id;
    await db.transaction(async tx => {
      const key = identity(f.companyId, "457");
      await lockProjectConnectionIdentities(tx, [key]);
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId, exclusive: false }))
        .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    });
  });

  it("J06/J09: shared binding on another installation of the verified registration blocks first EXCLUSIVE", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { installed: false });
    await db.transaction(async tx => {
      const key = identity(f.companyId, "457");
      await lockProjectConnectionIdentities(tx, [key]);
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.b.id, exclusive: true }))
        .rejects.toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    });
  });

  it("A14: excluding one's live shared row does not permit promotion to EXCLUSIVE", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await db.transaction(async tx => {
      const key = identity(f.companyId);
      await lockProjectConnectionIdentities(tx, [key]);
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.a.id, exclusive: true, excludeConnectionId: connection.id }))
        .rejects.toMatchObject({ status: 409, details: { code: "project_connection_exclusive_promotion_unsupported" } });
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.a.id, exclusive: false, excludeConnectionId: connection.id })).resolves.toBeUndefined();
    });
  });

  it("J06/J14: only archive releases; foreign-company bindings never reserve this company's installation", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { status: "archived", exclusive: true, installed: false });
    const other = await projectConnectionFixture(db);
    await other.seedConnection(other.a, { exclusive: true, installed: false });
    await db.transaction(async tx => {
      const key = identity(f.companyId);
      await lockProjectConnectionIdentities(tx, [key]);
      await expect(assertProjectConnectionAvailability(tx, { identity: key, projectId: f.b.id, exclusive: true })).resolves.toBeUndefined();
    });
  });

  it("J04: only the named project/installation unique violation maps to 409", () => {
    const named = { cause: { code: "23505", constraint_name: "tool_connections_project_live_installation_uq" } };
    expect(mapProjectConnectionUniquenessError(named)).toMatchObject({ status: 409, details: { code: "project_installation_in_use" } });
    const unrelated = { cause: { code: "23505", constraint_name: "different_constraint" } };
    expect(mapProjectConnectionUniquenessError(unrelated)).toBe(unrelated);
    const nonUnique = { code: "23503", constraint: "tool_connections_project_live_installation_uq" };
    expect(mapProjectConnectionUniquenessError(nonUnique)).toBe(nonUnique);
  });

  it.each([false, true])("J08/J09/A05: %s EXCLUSIVE first; the waiter sees committed aliases in a fresh statement", async firstExclusive => {
    const f = await projectConnectionFixture(db);
    const key = identity(f.companyId);
    const locked = deferred();
    const release = deferred();
    const waiterName = `arb-${randomUUID()}`;
    const holder = db.transaction(async tx => {
      await lockProjectConnectionIdentities(tx, [key]);
      locked.resolve();
      await release.promise;
      const [app] = await tx.insert(toolApplications).values({ companyId: f.companyId, name: randomUUID(), type: "rest_api" }).returning();
      await assertProjectConnectionAvailability(tx, { identity: key, projectId: f.a.id, exclusive: firstExclusive });
      await tx.insert(toolConnections).values({ companyId: f.companyId, projectId: f.a.id, applicationId: app!.id,
        name: randomUUID(), uid: randomUUID(), transport: "rest_api", status: "draft", config: f.config(f.a, firstExclusive) });
    });
    await locked.promise;
    const waiter = db.transaction(async tx => {
      await tx.execute(sql`select set_config('application_name', ${waiterName}, true)`);
      // This read happens before the wait, and MUST NOT be used as availability.
      expect(await tx.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
      await lockProjectConnectionIdentities(tx, [key]);
      await assertProjectConnectionAvailability(tx, { identity: key, projectId: f.b.id, exclusive: !firstExclusive });
    });
    // Observe the actual PostgreSQL advisory wait, not a timing assumption.
    const settledWaiter = waiter.then(() => null, error => error);
    try {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await db.execute(sql`select 1 from pg_stat_activity where application_name = ${waiterName} and wait_event = 'advisory'`);
        if (waiting.length) break;
        if (Date.now() >= deadline) throw new Error("Contender did not reach PostgreSQL advisory wait");
        await new Promise(done => setTimeout(done, 10));
      }
    } finally {
      release.resolve();
      await holder;
    }
    expect(await settledWaiter).toMatchObject({ status: 409, details: { code: "installation_not_exclusive" } });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(1);
  });

  it("J04/A10: seam composition rolls back the losing application/grant/receipt on the actual named PostgreSQL violation", async () => {
    const f = await projectConnectionFixture(db);
    const wait = barrier(2);
    const outcomes = await Promise.allSettled([0, 1].map(() => db.transaction(async tx => {
      await wait();
      const [app] = await tx.insert(toolApplications).values({ companyId: f.companyId, name: randomUUID(), type: "rest_api" }).returning();
      const [connection] = await tx.insert(toolConnections).values({ companyId: f.companyId, projectId: f.a.id,
        applicationId: app!.id, name: randomUUID(), uid: randomUUID(), transport: "rest_api", status: "draft", config: f.config() }).returning();
      await tx.insert(connectionGrants).values({ companyId: f.companyId, connectionId: connection!.id, kind: "organization", status: "active", isDefault: true });
      await tx.insert(activityLog).values({ companyId: f.companyId, actorId: f.primary.id, actorType: "agent",
        action: "tool_connection.project_taken", entityType: "tool_connection", entityId: connection!.id });
    }).catch(error => { throw mapProjectConnectionUniquenessError(error); })));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { status: 409, details: { code: "project_installation_in_use" } } });
    expect(await db.select().from(toolApplications).where(eq(toolApplications.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(1);
  });

  it("J09: first EXCLUSIVE seam writers use the registration lock across different installation aliases", async () => {
    const f = await projectConnectionFixture(db);
    const wait = barrier(2);
    const outcomes = await Promise.allSettled([f.a, f.b].map((project, index) => db.transaction(async tx => {
      const key = identity(f.companyId, String(456 + index));
      await wait();
      await lockProjectConnectionIdentities(tx, [key]);
      await assertProjectConnectionAvailability(tx, { identity: key, projectId: project.id, exclusive: true });
      const [app] = await tx.insert(toolApplications).values({ companyId: f.companyId, name: randomUUID(), type: "rest_api" }).returning();
      const config = f.config(project, true);
      await tx.insert(toolConnections).values({ companyId: f.companyId, projectId: project.id, applicationId: app!.id,
        name: randomUUID(), uid: randomUUID(), transport: "rest_api", status: "draft",
        config: { ...config, methodConfig: { ...config.methodConfig, installationId: String(456 + index) },
          projectScope: { ...config.projectScope, installationKey: key.canonicalInstallationKey } } });
    })));
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find(outcome => outcome.status === "rejected")).toMatchObject({ reason: { status: 409, details: { code: "installation_not_exclusive" } } });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(1);
  });

  it("J09: reversed multi-identity inputs and repeated identities cannot deadlock", async () => {
    const f = await projectConnectionFixture(db);
    const keys = [identity(f.companyId), identity(f.companyId, "457", "124")];
    const wait = barrier(2);
    await Promise.all([keys, [...keys].reverse()].map(identities => db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await wait();
      await lockProjectConnectionIdentities(tx, [...identities, identities[0]!]);
    })));
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
