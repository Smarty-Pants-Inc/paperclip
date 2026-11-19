import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { heartbeatRuns, type createDb } from '@paperclipai/db';
import type { NativeRunIdentity, NativeSession, PrpEvent } from '@paperclipai/paperclip-runner';
import type { HeartbeatServiceOptions } from '../../services/heartbeat.js';
// Reuses the provider-only boundary of heartbeat-provider-trace.test.ts.
// NO admission, stop-proof, selection, event persistence or publication mocks.
export function rf5CompletingPeer(db: ReturnType<typeof createDb>): NonNullable<HeartbeatServiceOptions['nativeSessionBackendFactory']> {
 return execution => {
  let identity: NativeRunIdentity; let sourceInstanceId=''; const turn=Promise.withResolvers<string>();
  const capabilities={resume:true,typedEvents:true,steering:false,interruption:true,structuredResult:true};
  const contract=execution.completionContract.contract as {revision:string;criteria:Array<{id:string}>};
  const result={schema:'paperclip.run_result.v1',reportedWorkDisposition:'done',summary:'RF5 controlled provider answered the new message.',completionClaim:{contractRevision:contract.revision,objectiveSatisfied:true,criteria:contract.criteria.map(c=>({criterionId:c.id,status:'satisfied',evidenceRefs:[]})),remainingWork:[]},evidence:[],verification:[],artifacts:[],attentionRequests:[]};
  const session: NativeSession={identity:()=>identity,capabilities:async()=>capabilities,attachRun:async input=>{identity=input.identity;},
   startTurn:async input=>{const turnId=randomUUID();await appendFile(process.env.TASK_OUT+'/executor-markers.jsonl',JSON.stringify({at:new Date().toISOString(),runId:identity.runId,sessionId:identity.sessionId,marker:'provider.startTurn',input})+'\n');turn.resolve(turnId);return {turnId};},
   async *events(){const turnId=await turn.promise;const event=(sourceSeq:number,eventType:PrpEvent['eventType'],payload:Record<string,unknown>):PrpEvent=>({schema:'paperclip.prp.event.v1',sourceKind:'runner',sourceInstanceId,sourceEventId:`${sourceInstanceId}:${identity.runId}:${sourceSeq}`,sourceSeq,runId:identity.runId,normalizedSessionId:identity.sessionId,turnId,schemaVersion:1,priority:0,emittedAt:new Date().toISOString(),eventType,payload});
    yield event(1,'turn.started',{});yield event(2,'item.completed',{kind:'agentMessage',channel:'final',text:'RF5 controlled provider answered the new message.'});yield event(3,'run.result.proposed',result);yield event(4,'turn.completed',{status:'completed'});},
   result:async()=>result as never,snapshot:async()=>({backendKind:'mock',sessionId:identity.sessionId,identity,providerSessionId:'rf5-controlled-provider',cursor:null,activeTurnId:null,pendingRuntimeRequests:[],lineage:[]}),close:async()=>{}};
  return {descriptor:async()=>{const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,execution.binding.runId));sourceInstanceId=run.runnerInstanceId!;
   await appendFile(process.env.TASK_OUT+'/executor-markers.jsonl',JSON.stringify({at:new Date().toISOString(),runId:run.id,startedAt:run.startedAt,marker:'executor.backend.descriptor',nativeSessionId:run.nativeSessionId})+'\n');
   return {kind:'mock',name:'rf5-controlled-provider-only',version:'1',capabilities,runtimeContextCapabilities:{instructions:'native',skills:'native',mcp:'native'}};},
   openSession:async input=>{identity=input.identity;return session;},
   recoverSession:async()=>{throw new Error('RF5 harness refuses to manufacture successful recovery of an old held provider session; only fresh OPEN is qualified.');}};
 };
}
