import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from "node:timers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerDeferredReceiptWork } from "../services/heartbeat/deferred-receipt-work.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { heartbeatService } from "../services/heartbeat.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { queuedCommentIdsFromWakePayload } from "../services/issue-queued-comment-queue.js";

vi.mock("../services/heartbeat.js", async (original) => {
 const actual=await original<typeof import("../services/heartbeat.js")>();
 return {...actual,heartbeatService:(...args:Parameters<typeof actual.heartbeatService>)=>{
  const service=actual.heartbeatService(...args);
  return {...service,resumeQueuedCommentInterrupt:async()=>{}};
 }};
});
// S124 (STOP-PATH-SITES-1117): a parked wake (a person's saved Send behind a
// Stop) retried at updatedAt + 30 s, and every failed retry rewrote updatedAt,
// so the silence could grow without bound. The owner ruling: a monotonic
// deadline from the FIRST park, stored once as payload.firstParkedAt; the 30 s
// cadence counts from it; after the deadline ONE true note + Retry, and no
// further silent retries. The deadline is the existing bound this wait already
// has (the unanswered-message pending-attempt bound, 2 min).
const RETRY_MS = 30_000;
const DEADLINE_MS = 2 * 60_000;

vi.setConfig({ testTimeout: 120_000 });
function waitForReal(assertion: () => unknown | Promise<unknown>, { timeout = 5_000 } = {}) {
  return new Promise<void>((resolve, reject) => {
    let settled = false, lastError: unknown;
    let retry: ReturnType<typeof realTimeout> | undefined;
    const deadline = realTimeout(() => finish(lastError ?? new Error("Expectation did not complete before its deadline")), timeout);
    function finish(error?: unknown) {
      if (settled) return;
      settled = true; clearRealTimeout(deadline); if (retry) clearRealTimeout(retry);
      if (error) reject(error); else resolve();
    }
    async function attempt() {
      try { await assertion(); finish(); }
      catch (error) { lastError = error; if (!settled) retry = realTimeout(attempt, 50); }
    }
    void attempt();
  });
}

describe("S124 fix: a parked Send answered elsewhere gets no false note", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  const errors: unknown[] = [];
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_DEFERRED_RECEIPT_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("s124-parked-");
    db = createDb(external ?? temporary!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    db.$client.options.onnotice = () => {};
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`); errors.length = 0;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => { errors.push(error); } });
  });
  afterEach(async () => {
    await coordinator.stop(); vi.useRealTimers(); vi.restoreAllMocks(); expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), actorId = "s124-user";
    await db.insert(authUsers).values({ id: actorId, name: "Parked sender", email: `${actorId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companies).values({ id: companyId, name: "S124", issuePrefix: `S${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: actorId, requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalId: actorId, principalType: "user", status: "active", membershipRole: "owner" });
    const [agent] = await db.insert(agents).values({ companyId, name: "Parked process", adapterType: "process", status: "idle",
      adapterConfig: { command: process.execPath, args: ["-e", "console.log('s124-proof')"], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 0, wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Send after Stop", status: "todo", assigneeAgentId: agent.id }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: issue.id, body: "please continue",
      authorType: "user", authorUserId: actorId }).returning();
    return { companyId, agent, issue, actorId, message };
  }
  async function park(f: Awaited<ReturnType<typeof fixture>>, parkedAt: Date, extra: Record<string, unknown> = {}) {
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agent.id,
      source: "on_demand", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: f.actorId,
      payload: { issueId: f.issue.id, queuedCommentInterrupt: { actorId: f.actorId,
        requestedAt: new Date(parkedAt.getTime() - 1_000).toISOString() },
      _paperclipWakeContext: { wakeCommentIds: [f.message.id] }, ...extra },
      requestedAt: parkedAt, updatedAt: parkedAt }).returning();
    return wake;
  }
  async function step(to: number) {
    await vi.advanceTimersByTimeAsync(Math.max(1, to - Date.now()));
    await waitForReal(() => expect(idleWorkSnapshot().active).toBe(0));
    await immediate();
  }
  // Production's periodic tick (queue.ts resumeQueuedRuns): the unscoped scan
  // that retries every parked Send whose updatedAt is 30 s old.
  async function tick(queue: ReturnType<typeof createHeartbeatQueue>, to: number) {
    await step(to);
    await queue.resumeDeferredExecutionReceipts();
    await waitForReal(() => expect(idleWorkSnapshot().active).toBe(0));
  }
  const notes = (issueId: string) => db.select().from(issueComments).where(and(eq(issueComments.issueId, issueId),
    eq(issueComments.authorType, "system")));
  const readWake = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0]!;


  function app(f: Awaited<ReturnType<typeof fixture>>) {
    const a=express();a.use(express.json());a.use((req,_res,next)=>{(req as any).actor={type:'board',source:'session',userId:f.actorId,companyIds:[f.companyId],memberships:[{companyId:f.companyId,status:'active',membershipRole:'owner'}],isInstanceAdmin:false};next();});a.use('/api',issueRoutes(db,{} as any,{}));a.use(errorHandler);return a;
  }
  async function register(queue: ReturnType<typeof createHeartbeatQueue>) {
    return registerDeferredReceiptWork(db,coordinator,{resume:scope=>queue.resumeDeferredExecutionReceipts(scope),settleTaskChat:async()=>{},createNativeBatch:()=>async()=>{},schedulingSuppressed:async()=>false},()=>true).ready;
  }
  // Stop (the cancelled run naming the receipt) then Send through the real route: the Send parks.
  async function stopAndSend(f: Awaited<ReturnType<typeof fixture>>, at: number, ids: string[]) {
    const wake=await park(f,new Date(at),{_paperclipWakeContext:{wakeCommentIds:ids}});
    await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,status:'cancelled',runtimeMode:'legacy',finishedAt:new Date(at-2000),responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id},resultJson:{queuedCommentInterruptQueueId:wake.id,cancelledByActorType:'user',cancelledByActorId:f.actorId}});
    const get=await request(app(f)).get(`/api/issues/${f.issue.id}/queued-comments`);expect(get.status).toBe(200);
    const sent=await request(app(f)).post(`/api/issues/${f.issue.id}/queued-comments/interrupt`).send({queueId:wake.id,targetRunId:null,revision:get.body.revision});
    expect(sent.status,JSON.stringify(sent.body)).toBe(200);
    expect((await readWake(wake.id)).status).toBe('deferred_issue_execution');
    return wake;
  }
  async function typed(f: Awaited<ReturnType<typeof fixture>>, body: string) {
    const [m]=await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issue.id,body,authorType:'user',authorUserId:f.actorId}).returning();
    return m;
  }
  // The typed message's run completes and publishes its reply (the executor's answer record).
  async function answer(f: Awaited<ReturnType<typeof fixture>>, ids: string[], status: 'succeeded'|'failed'='succeeded') {
    const [run]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,status,runtimeMode:'legacy',finishedAt:new Date(),responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id,wakeReason:'issue_commented',wakeCommentId:ids.at(-1),wakeCommentIds:ids}}).returning();
    if(status==='succeeded') await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issue.id,body:'done: answered both',authorType:'agent',authorAgentId:f.agent.id,createdByRunId:run.id,createdAt:new Date(Date.now()+1000)});
    return run;
  }
  async function pastDeadline(queue: ReturnType<typeof createHeartbeatQueue>, at: number) {
    for(let t=at+5000;t<=at+DEADLINE_MS+5000;t+=5000) await tick(queue,t);
  }
  async function view(f: Awaited<ReturnType<typeof fixture>>, wakeId: string) {
    const q=await request(app(f)).get(`/api/issues/${f.issue.id}/queued-comments`);
    const v={wake:await readWake(wakeId),notes:await notes(f.issue.id),queue:q.body};
    console.log('S124FIX_VIEW',JSON.stringify({status:v.wake.status,error:v.wake.error,finishedAt:v.wake.finishedAt,ids:v.wake.payload?._paperclipWakeContext,notes:v.notes.map(n=>n.body),queue:{wait:q.body.executionWait,comments:(q.body.entries??[]).map((e:any)=>e.comment.id),queueId:q.body.queueId,state:q.body.state}}));
    return v;
  }
  const heldIds=(q:any)=>(q.entries??[]).map((e:any)=>e.comment.id);
  async function expectRetired(f: Awaited<ReturnType<typeof fixture>>, wakeId: string, deps: ReturnType<typeof createHeartbeatQueueTestDependencies>, queue: ReturnType<typeof createHeartbeatQueue>, at: number) {
    const v=await view(f,wakeId);
    expect(v.notes).toHaveLength(0);
    expect(v.wake.status).toBe('cancelled');
    expect(v.wake.error).toBe('parked_send_answered_elsewhere');
    expect(v.wake.finishedAt).not.toBeNull();
    expect(heldIds(v.queue)).toEqual([]);
    expect(v.queue.executionWait?.reason).not.toBe('parked_not_started');
    const sends=deps.resumeQueuedCommentInterrupt.mock.calls.length;
    for(let i=1;i<=6;i++) await tick(queue,at+DEADLINE_MS+5000+i*RETRY_MS);
    expect(deps.resumeQueuedCommentInterrupt).toHaveBeenCalledTimes(sends);
    expect(await notes(f.issue.id)).toHaveLength(0);
  }

  it('row 1 B-shape: Stop, Send (parks), typed M2; M2 run answers M1+M2 -> no note, wake retired, held list empty', async()=>{
    const f=await fixture(),at=Date.now();
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);
    const wake=await stopAndSend(f,at,[f.message.id]);
    await tick(queue,at+10_000);
    const m2=await typed(f,'and also this');
    await answer(f,[f.message.id,m2.id]);
    await register(queue); await pastDeadline(queue,at);
    await expectRetired(f,wake.id,deps,queue,at);
  });
  it('row 2: Send + typed within ~1 s (the wake holds M1+M2), both answered -> retired, no note', async()=>{
    const f=await fixture(),at=Date.now();
    const m2=await typed(f,'typed right after Send');
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);
    const wake=await stopAndSend(f,at,[f.message.id,m2.id]);
    await answer(f,[f.message.id,m2.id]);
    await register(queue); await pastDeadline(queue,at);
    await expectRetired(f,wake.id,deps,queue,at);
  });
  it('row 3 TRUE: nothing answered -> exactly one note; Retry (real Send route) sends it', async()=>{
    const f=await fixture(),at=Date.now();
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);
    const wake=await stopAndSend(f,at,[f.message.id]);
    await register(queue); await pastDeadline(queue,at);
    const v=await view(f,wake.id);
    expect(v.notes).toHaveLength(1); expect(v.notes[0]!.body).toMatch(/did not start/); expect(v.notes[0]!.body).toMatch(/Retry/);
    expect((v.notes[0]!.metadata as any)?.authorizationReason).toBe(`unanswered_message:${f.message.id}`);
    expect(v.wake.status).toBe('deferred_issue_execution'); expect(heldIds(v.queue)).toEqual([f.message.id]);
    expect(v.queue.executionWait?.reason).toBe('parked_not_started');
    const retry=await request(app(f)).post(`/api/issues/${f.issue.id}/queued-comments/interrupt`).send({queueId:wake.id,targetRunId:null,revision:v.queue.revision});
    expect(retry.status,JSON.stringify(retry.body)).toBe(200);
    expect(queuedCommentIdsFromWakePayload((await readWake(wake.id)).payload)).toEqual([f.message.id]);
  });
  it('row 3 PARTIAL: 2 held, 1 answered elsewhere -> one note about the unanswered one; held list and Retry carry only it', async()=>{
    const f=await fixture(),at=Date.now();
    const m2=await typed(f,'second held');
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);
    const wake=await stopAndSend(f,at,[f.message.id,m2.id]);
    await answer(f,[f.message.id]);
    await register(queue); await pastDeadline(queue,at);
    const v=await view(f,wake.id);
    expect(v.notes).toHaveLength(1);
    expect((v.notes[0]!.metadata as any)?.authorizationReason).toBe(`unanswered_message:${m2.id}`);
    expect(v.wake.status).toBe('deferred_issue_execution');
    expect(queuedCommentIdsFromWakePayload(v.wake.payload)).toEqual([m2.id]);
    expect(heldIds(v.queue)).toEqual([m2.id]);
    const retry=await request(app(f)).post(`/api/issues/${f.issue.id}/queued-comments/interrupt`).send({queueId:wake.id,targetRunId:null,revision:v.queue.revision});
    expect(retry.status,JSON.stringify(retry.body)).toBe(200);
    expect(queuedCommentIdsFromWakePayload((await readWake(wake.id)).payload)).toEqual([m2.id]);
  });
  it('row 4 control: a run CARRIED M1 then FAILED (no completed answer) -> not retired, note fires', async()=>{
    const f=await fixture(),at=Date.now();
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);
    const wake=await stopAndSend(f,at,[f.message.id]);
    await answer(f,[f.message.id],'failed');
    await register(queue); await pastDeadline(queue,at);
    const v=await view(f,wake.id);
    expect(v.notes).toHaveLength(1); expect(v.wake.status).toBe('deferred_issue_execution'); expect(heldIds(v.queue)).toEqual([f.message.id]);
  });
});
