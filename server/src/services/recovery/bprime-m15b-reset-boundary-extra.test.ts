// Independent M1.5b boundary checks. Local PostgreSQL; no provider or production I/O.
// Keep reason: false failure advice after a session boundary (SMAA-1909), and temporal data safety.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueComments, issues } from '@paperclipai/db';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from '../../__tests__/helpers/embedded-postgres.js';
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_NO_RUN_GRACE_MS, UNANSWERED_MESSAGE_SETTLE_MS } from './unanswered-person-message.js';
const support=await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)('M15b independent reset boundary audit',()=>{
 let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
 const receipt: Record<string,unknown>={};
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase('m15b-boundary-');db=createDb(temp.connectionString)},60000);
 afterAll(async()=>{if (process.env.TASK_OUT) writeFileSync(process.env.TASK_OUT+'/reset-boundary-receipt.json',JSON.stringify(receipt,null,2));await db?.$client.end();await temp?.cleanup()});
 async function fixture(chat=true){
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),userId=randomUUID();
  const t=Date.now()-600000, at=(ms:number)=>new Date(t+ms);
  await db.insert(companies).values({id:companyId,name:'Reset boundary judge',issuePrefix:companyId.slice(0,8)});
  await db.insert(agents).values({id:agentId,companyId,name:'Coder',status:'active',adapterType:'paperclip_runner',adapterConfig:{},runtimeConfig:{}});
  await db.insert(issues).values({id:issueId,companyId,title:chat?'Chat':'Task',status:'in_review',assigneeAgentId:agentId,...(chat?{conversationAgentId:agentId,conversationUserId:userId,conversationState:'waiting'}:{})});
  const add=async(body:string,ms:number)=>{const [c]=await db.insert(issueComments).values({companyId,issueId,body,authorType:'user',authorUserId:userId,createdAt:at(ms)}).returning();return c!};
  const all=()=>db.select().from(issueComments).where(and(eq(issueComments.issueId,issueId),eq(issueComments.authorType,'system')));
  const settle=(ms:number)=>settleUnansweredPersonMessage(db,{companyId,issueId,now:at(ms)});
  return {companyId,agentId,issueId,userId,at,add,all,settle};
 }
 it.each([[-1,0],[0,1],[1,1]])('terminal settle deadline offset %s ms gives %s notes',async(offset,count)=>{
  const f=await fixture();const m=await f.add('Please continue',0);
  await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,nativeIssueId:f.issueId,runtimeMode:'native',status:'succeeded',createdAt:f.at(1),finishedAt:f.at(1000),contextSnapshot:{issueId:f.issueId,wakeCommentId:m.id}});
  await f.add('/new',1000+UNANSWERED_MESSAGE_SETTLE_MS+offset);
  await f.settle(300000);await f.settle(300001);
  const notes=await f.all();receipt['settle-offset-'+offset]=notes.map(n=>({id:n.id,body:n.body,reason:n.metadata?.authorizationReason}));expect(notes).toHaveLength(count);
 });
 it('no-run grace: reset inside the window suppresses notice on a late sweep',async()=>{
  const f=await fixture();await f.add('Please continue',0);await f.add('/new',1000);
  await f.settle(UNANSWERED_MESSAGE_NO_RUN_GRACE_MS+1000);expect(await f.all()).toHaveLength(0);
 });
 it.each(['late-create','queued-then-failed'])('a failed wake recorded AFTER the reset cannot retroactively make the pre-reset message overdue (%s)',async variant=>{
  const f=await fixture();const m=await f.add('Please continue',0);
  const wakeId=randomUUID();
  if(variant==='queued-then-failed') await db.insert(agentWakeupRequests).values({id:wakeId,companyId:f.companyId,agentId:f.agentId,source:'on_demand',triggerDetail:'manual',reason:'issue_commented',status:'queued',requestedByActorType:'user',requestedByActorId:f.userId,payload:{issueId:f.issueId,commentId:m.id},createdAt:f.at(500),updatedAt:f.at(500)});
  const actualAtBoundary=await f.settle(1000);expect(actualAtBoundary.kind).toBe('pending');
  await f.add('/new',1000);
  const resetAtBoundary=await f.settle(1001);expect(resetAtBoundary.kind).toBe('none');
  // The old message is reset away while its no-run grace is still pending.
  // Later cleanup/dispatch fails that message's durable wake, still with no run.
  if(variant==='late-create') await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'on_demand',triggerDetail:'manual',reason:'issue_commented',status:'failed',requestedByActorType:'user',requestedByActorId:f.userId,payload:{issueId:f.issueId,commentId:m.id},createdAt:f.at(2000),updatedAt:f.at(3000),finishedAt:f.at(3000)});
  else await db.update(agentWakeupRequests).set({status:'failed',updatedAt:f.at(3000),finishedAt:f.at(3000)}).where(eq(agentWakeupRequests.id,wakeId));
  const late=await f.settle(UNANSWERED_MESSAGE_NO_RUN_GRACE_MS+10000);await f.settle(UNANSWERED_MESSAGE_NO_RUN_GRACE_MS+10001);
  const notes=await f.all();receipt['lateFailedWake-'+variant]={actualAtBoundary,resetAtBoundary,late,messageId:m.id,notes:notes.map(n=>({id:n.id,body:n.body,reason:n.metadata?.authorizationReason}))};
  expect(notes,'the /new happened within the actual no-run window; later failure is not evidence that it was due before the reset').toHaveLength(0);
 });
 it('ordinary task /new is not Paperclip conversation reset and is still an owed message',async()=>{
  const f=await fixture(false);const m=await f.add('/new',0);
  await f.settle(UNANSWERED_MESSAGE_NO_RUN_GRACE_MS+1000);
  const notes=await f.all();receipt.taskLiteralNew={messageId:m.id,notes};
  expect(notes,'upstream reset admission is gated by isConversation(issue)').toHaveLength(1);
 });
});
