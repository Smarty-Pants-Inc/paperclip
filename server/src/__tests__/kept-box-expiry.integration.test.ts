import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issueComments, issueRecoveryActions, issues, plugins, projects, sandboxCreationOperations } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "../services/heartbeat.ts";
import type { KeptBoxExport } from "../services/environment-runtime.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { environmentService } from "../services/environments.js";
import { KEPT_UNSTOPPED_BOX_BOUND_MS } from "../services/warm-sandbox-expiry.js";
import { recordSandboxCreationResource } from "../services/sandbox-creation-operations.js";
import { resolvePluginTaskResume } from "../services/environment-task-runtime.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const external=resolveExternalTestDatabaseUrl("PAPERCLIP_PLUGIN_WARM_TASKS_TEST_DATABASE_URL");
const support=external ? {supported:true} : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("a kept unstopped box: expiry exports+reads back then releases; its alarm goes to the operator log, never the person's chat",()=>{
 let db:ReturnType<typeof createDb>,stop:()=>Promise<void>;
 beforeAll(async()=>{if(external){await applyPendingMigrations(external);db=createDb(external);stop=()=>db.$client.end({timeout:1});return;}const started=await startEmbeddedPostgresTestDatabase("kept-box-expiry");db=createDb(started.connectionString);stop=started.cleanup;});
 afterAll(async()=>{await stop?.();});
 async function fixture(initialProjects:string[]=[],initialExpiry?:string,deadline?:Date,keptBoxExport?:KeptBoxExport){
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
  const runtime=(orphanCleanupSpoolDir?:string)=>environmentRuntimeService(db,{pluginWorkerManager:workers,orphanCleanupSpoolDir,keptBoxExport});
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

 // The person case: the box holding the cut turn's only copy cannot be stopped
 // (no provider stop), so the release guard keeps it retained + owned + bounded.
 async function keptBox(exporter?:KeptBoxExport){
  const f=await fixture([],undefined,undefined,exporter);const box=f.first.lease.providerLeaseId!;
  await cutRun(f.firstRunId,reference(f.first.lease.id,box));
  f.noStop();f.unavailable();await f.nextRun();
  await f.acquire();
  const row=await oldRow(f.first.lease.id);
  expect(row.status).toBe("retained");
  expect(row.metadata).toMatchObject({unexportedWorkKept:{providerStop:"unavailable"}});
  return {f,box,row};
 }
 async function pastExpiry(leaseId:string){
  await db.update(environmentLeases).set({expiresAt:new Date(Date.now()-60_000)}).where(eq(environmentLeases.id,leaseId));
 }
 // The real reaper tick (heartbeat sweepPendingCleanupLeases) is the sweep.
 async function tick(f:Awaited<ReturnType<typeof fixture>>){
  await heartbeatService(db,{environmentRuntime:f.runtime()}).sweepPendingCleanupLeases({backoffMs:0});
 }
 // The chat shows NOTHING: no recovery action/card, no comment, no activity on the task.
 async function expectChatSilent(issueId:string){
  expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId,issueId))).toEqual([]);
  expect(await db.select().from(issueComments).where(eq(issueComments.issueId,issueId))).toEqual([]);
  expect((await db.select().from(activityLog).where(eq(activityLog.entityId,issueId))).filter(a=>/kept_box/.test(a.action))).toEqual([]);
 }
 // The operator path: the structured alarm log line (no operator page route exists in the server).
 const errorSpy=vi.spyOn(logger,"error"),fatalSpy=vi.spyOn(logger,"fatal");
 function alarms(spy:typeof errorSpy|typeof fatalSpy,alarm:string,leaseId:string){
  return spy.mock.calls.map(c=>c[0] as any).filter(o=>o&&typeof o==="object"&&o.alarm===alarm&&o.leaseId===leaseId);
 }
 // A stand-in for resumeNativeWorkspaceSync's effect: the server copy is written
 // and the run's reference is finalized with its final host sha.
 function exporter(calls:string[],mode:"ok"|"throws"|"no_readback"|"no_sha"):KeptBoxExport{
  return async({db:d,runId})=>{
   calls.push(`export:${runId}`);
   if(mode==="throws") throw Error("sandbox unreachable");
   if(mode==="no_readback") return true;
   const [run]=await d.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
   const ref=(run!.runnerProfileJson as any).nativeWorkspaceSync;
   await d.update(heartbeatRuns).set({runnerProfileJson:{...(run!.runnerProfileJson as any),nativeWorkspaceSync:{...ref,state:"finalized",finalHostSha256:mode==="no_sha"?null:sha("c")}} as never}).where(eq(heartbeatRuns.id,runId));
   return true;
  };
 }

 it("(1a) EXPIRY ACTS: past expiresAt the work is exported, read back (final sha), THEN the box is released",async()=>{
  const calls:string[]=[];
  const {f,box}=await keptBox(exporter(calls,"ok"));
  await pastExpiry(f.first.lease.id);
  const before=f.calls.length;
  await tick(f);
  // exported before any release
  expect(calls).toEqual([`export:${f.firstRunId}`]);
  const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.firstRunId));
  expect((run!.runnerProfileJson as any).nativeWorkspaceSync).toMatchObject({state:"finalized",finalHostSha256:sha("c"),providerLeaseId:box});
  expect(f.calls.slice(before)).toContain("environmentReleaseLease");
  const row=await oldRow(f.first.lease.id);
  expect(row.status).toBe("released");
  expect(row.metadata).toMatchObject({keptBoxExported:{runIds:[f.firstRunId]}});
 });
 it("(1b) export FAILS at expiry: box KEPT (not released), bound extended, ONE louder second alarm on the task card",async()=>{
  const calls:string[]=[];
  const {f}=await keptBox(exporter(calls,"throws"));
  await pastExpiry(f.first.lease.id);
  const before=f.calls.length;const t0=Date.now();
  await tick(f);
  expect(calls).toEqual([`export:${f.firstRunId}`]);
  for(const m of ["environmentReleaseLease","environmentDestroyLease"]) expect(f.calls.slice(before)).not.toContain(m);
  const row=await oldRow(f.first.lease.id);
  expect(row.status).toBe("retained");
  expect(row.metadata).toMatchObject({unexportedWorkKept:{providerStop:"unavailable",expiryExportFailed:{reason:"export_failed"}}});
  expect(row.expiresAt!.getTime()-t0).toBeGreaterThanOrEqual(KEPT_UNSTOPPED_BOX_BOUND_MS-60000);
  const second=alarms(fatalSpy,"kept_box_export_failed",f.first.lease.id);
  expect(second).toHaveLength(1);
  expect(second[0]).toMatchObject({providerLeaseId:f.first.lease.providerLeaseId,runIds:[f.firstRunId],companyId:f.companyId});
  expect(second[0].expiresAt).toBe(row.expiresAt!.toISOString());
  await expectChatSilent(f.issueId);
  // A second tick inside the new bound does nothing more: no repeat alarm, no release.
  await tick(f);
  expect(calls).toHaveLength(1);
  expect(alarms(fatalSpy,"kept_box_export_failed",f.first.lease.id)).toHaveLength(1);
 });
 it.each(["no_readback","no_sha"] as const)("(1b') an export that does not READ BACK finalized with a final sha is a failure: kept + second alarm, never released: %s",async mode=>{
  const calls:string[]=[];
  const {f}=await keptBox(exporter(calls,mode));
  await pastExpiry(f.first.lease.id);
  const before=f.calls.length;
  await tick(f);
  expect(f.calls.slice(before)).not.toContain("environmentReleaseLease");
  const row=await oldRow(f.first.lease.id);
  expect(row.status).toBe("retained");
  expect(row.metadata).toMatchObject({unexportedWorkKept:{expiryExportFailed:{reason:"export_not_read_back"}}});
  expect(alarms(fatalSpy,"kept_box_export_failed",f.first.lease.id)).toHaveLength(1);
  await expectChatSilent(f.issueId);
 });
 it("(1c) control: a kept box BEFORE its bound is untouched by the tick",async()=>{
  const calls:string[]=[];
  const {f}=await keptBox(exporter(calls,"ok"));
  await tick(f);
  expect(calls).toEqual([]);
  expect((await oldRow(f.first.lease.id)).status).toBe("retained");
 });
 it("(2) ALARM goes to the OPERATOR path (structured log alarm=kept_box_still_running), once per box; the chat shows NOTHING",async()=>{
  const {f,box}=await keptBox();
  const first=alarms(errorSpy,"kept_box_still_running",f.first.lease.id);
  expect(first).toHaveLength(1);
  const kept=await oldRow(f.first.lease.id);
  expect(first[0]).toMatchObject({companyId:f.companyId,providerLeaseId:box,runIds:[f.firstRunId],expiresAt:kept.expiresAt!.toISOString()});
  expect(JSON.stringify(first[0])).not.toMatch(/\/workspace/);
  expect(kept.metadata).toMatchObject({keptBoxAlarm:{kept:expect.any(String),providerLeaseId:box}});
  await expectChatSilent(f.issueId);
  // A stop-only retry on the same box keeps it again (stopOnlyPluginRunLease -> keepUnstoppedBox).
  await db.update(environmentLeases).set({metadata:sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({sandboxStopAndRetain:{
   schema:"paperclip.sandbox-stop-and-retain.v1",companyId:f.companyId,runId:f.firstRunId,leaseId:f.first.lease.id,provider:f.first.lease.provider,
   providerLeaseId:box,requestId:randomUUID(),pluginId:f.first.lease.metadata?.pluginId}})}::jsonb`}).where(eq(environmentLeases.id,f.first.lease.id));
  const lease=(await environmentService(db).getLeaseById(f.first.lease.id))!;
  const boundBefore=(await oldRow(f.first.lease.id)).expiresAt!.getTime();
  await new Promise(r=>setTimeout(r,20));
  const keepsBefore=(await oldRow(f.first.lease.id)).metadata?.unexportedWorkKept as any;
  await f.runtime().retryPendingSandboxTeardown({environment:null,lease});
  // The keep really ran again (fresh keep timestamp) ...
  expect(((await oldRow(f.first.lease.id)).metadata?.unexportedWorkKept as any).at).not.toBe(keepsBefore.at);
  // The bound never slides on a repeated keep: the expiry always comes.
  expect((await oldRow(f.first.lease.id)).expiresAt!.getTime()).toBe(boundBefore);
  expect(alarms(errorSpy,"kept_box_still_running",f.first.lease.id)).toHaveLength(1);
  await expectChatSilent(f.issueId);
 });
});
