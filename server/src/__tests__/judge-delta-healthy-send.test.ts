import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, executionWorkspaces, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { describe, expect, it } from "vitest";
import { agentRunWritesRevoked, assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { loadAgentRunAuthentication } from "../middleware/agent-run-authentication.js";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { requestTaskRetry } from "../services/task-retry.js";
import * as nativeExecutor from "../services/native-runtime/native-session-executor.js";
import { REMOTE_RUNNER_SUPERVISION_EXHAUSTED, REMOTE_RUNNER_SUPERVISION_EXHAUSTED_ACTION } from "../services/native-runtime/remote-runner-recovery-diagnostics.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";

/** Only the provider is substituted. The real comment delivery, wake queue,
 * admission, native executor, authority readers and comment consumer run. */
function answeringBackend(db: ReturnType<typeof createDb>, beforeTurn: (runId: string) => Promise<void>):
  NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity, sourceInstanceId = "";
    const turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity, capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn: async () => { await beforeTurn(identity.runId); const turnId = randomUUID(); turn.resolve(turnId); return { turnId }; },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq, runId: identity.runId,
          normalizedSessionId: identity.sessionId, turnId, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "One admitted answer." });
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "supervision-test", identity,
        providerSessionId: "provider-test", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, execution.binding.runId));
        sourceInstanceId = run!.runnerInstanceId!;
        return { kind: "mock", name: "supervision-admission", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    return backend;
  };
}

describe("JUDGE healthy running Send",()=>{
 const fixture=nativeRestartFixture({});
 it("queues a second real person message without superseding the healthy writer",async()=>{
  const {companyId,agentId,temporary}=fixture.current;const db=createDb(temporary.connectionString,{maxConnections:6});
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();const executions:string[]=[];
  const hb=heartbeatService(db,{nativeSessionBackendFactory:answeringBackend(db,async runId=>{executions.push(runId);if(executions.length===1){entered.resolve();await release.promise;}})});
  try{
   const userId=randomUUID();await db.insert(authUsers).values({id:userId,name:"Healthy Send judge",email:`${userId}@example.test`,createdAt:new Date(),updatedAt:new Date()});await db.insert(companyMemberships).values({companyId,principalType:"user",principalId:userId,status:"active",membershipRole:"owner"});
   await db.update(agents).set({status:"idle",adapterConfig:{provider:"codex",lifecycleMode:"per_turn"},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:1}}}).where(eq(agents.id,agentId));await instanceSettingsService(db).updateExperimental({enableAgentChat:true,enableNativeRunner:true});
   const [issue]=await db.insert(issues).values({companyId,title:"Healthy queued Send",status:"in_progress",assigneeAgentId:agentId,responsibleUserId:userId,conversationAgentId:agentId,conversationUserId:userId,conversationState:"active"}).returning();
   await issueService(db).addComment(issue.id,"FIRST PERSON MESSAGE",{userId},{clientRequestId:randomUUID()});await deliverConversationComments(db,issue,hb.wakeup);
   await waitForCondition("first provider entry",()=>executions.length===1,30000);
   const sourceId=executions[0];await issueService(db).addComment(issue.id,"SECOND WHILE HEALTHY",{userId},{clientRequestId:randomUUID()});await deliverConversationComments(db,issue,hb.wakeup);
   const [source]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,sourceId));const actions=await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId,issue.id));
   await appendFile(`${process.env.TASK_OUT}/healthy-queued.jsonl`,JSON.stringify({sourceId,issueId:issue.id,source,actions,executions:[...executions]})+"\n");
   expect(source.status).toBe("running");expect(agentRunWritesRevoked(source)).toBe(false);expect(actions).toHaveLength(0);expect(executions).toHaveLength(1);
   release.resolve();await waitForCondition("all queued messages settle",()=>hb.getTaskDrainStatus().quiescent,30000);
   const runs=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId,issue.id));
   expect(agentRunWritesRevoked(runs.find(run=>run.id===sourceId))).toBe(false);
   await appendFile(`${process.env.TASK_OUT}/healthy-queued.jsonl`,JSON.stringify({sourceId,issueId:issue.id,runs,executions})+"\n");
  }finally{release.resolve();await hb.drainActiveRunExecutions();await nativeExecutor.closeIdleWarmNativeSessionsForRestart();await db.$client.end();}
 },60000);
});
