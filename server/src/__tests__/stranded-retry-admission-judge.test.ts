import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, ne } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, authUsers, closeRegisteredClients, companies, createDb, heartbeatRuns, issueRelations, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { closeProcessRunAdmission, resetProcessRunAdmissionForTests } from "../services/heartbeat/run-admission.js";
import { decideStrandedRetryAdmission } from "../services/recovery/stranded-retry-admission.js";
import { buildStrandedRecoveryEscalationNotice } from "../services/recovery/stranded-notice.js";

// Judge rows (rf-5 bar, round 2b): the stranded notice says "Press Retry" IFF
// the screen's one Retry decision (taskInterruptionPresentation.canRetry,
// returned by POST /issues/:id/retry as `presentation`) admits, and that
// decision is compared with what the REAL route + dispatch then do.
describe("stranded notice Retry == the real POST /issues/:id/retry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const userId = `stranded-judge-${randomUUID()}`;
  const support = getEmbeddedPostgresTestSupport();

  beforeAll(async () => {
    expect((await support).supported, "embedded Postgres required; no expected skip").toBe(true);
    temporary = await startEmbeddedPostgresTestDatabase("stranded-retry-judge-");
    db = createDb(temporary.connectionString);
    closeProcessRunAdmission();
    await db.insert(authUsers).values({ id: userId, name: "Judge board", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);

  afterAll(async () => {
    if (db) await heartbeatService(db).drainActiveRunExecutions();
    if (temporary) await closeRegisteredClients(temporary.connectionString);
    await temporary?.cleanup?.();
    resetProcessRunAdmissionForTests();
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId }; next(); });
    a.use("/api", issueRoutes(db, {} as never));
    a.use(errorHandler);
    return a;
  }

  async function fixture(opts: { paused?: boolean; blocker?: boolean } = {}) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stranded judge", issuePrefix: `SJ${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Judge agent", role: "engineer", status: opts.paused ? "paused" : "idle",
      adapterType: "process", adapterConfig: { command: "true" }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Stranded task", status: "todo", assigneeAgentId: agentId, priority: "medium" });
    if (opts.blocker) {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    }
    const at = new Date(Date.now() - 60_000);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId, status: "failed", errorCode: "adapter_failed",
      error: "Injected failure", invocationSource: "on_demand", contextSnapshot: { issueId }, createdAt: at, startedAt: at, finishedAt: at }).returning();
    return { companyId, agentId, issueId, run: run! };
  }

  async function judge(f: Awaited<ReturnType<typeof fixture>>) {
    const retry = await decideStrandedRetryAdmission(db, { companyId: f.companyId, issueId: f.issueId, runId: f.run.id });
    const notice = buildStrandedRecoveryEscalationNotice({ retry, recoveryCause: "stranded_assigned_issue",
      recoveryActionId: null, recoveryOwner: null, sourceRun: { id: f.run.id, agentId: f.agentId, status: f.run.status, errorCode: f.run.errorCode } } as never);
    const res = await request(app()).post(`/api/issues/${f.issueId}/retry`).send({ idempotencyKey: randomUUID(), observedRunId: f.run.id });
    let dispatchError: string | null = null;
    // The route nudges dispatch with `void resumeTaskRetry(...)`; await the same call to read its outcome.
    if (res.body.requestId) await heartbeatService(db).resumeTaskRetry(f.companyId, res.body.requestId)
      .catch((error: Error) => { dispatchError = error.message; });
    const started = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.issueId, f.issueId), ne(heartbeatRuns.id, f.run.id)));
    const text = JSON.stringify(notice);
    const row = { admits: retry.admits, refusal: retry.admits ? null : retry.refusal, pressRetry: /Press Retry/.test(text),
      status: res.status, routeCanRetry: res.body.presentation?.canRetry ?? null, runStarted: started.length > 0, dispatchError,
      body: notice.body, nextAction: JSON.stringify(notice.metadata.sections[0]!.rows.find(r => "label" in r && r.label === "Next action") ?? null) };
    console.info("JUDGE_ROW", JSON.stringify(row));
    return row;
  }

  it("CONTROL: an idle agent's failed task: notice says Press Retry, route 202 and a run starts", async () => {
    const row = await judge(await fixture());
    expect(row).toMatchObject({ admits: true, pressRetry: true, status: 202, runStarted: true, dispatchError: null });
  }, 60_000);

  it("paused agent WITHOUT a blocker: no Press Retry, names resume; route 202 but no run starts", async () => {
    const row = await judge(await fixture({ paused: true }));
    expect(row).toMatchObject({ admits: false, refusal: "agent_paused", pressRetry: false, status: 202, runStarted: false });
    expect(row.nextAction).toMatch(/resume/);
  }, 60_000);

  it("paused agent WITH a blocker: no Press Retry; route 202 but no run starts", async () => {
    const row = await judge(await fixture({ paused: true, blocker: true }));
    expect(row).toMatchObject({ admits: false, pressRetry: false, status: 202, runStarted: false });
  }, 60_000);
});
