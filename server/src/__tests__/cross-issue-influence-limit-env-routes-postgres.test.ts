import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping cross-issue env route proof: ${support.reason}`);

// Keep reason: the real agent-write trust boundary must honor operator config
// without losing the default backstop or its durable rejection audit receipt.
describePostgres("cross-issue influence environment limit (routes + postgres)", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-env-");
    db = createDb(temporary.connectionString);
  }, 90_000);

  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    await db?.$client.end();
    await temporary?.cleanup();
  });

  it.each([
    { setting: undefined, accepted: 20, label: "unset keeps the 20-write backstop" },
    { setting: "1000000000", accepted: 30, label: "a raised cap permits all 30 writes" },
  ])("$label", async ({ setting, accepted }) => {
    vi.stubEnv("PAPERCLIP_CROSS_ISSUE_INFLUENCE_LIMIT", setting);
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    const sourceIssueId = randomUUID();
    const targets = Array.from({ length: 30 }, () => randomUUID());
    await db.insert(companies).values({
      id: companyId, name: "Cross-issue env route proof", issuePrefix: `E${companyId.slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Cross-issue writer", role: "engineer", adapterType: "process",
      adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: false } }, permissions: {},
    });
    await db.insert(issues).values([sourceIssueId, ...targets].map(id => ({
      id, companyId, title: "Before write", status: "blocked", assigneeAgentId: agentId,
    })));
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId: sourceIssueId },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, {}));
    app.use(errorHandler);

    // Every request traverses the real route/services and changes a different
    // OTHER issue. No pre-seeded observations stand in for actual writes.
    const responses = [];
    for (const [index, targetId] of targets.entries()) {
      responses.push(await request(app).patch(`/api/issues/${targetId}`)
        .send({ title: `Write ${index + 1}` }).timeout({ deadline: 10_000 }));
    }
    expect(responses.map(response => response.status)).toEqual(
      targets.map((_, index) => index < accepted ? 200 : 429),
    );
    if (accepted === 20) {
      expect(responses[20].body.details).toMatchObject({
        code: "cross_issue_influence_cap_exceeded", cap: 20, count: 21, mode: "enforce",
      });
    }
    const persisted = await db.select({ id: issues.id, title: issues.title }).from(issues)
      .where(eq(issues.companyId, companyId));
    for (const [index, targetId] of targets.entries()) {
      expect(persisted.find(row => row.id === targetId)?.title)
        .toBe(index < accepted ? `Write ${index + 1}` : "Before write");
    }
    expect(persisted.find(row => row.id === sourceIssueId)?.title).toBe("Before write");
    const receipts = await db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.runId, runId)));
    const observations = receipts.filter(row => row.action === "issue.cross_issue_influence_observed");
    const rejected = receipts.filter(row => row.action === "issue.cross_issue_influence_cap_rejected");
    expect(observations).toHaveLength(accepted);
    expect(rejected).toHaveLength(30 - accepted);
    expect(observations).toEqual(expect.arrayContaining([expect.objectContaining({
      details: expect.objectContaining({
        cap: setting === undefined ? 20 : 1000000000, count: accepted, allowed: true,
      }),
    })]));
    if (accepted === 20) expect(rejected[0].details).toMatchObject({ cap: 20, count: 21, allowed: false });
  }, 90_000);
});
