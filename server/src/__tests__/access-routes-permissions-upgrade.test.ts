import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  connectionGrantDelegations,
  connectionGrants,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db, companyId: string, userId: string, authenticated = false) {
  const membership = authenticated
    ? await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalId, userId),
      eq(companyMemberships.principalType, "user"),
    )).then((rows) => rows[0]!)
    : null;
  const instanceAdmin = authenticated
    ? await db.select().from(instanceUserRoles).where(and(
      eq(instanceUserRoles.userId, userId),
      eq(instanceUserRoles.role, "instance_admin"),
    )).then((rows) => rows.length > 0)
    : true;
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
  const { accessRoutes } = await import("../routes/access.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId,
      source: authenticated ? "session" : "local_implicit",
      companyIds: [companyId],
      memberships: [{
        companyId,
        membershipRole: membership?.membershipRole ?? "owner",
        status: membership?.status ?? "active",
      }],
      isInstanceAdmin: instanceAdmin,
    };
    next();
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

async function createCompanyWithOwner(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Access Routes ${randomUUID()}`,
      issuePrefix: `AR${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const owner = await db
    .insert(companyMemberships)
    .values({
      companyId: company.id,
      principalType: "user",
      principalId: `owner-${randomUUID()}`,
      status: "active",
      membershipRole: "owner",
    })
    .returning()
    .then((rows) => rows[0]!);
  await db.insert(principalPermissionGrants).values({
    companyId: company.id,
    principalType: "user",
    principalId: owner.principalId,
    permissionKey: "users:manage_permissions",
    scope: null,
    grantedByUserId: owner.principalId,
  });
  return { company, owner };
}

describeEmbeddedPostgres("access routes permissions upgrade compatibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Load the large router graph during setup so a cold CI transform does not
  // consume the first permission assertion's timeout budget.
  beforeAll(async () => {
    await import("../routes/access.js");
  }, 30_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-access-routes-permissions-upgrade-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionGrantDelegations);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(principalPermissionGrants);
    await db.delete(instanceUserRoles);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createMember(
    companyId: string,
    membershipRole: string,
    instanceAdmin = false,
    status = "active",
  ) {
    const member = await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: `member-${randomUUID()}`,
      status,
      membershipRole,
    }).returning().then((rows) => rows[0]!);
    if (instanceAdmin) {
      await db.insert(instanceUserRoles).values({ userId: member.principalId, role: "instance_admin" });
    }
    return member;
  }

  for (const suffix of ["", "/role-and-grants"]) {
    describe(`instance-admin role protection: member${suffix}`, () => {
      // catch: https://github.com/paperclipai/paperclip/pull/4088
      it.each([
        ["operator", "owner"],
        ["viewer", "operator"],
        ["operator", "admin"],
        ["admin", "owner"],
      ])("allows an owner to raise an instance admin from %s to %s", async (from, to) => {
        const { company, owner } = await createCompanyWithOwner(db);
        const target = await createMember(company.id, from, true);
        const grants = [{ permissionKey: "tasks:assign_scope", scope: null }];
        const res = await request(await createApp(db, company.id, owner.principalId, true))
          .patch(`/api/companies/${company.id}/members/${target.id}${suffix}`)
          .send({ membershipRole: to, status: "active", ...(suffix ? { grants } : {}) });

        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ id: target.id, membershipRole: to, status: "active" });
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
          .toEqual([expect.objectContaining({ membershipRole: to, status: "active" })]);
        expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, target.principalId)))
          .toEqual([expect.objectContaining({ role: "instance_admin" })]);
        const events = await db.select().from(activityLog).where(and(
          eq(activityLog.companyId, company.id),
          eq(activityLog.entityId, target.id),
        ));
        expect(events).toEqual([expect.objectContaining({
          actorId: owner.principalId,
          action: suffix ? "company_member.access_updated" : "company_member.updated",
          details: expect.objectContaining({ membershipRole: to, status: "active" }),
        })]);
        if (suffix) {
          expect(await db.select().from(principalPermissionGrants).where(and(
            eq(principalPermissionGrants.companyId, company.id),
            eq(principalPermissionGrants.principalId, target.principalId),
          ))).toEqual([expect.objectContaining({ ...grants[0], grantedByUserId: owner.principalId })]);
        }
      });

      it("lets an instance admin stored as operator raise another instance admin", async () => {
        const { company } = await createCompanyWithOwner(db);
        const actor = await createMember(company.id, "operator", true);
        const target = await createMember(company.id, "operator", true);
        await request(await createApp(db, company.id, actor.principalId, true))
          .patch(`/api/companies/${company.id}/members/${target.id}${suffix}`)
          .send({ membershipRole: "owner" })
          .expect(200);
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
          .toEqual([expect.objectContaining({ membershipRole: "owner", status: "active" })]);
        expect(await db.select().from(activityLog).where(eq(activityLog.entityId, target.id)))
          .toEqual([expect.objectContaining({ actorId: actor.principalId })]);
      });

      it("keeps self-update protection even for an instance-admin role raise", async () => {
        const { company } = await createCompanyWithOwner(db);
        const actor = await createMember(company.id, "operator", true);
        const res = await request(await createApp(db, company.id, actor.principalId, true))
          .patch(`/api/companies/${company.id}/members/${actor.id}${suffix}`)
          .send({ membershipRole: "owner" });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe("You cannot remove yourself.");
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, actor.id)))
          .toEqual([expect.objectContaining({ membershipRole: "operator" })]);
      });

      it("allows a role-only raise with no status field", async () => {
        const { company, owner } = await createCompanyWithOwner(db);
        const target = await createMember(company.id, "operator", true);
        await request(await createApp(db, company.id, owner.principalId, true))
          .patch(`/api/companies/${company.id}/members/${target.id}${suffix}`)
          .send({ membershipRole: "owner" })
          .expect(200);
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
          .toEqual([expect.objectContaining({ membershipRole: "owner", status: "active" })]);
      });

      it.each([
        ["owner", "active", { membershipRole: "operator" }],
        ["operator", "active", { membershipRole: "operator" }],
        ["operator", "active", { membershipRole: null }],
        ["operator", "active", { status: "suspended" }],
        ["operator", "active", { membershipRole: "owner", status: "suspended" }],
        ["operator", "active", { membershipRole: "owner", status: "pending" }],
        ["operator", "suspended", { membershipRole: "owner", status: "active" }],
        ["operator", "archived", { membershipRole: "owner" }],
      ])("still refuses protected update from %s/%s with %j", async (role, status, body) => {
        const { company, owner } = await createCompanyWithOwner(db);
        const target = await createMember(company.id, role, true, status);
        const res = await request(await createApp(db, company.id, owner.principalId, true))
          .patch(`/api/companies/${company.id}/members/${target.id}${suffix}`)
          .send(body);
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe("Instance admins cannot be removed from company access.");
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
          .toEqual([expect.objectContaining({ membershipRole: role, status })]);
        expect(await db.select().from(activityLog)).toEqual([]);
      });

      it("keeps the normal permission denial for a non-admin actor", async () => {
        const { company } = await createCompanyWithOwner(db);
        const actor = await createMember(company.id, "operator");
        const target = await createMember(company.id, "operator", true);
        const res = await request(await createApp(db, company.id, actor.principalId, true))
          .patch(`/api/companies/${company.id}/members/${target.id}${suffix}`)
          .send({ membershipRole: "owner" });
        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.error).toBe("Permission denied");
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
          .toEqual([expect.objectContaining({ membershipRole: "operator" })]);
        expect(await db.select().from(activityLog)).toEqual([]);
      });

      it("preserves a non-admin target's raise", async () => {
        const { company, owner } = await createCompanyWithOwner(db);
        const target = await createMember(company.id, "operator");
        await request(await createApp(db, company.id, owner.principalId, true))
          .patch(`/api/companies/${company.id}/members/${target.id}${suffix}`)
          .send({ membershipRole: "owner" })
          .expect(200);
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
          .toEqual([expect.objectContaining({ membershipRole: "owner", status: "active" })]);
      });

      it("keeps the company boundary on a role raise", async () => {
        const { company, owner } = await createCompanyWithOwner(db);
        const { company: otherCompany } = await createCompanyWithOwner(db);
        const target = await createMember(otherCompany.id, "operator", true);
        await request(await createApp(db, company.id, owner.principalId, true))
          .patch(`/api/companies/${company.id}/members/${target.id}${suffix}`)
          .send({ membershipRole: "owner" })
          .expect(404);
        expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
          .toEqual([expect.objectContaining({ membershipRole: "operator" })]);
      });
    });
  }

  it("still refuses archiving an instance admin", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const target = await createMember(company.id, "operator", true);
    const res = await request(await createApp(db, company.id, owner.principalId, true))
      .post(`/api/companies/${company.id}/members/${target.id}/archive`)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Instance admins cannot be removed from company access.");
    expect(await db.select().from(companyMemberships).where(eq(companyMemberships.id, target.id)))
      .toEqual([expect.objectContaining({ membershipRole: "operator", status: "active" })]);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("rejects owner self-lockout through the member route after the permissions upgrade", async () => {
    const { company, owner } = await createCompanyWithOwner(db);

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${owner.id}`)
      .send({ membershipRole: "admin" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toContain("You cannot remove yourself");

    const unchanged = await db
      .select()
      .from(companyMemberships)
      .where(eq(companyMemberships.id, owner.id))
      .then((rows) => rows[0]!);
    expect(unchanged.membershipRole).toBe("owner");
  }, 10_000);

  it("keeps custom grants when the role-only member route changes a member role", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db
      .insert(companyMemberships)
      .values({
        companyId: company.id,
        principalType: "user",
        principalId: `admin-${randomUUID()}`,
        status: "active",
        membershipRole: "admin",
      })
      .returning()
      .then((rows) => rows[0]!);
    const customScope = { projectIds: ["project-1"] };
    await db.insert(principalPermissionGrants).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.principalId,
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ membershipRole: "operator" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.membershipRole).toBe("operator");

    const grants = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, company.id),
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, member.principalId),
        ),
      );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      permissionKey: "tasks:assign_scope",
      scope: customScope,
      grantedByUserId: owner.principalId,
    });
  });

  it("sweeps personal connection access when the member route suspends a user", async () => {
    const { company, owner } = await createCompanyWithOwner(db);
    const member = await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: `member-${randomUUID()}`,
      status: "active",
      membershipRole: "member",
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Delegated route agent",
      role: "worker",
      adapterType: "process",
      adapterConfig: {},
    }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({
      companyId: company.id,
      applicationKey: `route-app-${randomUUID()}`,
      name: "Route personal app",
      type: "mcp_http",
      status: "active",
    }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Route personal connection",
      uid: `route-connection-${randomUUID()}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
    }).returning().then((rows) => rows[0]!);
    const grant = await db.insert(connectionGrants).values({
      companyId: company.id,
      connectionId: connection.id,
      kind: "user",
      subjectUserId: member.principalId,
      status: "active",
    }).returning().then((rows) => rows[0]!);
    await db.insert(connectionGrantDelegations).values({
      companyId: company.id,
      grantId: grant.id,
      agentId: agent.id,
      createdByUserId: member.principalId,
    });

    const res = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}`)
      .send({ status: "suspended" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("suspended");
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))
      .toEqual([expect.objectContaining({ status: "revoked" })]);

    await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}/role-and-grants`)
      .send({ status: "active", grants: [] })
      .expect(200);
    await db.update(connectionGrants).set({ status: "active" }).where(eq(connectionGrants.id, grant.id));
    await db.insert(connectionGrantDelegations).values({
      companyId: company.id,
      grantId: grant.id,
      agentId: agent.id,
      createdByUserId: member.principalId,
    });

    const permissionsRoute = await request(await createApp(db, company.id, owner.principalId))
      .patch(`/api/companies/${company.id}/members/${member.id}/role-and-grants`)
      .send({ status: "suspended", grants: [] });
    expect(permissionsRoute.status, JSON.stringify(permissionsRoute.body)).toBe(200);
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant.id)))
      .toEqual([expect.objectContaining({ status: "revoked" })]);
  });
});
