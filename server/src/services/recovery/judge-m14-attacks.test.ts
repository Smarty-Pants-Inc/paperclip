// Independent M1.4 attacks: actual PostgreSQL and production settlement, not mocked decisions.
// Keep reasons: immutable conversation history, durable links, multi-client idempotency.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { settleUnansweredPersonMessage } from "./unanswered-person-message.js";
const support=await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("independent M14 never-delete and current-link attacks",()=>{
 let temp:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase("judge-m14-attack-");db=createDb(temp.connectionString);},60000);
 afterAll(async()=>{await db?.$client.end();await temp?.cleanup();});
 async function seed(chat=true){
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID(),userId=randomUUID(),runId=randomUUID();
  const now=new Date(),at=(ms:number)=>new Date(now.getTime()+ms);
  await db.insert(authUsers).values({id:userId,name:"Judge",email:userId+"@example.test",emailVerified:true,createdAt:now,updatedAt:now});
  await db.insert(companies).values({id:companyId,name:"M14 independent attack",issuePrefix:companyId.slice(0,8),defaultResponsibleUserId:userId});
  await db.insert(agents).values({id:agentId,companyId,name:"Coder",status:"active",adapterType:"paperclip_runner",adapterConfig:{},runtimeConfig:{}});
  await db.insert(issues).values({id:issueId,companyId,title:"History test",status:"blocked",assigneeAgentId:agentId,...(chat?{conversationAgentId:agentId,conversationUserId:userId,conversationState:"active"}:{} )});
  const message=async(ms:number,q=db)=>{const [m]=await q.insert(issueComments).values({companyId,issueId,authorType:"user",authorUserId:userId,body:"Follow up "+ms,createdAt:at(ms)}).returning();return m!;};
  const first=await message(-300000);
  await db.insert(heartbeatRuns).values({id:runId,companyId,agentId,issueId,nativeIssueId:issueId,runtimeMode:"native",status:"failed",createdAt:at(-240000),finishedAt:at(-180000),errorCode:"native_continuation_requires_reconciliation",error:null,contextSnapshot:{issueId}});
  const [hold]=await db.insert(issueRecoveryActions).values({companyId,sourceIssueId:issueId,kind:"active_run_watchdog",ownerType:"board",status:"active",cause:"native_continuation_requires_reconciliation",fingerprint:"attack:"+runId,nextAction:"Inspect",evidence:{runId}}).returning();
  const all=()=>db.select().from(issueComments).where(and(eq(issueComments.companyId,companyId),eq(issueComments.issueId,issueId),eq(issueComments.authorType,"system")));
  const notices=async()=>(await all()).filter(n=>!n.deletedAt&&!n.metadata?.supersededBy);
  const settle=(ms=0,q=db)=>settleUnansweredPersonMessage(q,{companyId,issueId,now:at(ms)});
  const runQueued=async(messageId:string,ms:number,status="queued")=>{const [r]=await db.insert(heartbeatRuns).values({companyId,agentId,issueId,nativeIssueId:issueId,runtimeMode:"native",status,createdAt:at(ms),contextSnapshot:{issueId,wakeCommentId:messageId}}).returning();return r!;};
  return{companyId,agentId,issueId,userId,runId,at,first,holdId:hold!.id,message,all,notices,settle,runQueued};
 }
 it("exports actual persisted held-note rows for the production UI projection check",async()=>{
  const f=await seed();await f.settle();await f.message(1000);await f.settle(130000);
  const rows=await f.all();expect(rows).toHaveLength(2);expect(await f.notices()).toHaveLength(1);
  const receiptPath=process.env.JUDGE_NOTICE_RECEIPT ?? join(process.env.RFL_JUDGE_LOG_DIR ?? tmpdir(),"ui-notice-rows.json");mkdirSync(dirname(receiptPath),{recursive:true});
  writeFileSync(receiptPath,JSON.stringify(rows.map(n=>({id:n.id,companyId:n.companyId,issueId:n.issueId,authorType:n.authorType,authorAgentId:n.authorAgentId,authorUserId:n.authorUserId,body:n.body,presentation:n.presentation,metadata:n.metadata,createdAt:n.createdAt,updatedAt:n.updatedAt,deletedAt:n.deletedAt})),null,2)+"\n");
 });
 it("every supersededBy directly targets an existing CURRENT note after three held messages",async()=>{
  const f=await seed();await f.settle();
  await f.message(1000);await f.settle(130000);
  await f.message(140000);await f.settle(270000);
  const rows=await f.all(),current=await f.notices();
  expect(current).toHaveLength(1);expect(rows).toHaveLength(3);
  const byId=new Map(rows.map(n=>[n.id,n]));
  for(const n of rows){
   const seen=new Set<string>();let cursor:typeof n|undefined=n;
   while(cursor?.metadata?.supersededBy){expect(seen.has(cursor.id),"no cycle").toBe(false);seen.add(cursor.id);cursor=byId.get(cursor.metadata.supersededBy);expect(cursor,"link target exists").toBeDefined();}
  }
  console.log("three-note-link-receipt",JSON.stringify(rows.map(n=>({id:n.id,supersededBy:n.metadata?.supersededBy??null,deleted:!!n.deletedAt}))));
  // RFL-AUTHORIZED (M1.5): following supersededBy from any row ends at exactly ONE current note, no cycle, every target exists.
  const ends=new Set<string>();
  for(const n of rows){const seen=new Set<string>();let cursor:typeof n=n;
   while(cursor.metadata?.supersededBy){expect(seen.has(cursor.id),"no cycle").toBe(false);seen.add(cursor.id);const next=byId.get(cursor.metadata.supersededBy);expect(next,"every target exists").toBeDefined();cursor=next!;}
   expect(cursor.deletedAt,"the chain end is not deleted").toBeNull();ends.add(cursor.id);}
  expect([...ends],"every chain ends at the ONE current note").toEqual([current[0]!.id]);
 });
 it("waiting-to-held creates a new note; waiting body and presentation are immutable history",async()=>{
  const f=await seed();await db.update(issueRecoveryActions).set({status:"resolved"}).where(eq(issueRecoveryActions.id,f.holdId));
  const q=await f.runQueued(f.first.id,-60000);await f.settle();await f.settle(121000);
  const [waiting]=await f.notices();expect(waiting!.body).toContain("it will start by itself");
  await db.update(issueRecoveryActions).set({status:"active"}).where(eq(issueRecoveryActions.id,f.holdId));
  await db.update(heartbeatRuns).set({status:"failed",finishedAt:f.at(122000),errorCode:"native_continuation_requires_reconciliation",error:"native_controller_recovery_missing_evidence:snapshot_binding"}).where(eq(heartbeatRuns.id,q.id));
  await f.settle(150000);const rows=await f.all(),kept=rows.find(n=>n.id===waiting!.id)!;
  console.log("waiting-transition-receipt",JSON.stringify({sameRow:rows.length===1,before:waiting!.body,after:kept.body,supersededBy:kept.metadata?.supersededBy??null}));
  expect(kept.body,"never edit a note body in place").toBe(waiting!.body);
  expect(kept.presentation).toEqual(waiting!.presentation);expect(kept.deletedAt).toBeNull();
  expect(rows).toHaveLength(2);expect(kept.metadata?.supersededBy).toBe((await f.notices())[0]!.id);
 });
 it("an answer must not soft-delete any earlier notice",async()=>{
  const f=await seed();await f.settle();const [before]=await f.notices();
  const [answer]=await db.insert(issueComments).values({companyId:f.companyId,issueId:f.issueId,authorType:"agent",authorAgentId:f.agentId,body:"Here is your answer",createdAt:f.at(1000)}).returning();
  expect((await f.settle(2000)).kind).toBe("answered");const kept=(await f.all()).find(n=>n.id===before!.id)!;
  console.log("answer-retention-receipt",JSON.stringify({kept:!!kept,deleted:!!kept.deletedAt,supersededBy:kept.metadata?.supersededBy??null,answerId:answer!.id}));
  expect(kept.deletedAt,"never-delete includes answered notices").toBeNull();expect(kept.body).toBe(before!.body);expect(kept.metadata?.supersededBy).toBe(answer!.id);
 });
 it("a later message's held note leaves earlier waiting history untouched",async()=>{
  const f=await seed();await db.update(issueRecoveryActions).set({status:"resolved"}).where(eq(issueRecoveryActions.id,f.holdId));
  const q=await f.runQueued(f.first.id,-60000);await f.settle();await f.settle(121000);const [waiting]=await f.notices();
  expect(waiting!.body).toContain("it will start by itself");
  await f.message(122000);await db.update(issueRecoveryActions).set({status:"active"}).where(eq(issueRecoveryActions.id,f.holdId));
  await db.update(heartbeatRuns).set({status:"failed",finishedAt:f.at(123000),errorCode:"native_continuation_requires_reconciliation"}).where(eq(heartbeatRuns.id,q.id));
  await f.settle(260000);const rows=await f.all(),kept=rows.find(n=>n.id===waiting!.id)!;
  expect(kept).toEqual(waiting);expect(rows.filter(n=>n.presentation?.title==="This conversation can't continue"&&!n.deletedAt&&!n.metadata?.supersededBy)).toHaveLength(1);
 });
 it("two independent clients racing distinct held messages leave exactly one current held note",async()=>{
  const other=createDb(temp.connectionString);
  try{for(let i=0;i<5;i++){
   const f=await seed();await f.settle();
   const [m1,m2]=await Promise.all([f.message(1000,db),f.message(2000,other)]);
   const outcomes=await Promise.all([f.settle(130000,db),f.settle(130000,other)]);
   const rows=await f.all(),current=await f.notices();
   expect(current).toHaveLength(1);expect(current[0]!.presentation?.title).toBe("This conversation can't continue");
   expect(current[0]!.metadata?.authorizationReason).toBe("unanswered_message:"+m2.id);
   expect(rows.every(n=>!n.deletedAt)).toBe(true);expect(rows.filter(n=>n.metadata?.supersededBy).every(n=>n.metadata?.supersededBy===current[0]!.id)).toBe(true);
   console.log("two-client-distinct-message-race",JSON.stringify({round:i,messages:[m1.id,m2.id],outcomes:outcomes.map(x=>x.kind),current:current.length}));
  }}finally{await other.$client.end();}
 });
 it.each([true,false])("queued and scheduled chat=%s under active/escalated hold never promise automatic start",async chat=>{
  for(const status of ["queued","scheduled_retry"])for(const holdStatus of ["active","escalated"]){
   const f=await seed(chat);await db.update(issueRecoveryActions).set({status:holdStatus}).where(eq(issueRecoveryActions.id,f.holdId));
   await f.runQueued(f.first.id,-60000,status);await f.settle();await f.settle(121000);
   const [n]=await f.notices();expect(n!.presentation?.title).toBe("This conversation can't continue");expect(n!.body).not.toContain("it will start by itself");
   expect(JSON.stringify(n!.metadata)).not.toContain("No action is needed; it will start by itself.");
  }
 });
 it.each([true,false])("paused chat=%s plus reconciliation hold must choose held, not promise resume suffices",async chat=>{
  const f=await seed(chat);await db.update(agents).set({status:"paused"}).where(eq(agents.id,f.agentId));
  await f.runQueued(f.first.id,-60000);await f.settle();const [n]=await f.notices();
  console.log("paused-held-receipt",JSON.stringify({chat,body:n!.body,title:n!.presentation?.title}));
  expect(n!.presentation?.title).toBe("This conversation can't continue");expect(n!.body).not.toContain("it will run when Coder is resumed");
 });
});
