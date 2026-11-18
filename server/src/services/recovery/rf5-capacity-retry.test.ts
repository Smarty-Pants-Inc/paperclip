// Independent audit of actual retry materializers. No production fixes.
import { randomUUID } from "node:crypto";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues, issueThreadInteractions } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { materializeNativeProviderCapacityRetry } from "../native-runtime/native-provider-capacity-retry.js";
import * as statusCommitter from "../native-runtime/status-decision-committer.js";
import { completedPersonMessageAnswerSql } from "../person-message-answer.js";
import { heartbeatService } from "../heartbeat.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";
const environmentMaterializer=(statusCommitter as any).materializeNativeEnvironmentBlockerRetry;
const support=await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("RF5 independent capacity/environment retry attribution",()=>{
 let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
 beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase("rf5-capacity-");db=createDb(database.connectionString);},60000);
 afterAll(async()=>{await db?.$client.end();await database?.cleanup();});
 for(const lane of ["capacity","environment"] as const)for(const kind of ["typed","card"] as const)
 it.skipIf(lane==="environment"&&!environmentMaterializer)(`${lane} retry: pending ${kind} input -> actual successor final -> no false notice`,async()=>{
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),userId=`user-${randomUUID()}`,base=Date.now()-900000;
  await db.insert(companies).values({id:companyId,name:"RF5 retry attribution",issuePrefix:companyId.slice(0,8)});
  await db.insert(agents).values({id:agentId,companyId,name:"Managed Pi",status:"active",adapterType:"paperclip_runner",
   adapterConfig:{provider:"pi_rpc",instructionsBundleMode:"managed",instructionsEntryFile:"AGENTS.md"}});
  await db.insert(issues).values({id:issueId,companyId,title:"Answer my pending input",status:"in_progress",assigneeAgentId:agentId,responsibleUserId:userId});
  let inputId:string,inputAt:Date;
  if(kind==="typed"){
   const [m]=await db.insert(issueComments).values({companyId,issueId,body:"Please answer my saved question.",authorType:"user",authorUserId:userId,createdAt:new Date(base)}).returning();inputId=m!.id;inputAt=m!.createdAt;
  }else{
   const [asker]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"succeeded",runtimeMode:"native",nativeIssueId:issueId,contextSnapshot:{issueId},createdAt:new Date(base-2000),finishedAt:new Date(base-1000)}).returning();
   const [q]=await db.insert(issueThreadInteractions).values({companyId,issueId,sourceRunId:asker!.id,kind:"ask_user_questions",status:"answered",createdByAgentId:agentId,addresseeUserId:userId,
    createdAt:new Date(base),resolvedAt:new Date(base+1000),resolvedByUserId:userId,payload:{version:1,questions:[]}}).returning();inputId=q!.id;inputAt=q!.resolvedAt!;
  }
  const context={issueId,...(kind==="typed"?{wakeCommentId:inputId,wakeCommentIds:[inputId]}:{interactionId:inputId,interactionStatus:"answered",source:"issue.interaction.respond"})};
  const [origin]=await db.insert(heartbeatRuns).values({companyId,agentId,status:"failed",runtimeMode:"native",nativeIssueId:issueId,errorCode:"native_provider_overloaded",contextSnapshot:context,
   createdAt:new Date(base+2000),finishedAt:new Date(base+3000)}).returning();
  const materialize=lane==="capacity"?materializeNativeProviderCapacityRetry:environmentMaterializer;
  const successorId=await db.transaction(async tx=>materialize({tx,companyId,agentId,issueId,runId:origin!.id}));
  const [successor]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,successorId));expect(successor!.retryOfRunId).toBe(origin!.id);
  await db.update(heartbeatRuns).set({status:"succeeded",runtimeMode:"native",nativeIssueId:issueId,finishedAt:new Date(base+5000)}).where(eq(heartbeatRuns.id,successorId));
  await db.update(agentWakeupRequests).set({status:"completed",finishedAt:new Date(base+5000)}).where(eq(agentWakeupRequests.id,successor!.wakeupRequestId!));
  await db.insert(issueComments).values({companyId,issueId,body:"Here is the final answer to your saved input.",authorType:"agent",authorAgentId:agentId,createdByRunId:successorId,createdAt:new Date(base+6000)});
  const answeredSql=completedPersonMessageAnswerSql({id:sql`${inputId}::uuid`,companyId:sql`${companyId}::uuid`,issueId:sql`${issueId}::uuid`,createdAt:sql`${inputAt.toISOString()}::timestamptz`});
  const answer=await db.execute(sql`select ${answeredSql} as answered`);
  await settleUnansweredPersonMessage(db,{companyId,issueId});await settleUnansweredPersonMessage(db,{companyId,issueId});
  await heartbeatService(db).reconcileStrandedAssignedIssues({companyId,issueId,skipRelatedRecovery:true,skipExternalConversationSettlement:true,unanswered:true});
  const notes=(await db.select().from(issueComments).where(eq(issueComments.issueId,issueId))).filter(n=>n.authorType==="system"&&!n.deletedAt&&n.metadata?.recoveryResponsibility!=="system");
  console.log("RF5_CAPACITY_RETRY",JSON.stringify({lane,kind,inputId,origin:origin!.id,successor:successorId,contextSnapshot:successor!.contextSnapshot,answer,notices:notes.map(n=>({id:n.id,body:n.body,reason:n.metadata?.authorizationReason}))}));
  expect.soft(notes,"actual successor answered pending input; no false notice").toHaveLength(0);
  // Positive own-input control after retaining raw result; does not repair the materializer.
  await db.update(heartbeatRuns).set({contextSnapshot:{...successor!.contextSnapshot,...(kind==="typed"?{attributionCommentIds:[inputId]}:{attributionInteractionIds:[inputId]})}}).where(eq(heartbeatRuns.id,successorId));
  await settleUnansweredPersonMessage(db,{companyId,issueId});
  const restored=(await db.select().from(issueComments).where(eq(issueComments.issueId,issueId))).filter(n=>n.authorType==="system"&&!n.deletedAt&&n.metadata?.recoveryResponsibility!=="system");
  console.log("RF5_CAPACITY_OWN_CONTROL",JSON.stringify({lane,kind,successor:successorId,notices:restored.map(n=>n.id)}));expect(restored).toHaveLength(0);
 });
});
