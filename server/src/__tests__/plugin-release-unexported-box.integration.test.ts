import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, plugins, projects, sandboxCreationOperations } from "@paperclipai/db";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { KEPT_UNSTOPPED_BOX_BOUND_MS } from "../services/warm-sandbox-expiry.js";
import { recordSandboxCreationResource } from "../services/sandbox-creation-operations.js";
import { resolvePluginTaskResume } from "../services/environment-task-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external=resolveExternalTestDatabaseUrl("PAPERCLIP_PLUGIN_WARM_TASKS_TEST_DATABASE_URL");
const support=external ? {supported:true} : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("a release never wipes a box holding unexported prepared work",()=>{
 let db:ReturnType<typeof createDb>,stop:()=>Promise<void>;
 beforeAll(async()=>{if(external){await applyPendingMigrations(external);db=createDb(external);stop=()=>db.$client.end({timeout:1});return;}const started=await startEmbeddedPostgresTestDatabase("plugin-release-unexported-box");db=createDb(started.connectionString);stop=started.cleanup;});
 afterAll(async()=>{await stop?.();});
 async function fixture(initialProjects:string[]=[],initialExpiry?:string,deadline?:Date){
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),environmentId=randomUUID(),pluginId=randomUUID();
  let stopOffered=true,runId=randomUUID(),allocation=0,stopped=false,outage=false,releaseFails=false,unavailable=false;
  const calls:string[]=[],dispatched:Array<[string,string]>=[],failures=new Set<string>();
  const releaseMetadata: unknown[] = [];
  let projectIds=[...initialProjects],providerExpiry=initialExpiry;
  const taskExpiries=new Map<string,string|undefined>(),acquireRequests:any[]=[];
  let resumeGate:Promise<void>|undefined,releaseResume:(()=>void)|undefined,resumes=0;
  await db.insert(companies).values({id:companyId,name:"Warm fixture",issuePrefix:`W${companyId.slice(0,7)}`});
  for(const id of initialProjects) await db.insert(projects).values({id,companyId,name:"Authorized project"});
  await db.insert(agents).values({id:agentId,companyId,name:"Codex",adapterType:"paperclip_runner"});
  await db.insert(issues).values({id:issueId,companyId,title:"Warm task",status:"in_progress",assigneeAgentId:agentId});
  await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,invocationSource:"manual",status:"running"});
  const [environment]=await db.insert(environments).values({id:environmentId,name:environmentId,driver:"plugin",status:"active",
   config:{pluginKey:pluginId,driverKey:"tasks",driverConfig:{},runnerLifecycleMode:"warm",runnerIdleTimeoutMs:300000}}).returning();
  await db.insert(plugins).values({id:pluginId,pluginKey:pluginId,packageName:"fixture-warm",version:"1.0.0",status:"ready",manifestJson:{
   capabilities:["environment.drivers.register"],environmentDrivers:[{driverKey:"tasks",supportsTasks:true,warmTaskVersion:1}],
  } as never});
  const workers={isRunning:()=>true,getWorker:()=>({supportedMethods:["environmentTask","environmentAcquireLease","environmentResumeLease","environmentReleaseLease","environmentStopLease","environmentDestroyLease"].filter(m=>stopOffered||m!=="environmentStopLease")}),
   call:async(_id:string,method:string,p:any)=>{
    calls.push(method==="environmentTask" ? p.operation.kind : method);
    if(method==="environmentTask") dispatched.push([p.operation.kind,p.taskId]);
    if(method==="environmentTask" && failures.delete(p.operation.kind)) throw Error(`${p.operation.kind} unavailable`);
    if(method==="environmentAcquireLease") {
     const id=`task-${++allocation}`;taskExpiries.set(id,providerExpiry);acquireRequests.push(p);
     return {providerLeaseId:id,...(providerExpiry ? {expiresAt:providerExpiry}:{}),metadata:{runId:p.runId}};
    }
    if(method==="environmentResumeLease") {if(outage) throw Error("unreachable");
     if(resumeGate){if(++resumes===2)releaseResume!();await resumeGate;}return {providerLeaseId:stopped||unavailable?null:p.providerLeaseId,expiresAt:taskExpiries.get(p.providerLeaseId),metadata:{runId:p.runId}};}
    if(method==="environmentStopLease"||method==="environmentDestroyLease") return {providerLeaseId:p.providerLeaseId,state:method==="environmentStopLease"?"stopped":"destroyed"};
    if(method==="environmentReleaseLease") {releaseMetadata.push(p.leaseMetadata);if(releaseFails) throw Error("release unavailable");return {providerLeaseId:p.providerLeaseId,state:"stopped"};}
    if(p.operation.kind==="status") return {kind:"status",taskId:p.taskId,phase:stopped?"completed":"running",executionStopped:stopped,sessionStateAvailable:stopped,preparationStopped:stopped};
    if(p.operation.kind==="read_state") return {kind:"state",taskId:p.taskId,state:{...p.operation.identity,lifecycle:"ready"}};
    if(p.operation.kind==="stop") stopped=true;
    if(p.operation.kind==="prepare") return {kind:"prepared",taskId:p.taskId,launch:{configurationId:"configuration",requirementsDigest:`sha256:${"a".repeat(64)}`,provider:{}}};
    if(p.operation.kind==="check_project_auth") return {kind:"project_auth",taskId:p.taskId,configurationId:p.operation.configurationId,provider:"openai",allowed:true};
    if(p.operation.kind==="describe") return {kind:"description",taskId:p.taskId,runner:{version:"fixture",digest:`sha256:${"a".repeat(64)}`},warmTaskVersion:1};
    return {kind:"accepted",taskId:p.taskId};
   }} as unknown as PluginWorkerManager;
  const runtime=(orphanCleanupSpoolDir?:string)=>environmentRuntimeService(db,{pluginWorkerManager:workers,orphanCleanupSpoolDir});
  const acquire=()=>runtime().acquireRunLease({companyId,environment:environment as never,issueId,agentId,heartbeatRunId:runId,persistedExecutionWorkspace:null,adapterType:"paperclip_runner",runnerTaskProjectIds:projectIds,requestedExpiresAt:deadline});
  const first=await acquire();
  const identity={runnerInstanceId:"runner",environmentLeaseId:first.lease.id,runId,normalizedSessionId:"session",turnId:"turn",itemId:"item"};
  await runtime().task({companyId,leaseId:first.lease.id,operation:{kind:"check_project_auth",configurationId:"configuration",provider:"openai",projectIds:initialProjects}});
  await runtime().task({companyId,leaseId:first.lease.id,operation:{kind:"submit",preparedLaunchId:"configuration",projectIds:initialProjects,bootstrapTicket:"synthetic",accountIdentity:"account",
   runner:{harness:"codex",protocolMin:1,protocolMax:3,runnerId:identity.runnerInstanceId,leaseId:identity.environmentLeaseId,runId,sessionId:identity.normalizedSessionId,turnId:identity.turnId,itemId:identity.itemId},
   launch:{runnerVersion:"fixture",runnerDigest:`sha256:${"a".repeat(64)}`,maxOutboxBytes:262144,p0ReserveBytes:65536,lifecyclePolicy:{mode:"warm",idleTimeoutMs:300000}}}});
  await runtime().releaseRunLeases(runId,"released",undefined,"keep_running");
  await db.update(heartbeatRuns).set({status:"succeeded"}).where(eq(heartbeatRuns.id,runId));
  return {agentId,issueId,firstRunId:runId,companyId,first,identity,calls,dispatched,runtime,acquire,acquireRequests,releaseMetadata,
   fail(kind:string){failures.add(kind);},unavailable(){unavailable=true;},noStop(){stopOffered=false;},
   setExpiry(next?:string){providerExpiry=next;},
   async nextRun(){runId=randomUUID();await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,invocationSource:"manual",status:"running"});return runId;},
   setProjects(next:string[]){projectIds=next;},stopped(){stopped=true;},failRelease(){releaseFails=true;},restoreRelease(){releaseFails=false;},outage(){outage=true;},
   raceResume(){resumeGate=new Promise<void>(resolve=>{releaseResume=resolve;});}};
 }
 const sha=(c:string)=>c.repeat(64);
 // The cut run's reference: 'prepared' and no final sha, naming lease L on box X.
 function reference(leaseId:string,providerLeaseId:string,finalized=false){
  return {nativeWorkspaceSync:{schema:"paperclip.native-workspace-sync/v3",state:finalized?"finalized":"prepared",descriptorSha256:sha("a"),baselineSha256:sha("b"),
   finalHostSha256:finalized?sha("c"):null,workspaceId:randomUUID(),leaseId,providerLeaseId,remoteCwd:"/workspace",resourceDisposition:"stop_and_retain"}};
 }
 async function cutRun(runId:string,profile:Record<string,unknown>,started=true){
  await db.update(heartbeatRuns).set({status:"cancelled",runtimeMode:"native",runnerProfileJson:profile as never,
   ...(started?{processPid:4242,processGroupId:4242}:{})}).where(eq(heartbeatRuns.id,runId));
 }
 async function oldRow(id:string){return (await db.select().from(environmentLeases).where(eq(environmentLeases.id,id)))[0]!;}
 function expectKept(f:Awaited<ReturnType<typeof fixture>>,row:typeof environmentLeases.$inferSelect,box:string,runIds:string[]){
  expect(f.calls).not.toContain("environmentReleaseLease");
  expect(f.calls).not.toContain("environmentDestroyLease");
  expect(f.calls).toContain("environmentStopLease");
  expect(row.metadata).toMatchObject({unexportedWorkKept:{runIds,providerLeaseId:box},pluginLeaseCleanupMethod:"stop",
   remoteExecutionTermination:{providerLeaseId:box,state:"stopped"}});
 }

 it("(a) a new run whose mounts changed stops and KEEPS the cut run's box (no release)",async()=>{
  const projectId=randomUUID(),f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box));
  await db.insert(projects).values({id:projectId,companyId:f.companyId,name:"Added project"});
  f.setProjects([projectId]);await f.nextRun();
  const next=await f.acquire();
  expect(next.lease.providerLeaseId).not.toBe(box);
  expectKept(f,await oldRow(f.first.lease.id),box,[f.firstRunId]);
 });
 it("(b) a resume that returns no box stops and KEEPS the cut run's box (no release)",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box));
  f.unavailable();await f.nextRun();
  const next=await f.acquire();
  expect(f.calls).toContain("environmentResumeLease");
  expect(next.lease.providerLeaseId).not.toBe(box);
  expectKept(f,await oldRow(f.first.lease.id),box,[f.firstRunId]);
 });
 it("(c) control: a FINALIZED reference releases the old box as today",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box,true));
  f.unavailable();await f.nextRun();
  await f.acquire();
  expect(f.calls).toContain("environmentReleaseLease");
  expect(f.calls).not.toContain("environmentStopLease");
  expect((await oldRow(f.first.lease.id)).metadata?.unexportedWorkKept).toBeUndefined();
 });
 // Authoritative never-launched proof: no startedAt, no accepted runner task on
 // the box, no process ids, no start event. (The fixture submits a task, so a
 // genuinely never-dispatched cut is recorded as runnerTaskDispatched false.)
 async function neverDispatched(leaseId:string){
  await db.update(environmentLeases).set({metadata:sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || '{"runnerTaskDispatched":false}'::jsonb`}).where(eq(environmentLeases.id,leaseId));
 }
 it("(d) a cut with positive never-started proof may be released",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box),false);
  await neverDispatched(f.first.lease.id);
  f.unavailable();await f.nextRun();
  await f.acquire();
  expect(f.calls).toContain("environmentReleaseLease");
  expect(f.calls).not.toContain("environmentStopLease");
 });
 it("(d2) no process ids but an ACCEPTED runner task (runnerTaskDispatched) is not never-launched proof: held",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  expect((await oldRow(f.first.lease.id)).metadata?.runnerTaskDispatched).toBe(true);
  await cutRun(f.firstRunId,reference(f.first.lease.id,box),false);
  f.unavailable();await f.nextRun();
  await f.acquire();
  expectKept(f,await oldRow(f.first.lease.id),box,[f.firstRunId]);
 });
 it("(d3) no process ids and no accepted task but startedAt set is not never-launched proof: held",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box),false);
  await neverDispatched(f.first.lease.id);
  await db.update(heartbeatRuns).set({startedAt:new Date()}).where(eq(heartbeatRuns.id,f.firstRunId));
  f.unavailable();await f.nextRun();
  await f.acquire();
  expectKept(f,await oldRow(f.first.lease.id),box,[f.firstRunId]);
 });
 it("(d') a cut with no process ids but a tool event still holds the box",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box),false);
  await db.insert(heartbeatRunEvents).values({companyId:f.companyId,runId:f.firstRunId,agentId:f.agentId,seq:1,eventType:"tool.execution.started"} as never);
  f.unavailable();await f.nextRun();
  await f.acquire();
  expectKept(f,await oldRow(f.first.lease.id),box,[f.firstRunId]);
 });
 it("(e) a prepared reference on ANOTHER lease row naming the same box holds it",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  const otherRun=randomUUID(),otherLease=randomUUID();
  await db.insert(heartbeatRuns).values({id:otherRun,companyId:f.companyId,agentId:f.agentId,nativeIssueId:f.issueId,invocationSource:"manual",status:"running"});
  await db.insert(environmentLeases).values({id:otherLease,companyId:f.companyId,environmentId:f.first.lease.environmentId,issueId:f.issueId,
   heartbeatRunId:otherRun,status:"released",leasePolicy:"reuse_by_environment",provider:f.first.lease.provider,providerLeaseId:box,metadata:{}});
  await cutRun(otherRun,reference(otherLease,box));
  f.unavailable();await f.nextRun();
  await f.acquire();
  expectKept(f,await oldRow(f.first.lease.id),box,[otherRun]);
 });
 // The plugin driver's stop-only retry (retryPendingSandboxTeardown) is a STOP:
 // it must never call environmentReleaseLease, held box or not.
 async function stopOnlyRetry(f:Awaited<ReturnType<typeof fixture>>,stopOnly=true){
  const box=f.first.lease.providerLeaseId!;
  if(stopOnly) await db.update(environmentLeases).set({metadata:sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({sandboxStopAndRetain:{
   schema:"paperclip.sandbox-stop-and-retain.v1",companyId:f.companyId,runId:f.firstRunId,leaseId:f.first.lease.id,provider:f.first.lease.provider,
   providerLeaseId:box,requestId:randomUUID(),pluginId:f.first.lease.metadata?.pluginId}})}::jsonb`}).where(eq(environmentLeases.id,f.first.lease.id));
  const lease=(await environmentService(db).getLeaseById(f.first.lease.id))!;
  const before=f.calls.length;
  const receipt=await f.runtime().retryPendingSandboxTeardown({environment:null,lease});
  return {box,receipt,calls:f.calls.slice(before)};
 }
 it("(f) a stop-only retry on a box holding a prepared cut run STOPS and keeps it (no release)",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box));
  const r=await stopOnlyRetry(f);
  expect(r.calls).not.toContain("environmentReleaseLease");
  expect(r.calls).not.toContain("environmentDestroyLease");
  expect(r.calls).toContain("environmentStopLease");
  expect(r.receipt).toMatchObject({providerLeaseId:box,state:"stopped"});
  expect((await oldRow(f.first.lease.id)).metadata).toMatchObject({unexportedWorkKept:{runIds:[f.firstRunId],providerLeaseId:box}});
 });
 it("(g) a stop-only retry with NO prepared run still stops, never releases",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box,true));
  const r=await stopOnlyRetry(f);
  expect(r.calls).not.toContain("environmentReleaseLease");
  expect(r.calls).not.toContain("environmentDestroyLease");
  expect(r.calls).toContain("environmentStopLease");
  expect(r.receipt).toMatchObject({providerLeaseId:box,state:"stopped"});
  expect((await oldRow(f.first.lease.id)).metadata?.unexportedWorkKept).toBeUndefined();
 });
 it("(i) MONEY: no provider stop never labels the running box stopped and never releases it; kept with owner + bound + alarm",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box));
  f.noStop();f.unavailable();await f.nextRun();
  const before=Date.now();const next=await f.acquire();
  expect(next.lease.providerLeaseId).not.toBe(box);
  for(const m of ["environmentReleaseLease","environmentDestroyLease","environmentStopLease"]) expect(f.calls).not.toContain(m);
  const row=await oldRow(f.first.lease.id);
  expect(row.status).toBe("retained");expect(row.releasedAt).toBeNull();expect(row.heartbeatRunId).toBe(f.firstRunId);
  expect(row.metadata?.remoteExecutionTermination).toBeUndefined();
  expect(row.metadata?.pluginLeaseCleanupMethod).not.toBe("stop");
  expect(row.metadata).toMatchObject({unexportedWorkKept:{runIds:[f.firstRunId],providerLeaseId:box,providerStop:"unavailable"}});
  expect(row.expiresAt).not.toBeNull();
  expect(row.expiresAt!.getTime()-before).toBeGreaterThanOrEqual(KEPT_UNSTOPPED_BOX_BOUND_MS-60000);
  expect(row.expiresAt!.getTime()-before).toBeLessThanOrEqual(KEPT_UNSTOPPED_BOX_BOUND_MS+60000);
 });
 it("(j) MONEY: a stop-only retry with no provider stop returns NO stop receipt and keeps the held box",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box));
  f.noStop();
  const r=await stopOnlyRetry(f);
  expect(r.receipt).toBeUndefined();
  for(const m of ["environmentReleaseLease","environmentDestroyLease","environmentStopLease"]) expect(r.calls).not.toContain(m);
  const row=await oldRow(f.first.lease.id);
  expect(row.metadata?.remoteExecutionTermination).toBeUndefined();
  expect(row.metadata).toMatchObject({unexportedWorkKept:{runIds:[f.firstRunId],providerLeaseId:box,providerStop:"unavailable"}});
  expect(row.expiresAt).not.toBeNull();
 });
 it("(h) control: a real release-intent retry with a FINALIZED reference releases as today",async()=>{
  const f=await fixture();const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box,true));
  const r=await stopOnlyRetry(f,false);
  expect(r.calls).toContain("environmentReleaseLease");
  expect(r.calls).not.toContain("environmentStopLease");
 });
});
