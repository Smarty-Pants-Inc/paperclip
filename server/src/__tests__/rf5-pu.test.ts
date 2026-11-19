import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { and,eq,ne,sql } from 'drizzle-orm';
import { agents,authUsers,companyMemberships,createDb,environments,environmentLeases,heartbeatRuns,issueComments,issues,plugins } from '@paperclipai/db';
import { afterAll,describe,expect,it,vi } from 'vitest';
import { nativeRestartFixture,waitForCondition } from './helpers/native-restart-fixture.js';
import { getRecoveryPostgresSupport } from './helpers/recovery-postgres-fixture.js';
import { rf5CompletingPeer } from './helpers/rf5-completing-peer.js';
const seam=vi.hoisted(()=>({factory:undefined as any}));
// Only the external native provider is substituted; routes, admission, cancellation,
// lifecycle worker, result/event persistence, reply publication and GET projections are real.
vi.mock('../services/heartbeat.js',async original=>{
 const actual=await original<typeof import('../services/heartbeat.js')>();
 return {...actual,heartbeatService:(db:any,options:any={})=>actual.heartbeatService(db,{...options,nativeSessionBackendFactory:seam.factory})};
});
vi.mock('../telemetry.ts',()=>({getTelemetryClient:()=>({track:()=>{}})}));
import { heartbeatService } from '../services/heartbeat.js';
import { agentRoutes } from '../routes/agents.js';
import { issueRoutes } from '../routes/issues.js';
import { errorHandler } from '../middleware/index.js';
import { configureAgentLifecycle } from '../services/agent-lifecycle.js';
import { createLifecycleDriver } from '../services/agent-lifecycle-driver.js';
import { instanceSettingsService } from '../services/instance-settings.js';
import { closeIdleWarmNativeSessionsForRestart } from '../services/native-runtime/native-session-executor.js';
const support=await getRecoveryPostgresSupport({});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const bounded=async<T>(p:Promise<T>,ms:number)=>{let t:any;try{return await Promise.race([p,new Promise<never>((_,reject)=>{t=setTimeout(()=>reject(new Error('bounded timeout')),ms)})])}finally{clearTimeout(t)}};
describe.skipIf(!support.supported)('RF5 PU real HTTP pause truth',()=>{
 const fixture=nativeRestartFixture({});
 afterAll(async()=>{await closeIdleWarmNativeSessionsForRestart()});
 async function seed(){
  const {companyId,temporary}=fixture.current; const db=createDb(temporary.connectionString);
  const agentId=randomUUID(),userId=randomUUID(),issueId=randomUUID(),pluginId=randomUUID(),environmentId=randomUUID();
  await db.insert(authUsers).values({id:userId,name:'PU board',email:userId+'@example.test',createdAt:new Date(),updatedAt:new Date()});
  await db.insert(companyMemberships).values({companyId,principalType:'user',principalId:userId,membershipRole:'owner',status:'active'});
  await db.insert(agents).values({id:agentId,companyId,name:'PU Managed Pi',role:'engineer',status:'idle',adapterType:'paperclip_runner',adapterConfig:{provider:'pi_rpc',model:'paperclip/faux',lifecycleMode:'warm',idleTimeoutMs:60000},runtimeConfig:{},permissions:{}});
  await db.insert(issues).values({id:issueId,companyId,title:'Pause HTTP truth',status:'in_progress',assigneeAgentId:agentId,responsibleUserId:userId,conversationAgentId:agentId,conversationUserId:userId,conversationState:'active'});
  await instanceSettingsService(db).updateExperimental({enableAgentChat:true,enableNativeRunner:true});
  let holdNext=true,started=false; const stop=Promise.withResolvers<void>();
  const completing=rf5CompletingPeer(db);
  seam.factory=(execution:any)=>{
   const backend=completing(execution);if(!holdNext)return backend;holdNext=false;
   return {...backend,openSession:async(input:any)=>{const session=await backend.openSession(input);return {...session,
    startTurn:async(input:any)=>session.startTurn(input),
    async *events(){for await(const event of session.events()){if(event.eventType==='turn.started'){started=true;yield event;await stop.promise;yield {...event,sourceSeq:2,sourceEventId:event.sourceInstanceId+':'+event.runId+':2',eventType:'turn.completed' as const,payload:{status:'interrupted'}};return;}}},result:async()=>null,
    interrupt:async()=>{stop.resolve();},close:async()=>{stop.resolve();await session.close({reason:"test close"})}}}};
  };
  const pluginKey='paperclip.pu-'+pluginId.slice(0,8);
  await db.insert(plugins).values({id:pluginId,pluginKey,packageName:'@paperclipai/plugin-fake-sandbox',version:'1.0.0',apiVersion:1,categories:['automation'],status:'ready',installOrder:1,updatedAt:new Date(),manifestJson:{id:pluginKey,apiVersion:1,version:'1.0.0',displayName:'Blocked PU box',description:'provider-only seam',author:'Paperclip',categories:['automation'],capabilities:['environment.drivers.register'],entrypoints:{worker:'dist/worker.js'},environmentDrivers:[{driverKey:'fake-boat',kind:'sandbox_provider',displayName:'Blocked PU box',configSchema:{type:'object'}}]}} as never);
  await db.insert(environments).values({id:environmentId,name:'PU blocked remote '+environmentId,driver:'sandbox',status:'active',config:{provider:'fake-boat',image:'fake:test',reuseLease:true}});
  const manager={isRunning:(id:string)=>id===pluginId,getWorker:()=>({supportedMethods:['environmentAcquireLease','environmentExecute','environmentReleaseLease','environmentDestroyLease','environmentStopLease']}),call:()=>new Promise(()=>{})} as any;
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).actor={type:'board',source:'session',userId,companyIds:[companyId],memberships:[{companyId,status:'active',membershipRole:'owner'}],isInstanceAdmin:true};next()});
  app.use('/api',agentRoutes(db,{pluginWorkerManager:manager}));app.use('/api',issueRoutes(db,{} as any,{pluginWorkerManager:manager}));app.use(errorHandler);
  const heartbeat=heartbeatService(db,{pluginWorkerManager:manager});
  const initial=await request(app).post(`/api/issues/${issueId}/comments`).send({body:'Start the live turn.',clientRequestId:randomUUID()});
  expect(initial.status,JSON.stringify(initial.body)).toBe(201);
  await waitForCondition('actual provider startTurn',()=>started,15000);
  const [run]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,agentId),eq(heartbeatRuns.status,'running')));expect(run).toBeDefined();
  // Same active remote-lease/provider-stop shape as the unit's pause-server-record
  // template. Provider is controlled, not a live Boat; initial native admission above is real.
  await db.insert(environmentLeases).values({companyId,environmentId,heartbeatRunId:run.id,issueId,status:'active',leasePolicy:'ephemeral',provider:'fake-boat',providerLeaseId:'pu-box-'+randomUUID(),metadata:{agentId,driver:'sandbox',pluginId,pluginKey,sandboxProviderPlugin:true,provider:'fake-boat',image:'fake:test',remoteCwd:'/workspace',sandboxState:'started'}});
  let pumping=false; // Hold only the lifecycle scheduler until the HTTP Resume has observed 'pausing'.
  const worker=configureAgentLifecycle(db,createLifecycleDriver(db,manager),()=>pumping);
  const due=()=>db.update(agents).set({lifecycleOperation:sql`${agents.lifecycleOperation} - 'retryAt'`}).where(eq(agents.id,agentId));
  const get=async()=>{const r=await request(app).get(`/api/agents/${agentId}`);expect(r.status).toBe(200);return r.body};
  const process=async()=>{pumping=true;try{await due();await bounded(worker.process(agentId),3000).catch(()=>{});}finally{pumping=false}};
  const cleanup=async()=>{stop.resolve();await bounded(worker.stop(),2500).catch(()=>{});await bounded(heartbeat.drainActiveRunExecutions(),5000).catch(()=>{});await closeIdleWarmNativeSessionsForRestart();await db.$client.end()};
  return {db,app,companyId,agentId,issueId,run,heartbeat,get,process,cleanup};
 }
 it('(a)/(c) Pause live native turn: GET paused at +2s/+30s; real run GET execution truth',async()=>{
  const f=await seed();try{
   const response=await request(f.app).post(`/api/agents/${f.agentId}/pause`).send({});expect(response.status,JSON.stringify(response.body)).toBe(200);
   const began=Date.now();const firstPump=f.process();await sleep(Math.max(0,2000-(Date.now()-began)));const plus2=await f.get();const plus2Elapsed=Date.now()-began;await firstPump;
   await sleep(Math.max(0,29000-(Date.now()-began)));const latePump=f.process();await sleep(Math.max(0,30000-(Date.now()-began)));const plus30=await f.get();const plus30Elapsed=Date.now()-began;await latePump;
   const run=await request(f.app).get(`/api/heartbeat-runs/${f.run.id}`);expect(run.status).toBe(200);
   const [storedAgent]=await f.db.select().from(agents).where(eq(agents.id,f.agentId));
   console.log('PU_PAUSE_TRUTH',JSON.stringify({agentId:f.agentId,runId:f.run.id,storedOperation:storedAgent.lifecycleOperation,plus2Elapsed,plus30Elapsed,plus2:{state:plus2.lifecycleState,status:plus2.status,operation:plus2.lifecycleOperation},plus30:{state:plus30.lifecycleState,status:plus30.status,operation:plus30.lifecycleOperation},runStatus:run.body.status,runErrorCode:run.body.errorCode,execution:run.body.execution}));
   expect(plus2).toMatchObject({lifecycleState:'paused',status:'paused'});expect(plus30).toMatchObject({lifecycleState:'paused',status:'paused'});
  }finally{await f.cleanup()}
 },70000);
 it('(b) Resume HTTP while pausing, new person message starts ONE real native run and publishes ONE answer',async()=>{
  const f=await seed();try{
   const pause=await request(f.app).post(`/api/agents/${f.agentId}/pause`).send({});expect(pause.status).toBe(200);
   expect((await f.get()).lifecycleState).toBe('pausing');
   const resume=await request(f.app).post(`/api/agents/${f.agentId}/resume`).send({});expect(resume.status).toBe(200);
   await f.process();const ready=await f.get();console.log('PU_RESUME_TRUTH',JSON.stringify({agentId:f.agentId,state:ready.lifecycleState,status:ready.status}));expect(ready.lifecycleState).toBe('ready');
   const message=await request(f.app).post(`/api/issues/${f.issueId}/comments`).send({body:'Answer this NEW person message once.',clientRequestId:randomUUID()});expect(message.status,JSON.stringify(message.body)).toBe(201);
   await waitForCondition('one provider answer',async()=> (await f.db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),eq(issueComments.authorType,'agent')))).some(c=>c.body.includes('RF5 controlled provider answered')),15000).catch(()=>{});
   await bounded(f.heartbeat.drainActiveRunExecutions(),10000).catch(()=>{});
   const runs=await f.db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId,f.agentId),ne(heartbeatRuns.id,f.run.id)));
   const answers=await f.db.select().from(issueComments).where(and(eq(issueComments.issueId,f.issueId),eq(issueComments.authorType,'agent')));
   console.log('PU_MESSAGE_TRUTH',JSON.stringify({commentId:message.body.id,runs:runs.map(r=>({id:r.id,status:r.status,context:r.contextSnapshot})),answers:answers.map(a=>({id:a.id,runId:a.createdByRunId,body:a.body}))}));
   expect(runs).toHaveLength(1);expect(runs[0].runtimeMode).toBe('native');expect(answers.filter(a=>a.body.includes('RF5 controlled provider answered'))).toHaveLength(1);
  }finally{await f.cleanup()}
 },60000);
});
