import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, companyMemberships, companySecrets, connectionGrants, createDb, toolConnections, userCompanyPreferences } from "@paperclipai/db";
import { createToolConnectionSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { projectConnectionFixture, storedConnection } from "./helpers/project-connections-fixture.js";

describe("project connection writer admission (round-4 B)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-project-admission-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }, 60_000);

  it("J19: a viewer's private primary is not the designated human's approval authority", async () => {
    const f = await projectConnectionFixture(db);
    const viewer = `viewer-${randomUUID()}`;
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: viewer, membershipRole: "viewer", status: "active" });
    await db.insert(userCompanyPreferences).values({ companyId: f.companyId, userId: viewer, primaryAgentId: f.outsider.id });
    await expect(f.service.createConnection(f.companyId, f.input(), { ...f.actor(f.outsider.id), responsibleUserId: viewer }))
      .rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(0);
  });

  it("A01: worker cannot self-ratify first bind; actorless service calls cannot bypass it", async () => {
    const f = await projectConnectionFixture(db);
    await expect(f.service.createConnection(f.companyId, f.input(), f.actor(f.worker.id)))
      .rejects.toMatchObject({ status: 403 });
    await expect(f.service.createConnection(f.companyId, f.input())).rejects.toMatchObject({ status: 403 });
  });

  it("J01: B's ordinarily permitted lead cannot disable A through the common writer", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    // The saved actor, not a route-only check, is needed by the writer.
    await expect(f.service.updateConnection(connection.id, { enabled: false }, {
      actor: { type: "agent", companyId: f.companyId, agentId: f.leadB.id, source: "agent_key" },
      responsibleUserId: f.human, reauthorize: async () => undefined,
    } as Parameters<typeof f.service.updateConnection>[2])).rejects.toMatchObject({ status: 403, details: { code: "project_connection_actor_required" } });
    expect((await storedConnection(db, connection.id)).enabled).toBe(true);
  });

  it("J02: wrong-project recipient cannot be installed by an otherwise permitted manager", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await expect(f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "agent", targetId: f.outsider.id }] }, f.actor()))
      .rejects.toMatchObject({ status: 403, details: { code: "project_connection_target_outside_project" } });
  });

  it("J03/J16: native create parsing preserves the nullable owner without removing baseline grants", async () => {
    const f = await projectConnectionFixture(db);
    const parsed = createToolConnectionSchema.parse(f.input());
    expect(parsed).toHaveProperty("projectId", f.a.id);
    const before = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
    const result = await f.service.createConnection(f.companyId, parsed, f.actor());
    expect(result).toHaveProperty("projectId", f.a.id);
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, f.companyId))).toEqual(before);
  });

  it("A02: changing workspace/repo hints cannot authorize another project's stable repo IDs", async () => {
    const f = await projectConnectionFixture(db);
    const proposed = f.input(f.b);
    proposed.config = { ...f.config(f.b), methodConfig: { ...f.config(f.b).methodConfig, repositories: "owner/A", repositoryIds: [101] } };
    await expect(f.service.createConnection(f.companyId, proposed, f.actor(f.leadB.id))).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });

  it("A04: null adoption, reparent, owner clearing and direct archive are not generic PATCH", async () => {
    const f = await projectConnectionFixture(db);
    for (const [from, to] of [[null, f.a], [f.a, f.b], [f.a, null]] as const) {
      const { connection } = await f.seedConnection(from);
      const patch = { projectId: to?.id ?? null, name: "must not silently strip ownership" };
      await expect(f.service.updateConnection(connection.id, patch)).rejects.toMatchObject({ status: 409 });
      expect((await storedConnection(db, connection.id)).name).toBe(connection.name);
    }
    const { connection } = await f.seedConnection();
    await expect(f.service.updateConnection(connection.id, { status: "archived" })).rejects.toMatchObject({ status: 409 });
  });

  it("J15: a primary cannot turn the trusted manager App classification into a project connection", async () => {
    const f = await projectConnectionFixture(db);
    const input = f.input();
    input.config = { ...f.config(), projectScope: { ...f.scope(), managerApp: true } };
    // Even caller-supplied protected metadata must not become approval evidence.
    await expect(f.service.createConnection(f.companyId, input, f.actor())).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });

  it("A14/W1/W8: owned non-GitHub provider fails typed 422 before creating any residue", async () => {
    const f = await projectConnectionFixture(db);
    await expect(f.service.createConnection(f.companyId, f.input(f.a, { config: { sourceTemplateKey: "railway" } }), f.actor()))
      .rejects.toMatchObject({ status: 422, details: { code: "project_connection_provider_unsupported" } });
    expect(await db.select().from(toolConnections).where(eq(toolConnections.companyId, f.companyId))).toHaveLength(0);
  });

  it("A14-promotion: live shared to EXCLUSIVE is a typed refusal, not a hidden implementation", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection();
    await expect(f.service.updateConnection(connection.id, { config: f.config(f.a, true) }))
      .rejects.toMatchObject({ status: 409, details: { code: "project_connection_exclusive_promotion_unsupported" } });
    expect((await storedConnection(db, connection.id)).config).toEqual(connection.config);
  });

  it("A08/W3: actorless company-wide replacement cannot manufacture owned connection reach", async () => {
    const f = await projectConnectionFixture(db);
    const { connection } = await f.seedConnection(f.a, { installed: false });
    await expect(f.service.putConnectionInstalls(connection.id, { installs: [{ targetType: "company", targetId: f.companyId }] }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("A09: another same-company secret cannot be substituted through a second/default installation grant", async () => {
    const f = await projectConnectionFixture(db);
    const { connection, grant } = await f.seedConnection();
    const [other] = await db.insert(companySecrets).values({ companyId: f.companyId, name: randomUUID(), key: randomUUID(), scope: "company" }).returning();
    await expect(f.service.addConnectionInstallation(connection.id, { isDefault: true,
      providerTenant: { externalId: "456" }, credentialSecretRefs: [{ secretId: other!.id, configPath: "credentials.privateKey", versionSelector: "latest" }],
    }, f.actor())).rejects.toMatchObject({ status: 403 });
    const saved = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connection.id));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: grant.id, isDefault: true, credentialSecretRefs: grant.credentialSecretRefs });
  });

  it("A12/W7: project deletion cannot strand retained owned history", async () => {
    const f = await projectConnectionFixture(db);
    await f.seedConnection(f.a, { status: "archived", installed: false });
    const { projectService } = await import("../services/projects.js");
    await expect(projectService(db).remove(f.a.id)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(toolConnections).where(and(eq(toolConnections.companyId, f.companyId), eq(toolConnections.status, "archived")))).toHaveLength(1);
  });
});
