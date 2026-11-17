import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, issues, nativeRunFinalizations, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()),
  executeNativeSession: provider.execute,
}));

import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readNativeContinuationSource } from "./native-continuation-delivery.js";
import { NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION } from "./status-arbiter.js";
import { heartbeatService } from "../heartbeat.js";
import { requestTaskRetry } from "../task-retry.js";
import { callbacks } from "../../__tests__/helpers/judge-completion-support.js";
import { createHeartbeatRunCompletion } from "../heartbeat/run-completion.js";
import { createHeartbeatRunPreparation } from "../heartbeat/run-preparation.js";
import { getAdapterSessionCodec } from "../heartbeat/run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "../heartbeat/workspaces.js";
import * as usageReceipts from "../usage-receipts.js";
import { issueService } from "../issues.js";

type FailureCode = "pi_output_truncated" | "pi_provider_error" | "pi_rpc_transport_failed" | "pi_provider_refusal";

// Seen on a staging deployment: an OpenCode turn
// failed (its server was killed, or it ended without an answer). The accepted
// result kept the task in_progress and the arbiter scheduled a retry, but the
// dispatcher refused that wake (`chat_control_recovery_proof_unresolved`), so
// the task sat for hours with no owner and no queued work.
describe("native failed-turn continuation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();

  beforeAll(async () => {
    vi.spyOn(usageReceipts,"indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts,"recoverPendingRunUsageReceipts").mockResolvedValue([]);
    temporary = await startEmbeddedPostgresTestDatabase("native-failed-turn-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({id:"board-user",name:"Judge",email:"judge@example.test",createdAt:new Date(),updatedAt:new Date()});
    await db.insert(companies).values({ id: companyId, name: "Native failed turn", issuePrefix: "NFT" });
    await db.insert(agents).values({ id: agentId, companyId, name: "OpenCode agent", status: "active", adapterType: "paperclip_runner", runtimeConfig:{heartbeat:{maxConcurrentRuns:1}}, adapterConfig: { provider: "pi_rpc", model: "paperclip/gateway/claude-fable-5-2", piRpcThinkingLevel:"xhigh" } });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "member" });
  });
  afterAll(async () => { await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end(); await temporary?.cleanup(); });

  async function failTurn(issueId: string, code: FailureCode, context: Record<string, unknown> = {}, dispatchedFrom?: string, existingRunId?: string) {
    const runId = existingRunId ?? randomUUID();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    // A dispatched continuation carries the dispatcher's own receipt for its intent.
    const [receipt] = dispatchedFrom && !existingRunId ? await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "issue_status_changed", status: "claimed", requestedByActorType: "system",
      requestedByActorId: `native-status-wake-dispatch:${dispatchedFrom}`, payload: { issueId } }).returning() : [];
    const [run] = existingRunId ? await db.update(heartbeatRuns).set({status:"running",runtimeMode:"native"}).where(eq(heartbeatRuns.id,existingRunId)).returning() : await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, responsibleUserId: "board-user", invocationSource: "automation", triggerDetail: "system", wakeupRequestId: receipt?.id ?? null, contextSnapshot: { issueId, ...context } }).returning();
    if (receipt) await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receipt.id));
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const completionInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "pi_rpc", model: "paperclip/gateway/claude-fable-5-2", piRpcThinkingLevel:"xhigh" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Review the PR.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "pi_rpc", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completionInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId,
      turnId: native.turnId, sourceInstanceId: native.runnerInstanceId, sourceEventId: "turn-terminal", sourceSeq: 1,
      sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: code === "pi_provider_error"
        ? { status: "failed", error: { code, message: "Anthropic performed an unsupported mid-output model fallback", opencodeFailure: { kind: "server_exited", signal: "SIGKILL", connectionError: "ECONNREFUSED" } } }
        : { status: "failed", error: { code:code === "pi_provider_refusal" ? "pi_provider_error" : code, message: code === "pi_output_truncated" ? "Pi's final assistant response reached its output limit." : code === "pi_provider_refusal" ? "Provider refused this request" : "EOF mid-thinking", recoverable:false } },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completionInput.revision } };
    const openInput = { identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock" as const, sourceInstanceId: native.runnerInstanceId };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun(openInput);
      if(code==="pi_provider_error" && context.judgeMidAnswer===true) await options.controlPlane.appendEvent({...event,sourceEventId:"partial-answer",sourceSeq:1,eventType:"item.delta",itemId:native.turnId+":pi-message:1:block:0",payload:{kind:"agentMessage",channel:"final",text:"A real stored partial answer before provider failure."}} as PrpEvent);
      await options.controlPlane.appendEvent({...event,sourceSeq:code==="pi_provider_error" && context.judgeMidAnswer===true?2:1});
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-provider-session", driverKind: execution.session.driverKind, driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: {
      descriptor: async () => { throw new Error("Unexpected provider call"); },
      openSession: async () => { throw new Error("Unexpected provider call"); },
    } });
    await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    const [failedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(failedRun.status).toBe("failed");
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    return { runId, decision, nativeSessionId:native.normalizedSessionId,storedStatus:failedRun.status,storedErrorCode:failedRun.errorCode,storedError:failedRun.error,providerFailureCode:code,providerInput:execution.provider };
  }

  async function completePublication(runId:string) {
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,runId));
    const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
    const issueId=run.nativeIssueId!;const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));
    const deps=callbacks(db,true);deps.issuesSvc.addComment.mockImplementation(issueService(db).addComment);
    await createHeartbeatRunCompletion(db,deps).completeRun({
      run,agent,issueId,issueRef:issue,signal:new AbortController().signal,
      output:{handle:{store:"local_file",logRef:"judge"},outputProgressState:{pending:{bytes:0}},flushOutputProgress:async()=>{},stdoutExcerpt:"",stderrExcerpt:""},
      session:{runtimeForAdapter:{sessionId:null,sessionDisplayId:null},previousSessionParams:null,taskKey:issueId,configuredModel:"paperclip/gateway/claude-fable-5-2",sessionConfigMetadata:await buildEffectiveRunSessionConfigMetadata({adapterType:agent.adapterType,effectiveAdapterConfig:agent.adapterConfig,agentRuntimeConfig:{},issueOverrides:null,workspaceConfig:null,environment:null,environmentEnv:null,projectEnv:null,routineEnv:null,runtimeSkills:[]})},
      readFailureReportSecrets:()=>[],adapterResult:{nativeFinalization:{terminal:{runTerminalState:"failed"}},exitCode:1,signal:null,timedOut:false,sessionId:"fixture-provider-session",sessionParams:{sessionId:"fixture-provider-session"},errorCode:"adapter_failed",errorMessage:"Pi's final assistant response reached its output limit.",resultJson:run.resultJson??{}},
      sessionCodec:getAdapterSessionCodec(agent.adapterType),taskSessionForRun:null,sessionCompaction:{rotate:false,reason:null},configFreshnessResultMetadata:{version:1},runLedgerScope:{},currentUserRedactionOptions:{enabled:false},providerTraceCapture:false,onProviderTraceFinalized:()=>{},issueContext:await createHeartbeatRunPreparation(db).getIssueExecutionContext(companyId,issueId),onLog:async(stream,text)=>{console.log("JUDGE PUBLICATION LOG",stream,text)}
    });
  }

  const issueWakes = async (issueId: string) => (await db.select().from(agentWakeupRequests)
    .where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId);


  it("JUDGE report-only cap NEXT and Retry conversation identity",async()=>{
    const {selectPiConversation}=await import("./pi-conversation-record.js");
    const {resolveRunAssigneeAdapterOverrides}=await import("../thinking-cap-stop.js");
    const issueId=randomUUID();await db.insert(issues).values({id:issueId,companyId,title:"Report cap session replay",status:"in_progress",assigneeAgentId:agentId,responsibleUserId:"board-user"});
    const [run]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",runtimeMode:"native",nativeIssueId:issueId,responsibleUserId:"board-user",contextSnapshot:{issueId}}).returning();
    const boundary={provider:"pi_rpc",cwd:"/tmp",workspaceId:null,trust:"judge-trust"};
    const first=await selectPiConversation(db,{companyId,agentId,issueId,runId:run.id,boundary});
    await db.update(heartbeatRuns).set({nativeSessionId:first.id}).where(eq(heartbeatRuns.id,run.id));
    await failTurn(issueId,"pi_output_truncated",{},undefined,run.id);
    const next=[];
    for(const wakeReason of ["issue_commented","task_retry"]){
      const [r]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"running",runtimeMode:"native",nativeIssueId:issueId,responsibleUserId:"board-user",contextSnapshot:{issueId,wakeReason}}).returning();
      const selected=await selectPiConversation(db,{companyId,agentId,issueId,runId:r.id,boundary});
      const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
      const overrides=await resolveRunAssigneeAdapterOverrides(db,{companyId,runId:r.id,agent,issueContext:null});
      next.push({wakeReason,selectedId:selected.id,sameConversation:selected.id===first.id,overrides,storedLevel:agent.adapterConfig.piRpcThinkingLevel});
      expect(selected.id).toBe(first.id);
      await db.update(heartbeatRuns).set({status:"failed",finishedAt:new Date()}).where(eq(heartbeatRuns.id,r.id));
    }
    console.log("JUDGE REPORT NEXT RETRY",JSON.stringify({capRunId:run.id,capConversation:first.id,next,note:"identity selector evidence; not an observed provider session event"}));
  },120000);
  it.each(["pi_output_truncated","pi_provider_error","pi_rpc_transport_failed","pi_provider_refusal"] as const)("JUDGE real scheduler %s",async(code)=>{
    const issueId=randomUUID();
    await db.insert(issues).values({id:issueId,companyId,title:"Real scheduling cut",status:"in_progress",workMode:"standard",assigneeAgentId:agentId,createdByUserId:"board-user",responsibleUserId:"board-user"});
    // Hold the executor slot so the real wakeup's persisted input is readable.
    const hold=randomUUID();
    await db.insert(heartbeatRuns).values({id:hold,companyId,agentId,status:"running",contextSnapshot:{issueId:randomUUID()}});
    const first=await failTurn(issueId,code,{judgeMidAnswer:code==="pi_provider_error"});
    const heartbeat=heartbeatService(db);
    const dispatch=await heartbeat.dispatchPendingNativeStatusWakeups({companyId});
    const all=(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agentId))).filter(r=>r.contextSnapshot?.issueId===issueId);
    const next=all.filter(r=>r.id!==first.runId);
    const wakes=await issueWakes(issueId);
    let projectedProviderInput:unknown=null;
    if(next[0]) {
      const {resolveRunAssigneeAdapterOverrides}=await import("../thinking-cap-stop.js");
      const {projectPaperclipRunnerTaskConfig,resolvePaperclipRunnerNativeProviderInput}=await import("./provider-profile.js");
      const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
      const overrides=await resolveRunAssigneeAdapterOverrides(db,{companyId,runId:next[0].id,agent,issueContext:null});
      const config=projectPaperclipRunnerTaskConfig("pi_rpc",agent.adapterConfig,overrides?.adapterConfig??{});
      projectedProviderInput=resolvePaperclipRunnerNativeProviderInput({backend:"pi_rpc",adapterConfig:config});
    }
    console.log("JUDGE SCHEDULE",JSON.stringify({code,first,dispatch,projectedProviderInput,next:next.map(r=>({id:r.id,status:r.status,retryOfRunId:r.retryOfRunId,context:r.contextSnapshot})),wakes}));
    if(code==="pi_provider_refusal") expect.soft(next,"provider refusal must have ZERO automatic sends").toHaveLength(0);
    else {
      expect.soft(next).toHaveLength(1);
      expect.soft(next[0]?.contextSnapshot?.source,"must not use generic status-decision retry").not.toBe("native_status_decision");
      if(code==="pi_output_truncated") expect.soft(next[0]?.contextSnapshot?.forceFreshSession,"cap recovery must be fresh").toBe(true);
    }
    await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,hold));
    await heartbeat.drainActiveRunExecutions();
  },120000);
  it("JUDGE live vii provider error then exhausted cap",async()=>{
    const issueId=randomUUID();
    await db.insert(issues).values({id:issueId,companyId,title:"Live vii",status:"in_progress",workMode:"standard",assigneeAgentId:agentId,createdByUserId:"board-user",responsibleUserId:"board-user"});
    const hold=randomUUID();await db.insert(heartbeatRuns).values({id:hold,companyId,agentId,status:"running",contextSnapshot:{issueId:randomUUID()}});
    const first=await failTurn(issueId,"pi_provider_error");const heartbeat=heartbeatService(db);
    await heartbeat.dispatchPendingNativeStatusWakeups({companyId});
    const intent=(await issueWakes(issueId)).find(w=>w.requestedByActorId==="native-status-committer")!;
    const successor=(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agentId))).find(r=>r.id!==first.runId&&r.contextSnapshot?.issueId===issueId)!;
    await db.update(heartbeatRuns).set({status:"failed",finishedAt:new Date()}).where(eq(heartbeatRuns.id,successor.id));
    await db.update(issues).set({status:"in_progress",executionRunId:null,checkoutRunId:null}).where(eq(issues.id,issueId));
    const second=await failTurn(issueId,"pi_output_truncated",{},undefined,successor.id);
    await db.update(heartbeatRuns).set({retryOfRunId:first.runId}).where(eq(heartbeatRuns.id,second.runId));
    const {readThinkingCapStop,thinkingCapStopCandidate}=await import("../thinking-cap-stop.js");
    const cap=await readThinkingCapStop(db,{companyId,runId:second.runId});
    const note=cap?thinkingCapStopCandidate(cap):null;
    await heartbeat.dispatchPendingNativeStatusWakeups({companyId});
    const [task]=await db.select().from(issues).where(eq(issues.id,issueId));
    const {issueService}=await import("../issues.js");
    await completePublication(second.runId);
    const comments=await db.select().from(issueComments).where(eq(issueComments.issueId,issueId));
    const [secondReadback]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,second.runId));
    console.log("JUDGE LIVE VII",JSON.stringify({first,successor,second,secondReadback,cap,note,task,comments,wakes:await issueWakes(issueId)}));
    expect.soft(second.decision.reasonCode).toBe("native_run_failed_continuation_exhausted");
    expect.soft(comments.map(c=>c.body).join(""),"must NOT claim continuing when exhausted").not.toContain("continuing");
    expect.soft(comments,"one real completion note").toHaveLength(1);
    expect.soft(task.unblockDescriptor).not.toBeNull();
    const beforeRetry=(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agentId))).filter(r=>r.contextSnapshot?.issueId===issueId);
    expect.soft(beforeRetry,"exactly source + ONE automatic successor; no third automatic run").toHaveLength(2);
    const retry=await requestTaskRetry({db,companyId,issueId,actorId:"board-user",actorSource:"session",idempotencyKey:randomUUID(),observedRunId:second.runId});
    expect.soft(retry).toMatchObject({accepted:true,stale:false});
    if(retry.accepted) await heartbeat.resumeTaskRetry(companyId,retry.requestId!);
    const manual=(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,agentId))).filter(r=>r.contextSnapshot?.taskRetryRequestId===retry.requestId);
    console.log("JUDGE REAL RETRY",JSON.stringify({beforeAutomaticRunCount:beforeRetry.length,retry,runs:manual}));
    expect.soft(manual).toHaveLength(1);
    await db.update(heartbeatRuns).set({status:"succeeded",finishedAt:new Date()}).where(eq(heartbeatRuns.id,hold));
    await heartbeat.drainActiveRunExecutions();
  },120000);
});
