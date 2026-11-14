// Independent RFL B2 probes: isolated real PostgreSQL, production settle/fallback entry points.
// Keep reason: recorded seed A false resend advice; temporal and notice-history data safety.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from '@paperclipai/db';
import { isCurrentNotice } from '@paperclipai/shared';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from '../../__tests__/helpers/embedded-postgres.js';
import { settleUnansweredPersonMessage, settleUnansweredPersonMessages } from './unanswered-person-message.js';
import { BACKLOG_CONTINUATION_SOURCE_CODES, BACKLOG_CONTINUATION_MAX_AGE_MS, ensureFreshContinuation, FRESH_CONTINUATION_SCHEMA } from '../fresh-continuation-fallback.js';
import { recordNativeFinalizationFailure } from '../native-runtime/native-run-finalizer.js';
const support=await getEmbeddedPostgresTestSupport();
const RETRYING="Your message wasn't answered yet; Paperclip is retrying automatically.";
const SAFE=/sending it again is safe/i;
describe.skipIf(!support.supported)('B2 independent verdict and lifetime',()=>{
 let temp:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
 const receipt:Record<string,unknown>={};
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase('b2-own-');db=createDb(temp.connectionString)},60000);
 afterAll(async()=>{try {if(process.env.TASK_OUT)writeFileSync(process.env.TASK_OUT+'/b2-independent-receipt.json',JSON.stringify(receipt,null,2))}finally{await db?.$client.end();await temp?.cleanup()}});
 async function fixture(code='native_session_interrupted',chat=true,status='in_progress'){
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),userId=randomUUID();
  const t=Date.now()-3600000,at=(ms:number)=>new Date(t+ms);
  await db.insert(companies).values({id:companyId,name:'B2 independent',issuePrefix:companyId.slice(0,8)});
  await db.insert(agents).values({id:agentId,companyId,name:'Coder',status:'active',adapterType:'paperclip_runner'});
  await db.insert(issues).values({id:issueId,companyId,title:'B2 check',status,assigneeAgentId:agentId,...(chat?{conversationAgentId:agentId,conversationUserId:userId,conversationState:'active'}:{})});
  const message=(await db.insert(issueComments).values({companyId,issueId,authorType:'user',authorUserId:userId,body:'What word did I ask you to remember?',createdAt:at(0)}).returning())[0]!;
  const run=async(errorCode:string,ms:number,retryOfRunId?:string,error?:string)=> (await db.insert(heartbeatRuns).values({companyId,agentId,nativeIssueId:issueId,issueId,runtimeMode:'native',status:'failed',errorCode,error:error??'runner_harness_state_mismatch: backup_without_reusable_lease',createdAt:at(ms),startedAt:at(ms+1),finishedAt:at(ms+2),updatedAt:at(ms+2),retryOfRunId,contextSnapshot:{issueId,wakeCommentId:message.id}}).returning())[0]!;
  const first=await run(code,1000);
  // Production logActivity uses wall time. Align only newly emitted fixture receipts/notes to our explicit clock.
  const stamp=async(ms:number)=>{await db.update(activityLog).set({createdAt:at(ms)}).where(and(eq(activityLog.companyId,companyId),gt(activityLog.createdAt,at(ms))));await db.update(issueComments).set({createdAt:at(ms)}).where(and(eq(issueComments.issueId,issueId),eq(issueComments.authorType,'system'),gt(issueComments.createdAt,at(ms))))};
  const settle=async(ms:number)=>{const result=await settleUnansweredPersonMessage(db,{companyId,issueId,now:at(ms)});await stamp(ms);return result};
  const sweep=async(ms:number)=>{const result=await settleUnansweredPersonMessages(db,{companyId,issueId,now:at(ms)});await stamp(ms);return result};
  const history=()=>db.select().from(issueComments).where(and(eq(issueComments.issueId,issueId),eq(issueComments.authorType,'system')));
  const current=async()=>(await history()).filter(n=>isCurrentNotice(n.metadata));
  const reply=async(ms:number,runId=first.id)=>(await db.insert(issueComments).values({companyId,issueId,authorType:'agent',authorAgentId:agentId,createdByRunId:runId,body:'The answer is cedar.',createdAt:at(ms)}).returning())[0]!;
  const refusal=(ms:number)=>run('native_continuation_requires_reconciliation',ms,first.id,'native_controller_recovery_missing_evidence:retained_sandbox_binding');
  const record=async(ms:number,evidence:Record<string,unknown>,ownerType='system',status='resolved')=>(await db.insert(issueRecoveryActions).values({companyId,sourceIssueId:issueId,kind:'active_run_watchdog',cause:'native_continuation_requires_reconciliation',ownerType,status,fingerprint:randomUUID(),evidence,nextAction:'Independent fixture',createdAt:at(ms),updatedAt:at(ms)}).returning())[0]!;
  return{companyId,agentId,issueId,userId,at,message,first,run,settle,sweep,history,current,reply,refusal,record};
 }
 async function save(key:string,f:Awaited<ReturnType<typeof fixture>>,extra:unknown={}){receipt[key]={extra,notes:await f.history()};}
 it.each(BACKLOG_CONTINUATION_SOURCE_CODES)('source code %s waits before T0 and yields only held note on refusal',async code=>{
  const f=await fixture(code);await f.sweep(20000);expect(await f.history()).toHaveLength(0);
  await f.refusal(30000);await f.sweep(50000);await f.sweep(60000);
  await save(code,f);expect(await f.current()).toHaveLength(1);expect((await f.current())[0]!.body).toBe("Coder can't continue this chat from its saved state. Start a new chat with Coder; this one stays readable.");expect((await f.history()).some(n=>SAFE.test(n.body))).toBe(false);
 });
 it.each([true,false])('reply before recovery verdict means no notice (chat=%s)',async chat=>{
  const f=await fixture('native_session_interrupted',chat);await f.sweep(20000);await f.reply(30000);await f.sweep(200000);await save('early-answer-'+chat,f);expect(await f.history()).toHaveLength(0);
 });
 it.each(['held','answer'])('T0 boundary then %s: one current note, history retained',async end=>{
  const f=await fixture();await f.sweep(20000);expect(await f.history()).toHaveLength(0);
  await f.sweep(139999);expect(await f.history()).toHaveLength(0);
  await Promise.all([f.sweep(140000),f.sweep(140000)]);const first=(await f.current())[0]!;expect((await f.current()).map(n=>n.body)).toEqual([RETRYING]);
  await Promise.all([f.sweep(150000),f.sweep(150000)]);expect(await f.history()).toHaveLength(1);
  if(end==='held')await f.refusal(160000);else await f.reply(160000);
  await f.sweep(180000);await f.sweep(190000);await save('late-'+end,f);
  const all=await f.history(),kept=all.find(n=>n.id===first.id)!;
  expect(kept.body).toBe(first.body);expect((kept.metadata as unknown as Record<string,unknown>).supersededBy).toBeTruthy();
  expect(await f.current()).toHaveLength(end==='held'?1:0);expect(all.some(n=>SAFE.test(n.body))).toBe(false);
 });
 it('direct retained_sandbox_binding refusal does not defer',async()=>{
  const f=await fixture('native_continuation_requires_reconciliation');await db.update(heartbeatRuns).set({error:'native_controller_recovery_missing_evidence:retained_sandbox_binding'}).where(eq(heartbeatRuns.id,f.first.id));await f.sweep(20000);await save('direct-refusal',f);expect(await f.current()).toHaveLength(1);expect((await f.current())[0]!.body).toContain("can't continue");
 });
 it.each(['provider_quota','operator_cancelled','budget_blocked','native_provider_model_rejected'])('person-owned failure %s retains immediate existing notice',async code=>{
  const f=await fixture(code);await f.sweep(20000);await save('person-code-'+code,f);expect(await f.current()).toHaveLength(1);expect((await f.current())[0]!.body).not.toBe(RETRYING);
 });
 it.each(['board','pending-finalization','scheduled-resume','recorded','too-old'])('guard %s excludes the new retrying classification',async guard=>{
  const f=await fixture();
  if(guard==='board')await f.record(2000,{runId:f.first.id},'board','active');
  if(guard==='pending-finalization'||guard==='scheduled-resume')await db.insert(nativeRunFinalizations).values({companyId:f.companyId,issueId:f.issueId,runId:f.first.id,phase:guard==='pending-finalization'?'result_persisted':'retryable_failure',nextAttemptAt:guard==='scheduled-resume'?f.at(400000):null});
  if(guard==='recorded')await f.record(2000,{runId:f.first.id,freshContinuation:{sourceRunId:f.first.id,schema:FRESH_CONTINUATION_SCHEMA,recordedAt:f.at(2000).toISOString()},continuationDelivery:'delivered'});
  const ageOffset=guard==='too-old'?BACKLOG_CONTINUATION_MAX_AGE_MS:0;
  await f.sweep(ageOffset+20000);await f.sweep(ageOffset+200000);await save('guard-'+guard,f);expect((await f.history()).some(n=>n.body===RETRYING)).toBe(false);
 });
 it('reset during recovery-verdict window stays reset after a later durable continuation record',async()=>{
  const f=await fixture();await f.sweep(20000);expect(await f.history()).toHaveLength(0);
  await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:'user',authorUserId:f.userId,body:'/new',createdAt:f.at(30000)});
  expect((await f.settle(30001)).kind).toBe('none');
  await f.record(40000,{runId:f.first.id,freshContinuation:{sourceRunId:f.first.id,schema:FRESH_CONTINUATION_SCHEMA,recordedAt:f.at(40000).toISOString()},continuationDelivery:'delivered'});
  await f.refusal(50000);const outcome=await f.sweep(80000);await save('reset-late-record',f,outcome);
  expect(await f.history(),'a later recovery record must not turn the prior pending-at-reset decision into a due notice').toHaveLength(0);
 });
 it('a chain already exhausted gets no new recovery-verdict wait',async()=>{
  const f=await fixture();const root=await f.run('native_session_interrupted',-2000);const previous=await f.run('native_session_interrupted',-1000,root.id);await db.update(heartbeatRuns).set({retryOfRunId:previous.id}).where(eq(heartbeatRuns.id,f.first.id));
  for(const [i,source] of [root,previous].entries())await f.record(-1500+1000*i,{runId:source.id,freshContinuation:{sourceRunId:source.id,schema:FRESH_CONTINUATION_SCHEMA,recordedAt:f.at(-1500+1000*i).toISOString()},continuationDelivery:'delivered'});
  await f.sweep(20000);await save('chain-exhausted',f);expect(await f.current()).toHaveLength(1);expect((await f.current())[0]!.body).not.toBe(RETRYING);
 });
 it('scheduled resume pending at reset stays reset after the real finalizer ends it',async()=>{
  const f=await fixture('adapter_failed');
  await db.insert(nativeRunFinalizations).values({companyId:f.companyId,issueId:f.issueId,runId:f.first.id,phase:'retryable_failure',nextAttemptAt:f.at(60000),createdAt:f.at(1000),updatedAt:f.at(1002)});
  await f.sweep(20000);expect(await f.history()).toHaveLength(0);
  await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:'user',authorUserId:f.userId,body:'/new',createdAt:f.at(30000)});
  expect((await f.settle(30001)).kind).toBe('none');
  const terminal=await recordNativeFinalizationFailure({db,runId:f.first.id,error:new Error('native_finalization_invalid'),permanent:true,projectRunStatus:true});
  expect(terminal.phase).toBe('terminal_failure');
  const [runNow]=await db.select({finishedAt:heartbeatRuns.finishedAt,nativePhase:heartbeatRuns.nativePhase,nativePhaseUpdatedAt:heartbeatRuns.nativePhaseUpdatedAt}).from(heartbeatRuns).where(eq(heartbeatRuns.id,f.first.id));
  const [finalizationNow]=await db.select({phase:nativeRunFinalizations.phase,nextAttemptAt:nativeRunFinalizations.nextAttemptAt,updatedAt:nativeRunFinalizations.updatedAt}).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.first.id));
  expect(runNow!.finishedAt).toEqual(f.first.finishedAt);expect(finalizationNow!.updatedAt.getTime()).toBeGreaterThan(f.at(30000).getTime());expect(finalizationNow!.phase).toBe('terminal_failure');expect(finalizationNow!.nextAttemptAt).toBeNull();
  await f.sweep(3700000);await save('late-finalizer-terminal',f,{terminal,runNow,finalizationNow});
  expect(await f.history(),'terminal verdict after reset must not move the past retry deadline backward').toHaveLength(0);
 });
 it('a real person-owned fallback verdict must not be described as retrying automatically',async()=>{
  const f=await fixture('native_session_interrupted',true,'in_review');
  const verdict=await ensureFreshContinuation(db,{companyId:f.companyId,runId:f.first.id,trigger:'recovery_refused',now:f.at(19000)});
  expect(verdict).toEqual({kind:'person_owned',reason:'in_review'});
  await f.sweep(20000);await f.sweep(140000);await save('person-owned-real-fallback',f,verdict);
  expect((await f.current()).some(n=>n.body===RETRYING),'Paperclip returned person_owned, not an automatic retry').toBe(false);
 });
});
