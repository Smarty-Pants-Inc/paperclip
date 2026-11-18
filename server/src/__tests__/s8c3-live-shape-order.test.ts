import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, companyMemberships, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues,
  issueRecoveryActions, nativeRunFinalizations,
} from "@paperclipai/db";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// S8 c3 RED from the LIVE shape (Paul's Night S8, M0013-M0017, 11-17 21:13Z;
// principal-lead's 4-message row): a busy turn, three messages queued, the
// person's Interrupt, a fourth message +7 s. ONE successor carries M1-M3 in the
// order written, M4 runs after them, each is answered once, nothing is skipped.
// Plus the promotion-only row: a consumed saved wake is never promoted by the
// durable release when no Interrupt route ran (the route's settle is bypassed).
describeEmbeddedPostgres("S8 c3 live shape: Interrupt + a message 7 s later", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-s8-order-");
    db = createDb(tempDb.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 30_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await tempDb?.cleanup(); });

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "session", userId: "queue-owner", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  // A busy native chat turn with three messages queued behind it, one wake each.
  async function seedBusyChat() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Order", issuePrefix: "ORD", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Chat Runner", role: "engineer", status: "idle",
      adapterType: "paperclip_runner", adapterConfig: {}, permissions: {},
      // Successors stay queued behind the occupying run; no provider launches.
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "queue-owner",
      status: "active", membershipRole: "operator" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "assignment",
      triggerDetail: "order test", status: "running", runtimeMode: "native", startedAt: new Date(Date.now() - 600_000),
      createdAt: new Date(Date.now() - 600_000), contextSnapshot: { issueId }, nativeIssueId: issueId, responsibleUserId: "queue-owner" });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: randomUUID() } });
    await db.insert(issues).values({ id: issueId, companyId, identifier: "ORD-1", title: "Chat", status: "in_progress",
      priority: "medium", assigneeAgentId: agentId, executionRunId: runId,
      conversationAgentId: agentId, conversationUserId: "queue-owner", conversationState: "active" });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "observed" });
    const commentIds = [randomUUID(), randomUUID(), randomUUID()];
    const wakeIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of commentIds.entries()) {
      const at = new Date(Date.now() - 300_000 + index * 30_000);
      await db.insert(issueComments).values({ id, companyId, issueId, authorType: "user", authorUserId: "queue-owner",
        body: `M${index + 1}`, clientRequestId: randomUUID(), createdAt: at, updatedAt: at });
      await db.insert(agentWakeupRequests).values({ id: wakeIds[index], companyId, agentId, source: "on_demand",
        triggerDetail: "manual", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "queue-owner", requestedAt: at,
        idempotencyKey: `conversation-comment:${id}`,
        payload: { issueId, commentId: id, _paperclipWakeContext: { issueId, commentId: id, wakeCommentId: id, wakeCommentIds: [id] } } });
    }
    return { companyId, agentId, issueId, runId, commentIds, wakeIds };
  }

  async function press(f: Awaited<ReturnType<typeof seedBusyChat>>, targetRunId = f.runId) {
    const client = app(f.companyId);
    const queue = await request(client).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries.map((entry: any) => entry.comment.body)).toEqual(["M1", "M2", "M3"]);
    const pressed = await request(client).post(`/api/issues/${f.issueId}/queued-comments/interrupt`)
      .send({ queueId: f.wakeIds[0], targetRunId, revision: queue.body.revision });
    expect(pressed.status, JSON.stringify(pressed.body)).toBe(200);
    await acknowledgeStop(f);
  }

  async function sendLater(f: Awaited<ReturnType<typeof seedBusyChat>>, body = "M4") {
    const id = randomUUID();
    await db.insert(issueComments).values({ id, companyId: f.companyId, issueId: f.issueId, authorType: "user",
      authorUserId: "queue-owner", body, clientRequestId: randomUUID() });
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await deliverConversationComments(db, issue, heartbeatService(db).wakeup);
    const [wake] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${id}`));
    return { id, wake };
  }

  const successors = async (f: { companyId: string; issueId: string; runId: string }) =>
    (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .filter(run => run.id !== f.runId && run.contextSnapshot?.issueId === f.issueId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Live shape: the runner acknowledged the person's Stop, so the release
  // recorded no recovery hold (postgres.ts isAcknowledgedNativeStop). The
  // harness has no runner, so it writes that acknowledgement itself.
  async function acknowledgeStop(f: { companyId: string; issueId: string; runId: string }) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stopped.status).toBe("cancelled");
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
        dispatched: true, intentAuditId: "s8", acknowledgementAuditId: "s8" } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
  }

  async function finishTeardown(f: Awaited<ReturnType<typeof seedBusyChat>>) {
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ processPid: 999_999_999, resultJson: { ...stopped.resultJson,
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: f.runId, companyId: f.companyId,
        issueId: f.issueId, scope: "run", reasonCode: "cancellation_run_only", dispatchState: "acknowledged",
        dispatched: true, intentAuditId: "s8", acknowledgementAuditId: "s8" } } }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", leaseOwner: null })
      .where(eq(nativeRunFinalizations.runId, f.runId));
  }


  const release = (runId: string, companyId: string) => createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
    resolveResponsibleUserId: async () => "queue-owner",
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } })(
    { companyId, runId, now: new Date() });

  // The run completes with its published final reply, and the durable release runs.
  async function succeedAndRelease(f: { companyId: string; issueId: string; agentId: string }, runId: string, body: string) {
    const now = new Date();
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native", nativeIssueId: f.issueId,
      startedAt: now, finishedAt: now }).where(eq(heartbeatRuns.id, runId));
    const [fin] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    if (fin) await db.update(nativeRunFinalizations).set({ phase: "committed", leaseOwner: null }).where(eq(nativeRunFinalizations.runId, runId));
    else await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.issueId, runId, phase: "committed", leaseOwner: null });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: runId, body });
    return release(runId, f.companyId);
  }

  const inputs = (run: { contextSnapshot: Record<string, unknown> | null }) =>
    (run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? [];

  it("LIVE SHAPE: one successor carries [M1,M2,M3] in order, M4 (+7 s) after them, each answered once, nothing skipped", async () => {
    const f = await seedBusyChat();
    await press(f);
    // The person writes M4 seven seconds after the Interrupt (live: 21:14:02 -> 21:14:09).
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    const m4 = await sendLater(f);
    await finishTeardown(f);
    const service = heartbeatService(db);
    await service.resumeQueuedCommentInterrupt(f.companyId, f.wakeIds[0]);
    const early = await successors(f);
    expect(early.map(inputs)).toEqual([f.commentIds]);
    await succeedAndRelease(f, early[0].id, "Final reply to M1, M2 and M3");
    const second = await successors(f);
    expect(second.map(inputs)).toEqual([f.commentIds, [m4.id]]);
    await succeedAndRelease(f, second[1].id, "Final reply to M4");
    const runs = await successors(f);
    const answered = runs.flatMap(inputs);
    expect(answered).toEqual([...f.commentIds, m4.id]);
    expect(new Set(answered).size).toBe(answered.length);
    const deferred = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(deferred).toEqual([]);
    const queue = await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    expect(queue.body.entries ?? []).toEqual([]);
  }, 120_000);

  // An earlier turn carried `indices` as its own input, had started answering
  // them (it read the input and began its reply) and its sender, the person,
  // stopped it: app-lead's senderStoppedWhileAnswering holds for each.
  async function senderStoppedWhileAnswering(f: Awaited<ReturnType<typeof seedBusyChat>>, indices: number[]) {
    const stoppedId = randomUUID();
    const own = indices.map((i) => f.commentIds[i]);
    await db.insert(heartbeatRuns).values({ id: stoppedId, companyId: f.companyId, agentId: f.agentId, status: "cancelled",
      runtimeMode: "native", nativeIssueId: f.issueId, errorCode: "cancelled",
      createdAt: new Date(Date.now() - 260_000), startedAt: new Date(Date.now() - 250_000), finishedAt: new Date(Date.now() - 240_000),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "queue-owner", executionCancellation: { state: "acknowledged" } },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: own[0], wakeCommentIds: own } });
    await db.insert(heartbeatRunEvents).values([
      { companyId: f.companyId, runId: stoppedId, agentId: f.agentId, seq: 1, eventType: "item.started", sourceEventId: `s8c3-${stoppedId}-1`,
        payload: { prpEvent: { turnId: "t1", itemId: "u1", payload: { kind: "userMessage" } } } },
      { companyId: f.companyId, runId: stoppedId, agentId: f.agentId, seq: 2, eventType: "item.started", sourceEventId: `s8c3-${stoppedId}-2`,
        payload: { prpEvent: { turnId: "t1", itemId: "a1", payload: { kind: "agentMessage" } } } },
    ]);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: stoppedId, body: "Partial progress, not a final answer", createdAt: new Date(Date.now() - 245_000) });
    return stoppedId;
  }

  it("F1b: an Interrupt whose whole batch its sender stopped while answered presses NOTHING; no run carries M1-M3; their wakes settled", async () => {
    const f = await seedBusyChat();
    const stoppedId = await senderStoppedWhileAnswering(f, [0, 1, 2]);
    await press(f);
    await finishTeardown(f);
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId, f.wakeIds[0]);
    const runs = (await successors(f)).filter((run) => run.id !== stoppedId);
    expect(runs.flatMap(inputs).filter((id) => (f.commentIds as string[]).includes(id))).toEqual([]);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(f.wakeIds.map((id) => wakes.find((wake) => wake.id === id)?.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  }, 120_000);

  it("PROMOTION ONLY: the durable release never promotes a saved wake its own sender stopped while answered (no Interrupt route ran)", async () => {
    const f = await seedBusyChat();
    // An earlier turn carried M1 as its own input, had started answering it
    // (it read the message and began its reply) and its sender, the person,
    // stopped it. M1's saved wake is still deferred; no Interrupt is pressed.
    const stoppedId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: stoppedId, companyId: f.companyId, agentId: f.agentId, status: "cancelled",
      runtimeMode: "native", nativeIssueId: f.issueId, errorCode: "cancelled",
      createdAt: new Date(Date.now() - 260_000), startedAt: new Date(Date.now() - 250_000), finishedAt: new Date(Date.now() - 240_000),
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "queue-owner", executionCancellation: { state: "acknowledged" } },
      contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentIds[0], wakeCommentIds: [f.commentIds[0]] } });
    await db.insert(heartbeatRunEvents).values([
      { companyId: f.companyId, runId: stoppedId, agentId: f.agentId, seq: 1, eventType: "item.started", sourceEventId: "s8c3-1",
        payload: { prpEvent: { turnId: "t1", itemId: "u1", payload: { kind: "userMessage" } } } },
      { companyId: f.companyId, runId: stoppedId, agentId: f.agentId, seq: 2, eventType: "item.started", sourceEventId: "s8c3-2",
        payload: { prpEvent: { turnId: "t1", itemId: "a1", payload: { kind: "agentMessage" } } } },
    ]);
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: stoppedId, body: "Partial progress, not a final answer", createdAt: new Date(Date.now() - 245_000) });
    // The busy turn ends; the durable release promotes the next saved wake.
    await succeedAndRelease(f, f.runId, "Final reply to the busy turn");
    const runs = (await successors(f)).filter((run) => run.id !== stoppedId);
    const [m1Wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeIds[0]));
    expect(runs.flatMap(inputs)).not.toContain(f.commentIds[0]);
    expect(runs.flatMap(inputs)).toContain(f.commentIds[1]);
    expect(m1Wake.status).toBe("cancelled");
  }, 120_000);
});
