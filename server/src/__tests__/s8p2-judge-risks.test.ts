import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
const evidence = (kind: string, value: unknown) => appendFileSync(process.env.TASK_OUT + '/independent-observations.jsonl', JSON.stringify({kind,value})+'\n');
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
import { createReleaseIssueExecution } from '../modules/wake-queue/application/use-cases.js';
import { createPostgresWakeQueueAdapter } from '../modules/wake-queue/adapters/postgres.js';
import { deliverConversationComments } from "../services/agent-conversations.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

// S8 order (Paul note 6): after an Interrupt, a message the person wrote later
// never runs before the messages queued earlier; each is answered once.
describeEmbeddedPostgres("RF4 independent named risk and failure probes", () => {
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

  async function oldAnswer(f: Awaited<ReturnType<typeof seedBusyChat>>, indices: number[], status: 'succeeded' | 'cancelled', stopper = 'queue-owner') {
    await db.update(heartbeatRuns).set({createdAt:new Date(Date.now()-100_000),startedAt:new Date(Date.now()-90_000)}).where(eq(heartbeatRuns.id,f.runId));
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({id,companyId:f.companyId,agentId:f.agentId,status,runtimeMode:'native',nativeIssueId:f.issueId,
      createdAt:new Date(Date.now()-250_000),startedAt:new Date(Date.now()-230_000),finishedAt:new Date(Date.now()-150_000),
      resultJson:status === 'cancelled' ? {cancelledByActorType:'user',cancelledByActorId:stopper,cancelledByUserId:stopper} : {},
      contextSnapshot:{issueId:f.issueId,wakeCommentIds:indices.map(i=>f.commentIds[i])}});
    await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:'agent',authorAgentId:f.agentId,
      createdByRunId:id,body:status === 'succeeded' ? 'Final reply' : 'Partial progress, not a final answer',createdAt:new Date(Date.now()-180_000)});
    return id;
  }
  const snapshot = async (f: Awaited<ReturnType<typeof seedBusyChat>>) => {
    const q = await request(app(f.companyId)).get(`/api/issues/${f.issueId}/queued-comments`).expect(200);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.companyId));
    return {queue:q.body,wakes:wakes.map(w=>({id:w.id,status:w.status,runId:w.runId,payload:w.payload})),runs:(await successors(f)).map(r=>({id:r.id,status:r.status,input:r.contextSnapshot?.wakeCommentIds}))};
  };

  it('Q3a different person Y stops X partial reply: X remains visible and Send-able, never lost', async () => {
    const f = await seedBusyChat();
    await db.insert(companyMemberships).values({companyId:f.companyId,principalType:'user',principalId:'sender-X',status:'active',membershipRole:'operator'});
    await db.update(issueComments).set({authorUserId:'sender-X'}).where(eq(issueComments.id,f.commentIds[1]));
    await db.update(agentWakeupRequests).set({requestedByActorId:'sender-X'}).where(eq(agentWakeupRequests.id,f.wakeIds[1]));
    const oldRunId = await oldAnswer(f,[1],'cancelled','queue-owner');
    await press(f); await finishTeardown(f);
    const service = heartbeatService(db); await service.resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0]);
    const before = await snapshot(f); evidence('Q3A_EXCLUDED_BUT_VISIBLE',{oldRunId,message:f.commentIds[1],...before});
    expect(before.runs.at(-1)?.input).not.toContain(f.commentIds[1]);
    expect(before.queue.entries.map((e:any)=>e.comment.id)).toContain(f.commentIds[1]);
    expect(before.queue.queueId).toBe(f.wakeIds[1]);
    // Ending the queued successor uses the real release/admission path, not a copied predicate.
    await service.cancelRun(before.runs.at(-1)!.id);
    const after = await snapshot(f); evidence('Q3A_RELEASE',{message:f.commentIds[1],...after});
    expect(after.runs.filter(r=>r.id!==oldRunId).flatMap(r=>(r.input as string[])??[])).toEqual(f.commentIds.filter((_,i)=>i!==1).concat(f.commentIds[1]));
  });

  it.each(['cancelled','succeeded'] as const)('F1 durable %s release must not re-present the same sender-stopped consumed M2', async terminal => {
    const f = await seedBusyChat(); const oldRunId = await oldAnswer(f,[1],'cancelled','queue-owner');
    await press(f); await finishTeardown(f);
    const service = heartbeatService(db); await service.resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0]);
    const first = (await successors(f)).at(-1)!;
    expect(first.contextSnapshot?.wakeCommentIds).toEqual([f.commentIds[0],f.commentIds[2]]);
    if (terminal === 'cancelled') await service.cancelRun(first.id);
    else {
      const now = new Date();
      await db.update(heartbeatRuns).set({status:'succeeded',runtimeMode:'native',nativeIssueId:f.issueId,startedAt:now,finishedAt:now}).where(eq(heartbeatRuns.id,first.id));
      await db.insert(nativeRunFinalizations).values({companyId:f.companyId,issueId:f.issueId,runId:first.id,phase:'committed',leaseOwner:null});
      await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:'agent',authorAgentId:f.agentId,createdByRunId:first.id,body:'Final reply to M1 and M3'});
      const release = createReleaseIssueExecution({issueLock:createPostgresWakeQueueAdapter(db,{
        resolveResponsibleUserId:async ()=>'queue-owner',getRoutineEnv:async ()=>({routineId:null,env:null,responsibleUserId:null}),resolveSessionBeforeForWakeup:async ()=>null,
      }),recovery:{escalateStrandedAssignedIssue:async ()=>undefined,escalateStrandedRecoveryIssueInPlace:async ()=>undefined}});
      const released = await release({companyId:f.companyId,runId:first.id,now:new Date()});
      evidence('F1_SUCCESS_RELEASE_OUTCOME',released);
    }
    const state = await snapshot(f); evidence('F1_SAME_SENDER_AFTER_RELEASE',{terminal,consumed:f.commentIds[1],oldRunId,first:first.id,...state});
    expect(state.runs.filter(r=>r.id!==oldRunId&&r.id!==first.id).flatMap(r=>(r.input as string[])??[])).not.toContain(f.commentIds[1]);
  });

  it('Q3b all-consumed deferred wake cannot hold a later live press', async () => {
    const f = await seedBusyChat(); await oldAnswer(f,[1],'succeeded');
    await press(f); const m4 = await sendLater(f); await finishTeardown(f);
    const service = heartbeatService(db); await service.resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0]);
    const before = await snapshot(f); evidence('Q3B_BEFORE_RELEASE',{m4:m4.id,...before});
    expect(before.runs.at(-1)?.input).toEqual([f.commentIds[0],f.commentIds[2]]);
    await service.cancelRun(before.runs.at(-1)!.id);
    const after = await snapshot(f); evidence('Q3B_AFTER_RELEASE',{m4:m4.id,...after});
    expect(after.runs.at(-1)?.input).toEqual([m4.id]);
    expect(after.wakes.find(w=>w.id===f.wakeIds[1])?.status).toBe('cancelled');
    expect(after.queue.entries.map((e:any)=>e.comment.id)).not.toContain(f.commentIds[1]);
  });

  it('Q3b completed message is not shown as falsely waiting while next successor queues', async () => {
    const f = await seedBusyChat(); await oldAnswer(f,[1],'succeeded');
    await press(f); await finishTeardown(f);
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0]);
    const state = await snapshot(f); evidence('Q3B_FALSE_WAIT',{answered:f.commentIds[1],...state});
    expect(state.queue.entries.map((e:any)=>e.comment.id)).not.toContain(f.commentIds[1]);
  });

  it('Q3b press with only completed input neither holds nor repeats that input', async () => {
    const f = await seedBusyChat(); await oldAnswer(f,[0,1,2],'succeeded');
    await press(f); const m4 = await sendLater(f); await finishTeardown(f);
    const state = await snapshot(f); evidence('Q3B_ALL_CONSUMED',{m4:m4.id,m4Wake:m4.wake,...state});
    expect(m4.wake.status).toBe('queued');
    await heartbeatService(db).resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0]);
    const after = await snapshot(f); evidence('Q3B_ALL_CONSUMED_RESUMED',after);
    expect(after.runs.filter(r=>r.status!=='succeeded').flatMap(r=>(r.input as string[])??[])).toEqual([m4.id]);
  });

  it.each([false,true])('Q4 failed-first-successor one true notice, later M4=%s', async withM4 => {
    const f = await seedBusyChat(); await press(f);
    const m4 = withM4 ? await sendLater(f) : null; await finishTeardown(f);
    const service = heartbeatService(db); await service.resumeQueuedCommentInterrupt(f.companyId,f.wakeIds[0]);
    const first = (await successors(f))[0];
    await db.update(heartbeatRuns).set({status:'failed',runtimeMode:'native',nativeIssueId:f.issueId,
      startedAt:new Date(),finishedAt:new Date(),errorCode:'native_predecessor_retirement_unproven',error:'native_predecessor_retirement_unproven'}).where(eq(heartbeatRuns.id,first.id));
    await db.update(agentWakeupRequests).set({status:'failed',finishedAt:new Date()}).where(eq(agentWakeupRequests.id,first.wakeupRequestId!));
    const retry = await service.scheduleBoundedRetry(first.id);
    const now = new Date(Date.now()+180_000);
    const outcomes = [];
    for (const delta of [0,180_000,181_000]) outcomes.push(await settleUnansweredPersonMessage(db,{companyId:f.companyId,issueId:f.issueId,now:new Date(now.getTime()+delta)}));
    const notes = (await db.select().from(issueComments).where(eq(issueComments.issueId,f.issueId))).filter(c=>c.authorType==='system'&&!c.deletedAt);
    evidence('Q4_FAILURE_NOTICE',{withM4,m4:m4?.id,first:first.id,retry,outcomes,notes:notes.map(c=>({id:c.id,body:c.body,metadata:c.metadata})),...await snapshot(f)});
    expect(notes).toHaveLength(1);
    expect(outcomes.at(-1)?.kind).toBe('noticed_before');
    expect(notes[0].body).not.toContain('will start by itself');
    expect(JSON.stringify(notes[0].metadata)).toContain('unanswered_message:');
    // The required F3 notice must explain the FAILED M1-M3 successor, not only a newer never-started M4.
    expect(notes[0].metadata?.sourceRunId).toBe(first.id);
  });

});
