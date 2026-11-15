import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { projectRoutes } from "../routes/projects.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project open task count tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", projectRoutes(db));
  app.use(errorHandler);
  return app;
}

// A project reads finished when its work is done: the list row counts open
// tasks (not done, not cancelled, not hidden, not chats) next to the total,
// and the project's pill is derived from those tasks, not the stored status.
describeEmbeddedPostgres("project open task count and derived status", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-open-task-count-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const finishedProjectId = randomUUID();
    const emptyProjectId = randomUUID();
    const hiddenOnlyProjectId = randomUUID();
    const waitingProjectId = randomUUID();
    const resumedProjectId = randomUUID();
    const restartedProjectId = randomUUID();
    const chatOnlyProjectId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Busy", status: "in_progress" },
      { id: finishedProjectId, companyId, name: "Finished", status: "in_progress" },
      { id: emptyProjectId, companyId, name: "Empty", status: "completed" },
      { id: hiddenOnlyProjectId, companyId, name: "Hidden only", status: "planned" },
      { id: waitingProjectId, companyId, name: "Waiting", status: "in_progress" },
      { id: resumedProjectId, companyId, name: "Resumed", status: "backlog" },
      { id: restartedProjectId, companyId, name: "Restarted", status: "backlog" },
      { id: chatOnlyProjectId, companyId, name: "Chat only", status: "in_progress" },
    ]);
    await db.insert(issues).values([
      { companyId, projectId, title: "Open todo", status: "todo" },
      { companyId, projectId, title: "Open in progress", status: "in_progress" },
      { companyId, projectId, title: "Done", status: "done" },
      { companyId, projectId, title: "Cancelled", status: "cancelled" },
      { companyId, projectId, title: "Hidden todo", status: "todo", hiddenAt: new Date() },
      {
        companyId,
        projectId,
        title: "Chat",
        status: "todo",
        assigneeAgentId: agentId,
        conversationAgentId: agentId,
        conversationUserId: "user-1",
        conversationState: "active",
      },
      { companyId, projectId: finishedProjectId, title: "Only task, cancelled", status: "cancelled" },
      { companyId, projectId: hiddenOnlyProjectId, title: "Hidden in progress", status: "in_progress", hiddenAt: new Date() },
      { companyId, projectId: waitingProjectId, title: "Backlog", status: "backlog" },
      { companyId, projectId: waitingProjectId, title: "Todo", status: "todo" },
      { companyId, projectId: waitingProjectId, title: "Cancelled before it began", status: "cancelled" },
      { companyId, projectId: resumedProjectId, title: "Shipped", status: "done" },
      { companyId, projectId: resumedProjectId, title: "Next up", status: "todo" },
      // Started once, then put back to todo: it has begun.
      { companyId, projectId: restartedProjectId, title: "Put back", status: "todo", startedAt: new Date() },
      {
        companyId,
        projectId: chatOnlyProjectId,
        title: "Chat in progress",
        status: "in_progress",
        assigneeAgentId: agentId,
        conversationAgentId: agentId,
        conversationUserId: "user-2",
        conversationState: "active",
      },
    ]);

    return {
      companyId,
      projectId,
      finishedProjectId,
      emptyProjectId,
      hiddenOnlyProjectId,
      waitingProjectId,
      resumedProjectId,
      restartedProjectId,
      chatOnlyProjectId,
    };
  }

  type ListedProject = { id: string; taskCount?: number; openTaskCount?: number; derivedStatus?: string; status: string };

  async function listById(companyId: string) {
    const res = await request(createApp(db, boardActor(companyId))).get(`/api/companies/${companyId}/projects`);
    expect(res.status).toBe(200);
    return new Map<string, ListedProject>(
      res.body.map((project: ListedProject) => [
        project.id,
        project,
      ]),
    );
  }

  it("counts open tasks, excluding done, cancelled, hidden and chats", async () => {
    const { companyId, projectId, finishedProjectId, emptyProjectId } = await seed();
    const byId = await listById(companyId);

    expect(byId.get(projectId)?.openTaskCount).toBe(2);
    expect(byId.get(finishedProjectId)?.openTaskCount).toBe(0);
    expect(byId.get(emptyProjectId)?.openTaskCount).toBe(0);
  });

  it("keeps taskCount as the total of non-chat tasks", async () => {
    const { companyId, projectId, finishedProjectId, emptyProjectId } = await seed();
    const byId = await listById(companyId);

    // todo, in_progress, done, cancelled, hidden todo; the chat is excluded.
    expect(byId.get(projectId)?.taskCount).toBe(5);
    expect(byId.get(finishedProjectId)?.taskCount).toBe(1);
    expect(byId.get(emptyProjectId)?.taskCount).toBe(0);
  });

  it("derives the pill from the tasks on the list: In progress, Done or Not started", async () => {
    const seeded = await seed();
    const byId = await listById(seeded.companyId);

    // An open task that has begun (in progress).
    expect(byId.get(seeded.projectId)?.derivedStatus).toBe("in_progress");
    // Every task done or cancelled; the stored status says in_progress.
    expect(byId.get(seeded.finishedProjectId)?.derivedStatus).toBe("done");
    // Hidden-only: tasks exist and none is open, so Done (hidden is not work left).
    expect(byId.get(seeded.hiddenOnlyProjectId)?.derivedStatus).toBe("done");
    // No tasks; the stored status says completed.
    expect(byId.get(seeded.emptyProjectId)?.derivedStatus).toBe("not_started");
    // Open tasks, all still backlog or todo and never started.
    expect(byId.get(seeded.waitingProjectId)?.derivedStatus).toBe("not_started");
    // A task already done and one still to do: work has begun.
    expect(byId.get(seeded.resumedProjectId)?.derivedStatus).toBe("in_progress");
    // A todo that was started once has begun.
    expect(byId.get(seeded.restartedProjectId)?.derivedStatus).toBe("in_progress");
    // Chats are not tasks.
    expect(byId.get(seeded.chatOnlyProjectId)?.derivedStatus).toBe("not_started");
  });

  it("returns the same derived status on the project's own payload", async () => {
    const seeded = await seed();
    const app = createApp(db, boardActor(seeded.companyId));
    const byId = await listById(seeded.companyId);

    for (const [projectId, expected] of [
      [seeded.projectId, "in_progress"],
      [seeded.finishedProjectId, "done"],
      [seeded.hiddenOnlyProjectId, "done"],
      [seeded.emptyProjectId, "not_started"],
      [seeded.waitingProjectId, "not_started"],
    ] as const) {
      const res = await request(app).get(`/api/projects/${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body.derivedStatus).toBe(expected);
      expect(res.body.derivedStatus).toBe(byId.get(projectId)?.derivedStatus);
    }
  });

  it("leaves the stored status alone and does not read it for the pill", async () => {
    const { companyId, projectId, finishedProjectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).patch(`/api/projects/${projectId}`).send({ status: "completed" });
    expect(res.status).toBe(200);

    const byId = await listById(companyId);
    expect(byId.get(projectId)?.status).toBe("completed");
    expect(byId.get(projectId)?.derivedStatus).toBe("in_progress");
    // Reading the list never writes the stored status.
    const [finished] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, finishedProjectId));
    expect(finished?.status).toBe("in_progress");
    expect(byId.get(finishedProjectId)?.derivedStatus).toBe("done");
  });
});
