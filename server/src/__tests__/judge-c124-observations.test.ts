import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { setTimeout as realTimeout, clearTimeout as clearRealTimeout } from "node:timers";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments,
  issues, issueRecoveryActions } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerDeferredReceiptWork } from "../services/heartbeat/deferred-receipt-work.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { heartbeatService } from "../services/heartbeat.js";
import { saveUndeliveredUserComments } from "../services/work-intent-outbox.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

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

describe("S124 parked wake: monotonic first-park deadline", () => {
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


  async function snapshot(label: string, f: Awaited<ReturnType<typeof fixture>>, wakeId: string, at: number, deps?: ReturnType<typeof createHeartbeatQueueTestDependencies>) {
    const row=await readWake(wakeId), ns=await notes(f.issue.id);
    const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).actor={type:'board',source:'session',userId:f.actorId,companyIds:[f.companyId],memberships:[{companyId:f.companyId,status:'active',membershipRole:'owner'}],isInstanceAdmin:false};next();});app.use('/api',issueRoutes(db,{} as any,{}));app.use(errorHandler);
    const projection=await request(app).get(`/api/issues/${f.issue.id}/queued-comments`);
    const s={label,queueProjection:{status:projection.status,body:projection.body},elapsedMs:Date.now()-at,receipt:row,notes:ns.map(n=>({id:n.id,body:n.body,metadata:n.metadata,presentation:n.presentation})),savedMessage:(await db.select().from(issueComments).where(eq(issueComments.id,f.message.id)))[0],releaseAttempts:deps?.releaseIssueExecutionAndPromote.mock.calls.length,qciAttempts:deps?.resumeQueuedCommentInterrupt.mock.calls.length};
    console.log('C124_SNAPSHOT',JSON.stringify(s)); return s;
  }
  async function register(queue: ReturnType<typeof createHeartbeatQueue>) {
    return registerDeferredReceiptWork(db,coordinator,{resume:scope=>queue.resumeDeferredExecutionReceipts(scope),settleTaskChat:async()=>{},createNativeBatch:()=>async()=>{},schedulingSuppressed:async()=>false},()=>true).ready;
  }
  async function timeline(f: Awaited<ReturnType<typeof fixture>>, wakeId:string, at:number, queue:ReturnType<typeof createHeartbeatQueue>,deps:ReturnType<typeof createHeartbeatQueueTestDependencies>) {
    for(let t=at+5000;t<=at+120000;t+=5000) await tick(queue,t);
    await tick(queue,at+121000);
    const two=await snapshot('two_minutes',f,wakeId,at,deps);
    await tick(queue,at+125000);await snapshot('two_minutes_plus_5s',f,wakeId,at,deps);
    for(let t=at+130000;t<=at+360000;t+=5000) await tick(queue,t);
    const six=await snapshot('six_minutes',f,wakeId,at,deps); return {two,six};
  }
  it.each([false,true])('C124: legacy interrupted qci=%s two/six-minute observations',async qci=>{
    const f=await fixture(),at=Date.now(),wake=await park(f,new Date(at),{...(qci?{}:{queuedCommentInterrupt:null}),executionWait:{reason:'remote_cleanup',message:'Waiting for previous execution. Your message is saved.'}});
    if(!qci) await db.update(agentWakeupRequests).set({payload:sql`${agentWakeupRequests.payload} - 'queuedCommentInterrupt'`}).where(eq(agentWakeupRequests.id,wake.id));
    await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,status:'cancelled',runtimeMode:'legacy',finishedAt:new Date(at),responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id},resultJson:{queuedCommentInterruptQueueId:wake.id,cancelledByActorType:'user',cancelledByActorId:f.actorId}});
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps); await register(queue);
    await snapshot('first_deferral',f,wake.id,at,deps); const {two,six}=await timeline(f,wake.id,at,queue,deps);
    expect.soft(two.notes).toHaveLength(1); expect(six.notes).toHaveLength(1);
  });
  it('C124: non-QCI receipt still releases after its notice',async()=>{
    const f=await fixture(),at=Date.now(),wake=await park(f,new Date(at),{queuedCommentInterrupt:null,executionWait:{reason:'remote_cleanup',message:'Waiting. Your message is saved.'}});
    await db.update(agentWakeupRequests).set({payload:sql`${agentWakeupRequests.payload} - 'queuedCommentInterrupt'`}).where(eq(agentWakeupRequests.id,wake.id));
    await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,status:'failed',runtimeMode:'native',nativeIssueId:f.issue.id,finishedAt:new Date(at),responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id}});
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);await register(queue);
    const {two,six}=await timeline(f,wake.id,at,queue,deps);
    expect.soft(two.notes).toHaveLength(1); expect.soft(six.notes).toHaveLength(1);expect(six.releaseAttempts).toBe(two.releaseAttempts);
  });
  it.each(['company.inactive','wake_lost','execution_recovery','send_press'])('C124: writer %s immediate anchor and two/six-minute behavior',async mode=>{
    const f=await fixture(),at=Date.now();let id:string;
    const deps=createHeartbeatQueueTestDependencies(db),queue=createHeartbeatQueue(db,deps);deps.getAgent.mockResolvedValue(f.agent);
    if(mode==='company.inactive') {
      await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,status:'failed',runtimeMode:'legacy',finishedAt:new Date(at-1000),responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id}});
      await db.update(companies).set({status:'paused'}).where(eq(companies.id,f.companyId));
      let refusal:unknown;try{await queue.enqueueWakeup(f.agent.id,{source:'on_demand',reason:'issue_commented',requestedByActorType:'user',requestedByActorId:f.actorId,payload:{issueId:f.issue.id,commentId:f.message.id},contextSnapshot:{issueId:f.issue.id,wakeReason:'issue_commented',wakeCommentId:f.message.id,wakeCommentIds:[f.message.id]}});}catch(e){refusal=e;}
      console.log('C124_REFUSAL',String(refusal));
      const rows=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.companyId));expect(rows).toHaveLength(1);id=rows[0].id;
    }else if(mode==='wake_lost') {
      id=(await saveUndeliveredUserComments(db,{companyId:f.companyId,issueId:f.issue.id,agentId:f.agent.id,commentIds:[f.message.id],allowedStatuses:['todo'],requestedByActorId:f.actorId,executionWait:{reason:'wake_lost',trigger:'reconciler_backstop',message:"This message's wake was lost; it is sent now."}}))!;
      // A queued/running task prevents promotion, so the saved Send remains deferred.
      await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,status:'running',runtimeMode:'legacy',responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id}});
    }else if(mode==='execution_recovery') {
      const [source]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,nativeIssueId:f.issue.id,status:'cancelled',runtimeMode:'native',finishedAt:new Date(at-2000),responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id}}).returning();
      const [hold]=await db.insert(issueRecoveryActions).values({companyId:f.companyId,sourceIssueId:f.issue.id,kind:'active_run_watchdog',ownerType:'board',status:'active',cause:'legacy_execution_requires_reconciliation',fingerprint:source.id,nextAction:'Inspect source',evidence:{runId:source.id}}).returning();
      const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agent.id,source:'on_demand',reason:'issue_commented',status:'queued',requestedByActorType:'user',requestedByActorId:f.actorId,payload:{issueId:f.issue.id,commentId:f.message.id}}).returning();id=wake.id;
      const [run]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agent.id,issueId:f.issue.id,wakeupRequestId:id,status:'queued',runtimeMode:'legacy',responsibleUserId:f.actorId,contextSnapshot:{issueId:f.issue.id,wakeReason:'issue_commented',wakeCommentId:f.message.id,wakeCommentIds:[f.message.id]}}).returning();
      await db.update(agentWakeupRequests).set({runId:run.id}).where(eq(agentWakeupRequests.id,id));
      await db.update(issues).set({status:'in_progress',executionRunId:run.id}).where(eq(issues.id,f.issue.id));
      console.log('C124_RECOVERY_OUTCOME',JSON.stringify(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({companyId:f.companyId,runId:run.id,expectedStatus:'queued',now:new Date(at)})));
      expect((await readWake(id)).status).toBe('deferred_issue_execution');
      await db.update(issues).set({executionRunId:null}).where(eq(issues.id,f.issue.id));
    }else {
      const old=new Date(at-3600000).toISOString();
      const wake=await park(f,new Date(at),{firstParkedAt:old,parkedNoticeAt:old});id=wake.id;
      const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).actor={type:'board',source:'session',userId:f.actorId,companyIds:[f.companyId],memberships:[{companyId:f.companyId,status:'active',membershipRole:'owner'}],isInstanceAdmin:false};next();});app.use('/api',issueRoutes(db,{} as any,{}));app.use(errorHandler);
      const get=await request(app).get(`/api/issues/${f.issue.id}/queued-comments`);console.log('C124_GET',get.status,JSON.stringify(get.body));expect(get.status).toBe(200);
      const sent=await request(app).post(`/api/issues/${f.issue.id}/queued-comments/interrupt`).send({queueId:id,targetRunId:null,revision:get.body.revision});console.log('C124_SEND',sent.status,JSON.stringify(sent.body));expect(sent.status).toBe(200);
    }
    const first=await snapshot('writer_return',f,id,at,deps);
    await register(queue);const {two,six}=await timeline(f,id,at,queue,deps);
    expect.soft(two.notes).toHaveLength(1);expect.soft(six.notes).toHaveLength(1);expect.soft(six.notes[0]?.body).toMatch(/Retry/);
    expect.soft(Date.parse(String(two.receipt.payload?.firstParkedAt))).toBeGreaterThanOrEqual(at-1000);
    expect.soft(Date.parse(String(two.receipt.payload?.firstParkedAt))).toBeLessThan(at+1000);
    // Eager storage and deadline correctness are reported separately.
    expect(typeof first.receipt.payload?.firstParkedAt).toBe('string');
    if(mode==='send_press')expect(Date.parse(String(first.receipt.payload?.firstParkedAt))).toBeGreaterThanOrEqual(at-1000);
  });
});
