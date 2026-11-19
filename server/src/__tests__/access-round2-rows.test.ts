import { appendFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  documents,
  feedbackExports,
  feedbackVotes,
  heartbeatRuns,
  issueReadStates,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// access-overlay (rf-4 F1-F10): the private-task overlay rides on every
// issue-scoped decision. A board user whose grant was REVOKED, a board user who
// was NEVER granted, and a company agent that was never granted (and is not the
// assignee) all get the missing-task 404 on every route below, before any
// effect. The owner, a still-granted user, the ASSIGNED agent, local_trusted
// board, an instance admin, any member on a non-private task and a scheduled
// (system) wake keep working.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OWNER = "ov-owner";
const REVOKED = "ov-revoked";
const GRANTED = "ov-granted";
const NEVER = "ov-never";
const ADMIN = "ov-instance-admin";
const DOC_TEXT = "OV-PRIVATE-DOCUMENT-BODY";
const NOT_FOUND = { error: "Issue not found" };

type Principal =
  | { kind: "user"; userId: string; instanceAdmin?: boolean; local?: boolean }
  | { kind: "agent"; agentId: string; runId?: string };

describeEmbeddedPostgres("access-round2 residual rows through the real routes (F4 checkout/oracles/aliases, F7 run/audit, F9 vote)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const children: ChildProcess[] = [];
  const childRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-a2-rows-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
  }, 60_000);

  afterEach(async () => {
    for (const id of childRunIds) runningProcesses.delete(id);
    for (const child of children) child.kill();
    children.length = 0;
    childRunIds.length = 0;
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string, who: Principal) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = who.kind === "agent"
        ? { type: "agent", source: "agent_key", agentId: who.agentId, companyId, runId: who.runId ?? null }
        : {
            type: "board",
            source: who.local ? "local_implicit" : "session",
            userId: who.userId,
            companyIds: [companyId],
            memberships: [{ companyId, status: "active", membershipRole: "operator" }],
            isInstanceAdmin: who.instanceAdmin === true,
          };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use("/api", agentRoutes(db));
    testApp.use("/api", activityRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  /** Company, users, assigned agent A, a never-granted agent N, a private task
   * (owner-created, assigned to A, live issue-bound run) and a non-private task.
   * Grants and the revoke go through the real access-grant routes. */
  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const openIssueId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId, name: "Overlay company",
      issuePrefix: `O${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const users = [OWNER, REVOKED, GRANTED, NEVER, ADMIN];
    await db.insert(authUsers).values(users.map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now })));
    await db.insert(companyMemberships).values(users.map(principalId => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "operator",
    })));
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Assigned Agent", role: "engineer", status: "idle",
        adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
      { id: otherAgentId, companyId, name: "Other Agent", role: "engineer", status: "idle",
        adapterType: "claude_local", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
    ]);
    await db.insert(companyMemberships).values([agentId, otherAgentId].map(principalId => ({
      companyId, principalType: "agent", principalId, status: "active", membershipRole: "operator",
    })));
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "overlay rows",
      status: "running", runtimeMode: "legacy", startedAt: new Date(), contextSnapshot: { issueId },
    });
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "OVP-1", title: "Private overlay task", status: "in_progress",
        priority: "medium", assigneeAgentId: agentId, executionRunId: runId, visibility: "private",
        privacyRootIssueId: issueId, responsibleUserId: OWNER, createdByUserId: OWNER },
      { id: openIssueId, companyId, identifier: "OVP-2", title: "Open overlay task", status: "todo",
        priority: "medium", assigneeAgentId: agentId, createdByUserId: OWNER },
    ]);
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    childRunIds.push(runId);
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });

    const owner = app(companyId, { kind: "user", userId: OWNER });
    const grants: Record<string, string> = {};
    for (const subjectId of [REVOKED, GRANTED]) {
      const granted = await request(owner).post(`/api/issues/${issueId}/access-grants`).send({ subjectType: "user", subjectId });
      expect(granted.status, JSON.stringify(granted.body)).toBe(201);
      grants[subjectId] = granted.body.id;
    }
    await request(app(companyId, { kind: "user", userId: REVOKED })).get(`/api/issues/${issueId}`).expect(200);
    const doc = await request(owner).put(`/api/issues/${issueId}/documents/plan`)
      .send({ title: "Private plan", body: DOC_TEXT, format: "markdown" });
    expect([200, 201], JSON.stringify(doc.body)).toContain(doc.status);
    const openDoc = await request(owner).put(`/api/issues/${openIssueId}/documents/plan`)
      .send({ title: "Open plan", body: "open body", format: "markdown" });
    expect([200, 201], JSON.stringify(openDoc.body)).toContain(openDoc.status);
    await request(owner).post(`/api/issues/${issueId}/access-grants/${grants[REVOKED]}/revoke`).send({}).expect(200);
    // The revoke is real; NEVER and agent N never had a grant.
    await request(app(companyId, { kind: "user", userId: REVOKED })).get(`/api/issues/${issueId}`).expect(404);
    await request(app(companyId, { kind: "user", userId: NEVER })).get(`/api/issues/${issueId}`).expect(404);
    await request(app(companyId, { kind: "agent", agentId: otherAgentId })).get(`/api/issues/${issueId}`).expect(404);
    return { companyId, agentId, otherAgentId, issueId, openIssueId, runId };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const DENIED = ["revoked", "never-granted", "non-granted-agent"] as const;
  function denied(f: Seeded, who: typeof DENIED[number]): Principal {
    if (who === "revoked") return { kind: "user", userId: REVOKED };
    if (who === "never-granted") return { kind: "user", userId: NEVER };
    return { kind: "agent", agentId: f.otherAgentId };
  }

  async function snapshot(f: Seeded) {
    const wakes = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)).orderBy(agentWakeupRequests.id);
    const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId)).orderBy(heartbeatRuns.id);
    const activity = await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.companyId, f.companyId));
    const docs = await db.select({ id: documents.id, body: documents.latestBody, lockedAt: documents.lockedAt,
      lockedByUserId: documents.lockedByUserId, lockedByAgentId: documents.lockedByAgentId })
      .from(documents).where(eq(documents.companyId, f.companyId)).orderBy(documents.id);
    const reads = await db.select({ id: issueReadStates.id }).from(issueReadStates).where(eq(issueReadStates.companyId, f.companyId));
    const interactions = await db.select({ id: issueThreadInteractions.id, status: issueThreadInteractions.status })
      .from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId)).orderBy(issueThreadInteractions.id);
    const issueRows = await db.select({ id: issues.id, title: issues.title, status: issues.status }).from(issues)
      .where(eq(issues.companyId, f.companyId)).orderBy(issues.id);
    return { wakes, runs, activity: activity.length, docs, reads: reads.length, interactions, issueRows };
  }

  function expectNotFound(response: request.Response, f: Seeded) {
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body).toEqual(NOT_FOUND);
    const text = JSON.stringify(response.body);
    expect(text).not.toContain(DOC_TEXT);
    expect(text).not.toContain(f.runId);
  }

  async function expectDeniedNoEffect(f: Seeded, send: () => Promise<request.Response>, missing?: () => Promise<request.Response>,
    options: { boardOnlyBeforeLookup?: boolean } = {}) {
    const before = await snapshot(f);
    const response = await send();
    // A board-only route refuses an agent before it looks the task up: the same
    // 403 for a private and a missing task (no oracle), and no effect.
    if (options.boardOnlyBeforeLookup) expect(response.status, JSON.stringify(response.body)).toBe(403);
    else expectNotFound(response, f);
    expect(await snapshot(f)).toEqual(before);
    if (missing) {
      const absent = await missing();
      expect({ status: absent.status, body: absent.body }).toEqual({ status: response.status, body: response.body });
    }
  }

  // ---- access-round2: each residual has a revoked-user, a never-granted-user
  // and a never-granted AGENT row (agent first), through the real routes. ----

  const ORDER = ["non-granted-agent", "revoked", "never-granted"] as const;
  const userOf = (f: Seeded, who: typeof ORDER[number]) => app(f.companyId, denied(f, who));
  const votes = async (f: Seeded) => (await db.select({ id: feedbackVotes.id }).from(feedbackVotes)
    .where(eq(feedbackVotes.companyId, f.companyId))).length;

  async function expectSameAsMissing(f: Seeded, send: () => Promise<request.Response>, missing: () => Promise<request.Response>,
    exact404: boolean | Record<string, unknown>) {
    const before = await snapshot(f);
    const votesBefore = await votes(f);
    const response = await send();
    if (exact404 === true) expectNotFound(response, f);
    else if (exact404) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(response.body).toEqual(exact404);
    }
    else {
      expect([200, 201, 202], JSON.stringify(response.body)).not.toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain(f.runId);
    }
    expect(await snapshot(f)).toEqual(before);
    expect(await votes(f)).toBe(votesBefore);
    const absent = await missing();
    expect({ status: absent.status, body: absent.body }).toEqual({ status: response.status, body: response.body });
  }

  // 1. F4 CHECKOUT (25): no private task projection, no activity, before anything.
  it.each(ORDER)("A2-1 F4 checkout by %s: private task looks missing, no effect", async who => {
    const f = await seed();
    const a = userOf(f, who);
    const agentId = who === "non-granted-agent" ? f.otherAgentId : f.agentId;
    const body = { agentId, expectedStatuses: ["in_progress"] };
    await expectSameAsMissing(f,
      () => request(a).post(`/api/issues/${f.issueId}/checkout`).send(body),
      () => request(a).post(`/api/issues/${randomUUID()}/checkout`).send(body), true);
  });

  it.each(["owner", "granted", "local_trusted", "instance_admin"])("A2-1 control: %s checks the private task out to its assigned agent (200)", async who => {
    const f = await seed();
    const a = app(f.companyId, who === "owner" ? { kind: "user", userId: OWNER } : who === "granted" ? { kind: "user", userId: GRANTED }
      : who === "local_trusted" ? { kind: "user", userId: "local-board", local: true } : { kind: "user", userId: ADMIN, instanceAdmin: true });
    const response = await request(a).post(`/api/issues/${f.issueId}/checkout`).send({ agentId: f.agentId, expectedStatuses: ["in_progress"] });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.id).toBe(f.issueId);
  });

  it("A2-1 control: assigned agent checkout (own run) and never-granted user on a NON-private task stay 200", async () => {
    const f = await seed();
    const own = await request(app(f.companyId, { kind: "agent", agentId: f.agentId, runId: f.runId }))
      .post(`/api/issues/${f.issueId}/checkout`).send({ agentId: f.agentId, expectedStatuses: ["in_progress"] });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const open = await request(app(f.companyId, { kind: "user", userId: NEVER }))
      .post(`/api/issues/${f.openIssueId}/checkout`).send({ agentId: f.agentId, expectedStatuses: ["todo"] });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
  });

  // 4. F9 feedback vote (9): no vote written after revoke / without a grant.
  async function privateComment(f: Seeded) {
    const comment = await request(app(f.companyId, { kind: "agent", agentId: f.agentId, runId: f.runId }))
      .post(`/api/issues/${f.issueId}/comments`).send({ body: "A2-PRIVATE-FEEDBACK-COMMENT" });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    return comment.body.id as string;
  }
  it.each(ORDER)("A2-4 F9 feedback vote by %s: private task looks missing, no vote", async who => {
    const f = await seed();
    const targetId = await privateComment(f);
    const a = userOf(f, who);
    const body = { targetType: "issue_comment", targetId, vote: "up" };
    await expectSameAsMissing(f,
      () => request(a).post(`/api/issues/${f.issueId}/feedback-votes`).send(body),
      () => request(a).post(`/api/issues/${randomUUID()}/feedback-votes`).send(body), true);
    expect(await votes(f)).toBe(0);
  });
  it.each([OWNER, GRANTED])("A2-4 control: %s still votes on the private comment (201)", async userId => {
    const f = await seed();
    const targetId = await privateComment(f);
    const response = await request(app(f.companyId, { kind: "user", userId }))
      .post(`/api/issues/${f.issueId}/feedback-votes`).send({ targetType: "issue_comment", targetId, vote: "up" });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await votes(f)).toBe(1);
  });

  // 5. F4 control-route existence oracles (10): same 404 + body as a missing task.
  const ORACLES = ["context/compact", "monitor/check-now", "runner-goal/actions"] as const;
  const oracleBody = (f: Seeded, path: string, agentId: string) => path === "runner-goal/actions"
    ? { requestId: randomUUID(), agentId, expectedRevision: 0, action: "create", objective: "a2 objective" } : {};
  for (const path of ORACLES) {
    it.each(ORDER)(`A2-5 F4 ${path} by %s: private task answers exactly as a missing one`, async who => {
      const f = await seed();
      const a = userOf(f, who);
      const body = oracleBody(f, path, who === "non-granted-agent" ? f.otherAgentId : f.agentId);
      // compact is board-only: an agent gets the same 403 before any lookup.
      const exact404 = !(path === "context/compact" && who === "non-granted-agent");
      await expectSameAsMissing(f,
        () => request(a).post(`/api/issues/${f.issueId}/${path}`).send(body),
        () => request(a).post(`/api/issues/${randomUUID()}/${path}`).send(body), exact404);
    });
  }
  it.each(ORDER)("A2-5 F4 exact-run retry by %s: a run on a private task is a missing run", async who => {
    const f = await seed();
    const a = userOf(f, who);
    const target = who === "non-granted-agent" ? f.otherAgentId : f.agentId;
    const send = (failedRunId: string) => request(a).post(`/api/agents/${target}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId });
    const before = await snapshot(f);
    const response = await send(f.runId);
    const absent = await send(randomUUID());
    expect(response.status, JSON.stringify(response.body)).not.toBe(202);
    if (who !== "non-granted-agent") expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect({ status: absent.status, body: absent.body }).toEqual({ status: response.status, body: response.body });
    expect(await snapshot(f)).toEqual(before);
  });
  it.each([OWNER, GRANTED])("A2-5 control: %s still gets each control route's real answer (no 404)", async userId => {
    const f = await seed();
    const a = app(f.companyId, { kind: "user", userId });
    for (const path of ORACLES) {
      const response = await request(a).post(`/api/issues/${f.issueId}/${path}`).send(oracleBody(f, path, f.agentId));
      expect(response.status, `${path} ${JSON.stringify(response.body)}`).not.toBe(404);
    }
    const retry = await request(a).post(`/api/agents/${f.agentId}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: f.runId });
    expect(retry.status, JSON.stringify(retry.body)).toBe(409);
  });

  // 3. F7 trace reprojection / runtime-request resolve (15).
  const RUN_ROUTES = ["provider-trace/reproject-workspace-diffs", "runtime-requests/a2-request/resolve"] as const;
  for (const suffix of RUN_ROUTES) {
    it.each(ORDER)(`A2-3 F7 ${suffix} by %s: a run on a private task is a missing run`, async who => {
      const f = await seed();
      const a = userOf(f, who);
      // board-only: an agent gets the same 403 before any lookup.
      await expectSameAsMissing(f,
        () => request(a).post(`/api/heartbeat-runs/${f.runId}/${suffix}`).send({}),
        () => request(a).post(`/api/heartbeat-runs/${randomUUID()}/${suffix}`).send({}),
        who !== "non-granted-agent" && { error: "Heartbeat run not found" });
    });
  }
  it.each([OWNER, GRANTED])("A2-3 control: %s still reaches the run routes (reprojection 200, legacy resolve 409)", async userId => {
    const f = await seed();
    const a = app(f.companyId, { kind: "user", userId });
    const reproject = await request(a).post(`/api/heartbeat-runs/${f.runId}/provider-trace/reproject-workspace-diffs`).send({});
    expect(reproject.status, JSON.stringify(reproject.body)).toBe(200);
    const resolve = await request(a).post(`/api/heartbeat-runs/${f.runId}/runtime-requests/a2-request/resolve`).send({});
    expect(resolve.status, JSON.stringify(resolve.body)).toBe(409);
  });

  // 6. F7 audit listing (10): no hidden task ids / actions / timestamps.
  async function auditFor(f: Seeded, a: express.Express) {
    return request(a).get(`/api/companies/${f.companyId}/audit/agent-actions?actorScope=all`);
  }
  async function auditSeed(f: Seeded) {
    const owner = app(f.companyId, { kind: "user", userId: OWNER });
    await request(owner).put(`/api/issues/${f.issueId}/title`).send({ title: "A2-PRIVATE-AUDIT-TITLE" }).expect(200);
    await request(owner).put(`/api/issues/${f.openIssueId}/title`).send({ title: "A2-OPEN-AUDIT-TITLE" }).expect(200);
    await request(app(f.companyId, { kind: "agent", agentId: f.agentId, runId: f.runId }))
      .post(`/api/issues/${f.issueId}/comments`).send({ body: "A2-PRIVATE-AUDIT-COMMENT" }).expect(201);
  }
  const privateRows = (f: Seeded, items: any[], commentIds: string[]) => items.filter((item: any) =>
    item.entityId === f.issueId || commentIds.includes(item.entityId) || JSON.stringify(item).includes(f.issueId));
  it.each(ORDER)("A2-6 F7 audit listing for %s: no row of the hidden task (id/action/timestamp)", async who => {
    const f = await seed();
    await auditSeed(f);
    const commentIds = (await db.execute(sql`select id::text as id from issue_comments where issue_id = ${f.issueId}`) as any)
      .rows?.map((r: any) => r.id) ?? [];
    const response = await auditFor(f, userOf(f, who));
    if (response.status === 200) {
      expect(privateRows(f, response.body.items, commentIds)).toEqual([]);
      if (who !== "non-granted-agent") expect(response.body.items.some((item: any) => item.entityId === f.openIssueId)).toBe(true);
    } else {
      expect(JSON.stringify(response.body)).not.toContain(f.issueId);
    }
  });
  it.each([OWNER, GRANTED])("A2-6 control: %s still sees the private task's audit rows", async userId => {
    const f = await seed();
    await auditSeed(f);
    const response = await auditFor(f, app(f.companyId, { kind: "user", userId }));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.items.some((item: any) => item.entityId === f.issueId)).toBe(true);
  });

  // 7. identifier-valued wakes (9): 404 for missing/private, never 500.
  for (const key of ["issueId", "taskId"] as const) {
    it.each(ORDER)(`A2-7 F4 wake naming the private task by identifier in ${key}, by %s: 404 as missing`, async who => {
      const f = await seed();
      const a = userOf(f, who);
      // the never-granted agent wakes ITSELF naming the private task.
      const target = who === "non-granted-agent" ? f.otherAgentId : f.agentId;
      const send = (ref: string) => request(a).post(`/api/agents/${target}/wakeup`)
        .send({ source: "on_demand", triggerDetail: "manual", payload: { [key]: ref } });
      await expectSameAsMissing(f, () => send("OVP-1"), () => send("OVP-999"), true);
    });
  }
  it.each(["issueId", "taskId"] as const)("A2-7 missing identifier in %s for the owner is 404, not 500", async key => {
    const f = await seed();
    const response = await request(app(f.companyId, { kind: "user", userId: OWNER })).post(`/api/agents/${f.agentId}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", payload: { [key]: "OVP-999" } });
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body).toEqual(NOT_FOUND);
  });
  it.each(["issueId", "taskId"] as const)("A2-7 control: identifier in %s resolves to the task id for owner and assigned self-wake (202)", async key => {
    const f = await seed();
    for (const who of [{ kind: "user", userId: OWNER }, { kind: "agent", agentId: f.agentId, runId: f.runId }] as Principal[]) {
      const response = await request(app(f.companyId, who)).post(`/api/agents/${f.agentId}/wakeup`)
        .send({ source: "on_demand", triggerDetail: "manual", payload: { [key]: "OVP-1" } });
      expect(response.status, JSON.stringify(response.body)).toBe(202);
    }
    const payloads = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(payloads.length).toBeGreaterThan(0);
    for (const row of payloads) expect(JSON.stringify(row.payload)).not.toContain("OVP-1");
  });
  it("A2-7 control: never-granted user wakes for a NON-private task by identifier (202)", async () => {
    const f = await seed();
    const response = await request(app(f.companyId, { kind: "user", userId: NEVER })).post(`/api/agents/${f.agentId}/wakeup`)
      .send({ source: "on_demand", triggerDetail: "manual", payload: { issueId: "OVP-2" } });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
  });
});
