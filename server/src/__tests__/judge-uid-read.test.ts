import './helpers/project-connections-approval-http.js';
import {afterAll,beforeAll,expect,it} from 'vitest';
import request from 'supertest';
import {createDb,toolConnections} from '@paperclipai/db';
import {eq} from 'drizzle-orm';
import {startEmbeddedPostgresTestDatabase} from './helpers/embedded-postgres.js';
import {projectConnectionFixture} from './helpers/project-connections-approved-fixture.js';
let database:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;let db:ReturnType<typeof createDb>;
beforeAll(async()=>{database=await startEmbeddedPostgresTestDatabase('judge-uid-read-');db=createDb(database.connectionString)},60000);
afterAll(async()=>{await db?.$client.end({timeout:1});await database?.cleanup()},60000);
it('independent owned detail privacy must apply to UID aliases as well as UUIDs',async()=>{
 const f=await projectConnectionFixture(db);const {connection}=await f.seedConnection(f.a);const observations=[];
 const uid=`judge-owned-${connection.id}`;
 await db.update(toolConnections).set({uid}).where(eq(toolConnections.id,connection.id));
 for(const who of [f.leadB.id,f.outsider.id]){
  const canonical=await request(f.route(who)).get(`/api/tool-connections/${connection.id}/grants`);
  const alias=await request(f.route(who)).get(`/api/tool-connections/${encodeURIComponent(uid)}/grants`);
  const exposed=alias.body.grants?.some((g:{credentialSecretRefs?:unknown[]})=>!!g.credentialSecretRefs?.length)===true;
  const observed={canonicalStatus:canonical.status,aliasStatus:alias.status,aliasGrantsPresent:!!alias.body.grants?.length,aliasCredentialRefsExposed:exposed};
  console.log('UID detail read (booleans only)',JSON.stringify(observed));observations.push(observed);
 }
 expect(observations.every(r=>!r.aliasCredentialRefsExposed)).toBe(true);
});
