import './helpers/project-connections-approval-http.js';
import {afterAll,beforeAll,expect,it} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {createDb,toolConnections,toolConnectionInstalls} from '@paperclipai/db';
import {eq} from 'drizzle-orm';
import {startEmbeddedPostgresTestDatabase} from './helpers/embedded-postgres.js';
import {projectConnectionFixture} from './helpers/project-connections-approved-fixture.js';
import {storedConnection} from './helpers/project-connections-fixture.js';
import {consumeProjectAppApproval,readProjectAppCustody} from '../services/project-app-custody.js';
let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,db:ReturnType<typeof createDb>;
beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase('judge-r4-matrix-');db=createDb(database.connectionString)},60000);
afterAll(async()=>{await db?.$client.end({timeout:1});await database?.cleanup()},60000);
const record=(name:string,observation:unknown)=>{console.log(name,JSON.stringify(observation));if(process.env.TASK_OUT)appendFileSync(`${process.env.TASK_OUT}/r4-observations.jsonl`,JSON.stringify({name,observation})+'\n')};
async function fixture(live=false){
 const f=await projectConnectionFixture(db);const {sourceId}=await f.approve();let owned;
 if(live){
  const {connection}=await f.seedConnection(f.a,{status:'draft',pending:true,legacyId:sourceId,installed:false});owned=connection;
  const custody=await readProjectAppCustody(db,{companyId:f.companyId,projectId:f.a.id,config:owned.config,refs:owned.credentialSecretRefs,registrationId:'123',repositoryIds:[101]});
  await db.transaction(tx=>consumeProjectAppApproval(tx,{companyId:f.companyId,projectId:f.a.id,sourceConnectionId:sourceId,receiptId:custody.receipt.id,connectionId:owned.id,actorType:'agent',actorId:f.primary.id,retainAsPredecessor:true}));
 }else owned=await f.service.createConnection(f.companyId,f.input(f.a),f.actor());
 return {...f,sourceId,owned};
}
type F=Awaited<ReturnType<typeof fixture>>;
async function matrix(f:F,who:string,tag:string,readable:boolean){
 const company=`/api/companies/${f.companyId}`;const base=`/api/tool-connections/${f.sourceId}`;
 const urls=[base,`${company}/tools/connections`,`${company}/tools/apps/attention`,`${company}/tools/profiles/effective/agents/${f.leadA.id}`,`${base}/grants`];
 for(let i=0;i<urls.length;i++){
  const r=await request(f.route(who)).get(urls[i]);
  const row=i===0?r.body:i===1?r.body.connections?.find((x:{id:string})=>x.id===f.sourceId):i===2?r.body.apps?.find((x:{connection:{id:string}})=>x.connection.id===f.sourceId)?.connection:i===3?r.body.installedConnections?.find((x:{id:string})=>x.id===f.sourceId):r.body;
  const observed={path:['by-id','collection','attention','effective','param-grants'][i],status:r.status,present:!!row,reference:JSON.stringify(row??{}).includes(f.secret.id),config:!!row?.config};
  record(tag,observed);
  if(readable){if(i===0)expect.soft({status:r.status,reference:observed.reference,config:observed.config}).toEqual({status:200,reference:true,config:true});if(i===4)expect.soft(r.status).toBe(200)}
  else {expect.soft(observed.reference).toBe(false);if(i===4)expect.soft(r.status).toBe(403);else expect.soft(r.status).toBe(200)}
 }
}
for(const live of [false,true])it(`${live?'LIVE predecessor':'archived native first bind'}: every read path and owning lead/board positive`,async()=>{
 const f=await fixture(live);const source=await storedConnection(db,f.sourceId);
 expect(source.status==='archived').toBe(!live);
 // Force the LIVE predecessor into attention and effective sets. Archived sources are naturally absent from these sets.
 if(live){await db.update(toolConnections).set({status:'active',enabled:true,healthStatus:'error'}).where(eq(toolConnections.id,f.sourceId));await db.insert(toolConnectionInstalls).values({companyId:f.companyId,connectionId:f.sourceId,targetType:'agent',targetId:f.leadA.id});}
 await matrix(f,f.leadB.id,live?'live-other':'archived-other',false);
 await matrix(f,f.leadA.id,live?'live-owner':'archived-owner',true);
 await matrix(f,'board',live?'live-board':'archived-board',true);
});
for(const mode of ['missing','deleted','conflicting-forward','duplicate-consumers'] as const)it(`fail closed ${mode}: only board reads`,async()=>{
 const f=await fixture();const source=await storedConnection(db,f.sourceId);
 if(mode==='missing')await db.update(toolConnections).set({config:{...source.config,projectAppApprovalConsumedBy:randomUUID()}}).where(eq(toolConnections.id,f.sourceId));
 if(mode==='deleted')await db.delete(toolConnections).where(eq(toolConnections.id,f.owned.id));
 if(mode==='conflicting-forward')await db.update(toolConnections).set({transportConfig:{...source.transportConfig,projectAppApprovalConsumedBy:randomUUID()}}).where(eq(toolConnections.id,f.sourceId));
 if(mode==='duplicate-consumers'){
  const {connection}=await f.seedConnection(f.b);
  await db.update(toolConnections).set({config:{...connection.config,projectAppApprovalSourceId:f.sourceId},transportConfig:{...connection.transportConfig,projectAppApprovalSourceId:f.sourceId}}).where(eq(toolConnections.id,connection.id));
  record('duplicate consumers',{firstNamesSource:f.owned.config.projectAppApprovalSourceId===f.sourceId,secondNamesSource:true});
 }
 for(const who of [f.leadA.id,f.leadB.id,f.primary.id]){
  const r=await request(f.route(who)).get(`/api/tool-connections/${f.sourceId}`);
  const observed={status:r.status,reference:JSON.stringify(r.body).includes(f.secret.id)};record(mode+' agent',observed);expect.soft(observed.reference).toBe(false);
 }
 const board=await request(f.route('board')).get(`/api/tool-connections/${f.sourceId}`);expect({status:board.status,reference:JSON.stringify(board.body).includes(f.secret.id)}).toEqual({status:200,reference:true});
});
it('following a consumedBy marker on an OWNED row must never broaden the base audience',async()=>{
 const f=await projectConnectionFixture(db);const a=await f.seedConnection(f.a);const b=await f.seedConnection(f.b);
 await db.update(toolConnections).set({config:{...a.connection.config,projectAppApprovalConsumedBy:b.connection.id},transportConfig:{...a.connection.transportConfig,projectAppApprovalConsumedBy:b.connection.id}}).where(eq(toolConnections.id,a.connection.id));
 const r=await request(f.route(f.leadB.id)).get(`/api/tool-connections/${a.connection.id}`);
 const o={status:r.status,reference:JSON.stringify(r.body).includes(f.secret.id),config:!!r.body.config};record('owned cross-project follow broadening',o);expect(o.reference).toBe(false);
});
