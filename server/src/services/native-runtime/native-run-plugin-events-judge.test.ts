import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { agents, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, workAssessments, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../../vendor/paperclip-runner/testing.js";
import { setPluginEventBus } from "../activity-log.js";
import { createPluginEventBus } from "../plugin-event-bus.js";
import { createHeartbeatLifecycle } from "../heartbeat/run-lifecycle.js";
import { createHeartbeatRunState } from "../heartbeat/run-state.js";
import { createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { NativeRunCoordinatorStore } from "./native-run-coordinator-store.js";
import { finalizeNativeRun, recordNativeFinalizationFailure, endSupersededNativeFinalizationRuns, NATIVE_FINALIZATION_SUPERSEDED } from "./native-run-finalizer.js";
import { projectCommittedRun } from "./native-run-projection.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./status-arbiter.js";

// Independent N2/N3 checks from review-fleet-4, retained as behavioral regressions.
// Keep reason: data safety at the PostgreSQL/side-effect boundary (F1-F3, #20991).
// Real PostgreSQL writes and real plugin bus; no publisher mocks.
function eventRunId(event: PluginEvent): unknown {
  const payload = event.payload;
  return typeof payload === "object" && payload !== null && "runId" in payload ? payload.runId : undefined;
}
describe("rf4 runfinished binding bar", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  const bus = createPluginEventBus();
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("rf4-runfinished-"); db = createDb(temporary.connectionString); setPluginEventBus(bus); });
  afterEach(() => { bus.clearPlugin("rf4-judge"); bus.clearPlugin("second-run-consumer"); });
  afterAll(async () => { await db.$client.end(); await temporary.cleanup(); });
  async function fixture(terminal: "succeeded" | "failed" | "cancelled" = "succeeded") {
    const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), runId=randomUUID(), contractId=randomUUID(), runner=randomUUID();
    await db.insert(companies).values({id:companyId,name:"rf4",issuePrefix:companyId.slice(0,8)});
    await db.insert(agents).values({id:agentId,companyId,name:"worker",adapterType:"paperclip_runner"});
    await db.insert(issues).values({id:issueId,companyId,title:"N2/N3",status:"in_progress",assigneeAgentId:agentId});
    await db.insert(completionContracts).values({id:contractId,companyId,issueId,revision:1,schemaVersion:"paperclip.completion-contract.v1",policyVersion:"test",risk:"low",completionAuthority:"agent_claim_policy",incompleteCriteriaPolicy:"preserve_non_terminal",canonicalSha256:contractId,contractJson:{revision:CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,objective:"Finish",criteria:[{id:"objective",requirement:"Complete the task"}]},createdByActorType:"system",createdByActorId:"test"});
    await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,nativeIssueId:issueId,runtimeMode:"native",status:"running",nativeSessionId:runId,runnerInstanceId:runner,completionContractId:contractId,completionContractSha256:contractId,contextSnapshot:{issueId},startedAt:new Date("2026-01-01T00:00:00Z")});
    const store=new NativeRunCoordinatorStore(db,{companyId,agentId,issueId,runId,normalizedSessionId:runId,runnerSourceInstanceId:runner,completionContractId:contractId,completionContractSha256:contractId,completionContractRevision:CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,completionContractCriterionIds:CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.criteria.map(c=>c.criterionId)});
    await store.completeRun({result:CONTROL_PLANE_CONFORMANCE_RESULT,terminal:{...CONTROL_PLANE_CONFORMANCE_TERMINAL,runTerminalState:terminal},callerResultId:runId+":result"});
    const events:PluginEvent[]=[];
    for(const eventType of ["agent.run.finished","agent.run.failed","agent.run.cancelled"] as const) {
      bus.forPlugin("rf4-judge").subscribe(eventType,{companyId},async e=>{if(eventRunId(e)===runId) events.push(e);});
    }
    const dependencies={...createHeartbeatRunState(db),...createHeartbeatRunPreparation(db),issuesSvc:{addComment:vi.fn(),listReviewAttention:vi.fn()},recovery:{escalateStrandedAssignedIssue:vi.fn()},companySkills:{completeTestRunForIssue:vi.fn()},budgets:{getInvocationBlock:vi.fn(async()=>null)},treeControlSvc:{getActivePauseHoldGate:vi.fn(async()=>null)},enqueueWakeup:vi.fn(),getCurrentUserRedactionOptions:vi.fn(async()=>({})),getAgentInvokability:vi.fn(async()=>({invokable:true as const})),emitTerminalAgentTaskRun:vi.fn(),budgetHooks:{}};
    const lifecycle=createHeartbeatLifecycle(db,dependencies);
    const read=async()=> (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId)))[0];
    const coordinator=async()=> (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,runId)))[0];
    const finalize=(writer:Db=db, workspaceFinalizeStatus:"succeeded"|"failed"="succeeded")=>finalizeNativeRun({db:writer,runId,workspaceFinalizeStatus,projectRunStatus:true});
    const project=async(writer:Db=db)=>projectCommittedRun({db:writer,run:await read(),coordinator:await coordinator()});
    return {companyId,agentId,issueId,runId,events,lifecycle,dependencies,read,coordinator,finalize,project};
  }
  const flush=async()=>{await new Promise(resolve=>setTimeout(resolve,25));};
  for(const owner of ["finalizer","projection"] as const) {
    it.each(["succeeded","failed","cancelled"] as const)(`${owner}: one terminal event and no event on repeated same-status recovery (%s)`,async status=>{
      const f=await fixture(status);
      if(owner==="finalizer") await f.finalize();
      else {await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"}); await f.project();}
      expect((await f.read()).status).toBe(status); await flush();
      expect(f.events.map(e=>e.eventType)).toEqual([status==="succeeded"?"agent.run.finished":status==="failed"?"agent.run.failed":"agent.run.cancelled"]);
      await f.finalize(); await f.project(); await flush(); expect(f.events).toHaveLength(1);
    });
    it(`${owner}: does not publish for an already-terminal failed run repaired to accepted success`,async()=>{
      const f=await fixture();
      await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"});
      expect((await f.lifecycle.setRunStatusIfRunning(f.runId,"failed",{finishedAt:new Date(),error:"live completion failed",errorCode:"adapter_failed"})).updated).toBe(true);
      await flush(); expect(f.events.map(e=>e.eventType)).toEqual(["agent.run.failed"]);
      if(owner==="finalizer") await f.finalize(); else await f.project();
      await flush(); console.log("RF4_ALREADY_TERMINAL",owner,(await f.read()).status,f.events.map(e=>e.eventType));
      expect(f.events).toHaveLength(1);
    });
    it(`${owner}: only the first terminal transition publishes, not a historical terminal repair`,async()=>{
      const f=await fixture();
      await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"});
      // A terminal row from before this process started is not a fresh lifecycle end.
      await db.update(heartbeatRuns).set({status:"failed",finishedAt:new Date(),error:"historical failure"})
        .where(eq(heartbeatRuns.id,f.runId));
      if(owner==="finalizer") await f.finalize(); else await f.project();
      expect((await f.read()).status).toBe("succeeded");
      await flush(); expect(f.events).toEqual([]);
    });
    it(`${owner}: transaction-scoped commit publishes once, only after the outer commit`,async()=>{
      const f=await fixture();
      if(owner==="projection") await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"});
      await db.transaction(async tx=>{
        if(owner==="finalizer") await f.finalize(tx as unknown as Db);
        else {
          const [run]=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
          const [coordinator]=await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
          await projectCommittedRun({db:tx as unknown as Db,run,coordinator});
        }
        await flush(); expect(f.events).toEqual([]);
        expect((await f.read()).status).toBe("running");
      });
      await vi.waitFor(()=>expect(f.events).toHaveLength(1));
      expect((await f.read()).status).toBe("succeeded");
      await f.finalize(); await f.project(); await flush(); expect(f.events).toHaveLength(1);
    });
    it(`${owner}: a caught savepoint rollback discards only its publication`,async()=>{
      const f=await fixture();
      if(owner==="projection") await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"});
      await db.transaction(async tx=>{
        await expect(tx.transaction(async nested=>{
          if(owner==="finalizer") await f.finalize(nested as unknown as Db);
          else {
            const [run]=await nested.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
            const [coordinator]=await nested.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
            await projectCommittedRun({db:nested as unknown as Db,run,coordinator});
          }
          throw new Error("discard this savepoint");
        })).rejects.toThrow("discard this savepoint");
      });
      await flush(); expect(f.events).toEqual([]); expect((await f.read()).status).toBe("running");
      await f.finalize(); await f.project();
      await vi.waitFor(()=>expect(f.events).toHaveLength(1));
    });
    it(`${owner}: root transaction forced failure after status write publishes nothing`,async()=>{
      const f=await fixture();
      if(owner==="projection") await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"});
      let tripped=false;
      const writer=new Proxy(db,{get(target,prop,receiver){
        if(prop!=="transaction") return Reflect.get(target,prop,receiver);
        return async (callback:(tx:Db)=>Promise<unknown>)=> target.transaction(async tx=>{
          const result=await callback(tx as unknown as Db);
          const [current]=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
          if(current.status!=="running"){tripped=true;throw new Error("RF4 forced failure after status write");}
          return result;
        });
      }}) as Db;
      if(owner==="finalizer") await f.finalize(writer);
      else await expect(f.project(writer)).rejects.toThrow("RF4 forced failure after status write");
      await flush(); expect(tripped).toBe(true); expect((await f.read()).status).toBe("running"); expect(f.events).toEqual([]);
    });
    it(`${owner}: direct transaction-scoped service call does not leak an event on parent rollback`,async()=>{
      const f=await fixture();
      if(owner==="projection") await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"});
      await expect(db.transaction(async tx=>{
        // Read through tx for this invocation, not through another connection.
        if(owner==="finalizer") await f.finalize(tx as unknown as Db);
        else {
          const [run]=await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId));
          const [coordinator]=await tx.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId));
          await projectCommittedRun({db:tx as unknown as Db,run,coordinator});
        }
        throw new Error("RF4 parent rollback after terminal write");
      })).rejects.toThrow("RF4 parent rollback after terminal write");
      await flush(); expect((await f.read()).status).toBe("running");
      console.log("RF4_ROLLBACK_LEAK",owner,f.events.map(e=>e.eventType)); expect(f.events).toEqual([]);
    });
  }
  it("exhausted workspace finalization emits one failed plugin event",async()=>{
    const f=await fixture();
    for(let i=0;i<3;i++) {
      await recordNativeFinalizationFailure({db,runId:f.runId,projectRunStatus:true,failureScope:"workspace",error:new Error("native_workspace_finalize_failed")});
      if(i<2) { await flush(); expect((await f.read()).status).toBe("running"); expect(f.events).toEqual([]); }
    }
    expect((await f.read()).status).toBe("failed"); await flush();
    console.log("RF4_EXHAUSTED",(await f.coordinator()).phase,f.events.map(e=>e.eventType));
    expect(f.events.map(e=>e.eventType)).toEqual(["agent.run.failed"]);
    await recordNativeFinalizationFailure({db,runId:f.runId,projectRunStatus:true,failureScope:"workspace",error:new Error("native_workspace_finalize_failed")});
    await flush(); expect(f.events).toHaveLength(1);
  });
  it.each(["succeeded","failed","cancelled"] as const)("superseded historical finalizer retirement emits one %s plugin event",async status=>{
    const f=await fixture(status);
    await db.update(heartbeatRuns).set({resultJson:{prpRunTerminalState:status}}).where(eq(heartbeatRuns.id,f.runId));
    await db.update(nativeRunFinalizations).set({phase:"terminal_failure",failureCode:NATIVE_FINALIZATION_SUPERSEDED}).where(eq(nativeRunFinalizations.runId,f.runId));
    expect(await endSupersededNativeFinalizationRuns(db,[f.runId])).toEqual([f.runId]);
    expect((await f.read()).status).toBe(status); await flush();
    expect(f.events.map(e=>e.eventType)).toEqual([status==="succeeded"?"agent.run.finished":status==="failed"?"agent.run.failed":"agent.run.cancelled"]);
    expect(await endSupersededNativeFinalizationRuns(db,[f.runId])).toEqual([]);
    await flush(); expect(f.events).toHaveLength(1);
  });
  it.each(["succeeded","failed","cancelled"] as const)("permanent provider finalization failure publishes the retained %s outcome",async status=>{
    const f=await fixture(status);
    await db.update(heartbeatRuns).set({resultJson:{prpRunTerminalState:status}}).where(eq(heartbeatRuns.id,f.runId));
    await recordNativeFinalizationFailure({db,runId:f.runId,projectRunStatus:true,permanent:true,error:new Error("native_fixture_permanent_failure")});
    expect((await f.read()).status).toBe(status); await flush();
    console.log("RF4_PERMANENT_PROVIDER",status,f.events.map(e=>e.eventType));
    expect(f.events.map(e=>e.eventType)).toEqual([status==="succeeded"?"agent.run.finished":status==="failed"?"agent.run.failed":"agent.run.cancelled"]);
    await recordNativeFinalizationFailure({db,runId:f.runId,projectRunStatus:true,permanent:true,error:new Error("native_fixture_permanent_failure")});
    await flush(); expect(f.events).toHaveLength(1);
  });
  it.each(["permanent", "exhausted", "superseded"] as const)("%s retirement publishes nothing when its outer transaction rolls back",async owner=>{
    const f=await fixture();
    if(owner==="superseded") {
      await db.update(heartbeatRuns).set({resultJson:{prpRunTerminalState:"succeeded"}}).where(eq(heartbeatRuns.id,f.runId));
      await db.update(nativeRunFinalizations).set({phase:"terminal_failure",failureCode:NATIVE_FINALIZATION_SUPERSEDED}).where(eq(nativeRunFinalizations.runId,f.runId));
    }
    await expect(db.transaction(async tx=>{
      const writer=tx as unknown as Db;
      if(owner==="superseded") await endSupersededNativeFinalizationRuns(writer,[f.runId]);
      else for(let i=0;i<(owner==="exhausted"?3:1);i++) await recordNativeFinalizationFailure({db:writer,runId:f.runId,projectRunStatus:true,
        ...(owner==="exhausted"?{failureScope:"workspace" as const}:{permanent:true}),error:new Error("native_fixture_permanent_failure")});
      expect((await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)))[0].status).not.toBe("running");
      await flush(); expect(f.events).toEqual([]);
      throw new Error("retirement rollback");
    })).rejects.toThrow("retirement rollback");
    await flush(); expect((await f.read()).status).toBe("running"); expect(f.events).toEqual([]);
  });
  it("workspace exhaustion preserves a live cancellation and publishes no second terminal event",async()=>{
    const f=await fixture();
    expect((await f.lifecycle.setRunStatusIfRunning(f.runId,"cancelled",{finishedAt:new Date()})).updated).toBe(true);
    await vi.waitFor(()=>expect(f.events).toHaveLength(1));
    for(let i=0;i<3;i++) await recordNativeFinalizationFailure({db,runId:f.runId,projectRunStatus:true,failureScope:"workspace",error:new Error("native_workspace_finalize_failed")});
    expect((await f.read()).status).toBe("cancelled"); await flush();
    expect(f.events.map(e=>e.eventType)).toEqual(["agent.run.cancelled"]);
  });
  it.each((["succeeded","failed","timed_out","cancelled","interrupted"] as const).flatMap(status=>[false,true].map(rollback=>({status,rollback}))))(
    "live native $status waits for its outer transaction (rollback=$rollback)",async ({status,rollback})=>{
    const f=await fixture();
    const transaction=db.transaction(async tx=>{
      const lifecycle=createHeartbeatLifecycle(tx as unknown as Db,f.dependencies);
      expect((await lifecycle.setRunStatusIfRunning(f.runId,status,{finishedAt:new Date()})).updated).toBe(true);
      await flush(); expect(f.events).toEqual([]);
      if(rollback) throw new Error("live rollback");
    });
    if(rollback) { await expect(transaction).rejects.toThrow("live rollback"); await flush(); expect((await f.read()).status).toBe("running"); expect(f.events).toEqual([]); }
    else {
      await transaction;
      await vi.waitFor(()=>expect(f.events.map(e=>e.eventType)).toEqual([status==="succeeded"?"agent.run.finished":status==="cancelled"?"agent.run.cancelled":"agent.run.failed"]));
      expect((await f.read()).status).toBe(status);
      await f.lifecycle.setRunStatus(f.runId,status,{finishedAt:new Date()});
      await flush(); expect(f.events).toHaveLength(1);
    }
  });
  it.each([false,true])("cancel_continuations publishes once after its outer commit (rollback=%s)",async rollback=>{
    const f=await fixture("cancelled"), run=await f.read(), coordinator=await f.coordinator(), assessmentId=randomUUID();
    await db.insert(workAssessments).values({id:assessmentId,companyId:f.companyId,issueId:f.issueId,runId:f.runId,
      contractId:run.completionContractId!,resultId:coordinator.resultId!,triggerKind:"native_result",
      triggerActorCompanyId:f.companyId,priorIssueStatus:"in_progress",priorStatusVersion:0,
      policyVersion:NATIVE_STATUS_ARBITER_POLICY_VERSION,assessmentJson:{source:"plugin-event-cancellation"},inputDigest:assessmentId});
    const apply=(writer:Db)=>commitNativeStatusDecision({db:writer,companyId:f.companyId,issueId:f.issueId,runId:f.runId,
      assessmentId,priorStatus:"in_progress",priorStatusVersion:0,priorDecisionId:null,
      decision:{statusAction:"cancelled",toStatus:"cancelled",reasonCode:"cancellation_issue_authorized",unblockDescriptor:null,
        effects:[{kind:"release_checkout"},{kind:"cancel_continuations"}],policyVersion:NATIVE_STATUS_ARBITER_POLICY_VERSION}});
    const transaction=db.transaction(async tx=>{
      await apply(tx as unknown as Db);
      expect((await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)))[0].status).toBe("cancelled");
      await flush(); expect(f.events).toEqual([]);
      if(rollback) throw new Error("cancellation rollback");
    });
    if(rollback) {
      await expect(transaction).rejects.toThrow("cancellation rollback");
      expect((await f.read()).status).toBe("running"); await flush(); expect(f.events).toEqual([]);
      await apply(db);
    } else await transaction;
    await vi.waitFor(()=>expect(f.events.map(e=>e.eventType)).toEqual(["agent.run.cancelled"]));
    await apply(db); await flush(); expect(f.events).toHaveLength(1);
  });
  it.each(["succeeded","failed","timed_out","cancelled","interrupted"] as const)("live completion maps %s and loses repeated CAS quietly",async status=>{
    const f=await fixture();
    expect((await f.lifecycle.setRunStatusIfRunning(f.runId,status,{finishedAt:new Date()})).updated).toBe(true);
    expect((await f.lifecycle.setRunStatusIfRunning(f.runId,status,{finishedAt:new Date()})).updated).toBe(false);
    await flush(); expect(f.events.map(e=>e.eventType)).toEqual([status==="succeeded"?"agent.run.finished":status==="cancelled"?"agent.run.cancelled":"agent.run.failed"]);
  });
  it("actual concurrent live completion and committed projection publish exactly once",async()=>{
    const f=await fixture(); await finalizeNativeRun({db,runId:f.runId,workspaceFinalizeStatus:"succeeded"});
    await Promise.all([f.project(),f.lifecycle.setRunStatusIfRunning(f.runId,"succeeded",{finishedAt:new Date()})]);
    await flush(); expect(f.events).toHaveLength(1); expect((await f.read()).status).toBe("succeeded");
  });
  it("two independently scoped consumers receive the same committed envelope once, with no cross-company delivery",async()=>{
    const f=await fixture(), second:PluginEvent[]=[], wrongCompany:PluginEvent[]=[];
    bus.forPlugin("second-run-consumer").subscribe("agent.run.finished",{companyId:f.companyId},async event=>{
      if(eventRunId(event)!==f.runId) return;
      expect((await f.read()).status).toBe("succeeded"); second.push(event);
    });
    bus.forPlugin("second-run-consumer").subscribe("agent.run.finished",{companyId:randomUUID()},async event=>{wrongCompany.push(event);});
    await db.transaction(async tx=>{await f.finalize(tx as unknown as Db); await flush(); expect(second).toEqual([]);});
    await vi.waitFor(()=>expect(second).toHaveLength(1));
    expect(second).toEqual(f.events); expect(wrongCompany).toEqual([]);
    await f.finalize(); await f.project(); await flush(); expect(second).toHaveLength(1);
  });
  it("native terminal event equals actual legacy CAS event field by field",async()=>{
    const f=await fixture(); await f.finalize(); await flush(); expect(f.events).toHaveLength(1);
    const native=await f.read(), legacyId=randomUUID(), legacyEvents:PluginEvent[]=[];
    await db.insert(heartbeatRuns).values({id:legacyId,companyId:f.companyId,agentId:f.agentId,runtimeMode:"legacy",status:"running",contextSnapshot:native.contextSnapshot,startedAt:native.startedAt,invocationSource:native.invocationSource,triggerDetail:native.triggerDetail});
    bus.forPlugin("rf4-judge").subscribe("agent.run.finished",{companyId:f.companyId},async e=>{if(eventRunId(e)===legacyId)legacyEvents.push(e);});
    expect((await f.lifecycle.setRunStatusIfRunning(legacyId,"succeeded",{finishedAt:native.finishedAt,error:native.error,errorCode:native.errorCode})).updated).toBe(true);
    await flush(); expect(legacyEvents).toHaveLength(1);
    const legacyPayload=legacyEvents[0].payload;
    if(typeof legacyPayload!=="object" || legacyPayload===null) throw new Error("legacy event payload must be an object");
    expect(f.events[0].payload).toEqual({...legacyPayload,runId:f.runId});
    for(const field of ["eventType","companyId","actorId","actorType","entityType"] as const) expect(f.events[0][field]).toEqual(legacyEvents[0][field]);
    expect(f.events[0].entityId).toBe(f.runId); expect(legacyEvents[0].entityId).toBe(legacyId);
  });
});
