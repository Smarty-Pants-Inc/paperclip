import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sql, eq } from 'drizzle-orm';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { companies, companySkills, companySkillVersions, createDb, executionWorkspaces } from '@paperclipai/db';
import { startEmbeddedPostgresTestDatabase } from '../__tests__/helpers/embedded-postgres.js';
import { withWorkspaceSourceLocks, workspaceSourceLockSignal } from './workspace-source-lock.js';
import { withSkillVersionCacheLock, skillVersionCachePaths, touchSkillVersionCache } from './skill-version-cache.js';
import { skillExecutionContent } from './skill-execution-content.js';
import { skillVersionRetentionService } from './skill-version-retention.js';
import { moveTransferItems, withWorkspaceMoveLocks } from './isolated-repository-rehome.js';
import { hostMutation } from '@paperclipai/adapter-utils/host-mutation-drain';

function latch() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
describe('RFL independent real consumer boundaries', () => {
 let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 let db: ReturnType<typeof createDb>; let home: string;
 beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase('rfl-ka6-consumers-'); db = createDb(database.connectionString);
  const [row] = await db.execute(sql`select current_database() as name`);
  await db.execute(sql.raw(`alter database "${row.name}" set idle_in_transaction_session_timeout = '3s'`));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'rfl-ka6-consumers-')); vi.stubEnv('PAPERCLIP_HOME', home);
 }, 120000);
 afterEach(() => vi.restoreAllMocks());
 afterAll(async () => { vi.unstubAllEnvs(); await db?.$client.end({timeout:1}); await database?.cleanup(); await fs.rm(home, {recursive:true,force:true}); });
 async function lose(key: string) {
  const rows = await db.execute(sql`select pid from pg_locks where locktype='advisory' and granted
   and classid::bigint=((hashtextextended(${key},0)>>32)&4294967295) and objid::bigint=(hashtextextended(${key},0)&4294967295)`);
  expect(rows).toHaveLength(1); await db.execute(sql`select pg_terminate_backend(${rows[0].pid})`);
  const next = await db.transaction(async tx => (await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key},0)) as acquired`))[0].acquired);
  expect(next).toBe(true); await sleep(2500); return true;
 }
 async function skill() {
  const companyId=randomUUID(), skillId=randomUUID(), versionId=randomUUID();
  await db.insert(companies).values({id:companyId,name:'RFL real skill',issuePrefix:companyId.slice(0,8)});
  await db.insert(companySkills).values({id:skillId,companyId,key:`company/${companyId}/judge`,slug:'judge',name:'Judge',markdown:'# Judge'});
  await db.insert(companySkillVersions).values({id:versionId,companyId,companySkillId:skillId,revisionNumber:1,fileInventory:[
   {path:'SKILL.md',kind:'skill',content:'# Judge'}, {path:'second.txt',kind:'reference',content:'second'}]});
  return {companyId,skillId,versionId};
 }
 it('JUDGE materialisation: loss after first file write must prevent second write and publication', async () => {
  const ref=await skill(), entered=latch(), gate=latch(), ended=latch(); const writes: string[]=[];
  const original=fs.writeFile.bind(fs); let stopped=false;
  vi.spyOn(fs,'writeFile').mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
   const filename=String(args[0]); if(stopped) writes.push(filename);
   const value=await original(...args);
   if(filename.endsWith('/SKILL.md') && filename.includes(ref.versionId)) { entered.release(); await gate.promise; }
   return value;
  });
  let signal:AbortSignal|undefined;
  const op=withSkillVersionCacheLock(db,ref.companyId, async lost => { signal=lost; try {
   return await skillExecutionContent(db).withReadableVersion(ref, async p=>p);
  } finally {ended.release();} }).then(value=>({value}),error=>({error:String(error)}));
  try {
   await Promise.race([entered.promise,op.then(x=>{throw Error('early '+JSON.stringify(x))})]);
   await lose(`skill_version_cache:${ref.companyId}`); expect(signal?.aborted).toBe(true); stopped=true;
   gate.release(); await ended.promise; const result=await op;
   const directory=skillVersionCachePaths(ref.companyId,ref.skillId,ref.versionId).directory;
   const proof={writesAfterLoss:writes,published:existsSync(path.join(directory,'second.txt')),versionRows:(await db.select().from(companySkillVersions).where(eq(companySkillVersions.id,ref.versionId))).length,result};
   console.log('RFL_MATERIALISATION',JSON.stringify(proof));
   await fs.writeFile(path.join(process.env.TASK_OUT!,'consumer-materialisation.json'),JSON.stringify(proof,null,2));
   expect(proof.versionRows).toBe(1); expect(proof.published).toBe(false); expect(writes.filter(p=>p.includes(ref.versionId))).toEqual([]);
  } finally {gate.release();await ended.promise;await op;}
 },45000);
 it('JUDGE transfer loop: loss after first rename must prevent second rename', async () => {
  const workspace={id:randomUUID(),companyId:randomUUID(),sourceIssueId:randomUUID(),projectId:null,cwd:null,providerRef:null} as never as Parameters<typeof withWorkspaceMoveLocks>[1];
  const from=path.join(home,randomUUID(),'from'),to=path.join(home,randomUUID(),'to');
  await fs.mkdir(from,{recursive:true}); await fs.mkdir(to,{recursive:true}); await fs.writeFile(path.join(from,'one'),'one');await fs.writeFile(path.join(from,'two'),'two');
  const entered=latch(),gate=latch(),ended=latch(); const original=fs.rename.bind(fs); let signal:AbortSignal|undefined;
  vi.spyOn(fs,'rename').mockImplementation(async (...args:Parameters<typeof fs.rename>)=> {
   const value=await original(...args); if(String(args[0])===path.join(from,'one')) {entered.release();await gate.promise;} return value;
  });
  const op=withWorkspaceMoveLocks(db,workspace,async (_tx,lost)=> {signal=lost;try {await hostMutation(()=>moveTransferItems(from,to,['one','two'],new Map()));return 'done';}finally{ended.release();}}).then(value=>({value}),error=>({error:String(error)}));
  try {
   await Promise.race([entered.promise,op.then(x=>{throw Error('early '+JSON.stringify(x))})]);
   await lose(`isolated_repository_source:${workspace.companyId}:${workspace.sourceIssueId}`);expect(signal?.aborted).toBe(true);
   gate.release();await ended.promise;const result=await op;
   const proof={firstMoved:existsSync(path.join(to,'one')),secondMovedAfterLoss:existsSync(path.join(to,'two')),secondRetained:existsSync(path.join(from,'two')),result};
   console.log('RFL_TRANSFER',JSON.stringify(proof));await fs.writeFile(path.join(process.env.TASK_OUT!,'consumer-transfer.json'),JSON.stringify(proof,null,2));
   expect(proof.secondMovedAfterLoss).toBe(false);expect(proof.secondRetained).toBe(true);
  }finally{gate.release();await ended.promise;await op;}
 },45000);
 it('JUDGE retention: loss during final eligibility read prevents the rename, retaining DB and FS bytes',async()=>{
  const ref=await skill(),paths=skillVersionCachePaths(ref.companyId,ref.skillId,ref.versionId);
  await fs.mkdir(paths.directory,{recursive:true});await fs.writeFile(path.join(paths.directory,'SKILL.md'),'# Judge');
  await touchSkillVersionCache(ref.companyId,ref.skillId,ref.versionId,Date.now()-7200000);
  const entered=latch(),gate=latch();const original=fs.lstat.bind(fs);let matches=0;
  vi.spyOn(fs,'lstat').mockImplementation(async(...args:Parameters<typeof fs.lstat>)=>{
   const value=await original(...args);if(String(args[0])===paths.directory && ++matches===5){entered.release();await gate.promise;}return value;
  });
  const service=skillVersionRetentionService(db);
  const op=service.pruneCompany(ref.companyId,{graceMs:0}).then(value=>({value}),error=>({error:String(error)}));
  try {
   await Promise.race([entered.promise,op.then(x=>{throw Error('early '+JSON.stringify({matches,...x}))})]);
   await lose(`skill_version_cache:${ref.companyId}`);gate.release();const result=await op;
   const proof={matches,retained:existsSync(paths.directory),versionRows:(await db.select().from(companySkillVersions).where(eq(companySkillVersions.id,ref.versionId))).length,result};
   console.log('RFL_RETENTION',JSON.stringify(proof));await fs.writeFile(path.join(process.env.TASK_OUT!,'consumer-retention.json'),JSON.stringify(proof,null,2));
   expect(proof.retained).toBe(true);expect(proof.versionRows).toBe(1);
  }finally{gate.release();await op;service.dispose();}
 },45000);
 it('JUDGE workspaceSourceLockSignal joins an outer held lock and refuses the next guarded write',async()=>{
  const companyId=randomUUID(),id=randomUUID(),entered=latch(),gate=latch(),ended=latch();const filename=path.join(home,'signal-late');let effective:AbortSignal|undefined;
  const op=withWorkspaceSourceLocks(db,{companyId,issueIds:[id]},async()=> {try{
   await withSkillVersionCacheLock(db,companyId,async()=>{ effective=workspaceSourceLockSignal();entered.release();await gate.promise;effective?.throwIfAborted();await hostMutation(()=>fs.writeFile(filename,'late')); });
  }finally{ended.release();}}).then(value=>({value}),error=>({error:String(error)}));
  try{await entered.promise;await lose(`isolated_repository_source:${companyId}:${id}`);gate.release();await ended.promise;await op;
   const proof={aborted:effective?.aborted,late:existsSync(filename)};console.log('RFL_SOURCE_SIGNAL',JSON.stringify(proof));expect(proof).toEqual({aborted:true,late:false});
  }finally{gate.release();await ended.promise;await op;}
 },45000);
});
