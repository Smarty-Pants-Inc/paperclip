import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { getServerProcessStartedAt } from "../server-info.js";
import { settleUnansweredPersonMessage, UNANSWERED_MESSAGE_REASON_PREFIX } from "../services/recovery/unanswered-person-message.js";
import { deliverConversationComments, undeliveredConversationComments } from "../services/agent-conversations.js";
import { hedge } from "./helpers/outbox-baseline.js";

// Real persisted outbox rows, not a mocked query or a test-only owed predicate.
describe("conversation outbox hot path and carried history", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("outbox-hot-path-"); db = createDb(temp.connectionString); }, 60_000);
  afterAll(async () => { await db?.$client.end(); await temp?.cleanup(); });

  async function fixture(ageDays: number) {
    const companyId=randomUUID(), agentId=randomUUID(), issueId=randomUUID(), oldId=randomUUID(), newerId=randomUUID();
    const sourceId=randomUUID(), replyRunId=randomUUID();
    const at=new Date(Date.now()-ageDays*86_400_000);
    await db.insert(companies).values({id:companyId,name:"Daily chat",issuePrefix:`OB${companyId.replaceAll("-", "").slice(0,12)}`});
    await db.insert(agents).values({id:agentId,companyId,name:"Assistant",role:"engineer",adapterType:"process",status:"idle"});
    await db.insert(issues).values({id:issueId,companyId,title:"Daily chat",status:"in_review",conversationAgentId:agentId,conversationUserId:"paul",assigneeAgentId:agentId,conversationState:"waiting"});
    await db.insert(heartbeatRuns).values([
      {id:sourceId,companyId,agentId,nativeIssueId:issueId,status:"failed",startedAt:new Date(+at+100),finishedAt:new Date(+at+500),contextSnapshot:{issueId,wakeCommentId:oldId}},
      {id:replyRunId,companyId,agentId,nativeIssueId:issueId,status:"succeeded",startedAt:new Date(+at+1100),finishedAt:new Date(+at+1500),contextSnapshot:{issueId,wakeCommentId:newerId}},
    ]);
    await db.insert(issueComments).values([
      {id:oldId,companyId,issueId,authorType:"user",authorUserId:"paul",origin:"comment",body:"Please inspect the build",clientRequestId:randomUUID(),createdAt:at},
      {id:newerId,companyId,issueId,authorType:"user",authorUserId:"paul",origin:"comment",body:"Actually check the release",clientRequestId:randomUUID(),createdAt:new Date(+at+1000)},
      {id:randomUUID(),companyId,issueId,authorType:"agent",authorAgentId:agentId,createdByRunId:replyRunId,origin:"comment",body:"Release checked",createdAt:new Date(+at+1400)},
    ]);
    const [issue]=await db.select().from(issues).where(eq(issues.id,issueId));
    return {companyId,agentId,issueId,oldId,newerId,sourceId,replyRunId,issue,at};
  }

  it("never-carried Send does not plan the owed floor", async () => {
    const f=await fixture(3);
    await db.delete(issueComments).where(eq(issueComments.companyId,f.companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.companyId));
    const id=randomUUID();
    await db.insert(issueComments).values({id,companyId:f.companyId,issueId:f.issueId,authorType:"user",authorUserId:"paul",origin:"comment",body:"Fresh Send",clientRequestId:randomUUID(),createdAt:new Date()});
    const statements:string[]=[];
    // Observe the real Drizzle statements at execution, without replacing results.
    const tracked=new Proxy(db,{get(target,prop){
      if(prop==="execute") return (query:any)=>{statements.push((target as any).dialect.sqlToQuery(query).sql);return target.execute(query);};
      if(prop!=="select") return Reflect.get(target,prop,target);
      return (...args:unknown[])=>{
        const wrap=(q:any):any=>new Proxy(q,{get(t,p){
          if(p==="then") return (resolve:any,reject:any)=>{statements.push(t.toSQL().sql);return t.then(resolve,reject);};
          const value=Reflect.get(t,p,t);
          if(typeof value!=="function") return value;
          return (...a:unknown[])=>{const result=value.apply(t,a);return result&&typeof result==="object"&&!Array.isArray(result)?wrap(result):result;};
        }});
        return wrap((target.select as any)(...args));
      };
    }});
    expect((await undeliveredConversationComments(tracked,f.companyId,f.issueId)).map(row=>row.id)).toEqual([id]);
    for (const statement of statements) {
      expect(statement).not.toContain("newer_person");
      expect(statement).not.toContain("source_chain");
    }
    expect(statements).toHaveLength(2);
  });

  for (const days of [3, 0]) {
    it(`${days ? "days-old boot" : "post-boot"}: carried then moved-past input is not re-sent`, async () => {
      const f=await fixture(days);
      if(!days) expect(+f.at).toBeGreaterThanOrEqual(+new Date(getServerProcessStartedAt()));
      const baseline=await hedge(db,f.companyId,f.issueId);
      expect(baseline).toEqual([]);
      expect(await undeliveredConversationComments(db,f.companyId,f.issueId)).toEqual(baseline);
      const sent:string[]=[];
      await deliverConversationComments(db,f.issue,async (_agent,options)=>{sent.push(String(options.payload.commentId));});
      expect(sent).toEqual([]);
    });
  }

  it("the cheap gate covers each non-receipt carrier field, including post-boot failures", async () => {
    for (const field of ["wakeCommentId", "commentId", "conversationReplyBoundaryCommentId", "wakeCommentIds", "firstTurnQueuedInput", "carriedSteeredCommentIds", "queuedSteeringAcknowledgements"]) {
      const f=await fixture(0);
      const scalar=["wakeCommentId", "commentId", "conversationReplyBoundaryCommentId"].includes(field);
      const context:Record<string,unknown>={issueId:f.issueId};
      const result:Record<string,unknown>={};
      if(field==="queuedSteeringAcknowledgements") result[field]={[f.oldId]:{status:"acknowledged"}};
      else context[field]=scalar?f.oldId:field==="firstTurnQueuedInput"?{commentIds:[f.oldId]}:[f.oldId];
      await db.update(heartbeatRuns).set({contextSnapshot:context,resultJson:result}).where(eq(heartbeatRuns.id,f.sourceId));
      const baseline=await hedge(db,f.companyId,f.issueId);
      expect(baseline,field).toEqual([]);
      expect(await undeliveredConversationComments(db,f.companyId,f.issueId),field).toEqual(baseline);
    }
  });

  it("a three-day-old still-owed failed input retains the monolithic result", async () => {
    const f=await fixture(3);
    await db.delete(issueComments).where(eq(issueComments.createdByRunId,f.replyRunId));
    await db.delete(issueComments).where(eq(issueComments.id,f.newerId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id,f.replyRunId));
    const baseline=await hedge(db,f.companyId,f.issueId);
    expect(baseline.map(row=>row.id)).toEqual([f.oldId]);
    expect(await undeliveredConversationComments(db,f.companyId,f.issueId)).toEqual(baseline);
  });

  it("post-boot failed carrier keeps its one card after move-on and a new Send", async () => {
    const f=await fixture(0);
    expect(+f.at).toBeGreaterThanOrEqual(+new Date(getServerProcessStartedAt()));
    const [newer]=await db.select().from(issueComments).where(eq(issueComments.id,f.newerId));
    const [reply]=await db.select().from(issueComments).where(eq(issueComments.createdByRunId,f.replyRunId));
    const [run]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.replyRunId));
    await db.delete(issueComments).where(eq(issueComments.createdByRunId,f.replyRunId));
    await db.delete(issueComments).where(eq(issueComments.id,f.newerId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id,f.replyRunId));
    const now=new Date(Date.now()+180_000);
    expect((await settleUnansweredPersonMessage(db,{companyId:f.companyId,issueId:f.issueId,now})).kind).toBe("noticed");
    await db.insert(heartbeatRuns).values(run);
    await db.insert(issueComments).values([newer,reply]);
    for (let i=0;i<2;i++) await settleUnansweredPersonMessage(db,{companyId:f.companyId,issueId:f.issueId,now:new Date(+now+i*60_000)});
    const id=randomUUID();
    await db.insert(issueComments).values({id,companyId:f.companyId,issueId:f.issueId,authorType:"user",authorUserId:"paul",origin:"comment",body:"New daily Send",clientRequestId:randomUUID(),createdAt:new Date(+f.at+2000)});
    expect(await undeliveredConversationComments(db,f.companyId,f.issueId)).toEqual(await hedge(db,f.companyId,f.issueId));
    const sent:string[]=[];
    await deliverConversationComments(db,f.issue,async (_agent,options)=>{sent.push(String(options.payload.commentId));});
    expect(sent).toEqual([id]);
    const notices=(await db.select().from(issueComments).where(eq(issueComments.issueId,f.issueId)))
      .filter(row=>row.metadata?.authorizationReason===UNANSWERED_MESSAGE_REASON_PREFIX+f.oldId);
    expect(notices).toHaveLength(1);
  });

  it("a fresh saved Send is delivered while days-old moved-past rows stay consumed", async () => {
    const f=await fixture(3), id=randomUUID();
    await db.insert(issueComments).values({id,companyId:f.companyId,issueId:f.issueId,authorType:"user",authorUserId:"paul",origin:"comment",body:"Next task please",clientRequestId:randomUUID(),createdAt:new Date()});
    const baseline=await hedge(db,f.companyId,f.issueId);
    expect(baseline.map(row=>row.id)).toEqual([id]);
    expect(await undeliveredConversationComments(db,f.companyId,f.issueId)).toEqual(baseline);
    const sent:string[]=[];
    await deliverConversationComments(db,f.issue,async (_agent,options)=>{sent.push(String(options.payload.commentId));});
    expect(sent).toEqual([id]);
  });

  it("more than 100 rejected candidates cannot starve a later fresh Send", async () => {
    const f=await fixture(3), id=randomUUID();
    const rows=Array.from({length:105},()=>({id:randomUUID(),companyId:f.companyId,issueId:f.issueId,authorType:"user" as const,authorUserId:"paul",origin:"comment" as const,body:"Older carried input",clientRequestId:randomUUID(),createdAt:f.at}));
    await db.insert(issueComments).values(rows);
    await db.insert(heartbeatRuns).values({id:randomUUID(),companyId:f.companyId,agentId:f.agentId,nativeIssueId:f.issueId,status:"cancelled",startedAt:new Date(+f.at+100),finishedAt:new Date(+f.at+500),contextSnapshot:{issueId:f.issueId,wakeCommentIds:rows.map(row=>row.id)}});
    await db.insert(issueComments).values({id,companyId:f.companyId,issueId:f.issueId,authorType:"user",authorUserId:"paul",origin:"comment",body:"New Send",clientRequestId:randomUUID(),createdAt:new Date()});
    const baseline=await hedge(db,f.companyId,f.issueId);
    expect(baseline.map(row=>row.id)).toEqual([id]);
    expect(await undeliveredConversationComments(db,f.companyId,f.issueId)).toEqual(baseline);
  });
});
