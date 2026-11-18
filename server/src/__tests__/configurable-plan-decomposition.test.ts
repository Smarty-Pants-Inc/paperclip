import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, documents, documentRevisions, issueDocuments, issueThreadInteractions, issues } from "@paperclipai/db";
import { createAcceptedPlanDecompositionSchema } from "@paperclipai/shared";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("configured accepted-plan decomposition limit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("configured-plan-decomposition-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  // Keep: real API validation boundary plus durable creation of all accepted children.
  it.each([
    [undefined, 25], ["25", 25], ["025", 25], [" 25", 25], ["25 ", 25],
    ["0025", 25], ["\t25\n", 25], [" 30 ", 30],
  ] as const)("accepts %s children up to the configured boundary", async (raw, limit) => {
    vi.stubEnv("PAPERCLIP_MAX_PLAN_DECOMPOSITION_CHILDREN", raw);
    vi.stubEnv("PAPERCLIP_MAX_ACTIVE_CHILD_ISSUES", "100");
    const companyId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID();
    const documentId = randomUUID(), revisionId = randomUUID(), userId = "board-user";
    await db.insert(companies).values({ id: companyId, name: "Plan limits", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Planner", status: "paused", adapterType: "process" });
    await db.insert(issues).values({ id: sourceId, companyId, title: "Approved plan", workMode: "planning", status: "in_progress", assigneeAgentId: agentId, createdByUserId: userId });
    await db.insert(documents).values({ id: documentId, companyId, title: "Plan", format: "markdown", latestBody: "Plan body", latestRevisionId: revisionId, latestRevisionNumber: 1 });
    await db.insert(documentRevisions).values({ id: revisionId, companyId, documentId, revisionNumber: 1, title: "Plan", format: "markdown", body: "Plan body" });
    await db.insert(issueDocuments).values({ companyId, issueId: sourceId, documentId, key: "plan" });
    await db.insert(issueThreadInteractions).values({ companyId, issueId: sourceId, kind: "request_confirmation", status: "accepted", continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve?", target: { type: "issue_document", issueId: sourceId, documentId, key: "plan", revisionId, revisionNumber: 1 } },
      result: { version: 1, outcome: "accepted" }, resolvedAt: new Date(), createdByUserId: userId, resolvedByUserId: userId });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId, source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const body = (count: number) => ({ acceptedPlanRevisionId: revisionId,
      children: Array.from({ length: count }, (_, n) => ({ title: `Child ${n}`, status: "backlog" })) });
    const rejected = await request(app).post(`/api/issues/${sourceId}/accepted-plan-decompositions`).send(body(limit + 1));
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
    const created = await request(app).post(`/api/issues/${sourceId}/accepted-plan-decompositions`).send(body(limit));
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body.childIssueIds).toHaveLength(limit);
    expect(created.body.newlyCreatedChildIssueIds).toHaveLength(limit);
    // The browser-facing default schema does not read server environment variables.
    expect(createAcceptedPlanDecompositionSchema.safeParse(body(26)).success).toBe(false);
  }, 60_000);
});
