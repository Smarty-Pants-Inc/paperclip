// Test fixture: real root installation in a private mount namespace. systemctl
// alone is a fixture; its exact ExecStart runs as the ordinary user. No Boat.
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { BoatIO } from '../runner-support.js';
import { GUARDIAN_DIRECTORY, GUARDIAN_RUNNER_DIRECTORY } from '../guardian-stage.js';
const exec=promisify(execFile);
export async function localGuardian(poison=false) {
 const root=await mkdtemp(join(tmpdir(),'routea-local-'));
 for(const path of ['home','bin','local','run','tmp'])await mkdir(join(root,path),{mode:0o755});
 await mkdir(join(root,'local/libexec'),{mode:0o755});
 await exec('sudo',['-n','chown','root:root',join(root,'local'),join(root,'local/libexec'),join(root,'run')]);
 const home=join(root,'home');
 const tools=['env','sh','bash','setpriv','sudo','flock','pgrep','mkdir','chmod','test','id','cat'];
 for(const tool of tools){await copyFile(await realpath('/usr/bin/'+tool),join(root,'bin',tool));await chmod(join(root,'bin',tool),0o755);}
 // Real sudo binary needs its setuid bit inside this namespace, exactly as on
 // the guest. This touches only the test's own scratch copy.
 await exec('sudo',['-n','chown','root:root',join(root,'bin/sudo')]);
 await exec('sudo',['-n','chmod','4755',join(root,'bin/sudo')]);
 await copyFile(process.execPath,join(root,'bin/node'));await chmod(join(root,'bin/node'),0o755);
 await copyFile(fileURLToPath(new URL('./guardian-systemctl.mjs',import.meta.url)),join(root,'bin/systemctl'));await chmod(join(root,'bin/systemctl'),0o755);
 const state={pid:0,manager:{UNKNOWN_CREDENTIAL:'LOCAL-CANARY',NODE_OPTIONS:'--invalid-node-option',HOME:'/invalid',PATH:'/invalid',LANG:'C'}};
 const statePath=join(home,'.test-systemd.json');await writeFile(statePath,JSON.stringify(state));
 const helper=spawn('sudo',['-n','unshare','--mount','--propagation','private','/bin/sh',fileURLToPath(new URL('./guardian-namespace.sh',import.meta.url)),root,String(process.getuid!()),String(process.getgid!()),process.execPath,fileURLToPath(new URL('./guardian-local-namespace.mjs',import.meta.url)),fileURLToPath(new URL('./guardian-systemctl.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe']});
 const exited=once(helper,'exit'),lines=createInterface({input:helper.stdout}); let stderr='';helper.stderr.on('data',b=>{stderr+=b;});
 let seq=0,starts=0,unit='';
 const pending=new Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:NodeJS.Timeout}>();
 lines.on('line',line=>{let reply;try{reply=JSON.parse(line);}catch{return;}const p=pending.get(reply.id);if(!p)return;pending.delete(reply.id);clearTimeout(p.timer);reply.error?p.reject(Error(reply.error)):p.resolve(reply.result);});
 helper.once('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('namespace exited: '+stderr));}pending.clear();});
 const call=(op:string,args:Record<string,unknown>={}):Promise<any>=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error('namespace timeout '+op+': '+stderr));},35000);pending.set(id,{resolve,reject,timer});helper.stdin.write(JSON.stringify({id,op,...args})+'\n');});
 const local=(p:string)=>p.startsWith('/home/user/')?join(home,p.slice('/home/user/'.length)):p.startsWith('/usr/local/')?join(root,'local',p.slice('/usr/local/'.length)):p.startsWith('/run/')?join(root,'run',p.slice('/run/'.length)):p.startsWith('/tmp/')?join(root,'tmp',p.slice('/tmp/'.length)):p;
 const commands:{command:string,exitCode:number}[]=[],uploads:{path:string,bytes:number}[]=[],signed=new Map<string,string>();
 async function startUnit(){
  unit=await readFile(local('/home/user/.config/systemd/user/paperclip-guardian.service'),'utf8');
  const argv=unit.split('\n').find(l=>l.startsWith('ExecStart='))!.slice(10).split(' ');
  const env:Record<string,string>={...state.manager};
  for(const line of unit.split('\n')){
   if(line.startsWith('Environment=')&&line!=='Environment=')for(const v of line.slice(12).split(' ')){const i=v.indexOf('=');env[v.slice(0,i)]=v.slice(i+1);}
   if(line.startsWith('UnsetEnvironment='))for(const name of line.slice(17).split(' '))delete env[name];
  }
  if(poison)env.AFTER_STAGE_CREDENTIAL='LOCAL-CANARY';
  const started=await call('start',{argv,env});state.pid=started.pid;starts++;await writeFile(statePath,JSON.stringify(state));
 }
 const io:BoatIO={
  async request(_path,init){const p=JSON.parse(String(init?.body)).path,url='https://routea-upload.test/'+signed.size;signed.set(url,p);return{url};},
  async run(command,timeout){
   try{const result=await call('run',{command,timeout});commands.push({command,exitCode:0});if(command.includes('paperclip-guardian:service')&&!state.pid)await startUnit();return result;}
   catch(error){commands.push({command,exitCode:1});console.error('LOCAL_MAINTENANCE_FAILURE',String(error));throw error;}
  }
 };
 const uploadFetch=async(url:string|URL,init:RequestInit)=>{const path=signed.get(String(url));if(!path)throw Error('unknown upload');if(new Headers(init.headers).has('authorization'))throw Error('credential on signed PUT');const bytes=Buffer.from(init.body as Uint8Array);await writeFile(local(path),bytes);uploads.push({path,bytes:bytes.length});return new Response(null,{status:204});};
 async function close(){
  let receipt;
  try{receipt=await call('close');}finally{helper.stdin.end();lines.close();for(const p of pending.values())clearTimeout(p.timer);await exited;await exec('sudo',['-n','rm','-rf','--',root]);}
  return receipt;
 }
 async function stopUnit(){const receipt=await call('stop-unit');state.pid=0;await writeFile(statePath,JSON.stringify(state));return receipt;}
 return{root,home,local,io,uploadFetch,call,close,stopUnit,commands,uploads,get unit(){return unit;},get starts(){return starts;},get pid(){return state.pid;}};
}
