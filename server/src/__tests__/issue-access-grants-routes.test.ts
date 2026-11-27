import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import { documents, documentRevisions, issueDocuments, issuePlanDecompositions, issueThreadInteractions } from "@paperclipai/db";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAccessGrants,
  issueComments,
  issueReferenceMentions,
  issueRelations,
  issues,
  projectAccessMembers,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string, userId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId,
    companyIds: [companyId],
    source: "session",
    isInstanceAdmin: false,
  };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, source: "agent_jwt" };
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { issueRoutes } = await import("../routes/issues.js");
  const { projectRoutes } = await import("../routes/projects.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use("/api", projectRoutes(db));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describeEmbeddedPostgres("issue access grant and locked edge routes", { concurrent: false }, () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-access-grants-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
    // Load the current route dependency graph during setup, outside assertion timeouts.
    await Promise.all([import("../routes/issues.js"), import("../routes/projects.js")]);
  }, 120_000);

  afterEach(async () => {
    await db.delete(issueReferenceMentions);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueAccessGrants);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projectAccessMembers);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const ownerId = `owner-${randomUUID()}`;
    const adminId = `admin-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    const sharedUserId = `shared-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Private issue grants",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([
      { id: ownerId, name: "Olivia Owner", email: `${ownerId}@example.test`, createdAt: now, updatedAt: now },
      { id: adminId, name: "Ada Admin", email: `${adminId}@example.test`, createdAt: now, updatedAt: now },
      { id: memberId, name: "Nora Nonreader", email: `${memberId}@example.test`, createdAt: now, updatedAt: now },
      {
        id: sharedUserId,
        name: "Uma User",
        email: `${sharedUserId}@example.test`,
        image: "https://example.test/uma.png",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([ownerId, adminId, memberId, sharedUserId].map((principalId) => ({
      companyId,
      principalType: "user",
      principalId,
      status: "active",
      membershipRole: principalId === ownerId ? "owner" : principalId === adminId ? "admin" : "operator",
    })));
    const [assignedAgent, sharedAgent] = await db.insert(agents).values([
      {
        companyId,
        name: "Assigned Agent",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        companyId,
        name: "Private Helper",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {
          authorizationPolicy: {
            agentVisibility: { mode: "private", hiddenFromDefaultDirectory: true },
          },
        },
      },
    ]).returning();
    const privateProject = await db.insert(projects).values({
      companyId,
      name: "Secret launch project",
      visibility: "private",
      status: "planned",
    }).returning().then((rows) => rows[0]!);
    const privateIssueId = randomUUID();
    await db.insert(issues).values({
      id: privateIssueId,
      companyId,
      identifier: "PRV-1",
      title: "Confidential root",
      status: "backlog",
      priority: "medium",
      projectId: privateProject.id,
      visibility: "private",
      privacyRootIssueId: privateIssueId,
      responsibleUserId: ownerId,
      createdByUserId: ownerId,
    });
    const privateChild = await db.insert(issues).values({
      companyId,
      parentId: privateIssueId,
      identifier: "PRV-1A",
      title: "Confidential child",
      status: "backlog",
      priority: "medium",
      projectId: privateProject.id,
      visibility: "private",
      privacyRootIssueId: privateIssueId,
      responsibleUserId: ownerId,
      createdByUserId: ownerId,
    }).returning().then((rows) => rows[0]!);
    const openIssue = await db.insert(issues).values({
      companyId,
      identifier: "PRV-2",
      title: "Open issue",
      status: "todo",
      priority: "medium",
      createdByUserId: ownerId,
    }).returning().then((rows) => rows[0]!);
    return {
      companyId,
      ownerId,
      adminId,
      memberId,
      sharedUserId,
      assignedAgent: assignedAgent!,
      sharedAgent: sharedAgent!,
      privateProject,
      privateIssueId,
      privateChild,
      openIssue,
    };
  }

  async function privacyRun(f: Awaited<ReturnType<typeof seedFixture>>, person: boolean, userId = f.ownerId): Promise<Express.Request["actor"]> {
    const [comment] = person ? await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.openIssue.id, authorUserId: userId, body: "Please make this work private" }).returning() : [];
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgent.id, issueId: f.openIssue.id, status: "running", contextSnapshot: { issueId: f.openIssue.id } }).returning();
    const { initializeRunIdentity } = await import("../services/run-identity.js");
    await initializeRunIdentity(db, { companyId: f.companyId, runId: run!.id, responsibleUserId: null, issueId: f.openIssue.id, messageIds: comment ? [comment.id] : [], cause: person ? "instruction" : "timer" });
    return { ...agentActor(f.companyId, f.assignedAgent.id), runId: run!.id, onBehalfOfUserId: person ? userId : null, onBehalfOfMemberships: person ? [{ companyId: f.companyId, status: "active", membershipRole: userId === f.ownerId ? "owner" : "operator" }] : [] } satisfies Express.Request["actor"];
  }

  it.each(["timer", "routine", "company_default", "no-context", "agent-steering", "person-comment", "person-steering", "person-interaction", "manual-wake"])("requires the person's own current act: %s", async cause => {
    const f = await seedFixture();
    await db.update(issues).set({ responsibleUserId: f.ownerId }).where(eq(issues.id, f.openIssue.id));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignedAgent.id, issueId: f.openIssue.id, status: "running", responsibleUserId: f.ownerId, contextSnapshot: { issueId: f.openIssue.id } }).returning();
    const { initializeRunIdentity, reserveSteeredIdentity, acceptSteeredIdentity } = await import("../services/run-identity.js");
    const [comment] = ["agent-steering", "person-comment", "person-steering"].includes(cause) ? await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.openIssue.id, body: "Please make this work private", ...(cause === "agent-steering" ? { authorType: "agent", authorAgentId: f.sharedAgent.id } : { authorUserId: f.ownerId }) }).returning() : [];
    if (cause === "manual-wake") {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.assignedAgent.id, runId: run!.id, source: "on_demand", requestedByActorType: "user", requestedByActorId: f.ownerId, payload: { manualUserWake: true } }).returning();
      await db.update(heartbeatRuns).set({ wakeupRequestId: wake!.id }).where(eq(heartbeatRuns.id, run!.id));
    }
    if (cause !== "no-context") await initializeRunIdentity(db, { companyId: f.companyId, runId: run!.id, responsibleUserId: f.ownerId, issueId: f.openIssue.id, messageIds: cause === "person-comment" ? [comment!.id] : [], cause: ["routine", "company_default"].includes(cause) ? cause : "timer" });
    if (["agent-steering", "person-steering", "person-interaction"].includes(cause)) {
      const [interaction] = cause === "person-interaction" ? await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.openIssue.id, kind: "request_confirmation", status: "accepted", payload: { version: 1, prompt: "Make it private?" }, result: { version: 1, outcome: "accepted" }, resolvedAt: new Date(), createdByAgentId: f.assignedAgent.id, resolvedByUserId: f.ownerId }).returning() : [];
      const pending = await reserveSteeredIdentity(db, { companyId: f.companyId, runId: run!.id, issueId: f.openIssue.id, messageId: interaction?.id ?? comment!.id, source: interaction ? "interaction" : "comment" });
      await db.transaction(tx => acceptSteeredIdentity(tx, pending!));
    }
    const actor = { ...agentActor(f.companyId, f.assignedAgent.id), runId: run!.id, onBehalfOfUserId: f.ownerId, onBehalfOfMemberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] } satisfies Express.Request["actor"];
    const before = await db.select().from(issues);
    const result = await request(await createApp(db, actor)).post(`/api/companies/${f.companyId}/issues`).send({ title: "Private request", visibility: "private" });
    const personAsked = ["person-comment", "person-steering", "person-interaction", "manual-wake"].includes(cause);
    expect(result.status, JSON.stringify(result.body)).toBe(personAsked ? 201 : 403);
    if (personAsked) {
      expect(result.body).toMatchObject({ visibility: "private", responsibleUserId: f.ownerId });
      expect(await db.select().from(issues).where(eq(issues.id, result.body.id))).toEqual([expect.objectContaining({ visibility: "private", responsibleUserId: f.ownerId })]);
    } else {
      expect(result.body.error).toContain("a person must ask for it");
      expect(await db.select().from(issues)).toEqual(before);
    }
  });

  it.each(["issues", "projects", "children", "accepted-plan-decompositions"].flatMap(resource => [false, true].map(person => ({ resource, person }))))("agent-private $resource creation, person=$person", async ({ resource, person }) => {
    const f = await seedFixture();
    const documentId = randomUUID(), revisionId = randomUUID();
    if (resource === "accepted-plan-decompositions") {
      await db.insert(documents).values({ id: documentId, companyId: f.companyId, title: "Plan", format: "markdown", latestBody: "Plan", latestRevisionId: revisionId, latestRevisionNumber: 1 });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: f.companyId, documentId, revisionNumber: 1, title: "Plan", format: "markdown", body: "Plan" });
      await db.insert(issueDocuments).values({ companyId: f.companyId, issueId: f.openIssue.id, documentId, key: "plan" });
      await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.openIssue.id, kind: "request_confirmation", status: "accepted", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Approve plan?", target: { type: "issue_document", issueId: f.openIssue.id, documentId, key: "plan", revisionId, revisionNumber: 1 } }, result: { version: 1, outcome: "accepted" }, resolvedAt: new Date(), createdByUserId: f.ownerId, resolvedByUserId: f.ownerId });
    }
    const app = await createApp(db, await privacyRun(f, person));
    const readRows = () => resource === "projects" ? db.select().from(projects) : db.select().from(issues);
    const before = await readRows();
    const child = { title: "Agent request", visibility: "private", status: "backlog" };
    const result = await request(app).post(resource === "issues" || resource === "projects" ? `/api/companies/${f.companyId}/${resource}` : `/api/issues/${f.openIssue.id}/${resource}`).send(resource === "accepted-plan-decompositions" ? { acceptedPlanRevisionId: revisionId, children: [{ title: "Open child", status: "backlog" }, child] } : resource === "projects" ? { name: child.title, visibility: child.visibility } : child);
    expect(result.status, JSON.stringify(result.body)).toBe(person ? (resource === "accepted-plan-decompositions" ? 200 : 201) : 403);
    if (person) {
      const added = (await readRows()).filter(row => !before.some(old => old.id === row.id));
      const privateRow = added.find(row => row.visibility === "private")!;
      expect(privateRow).toMatchObject(resource === "projects" ? { privacyOwnerUserId: f.ownerId } : { responsibleUserId: f.ownerId });
      expect(await db.select().from(projectAccessMembers)).toEqual(expect.arrayContaining([expect.objectContaining({ subjectType: "user", subjectId: f.ownerId })]));
    } else {
      expect(result.body.error).toContain("a person must ask for it");
      expect(await readRows()).toEqual(before);
      expect(await db.select().from(issuePlanDecompositions)).toEqual([]);
    }
  });
  it.each(["issues", "projects"].flatMap(resource => [false, true].map(person => ({ resource, person }))))("agent-private $resource update, person=$person", async ({ resource, person }) => {
    const f = await seedFixture();
    const app = await createApp(db, await privacyRun(f, person));
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Open project" }).returning();
    const [before] = resource === "issues" ? await db.update(issues).set({ projectId: project!.id, responsibleUserId: f.ownerId, assigneeAgentId: f.assignedAgent.id }).where(eq(issues.id, f.openIssue.id)).returning() : [project!];
    const result = await request(app).patch(`/api/${resource}/${before!.id}`).send({ visibility: "private" });
    expect(result.status, JSON.stringify(result.body)).toBe(person ? 200 : 403);
    const [saved] = resource === "issues" ? await db.select().from(issues).where(eq(issues.id, before!.id)) : await db.select().from(projects).where(eq(projects.id, before!.id));
    if (person) {
      expect(saved).toMatchObject(resource === "projects" ? { visibility: "private", privacyOwnerUserId: f.ownerId } : { visibility: "private", responsibleUserId: f.ownerId });
      if (resource === "projects") expect(await db.select().from(projectAccessMembers)).toEqual(expect.arrayContaining([expect.objectContaining({ projectId: saved!.id, subjectType: "user", subjectId: f.ownerId })]));
    }
    else { expect(result.body.error).toContain("a person must ask for it"); expect(saved).toEqual(before); }
  });

  it.each(["no-run", "forged-person", "inactive-person", "not-owner"])("rejects agent privacy without current person authority: %s", async reason => {
    const f = await seedFixture();
    const actor = await privacyRun(f, reason !== "forged-person", reason === "not-owner" ? f.memberId : f.ownerId);
    if (reason === "no-run") delete actor.runId;
    if (reason === "forged-person") actor.onBehalfOfUserId = f.ownerId;
    if (reason === "inactive-person") await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.principalId, f.ownerId));
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Other person's project", privacyOwnerUserId: f.sharedUserId }).returning();
    const result = reason === "not-owner"
      ? await request(await createApp(db, actor)).patch(`/api/issues/${f.openIssue.id}`).send({ visibility: "private" })
      : await request(await createApp(db, actor)).post(`/api/companies/${f.companyId}/projects`).send({ name: "Private", visibility: "private" });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    if (reason === "not-owner") await request(await createApp(db, actor)).patch(`/api/projects/${project!.id}`).send({ visibility: "private" }).expect(403);
    expect((await db.select().from(projects)).find(row => row.id === project!.id)?.visibility).toBe("open");
  });

  it("preserves a person's privacy choice, agent defaults and inherited private subtasks", async () => {
    const f = await seedFixture();
    const board = await createApp(db, boardActor(f.companyId, f.ownerId));
    expect((await request(board).post(`/api/companies/${f.companyId}/issues`).send({ title: "Person's private task", visibility: "private" }).expect(201)).body).toMatchObject({ visibility: "private", responsibleUserId: f.ownerId });
    await request(board).patch(`/api/issues/${f.openIssue.id}`).send({ visibility: "private" }).expect(200);
    await request(board).post(`/api/issues/${f.openIssue.id}/access-grants`).send({ subjectType: "agent", subjectId: f.assignedAgent.id }).expect(201);
    const app = await createApp(db, { ...agentActor(f.companyId, f.assignedAgent.id), onBehalfOfUserId: f.ownerId, onBehalfOfMemberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] });
    expect((await request(app).post(`/api/companies/${f.companyId}/issues`).send({ title: "Open default" }).expect(201)).body.visibility).toBe("open");
    expect((await request(app).post(`/api/companies/${f.companyId}/issues`).send({ title: "Inherited", parentId: f.openIssue.id }).expect(201)).body.visibility).toBe("private");
    expect((await request(app).post(`/api/issues/${f.openIssue.id}/children`).send({ title: "Inherited child", status: "backlog" }).expect(201)).body.visibility).toBe("private");
  });

  it("protects personal dashboard conversations from break-glass and title writes by teammates", async () => {
    const fixture = await seedFixture();
    const issueId = fixture.privateIssueId;
    await db.update(issues).set({
      originKind: "responsibility_dashboard",
      originId: fixture.ownerId,
      projectId: null,
    }).where(eq(issues.id, issueId));
    const owner = await createApp(db, boardActor(fixture.companyId, fixture.ownerId));
    const admin = await createApp(db, boardActor(fixture.companyId, fixture.adminId));
    const member = await createApp(db, boardActor(fixture.companyId, fixture.memberId));

    await request(admin).get(`/api/issues/${issueId}?breakGlass=true&view=core`).expect(404);
    await request(member).put(`/api/issues/${issueId}/title`).send({ title: "Another title" }).expect(404);
    await request(member).put(`/api/issues/${issueId}/title`).send({
      title: "Another title", onlyIfProvisional: true,
    }).expect(404);
    await request(admin).post(`/api/issues/${issueId}/admin/force-release`).expect(404);
    const original = await request(owner).get(`/api/issues/${issueId}?view=core`).expect(200);
    expect(original.body.title).toBe("Confidential root");
    const renamed = await request(owner).put(`/api/issues/${issueId}/title`).send({ title: "My dashboard" }).expect(200);
    expect(renamed.body.title).toBe("My dashboard");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.break_glass_read"))).toEqual([]);
  });

  it("requires explicit owner/admin break-glass and records both audit evidence and an owner-visible notice", async () => {
    const fixture = await seedFixture();
    const adminApp = await createApp(db, boardActor(fixture.companyId, fixture.adminId));
    const memberApp = await createApp(db, boardActor(fixture.companyId, fixture.memberId));

    await request(adminApp).get(`/api/issues/${fixture.privateIssueId}`).expect(404);
    await request(memberApp).get(`/api/issues/${fixture.privateIssueId}?breakGlass=true`).expect(404);

    const accessed = await request(adminApp)
      .get(`/api/issues/${fixture.privateIssueId}?breakGlass=true`);
    expect(accessed.status, JSON.stringify(accessed.body)).toBe(200);
    expect(accessed.body.id).toBe(fixture.privateIssueId);

    const auditRows = await db.select().from(activityLog);
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "issue.break_glass_read",
        actorType: "user",
        actorId: fixture.adminId,
        entityType: "issue",
        entityId: fixture.privateIssueId,
      }),
    ]));
    const notices = await db.select().from(issueComments);
    expect(notices).toEqual([
      expect.objectContaining({
        issueId: fixture.privateIssueId,
        authorType: "system",
        presentation: expect.objectContaining({
          kind: "system_notice",
          title: "Break-glass access used",
          tone: "warning",
        }),
      }),
    ]);
  }, 20_000);

  it("auto-grants child-subtree access on assignment and keeps it sticky until revoke", async () => {
    const fixture = await seedFixture();
    const ownerApp = await createApp(db, boardActor(fixture.companyId, fixture.ownerId));

    const assigned = await request(ownerApp)
      .patch(`/api/issues/${fixture.privateChild.id}`)
      .send({ assigneeAgentId: fixture.assignedAgent.id });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    await request(ownerApp)
      .patch(`/api/issues/${fixture.privateChild.id}`)
      .send({ assigneeAgentId: fixture.assignedAgent.id })
      .expect(200);
    await request(ownerApp)
      .patch(`/api/issues/${fixture.privateChild.id}`)
      .send({ assigneeAgentId: null })
      .expect(200);
    const unassignedIssue = await db.select().from(issues).then((rows) => rows.find((row) => row.id === fixture.privateChild.id));
    expect(unassignedIssue?.assigneeAgentId).toBeNull();

    const grants = await db.select().from(issueAccessGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      issueId: fixture.privateChild.id,
      subjectType: "agent",
      subjectId: fixture.assignedAgent.id,
      source: "assignment",
      grantedByUserId: fixture.ownerId,
      revokedAt: null,
    });

    const readableBeforeRevoke = await request(await createApp(
      db,
      agentActor(fixture.companyId, fixture.assignedAgent.id),
    )).get(`/api/issues/${fixture.privateChild.id}`);
    expect(readableBeforeRevoke.status).toBe(200);

    await request(ownerApp)
      .post(`/api/issues/${fixture.privateChild.id}/access-grants/${grants[0]!.id}/revoke`)
      .send({})
      .expect(200);
    const deniedAfterRevoke = await request(await createApp(
      db,
      agentActor(fixture.companyId, fixture.assignedAgent.id),
    )).get(`/api/issues/${fixture.privateChild.id}`);
    expect(deniedAfterRevoke.status).toBe(404);
    expect(deniedAfterRevoke.body.error).toBe("Issue not found");
    // A private task and a missing one must give an agent the same final answer.
    const missing = await request(await createApp(
      db,
      agentActor(fixture.companyId, fixture.assignedAgent.id),
    )).get(`/api/issues/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(deniedAfterRevoke.body).toEqual(missing.body);
    expect(deniedAfterRevoke.body.code).toBe("issue_not_visible");
  }, 20_000);

  it("creates and enriches explicit grants idempotently while rejecting unauthorized and open shares", async () => {
    const fixture = await seedFixture();
    const ownerApp = await createApp(db, boardActor(fixture.companyId, fixture.ownerId));
    const nonreaderApp = await createApp(db, boardActor(fixture.companyId, fixture.memberId));

    await request(nonreaderApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id })
      .expect(404);
    await request(nonreaderApp)
      .patch(`/api/issues/${fixture.privateIssueId}`)
      .send({ assigneeAgentId: fixture.assignedAgent.id })
      .expect(404);
    const openShare = await request(ownerApp)
      .post(`/api/issues/${fixture.openIssue.id}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id });
    expect(openShare.status).toBe(409);
    expect(openShare.body.error).toContain("Open issues");

    const first = await request(ownerApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      issueId: fixture.privateIssueId,
      source: "explicit",
      subjectDisplayName: "Private Helper",
      subjectInitials: "PH",
      subjectAvatarUrl: null,
      agentVisibility: "private",
    });
    const duplicate = await request(ownerApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.id).toBe(first.body.id);

    await request(ownerApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "user", subjectId: fixture.sharedUserId })
      .expect(201);
    const listed = await request(ownerApp).get(`/api/issues/${fixture.privateIssueId}/access-grants`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subjectId: fixture.sharedUserId,
        subjectDisplayName: "Uma User",
        subjectAvatarUrl: "https://example.test/uma.png",
        subjectInitials: "UU",
        agentVisibility: null,
      }),
    ]));
    expect(await db.select().from(issueAccessGrants)).toHaveLength(2);
    const createdActivities = await db.select().from(activityLog);
    expect(createdActivities.filter((row) => row.action === "issue_access_grant.created")).toHaveLength(2);
  }, 20_000);

  it("keeps private project metadata hidden from user and agent issue grantees", async () => {
    const fixture = await seedFixture();
    await db.insert(issueAccessGrants).values([
      {
        issueId: fixture.privateIssueId,
        subjectType: "user",
        subjectId: fixture.sharedUserId,
        source: "explicit",
        grantedByUserId: fixture.ownerId,
      },
      {
        issueId: fixture.privateIssueId,
        subjectType: "agent",
        subjectId: fixture.sharedAgent.id,
        source: "explicit",
        grantedByUserId: fixture.ownerId,
      },
    ]);

    const granteeApps = [
      await createApp(db, boardActor(fixture.companyId, fixture.sharedUserId)),
      await createApp(db, agentActor(fixture.companyId, fixture.sharedAgent.id)),
    ];

    for (const app of granteeApps) {
      const detail = await request(app).get(`/api/issues/${fixture.privateIssueId}`);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(detail.body.projectId).toBe(fixture.privateProject.id);
      expect(detail.body.project).toBeNull();

      const heartbeatContext = await request(app)
        .get(`/api/issues/${fixture.privateIssueId}/heartbeat-context`);
      expect(heartbeatContext.status, JSON.stringify(heartbeatContext.body)).toBe(200);
      expect(heartbeatContext.body.issue.projectId).toBe(fixture.privateProject.id);
      expect(heartbeatContext.body.project).toBeNull();

      await request(app).get(`/api/projects/${fixture.privateProject.id}`).expect(404);

      const projectList = await request(app)
        .get(`/api/companies/${fixture.companyId}/projects`);
      expect(projectList.status, JSON.stringify(projectList.body)).toBe(200);
      expect(projectList.body.map((project: { id: string }) => project.id))
        .not.toContain(fixture.privateProject.id);

      const projectSearch = await request(app)
        .get(`/api/companies/${fixture.companyId}/search?q=Secret%20launch&scope=projects`);
      expect(projectSearch.status, JSON.stringify(projectSearch.body)).toBe(200);
      expect(projectSearch.body.results.map((project: { id: string }) => project.id))
        .not.toContain(fixture.privateProject.id);
    }
  }, 20_000);

  it("returns exact locked stubs only through visible blocker and mention edges", async () => {
    const fixture = await seedFixture();
    const visibleIssue = await db.insert(issues).values({
      companyId: fixture.companyId,
      identifier: "PRV-3",
      title: "Visible coordination issue",
      description: "Depends on PRV-1",
      status: "blocked",
      priority: "medium",
      createdByUserId: fixture.memberId,
    }).returning().then((rows) => rows[0]!);
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: fixture.privateIssueId,
      relatedIssueId: visibleIssue.id,
      type: "blocks",
    });
    await db.insert(issueReferenceMentions).values({
      companyId: fixture.companyId,
      sourceIssueId: visibleIssue.id,
      targetIssueId: fixture.privateIssueId,
      sourceKind: "description",
      sourceRecordId: null,
      documentKey: null,
      matchedText: "PRV-1",
    });

    const app = await createApp(db, boardActor(fixture.companyId, fixture.memberId));
    const detail = await request(app).get(`/api/issues/${visibleIssue.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const expectedStub = { id: fixture.privateIssueId, identifier: "PRV-1", locked: true };
    expect(detail.body.blockedBy).toEqual([expectedStub]);
    expect(detail.body.relatedWork.outbound[0].issue).toEqual(expectedStub);
    expect(JSON.stringify(detail.body)).not.toContain("Confidential root");

    const direct = await request(app).get(`/api/issues/${fixture.privateIssueId}`);
    expect(direct.status).toBe(404);

    const list = await request(app)
      .get(`/api/companies/${fixture.companyId}/issues?includeBlockedBy=true`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.map((row: { id: string }) => row.id)).not.toContain(fixture.privateIssueId);
    const visibleRow = list.body.find((row: { id: string }) => row.id === visibleIssue.id);
    expect(visibleRow.blockedBy).toEqual([expectedStub]);

    const search = await request(app)
      .get(`/api/companies/${fixture.companyId}/search?q=Confidential%20root&scope=issues`);
    expect(search.status).toBe(200);
    expect(search.body.results.map((row: { id: string }) => row.id)).not.toContain(fixture.privateIssueId);
  }, 20_000);
});
