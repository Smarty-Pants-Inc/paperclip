import './helpers/project-connections-approval-http.js';
import {afterAll,beforeAll,expect,it} from 'vitest';
import request from 'supertest';
import {createDb,toolConnections} from '@paperclipai/db';
import {eq} from 'drizzle-orm';
import {startEmbeddedPostgresTestDatabase} from './helpers/embedded-postgres.js';
import {projectConnectionFixture} from './helpers/project-connections-approved-fixture.js';
let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;let db:ReturnType<typeof createDb>;
beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase('judge-effective-read-');db=createDb(database.connectionString)},60000);
afterAll(async()=>{await db?.$client.end({timeout:1});await database?.cleanup()},60000);
it('independent cross-project effective-profile reader must not receive target agent owned configuration',async()=>{
 const f=await projectConnectionFixture(db);const {connection}=await f.seedConnection(f.a);
 await db.update(toolConnections).set({config:{...connection.config,judgeConfigMarker:'synthetic-private-config-marker'}}).where(eq(toolConnections.id,connection.id));
 const results=[];
 for (const actor of [f.leadB.id,f.outsider.id]) {
 const r=await request(f.route(actor)).get(`/api/companies/${f.companyId}/tools/profiles/effective/agents/${f.leadA.id}`);
 const row=r.body.installedConnections?.find((c:{id:string})=>c.id===connection.id);
 const observed={status:r.status,ownedRow:!!row,configPresent:!!row?.config,marker:row?.config?.judgeConfigMarker==='synthetic-private-config-marker',transportConfigPresent:!!row?.transportConfig,refs:!!row?.credentialSecretRefs?.length};
 console.log('effective profile read (booleans only)',JSON.stringify(observed));
 results.push(observed);
 }
 expect(results.every(r=>!r.marker)).toBe(true);
});
it('independent positives: board, own lead, own worker and company primary receive config and reference on by-ID',async()=>{
 const f=await projectConnectionFixture(db);const {connection}=await f.seedConnection(f.a);
 for (const who of ['board',f.leadA.id,f.worker.id,f.primary.id]) {
  const r=await request(f.route(who)).get(`/api/tool-connections/${connection.id}`);
  const observed={status:r.status,config:!!r.body.config,transportConfig:!!r.body.transportConfig,refs:!!r.body.credentialSecretRefs?.length};
  console.log('by-ID allowed read (booleans only)',JSON.stringify(observed));
  expect(observed).toEqual({status:200,config:true,transportConfig:true,refs:true});
 }
});
