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

describeEmbeddedPostgres("private-task overlay rows through the real routes (access-overlay F1-F10)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const children: ChildProcess[] = [];
  const childRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ov-rows-");
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

  async function ownerInteraction(f: Seeded) {
    const created = await request(app(f.companyId, { kind: "user", userId: OWNER }))
      .post(`/api/issues/${f.issueId}/interactions`)
      .send({ kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Ship it?" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.id as string;
  }

  // ---- F1 documents: lock / unlock / delete ----
  describe.each(DENIED)("F1 documents (%s)", (who) => {
    it.each(["lock", "unlock", "delete"])("%s → 404 before any body, lock or delete", async (op) => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      const path = (id: string) => `/api/issues/${id}/documents/plan${op === "delete" ? "" : `/${op}`}`;
      const send = (id: string) => op === "delete" ? request(a).delete(path(id)) : request(a).post(path(id)).send({});
      await expectDeniedNoEffect(f, () => send(f.issueId), () => send(randomUUID()));
    });
  });

  // ---- F2 mark read / unread ----
  describe.each(DENIED)("F2 read state (%s)", (who) => {
    it.each(["post", "delete"] as const)("%s /read → 404, no read-state or activity write", async (method) => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      const send = (id: string) => method === "post" ? request(a).post(`/api/issues/${id}/read`).send({}) : request(a).delete(`/api/issues/${id}/read`);
      await expectDeniedNoEffect(f, () => send(f.issueId), () => send(randomUUID()));
    });
  });

  // ---- F3 execution / active-run ----
  describe.each(DENIED)("F3 run reads (%s)", (who) => {
    it.each(["execution", "active-run", "live-runs"])("GET %s → 404, no run data", async (path) => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      await expectDeniedNoEffect(f, () => request(a).get(`/api/issues/${f.issueId}/${path}`),
        () => request(a).get(`/api/issues/${randomUUID()}/${path}`));
    });
  });

  // ---- F4 wake / invoke naming the private task ----
  describe.each(DENIED)("F4 wake (%s)", (who) => {
    it.each(["wakeup", "heartbeat/invoke"])("POST %s with the private issueId → 404, no wake, no run", async (endpoint) => {
      const f = await seed();
      const principal = denied(f, who);
      const a = app(f.companyId, principal);
      // A board user wakes the assigned agent; the non-granted agent wakes itself.
      const target = principal.kind === "agent" ? principal.agentId : f.agentId;
      const send = (issueId: string) => request(a).post(`/api/agents/${target}/${endpoint}`)
        .send({ source: "on_demand", triggerDetail: "manual", reason: "ov_private_wake", payload: { issueId } });
      await expectDeniedNoEffect(f, () => send(f.issueId), () => send(randomUUID()));
    });
  });

  // ---- F6 interactions: create / resolve / cancel ----
  describe.each(DENIED)("F6 interactions (%s)", (who) => {
    it("create → 404, no interaction", async () => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      const body = { kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Leak?" } };
      await expectDeniedNoEffect(f, () => request(a).post(`/api/issues/${f.issueId}/interactions`).send(body),
        () => request(a).post(`/api/issues/${randomUUID()}/interactions`).send(body));
    });
    it.each(["accept", "reject", "cancel", "dismiss"])("%s an existing interaction → 404, unchanged", async (op) => {
      const f = await seed();
      const interactionId = await ownerInteraction(f);
      const a = app(f.companyId, denied(f, who));
      await expectDeniedNoEffect(f, () => request(a).post(`/api/issues/${f.issueId}/interactions/${interactionId}/${op}`).send({}),
        () => request(a).post(`/api/issues/${randomUUID()}/interactions/${interactionId}/${op}`).send({}),
        { boardOnlyBeforeLookup: who === "non-granted-agent" && op === "dismiss" });
    });
  });

  // ---- F7 feedback traces ----
  describe.each(DENIED)("F7 feedback traces (%s)", (who) => {
    it("GET feedback-traces → 404", async () => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      await expectDeniedNoEffect(f, () => request(a).get(`/api/issues/${f.issueId}/feedback-traces`),
        () => request(a).get(`/api/issues/${randomUUID()}/feedback-traces`));
    });
  });

  async function seedTrace(f: Seeded) {
    const targetId = randomUUID();
    const [vote] = await db.insert(feedbackVotes).values({ companyId: f.companyId, issueId: f.issueId,
      targetType: "issue_comment", targetId, authorUserId: OWNER, vote: "up" }).returning();
    const [trace] = await db.insert(feedbackExports).values({ companyId: f.companyId, feedbackVoteId: vote!.id,
      issueId: f.issueId, authorUserId: OWNER, targetType: "issue_comment", targetId, vote: "up",
      targetSummary: { label: "OV-PRIVATE-TRACE", excerpt: DOC_TEXT } }).returning();
    return trace!.id;
  }

  describe.each(DENIED)("F7 trace detail / bundle (%s)", (who) => {
    it.each(["", "/bundle"])("GET /feedback-traces/:id%s → same 404 as a missing trace", async (suffix) => {
      const f = await seed();
      const traceId = await seedTrace(f);
      const a = app(f.companyId, denied(f, who));
      const before = await snapshot(f);
      const response = await request(a).get(`/api/feedback-traces/${traceId}${suffix}`);
      const missing = await request(a).get(`/api/feedback-traces/${randomUUID()}${suffix}`);
      expect({ status: response.status, body: response.body }).toEqual({ status: missing.status, body: missing.body });
      expect(JSON.stringify(response.body)).not.toContain(DOC_TEXT);
      expect(await snapshot(f)).toEqual(before);
    });
  });

  it.each(["", "/bundle"])("F7 control: owner reads /feedback-traces/:id%s → 200", async (suffix) => {
    const f = await seed();
    const traceId = await seedTrace(f);
    const response = await request(app(f.companyId, { kind: "user", userId: OWNER })).get(`/api/feedback-traces/${traceId}${suffix}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  it("F7 audit feed: the private task's joined title/comment content is withheld from a revoked / never-granted user, kept for the owner", async () => {
    const f = await seed();
    const comment = await request(app(f.companyId, { kind: "agent", agentId: f.agentId, runId: f.runId }))
      .post(`/api/issues/${f.issueId}/comments`).send({ body: "OV-PRIVATE-AUDIT-COMMENT" });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    const path = `/api/companies/${f.companyId}/audit/agent-actions?actorScope=all`;
    const ownerFeed = await request(app(f.companyId, { kind: "user", userId: OWNER })).get(path);
    expect(ownerFeed.status, JSON.stringify(ownerFeed.body)).toBe(200);
    // The feed joins the task snippet (identifier/title) onto each issue row.
    expect(JSON.stringify(ownerFeed.body)).toContain("Private overlay task");
    for (const userId of [REVOKED, NEVER]) {
      const feed = await request(app(f.companyId, { kind: "user", userId })).get(path);
      expect(feed.status, JSON.stringify(feed.body)).toBe(200);
      expect(JSON.stringify(feed.body)).not.toContain("OV-PRIVATE-AUDIT-COMMENT");
      expect(JSON.stringify(feed.body)).not.toContain("Private overlay task");
    }
  });

  describe.each(DENIED)("F4 other run controls (%s)", (who) => {
    it("POST admin/force-release → same 404 as missing, no release", async () => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      await expectDeniedNoEffect(f, () => request(a).post(`/api/issues/${f.issueId}/admin/force-release`).send({}),
        () => request(a).post(`/api/issues/${randomUUID()}/admin/force-release`).send({}),
        { boardOnlyBeforeLookup: who === "non-granted-agent" });
    });
    it("POST stalled-review-decision → same 404 as missing, no decision", async () => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      const body = { action: "approve" };
      await expectDeniedNoEffect(f, () => request(a).post(`/api/issues/${f.issueId}/stalled-review-decision`).send(body),
        () => request(a).post(`/api/issues/${randomUUID()}/stalled-review-decision`).send(body));
    });
  });

  // ---- F8 activity / run history: private == missing ----
  describe.each(DENIED)("F8 activity (%s)", (who) => {
    it.each(["activity", "runs"])("GET %s → same 404 as a missing task", async (path) => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      await expectDeniedNoEffect(f, () => request(a).get(`/api/issues/${f.issueId}/${path}`),
        () => request(a).get(`/api/issues/${randomUUID()}/${path}`));
    });
  });

  // ---- F9 title / accepted plans ----
  describe.each(DENIED)("F9 misc (%s)", (who) => {
    it("PUT title → 404, title unchanged", async () => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      await expectDeniedNoEffect(f, () => request(a).put(`/api/issues/${f.issueId}/title`).send({ title: "Renamed by outsider" }),
        () => request(a).put(`/api/issues/${randomUUID()}/title`).send({ title: "Renamed by outsider" }));
    });
    it.each(["post", "delete"] as const)("%s inbox-archive → same 404 as missing, no write", async (method) => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      const send = (id: string) => method === "post" ? request(a).post(`/api/issues/${id}/inbox-archive`).send({}) : request(a).delete(`/api/issues/${id}/inbox-archive`);
      await expectDeniedNoEffect(f, () => send(f.issueId), () => send(randomUUID()));
    });
    it("GET accepted-plan-decompositions → 404", async () => {
      const f = await seed();
      const a = app(f.companyId, denied(f, who));
      await expectDeniedNoEffect(f, () => request(a).get(`/api/issues/${f.issueId}/accepted-plan-decompositions`),
        () => request(a).get(`/api/issues/${randomUUID()}/accepted-plan-decompositions`));
    });
  });

  // ---- F10 manager-agent steer: gate first ----
  it("F10 never-granted manager agent: steer on the private task == missing task (404), no effect", async () => {
    const f = await seed();
    await db.update(agents).set({ reportsTo: f.otherAgentId }).where(eq(agents.id, f.agentId));
    const a = app(f.companyId, { kind: "agent", agentId: f.otherAgentId });
    const body = { queueId: randomUUID(), revision: "1", targetRunId: f.runId };
    const commentId = randomUUID();
    await expectDeniedNoEffect(f, () => request(a).post(`/api/issues/${f.issueId}/queued-comments/${commentId}/steer`).send(body),
      () => request(a).post(`/api/issues/${randomUUID()}/queued-comments/${commentId}/steer`).send(body));
  });

  // ================= OVER-BLOCKING CONTROLS (must still work) =================
  const ALLOWED: Array<[string, (f: Seeded) => Principal]> = [
    ["owner/creator", () => ({ kind: "user", userId: OWNER })],
    ["still-granted user", () => ({ kind: "user", userId: GRANTED })],
    ["instance admin", () => ({ kind: "user", userId: ADMIN, instanceAdmin: true })],
    ["local_trusted board", () => ({ kind: "user", userId: "local-board", local: true })],
  ];

  describe.each(ALLOWED)("control %s on the private task", (_label, principal) => {
    it("F1 lock then unlock → 200 with the document", async () => {
      const f = await seed();
      const a = app(f.companyId, principal(f));
      const lock = await request(a).post(`/api/issues/${f.issueId}/documents/plan/lock`).send({});
      expect(lock.status, JSON.stringify(lock.body)).toBe(200);
      expect(lock.body.body).toBe(DOC_TEXT);
      expect(lock.body.lockedAt).toBeTruthy();
      const unlock = await request(a).post(`/api/issues/${f.issueId}/documents/plan/unlock`).send({});
      expect(unlock.status, JSON.stringify(unlock.body)).toBe(200);
    });
    it("F2/F3/F7/F8 reads → 200", async () => {
      const f = await seed();
      const a = app(f.companyId, principal(f));
      const execution = await request(a).get(`/api/issues/${f.issueId}/execution`);
      expect(execution.status, JSON.stringify(execution.body)).toBe(200);
      expect(execution.body?.runId).toBe(f.runId);
      for (const path of ["active-run", "live-runs", "feedback-traces", "activity", "runs", "accepted-plan-decompositions"]) {
        const r = await request(a).get(`/api/issues/${f.issueId}/${path}`);
        expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
      }
      const read = await request(a).post(`/api/issues/${f.issueId}/read`).send({});
      expect(read.status, JSON.stringify(read.body)).toBe(200);
    });
    it("F4 wake the assigned agent for the task → 202", async () => {
      const f = await seed();
      const a = app(f.companyId, principal(f));
      const wake = await request(a).post(`/api/agents/${f.agentId}/wakeup`)
        .send({ source: "on_demand", triggerDetail: "manual", reason: "ov_control_wake", payload: { issueId: f.issueId } });
      expect(wake.status, JSON.stringify(wake.body)).toBe(202);
    });
    it("F6 create, then cancel an interaction → 201 / 200; F9 title → 200", async () => {
      const f = await seed();
      const a = app(f.companyId, principal(f));
      const created = await request(a).post(`/api/issues/${f.issueId}/interactions`)
        .send({ kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Ship it?" } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const accepted = await request(a).post(`/api/issues/${f.issueId}/interactions/${created.body.id}/accept`).send({});
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      const title = await request(a).put(`/api/issues/${f.issueId}/title`).send({ title: "Renamed by insider" });
      expect(title.status, JSON.stringify(title.body)).toBe(200);
    });
  });

  describe("control: the AGENT ASSIGNED to the private task", () => {
    it("comments, edits its documents, reads its execution, wakes itself, creates an interaction", async () => {
      const f = await seed();
      const a = app(f.companyId, { kind: "agent", agentId: f.agentId, runId: f.runId });
      const comment = await request(a).post(`/api/issues/${f.issueId}/comments`).send({ body: "assigned agent update" });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);
      const doc = await request(a).put(`/api/issues/${f.issueId}/documents/notes`).send({ title: "Notes", body: "agent notes", format: "markdown" });
      expect([200, 201], JSON.stringify(doc.body)).toContain(doc.status);
      const execution = await request(a).get(`/api/issues/${f.issueId}/execution`);
      expect(execution.status, JSON.stringify(execution.body)).toBe(200);
      const activeRun = await request(a).get(`/api/issues/${f.issueId}/active-run`);
      expect(activeRun.status, JSON.stringify(activeRun.body)).toBe(200);
      const wake = await request(a).post(`/api/agents/${f.agentId}/wakeup`)
        .send({ source: "on_demand", triggerDetail: "manual", reason: "ov_self_wake", payload: { issueId: f.issueId } });
      expect(wake.status, JSON.stringify(wake.body)).toBe(202);
      const interaction = await request(a).post(`/api/issues/${f.issueId}/interactions`)
        .send({ kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Agent asks" } });
      expect(interaction.status, JSON.stringify(interaction.body)).toBe(201);
      const activity = await request(a).get(`/api/issues/${f.issueId}/activity`);
      expect(activity.status, JSON.stringify(activity.body)).toBe(200);
    });
  });

  describe("control: a NON-private task for any member (never-granted user, other agent)", () => {
    it("never-granted user: lock, execution, activity, wake, interaction, title", async () => {
      const f = await seed();
      const a = app(f.companyId, { kind: "user", userId: NEVER });
      const lock = await request(a).post(`/api/issues/${f.openIssueId}/documents/plan/lock`).send({});
      expect(lock.status, JSON.stringify(lock.body)).toBe(200);
      for (const path of ["execution", "active-run", "activity", "runs", "feedback-traces"]) {
        const r = await request(a).get(`/api/issues/${f.openIssueId}/${path}`);
        expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
      }
      const wake = await request(a).post(`/api/agents/${f.agentId}/wakeup`)
        .send({ source: "on_demand", triggerDetail: "manual", reason: "ov_open_wake", payload: { issueId: f.openIssueId } });
      expect(wake.status, JSON.stringify(wake.body)).toBe(202);
      const created = await request(a).post(`/api/issues/${f.openIssueId}/interactions`)
        .send({ kind: "request_confirmation", continuationPolicy: "none", payload: { version: 1, prompt: "Open?" } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const title = await request(a).put(`/api/issues/${f.openIssueId}/title`).send({ title: "Open renamed" });
      expect(title.status, JSON.stringify(title.body)).toBe(200);
    });
    it("other (non-assigned) agent: execution and activity on the open task", async () => {
      const f = await seed();
      const a = app(f.companyId, { kind: "agent", agentId: f.otherAgentId });
      for (const path of ["execution", "activity"]) {
        const r = await request(a).get(`/api/issues/${f.openIssueId}/${path}`);
        expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
      }
    });
  });

  it("control: a scheduled/system wake on the private task is not cut by the overlay", async () => {
    const f = await seed();
    const { heartbeatService } = await import("../services/heartbeat.js");
    const before = (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, f.companyId))).length;
    await heartbeatService(db).wakeup(f.agentId, {
      source: "timer", triggerDetail: "system", reason: "ov_scheduled", payload: { issueId: f.issueId },
      requestedByActorType: "system", requestedByActorId: null,
    } as any);
    const after = await db.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, f.companyId)));
    expect(after.length).toBeGreaterThan(before);
  });
});
