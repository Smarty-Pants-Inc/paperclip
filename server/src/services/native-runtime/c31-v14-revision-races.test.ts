import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, authUsers, companyMemberships, companies, createDb, heartbeatRuns, issueComments, issues } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from '../../__tests__/helpers/embedded-postgres.js';
import { createHeartbeatQueueTestDependencies } from '../../__tests__/helpers/heartbeat-queue.js';
import { createHeartbeatQueue } from '../heartbeat/queue.js';
import { nativeInputRevision, guardNativeTurnCommands } from './native-turn-budget.js';
import { nativeInputRefusalEvidence, hasUnchangedNativeInputRefusal } from '../native-input-refusal.js';
import { callbacks } from './c31-v14-completion-fixture.js';
import { createHeartbeatRunCompletion } from '../heartbeat/run-completion.js';
import { getAdapterSessionCodec } from '../heartbeat/run-state.js';
import { buildEffectiveRunSessionConfigMetadata } from '../heartbeat/workspaces.js';
import { issueService } from '../issues.js';
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase('c31-revision-races-');db=createDb(database.connectionString);},120000);
afterAll(async()=>{await db?.$client.end();await database?.cleanup();});
async function fixture(){
 const now=new Date(),user='revision-'+randomUUID();
 await db.insert(authUsers).values({id:user,name:'Input owner',email:user+'@example.test',createdAt:now,updatedAt:now});
 const [company]=await db.insert(companies).values({name:'Refusal revision race',issuePrefix:'R'+randomUUID().replaceAll('-','').slice(0,8).toUpperCase()}).returning();
 await db.insert(companyMemberships).values({companyId:company.id,principalType:'user',principalId:user,status:'active',membershipRole:'operator'});
 const [agent]=await db.insert(agents).values({companyId:company.id,name:'Revision worker',status:'idle',adapterType:'paperclip_runner',adapterConfig:{provider:'pi_rpc'}}).returning();
 const [issue]=await db.insert(issues).values({companyId:company.id,title:'Answer the repaired input',description:'Short request.',status:'in_progress',assigneeAgentId:agent.id,responsibleUserId:user}).returning();
 const [message]=await db.insert(issueComments).values({companyId:company.id,issueId:issue.id,authorType:'user',authorUserId:user,body:'x'.repeat(600038)}).returning();
 const revision=nativeInputRevision(issue,[{id:message.id,authorType:'user',createdByRunId:null,updatedAt:message.updatedAt.toISOString(),deleted:false}]);
 const [run]=await db.insert(heartbeatRuns).values({companyId:company.id,agentId:agent.id,status:'running',runtimeMode:'native',issueId:issue.id,nativeIssueId:issue.id,responsibleUserId:user,contextSnapshot:{issueId:issue.id,nativeInputRevision:revision},startedAt:now}).returning();
 const deps=createHeartbeatQueueTestDependencies(db);deps.getAgent.mockResolvedValue(agent);deps.instanceSettings.getExperimental.mockResolvedValue({} as never);
 const queue=createHeartbeatQueue(db,deps);
 const automatic=()=>queue.enqueueWakeup(agent.id,{source:'automation',reason:'issue_continuation_needed',requestedByActorType:'system',requestedByActorId:'recovery',payload:{issueId:issue.id},contextSnapshot:{issueId:issue.id,wakeReason:'issue_continuation_needed'}});
 const person=()=>queue.enqueueWakeup(agent.id,{source:'on_demand',reason:'issue_commented',requestedByActorType:'user',requestedByActorId:user,payload:{issueId:issue.id,commentId:message.id},contextSnapshot:{issueId:issue.id,wakeReason:'issue_commented',wakeCommentId:message.id}});
 return {company,agent,issue,message,revision,run,automatic,person};
}
it('D1 records attempted A after a person repairs to B before a late refusal; the next wake answers B',async()=>{
 const f=await fixture();
 const [repaired]=await db.update(issueComments).set({body:'Please answer ready for repaired B.',updatedAt:new Date(f.message.updatedAt.getTime()+1000)}).where(eq(issueComments.id,f.message.id)).returning();
 const b=nativeInputRevision(f.issue,[{id:repaired.id,authorType:'user',createdByRunId:null,updatedAt:repaired.updatedAt.toISOString(),deleted:false}]);
 const error=Object.assign(new Error('command_payload_too_large'),{code:'command_payload_too_large'});
 const evidence=await nativeInputRefusalEvidence(db,f.run,error,'command_payload_too_large');
 await db.update(heartbeatRuns).set({status:'failed',errorCode:'command_payload_too_large',resultJson:evidence,finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.run.id));
 const held=await hasUnchangedNativeInputRefusal(db,{companyId:f.company.id,issueId:f.issue.id});
 console.info(JSON.stringify({row:'D1-late-refusal',runId:f.run.id,attemptedA:f.revision.fingerprint,repairedB:b.fingerprint,recorded:(evidence as any).nativeTurnPromptRefusalInput?.fingerprint,repairedInputHeld:held}));
 expect(evidence).toMatchObject({nativeTurnPromptRefusalInput:{fingerprint:f.revision.fingerprint}});
 expect(held).toBe(false);
 const admitted=await f.automatic();expect(admitted).not.toBeNull();
 await db.update(heartbeatRuns).set({status:'running',startedAt:new Date()}).where(eq(heartbeatRuns.id,admitted!.id));
 const sent:any[]=[]; const authority={store:{state:{identity:{runId:admitted!.id}}},queueCommand:async(type:string,payload:any)=>{sent.push({type,payload});return payload;}};
 guardNativeTurnCommands(authority as never);await authority.queueCommand('turn.start',{text:repaired.body});expect(sent[0].payload.text).toBe(repaired.body);
 await issueService(db).addComment(f.issue.id,'Ready for repaired B.',{agentId:f.agent.id,runId:admitted!.id},{authorType:'agent',completionReply:true});
 const completion=createHeartbeatRunCompletion(db,callbacks(db) as never);
 await completion.completeRun({run:admitted!,agent:f.agent,issueId:f.issue.id,issueRef:f.issue,signal:new AbortController().signal,
  output:{handle:null,outputProgressState:{pending:null},flushOutputProgress:async()=>{},stdoutExcerpt:'Ready for repaired B.',stderrExcerpt:''},
  session:{runtimeForAdapter:{sessionId:null,sessionDisplayId:null},previousSessionParams:null,taskKey:f.issue.id,configuredModel:'test-model',sessionConfigMetadata:await buildEffectiveRunSessionConfigMetadata({adapterType:f.agent.adapterType,effectiveAdapterConfig:{},agentRuntimeConfig:{},issueOverrides:null,workspaceConfig:null,environment:null,environmentEnv:null,projectEnv:null,routineEnv:null,runtimeSkills:[]})},
  readFailureReportSecrets:()=>[],adapterResult:{exitCode:0,signal:null,timedOut:false,resultJson:{summary:'Ready for repaired B.',testPort:'local provider answer'}},sessionCodec:getAdapterSessionCodec(f.agent.adapterType),taskSessionForRun:null,sessionCompaction:{rotate:false,reason:null},configFreshnessResultMetadata:{},runLedgerScope:{},currentUserRedactionOptions:{enabled:false},providerTraceCapture:false,onProviderTraceFinalized:()=>{},issueContext:f.issue,onLog:async()=>{},
 } as never);
 const [completed]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,admitted!.id));expect(completed.status).toBe('succeeded');
 const replies=await db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issue.id),eq(issueComments.createdByRunId,admitted!.id)));expect(replies.some(c=>c.body==='Ready for repaired B.')).toBe(true);
 console.info(JSON.stringify({row:'D1-repaired-next-wake',runId:admitted!.id,status:completed.status,input:repaired.body,answer:'Ready for repaired B.',provider:'local transport/answer test port'}));
},120000);
it('D2b a newer cancelled queued row cannot erase the refusal hold; a person wake still runs',async()=>{
 const f=await fixture();
 await db.update(heartbeatRuns).set({status:'failed',errorCode:'command_payload_too_large',resultJson:{nativeTurnPromptRefusalInput:f.revision},finishedAt:new Date()}).where(eq(heartbeatRuns.id,f.run.id));
 const [queued]=await db.insert(heartbeatRuns).values({companyId:f.company.id,agentId:f.agent.id,status:'queued',runtimeMode:'native',issueId:f.issue.id,nativeIssueId:f.issue.id,contextSnapshot:{issueId:f.issue.id,nativeInputRevision:f.revision},createdAt:new Date(f.run.createdAt.getTime()+1000)}).returning();
 await db.update(heartbeatRuns).set({status:'cancelled',finishedAt:new Date(),errorCode:'operator_cancelled'}).where(eq(heartbeatRuns.id,queued.id));
 const held=await hasUnchangedNativeInputRefusal(db,{companyId:f.company.id,issueId:f.issue.id});const automatic=await f.automatic();
 console.info(JSON.stringify({row:'D2b-cancelled-row',refusedRunId:f.run.id,cancelledQueuedRunId:queued.id,inputFingerprint:f.revision.fingerprint,held,automaticRunId:automatic?.id??null}));
 expect(held).toBe(true);expect(automatic).toBeNull();
 const person=await f.person();expect(person).not.toBeNull();
 await db.update(heartbeatRuns).set({status:'cancelled',finishedAt:new Date(),errorCode:'operator_cancelled'}).where(eq(heartbeatRuns.id,person!.id));
 console.info(JSON.stringify({row:'D2b-person-wake',runId:person!.id,admitted:true,disposed:'unused fixture row cancelled; no provider started'}));
},120000);
