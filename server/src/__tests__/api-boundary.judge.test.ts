import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { afterAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { companies, issues, issueComments, createDb, startEmbeddedPostgresTestDatabase } from '@paperclipai/db';
import { issueService } from '../services/issues';
import { buildStrandedRecoveryEscalationNotice } from '../services/recovery/stranded-notice';
import { issueCommentMetadataSchema } from '@paperclipai/shared';
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
afterAll(async()=>{await temp?.cleanup();});

it('judge: comments read service must preserve supersededBy from Postgres for the UI predicate',async()=>{
 temp=await startEmbeddedPostgresTestDatabase('rfl-supnotice-api-');
 const db=createDb(temp.connectionString);
 const companyId=randomUUID(), issueId=randomUUID(), oldId=randomUUID(), newId=randomUUID();
 await db.insert(companies).values({id:companyId,name:'Local boundary fixture',issuePrefix:'JUDGE',requireBoardApprovalForNewAgents:false});
 await db.insert(issues).values({id:issueId,companyId,title:'Superseded notice boundary',status:'in_progress',priority:'medium'});
 const built=buildStrandedRecoveryEscalationNotice({seed:{title:'Your message is waiting to start',body:'Your message is waiting for the agent to be free; it will start by itself.',tone:'info',nextAction:'No action is needed; it will start by itself.'},recoveryActionId:null,recoveryOwner:null,recoveryResponsibility:'user',sourceRun:null});
 const metadata={...built.metadata,authorizationReason:'unanswered_message:'+randomUUID()};
 expect(issueCommentMetadataSchema.safeParse(metadata).success).toBe(true);
 await db.insert(issueComments).values([
  {id:oldId,companyId,issueId,authorType:'system',body:built.body,presentation:built.presentation,metadata,deletedAt:null},
  {id:newId,companyId,issueId,authorType:'system',body:'This conversation cannot continue. Start a new chat.',presentation:built.presentation,metadata,deletedAt:null},
 ]);
 // The exact same JSONB merge shape used by the companion B-prime writer.
 await db.execute(sql`update ${issueComments} set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('supersededBy', ${newId}::text) where id = ${oldId}`);
 const stored=await db.select().from(issueComments);
 const service=issueService(db);
 const listed=await service.listComments(issueId,{order:'asc'});
 const exact=await service.getComment(oldId);
 const old=listed.find(c=>c.id===oldId)!;
 const current=listed.find(c=>c.id===newId)!;
 await writeFile(process.env.TASK_OUT+'/api-comment-payload.json',JSON.stringify({oldId,newId,stored,listed,exact},null,2));
 expect(stored.find(c=>c.id===oldId)?.metadata).toMatchObject({supersededBy:newId});
 expect(old.deletedAt).toBeNull();
 expect(current.metadata).not.toBeNull();
 expect(old.metadata,'real listComments response must carry the durable supersession marker').toMatchObject({supersededBy:newId});
},90000);
