import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  issues,
  runIdentityContexts,
} from "@paperclipai/db";
import { runningProcesses } from "../adapters/index.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
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

  function app(companyId: string, userId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "session",
        userId,
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
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

  it("GET /issues/:id/queued-comments: revoked → 404 without bodies; granted → the held bodies", async () => {
    const f = await seedPrivateHeldQueue();
    const before = await snapshot(f);
    expectDenied(await request(app(f.companyId, REVOKED)).get(`/api/issues/${f.issueId}/queued-comments`));
    await expectNothingChanged(f, before);
    const queue = await queueFor(f, GRANTED);
    expect(queue.entries.map((entry: any) => entry.comment.body)).toEqual([OWNER_TEXT, REVOKED_TEXT, GRANTED_TEXT]);
  });

  it("PATCH /issues/:id/queued-comments/:commentId: revoked → 404, own message unchanged; granted → edits", async () => {
    const f = await seedPrivateHeldQueue();
    const queue = await queueFor(f, OWNER);
    const before = await snapshot(f);
    expectDenied(await request(app(f.companyId, REVOKED))
      .patch(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[REVOKED]}`)
      .send({ queueId: queue.queueId, revision: queue.revision, body: "edited after revoke" }));
    await expectNothingChanged(f, before);
    const edited = await request(app(f.companyId, GRANTED))
      .patch(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[GRANTED]}`)
      .send({ queueId: queue.queueId, revision: queue.revision, body: "granted edit" });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const [row] = await db.select().from(issueComments).where(eq(issueComments.id, f.commentIds[GRANTED]!));
    expect(row?.body).toBe("granted edit");
  });

  it("PUT /issues/:id/queued-comments/order: revoked → 404, order unchanged; granted → reorders", async () => {
    const f = await seedPrivateHeldQueue();
    const queue = await queueFor(f, OWNER);
    const reversed = [f.commentIds[GRANTED], f.commentIds[REVOKED], f.commentIds[OWNER]];
    const before = await snapshot(f);
    expectDenied(await request(app(f.companyId, REVOKED)).put(`/api/issues/${f.issueId}/queued-comments/order`)
      .send({ queueId: queue.queueId, revision: queue.revision, orderedCommentIds: reversed }));
    await expectNothingChanged(f, before);
    const reordered = await request(app(f.companyId, GRANTED)).put(`/api/issues/${f.issueId}/queued-comments/order`)
      .send({ queueId: queue.queueId, revision: queue.revision, orderedCommentIds: reversed });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.body.entries.map((entry: any) => entry.comment.id)).toEqual(reversed);
  });

  it("POST /issues/:id/queued-comments/interrupt: revoked → 404, no intent, no run; granted → sends once", async () => {
    const f = await seedPrivateHeldQueue();
    await stopRunForSend(f);
    const queue = await queueFor(f, OWNER);
    expect(queue.targetRunId).toBeNull();
    const body = { queueId: f.wakeId, revision: queue.revision, targetRunId: null };
    const before = await snapshot(f);
    expectDenied(await request(app(f.companyId, REVOKED)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`).send(body));
    await expectNothingChanged(f, before);

    const sent = await request(app(f.companyId, GRANTED)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`).send(body);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
    expect(wake?.status).toBe("coalesced");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake!.runId!));
    expect(successor?.status).toBe("queued");
    expect(successor?.responsibleUserId).toBe(GRANTED);
  });

  it("POST /issues/:id/queued-comments/:commentId/steer: revoked → 404, nothing steered; granted → steers", async () => {
    const f = await seedPrivateHeldQueue();
    await seedDispatchIdentity(f);
    const queue = await queueFor(f, OWNER);
    const body = { queueId: f.wakeId, targetRunId: f.runId, revision: queue.revision };
    const before = await snapshot(f);
    const calls = steerNativeSessionMock.mock.calls.length;
    expectDenied(await request(app(f.companyId, REVOKED))
      .post(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[REVOKED]}/steer`).send(body));
    expect(steerNativeSessionMock.mock.calls).toHaveLength(calls);
    await expectNothingChanged(f, before);

    steerNativeSessionMock.mockResolvedValueOnce({ turnId: "granted-turn" });
    const steered = await request(app(f.companyId, GRANTED))
      .post(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[GRANTED]}/steer`).send(body);
    expect(steered.status, JSON.stringify(steered.body)).toBe(200);
    expect(steerNativeSessionMock.mock.calls).toHaveLength(calls + 1);
  });

  it("DELETE /issues/:id/queued-comments/:commentId: revoked → 404, message kept; granted → discards", async () => {
    const f = await seedPrivateHeldQueue();
    const queue = await queueFor(f, OWNER);
    const before = await snapshot(f);
    expectDenied(await request(app(f.companyId, REVOKED))
      .delete(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[REVOKED]}`)
      .send({ queueId: queue.queueId, revision: queue.revision }));
    await expectNothingChanged(f, before);
    const discarded = await request(app(f.companyId, GRANTED))
      .delete(`/api/issues/${f.issueId}/queued-comments/${f.commentIds[GRANTED]}`)
      .send({ queueId: queue.queueId, revision: queue.revision });
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    expect(discarded.body.entries.map((entry: any) => entry.comment.id))
      .toEqual([f.commentIds[OWNER], f.commentIds[REVOKED]]);
  });
});
