// Independent B1 audit. Local real PostgreSQL, no production/provider I/O.
// Keep reason: temporal data safety, false notice after /new and lost already-due notice.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issues, nativeRunFinalizations } from '@paperclipai/db';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from '../../__tests__/helpers/embedded-postgres.js';
import { settleUnansweredPersonMessage, settleUnansweredPersonMessages, unansweredPersonMessageCondition, unansweredPersonMessageCommentCondition, PENDING_WAIT_ACTION } from './unanswered-person-message.js';
import { conversationResetSql } from '../issue-comment-current.js';
import { isConversation, isConversationReset } from '../agent-conversations.js';
import { nativeLeaseHolderStamp, settleNativeTokenLease } from '../native-runtime/native-token-lease-settlement.js';
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)('B1 independent temporal audit', () => {
 let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
 const receipt: Record<string, unknown> = {};
 beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase('b1-own-'); db = createDb(temp.connectionString); receipt.postgres = await db.execute(sql`select version()`); }, 60000);
 afterAll(async () => { try { if(process.env.TASK_OUT) writeFileSync(process.env.TASK_OUT+'/independent-receipt.json', JSON.stringify(receipt,null,2)); } finally { await db?.$client.end(); await temp?.cleanup(); } });
 async function fixture(chat = true) {
  const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), userId=randomUUID();
  const t=Date.now()-3600000, at=(ms:number)=>new Date(t+ms);
  await db.insert(companies).values({id:companyId,name:'B1 independent',issuePrefix:companyId.slice(0,8)});
  await db.insert(agents).values({id:agentId,companyId,name:'Coder',status:'active',adapterType:'paperclip_runner',createdAt:at(-1000),updatedAt:at(-1000)});
  await db.insert(issues).values({id:issueId,companyId,title:'B1 temporal',status:'in_review',assigneeAgentId:agentId,...(chat?{conversationAgentId:agentId,conversationUserId:userId,conversationState:'waiting'}:{})});
  const add=async(body:string,ms:number)=> (await db.insert(issueComments).values({companyId,issueId,body,authorType:'user',authorUserId:userId,createdAt:at(ms)}).returning())[0]!;
  const notes=()=> db.select().from(issueComments).where(and(eq(issueComments.issueId,issueId),eq(issueComments.authorType,'system')));
  const settle=(ms:number)=>settleUnansweredPersonMessage(db,{companyId,issueId,now:at(ms)});
  const sweep=(ms:number)=>settleUnansweredPersonMessages(db,{companyId,issueId,now:at(ms)});
  const failedWake=async(messageId:string,created:number,finished:number)=>db.insert(agentWakeupRequests).values({companyId,agentId,source:'on_demand',reason:'issue_commented',status:'failed',payload:{issueId,commentId:messageId},createdAt:at(created),updatedAt:at(finished),finishedAt:at(finished)});
  const run=async(messageId:string,created:number,started:number|null,finished:number|null)=> (await db.insert(heartbeatRuns).values({companyId,agentId,nativeIssueId:issueId,runtimeMode:'native',status:finished===null?'running':'failed',errorCode:finished===null?null:'adapter_failed',contextSnapshot:{issueId,wakeCommentId:messageId},createdAt:at(created),startedAt:started===null?null:at(started),finishedAt:finished===null?null:at(finished),updatedAt:at(finished??created)}).returning())[0]!;
  return {companyId,agentId,issueId,userId,at,add,notes,settle,sweep,failedWake,run};
 }
 async function record(name:string,f:Awaited<ReturnType<typeof fixture>>, result:unknown) {const notes=await f.notes();receipt[name]={result,notes:notes.map(n=>({body:n.body,metadata:n.metadata}))};return notes;}
 it.each(['late-create','queued-then-failed'])('A: reset inside window then later failed wake: %s',async variant=>{
  const f=await fixture(), m=await f.add('Old message',0);const id=randomUUID();
  if(variant==='queued-then-failed') await db.insert(agentWakeupRequests).values({id,companyId:f.companyId,agentId:f.agentId,source:'on_demand',status:'queued',payload:{issueId:f.issueId,commentId:m.id},createdAt:f.at(500),updatedAt:f.at(500)});
  await f.add('/new',1000);
  if(variant==='late-create') await f.failedWake(m.id,2000,3000);else await db.update(agentWakeupRequests).set({status:'failed',updatedAt:f.at(3000),finishedAt:f.at(3000)}).where(eq(agentWakeupRequests.id,id));
  const outcomes=[await f.sweep(200000),await f.sweep(300000)];expect(await record('A-'+variant,f,outcomes)).toHaveLength(0);
 });
 it('B: already due before reset; first sweep after reset must post exactly once',async()=>{const f=await fixture();await f.add('Due message',0);await f.add('/new',130000);const outcomes=[await f.sweep(200000),await f.sweep(210000)];expect(await record('B',f,outcomes)).toHaveLength(1);});
 it('C: task literal /new passes both discovery predicates and posts a note',async()=>{const f=await fixture(false),m=await f.add('/new',0);const issueHits=await db.select({id:issues.id}).from(issues).where(and(eq(issues.id,f.issueId),unansweredPersonMessageCondition(issues.id,issues.companyId)));const commentHits=await db.select({id:issueComments.id}).from(issueComments).where(and(eq(issueComments.id,m.id),unansweredPersonMessageCommentCondition()));expect(issueHits).toHaveLength(1);expect(commentHits).toHaveLength(1);expect(await record('C',f,await f.sweep(200000))).toHaveLength(1);});
 it('D: a real message after /new is covered and attributed normally',async()=>{const f=await fixture();await f.add('Old',0);await f.add('/new',1000);const m=await f.add('New message',2000);const notes=await record('D',f,await f.sweep(200000));expect(notes).toHaveLength(1);expect(notes[0]?.metadata?.authorizationReason).toBe('unanswered_message:'+m.id);});
 it.each([-1,0,1])('E: failed wake timestamp relative to reset %s ms (inclusive failure)',async offset=>{const f=await fixture(),m=await f.add('Clock skew',0);await f.failedWake(m.id,500,1000+offset);await f.add('/new',1000);const notes=await record('E-'+offset,f,await f.sweep(200000));expect(notes).toHaveLength(offset<=0?1:0);});
 it.each(['late-created','finished-later'])('F: carrying run %s was not terminal at reset',async variant=>{const f=await fixture(),m=await f.add('Old',0);await f.add('/new',1000);await f.run(m.id,variant==='late-created'?2000:100,variant==='late-created'?2000:500,3000);expect(await record('F-'+variant,f,await f.sweep(200000))).toHaveLength(0);});
 it.each([null,15000,20000])('G: finished run at 1s and reset at 20s: finalization last update %s',async update=>{const f=await fixture(),m=await f.add('Due terminal message',0);const run=await f.run(m.id,100,200,1000);if(update!==null) await db.insert(nativeRunFinalizations).values({companyId:f.companyId,issueId:f.issueId,runId:run.id,phase:'terminal_failure',createdAt:f.at(100),updatedAt:f.at(update)});await f.add('/new',20000);expect(await record('G-'+update,f,await f.sweep(200000))).toHaveLength(1);});
 it('H: an already-terminal finalization touched after reset must not erase an already-due note',async()=>{const f=await fixture(),m=await f.add('Due terminal message',0);const run=await f.run(m.id,100,200,1000);await db.insert(nativeRunFinalizations).values({companyId:f.companyId,issueId:f.issueId,runId:run.id,phase:'terminal_failure',createdAt:f.at(100),updatedAt:f.at(1000)});await f.add('/new',20000);await db.update(nativeRunFinalizations).set({updatedAt:f.at(30000)}).where(eq(nativeRunFinalizations.runId,run.id));expect(await record('H',f,await f.sweep(200000))).toHaveLength(1);});
 it('I: pause after reset cannot revive a message reset away inside no-run window',async()=>{const f=await fixture(),m=await f.add('Pending while active',0);expect((await f.settle(29999)).kind).toBe('pending');await f.add('/new',30000);expect((await f.settle(30001)).kind).toBe('none');await db.update(agents).set({status:'paused',updatedAt:f.at(40000)}).where(eq(agents.id,f.agentId));await f.failedWake(m.id,100,50000);expect(await record('I',f,await f.sweep(200000))).toHaveLength(0);});
 it('J: resume after reset must not erase a note already due while agent was paused',async()=>{const f=await fixture();await db.update(agents).set({status:'paused',updatedAt:f.at(-100)}).where(eq(agents.id,f.agentId));await f.add('Already due paused',0);await f.add('/new',30000);await db.update(agents).set({status:'active',updatedAt:f.at(40000)}).where(eq(agents.id,f.agentId));expect(await record('J',f,await f.sweep(200000))).toHaveLength(1);});
 it('L: real token-lease settlement after reset cannot reinterpret committed finalization as pending',async()=>{
  const f=await fixture(),m=await f.add('Due terminal message',0);const run=await f.run(m.id,100,200,1000);
  await db.update(heartbeatRuns).set({status:'succeeded',errorCode:null}).where(eq(heartbeatRuns.id,run.id));
  const token='native-cleanup:'+randomUUID(), holder={bootId:randomUUID(),pid:2147483000,hostHash:'b1-isolated-fixture-host',processStartedAt:f.at(0).toISOString()};
  await db.insert(nativeRunFinalizations).values({companyId:f.companyId,issueId:f.issueId,runId:run.id,phase:'committed',createdAt:f.at(100),updatedAt:f.at(1000),leaseOwner:token,leaseExpiresAt:f.at(60000),leaseHolder:{token,...holder}});
  await f.add('/new',20000);
  const settled=await settleNativeTokenLease('native_cleanup_lease',db,{recordId:run.id,companyId:f.companyId,issueId:f.issueId,runId:run.id,updatedAt:f.at(1000),owner:{kind:'process',stamp:nativeLeaseHolderStamp(holder,'native_cleanup_lease')}},{now:f.at(30000),proof:{verdict:'gone',reason:'pid_dead'}});
  expect(settled.settled).toBe(true);
  const [state]=await db.select({phase:nativeRunFinalizations.phase,updatedAt:nativeRunFinalizations.updatedAt}).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,run.id));
  expect(state?.phase).toBe('committed');expect(state?.updatedAt).toEqual(f.at(30000));
  expect(await record('L',f,{settled,state,sweep:await f.sweep(200000)})).toHaveLength(1);
 });
 it('K: SQL reset agrees with TS on schema-valid chat and task identities',async()=>{for(const chat of [true,false]){const f=await fixture(chat);const m=await f.add(' \t/new\n',1);const rows=await db.select({reset:conversationResetSql({body:issueComments.body,authorUserId:issueComments.authorUserId,issueId:issueComments.issueId})}).from(issueComments).where(eq(issueComments.id,m.id));expect(rows[0]?.reset).toBe(isConversation(chat?{conversationAgentId:f.agentId,conversationUserId:f.userId}:{}) && isConversationReset(m.body));}});
});
