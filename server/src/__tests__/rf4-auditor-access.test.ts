import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

function auditEvidence(kind: string, detail: unknown) {
  appendFileSync(`${process.env.TASK_OUT}/auditor-observations.jsonl`, JSON.stringify({ kind, detail }) + "\n");
}
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAccessGrants,
  issueComments,
  issueReadStates,
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { agentRoutes } from "../routes/agents.js";
import { activityRoutes } from "../routes/activity.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// rf-4 c4z: a user whose explicit grant on a PRIVATE task was revoked must not
// read, change, send or steer that task's held messages. Every held-list route
// must answer the same 404 a missing task gets (assertIssueReadAllowed), write
// nothing, return no message body and queue no run. A still-granted user is the
// control: the same request works.

const steerNativeSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../services/native-runtime/native-session-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/native-runtime/native-session-executor.js")>();
  steerNativeSessionMock.mockImplementation(actual.steerNativeSession);
  return { ...actual, steerNativeSession: steerNativeSessionMock };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OWNER = "private-owner";
const REVOKED = "revoked-operator";
const GRANTED = "granted-operator";
const OWNER_TEXT = "OWNER-PRIVATE-HELD-BODY";
const REVOKED_TEXT = "REVOKED-USER-HELD-BODY";
const GRANTED_TEXT = "GRANTED-USER-HELD-BODY";

describeEmbeddedPostgres("queued-comment routes after a private-task grant is revoked (rf-4 c4z)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  const children: ChildProcess[] = [];
  const childRunIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-revoked-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
  }, 60_000);

  afterEach(async () => {
    for (const id of childRunIds) runningProcesses.delete(id);
    for (const child of children) child.kill();
    children.length = 0;
    childRunIds.length = 0;
    steerNativeSessionMock.mockClear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string, userId: string, role: "operator" | "owner" = "operator") {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: role }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use("/api", agentRoutes(db));
    testApp.use("/api", activityRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  /**
   * Real producers only for the access and the held messages: the owner grants
   * both operators through POST access-grants, each person posts a message
   * through POST comments while the task's run is alive (so the message is
   * held), and the owner revokes one grant through POST revoke. The company,
   * agent, private task and live run are planted.
   */
  async function seedPrivateHeldQueue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    await db.insert(companies).values({
      id: companyId, name: "Private queue company",
      issuePrefix: `Q${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([OWNER, REVOKED, GRANTED].map(id => ({
      id, name: id, email: `${id}@example.test`, createdAt: now, updatedAt: now,
    })));
    await db.insert(companyMemberships).values([OWNER, REVOKED, GRANTED].map(principalId => ({
      companyId, principalType: "user", principalId, status: "active", membershipRole: "operator",
    })));
    await db.insert(agents).values({
      id: agentId, companyId, name: "Paperclip Runner", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "assignment", triggerDetail: "revoked access test",
      status: "running", runtimeMode: "native", startedAt: new Date("2026-08-22T15:00:00.000Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId, companyId, identifier: "PRIV-1", title: "Private held queue",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId, executionRunId: runId,
      visibility: "private", privacyRootIssueId: issueId, responsibleUserId: OWNER, createdByUserId: OWNER,
    });
    // A real issue-scoped run uses the durable privacy binding, not contextSnapshot alone.
    await db.update(heartbeatRuns).set({ scopeKind: "issue", issueId }).where(eq(heartbeatRuns.id, runId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    childRunIds.push(runId);
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });

    const owner = app(companyId, OWNER);
    const grants: Record<string, string> = {};
    for (const subjectId of [REVOKED, GRANTED]) {
      const granted = await request(owner).post(`/api/issues/${issueId}/access-grants`)
        .send({ subjectType: "user", subjectId });
      expect(granted.status, JSON.stringify(granted.body)).toBe(201);
      grants[subjectId] = granted.body.id;
    }
    // Both operators can read the task while granted.
    await request(app(companyId, REVOKED)).get(`/api/issues/${issueId}`).expect(200);

    const commentIds: Record<string, string> = {};
    for (const [userId, body] of [[OWNER, OWNER_TEXT], [REVOKED, REVOKED_TEXT], [GRANTED, GRANTED_TEXT]] as const) {
      const posted = await request(app(companyId, userId)).post(`/api/issues/${issueId}/comments`).send({ body });
      expect(posted.status, JSON.stringify(posted.body)).toBe(201);
      commentIds[userId] = posted.body.id;
    }
    const wakeId = await vi.waitFor(async () => {
      const [wake] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution")));
      const ids = (wake?.payload as any)?._paperclipWakeContext?.wakeCommentIds ?? [];
      expect(ids).toHaveLength(3);
      return wake!.id;
    }, { timeout: 10_000 });

    const revoked = await request(owner).post(`/api/issues/${issueId}/access-grants/${grants[REVOKED]}/revoke`).send({});
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
    expect(revoked.body.revokedAt).toBeTruthy();
    const [grantRow] = await db.select().from(issueAccessGrants).where(eq(issueAccessGrants.id, grants[REVOKED]!));
    expect(grantRow?.revokedAt).toBeTruthy();
    // The revoke is real: the task itself is now hidden from the revoked user.
    await request(app(companyId, REVOKED)).get(`/api/issues/${issueId}`).expect(404);

    return { companyId, agentId, issueId, runId, wakeId, commentIds, grants };
  }

  type Seeded = Awaited<ReturnType<typeof seedPrivateHeldQueue>>;

  /** Stop the run so Send has something to send, and keep the successor queued (no provider launch). */
  async function stopRunForSend(f: Seeded) {
    runningProcesses.delete(f.runId);
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded",
      finishedAt: new Date("2026-08-22T15:03:00.000Z") }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.issueId));
    // Occupy this agent on a different task so the successor stays queued.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "running", contextSnapshot: { issueId: randomUUID() } });
  }

  async function seedDispatchIdentity(f: Seeded) {
    const [identity] = await db.insert(runIdentityContexts).values({
      companyId: f.companyId, runId: f.runId, revision: 1, cause: "dispatch", correlationId: "dispatch",
      status: "accepted", acceptedAt: new Date("2026-08-22T15:00:00.000Z"),
    }).returning();
    await db.update(heartbeatRuns).set({ activeIdentityContextId: identity!.id }).where(eq(heartbeatRuns.id, f.runId));
  }

  async function snapshot(f: Seeded) {
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))
      .orderBy(agentWakeupRequests.id);
    const runs = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, f.companyId)).orderBy(heartbeatRuns.id);
    const comments = await db.select({ id: issueComments.id, body: issueComments.body, deletedAt: issueComments.deletedAt })
      .from(issueComments).where(eq(issueComments.issueId, f.issueId)).orderBy(issueComments.id);
    const activity = await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.companyId, f.companyId));
    const identities = await db.select({ id: runIdentityContexts.id }).from(runIdentityContexts)
      .where(eq(runIdentityContexts.companyId, f.companyId));
    return { wakes, runs, comments, activity: activity.length, identities: identities.length };
  }

  function expectDenied(response: request.Response) {
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(response.body).toEqual({ error: "Issue not found" });
    const text = JSON.stringify(response.body);
    for (const body of [OWNER_TEXT, REVOKED_TEXT, GRANTED_TEXT]) expect(text).not.toContain(body);
  }

  async function expectNothingChanged(f: Seeded, before: Awaited<ReturnType<typeof snapshot>>) {
    const after = await snapshot(f);
    expect(after).toEqual(before);
    for (const wake of after.wakes) expect((wake.payload as any)?.queuedCommentInterrupt).toBeUndefined();
    expect(after.wakes.find(wake => wake.id === f.wakeId)?.status).toBe("deferred_issue_execution");
  }

  async function queueFor(f: Seeded, userId: string) {
    const queue = await request(app(f.companyId, userId)).get(`/api/issues/${f.issueId}/queued-comments`);
    expect(queue.status, JSON.stringify(queue.body)).toBe(200);
    return queue.body;
  }

  it.each(["edit", "reorder", "interrupt", "steer"])("responsible task owner control: %s", async (action) => {
    const f = await seedPrivateHeldQueue();
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, OWNER)));
    if (action === "interrupt") await stopRunForSend(f);
    if (action === "steer") await seedDispatchIdentity(f);
    const queue = await queueFor(f, OWNER);
    const owner = app(f.companyId, OWNER, "owner");
    let result: request.Response;
    if (action === "edit") result = await request(owner).patch(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[OWNER]}`)
      .send({ queueId: queue.queueId, revision: queue.revision, body: "owner revised" });
    else if (action === "reorder") result = await request(owner).put(`/api/issues/${f.issueId}/queued-comments/order`)
      .send({ queueId: queue.queueId, revision: queue.revision, orderedCommentIds: [f.commentIds[GRANTED], f.commentIds[REVOKED], f.commentIds[OWNER]] });
    else if (action === "interrupt") result = await request(owner).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: null });
    else {
      steerNativeSessionMock.mockResolvedValueOnce({ turnId: "owner-turn" });
      result = await request(owner).post(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[OWNER]}/steer`)
        .send({ queueId: queue.queueId, revision: queue.revision, targetRunId: f.runId });
    }
    expect(result.status, JSON.stringify(result.body)).toBe(200);
  });

  it.each(["wakeup", "heartbeat/invoke"])("AUDIT agent %s carrying private issue id must require read before wake admission", async endpoint => {
    const f = await seedPrivateHeldQueue();
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.agentId));
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", startedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    const before = await snapshot(f);
    const response = await request(app(f.companyId, REVOKED)).post(`/api/agents/${f.agentId}/${endpoint}`)
      .send({ source: "on_demand", triggerDetail: "manual", reason: "audit_private_wake", payload: { issueId: f.issueId } });
    const after = await snapshot(f);
    auditEvidence("AUDIT_WAKE", { endpoint, status: response.status, body: response.body, wakesBefore: before.wakes.length, wakesAfter: after.wakes.length, runsBefore: before.runs.length, runsAfter: after.runs.length, activityBefore: before.activity, activityAfter: after.activity });
    expect(response.status).toBe(404);
    expect(after).toEqual(before);
  });

  it("AUDIT mark-read is private: revoked user must receive 404 without a read-state or activity write", async () => {
    const f = await seedPrivateHeldQueue();
    const before = await snapshot(f);
    const response = await request(app(f.companyId, REVOKED)).post(`/api/issues/${f.issueId}/read`).send({});
    const reads = await db.select().from(issueReadStates).where(and(eq(issueReadStates.issueId, f.issueId), eq(issueReadStates.userId, REVOKED)));
    auditEvidence("AUDIT_MARK_READ", { status: response.status, body: response.body, writtenReadStates: reads.length, activityBefore: before.activity, activityAfter: (await snapshot(f)).activity });
    expectDenied(response);
    expect(reads).toHaveLength(0);
    await expectNothingChanged(f, before);
  });

  it.each(["execution", "active-run"])("AUDIT indirect issue run data: %s must require current read access", async path => {
    const f = await seedPrivateHeldQueue();
    const response = await request(app(f.companyId, REVOKED)).get(`/api/issues/${f.issueId}/${path}`);
    auditEvidence("AUDIT_RUN", { path, status: response.status, body: response.body, privateRunId: f.runId });
    expectDenied(response);
  });

  it("AUDIT document lock must not return private document text or mutate for a revoked user", async () => {
    const f = await seedPrivateHeldQueue();
    const document = await request(app(f.companyId, OWNER)).put(`/api/issues/${f.issueId}/documents/plan`)
      .send({ title: "Private plan", body: "AUDITOR-PRIVATE-DOCUMENT-CONTENT", format: "markdown" });
    expect([200, 201], JSON.stringify(document.body)).toContain(document.status);
    const response = await request(app(f.companyId, REVOKED)).post(`/api/issues/${f.issueId}/documents/plan/lock`).send({});
    auditEvidence("AUDIT_DOC_LOCK", { status: response.status, body: response.body });
    expectDenied(response);
  });

  it.each(["activity", "runs"])("AUDIT issue %s denial must be indistinguishable from a missing issue", async path => {
    const f = await seedPrivateHeldQueue();
    const response = await request(app(f.companyId, REVOKED)).get(`/api/issues/${f.issueId}/${path}`);
    const missing = await request(app(f.companyId, REVOKED)).get(`/api/issues/${randomUUID()}/${path}`);
    auditEvidence("AUDIT_ACTIVITY_ORACLE", { path, revokedStatus: response.status, revokedBody: response.body, missingStatus: missing.status, missingBody: missing.body });
    expect(response.status).toBe(missing.status);
    expect(response.body).toEqual(missing.body);
  });

  it("AUDIT manager-agent steer private denial must match missing-issue denial", async () => {
    const f = await seedPrivateHeldQueue();
    const managerId = randomUUID();
    await db.insert(agents).values({ id: managerId, companyId: f.companyId, name: "Auditor Manager", role: "ceo", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: managerId, status: "active", membershipRole: "operator" });
    await db.update(agents).set({ reportsTo: managerId }).where(eq(agents.id, f.agentId));
    const agentApp = express();
    agentApp.use(express.json());
    agentApp.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", agentId: managerId, companyId: f.companyId, onBehalfOfUserId: OWNER,
        onBehalfOfMemberships: [{ companyId: f.companyId, status: "active", membershipRole: "operator" }] };
      next();
    });
    agentApp.use("/api", issueRoutes(db, {} as any, {}));
    agentApp.use(errorHandler);
    const grant = await request(app(f.companyId, OWNER)).post(`/api/issues/${f.issueId}/access-grants`).send({ subjectType: "agent", subjectId: managerId });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    await request(agentApp).get(`/api/issues/${f.issueId}`).expect(200);
    await request(app(f.companyId, OWNER)).post(`/api/issues/${f.issueId}/access-grants/${grant.body.id}/revoke`).send({}).expect(200);
    await request(agentApp).get(`/api/issues/${f.issueId}`).expect(404);
    const queue = await queueFor(f, OWNER);
    const body = { queueId: queue.queueId, revision: queue.revision, targetRunId: f.runId };
    const suffix = `/queued-comments/${f.commentIds[OWNER]}/steer`;
    const privateResponse = await request(agentApp).post(`/api/issues/${f.issueId}${suffix}`).send(body);
    const missingResponse = await request(agentApp).post(`/api/issues/${randomUUID()}${suffix}`).send(body);
    auditEvidence("AUDIT_MANAGER_STEER", { privateStatus: privateResponse.status, privateBody: privateResponse.body, missingStatus: missingResponse.status, missingBody: missingResponse.body });
    expect(privateResponse.status, JSON.stringify({ private: privateResponse.body, missing: missingResponse.body })).toBe(missingResponse.status);
    expect(privateResponse.body).toEqual(missingResponse.body);
  });

  it.each(["", "/events", "/log"])("AUDIT run-by-id%s is protected after revoke", async suffix => {
    const f = await seedPrivateHeldQueue();
    const response = await request(app(f.companyId, REVOKED)).get(`/api/heartbeat-runs/${f.runId}${suffix}`);
    auditEvidence("AUDIT_RUN_ID", { suffix, status: response.status, body: response.body });
    expect(response.status).toBe(404);
  });
});
