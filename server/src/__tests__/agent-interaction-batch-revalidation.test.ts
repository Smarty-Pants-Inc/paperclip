import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueComments, issues, type Db } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import { startRecoveryPostgres, recoveryPostgresSupport as support } from "./helpers/recovery-postgres.js";

// Keep: data-safety/authorization boundary. Batch discovery must never authorize
// a later task using an earlier owner's policy or acquire an unplanned lower ID.
(support.supported ? describe : describe.skip)("batched interaction source revalidation", () => {
  let temporary:Awaited<ReturnType<typeof startRecoveryPostgres>>,db:Db;
  beforeAll(async()=>{temporary=await startRecoveryPostgres("batch-policy-revalidation-");db=createDb(temporary.connectionString);},90_000);
  afterAll(async()=>{await db?.$client.end();await temporary?.cleanup();});
  it("rolls back the whole real comment import if a later task changes owner after discovery",async()=>{
    const companyId=randomUUID(), actorId=randomUUID(), nextOwnerId=randomUUID();
    await db.insert(companies).values({id:companyId,name:"Batch revalidation",issuePrefix:`B${companyId.slice(0,6)}`});
    await db.insert(agents).values([actorId,nextOwnerId].map(id=>({id,companyId,name:id,adapterType:"process"})));
    const [one,two]=await db.insert(issues).values([1,2].map(n=>({companyId,title:`Task ${n}`,assigneeAgentId:actorId}))).returning();
    let open!:()=>void,release!:()=>void;
    const discovered=new Promise<void>(resolve=>{open=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
    let snapshots=0;
    const observed=new Proxy(db,{get(target,key,receiver){
      if(key!=="transaction")return Reflect.get(target,key,receiver);
      return (callback:(tx:Db)=>Promise<unknown>)=>target.transaction(async tx=>{
        await tx.execute(sql`set local statement_timeout = '5s'`);
        const session=(tx as unknown as {session:{prepareQuery:(...args:unknown[])=>{execute:(...args:unknown[])=>Promise<unknown>}}}).session;
        const prepare=session.prepareQuery;
        session.prepareQuery=function(...args){const prepared=prepare.apply(this,args),execute=prepared.execute;
          prepared.execute=async function(...values){const result=await execute.apply(this,values),query=(args[0] as {sql:string}).sql;
            if(query.includes('from "issues"')&&!query.includes("for ")&&++snapshots===1){open();await resume;}
            return result;};return prepared;};
        return callback(tx as unknown as Db);
      });
    }});
    const imported=Promise.allSettled([issueService(observed).addImportedComments([one!,two!].map(task=>({id:randomUUID(),companyId,
      issueId:task.id,authorType:"agent",authorAgentId:actorId,authorUserId:null,presentation:null,metadata:null,createdAt:null,body:"Imported text"})),actorId)]);
    try{
      await Promise.race([discovered,imported.then(()=>{throw new Error("import did not discover both task owners");})]);
      await db.update(issues).set({assigneeAgentId:nextOwnerId}).where(eq(issues.id,two!.id));
    }finally{release();await imported;}
    expect(await imported).toEqual([expect.objectContaining({status:"rejected",reason:expect.objectContaining({status:409,message:"Task interaction ownership changed during the operation."})})]);
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId,companyId))).toEqual([]);
    expect((await db.select().from(issues).where(eq(issues.id,two!.id)))[0]?.assigneeAgentId).toBe(nextOwnerId);
  },15_000);
});
