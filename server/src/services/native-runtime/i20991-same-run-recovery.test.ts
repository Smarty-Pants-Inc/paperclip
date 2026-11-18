import { recoverLegacyUnsafeWorkspaceExports } from "./native-workspace-export-recovery.js";
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
  it("review: same-run workspace recovery must not publish a second lifecycle end",async()=>{
    const f=await fixture();
    const failureCode="native_workspace_sync_out_unsafe_archive";
    expect((await f.lifecycle.setRunStatusIfRunning(f.runId,"failed",{
      finishedAt:new Date(), nativePhase:"terminal_failure", errorCode:failureCode,
      error:"Historical rejected archive needs finalization recovery"
    })).updated).toBe(true);
    await vi.waitFor(()=>expect(f.events.map(e=>e.eventType)).toEqual(["agent.run.failed"]));
    await db.update(issues).set({status:"blocked"}).where(eq(issues.id,f.issueId));
    await db.update(nativeRunFinalizations).set({phase:"terminal_failure",failureCode,
      leaseOwner:null,leaseExpiresAt:null}).where(eq(nativeRunFinalizations.runId,f.runId));
    await recoverLegacyUnsafeWorkspaceExports(db,[f.runId]);
    expect((await f.read()).status).toBe("running");
    await f.finalize();
    expect((await f.read()).status).toBe("succeeded");
    await flush();
    process.stdout.write("REVIEW_SAME_RUN_RECOVERY "+JSON.stringify({runId:f.runId,status:(await f.read()).status,events:f.events.map(e=>e.eventType)})+"\n");
    expect(f.events.map(e=>e.eventType)).toEqual(["agent.run.failed"]);
  });
});
