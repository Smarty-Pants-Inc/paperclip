// Keep: executes root install, real guardian and exact unit argv in a private
// mount namespace. Requires Linux + authorized local passwordless sudo.
import { afterEach, expect, it, vi } from 'vitest';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { localGuardian } from './test-fixtures/guardian-local.js';
import { GUARDIAN_DIRECTORY, GUARDIAN_FILES, GUARDIAN_RUNNER_DIRECTORY, guardianUnitContent, stageGuardian } from './guardian-stage.js';
import { GUARDIAN_ENTRY, GUARDIAN_SOCKET } from './guardian-contract.js';
const exec=promisify(execFile);
afterEach(()=>vi.unstubAllGlobals());
it.each([false,true])('stages root-owned S9 code and preserves the exact resident; manager drift=%s',async poison=>{
 const f=await localGuardian(poison);vi.stubGlobal('fetch',f.uploadFetch);
 try{
  if(poison){await expect(stageGuardian({duplexCarrier:'ssh'},'bx_local',f.io)).rejects.toMatchObject({code:'BOAT_GUARDIAN_PREFLIGHT_FAILED'});return;}
  const acquired=await stageGuardian({duplexCarrier:'ssh'},'bx_local',f.io);
  expect(acquired).toMatchObject({usable:true,active:true,status:{state:'empty'},coldStartRequired:true,socketPath:GUARDIAN_SOCKET});
  expect(f.unit).toContain(`ExecStart=/usr/bin/node ${GUARDIAN_DIRECTORY}/paperclip-runner-guardian serve ${GUARDIAN_RUNNER_DIRECTORY}\n`);
  expect(f.unit).toContain('Restart=no\n');
  for(const name of GUARDIAN_FILES){const s=await lstat(f.local(`${GUARDIAN_DIRECTORY}/${name}`));expect({uid:s.uid,gid:s.gid,mode:s.mode&0o777}).toEqual({uid:0,gid:0,mode:0o444});}
  const entry=await lstat(f.local(GUARDIAN_ENTRY));expect({uid:entry.uid,gid:entry.gid,mode:entry.mode&0o777}).toEqual({uid:0,gid:0,mode:0o755});
  expect((await lstat(f.local(GUARDIAN_SOCKET))).mode&0o777).toBe(0o600);
  const pid=f.pid,resumed=await stageGuardian({duplexCarrier:'ssh'},'bx_local',f.io,{guardianPreflight:acquired});
  expect(resumed).toMatchObject({machine:'same',status:{state:'empty'},coldStartRequired:true});expect(f.pid).toBe(pid);expect(f.starts).toBe(1);expect(f.uploads).toHaveLength(8);
  const path=f.local(`${GUARDIAN_DIRECTORY}/protocol.mjs`),original=await readFile(path);
  await exec('sudo',['-n','chmod','666',path]);await writeFile(path,Buffer.concat([original,Buffer.from('\n// changed')]));await exec('sudo',['-n','chmod','444',path]);
  await expect(stageGuardian({duplexCarrier:'ssh'},'bx_local',f.io)).rejects.toMatchObject({code:'BOAT_GUARDIAN_PREPARE_FAILED'});
  expect(f.starts).toBe(1);expect(f.uploads).toHaveLength(8);
  const env=await f.call('environment');expect(env).not.toContain('LOCAL-CANARY');expect(env).not.toContain('NODE_OPTIONS');
  const proof={acquired,resumed,starts:f.starts,rootOwned:true,entryMode:'0755',moduleMode:'0444',refusedLiveRewrite:true,systemd:'fixture; exact ExecStart real resident'};
  console.log('ROUTEA_STAGE',JSON.stringify(proof));
  if(process.env.ROUTEA_EVIDENCE)await writeFile(join(process.env.ROUTEA_EVIDENCE,'staging.json'),JSON.stringify(proof,null,2));
 }finally{const cleanup=await f.close();console.log('ROUTEA_STAGE_CLEANUP',JSON.stringify(cleanup));}
},45000);
it('reprovisions volatile /run with unchanged installed code and reports cold evidence',async()=>{
 const f=await localGuardian();vi.stubGlobal('fetch',f.uploadFetch);
 try{
  await stageGuardian({duplexCarrier:'ssh'},'bx_local',f.io);const oldPid=f.pid;
  await f.stopUnit();await exec('sudo',['-n','rm','-rf','--',f.local('/run/paperclip-runner-guardian')]);
  const result=await stageGuardian({duplexCarrier:'ssh'},'bx_local',f.io,{boot_id:'22222222-2222-4222-8222-222222222222'});
  expect(result).toMatchObject({usable:true,machine:'new',status:{state:'empty'},coldStartRequired:true});
  expect(f.starts).toBe(2);expect(f.pid).not.toBe(oldPid);expect(f.uploads).toHaveLength(8);
  if(process.env.ROUTEA_EVIDENCE)await writeFile(join(process.env.ROUTEA_EVIDENCE,'cold-preflight.json'),JSON.stringify({result,oldPid,newPid:f.pid,uploads:f.uploads.length,provenance:'local /run removal and deliberately different prior boot metadata; not a real VM reboot'},null,2));
 }finally{await f.close();}
},45000);
it('removes manager variable names without persisting their values',()=>{
 const unit=guardianUnitContent(['UNRECOGNIZED_SECRET','NODE_OPTIONS','HOME']);
 expect(unit).toContain('UnsetEnvironment=LOGNAME NODE_OPTIONS NODE_PATH SHELL UNRECOGNIZED_SECRET USER\n');
 expect(()=>guardianUnitContent(['NAME=secret'])).toThrow('BOAT_GUARDIAN_SERVICE_FAILED');
});
