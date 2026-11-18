import { randomUUID } from 'node:crypto';
import { and,eq } from 'drizzle-orm';
import { agents,authUsers,companyMemberships,createDb,heartbeatRuns,issueComments,issues } from '@paperclipai/db';
import type { NativeRunIdentity,NativeSession,PrpEvent } from '@paperclipai/paperclip-runner';
import { describe,it,expect } from 'vitest';
import { nativeRestartFixture,waitForCondition } from './helpers/native-restart-fixture.js';
import { heartbeatService, type HeartbeatServiceOptions } from '../services/heartbeat.js';
import { instanceSettingsService } from '../services/instance-settings.js';
import { issueService } from '../services/issues.js';
import { deliverConversationComments } from '../services/agent-conversations.js';
import { closeIdleWarmNativeSessionsForRestart } from '../services/native-runtime/native-session-executor.js';
const texts=["This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.","blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs"];
describe('independent refusal next-message real scheduling',()=>{
 const fixture=nativeRestartFixture({});
 it.each(texts)('answers next message after %s',async text=>{
  const {companyId,agentId}=fixture.current;
  const db=createDb(fixture.current.temporary.connectionString,{maxConnections:6});
  const seen:string[]=[];
  const factory:NonNullable<HeartbeatServiceOptions['nativeSessionBackendFactory']>=execution=>{
   let identity:NativeRunIdentity; let sourceInstanceId=''; let turn=Promise.withResolvers<string>();
   const first=seen.length===0; seen.push(execution.binding.runId);
   const capabilities={resume:true,typedEvents:true,steering:false,interruption:true,structuredResult:true};
   const session:NativeSession={identity:()=>identity,capabilities:async()=>capabilities,attachRun:async input=>{identity=input.identity;},
    startTurn:async()=>{const turnId=randomUUID();turn.resolve(turnId);return {turnId};},
    async *events(){const turnId=await turn.promise; const event=(seq:number,eventType:PrpEvent['eventType'],payload:Record<string,unknown>):PrpEvent=>({schema:'paperclip.prp.event.v1',sourceKind:'runner',sourceInstanceId,sourceEventId:`${identity.runId}:${seq}`,sourceSeq:seq,runId:identity.runId,normalizedSessionId:identity.sessionId,turnId,schemaVersion:1,priority:0,emittedAt:new Date().toISOString(),eventType,payload});
     yield event(1,'turn.started',{});
     if(first)yield event(2,'turn.failed',{status:'failed',error:{code:'pi_provider_error',message:text}});
     else {yield event(2,'item.completed',{kind:'agentMessage',channel:'final',text:'The capital of France is Paris.'});yield event(3,'turn.completed',{status:'completed'});}
     turn=Promise.withResolvers<string>();
    },result:async()=>null,snapshot:async()=>({backendKind:'mock',sessionId:'judge',identity,providerSessionId:'judge-provider',cursor:null,activeTurnId:null,pendingRuntimeRequests:[],lineage:[]}),close:async()=>{}};
   return {descriptor:async()=>{const [r]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,execution.binding.runId));sourceInstanceId=r.runnerInstanceId!;return {kind:'mock',name:'judge-refusal-next',version:'1',capabilities,runtimeContextCapabilities:{instructions:'native',skills:'native',mcp:'native'}};},openSession:async input=>{identity=input.identity;return session;},recoverSession:async snapshot=>{identity=snapshot.identity;return {recovered:true,session};}};
  };
  const hb=heartbeatService(db,{nativeSessionBackendFactory:factory});
  try {
   const userId=randomUUID(); await db.insert(authUsers).values({id:userId,name:'Judge owner',email:`${userId}@example.invalid`,createdAt:new Date(),updatedAt:new Date()});
   await db.insert(companyMemberships).values({companyId,principalType:'user',principalId:userId,membershipRole:'owner'});
   await db.update(agents).set({status:'idle',adapterConfig:{provider:'pi_rpc',model:'anthropic/fixture-model'},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true}}}).where(eq(agents.id,agentId));
   await instanceSettingsService(db).updateExperimental({enableAgentChat:true,enableNativeRunner:true});
   const chat=await issueService(db).create(companyId,{title:'Refusal then ordinary question',conversationAgentId:agentId,conversationUserId:userId,assigneeAgentId:agentId,conversationState:'waiting',status:'in_review',responsibleUserId:userId});
   const send=async(body:string)=>{const c=await issueService(db).addComment(chat.id,body,{userId},{clientRequestId:randomUUID()});const outcome=await deliverConversationComments(db,chat,hb.wakeup);console.log('JUDGE_DELIVERY',JSON.stringify({commentId:c.id,outcome}));return c;};
   await send('First request');
   await waitForCondition('first native refusal to settle',()=>hb.getTaskDrainStatus().quiescent,20000);
   const before=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId,chat.id));
   console.log('JUDGE_FIRST_RUN',JSON.stringify(before.map(r=>({id:r.id,status:r.status,errorCode:r.errorCode,error:r.error,result:r.resultJson,context:r.contextSnapshot}))));
   expect(before).toHaveLength(1);expect.soft(before[0].errorCode).toBe('provider_policy_refusal');
   const next=await send('What is the capital of France?');
   await waitForCondition('second native answer to settle',()=>hb.getTaskDrainStatus().quiescent,20000);
   const runs=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.nativeIssueId,chat.id));
   const comments=await db.select().from(issueComments).where(eq(issueComments.issueId,chat.id));
   console.log('JUDGE_NEXT_MESSAGE',JSON.stringify({text,nextCommentId:next.id,seen,runs:runs.map(r=>({id:r.id,status:r.status,errorCode:r.errorCode,context:r.contextSnapshot})),comments:comments.map(c=>({id:c.id,authorType:c.authorType,body:c.body,metadata:c.metadata}))}));
   expect(seen).toHaveLength(2);expect(runs).toHaveLength(2);
   expect(comments.filter(c=>c.authorAgentId===agentId&&c.body.includes('Paris'))).toHaveLength(1);
  } finally {await hb.drainActiveRunExecutions();await closeIdleWarmNativeSessionsForRestart();await db.$client.end();}
 },60000);
});
