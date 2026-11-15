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
// tasks (not done, not cancelled, not hidden, not chats) next to the total.
describeEmbeddedPostgres("project open task count and status", () => {
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
      { id: emptyProjectId, companyId, name: "Empty", status: "planned" },
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
    ]);

    return { companyId, projectId, finishedProjectId, emptyProjectId };
  }

  async function listById(companyId: string) {
    const res = await request(createApp(db, boardActor(companyId))).get(`/api/companies/${companyId}/projects`);
    expect(res.status).toBe(200);
    return new Map<string, { taskCount?: number; openTaskCount?: number; status: string }>(
      res.body.map((project: { id: string; taskCount?: number; openTaskCount?: number; status: string }) => [
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

  it("persists a project status change from the board", async () => {
    const { companyId, finishedProjectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).patch(`/api/projects/${finishedProjectId}`).send({ status: "completed" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    const [row] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, finishedProjectId));
    expect(row?.status).toBe("completed");
    const byId = await listById(companyId);
    expect(byId.get(finishedProjectId)?.status).toBe("completed");
  });
});
