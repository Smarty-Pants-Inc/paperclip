// Independent data-safety tests. All trees and bytes are synthetic, local and task-owned.
// Deterministic scheduler: the wrapper returns REAL lstat metadata, after a real rename
// at the POSIX-permitted check/use boundary. No metadata, deletion or outcome is faked.
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
const schedule = vi.hoisted(() => ({ path: '', action: undefined as undefined | (() => Promise<void>) }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const metadata = await actual.lstat(...args);
    if (String(args[0]) === schedule.path && schedule.action) {
      const action = schedule.action; schedule.action = undefined; await action();
    }
    return metadata;
  }};
});
import { removeLegacyPiCompileCache } from './pi-compile-cache-environment.js';
import { PiRpcDriver } from './pi-rpc-driver.js';
const roots: string[] = [];
afterEach(async () => { schedule.action=undefined; vi.restoreAllMocks(); vi.unstubAllEnvs(); for(const p of roots.splice(0)) await fs.rm(p,{recursive:true,force:true}); });
async function fixture() {
  const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'ncc-trace-'))); roots.push(root);
  const session=join(root,'durable-sessions','scope'), runtime=join(session,'filesystem','pi');
  const cache=join(runtime,'node-compile-cache'), hostTmp=join(root,'tmp');
  await fs.mkdir(cache,{recursive:true,mode:0o700}); await fs.mkdir(hostTmp,{mode:0o700});
  await fs.writeFile(join(cache,'bytecode'),'DERIVED');
  vi.stubEnv('TMPDIR',hostTmp); vi.stubEnv('PI_CODING_AGENT_DIR',join(root,'not-operator-home'));
  return {root,session,runtime,cache,hostTmp};
}
async function record(name:string, data:unknown) {
  if (!process.env.JUDGE_PROOF_DIRECTORY) return;
  await fs.mkdir(process.env.JUDGE_PROOF_DIRECTORY,{recursive:true});
  await fs.writeFile(join(process.env.JUDGE_PROOF_DIRECTORY,name+'.json'),JSON.stringify(data,null,2)+'\n');
}
async function stat(path:string) { const s=await fs.lstat(path); return {dev:s.dev,ino:s.ino,uid:s.uid,isDirectory:s.isDirectory(),isSymbolicLink:s.isSymbolicLink()}; }
async function contents(path:string) { return fs.readFile(path,'utf8').catch(e=>`ERROR:${e.code}`); }

it.each(['pi','runner','failover-backups','conversation-evidence'])('NEVER delete %s trace moved into the checked cache before rm',async kind=>{
  const f=await fixture(), trace=join(f.root,kind), name=kind==='pi'?'conversation.jsonl':kind==='runner'?'runner-journal.jsonl':'retained-evidence.jsonl';
  const bytes=`SYNTHETIC_${kind}_TRACE_DO_NOT_DELETE\n`;
  await fs.mkdir(trace,{mode:0o700}); await fs.writeFile(join(trace,name),bytes);
  const checked=await stat(f.cache), traceBefore=await stat(trace);
  schedule.path=f.cache; schedule.action=async()=>{await fs.rename(f.cache,join(f.root,'original-cache'));await fs.rename(trace,f.cache);};
  await removeLegacyPiCompileCache(f.runtime);
  const observed=await contents(join(f.cache,name));
  await record('swap-'+kind,{attack:'replace checked cache directory after lstat, before recursive rm',checked,traceBefore,observed,expected:bytes,originalCache:await contents(join(f.root,'original-cache','bytecode')),scheduleExecuted:!schedule.action});
  expect(schedule.action).toBeUndefined();
  expect(observed,'a real trace inode must survive an optional cache cleanup').toBe(bytes);
});

it('actual Pi driver preserves runner journal during cache-name substitution',async()=>{
  const f=await fixture(), runner=join(f.session,'runner'), bytes='SYNTHETIC_RUNNER_REPLAY_TRACE\n';
  await fs.mkdir(runner,{mode:0o700}); await fs.writeFile(join(runner,'events.jsonl'),bytes);
  // Disable seeding so the first cache lstat is the deletion predicate, not the seeder.
  vi.stubEnv('TMPDIR',runner);
  schedule.path=f.cache; schedule.action=async()=>{await fs.rename(f.cache,join(f.root,'original-cache'));await fs.rename(runner,f.cache);};
  const reachedTransport=new Error('JUDGE_CAPTURED_TRANSPORT');
  let thrown:unknown;
  try { await new PiRpcDriver({runtimeDirectory:f.runtime,model:'neutral/model',piRpcThinkingLevel:'off',
    environment:{PI_CODING_AGENT_DIR:join(f.root,'agent')},transportFactory:()=>{throw reachedTransport;},
  }).openSession({runId:'race',normalizedSessionId:'race',workingDirectory:f.root}); }catch(e){thrown=e;}
  const observed=await contents(join(f.cache,'events.jsonl'));
  await record('driver-swap-runner',{attack:'actual driver open path with controlled lstat completion interleaving',reachedTransport:thrown===reachedTransport,observed,expected:bytes,scheduleExecuted:!schedule.action});
  expect(thrown).toBe(reachedTransport); expect(schedule.action).toBeUndefined(); expect(observed).toBe(bytes);
});

it('preserves a retired runtime when its pathname is moved and reused after validation',async()=>{
  const f=await fixture(), retired=join(f.root,'retired-runtime'), replacement=join(f.root,'replacement');
  const bytes='SYNTHETIC_RETIRED_CONVERSATION_TRACE\n';
  await fs.mkdir(join(replacement,'node-compile-cache'),{recursive:true,mode:0o700});
  await fs.writeFile(join(replacement,'node-compile-cache','conversation.jsonl'),bytes);
  schedule.path=f.cache; schedule.action=async()=>{await fs.rename(f.runtime,retired);await fs.symlink(replacement,f.runtime);};
  await removeLegacyPiCompileCache(f.runtime);
  const observed=await contents(join(replacement,'node-compile-cache','conversation.jsonl'));
  await record('runtime-ancestor-swap',{attack:'replace validated physical runtime with symlink after cache lstat',observed,expected:bytes,runtimeNow:await stat(f.runtime),retiredCache:await contents(join(retired,'node-compile-cache','bytecode'))});
  expect(observed).toBe(bytes);
});

it.each(['cache-symlink','nested-symlink','dotdot','uid-mismatch','final-symlink-race'])('control: preserves external traces for %s',async kind=>{
  const f=await fixture(), trace=join(f.root,'evidence'), bytes='SYNTHETIC_CONTROL_TRACE\n';
  await fs.mkdir(trace,{mode:0o700}); await fs.writeFile(join(trace,'keep.jsonl'),bytes);
  if(kind==='cache-symlink'){await fs.rm(f.cache,{recursive:true});await fs.symlink(trace,f.cache);}
  if(kind==='nested-symlink') await fs.symlink(trace,join(f.cache,'linked'));
  if(kind==='uid-mismatch') vi.spyOn(process,'getuid').mockReturnValue(process.getuid!()+1);
  if(kind==='final-symlink-race'){schedule.path=f.cache;schedule.action=async()=>{await fs.rename(f.cache,join(f.root,'original-cache'));await fs.symlink(trace,f.cache);};}
  const runtime=kind==='dotdot'?f.runtime+'/../pi':f.runtime;
  await removeLegacyPiCompileCache(runtime);
  expect(await fs.readFile(join(trace,'keep.jsonl'),'utf8')).toBe(bytes);
  if(['dotdot','uid-mismatch'].includes(kind)) expect(await fs.readFile(join(f.cache,'bytecode'),'utf8')).toBe('DERIVED');
  await record('control-'+kind,{preserved:true,kind});
});
