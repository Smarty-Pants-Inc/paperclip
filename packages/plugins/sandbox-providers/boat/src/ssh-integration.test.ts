// Keep: real loopback SSH -> exact forced command -> staged S9 guardian ->
// real fd4 fake native process. No Boat calls or live continuity claims.
import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, rm, appendFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import net from 'node:net';
import { startWorkerRpcHost, encodeChannelBytes, decodeChannelBytes, DUPLEX_CHANNEL_DATA_NOTIFICATION, DUPLEX_CHANNEL_EXIT_NOTIFICATION } from '@paperclipai/plugin-sdk';
import { BoatSshCarrier, sshRoundTrip, type SshEndpoint } from './ssh-carrier.js';
import { IMAGE_PREFLIGHT, type KeyApi } from './ssh-keys.js';
import { guardianCommand, GUARDIAN_ENTRY } from './guardian-contract.js';
import { stageGuardian } from './guardian-stage.js';
import { localGuardian } from './test-fixtures/guardian-local.js';
// @ts-expect-error Test-only dependency-free S9 frames copied from the Core fixtures.
import { sha, qualify, launch, observe, park, claim, retire, source, wire } from './test-fixtures/s9-frames.mjs';
const exec=promisify(execFile),cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{const errors=[];try{for(const c of cleanups.splice(0).reverse())try{await c();}catch(e){errors.push(e);}}finally{vi.unstubAllGlobals();}if(errors.length)throw new AggregateError(errors,'cleanup failed');});
const scope={driverKey:'boat',companyId:'company',environmentId:'environment',providerLeaseId:'bx_sshfixture',config:{apiKey:'fixture-not-a-credential',duplexCarrier:'ssh',reuseLease:true}};
async function evidence(kind:string,data:unknown){if(process.env.ROUTEA_EVIDENCE)await appendFile(join(process.env.ROUTEA_EVIDENCE,'ssh-measurements.jsonl'),JSON.stringify({kind,data})+'\n');}
async function fixture(mode=''){
 const f=await localGuardian();cleanups.push(()=>f.close());vi.stubGlobal('fetch',f.uploadFetch);
 const preflight=await stageGuardian(scope.config,scope.providerLeaseId,f.io);
 const lease={...scope,guardianPreflight:preflight,runnerId:'runner'};
 const keys=join(f.home,'.ssh/authorized_keys');await mkdir(dirname(keys),{mode:0o700});await writeFile(keys,'# operator-owned sentinel\n',{mode:0o600});
 await exec('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(f.home,'host')]);
 const hostKey=(await readFile(join(f.home,'host.pub'),'utf8')).trim().split(' ').slice(0,2).join(' ');
 const reserve=net.createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
 await writeFile(join(f.home,'sshd_config'),`Port ${port}\nListenAddress 127.0.0.1\nHostKey /home/user/host\nAuthorizedKeysFile /home/user/.ssh/authorized_keys\nPidFile /home/user/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nStrictModes no\nLogLevel VERBOSE\n`);
 await f.call('sshd',{config:'/home/user/sshd_config'});
 await mkdir(join(f.home,'native'),{mode:0o700});
 const fake=await readFile(new URL('./test-fixtures/s9-runnerd.mjs',import.meta.url),'utf8');
 const bytes=Buffer.from('#!/usr/bin/node\n'+fake);await writeFile(join(f.home,'native/runnerd'),bytes,{mode:0o700});
 const q=qualify('/home/user/native/runnerd',`sha256:${sha(bytes)}`),l=launch('/home/user/native/runnerd','/home/user/native',{FAKE_MODE:mode,FAKE_DELAY_MS:'500',FAKE_PROOF_FILE:'/home/user/effects.json'});
 await writeFile(join(f.home,'effects.json'),'{}');
 let registrations=0,preflights=0;
 const api:KeyApi={
  async request(path,init){
   if(path.endsWith('/sshkey')){registrations++;await appendFile(keys,JSON.parse(String(init?.body)).key+'\n');return{hostKey,sshEndpoint:`127.0.0.1:${port}`,machineIp:'192.0.2.99',sshUser:userInfo().username};}
   if(path.endsWith('/files/upload-url'))return f.io.request(path,init);
   if(init?.method==='PUT'){const b=JSON.parse(String(init.body));await writeFile(f.local(b.path),b.content);return{};}
   if(init?.method==='DELETE'){const p=new URL('http://fixture'+path).searchParams.get('path')!;await rm(f.local(p),{force:true});return{};}
   throw Error('unexpected fixture API '+path);
  },
  async run(command,timeout){if(command===IMAGE_PREFLIGHT)preflights++;try{return await f.io.run(command,timeout);}catch{return{exitCode:1,timedOut:false,stdout:'',stderr:''};}}
 };
 const carrier=new BoatSshCarrier(()=>api);cleanups.push(()=>carrier.close());
 const rpc=async(e:SshEndpoint,frame:unknown)=>JSON.parse(await sshRoundTrip(e,Buffer.from(wire(frame))));
 const start=async(e:SshEndpoint)=>{expect((await rpc(e,q)).status).toBe('qualified');expect((await rpc(e,l)).status).toBe('launched');expect((await rpc(e,observe)).status).toBe('observed');};
 return{...f,keys,api,carrier,lease,q,l,rpc,start,hostKey,port,proof:join(f.home,'effects.json'),registrations:()=>registrations,preflights:()=>preflights,log:()=>f.call('sshlog')};
}
async function waitEffect(path:string,id:string){await new Promise<void>((resolve,reject)=>{let done=false;const finish=(e?:Error)=>{if(done)return;done=true;clearTimeout(timer);w.close();e?reject(e):resolve();};const check=async()=>{try{if(JSON.parse(await readFile(path,'utf8'))[id])finish();}catch{}};const w=watch(dirname(path),()=>void check()),timer=setTimeout(()=>finish(Error('effect deadline')),4000);void check();});}
it('real S9 launch observe park claim exact retry retire uses one multiplexed authentication',async()=>{
 const f=await fixture(),timings:Record<string,number>={};let t=performance.now();const e=await f.carrier.prepare(f.lease);timings.coldPrepare=performance.now()-t;
 for(const [name,frame,status] of [['qualify',f.q,'qualified'],['launch',f.l,'launched'],['observe',observe,'observed'],['park',park,'parked'],['claim',claim(),'claimed'],['retry',claim(),'claimed'],['retire',retire(claim()),'retired']] as const){t=performance.now();const reply=await f.rpc(e,frame);timings[name]=performance.now()-t;expect(reply.id).toBe(frame.id);expect(reply.status).toBe(status);if(name==='retire')expect(reply).toMatchObject({executionStopped:true,descendantsStopped:true,sessionStateAvailable:true});}
 await f.carrier.health(f.lease);expect(f.registrations()).toBe(1);expect(f.preflights()).toBe(1);const log=await f.log();expect((log.match(/Accepted publickey/g)??[])).toHaveLength(1);expect(log).toContain('forced-command');
 const key=await readFile(f.keys,'utf8');expect(key).toContain(`restrict,command="${guardianCommand('runner').join(' ')}"`);
 expect(JSON.parse(await readFile(f.proof,'utf8'))).toEqual({[park.id]:1,[claim().id]:1,[retire(claim()).id]:1});
 await f.carrier.retire(f.lease);expect(await readFile(f.keys,'utf8')).toBe('# operator-owned sentinel\n');
 await evidence('S9_END_TO_END',{timings,sshAuthentications:1,forcedCommand:guardianCommand('runner'),nativeApplications:3,retireProof:true,systemd:'fixture; real exact unit process',provider:'local API fixture'});
},30000);
it('forced command refuses a changed SSH_ORIGINAL_COMMAND and a different Runner',async()=>{
 const f=await fixture(),e=await f.carrier.prepare(f.lease);
 for(const command of ['/bin/sh',guardianCommand('other-runner').join(' '),guardianCommand('runner').join(' ')+' extra']){
  const result=await exec('ssh',['-o','ControlMaster=no','-o','ProxyCommand=/bin/false',...e.args,command],{env:e.env,input:undefined} as any).then(x=>x,(x:any)=>x);
  expect(result.code).toBe(1);expect(JSON.parse(result.stdout).error.code).toBe('UNTRUSTED_SSH_COMMAND');
 }
 await f.start(e);await evidence('EXACT_COMMAND_REFUSAL',{attempts:3,subsequentExactLaunch:true});
},30000);
it('two independent workers replay one claim and retirement preserves the other key',async()=>{
 const f=await fixture(),other=new BoatSshCarrier(()=>f.api);cleanups.push(()=>other.close());const[a,b]=await Promise.all([f.carrier.prepare(f.lease),other.prepare(f.lease)]);await f.start(a);await f.rpc(a,park);
 const[first,replay]=await Promise.all([f.rpc(a,claim()),f.rpc(b,claim())]);expect(first).toEqual(replay);expect(first.status).toBe('claimed');expect((await f.rpc(a,{...claim(),bootstrapTicket:'changed'})).status).toBe('refused');expect(JSON.parse(await readFile(f.proof,'utf8'))[claim().id]).toBe(1);
 expect((await readFile(f.keys,'utf8')).match(/restrict,command=/g)).toHaveLength(2);await f.carrier.retire(f.lease);expect((await readFile(f.keys,'utf8')).match(/restrict,command=/g)).toHaveLength(1);expect((await f.rpc(b,retire(claim()))).status).toBe('retired');
 await evidence('TWO_WORKERS',{claimApplications:1,otherWorkerPreserved:true});
},30000);
it('D4 transport loss after native claim admission is typed uncertainty; exact retry applies once',async()=>{
 const f=await fixture('delay-claim'),e=await f.carrier.prepare(f.lease);await f.start(e);await f.rpc(e,park);
 const lost=sshRoundTrip(e,Buffer.from(wire(claim()))),failed=expect(lost).rejects.toMatchObject({code:'BOAT_SSH_SESSION_LOST'});await waitEffect(f.proof,claim().id);await exec('ssh',['-O','exit',...e.args],{env:e.env,timeout:3000});await failed;
 const fresh=await f.carrier.prepare(f.lease);expect(fresh).not.toBe(e);expect((await f.rpc(fresh,claim())).status).toBe('claimed');expect(JSON.parse(await readFile(f.proof,'utf8'))[claim().id]).toBe(1);expect((await f.rpc(fresh,retire(claim()))).status).toBe('retired');await evidence('D4',{typedFailure:true,exactReplay:true,claimApplications:1});
},30000);
it.each([false,true])('accepts a changed host pin only after one API refresh; refreshed=%s',async refreshed=>{
 const f=await fixture();await exec('ssh-keygen',['-q','-t','ed25519','-N','','-f',join(f.home,'wrong')]);const wrong=(await readFile(join(f.home,'wrong.pub'),'utf8')).trim().split(' ').slice(0,2).join(' ');let calls=0;
 const carrier=new BoatSshCarrier(()=>({...f.api,request:async(path,init)=>{const r=await f.api.request(path,init);if(path.endsWith('/sshkey')){calls++;if(!refreshed||calls===1)return{...r,hostKey:wrong};}return r;}}));cleanups.push(()=>carrier.close());
 if(refreshed){await f.start(await carrier.prepare(f.lease));}else await expect(carrier.prepare(f.lease)).rejects.toMatchObject({code:'BOAT_SSH_HOST_KEY_MISMATCH'});expect(calls).toBe(2);await evidence('HOST_PIN',{refreshed,calls});
},30000);
it('off/preflight failure registers nothing; retirement/shutdown remove exact keys',async()=>{
 const f=await fixture();await expect(f.carrier.prepare({...f.lease,config:{...scope.config,duplexCarrier:'off'}})).rejects.toMatchObject({code:'BOAT_SSH_DISABLED'});await expect(f.carrier.prepare({...f.lease,guardianPreflight:undefined})).rejects.toMatchObject({code:'BOAT_SSH_PREFLIGHT_FAILED'});expect(f.registrations()).toBe(0);
 const e=await f.carrier.prepare(f.lease);await f.carrier.retire(f.lease);expect(e.dead).toBe(true);const renewed=await f.carrier.prepare(f.lease);await f.carrier.close();expect(renewed.dead).toBe(true);expect(await readFile(f.keys,'utf8')).toBe('# operator-owned sentinel\n');
},30000);
it('retirement fences registration in flight, joins concurrent teardown, then revokes the key',async()=>{
 const f=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),wait=new Promise<void>(r=>{release=r;});
 const carrier=new BoatSshCarrier(()=>({...f.api,request:async(path,init)=>{const r=await f.api.request(path,init);if(path.endsWith('/sshkey')){entered();await wait;}return r;}}));cleanups.push(()=>carrier.close());const pending=carrier.prepare(f.lease),failed=expect(pending).rejects.toMatchObject({code:'BOAT_SSH_CLOSED'});await started;const a=carrier.retire(f.lease),b=carrier.retire(f.lease);release();await failed;await Promise.all([a,b]);expect(await readFile(f.keys,'utf8')).toBe('# operator-owned sentinel\n');
},30000);
it('unconfirmed retirement remains retryable; no replacement key is issued',async()=>{
 const f=await fixture();let fail=false;const carrier=new BoatSshCarrier(()=>({...f.api,run:async(c,t)=>fail&&c.includes('-retire.mjs')?{exitCode:1,timedOut:false,stdout:'',stderr:''}:f.api.run(c,t)}));cleanups.push(()=>carrier.close());await carrier.prepare(f.lease);fail=true;await expect(carrier.retire(f.lease)).rejects.toMatchObject({code:'BOAT_SSH_RETIRE_FAILED'});await expect(carrier.prepare(f.lease)).rejects.toMatchObject({code:'BOAT_SSH_RETIRE_PENDING'});fail=false;await carrier.retire(f.lease);expect(await readFile(f.keys,'utf8')).toBe('# operator-owned sentinel\n');
},30000);
it('real SDK all four hooks carry S9 and release/resume re-preflights the same allocation',async()=>{
 const f=await fixture();const{default:plugin}=await import('./plugin.js'),{default:manifest}=await import('./manifest.js');const response=(x:unknown)=>new Response(JSON.stringify(x));
 vi.stubGlobal('fetch',async(url:any,init?:RequestInit)=>{
  if(String(url).startsWith('https://routea-upload.test/'))return f.uploadFetch(url,init!);
  const u=new URL(String(url)),path=u.pathname.replace('/api/v1','')+u.search;
  if(path==='/sandboxes'||path===`/sandboxes/${scope.providerLeaseId}`||path.endsWith('/resume'))return response({sandbox:{id:scope.providerLeaseId,state:'ready'}});
  if(path.endsWith('/stops/stop'))return response({stop:{status:'completed'}});if(path.endsWith('/stop'))return response({operation:{id:'stop'}});
  if(path.endsWith('/commands')){const b=JSON.parse(String(init?.body));return response(await f.api.run(b.command,b.timeoutSeconds*1000));}return response(await f.api.request(path,init));
 });
 const input=new PassThrough(),output=new PassThrough(),lines=createInterface({input:output}),host=startWorkerRpcHost({plugin,stdin:input,stdout:output,rpcTimeoutMs:10000});let seq=0;
 const pending=new Map<string,{resolve:(v:any)=>void,reject:(v:any)=>void,timer:NodeJS.Timeout}>(),notifications=new Map<string,{text:string,resolve:(v:any)=>void}>();
 lines.on('line',line=>{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method===DUPLEX_CHANNEL_DATA_NOTIFICATION){notifications.get(m.params.hostRouteId)!.text+=Buffer.from(decodeChannelBytes(m.params.chunk)!).toString();}else if(m.method===DUPLEX_CHANNEL_EXIT_NOTIFICATION)notifications.get(m.params.hostRouteId)?.resolve(m.params);else if(m.method&&m.id!==undefined)input.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:null})+'\n');});
 const rpc=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{const id='rpc-'+(++seq),timer=setTimeout(()=>{pending.delete(id);reject(Error('SDK timeout'));},12000);pending.set(id,{resolve,reject,timer});input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 cleanups.push(async()=>{try{await plugin.definition.onShutdown!();}finally{host.stop();lines.close();input.destroy();output.destroy();for(const p of pending.values())clearTimeout(p.timer);}});
 const init=await rpc('initialize',{manifest,config:{},apiVersion:1,instanceInfo:{instanceId:'routea-local',hostVersion:'test'}});expect(init.supportedMethods).toEqual(expect.arrayContaining(['duplexChannelOpen','duplexChannelWrite','duplexChannelStop','duplexChannelClose']));
 const acquired=await rpc('environmentAcquireLease',{...scope,runId:'run',agentId:'agent',executionWorkspaceId:'workspace',adapterType:'paperclip_runner'});expect(acquired.metadata.runnerGuardianVersion).toBe(1);
 for(const frame of[f.q,f.l,observe,park,claim(),claim(),retire(claim())]){
  const route='sdk-'+(++seq);let finish!:(v:any)=>void;const exited=new Promise(r=>{finish=r;}),n={text:'',resolve:finish};notifications.set(route,n);
  const ch=await rpc('duplexChannelOpen',{...scope,hostRouteId:route,command:guardianCommand('runner')});await rpc('duplexChannelWrite',{...ch,data:encodeChannelBytes(Buffer.from(wire(frame)))});const end:any=await exited;expect(end.transportClosed).toBe(false);expect(end.exitCode).toBe(0);expect(JSON.parse(n.text).id).toBe(frame.id);expect(JSON.parse(n.text).status).not.toBe('refused');await rpc('duplexChannelClose',{hostRouteId:route});
 }
 const stopped=await rpc('duplexChannelOpen',{...scope,hostRouteId:'sdk-stop',command:guardianCommand('runner')});await rpc('duplexChannelStop',stopped);await rpc('duplexChannelClose',{hostRouteId:'sdk-stop'});
 await rpc('configChanged',{companyId:'foreign',config:{duplexCarrier:'off'}});expect(await readFile(f.keys,'utf8')).toContain('restrict,command=');
 expect(await rpc('environmentReleaseLease',scope)).toMatchObject({state:'stopped'});expect(await readFile(f.keys,'utf8')).toBe('# operator-owned sentinel\n');
 const resumed=await rpc('environmentResumeLease',{...scope,leaseMetadata:acquired.metadata});expect(resumed.providerLeaseId).toBe(scope.providerLeaseId);expect(resumed.metadata.runnerGuardianVersion).toBe(1);expect(resumed.metadata.guardianPreflight.machine).toBe('same');
 const ch=await rpc('duplexChannelOpen',{...scope,hostRouteId:'sdk-resume',command:guardianCommand('runner')});await rpc('duplexChannelStop',ch);
 await rpc('configChanged',{companyId:scope.companyId,config:{duplexCarrier:'off'}});expect(await readFile(f.keys,'utf8')).toContain('restrict,command=');
 await rpc('configChanged',{config:{unrelated:true}});expect(await readFile(f.keys,'utf8')).toContain('restrict,command=');
 const disabled=await rpc('environmentResumeLease',{...scope,config:{...scope.config,duplexCarrier:'off'},leaseMetadata:resumed.metadata});
 expect(disabled.metadata.runnerGuardianVersion).toBeUndefined();expect(disabled.metadata.guardianPreflight).toBeUndefined();
 expect(await readFile(f.keys,'utf8')).toBe('# operator-owned sentinel\n');await expect(rpc('duplexChannelOpen',{...scope,hostRouteId:'sdk-off',command:guardianCommand('runner')})).rejects.toMatchObject({message:'BOAT_SSH_LEASE_UNBOUND'});
 await evidence('SDK_S9',{fourHooks:true,marker:true,releaseConfirmedStop:true,resumeSameSandbox:true,repreflight:true,foreignCompanyPreserved:true,unrelatedConfigPreserved:true,scopedOffRevoked:true,offMarkerRemoved:true});
},45000);
it('recovers its own interrupted public-key rewrite without a stale bootstrap wedge',async()=>{
 const f=await fixture();await f.carrier.prepare(f.lease);const worker=/paperclip-boat-carrier:([^:]+):\d+/.exec(await readFile(f.keys,'utf8'))![1];await f.carrier.invalidate(f.lease);const stale=join(f.home,'.ssh','.paperclip-key-'+worker);await writeFile(stale,'interrupted',{mode:0o600});await f.start(await f.carrier.prepare(f.lease));await expect(readFile(stale)).rejects.toMatchObject({code:'ENOENT'});expect((await readFile(f.keys,'utf8')).match(/restrict,command=/g)).toHaveLength(1);
},30000);
