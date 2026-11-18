import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
const evidence = (kind: string, value: unknown) => appendFileSync(process.env.TASK_OUT + '/judge-observations.jsonl', JSON.stringify({kind,value})+'\n');
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues,
  issueRecoveryActions, nativeRunFinalizations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// S8 order (Paul note 6): after an Interrupt, a message the person wrote later
// never runs before the messages queued earlier; each is answered once.
describeEmbeddedPostgres("RF4 independent S8 acceptance", () => {
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
    const [task] = await db.select().from(issues).where(eq(issues.id,f.issueId));
    expect(queue.body.entries.map((entry: any) => entry.comment.body)).toEqual(task.conversationAgentId ? ["M1", "M2", "M3"] : ["M1"]);
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

  it("answers M1, M2, M3, then the message written after the Interrupt, each once", async () => {
    const f = await seedBusyChat();
    const pressedAt = Date.now();
    await press(f);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stopped.status).toBe("cancelled");
    // The person writes M4 a few seconds after the press, while its teardown runs.
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("deferred_issue_execution");
    expect(await successors(f)).toEqual([]);
    await finishTeardown(f);
    const service = heartbeatService(db);
    await service.resumeQueuedCommentInterrupt(f.companyId, f.wakeIds[0]);
    const [first, ...early] = await successors(f);
    expect(early).toEqual([]);
    // The press sends everything that was waiting, in the order written.
    evidence('SUCCESSOR_INPUT', { pressedAt, admittedAt: first.createdAt.getTime(), elapsedMs: first.createdAt.getTime() - pressedAt, expected: f.commentIds, input: first.contextSnapshot?.wakeCommentIds });
    expect(first.createdAt.getTime() - pressedAt).toBeLessThanOrEqual(71_000);
    expect(first.contextSnapshot?.wakeCommentIds).toEqual(f.commentIds);
    await service.resumeQueuedCommentInterrupt(f.companyId, f.wakeIds[0]);
    expect(await successors(f)).toHaveLength(1);
    // The first successor ends: the release promotes M4, last and alone.
    await service.cancelRun(first.id);
    const runs = await successors(f);
    expect(runs).toHaveLength(2);
    expect(runs[1].contextSnapshot?.wakeCommentIds).toEqual([m4.id]);
    const answered = runs.flatMap(run => (run.contextSnapshot?.wakeCommentIds as string[] | undefined) ?? []);
    expect(answered).toEqual([...f.commentIds, m4.id]);
    const deferred = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.status, "deferred_issue_execution")));
    expect(deferred).toEqual([]);
  });

  it("admits a person's message at once when no Interrupt is pending", async () => {
    const f = await seedBusyChat();
    await heartbeatService(db).cancelRun(f.runId);
    await acknowledgeStop(f);
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.companyId, f.companyId));
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("queued");
    expect((await successors(f)).map(run => run.contextSnapshot?.wakeCommentIds)).toEqual([[m4.id]]);
  });

  it("does not hold a later message behind a stale press", async () => {
    const f = await seedBusyChat();
    await press(f);
    // A later run on the issue ended: the press no longer targets the latest run.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("queued");
  });

  it.each(['actor', 'finished-before-press', 'wrong-target'])("receipt-work predicate stale: %s does not hold a new person message", async kind => {
    const f = await seedBusyChat();
    await press(f);
    await finishTeardown(f);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    if (kind === 'actor') await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, interruptedByActorId: 'different-person' } }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === 'finished-before-press') await db.update(heartbeatRuns).set({ finishedAt: new Date(0) }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === 'not-native') await db.update(heartbeatRuns).set({ runtimeMode: 'legacy' }).where(eq(heartbeatRuns.id, f.runId));
    if (kind === 'controller-held') await db.update(nativeRunFinalizations).set({ phase: 'observed', leaseOwner: 'still-held' }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (kind === 'wrong-target') {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeIds[0]));
      await db.update(agentWakeupRequests).set({ payload: { ...wake.payload, queuedCommentInterrupt: { ...(wake.payload?.queuedCommentInterrupt as object), targetRunId: randomUUID() } } }).where(eq(agentWakeupRequests.id, wake.id));
    }
    const m4 = await sendLater(f);
    evidence('STALE', {kind,status:m4.wake.status});
    expect(m4.wake.status).toBe('queued');
  });

  it('a press on another issue does not hold this issue', async () => {
    const f = await seedBusyChat(); await press(f);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeIds[0]));
    await db.update(agentWakeupRequests).set({ payload: { ...wake.payload, issueId: randomUUID() } }).where(eq(agentWakeupRequests.id, wake.id));
    expect((await sendLater(f)).wake.status).toBe('queued');
  });

  it.each(['agent','system'] as const)('a %s comment wake is not held behind the press', async actor => {
    const f = await seedBusyChat(); await press(f);
    const id = randomUUID();
    await db.insert(issueComments).values({ id, companyId:f.companyId,issueId:f.issueId,authorType: actor === 'agent' ? 'agent' : 'system', ...(actor === 'agent' ? {authorAgentId:f.agentId} : {}),body:'non-person' });
    await heartbeatService(db).wakeup(f.agentId, { source:'on_demand',triggerDetail:'manual',reason:'issue_commented',payload:{issueId:f.issueId,commentId:id},contextSnapshot:{issueId:f.issueId,wakeCommentId:id,wakeCommentIds:[id],responsibleUserId:'queue-owner'},requestedByActorType:actor,requestedByActorId:actor === 'agent' ? f.agentId : 'test-system',idempotencyKey:`rf4:${id}` });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, `rf4:${id}`));
    expect(wake.status).toBe('queued');
  });

  it('B does not combine a non-chat issue queue', async () => {
    const f = await seedBusyChat();
    await db.update(issues).set({conversationAgentId:null,conversationUserId:null,conversationState:null}).where(eq(issues.id,f.issueId));
    const q = await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    await request(app(f.companyId)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`).send({queueId:f.wakeIds[0],targetRunId:f.runId,revision:q.body.revision}).expect(200);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,f.wakeIds[0]));
    expect((wake.payload?._paperclipWakeContext as any)?.wakeCommentIds).toEqual([f.commentIds[0]]);
    const rest = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.companyId));
    expect(rest.filter(w=>(f.wakeIds.slice(1) as string[]).includes(w.id)).map(w=>w.status)).toEqual(['deferred_issue_execution','deferred_issue_execution']);
  });

  it('double HTTP press while teardown waits preserves the exact input once', async () => {
    const f = await seedBusyChat(); await press(f);
    const q = await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    await request(app(f.companyId)).post(`/api/issues/${f.issueId}/queued-comments/interrupt`).send({queueId:f.wakeIds[0],targetRunId:f.runId,revision:q.body.revision}).expect(200);
    const m4 = await sendLater(f); await finishTeardown(f);
    const svc = heartbeatService(db);
    await Promise.all([svc.resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0]),svc.resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0])]);
    const first = (await successors(f))[0];
    expect((await successors(f)).flatMap(r=>r.contextSnapshot?.wakeCommentIds ?? [])).toEqual(f.commentIds);
    await svc.cancelRun(first.id);
    expect((await successors(f)).flatMap(r=>r.contextSnapshot?.wakeCommentIds ?? [])).toEqual([...f.commentIds,m4.id]);
  });

  it('does not strand the after-press message when the press is discarded', async () => {
    const f = await seedBusyChat(); await press(f); const m4 = await sendLater(f);
    for (const id of f.commentIds) {
      const q = await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
      await request(app(f.companyId)).delete(`/api/issues/${f.issueId}/queued-comments/${id}`).send({queueId:f.wakeIds[0],revision:q.body.revision}).expect(200);
    }
    await finishTeardown(f);
    // Run the same durable resumption entrypoint as the receipt worker.
    await heartbeatService(db).resumeQueuedRuns();
    const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,m4.wake.id));
    evidence('DISCARD',{m4Id:m4.id,status:pending.status,runs:(await successors(f)).map(r=>({id:r.id,input:r.contextSnapshot?.wakeCommentIds}))});
    expect((await successors(f)).flatMap(r=>r.contextSnapshot?.wakeCommentIds ?? [])).toEqual([m4.id]);
  });

  it("does not hold a later message behind a press whose target was not stopped by it", async () => {
    const f = await seedBusyChat();
    await press(f);
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await db.update(heartbeatRuns).set({ resultJson: { ...stopped.resultJson, queuedCommentInterruptQueueId: randomUUID() } })
      .where(eq(heartbeatRuns.id, f.runId));
    const m4 = await sendLater(f);
    expect(m4.wake.status).toBe("queued");
  });
});
