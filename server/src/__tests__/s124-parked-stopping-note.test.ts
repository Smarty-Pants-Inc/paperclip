import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as realTimeout } from 'node:timers/promises';
import express from 'express';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb,
 environmentLeases, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';

// Script ONLY provider edges: acknowledgement of run-only Stop, and the model's
// answer when (and only when) the actual dispatcher finally invokes it.
const edge = vi.hoisted(() => ({ calls: [] as string[], gates: [] as unknown[] }));
// Transparent observation: admission's original implementation and result stay intact.
vi.mock('../services/explicit-native-continuation.js',async original=>{
 const actual=await original<typeof import('../services/explicit-native-continuation.js')>();
 return {...actual,admitExplicitNativeContinuation:async(input:Parameters<typeof actual.admitExplicitNativeContinuation>[0])=>{
  let blocked:unknown=null;
  const result=await actual.admitExplicitNativeContinuation({...input,onBlocked:(reason,message)=>{blocked={reason,message};input.onBlocked?.(reason,message);}});
  const observation={at:new Date().toISOString(),queuedCommentInterruptId:input.queuedCommentInterruptId,blocked,result};
  edge.gates.push(observation);
  console.log('S124GATE',JSON.stringify(observation));
  return result;
 }};
});
vi.mock('../services/native-runtime/native-session-executor.js', async original => {
 const actual = await original<typeof import('../services/native-runtime/native-session-executor.js')>();
 return { ...actual,
  cancelNativeSession: async (...args: Parameters<typeof actual.cancelNativeSession>) => {
   const r = await actual.cancelNativeSession(...args);
   const db = args[2]!.db;
   await db.update(heartbeatRuns).set({resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeCancellation,dispatched}', 'true'::jsonb)`}).where(eq(heartbeatRuns.id,args[0]));
   return {...r,dispatched:true};
  },
  executePaperclipNativeSession: async (input: Parameters<typeof actual.executePaperclipNativeSession>[0]) => {
   const id=input.execution.binding.runId;
   edge.calls.push(id);
   const [run]=await input.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,id));
   const issueId=String(run.contextSnapshot!.issueId);
   await input.db.insert(issueComments).values({companyId:run.companyId,issueId,authorType:'agent',authorAgentId:run.agentId,
    createdByRunId:id,body:'M1 answer: completed exactly once by the scripted provider edge.'});
   await input.db.update(issues).set({status:'done'}).where(eq(issues.id,issueId));
   return {exitCode:0,signal:null,timedOut:false,summary:'M1 answered.',resultJson:{nativeResult:{summary:'M1 answered.'}}};
  }
 };
});
import { heartbeatService } from '../services/heartbeat.js';
import { issueRoutes } from '../routes/issues.js';
import { agentRoutes } from '../routes/agents.js';
import { errorHandler } from '../middleware/index.js';
import { createDeliveryWorkCoordinator } from '../services/delivery-work-coordinator.js';
import { idleWorkSnapshot } from '../services/task-admission.js';
import { notifyDeferredExecutionWork, notifyDeferredWakesForIssue } from '../services/deferred-execution-notifications.js';
import { remoteTerminationReceipt } from '../services/remote-execution-termination.js';
import { settleUnansweredPersonMessage } from '../services/recovery/unanswered-person-message.js';
import { PARKED_WAKE_NOT_STARTED_TEXT, PARKED_WAKE_STOPPING_TEXT, PARKED_WAKE_UNCONFIRMED_TEXT } from '../services/heartbeat/parked-wake-deadline.js';


// RFL 11:12Z rows. Real Stop and Send routes, real deferred-receipt and dispatch
// workers, embedded Postgres; only the provider edge is scripted (above).
const NEW_WORDS='Your message is saved and will be sent when the previous run has finished stopping, usually within ten minutes.';
vi.setConfig({testTimeout:400_000,hookTimeout:60_000});
describe('S124 fix 4: the parked-Send note while no run can start yet',()=>{
 let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 let db:ReturnType<typeof createDb>;
 let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>|undefined;
 let hb:ReturnType<typeof heartbeatService>;
 const errors:unknown[]=[];
 const wait=async (check:()=>Promise<void>,timeout=5000)=>{const at=performance.now();let last:unknown;while(performance.now()-at<timeout){try{await check();return;}catch(e){last=e;}await realTimeout(30);}throw last;};
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase('s124fix4-');db=createDb(temp.connectionString,{maxConnections:10});db.$client.options.onnotice=()=>{};hb=heartbeatService(db);});
 afterAll(async()=>{await coordinator?.stop();vi.useRealTimers();await hb?.drainActiveRunExecutions();await db?.$client.end({timeout:1});await temp?.cleanup();});
 const startWorkers=async()=>{await coordinator?.stop();coordinator=createDeliveryWorkCoordinator({owner:db,canRun:()=>true,canReconcile:()=>true,onError:e=>{errors.push(e);console.log('S124FIX4 worker-error',String(e));}});
  await hb.registerDeferredReceiptWork(coordinator,()=>true).ready;await hb.registerRunDispatchWork(coordinator,()=>true).ready;};
 // Stop (real route) a remote native run whose lease has no stop receipt yet; Send (real route) parks M1 behind remote_cleanup.
 async function stopAndSend(){
  edge.calls.length=0;
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),oldId=randomUUID(),wakeId=randomUUID(),m1=randomUUID(),actor='s124fix4-'+randomUUID();
  await db.insert(authUsers).values({id:actor,name:'Row operator',email:actor+'@example.test',createdAt:new Date(),updatedAt:new Date()});
  await db.insert(companies).values({id:companyId,name:'S124 fix4 row',issuePrefix:'F'+companyId.slice(0,3).toUpperCase(),defaultResponsibleUserId:actor,requireBoardApprovalForNewAgents:false});
  await db.insert(companyMemberships).values({companyId,principalType:'user',principalId:actor,status:'active',membershipRole:'owner'});
  await db.insert(agents).values({id:agentId,companyId,name:'S124 native agent',adapterType:'paperclip_runner',adapterConfig:{provider:'codex',model:'gpt-5.6-luna'},status:'running',runtimeConfig:{heartbeat:{wakeOnDemand:true,maxConcurrentRuns:1}}});
  await db.insert(heartbeatRuns).values({id:oldId,companyId,agentId,status:'running',runtimeMode:'native',nativeIssueId:issueId,issueId,startedAt:new Date(Date.now()-10_000),responsibleUserId:actor,contextSnapshot:{issueId},runnerProfileJson:{nativeResourceDisposition:'keep_running'}});
  await db.insert(issues).values({id:issueId,companyId,title:'S124 fix4 M1',status:'in_progress',assigneeAgentId:agentId,responsibleUserId:actor,executionRunId:oldId});
  await db.update(heartbeatRuns).set({scopeKind:'issue',issueId}).where(eq(heartbeatRuns.id,oldId));
  await db.insert(nativeRunFinalizations).values({companyId,issueId,runId:oldId,phase:'observed'});
  const [lease]=await db.insert(environmentLeases).values({companyId,issueId,heartbeatRunId:oldId,provider:'daytona',providerLeaseId:randomUUID(),status:'retained',leasePolicy:'reuse_by_environment',cleanupStatus:'success',releasedAt:new Date(),metadata:{driver:'sandbox',sandboxProviderPlugin:true,remoteCwd:'/work'}}).returning();
  await db.insert(issueComments).values({id:m1,companyId,issueId,authorType:'user',authorUserId:actor,body:'M1: answer this held message once.'});
  await db.insert(agentWakeupRequests).values({id:wakeId,companyId,agentId,source:'issue_comment',reason:'issue_commented',status:'deferred_issue_execution',requestedByActorType:'user',requestedByActorId:actor,payload:{issueId,commentId:m1,_paperclipWakeContext:{issueId,wakeCommentId:m1,wakeCommentIds:[m1]}}});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).actor={type:'board',source:'session',userId:actor,companyIds:[companyId],memberships:[{companyId,status:'active',membershipRole:'owner'}],isInstanceAdmin:false};next();});app.use('/api',agentRoutes(db,{}));app.use('/api',issueRoutes(db,{} as any,{}));app.use(errorHandler);
  const get=async()=>{const r=await request(app).get(`/api/issues/${issueId}/queued-comments`);expect(r.status,JSON.stringify(r.body)).toBe(200);return r.body;};
  const readWake=async()=> (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wakeId)))[0];
  const runs=()=>db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),sql`${heartbeatRuns.id} <> ${oldId}`));
  const replies=()=>db.select().from(issueComments).where(and(eq(issueComments.issueId,issueId),eq(issueComments.authorType,'agent')));
  const notes=()=>db.select().from(issueComments).where(and(eq(issueComments.issueId,issueId),eq(issueComments.authorType,'system'),sql`${issueComments.deletedAt} is null`));
  const stopped=await request(app).post(`/api/heartbeat-runs/${oldId}/cancel`).send({cancellationRequestId:randomUUID()});expect(stopped.status).toBe(200);
  await db.update(nativeRunFinalizations).set({phase:'terminal_failure',leaseOwner:null}).where(eq(nativeRunFinalizations.runId,oldId));
  await db.update(issues).set({executionRunId:null}).where(eq(issues.id,issueId));
  await db.update(agents).set({status:'idle'}).where(eq(agents.id,agentId));
  await startWorkers();
  const before=await get();
  const send=await request(app).post(`/api/issues/${issueId}/queued-comments/interrupt`).send({queueId:wakeId,targetRunId:null,revision:before.revision});expect(send.status).toBe(200);
  const sentAt=Date.now();
  expect((await readWake()).payload?.executionWait).toMatchObject({reason:'remote_cleanup'});
  expect(await runs()).toHaveLength(0);
  const receipt=async()=>{await db.transaction(async tx=>{await tx.update(environmentLeases).set({status:'released',cleanupStatus:'success',releasedAt:new Date(),metadata:{...lease.metadata,remoteExecutionTermination:remoteTerminationReceipt(lease,{providerLeaseId:lease.providerLeaseId,state:'stopped'})}}).where(eq(environmentLeases.id,lease.id));await notifyDeferredExecutionWork(tx,{companyId,requestId:wakeId});await notifyDeferredWakesForIssue(tx,{companyId,issueId});});};
  return {companyId,issueId,oldId,wakeId,m1,app,get,readWake,runs,replies,notes,receipt,sentAt};
 }
 // Fake ONLY Date/timeouts, advancing with wall time: +2 min past the Send, the real worker writes the note.
 async function toDeadline(r:Awaited<ReturnType<typeof stopAndSend>>){
  for(let i=0;i<25;i++){await vi.advanceTimersByTimeAsync(5000);await hb.resumeQueuedRuns();await wait(async()=>expect(idleWorkSnapshot().active).toBe(0));}
  await wait(async()=>expect((await r.readWake()).payload?.parkedNoticeAt).toBeTypeOf('string'));
  const q=await r.get();const ns=await r.notes();
  console.log('S124FIX4_NOTE',JSON.stringify({queueWait:q.executionWait,notes:ns.map(n=>({body:n.body,metadata:n.metadata}))}));
  return {q,ns};
 }
 // Fake time served ONLY the +2 min note (as rf-4's row). Native dispatch owns real
 // controller leases: wall time is restored and the actual workers re-registered.
 // After the receipt ONLY the real workers move it (no press, no direct resume).
 async function afterReceipt(r:Awaited<ReturnType<typeof stopAndSend>>){
  vi.useRealTimers();await startWorkers();
  await r.receipt();const receiptAt=Date.now();
  await wait(async()=>expect(edge.calls).toHaveLength(1),240_000);
  await hb.drainActiveRunExecutions();
  return {receiptAt,answeredAt:Date.now()};
 }
 it('row 1: Stop with no remote receipt, Send; at +2 min the NEW words (no Retry); press nothing; the receipt lands -> M1 answered exactly once inside 10 min; the note retires',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout'],shouldAdvanceTime:true});
  try{
   const r=await stopAndSend();
   const {q,ns}=await toDeadline(r);
   expect(q.executionWait).toEqual({reason:'parked_not_started',message:NEW_WORDS});
   expect(PARKED_WAKE_STOPPING_TEXT).toBe(NEW_WORDS);
   expect(ns).toHaveLength(1);expect(ns[0]!.body).toBe(NEW_WORDS);
   expect(JSON.stringify(ns[0]!.metadata)).not.toMatch(/Retry/);expect(ns[0]!.body).not.toMatch(/Retry/);expect(JSON.stringify(q)).not.toMatch(/Press Retry/);
   expect(await r.runs()).toHaveLength(0);
   // 30 s more (one cadence pass), still no receipt: still parked, still one note, nothing started.
   for(let i=0;i<6;i++){await vi.advanceTimersByTimeAsync(5000);await hb.resumeQueuedRuns();}
   expect(await r.runs()).toHaveLength(0);expect(await r.notes()).toHaveLength(1);expect((await r.readWake()).status).toBe('deferred_issue_execution');
   const t=await afterReceipt(r);
   expect(await r.replies()).toHaveLength(1);
   const rs=await r.runs();expect(rs).toHaveLength(1);expect(rs[0]!.status).toBe('succeeded');
   expect(rs[0]!.startedAt!.getTime()-r.sentAt).toBeLessThan(10*60_000);
   console.log('S124FIX4_ROW1',JSON.stringify({sendToStartMs:rs[0]!.startedAt!.getTime()-r.sentAt,receiptToStartMs:rs[0]!.startedAt!.getTime()-t.receiptAt}));
   // The unanswered sweep supersedes the note by the answer.
   await settleUnansweredPersonMessage(db,{companyId:r.companyId,issueId:r.issueId});
   expect(await r.notes()).toHaveLength(0);
   for(let i=0;i<6;i++){await realTimeout(150);await db.transaction(tx=>notifyDeferredExecutionWork(tx,{companyId:r.companyId,requestId:r.wakeId}));await hb.resumeQueuedRuns();await hb.drainActiveRunExecutions();}
   expect(await r.replies()).toHaveLength(1);expect(edge.calls).toHaveLength(1);expect(await r.runs()).toHaveLength(1);expect((await r.get()).entries).toHaveLength(0);
  }finally{vi.useRealTimers();}
  expect(errors).toEqual([]);
 });
 it('row 2: same, and the old Retry path (the queue Send, the only surface still offering a press) is pressed -> still ONE answer',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout'],shouldAdvanceTime:true});
  try{
   const r=await stopAndSend();
   const {q}=await toDeadline(r);
   expect(q.executionWait).toEqual({reason:'parked_not_started',message:NEW_WORDS});
   const press=await request(r.app).post(`/api/issues/${r.issueId}/queued-comments/interrupt`).send({queueId:r.wakeId,targetRunId:null,revision:q.revision});
   console.log('S124FIX4_ROW2_PRESS',press.status,JSON.stringify(press.body).slice(0,300));
   for(let i=0;i<6;i++){await vi.advanceTimersByTimeAsync(5000);await hb.resumeQueuedRuns();}
   expect(await r.runs()).toHaveLength(0);
   await afterReceipt(r);
   // A second press after the answer (stale revision or fresh), duplicate hints and scans.
   const again=await request(r.app).post(`/api/issues/${r.issueId}/queued-comments/interrupt`).send({queueId:r.wakeId,targetRunId:null,revision:(await r.get()).revision});
   console.log('S124FIX4_ROW2_PRESS2',again.status);
   for(let i=0;i<6;i++){await realTimeout(150);await db.transaction(tx=>notifyDeferredExecutionWork(tx,{companyId:r.companyId,requestId:r.wakeId}));await hb.resumeQueuedRuns();await hb.drainActiveRunExecutions();}
   expect(await r.replies()).toHaveLength(1);expect(edge.calls).toHaveLength(1);expect(await r.runs()).toHaveLength(1);
  }finally{vi.useRealTimers();}
  expect(errors).toEqual([]);
 });
 it('row 3: a parked Send whose run CAN start now keeps the existing note with a working Retry (one run, one answer)',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout'],shouldAdvanceTime:true});
  let r:Awaited<ReturnType<typeof stopAndSend>>;
  try{
   r=await stopAndSend();
   // Admission no longer blocks (the wait is not a stop wait), but the park's re-dispatch never happened: the old note.
   await db.update(agentWakeupRequests).set({payload:sql`jsonb_set(${agentWakeupRequests.payload},'{executionWait}',${JSON.stringify({reason:'interrupt_handoff',message:'Sending your messages.'})}::jsonb)`}).where(eq(agentWakeupRequests.id,r.wakeId));
   await coordinator!.stop();
   await r.receipt();
   // The worker is not running (the silent loop S124 bounds); it is restarted only for the deadline pass.
   await vi.advanceTimersByTimeAsync(125_000);
   await startWorkers();
   await wait(async()=>expect((await r.readWake()).payload?.parkedNoticeAt).toBeTypeOf('string'),20_000);
  }finally{vi.useRealTimers();}
  const q=await r!.get();const ns=await r!.notes();
  console.log('S124FIX4_ROW3_NOTE',JSON.stringify({queueWait:q.executionWait,notes:ns.map(n=>n.body)}));
  expect(q.executionWait).toEqual({reason:'parked_not_started',message:PARKED_WAKE_NOT_STARTED_TEXT});
  expect(ns).toHaveLength(1);expect(ns[0]!.body).toBe('Your message is saved, but it did not start. Press Retry to send it now.');
  expect(edge.calls).toHaveLength(0);
  await startWorkers();
  const retry=await request(r!.app).post(`/api/issues/${r!.issueId}/queued-comments/interrupt`).send({queueId:r!.wakeId,targetRunId:null,revision:q.revision});
  expect(retry.status,JSON.stringify(retry.body)).toBe(200);
  await hb.resumeQueuedRuns();
  await wait(async()=>expect(edge.calls).toHaveLength(1),40_000);
  await hb.drainActiveRunExecutions();
  expect(await r!.replies()).toHaveLength(1);expect(await r!.runs()).toHaveLength(1);
  expect(errors).toEqual([]);
 });
 it('row 4 (rf-4 Q5): send_predates_stop does not clear on the receipt, so its park keeps the OLD note with its working Retry',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout'],shouldAdvanceTime:true});
  let r:Awaited<ReturnType<typeof stopAndSend>>;
  try{
   r=await stopAndSend();
   // The previous run's terminal time lands after this Send (Send/Stop race), then its receipt.
   await db.update(heartbeatRuns).set({finishedAt:new Date(r.sentAt+500)}).where(eq(heartbeatRuns.id,r.oldId));
   await realTimeout(600);await r.receipt();
   for(let i=0;i<30;i++){await vi.advanceTimersByTimeAsync(5000);await hb.resumeQueuedRuns();await wait(async()=>expect(idleWorkSnapshot().active).toBe(0));}
   await wait(async()=>expect((await r.readWake()).payload?.parkedNoticeAt).toBeTypeOf('string'),20_000);
   // More passes with the receipt present: it stays parked (admission keeps answering send_predates_stop).
   for(let i=0;i<12;i++){await vi.advanceTimersByTimeAsync(5000);await hb.resumeQueuedRuns();}
  }finally{vi.useRealTimers();}
  const wake=await r!.readWake(),q=await r!.get(),ns=await r!.notes();
  console.log('S124FIX5_ROW4',JSON.stringify({wait:wake.payload?.executionWait,queueWait:q.executionWait,notes:ns.map(n=>n.body)}));
  expect(wake.payload?.executionWait).toMatchObject({reason:'send_predates_stop'});
  expect(q.executionWait).toEqual({reason:'parked_not_started',message:PARKED_WAKE_NOT_STARTED_TEXT});
  expect(ns).toHaveLength(1);expect(ns[0]!.body).toBe('Your message is saved, but it did not start. Press Retry to send it now.');
  expect(await r!.runs()).toHaveLength(0);expect(edge.calls).toHaveLength(0);
  await startWorkers();
  const retry=await request(r!.app).post(`/api/issues/${r!.issueId}/queued-comments/interrupt`).send({queueId:r!.wakeId,targetRunId:null,revision:q.revision});
  expect(retry.status,JSON.stringify(retry.body)).toBe(200);
  await hb.resumeQueuedRuns();
  await wait(async()=>expect(edge.calls).toHaveLength(1),40_000);
  await hb.drainActiveRunExecutions();
  expect(await r!.replies()).toHaveLength(1);expect(await r!.runs()).toHaveLength(1);
 });
 it('row 5 (RFL C2): a stop never confirmed -> at 30 min the ONE note is rewritten once to the true line; then the receipt -> one answer, note retired',async()=>{
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout'],shouldAdvanceTime:true});
  let r:Awaited<ReturnType<typeof stopAndSend>>;let noteId='';let firstRewrite:unknown;
  const step=async(n:number)=>{for(let i=0;i<n;i++){await vi.advanceTimersByTimeAsync(5000);await hb.resumeQueuedRuns();await wait(async()=>expect(idleWorkSnapshot().active).toBe(0));}};
  try{
   r=await stopAndSend();
   await step(30); // +2.5 min
   await wait(async()=>expect((await r.readWake()).payload?.parkedNoticeAt).toBeTypeOf('string'),20_000);
   let ns=await r.notes();expect(ns).toHaveLength(1);expect(ns[0]!.body).toBe(NEW_WORDS);noteId=ns[0]!.id;
   await step(318); // +29 min: no receipt, still the stopping words
   ns=await r.notes();expect(ns).toHaveLength(1);expect(ns[0]!.body).toBe(NEW_WORDS);
   expect((await r.readWake()).payload?.parkedUnconfirmedAt).toBeUndefined();
   await step(24); // +31 min
   await wait(async()=>expect((await r.readWake()).payload?.parkedUnconfirmedAt).toBeTypeOf('string'),20_000);
   ns=await r.notes();const q=await r.get();
   console.log('S124FIX5_ROW5_30MIN',JSON.stringify({elapsedMs:Date.now()-r.sentAt,queueWait:q.executionWait,notes:ns.map(n=>({id:n.id,body:n.body,metadata:n.metadata}))}));
   expect(ns).toHaveLength(1);expect(ns[0]!.id).toBe(noteId);
   expect(ns[0]!.body).toBe('Your message is saved. The previous run has not confirmed it stopped; it will be sent when it does.');
   expect(PARKED_WAKE_UNCONFIRMED_TEXT).toBe(ns[0]!.body);expect(JSON.stringify(ns[0]!.metadata)).not.toMatch(/Retry/);
   expect(q.executionWait).toEqual({reason:'parked_not_started',message:PARKED_WAKE_UNCONFIRMED_TEXT});
   firstRewrite={at:(await r.readWake()).payload?.parkedUnconfirmedAt,updatedAt:ns[0]!.updatedAt.toISOString()};
   await step(60); // +36 min: rewritten ONCE (no further rewrite), still one note, nothing started
   ns=await r.notes();
   expect(ns).toHaveLength(1);expect(ns[0]!.body).toBe(PARKED_WAKE_UNCONFIRMED_TEXT);
   expect({at:(await r.readWake()).payload?.parkedUnconfirmedAt,updatedAt:ns[0]!.updatedAt.toISOString()}).toEqual(firstRewrite);
   expect(await r.runs()).toHaveLength(0);expect(edge.calls).toHaveLength(0);
  }finally{vi.useRealTimers();}
  // Back to wall time: undo only the fake clock's skew on the wake's cadence stamp.
  await db.update(agentWakeupRequests).set({updatedAt:new Date()}).where(eq(agentWakeupRequests.id,r!.wakeId));
  await startWorkers();
  await r!.receipt();
  await wait(async()=>expect(edge.calls).toHaveLength(1),120_000);
  await hb.drainActiveRunExecutions();
  expect(await r!.replies()).toHaveLength(1);expect(await r!.runs()).toHaveLength(1);
  await settleUnansweredPersonMessage(db,{companyId:r!.companyId,issueId:r!.issueId});
  expect(await r!.notes()).toHaveLength(0);
  expect(await r!.replies()).toHaveLength(1);expect(edge.calls).toHaveLength(1);
 });
});
