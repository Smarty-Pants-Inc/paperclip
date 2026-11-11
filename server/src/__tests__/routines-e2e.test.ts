import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  companySecretVersions,
  companySecretBindings,
  secretAccessEvents,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  principalPermissionGrants,
  projectAccessMembers,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { accessService } from "../services/access.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";

function registerRoutineServiceMock() {
  vi.doMock("../services/routines.js", async () => {
    const actual = await vi.importActual<typeof import("../services/routines.js")>("../services/routines.js");

    return {
      ...actual,
      routineService: (db: any) =>
        actual.routineService(db, {
          heartbeat: {
            wakeup: async (agentId: string, wakeupOpts: any) => {
              const issueId =
                (typeof wakeupOpts?.payload?.issueId === "string" && wakeupOpts.payload.issueId) ||
                (typeof wakeupOpts?.contextSnapshot?.issueId === "string" && wakeupOpts.contextSnapshot.issueId) ||
                null;
              if (!issueId) return null;

              const issue = await db
                .select({ companyId: issues.companyId })
                .from(issues)
                .where(eq(issues.id, issueId))
                .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);
              if (!issue) return null;

              const queuedRunId = randomUUID();
              await db.insert(heartbeatRuns).values({
                id: queuedRunId,
                companyId: issue.companyId,
                agentId,
                invocationSource: wakeupOpts?.source ?? "assignment",
                triggerDetail: wakeupOpts?.triggerDetail ?? null,
                status: "queued",
                contextSnapshot: { ...(wakeupOpts?.contextSnapshot ?? {}), issueId },
              });
              await db
                .update(issues)
                .set({
                  executionRunId: queuedRunId,
                  executionLockedAt: new Date(),
                })
                .where(eq(issues.id, issueId));
              return { id: queuedRunId };
            },
          },
        }),
    };
  });
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routine routes end-to-end", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routines-e2e-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(routineDocuments);
    await db.delete(routines);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/access.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/companies.js");
    vi.doUnmock("../services/projects.js");
    vi.doUnmock("../services/company-skills.js");
    vi.doUnmock("../services/assets.js");
    vi.doUnmock("../services/agent-instructions.js");
    vi.doUnmock("../services/workspace-runtime.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/routines.js");
    vi.doUnmock("../routes/routines.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRoutineServiceMock();
    vi.doMock("../services/index.js", async () => {
      const [{ accessService }, { documentAnnotationService }, { logActivity }, { routineService }] = await Promise.all([
        import("../services/access.js"), import("../services/document-annotations.js"),
        import("../services/activity-log.js"), import("../services/routines.js"),
      ]);
      return { accessService, documentAnnotationService, logActivity, routineService };
    });
    vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));
    vi.clearAllMocks();
  });

  async function createApp(actor: Record<string, unknown>, includeLinkedResourceRoutes = false) {
    const { errorHandler } = await import("../middleware/index.js");
    const { routineRoutes } = await import("../routes/routines.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", routineRoutes(db));
    if (includeLinkedResourceRoutes) {
      const { issueRoutes } = await import("../routes/issues.js");
      const { projectRoutes } = await import("../routes/projects.js");
      app.use("/api", issueRoutes(db, {} as any));
      app.use("/api", projectRoutes(db));
    }
    app.use(errorHandler);
    return app;
  }

  async function createAuthenticatedApp() {
    const { actorMiddleware } = await import("../middleware/auth.js");
    const { routineRoutes } = await import("../routes/routines.js");
    const { errorHandler } = await import("../middleware/index.js");
    const resolveSession = vi.fn(async () => null);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
    app.use("/api", routineRoutes(db));
    app.use(errorHandler);
    return { app, resolveSession };
  }

  async function postRoutineRun(
    app: express.Express,
    routineId: string,
    body: Record<string, unknown>,
  ) {
    let response = await request(app)
      .post(`/api/routines/${routineId}/run`)
      .send(body);
    if (response.status === 500) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      response = await request(app)
        .post(`/api/routines/${routineId}/run`)
        .send(body);
    }
    return response;
  }

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const userId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routine Project",
      status: "in_progress",
    });

    const access = accessService(db);
    const membership = await access.ensureMembership(companyId, "user", userId, "owner", "active");
    await access.setMemberPermissions(
      companyId,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      userId,
    );

    return { companyId, agentId, projectId, userId };
  }

  function routineResourceRequests(app: express.Express, routineId: string, triggerId = routineId) {
    const path = `/api/routines/${encodeURIComponent(routineId)}`;
    const triggerPath = `/api/routine-triggers/${encodeURIComponent(triggerId)}`;
    const nestedId = "12345678-1234-4234-8234-123456789abc";
    return [
      request(app).get(path),
      request(app).get(`${path}/runs`),
      request(app).get(`${path}/revisions`),
      request(app).get(`${path}/description/annotations`),
      request(app).get(`${path}/description/annotations/${nestedId}`),
      request(app).post(`${path}/description/annotations`).send({
        baseRevisionId: nestedId, baseRevisionNumber: 1, body: "Review this text",
        selector: {
          quote: { exact: "text" },
          position: { normalizedStart: 0, normalizedEnd: 4, markdownStart: 0, markdownEnd: 4 },
        },
      }),
      request(app).post(`${path}/description/annotations/${nestedId}/comments`).send({ body: "Review" }),
      request(app).patch(`${path}/description/annotations/${nestedId}`).send({ status: "resolved" }),
      request(app).patch(path).send({ title: "Updated routine" }),
      request(app).post(`${path}/revisions/${nestedId}/restore`).send({}),
      request(app).post(`${path}/triggers`).send({ kind: "api" }),
      request(app).post(`${path}/run`).send({}),
      request(app).patch(triggerPath).send({ enabled: false }),
      request(app).delete(triggerPath),
      request(app).post(`${triggerPath}/rotate-secret`).send({}),
    ];
  }

  it("returns not found without queries for malformed routine and trigger IDs on every resource route", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const actors = [
      { type: "board", userId, source: "session", companyIds: [companyId] },
      { type: "agent", agentId, companyId },
      { type: "none" },
    ];
    const fullId = "12345678-1234-4234-8234-123456789abc";
    for (const actor of actors) {
      const app = await createApp(actor);
      const spies = [
        vi.spyOn(db, "select"), vi.spyOn(db, "insert"),
        vi.spyOn(db, "update"), vi.spyOn(db, "delete"),
      ];
      try {
        for (const id of [fullId.slice(0, 8), "not-a-uuid", ` ${fullId}`, `${fullId}\n`, `{${fullId}\n}`]) {
          for (const pending of routineResourceRequests(app, id)) {
            const response = await pending;
            expect(response.status, JSON.stringify(response.body)).toBe(404);
            expect(response.body).toEqual({ error: pending.url.includes("/routine-triggers/")
              ? "Routine trigger not found" : "Routine not found" });
          }
        }
        const invalidBody = await request(app).patch("/api/routines/not-a-uuid").send({ title: 42 });
        expect(invalidBody.status).toBe(400);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
    }
  }, 20_000);

  it("keeps missing and cross-company routine resources indistinguishable", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, assigneeAgentId: agentId, title: "Private routine" });
    await db.insert(routineTriggers).values({ id: triggerId, companyId, routineId, kind: "api" });
    for (const actor of [
      { type: "board", userId, source: "session", isInstanceAdmin: true, companyIds: [randomUUID()] },
      { type: "agent", agentId: randomUUID(), companyId: randomUUID() },
      { type: "none" },
    ]) {
      const app = await createApp(actor);
      for (const [id, tid] of [[routineId, triggerId], [routineId.toUpperCase(), `{${triggerId}}`], [randomUUID(), randomUUID()]]) {
        for (const pending of routineResourceRequests(app, id!, tid!)) {
          const response = await pending;
          expect(response.status, JSON.stringify(response.body)).toBe(404);
          expect(response.body).toEqual({ error: pending.url.includes("/routine-triggers/")
            ? "Routine trigger not found" : "Routine not found" });
        }
      }
    }
    expect(await db.select().from(routines)).toMatchObject([{ id: routineId, title: "Private routine" }]);
    expect(await db.select().from(routineTriggers)).toMatchObject([{ id: triggerId, enabled: true }]);
    expect(await db.select().from(activityLog)).toEqual([]);
  }, 20_000);

  it("preserves UUID routine reads and assignee-only mutations", async () => {
    const { companyId, agentId, userId } = await seedFixture();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(routines).values({ id: routineId, companyId, assigneeAgentId: agentId, title: "Private routine" });
    await db.insert(routineTriggers).values({ id: triggerId, companyId, routineId, kind: "api" });
    const owner = await createApp({ type: "agent", agentId, companyId });
    const otherAgent = await createApp({ type: "agent", agentId: randomUUID(), companyId });
    const board = await createApp({ type: "board", userId, source: "session", companyIds: [companyId] });
    for (const app of [owner, otherAgent, board]) {
      const response = await request(app).get(`/api/routines/${routineId.toUpperCase()}`);
      expect(response.status).toBe(200);
      expect(response.body.id).toBe(routineId);
    }
    for (const [index, pending] of routineResourceRequests(otherAgent, routineId, triggerId).entries()) {
      const response = await pending;
      expect(response.status, JSON.stringify(response.body)).toBe(index < 2 ? 200 : 403);
    }
    const updated = await request(owner).patch(`/api/routines/${routineId}`).send({ title: "Owner update" });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.title).toBe("Owner update");
    const changedTrigger = await request(board).patch(`/api/routine-triggers/${triggerId}`).send({ enabled: false });
    expect(changedTrigger.status, JSON.stringify(changedTrigger.body)).toBe(200);
    expect(changedTrigger.body.enabled).toBe(false);
  }, 20_000);

  it.each(["detail", "list", "runs"] as const)(
    "redacts unreadable linked resources from routine %s responses without hiding readable references",
    async (surface) => {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
      // Direct GETs and routine reads must use real services and authorization.
      // Keep only the existing heartbeat stub; these fixtures never dispatch work.
      vi.doUnmock("../services/index.js");
      const { companyId, agentId, projectId } = await seedFixture();
      const includedUserId = randomUUID();
      const excludedUserId = randomUUID();
      await db.insert(companyMemberships).values([includedUserId, excludedUserId].map((principalId) => ({
        companyId, principalType: "user", principalId, membershipRole: "operator", status: "active",
      })));
      const [publicProject] = await db.update(projects).set({
        description: "Public routine project description", targetDate: "2036-08-15",
      }).where(eq(projects.id, projectId)).returning();
      const [privateProject] = await db.insert(projects).values({
        companyId, visibility: "private", name: "CLASSIFIED routine project ORCHID",
        description: "CLASSIFIED project description ORCHID", targetDate: "2097-11-23",
      }).returning();
      await db.insert(projectAccessMembers).values({
        companyId, projectId: privateProject!.id, subjectType: "user", subjectId: includedUserId,
      });
      const privateMarkers = [privateProject!.name, privateProject!.description!, privateProject!.targetDate!];
      const fixtures: Array<{
        routineId: string; runId: string; readableByB: boolean;
        project: typeof projects.$inferSelect;
        parentIssue: typeof issues.$inferSelect;
        executionIssue: typeof issues.$inferSelect;
        publicRunId: string; publicIssue: typeof issues.$inferSelect;
      }> = [];
      // Exercise project privacy independently of issue privacy, and preserve
      // ordinary references rather than blanket-redacting every embedded object.
      for (const [index, kind] of ["private-project", "private-issue", "public"].entries()) {
        const routineId = randomUUID();
        const runId = randomUUID();
        const heartbeatRunId = randomUUID();
        const project = kind === "private-project" ? privateProject! : publicProject!;
        const readableByB = kind === "public";
        const marker = readableByB ? "PUBLIC" : `CLASSIFIED ${kind}`;
        const updatedAt = new Date(readableByB ? "2038-06-04T10:20:30.000Z" : "2098-12-17T13:42:19.000Z");
        await db.insert(heartbeatRuns).values({ id: heartbeatRunId, companyId, agentId, status: "running" });
        const [parentIssue, executionIssue] = await db.insert(issues).values([
          {
            id: randomUUID(), companyId, projectId: project.id,
            title: `${marker} parent title`, description: `${marker} parent description`,
            visibility: kind === "private-issue" ? "private" : "open",
            responsibleUserId: includedUserId, createdByUserId: includedUserId, updatedAt,
          },
          {
            id: randomUUID(), companyId, projectId: project.id,
            identifier: `RV-${index + 1}`, title: `${marker} execution title`, description: `${marker} execution description`,
            visibility: kind === "private-issue" ? "private" : "open",
            responsibleUserId: includedUserId, createdByUserId: includedUserId, updatedAt,
            status: "in_progress", priority: "high", originKind: "routine_execution",
            originId: routineId, originRunId: runId, executionRunId: heartbeatRunId,
          },
        ]).returning();
        await db.insert(routines).values({
          id: routineId, companyId, projectId: project.id, parentIssueId: parentIssue!.id,
          assigneeAgentId: agentId, title: `Reference routine ${index + 1}`,
        });
        await db.insert(routineRuns).values({
          id: runId, companyId, routineId, source: "manual", status: "issue_created", linkedIssueId: executionIssue!.id,
        });
        // Mixed history in the same response: an older open issue remains
        // readable even when the latest linked issue is private.
        const publicRunId = randomUUID();
        const [publicIssue] = await db.insert(issues).values({
          companyId, projectId, title: `PUBLIC historical execution ${index + 1}`, status: "done",
          originKind: "routine_execution", originId: routineId, originRunId: publicRunId,
        }).returning();
        await db.insert(routineRuns).values({
          id: publicRunId, companyId, routineId, source: "manual", status: "issue_created",
          linkedIssueId: publicIssue!.id, createdAt: new Date("2020-01-01T00:00:00.000Z"),
        });
        if (!readableByB) privateMarkers.push(
          parentIssue!.title, parentIssue!.description!, executionIssue!.title, executionIssue!.description!, updatedAt.toISOString(),
        );
        fixtures.push({
          routineId, runId, project, parentIssue: parentIssue!, executionIssue: executionIssue!, readableByB,
          publicRunId, publicIssue: publicIssue!,
        });
      }
      const included = await createApp({
        type: "board", userId: includedUserId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
      }, true);
      const excluded = await createApp({
        type: "board", userId: excludedUserId, source: "session", isInstanceAdmin: false, companyIds: [companyId],
      }, true);

      for (const fixture of fixtures) {
        // Establish actual direct-resource access, not a mocked allow/deny table.
        for (const [app, readable] of [[included, true], [excluded, fixture.readableByB]] as const) {
          await request(app).get(`/api/projects/${fixture.project.id}`)
            .expect(fixture.project.visibility === "open" || readable ? 200 : 404);
          await request(app).get(`/api/issues/${fixture.parentIssue.id}`).expect(readable ? 200 : 404);
          await request(app).get(`/api/issues/${fixture.executionIssue.id}`).expect(readable ? 200 : 404);
          await request(app).get(`/api/issues/${fixture.publicIssue.id}`).expect(200);
        }
      }
      for (const [app, isIncluded] of [[included, true], [excluded, false]] as const) {
        // The list is checked as a whole, so a leak in a sibling row cannot hide.
        const list = surface === "list"
          ? await request(app).get(`/api/companies/${companyId}/routines`).expect(200)
          : null;
        for (const fixture of fixtures) {
          const response = list ?? await request(app)
            .get(`/api/routines/${fixture.routineId}${surface === "runs" ? "/runs" : ""}`).expect(200);
          const item = surface === "list"
            ? response.body.find((row: { id: string }) => row.id === fixture.routineId)
            : response.body;
          const readable = isIncluded || fixture.readableByB;
          const summary = {
            id: fixture.executionIssue.id, identifier: fixture.executionIssue.identifier,
            title: fixture.executionIssue.title, status: fixture.executionIssue.status,
            priority: fixture.executionIssue.priority, updatedAt: fixture.executionIssue.updatedAt.toISOString(),
          };
          if (surface !== "runs") {
            expect(item).toMatchObject({
              id: fixture.routineId, projectId: fixture.project.id, parentIssueId: fixture.parentIssue.id,
            });
            expect.soft(item.activeIssue).toEqual(readable ? expect.objectContaining(summary) : null);
          }
          if (surface === "detail") {
            expect.soft(item.project).toEqual(fixture.project.visibility === "open" || readable
              ? expect.objectContaining({
                id: fixture.project.id, name: fixture.project.name,
                description: fixture.project.description, targetDate: fixture.project.targetDate,
              }) : null);
            expect.soft(item.parentIssue).toEqual(readable ? expect.objectContaining({
              id: fixture.parentIssue.id, title: fixture.parentIssue.title, description: fixture.parentIssue.description,
            }) : null);
            if (readable) expect(item.activeIssue.description).toBe(fixture.executionIssue.description);
          }
          const runs = surface === "detail" ? item.recentRuns : surface === "list" ? [item.lastRun] : response.body;
          const expectedRuns = [expect.objectContaining({
            id: fixture.runId, linkedIssueId: fixture.executionIssue.id,
            linkedIssue: readable ? expect.objectContaining(summary) : null,
          })];
          if (surface !== "list") expectedRuns.push(expect.objectContaining({
            id: fixture.publicRunId, linkedIssueId: fixture.publicIssue.id,
            linkedIssue: expect.objectContaining({
              id: fixture.publicIssue.id, title: fixture.publicIssue.title, status: fixture.publicIssue.status,
              priority: fixture.publicIssue.priority, updatedAt: fixture.publicIssue.updatedAt.toISOString(),
            }),
          }));
          expect.soft(runs).toEqual(expectedRuns);
          if (!isIncluded) {
            const json = JSON.stringify(response.body);
            for (const marker of privateMarkers) expect.soft(json).not.toContain(marker);
          }
        }
      }
    }, 60_000,
  );

  it.each(["bearer", "hmac_sha256", "github_hmac", "none"] as const)(
    "authenticates %s HTTP deliveries, persists payloads, and enforces trigger lifecycle",
    async (signingMode) => {
      vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
      vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
      const { companyId, agentId, projectId, userId } = await seedFixture();
      const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
      const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
        projectId, assigneeAgentId: agentId, title: "Webhook {{event}}",
        description: "Handle {{event}}", variables: [{ name: "event", type: "text", required: true }],
        concurrencyPolicy: "always_enqueue",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const routineId = created.body.id;
      const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode });
      expect(configured.status, JSON.stringify(configured.body)).toBe(201);
      const { trigger, secretMaterial } = configured.body;
      const detail = await request(board).get(`/api/routines/${routineId}`);
      expect(detail.body.triggers[0].webhookUrl).toBe(secretMaterial.webhookUrl);
      const path = new URL(secretMaterial.webhookUrl).pathname;
      const [{ actorMiddleware }, { boardMutationGuard }, { routineRoutes }, { errorHandler }] = await Promise.all([
        import("../middleware/auth.js"), import("../middleware/board-mutation-guard.js"),
        import("../routes/routines.js"), import("../middleware/error-handler.js"),
      ]);
      const ingress = express();
      ingress.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
      ingress.use(actorMiddleware(db, {
        deploymentMode: "authenticated",
        // A webhook must not acquire an ambient board session or need CSRF headers.
        resolveSession: async () => { throw new Error("Webhook must not resolve a browser session"); },
      }));
      ingress.use("/api", boardMutationGuard(), routineRoutes(db));
      ingress.use(errorHandler);
      const raw = '{ "event": "deploy", "detail": { "text": "café" } }';
      const timestamp = String(Math.floor(Date.now() / 1000));
      function delivery(secret = secretMaterial.webhookSecret, body = raw, ts = timestamp) {
        const req = request(ingress).post(path).set("Content-Type", "application/json");
        if (signingMode === "bearer") req.set("Authorization", `Bearer ${secret}`);
        if (signingMode === "hmac_sha256") {
          req.set("X-Paperclip-Timestamp", ts).set("X-Paperclip-Signature",
            `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex")}`);
        }
        if (signingMode === "github_hmac") req.set("X-Hub-Signature-256",
          `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
        return req.send(body);
      }
      if (signingMode !== "none") expect((await delivery("wrong-secret")).status).toBe(401);
      if (signingMode === "hmac_sha256" || signingMode === "github_hmac") {
        expect((await delivery(undefined, raw.replace("deploy", "tampered"))).status).toBe(401);
      }
      if (signingMode === "hmac_sha256") {
        expect((await delivery(undefined, raw, "1")).status).toBe(401);
        const malformed = await request(ingress).post(path).set("Content-Type", "application/json")
          .set("X-Paperclip-Timestamp", timestamp).set("X-Paperclip-Signature", "é".repeat(64)).send(raw);
        expect(malformed.status).toBe(401);
      }
      expect((await request(ingress).post(path).type("text").send(raw)).status).toBe(415);
      expect((await request(ingress).post(path).send([])).status).toBe(400);
      const accepted = await delivery();
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
      expect(accepted.body).toMatchObject({ source: "webhook", status: "issue_created" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, accepted.body.linkedIssueId));
      expect(issue).toMatchObject({ companyId, assigneeAgentId: agentId, title: "Webhook deploy", description: "Handle deploy" });
      const history = await request(board).get(`/api/routines/${routineId}/runs`);
      expect(history.body[0].triggerPayload).toMatchObject({ event: "deploy", detail: { text: "café" } });
      await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, issue.id));
      if (signingMode === "hmac_sha256") {
        expect((await delivery()).status).toBe(409);
      } else {
        const first = await delivery().set("Idempotency-Key", "delivery-2");
        const retry = await delivery().set("Idempotency-Key", "delivery-2");
        expect(retry.status).toBe(202);
        expect(retry.body.id).toBe(first.body.id);
        await db.update(issues).set({ status: "done", executionRunId: null }).where(eq(issues.id, first.body.linkedIssueId));
      }
      if (signingMode !== "none") {
        const rotated = await request(board).post(`/api/routine-triggers/${trigger.id}/rotate-secret`).send({});
        expect(rotated.status).toBe(200);
        expect(rotated.body.trigger.lastWebhookDelivery).toBeNull();
        expect((await delivery()).status).toBe(401);
        expect((await delivery(rotated.body.secretMaterial.webhookSecret)).status).toBe(202);
      }
      await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: false });
      expect((await delivery()).status).toBe(409);
      await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ enabled: true });
      await request(board).patch(`/api/routines/${routineId}`).send({ status: "paused" });
      expect((await delivery()).status).toBe(409);
    },
  );

  it("uses the normal public webhook for verified caller provenance and routine-wide receipts", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Ordinary webhook", concurrencyPolicy: "always_enqueue",
    });
    expect(created.status).toBe(201);
    const routineId = created.body.id;
    const a = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "app_webhook" });
    const b = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "app_webhook" });
    expect(a.status).toBe(201); expect(b.status).toBe(201);
    const [source] = await db.insert(issues).values({ companyId, title: "Caller source", createdByUserId: userId }).returning();
    const [caller] = await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: source!.id, status: "running" }).returning();
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", caller!.id)!;
    const { app: publicApp, resolveSession } = await createAuthenticatedApp();
    const delivery = (config: typeof a.body, scope = "routine") => request(publicApp)
      .post(new URL(config.secretMaterial.webhookUrl).pathname)
      .set("Authorization", `Bearer ${config.secretMaterial.webhookSecret}`)
      .set("X-Paperclip-Source-Run-Token", token).set("X-Paperclip-Idempotency-Scope", scope)
      .set("Idempotency-Key", "external-occurrence-1").send({ event: "any-provider.failure", createdByRunId: randomUUID() });
    expect((await delivery(a.body, "global")).status).toBe(400);
    const first = await delivery(a.body), retry = await delivery(b.body);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    expect(retry.status).toBe(202);
    expect(first.body.createdByRunId).toBe(caller!.id);
    expect(retry.body.id).toBe(first.body.id);
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(2);
    expect(resolveSession).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, caller!.id));
    expect((await delivery(a.body)).status).toBe(401);
    expect(await db.select().from(routineRuns)).toHaveLength(1);
    const removedPath = new URL(a.body.secretMaterial.webhookUrl).pathname.replace(/\/fire$/, "/sentry-run-failures");
    expect((await request(publicApp).post(removedPath).send({})).status).toBe(404);
  });

  it("preserves the authenticated caller and upstream routine through the routine HTTP API", async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID().repeat(2));
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const create = (title: string) => request(board).post(`/api/companies/${companyId}/routines`)
      .send({ projectId, assigneeAgentId: agentId, title });
    const upstream = await create("Upstream routine"), downstream = await create("API consumer");
    expect(upstream.status).toBe(201); expect(downstream.status).toBe(201);
    const source = await request(board).post(`/api/routines/${upstream.body.id}/run`).send({});
    expect(source.status, JSON.stringify(source.body)).toBe(202);
    const [task] = await db.select().from(issues).where(eq(issues.id, source.body.linkedIssueId));
    const [caller] = await db.update(heartbeatRuns).set({ status: "running" })
      .where(eq(heartbeatRuns.id, task!.executionRunId!)).returning();
    const { app } = await createAuthenticatedApp();
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", caller!.id)!;
    const response = await request(app).post(`/api/routines/${downstream.body.id}/run`)
      .set("Authorization", `Bearer ${token}`).send({ source: "api" });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.createdByRunId).toBe(caller!.id);
    const [receipt] = await db.select().from(routineRuns).where(eq(routineRuns.id, response.body.id));
    expect(receipt?.createdByRunId).toBe(caller!.id);
    const { readTaskCreationProvenance } = await import("../services/task-creation-provenance.js");
    expect(await readTaskCreationProvenance(db, companyId, response.body.linkedIssueId))
      .toEqual({ status: "complete", routineIds: [upstream.body.id, downstream.body.id].sort(), shareable: true });
  });

  it("keeps setup deliveries out of runs, persists test receipts, and restores removed triggers", async () => {
    vi.stubEnv("PAPERCLIP_API_URL", "http://localhost:3100");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "false");
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const board = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    const created = await request(board).post(`/api/companies/${companyId}/routines`).send({
      projectId, assigneeAgentId: agentId, title: "Verify deployment", description: "Inspect deployment", concurrencyPolicy: "always_enqueue",
    });
    expect(created.status).toBe(201);
    const routineId = created.body.id;
    const configured = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "webhook", signingMode: "bearer", setupPending: true });
    expect(configured.status).toBe(201);
    const { trigger, secretMaterial } = configured.body;
    const path = new URL(secretMaterial.webhookUrl).pathname;
    const publicApp = await createApp({ type: "none" });
    const deliver = (key: string, secret = secretMaterial.webhookSecret) => request(publicApp).post(path).set("Authorization", `Bearer ${secret}`).set("Idempotency-Key", key).send({ event: "deployment.completed" });
    await request(board).patch(`/api/routines/${routineId}`).send({ status: "paused" });
    expect((await deliver("bad", "wrong")).status).toBe(401);
    let detail = await request(board).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0]).toMatchObject({ setupPending: true, lastWebhookDelivery: { status: "rejected", test: true } });
    const tested = await deliver("setup-event");
    expect(tested.status, JSON.stringify(tested.body)).toBe(202);
    expect(tested.body).toMatchObject({ status: "test_received", routineStarted: false, linkedIssueId: null });
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    // Read through a fresh app instance to prove the state is database-backed.
    const reopened = await createApp({ type: "board", source: "local_implicit", userId, isInstanceAdmin: true });
    detail = await request(reopened).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0]).toMatchObject({ setupPending: true, lastWebhookDelivery: { status: "received", test: true } });
    expect(JSON.stringify(detail.body)).not.toContain(secretMaterial.webhookSecret);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: false })).status).toBe(200);
    await request(board).patch(`/api/routines/${routineId}`).send({ status: "active" });
    expect((await deliver("setup-event")).body.status).toBe("test_received");
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    const live = await deliver("live-event");
    expect(live.status, JSON.stringify(live.body)).toBe(202);
    expect(live.body.status).toBe("issue_created");
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await deliver("live-event")).body.id).toBe(live.body.id);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "routine.run_triggered"))).toHaveLength(1);
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ setupPending: true })).status).toBe(400);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ archived: true })).status).toBe(200);
    expect((await deliver("removed-event")).status).toBe(404);
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(0);
    expect((await request(board).patch(`/api/routine-triggers/${trigger.id}`).send({ archived: false })).status).toBe(200);
    detail = await request(board).get(`/api/routines/${routineId}`);
    expect(detail.body.triggers[0].webhookUrl).toBe(secretMaterial.webhookUrl);
    expect((await deliver("restored-event")).status).toBe(202);
    const schedule = await request(board).post(`/api/routines/${routineId}/triggers`).send({ kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "America/Chicago" });
    expect(schedule.status).toBe(201);
    await request(board).patch(`/api/routine-triggers/${schedule.body.trigger.id}`).send({ archived: true });
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(1);
    await request(board).patch(`/api/routine-triggers/${schedule.body.trigger.id}`).send({ archived: false });
    expect((await request(board).get(`/api/routines/${routineId}`)).body.triggers).toHaveLength(2);
  });

  it("supports creating, scheduling, and manually running a routine through the API", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Daily standup prep",
        description: "Summarize blockers and open PRs",
        assigneeAgentId: agentId,
        priority: "high",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        activityGatePolicy: "require_external_activity",
        activityGateScope: "project",
      });

    expect([200, 201]).toContain(createRes.status);
    expect(createRes.body.title).toBe("Daily standup prep");
    expect(createRes.body.assigneeAgentId).toBe(agentId);
    expect(createRes.body.activityGatePolicy).toBe("require_external_activity");
    expect(createRes.body.activityGateScope).toBe("project");

    const routineId = createRes.body.id as string;

    const updateRes = await request(app)
      .patch(`/api/routines/${routineId}`)
      .send({
        activityGatePolicy: "always",
        activityGateScope: "company",
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.activityGatePolicy).toBe("always");
    expect(updateRes.body.activityGateScope).toBe("company");

    const triggerRes = await request(app)
      .post(`/api/routines/${routineId}/triggers`)
      .send({
        kind: "schedule",
        label: "Weekday morning",
        cronExpression: "0 10 * * 1-5",
        timezone: "UTC",
      });

    expect([200, 201], JSON.stringify(triggerRes.body)).toContain(triggerRes.status);
    const createdTrigger = triggerRes.body.trigger ?? triggerRes.body;
    expect(createdTrigger.kind).toBe("schedule");
    expect(createdTrigger.enabled).toBe(true);
    expect(triggerRes.body.secretMaterial).toBeNull();

    const runRes = await postRoutineRun(app, routineId, {
      source: "manual",
      payload: { origin: "e2e-test" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");
    expect(runRes.body.source).toBe("manual");
    expect(runRes.body.linkedIssueId).toBeTruthy();

    const listRes = await request(app).get(`/api/companies/${companyId}/routines`);
    expect(listRes.status).toBe(200);
    const listed = listRes.body.find((r: { id: string }) => r.id === routineId);
    expect(listed).toBeDefined();
    expect(listed.activityGatePolicy).toBe("always");
    expect(listed.activityGateScope).toBe("company");
    expect(listed.triggers).toHaveLength(1);
    expect(listed.triggers[0].cronExpression).toBe("0 10 * * 1-5");
    expect(listed.triggers[0].timezone).toBe("UTC");

    const detailRes = await request(app).get(`/api/routines/${routineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.activityGatePolicy).toBe("always");
    expect(detailRes.body.activityGateScope).toBe("company");
    expect(detailRes.body.triggers).toHaveLength(1);
    expect(detailRes.body.triggers[0]?.id).toBe(createdTrigger.id);
    expect(detailRes.body.recentRuns).toHaveLength(1);
    expect(detailRes.body.recentRuns[0]?.id).toBe(runRes.body.id);
    expect(detailRes.body.activeIssue?.id).toBe(runRes.body.linkedIssueId);

    const runsRes = await request(app).get(`/api/routines/${routineId}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    const [persistedRun] = await db
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(eq(routineRuns.id, runRes.body.id));
    expect(persistedRun?.id).toBe(runRes.body.id);

    const [issue] = await db
      .select({
        id: issues.id,
        originId: issues.originId,
        originKind: issues.originKind,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toMatchObject({
      id: runRes.body.linkedIssueId,
      originId: routineId,
      originKind: "routine_execution",
    });
    expect(issue?.executionRunId).toBeTruthy();

    const actions = await db
      .select({
        action: activityLog.action,
      })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    expect(actions.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "routine.created",
        "routine.trigger_created",
        "routine.run_triggered",
      ]),
    );
  }, 15_000);

  it("runs routines with variable inputs and interpolates the execution issue description", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Repository triage",
        description: "Review {{repo}} for {{priority}} bugs",
        assigneeAgentId: agentId,
        variables: [
          { name: "repo", type: "text", required: true },
          { name: "priority", type: "select", required: true, defaultValue: "high", options: ["high", "low"] },
        ],
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      variables: { repo: "paperclip" },
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.triggerPayload).toEqual({
      variables: {
        repo: "paperclip",
        priority: "high",
      },
    });

    const [issue] = await db
      .select({ description: issues.description })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue?.description).toBe("Review paperclip for high bugs");
  });

  it("defaults activity gates and rejects invalid activity gate values", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Default activity gate",
        assigneeAgentId: agentId,
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.activityGatePolicy).toBe("always");
    expect(createRes.body.activityGateScope).toBe("company");

    const invalidCreateRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Invalid activity gate",
        assigneeAgentId: agentId,
        activityGatePolicy: "when_busy",
      });

    expect(invalidCreateRes.status).toBe(400);

    const invalidPatchRes = await request(app)
      .patch(`/api/routines/${createRes.body.id}`)
      .send({ activityGateScope: "agent" });

    expect(invalidPatchRes.status).toBe(400);
  });

  it("allows drafting a routine without defaults and running it with one-off overrides", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        title: "Draft routine",
        description: "No saved defaults",
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);
    expect(createRes.body.projectId ?? null).toBeNull();
    expect(createRes.body.assigneeAgentId ?? null).toBeNull();
    expect(createRes.body.status).toBe("paused");

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      projectId,
      assigneeAgentId: agentId,
    });

    expect(runRes.status).toBe(202);
    expect(runRes.body.status).toBe("issue_created");

    const [issue] = await db
      .select({
        projectId: issues.projectId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectId,
      assigneeAgentId: agentId,
    });
  });

  it("persists execution workspace selections from manual routine runs", async () => {
    const { companyId, agentId, projectId, userId } = await seedFixture();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const app = await createApp({
      type: "board",
      userId,
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    });

    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
      isPrimary: true,
      sharedWorkspaceKey: "routine-primary",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Routine worktree",
      status: "active",
      providerType: "git_worktree",
    });
    await db
      .update(projects)
      .set({
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
          defaultProjectWorkspaceId: projectWorkspaceId,
        },
      })
      .where(eq(projects.id, projectId));
    await db.insert(instanceSettings).values({
      experimental: { enableIsolatedWorkspaces: true },
    });

    const createRes = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        projectId,
        title: "Workspace-aware routine",
        assigneeAgentId: agentId,
      });

    expect([200, 201], JSON.stringify(createRes.body)).toContain(createRes.status);

    const runRes = await postRoutineRun(app, createRes.body.id, {
      source: "manual",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    expect(runRes.status).toBe(202);

    const [issue] = await db
      .select({
        projectWorkspaceId: issues.projectWorkspaceId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, runRes.body.linkedIssueId));

    expect(issue).toEqual({
      projectWorkspaceId,
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
  });
});
