import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, authUsers, companyMemberships, createDb, heartbeatRuns, issueComments, issues, providerTraceRecords } from "@paperclipai/db";
import type { NativeRunIdentity, NativeSession, NativeSessionBackend, PrpEvent } from "@paperclipai/paperclip-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatService, type HeartbeatServiceOptions } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as nativeExecutor from "../services/native-runtime/native-session-executor.js";
import { nativeRestartFixture, waitForCondition } from "./helpers/native-restart-fixture.js";
import { getRecoveryPostgresSupport } from "./helpers/recovery-postgres-fixture.js";

import { loadAgentRunAuthentication } from "../middleware/agent-run-authentication.js";
import { assertAgentRunWriteAllowed, agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile } from "node:fs/promises";
import { nativeRunFinalizations } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { deliverConversationComments } from "../services/agent-conversations.js";
function completingBackend(db: ReturnType<typeof createDb>): NonNullable<HeartbeatServiceOptions["nativeSessionBackendFactory"]> {
  return execution => {
    let identity: NativeRunIdentity;
    let sourceInstanceId = "";
    const turn = Promise.withResolvers<string>();
    const capabilities = { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
    const session: NativeSession = {
      identity: () => identity,
      capabilities: async () => capabilities,
      attachRun: async input => { identity = input.identity; },
      startTurn: async () => { executions.push(identity.runId); const turnId = randomUUID(); turn.resolve(turnId); return { turnId }; },
      async *events() {
        const turnId = await turn.promise;
        const event = (sourceSeq: number, eventType: PrpEvent["eventType"], payload: Record<string, unknown>): PrpEvent => ({
          schema: "paperclip.prp.event.v1", sourceKind: "runner", sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${identity.runId}:${sourceSeq}`, sourceSeq,
          runId: identity.runId, normalizedSessionId: identity.sessionId, turnId,
          schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), eventType, payload,
        });
        yield event(1, "turn.started", {});
        yield event(2, "item.completed", { kind: "agentMessage", channel: "final", text: "Done." });
        yield event(3, "turn.completed", { status: "completed" });
      },
      result: async () => null,
      snapshot: async () => ({ backendKind: "mock", sessionId: "trace-session", identity,
        providerSessionId: "trace-provider-session", cursor: null, activeTurnId: null, pendingRuntimeRequests: [], lineage: [] }),
      close: async () => {},
    };
    const backend: NativeSessionBackend = {
      descriptor: async () => {
        const [run] = await db.select({ runnerInstanceId: heartbeatRuns.runnerInstanceId }).from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, execution.binding.runId));
        if (!run?.runnerInstanceId) throw new Error("Native admission did not persist a runner identity");
        sourceInstanceId = run.runnerInstanceId;
        return { kind: "mock", name: "provider-trace", version: "1", capabilities,
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } };
      },
      openSession: async input => { identity = input.identity; return session; },
      recoverSession: async snapshot => { identity = snapshot.identity; return { recovered: true, session }; },
    };
    return backend;
  };
}


const executions: string[] = [];
describe("JUDGE native row14 next person message",()=>{
 const fixture=nativeRestartFixture({});
 it.each(["raw","notification","saved_code"] as const)("%s",async shape=>{
  const {companyId,agentId,temporary}=fixture.current;
  const db=createDb(temporary.connectionString,{maxConnections:6});
  const hb=heartbeatService(db,{nativeSessionBackendFactory:completingBackend(db)});
  const old=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});await once(old,"spawn");
  try{
   executions.length=0;
   const userId=randomUUID(); await db.insert(authUsers).values({id:userId,name:"Judge",email:`${userId}@example.test`,createdAt:new Date(),updatedAt:new Date()});
   await db.insert(companyMemberships).values({companyId,principalType:"user",principalId:userId,status:"active",membershipRole:"owner"});
   await db.update(agents).set({status:"idle",adapterConfig:{provider:"codex",lifecycleMode:"per_turn"},runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true}}}).where(eq(agents.id,agentId));
   await instanceSettingsService(db).updateExperimental({enableAgentChat:true,enableNativeRunner:true});
   const [issue]=await db.insert(issues).values({companyId,title:"Row14 native next message",status:"in_progress",assigneeAgentId:agentId,responsibleUserId:userId,conversationAgentId:agentId,conversationUserId:userId,conversationState:"active"}).returning();
   const failure="runner_process_termination_unconfirmed: runnerd process supervision failed: Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): result_unconfirmed, evidence=unknown (possibly ran)";
   const [source]=await db.insert(heartbeatRuns).values({companyId,agentId,issueId:issue.id,nativeIssueId:issue.id,runtimeMode:"native",status:"failed",nativePhase:"terminal_failure",error:shape==="saved_code"?"Saved supervision failure":shape==="notification"?`Notification transport failed closed: ${failure}`:failure,errorCode:shape==="saved_code"?failure:"notification_transport_failed",finishedAt:new Date(Date.now()-60000),responsibleUserId:userId,processPid:old.pid,contextSnapshot:{issueId:issue.id,conversationSessionGeneration:0}}).returning();
   await db.insert(nativeRunFinalizations).values({runId:source.id,companyId,issueId:issue.id,phase:"terminal_failure",failureCode:"notification_transport_failed",recoveryState:"blocked"});
   const message=await issueService(db).addComment(issue.id,"NEXT NATIVE PERSON MESSAGE",{userId},{clientRequestId:randomUUID()});
   await deliverConversationComments(db,issue,hb.wakeup);
   await waitForCondition("native next message settles",()=>hb.getTaskDrainStatus().quiescent,30000);
   const runs=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId,issue.id));
   const oldAuth = await loadAgentRunAuthentication(db, { runId: source.id, companyId, agentId });
   let oldWriteGuard: unknown; try { await db.transaction(tx=>assertAgentRunWriteAllowed(tx as any,companyId,{agentId,runId:source.id})); oldWriteGuard={allowed:true}; } catch(e) { oldWriteGuard={rejected:true,message:(e as Error).message,status:(e as any).status}; }
   let late:unknown;try{late=await issueService(db).addComment(issue.id,"OLD NATIVE LATE ANSWER",{agentId,runId:source.id},{completionReply:true})}catch(e){late={rejected:true,message:(e as Error).message,status:(e as any).status}}
   const comments=await db.select().from(issueComments).where(eq(issueComments.issueId,issue.id));
   await appendFile(`${process.env.TASK_OUT}/judge-native-next.jsonl`,JSON.stringify({shape,sourceId:source.id,issueId:issue.id,message,runs,executions:[...executions],oldAuth,oldAuthRevoked:agentRunWritesRevoked(oldAuth[0]),oldWriteGuard,late,comments,oldPid:old.pid,oldAlive:true})+"\n");
   expect(executions).toHaveLength(1);
   expect(runs.find(r=>r.id!==source.id)).toMatchObject({status:"succeeded",runtimeMode:"native"});
   expect(late).toMatchObject({rejected:true});
   expect(comments.filter(c=>c.authorType==="agent")).toHaveLength(1);
  }finally{const exited=once(old,"exit");old.kill("SIGKILL");await exited;await hb.drainActiveRunExecutions();await nativeExecutor.closeIdleWarmNativeSessionsForRestart();await db.$client.end();}
 },60000);
});
