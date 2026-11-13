// Shared Route A judge fixture: real SSH and staged S9; fixture Boat API and fd4 Runner.
import { afterEach, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import { watch } from "node:fs";
import { userInfo } from "node:os";
import { join, dirname } from "node:path";
import net from "node:net";
import { startWorkerRpcHost, encodeChannelBytes, decodeChannelBytes, DUPLEX_CHANNEL_DATA_NOTIFICATION, DUPLEX_CHANNEL_EXIT_NOTIFICATION } from "@paperclipai/plugin-sdk";
import { BoatSshCarrier, sshRoundTrip, type SshEndpoint } from "../ssh-carrier.js";
import { IMAGE_PREFLIGHT, type KeyApi } from "../ssh-keys.js";
import { guardianCommand } from "../guardian-contract.js";
import { stageGuardian } from "../guardian-stage.js";
import { localGuardian } from "./guardian-local.js";
// @ts-expect-error Dependency-free S9 fixture.
import { sha, qualify, launch, observe, wire } from "./s9-frames.mjs";
export const exec=promisify(execFile), cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{const errors=[];try{for(const c of cleanups.splice(0).reverse())try{await c();}catch(e){errors.push(e);}}finally{vi.restoreAllMocks();vi.unstubAllGlobals();}if(errors.length)throw new AggregateError(errors,"cleanup failed");});
export const scope={driverKey:"boat",companyId:"company",environmentId:"environment",providerLeaseId:"bx_sshfixture",config:{apiKey:"fixture-not-a-credential",duplexCarrier:"ssh",reuseLease:true}};
export async function obs(kind:string,data:unknown){if(process.env.JUDGE_OBS)await appendFile(process.env.JUDGE_OBS,JSON.stringify({kind,data})+"\n");}
export async function fixture(mode=""){
 const f=await localGuardian();cleanups.push(()=>f.close());vi.stubGlobal("fetch",f.uploadFetch);
 const preflight=await stageGuardian(scope.config,scope.providerLeaseId,f.io);
 const lease={...scope,guardianPreflight:preflight,runnerId:"runner"};
 const keys=join(f.home,".ssh/authorized_keys");await mkdir(dirname(keys),{mode:0o700});await writeFile(keys,"# operator-owned sentinel\n",{mode:0o600});
 await exec("ssh-keygen",["-q","-t","ed25519","-N","","-f",join(f.home,"host")]);
 const hostKey=(await readFile(join(f.home,"host.pub"),"utf8")).trim().split(" ").slice(0,2).join(" ");
 const reserve=net.createServer();await new Promise<void>(r=>reserve.listen(0,"127.0.0.1",r));const port=(reserve.address() as net.AddressInfo).port;await new Promise<void>(r=>reserve.close(()=>r()));
 await writeFile(join(f.home,"sshd_config"),`Port ${port}\nListenAddress 127.0.0.1\nHostKey /home/user/host\nAuthorizedKeysFile /home/user/.ssh/authorized_keys\nPidFile /home/user/sshd.pid\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nStrictModes no\nLogLevel VERBOSE\n`);
 const sshd=await f.call("sshd",{config:"/home/user/sshd_config"});
 await mkdir(join(f.home,"native"),{mode:0o700});
 const fake=await readFile(new URL("./s9-runnerd.mjs",import.meta.url),"utf8"),bytes=Buffer.from("#!/usr/bin/node\n"+fake);
 await writeFile(join(f.home,"native/runnerd"),bytes,{mode:0o700});
 const q=qualify("/home/user/native/runnerd",`sha256:${sha(bytes)}`),l=launch("/home/user/native/runnerd","/home/user/native",{FAKE_MODE:mode,FAKE_DELAY_MS:"1000",FAKE_PROOF_FILE:"/home/user/effects.json"});
 await writeFile(join(f.home,"effects.json"),"{}");let registrations=0,preflights=0;
 const api:KeyApi={
  async request(path,init){
   if(path.endsWith("/sshkey")){registrations++;await appendFile(keys,JSON.parse(String(init?.body)).key+"\n");return{hostKey,sshEndpoint:`127.0.0.1:${port}`,machineIp:"192.0.2.99",sshUser:userInfo().username};}
   if(path.endsWith("/files/upload-url"))return f.io.request(path,init);
   if(init?.method==="PUT"){const b=JSON.parse(String(init.body));await writeFile(f.local(b.path),b.content);return{};}
   if(init?.method==="DELETE"){const p=new URL("http://fixture"+path).searchParams.get("path")!;await rm(f.local(p),{force:true});return{};}
   throw Error("unexpected fixture API "+path);
  },
  async run(command,timeout){if(command===IMAGE_PREFLIGHT)preflights++;try{return await f.io.run(command,timeout);}catch{return{exitCode:1,timedOut:false,stdout:"",stderr:""};}}
 };
 const carrier=new BoatSshCarrier(()=>api);cleanups.push(()=>carrier.close());
 const rpc=async(e:SshEndpoint,frame:unknown)=>JSON.parse(await sshRoundTrip(e,Buffer.from(wire(frame))));
 const start=async(e:SshEndpoint)=>{expect((await rpc(e,q)).status).toBe("qualified");expect((await rpc(e,l)).status).toBe("launched");expect((await rpc(e,observe)).status).toBe("observed");};
 return{...f,sshdPid:sshd.pid as number,keys,api,carrier,lease,q,l,rpc,start,hostKey,port,proof:join(f.home,"effects.json"),registrations:()=>registrations,preflights:()=>preflights,log:()=>f.call("sshlog")};
}
export async function waitEffect(path:string,id:string){await new Promise<void>((resolve,reject)=>{let done=false;const finish=(e?:Error)=>{if(done)return;done=true;clearTimeout(timer);w.close();e?reject(e):resolve();};const check=async()=>{try{if(JSON.parse(await readFile(path,"utf8"))[id])finish();}catch{}};const w=watch(dirname(path),()=>void check()),timer=setTimeout(()=>finish(Error("effect deadline")),4000);void check();});}
export async function masterPid(e:SshEndpoint){const r=await exec("ssh",["-O","check",...e.args],{env:e.env,timeout:3000});const id=Number(/pid=(\d+)/.exec(r.stdout+r.stderr)?.[1]);if(!id)throw Error("missing master PID");return id;}
export async function sdk(f:Awaited<ReturnType<typeof fixture>>){
 vi.resetModules();const{default:plugin}=await import("../plugin.js"),{default:manifest}=await import("../manifest.js");
 const {BoatSshCarrier:WorkerCarrier}=await import("../ssh-carrier.js");const warm=vi.spyOn(WorkerCarrier.prototype,"prewarm");
 const ctl={failRetire:false,retireCalls:0,stopCalls:0,destroyCalls:0};
 const response=(x:unknown)=>new Response(JSON.stringify(x));
 vi.stubGlobal("fetch",async(url:any,init?:RequestInit)=>{
  if(String(url).startsWith("https://routea-upload.test/"))return f.uploadFetch(url,init!);
  const u=new URL(String(url)),path=u.pathname.replace("/api/v1","")+u.search;
  if(path===`/sandboxes/${scope.providerLeaseId}`&&init?.method==="DELETE"){ctl.destroyCalls++;throw Error("sandbox DELETE forbidden");}
  if(path==="/sandboxes"||path===`/sandboxes/${scope.providerLeaseId}`||path.endsWith("/resume"))return response({sandbox:{id:scope.providerLeaseId,state:"ready"}});
  if(path.endsWith("/stops/stop"))return response({stop:{status:"completed"}});
  if(path.endsWith("/stop")){ctl.stopCalls++;return response({operation:{id:"stop"}});}
  if(path.endsWith("/commands")){const b=JSON.parse(String(init?.body));if(b.command.includes("-retire.mjs")){ctl.retireCalls++;if(ctl.failRetire)return response({exitCode:1,timedOut:false,stdout:"",stderr:""});}return response(await f.api.run(b.command,b.timeoutSeconds*1000));}
  return response(await f.api.request(path,init));
 });
 const input=new PassThrough(),output=new PassThrough(),lines=createInterface({input:output}),host=startWorkerRpcHost({plugin,stdin:input,stdout:output,rpcTimeoutMs:10000});let seq=0;
 const pending=new Map<string,{resolve:(v:any)=>void,reject:(v:any)=>void,timer:NodeJS.Timeout}>(),notifications=new Map<string,{text:string,resolve:(v:any)=>void}>();
 lines.on("line",line=>{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(m.error):p.resolve(m.result);}else if(m.method===DUPLEX_CHANNEL_DATA_NOTIFICATION){notifications.get(m.params.hostRouteId)!.text+=Buffer.from(decodeChannelBytes(m.params.chunk)!).toString();}else if(m.method===DUPLEX_CHANNEL_EXIT_NOTIFICATION)notifications.get(m.params.hostRouteId)?.resolve(m.params);else if(m.method&&m.id!==undefined)input.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:null})+"\n");});
 const rpc=(method:string,params:unknown):Promise<any>=>new Promise((resolve,reject)=>{const id="rpc-"+(++seq),timer=setTimeout(()=>{pending.delete(id);reject(Error("SDK timeout"));},12000);pending.set(id,{resolve,reject,timer});input.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
 cleanups.push(async()=>{ctl.failRetire=false;try{await plugin.definition.onShutdown!();}finally{warm.mockRestore();host.stop();lines.close();input.destroy();output.destroy();for(const p of pending.values())clearTimeout(p.timer);}});
 const initialized=await rpc("initialize",{manifest,config:{},apiVersion:1,instanceInfo:{instanceId:"foldin2-local",hostVersion:"test"}});
 const acquire=()=>rpc("environmentAcquireLease",{...scope,runId:"run",agentId:"agent",executionWorkspaceId:"workspace",adapterType:"paperclip_runner"});
 const open=(route="open-"+(++seq))=>rpc("duplexChannelOpen",{...scope,hostRouteId:route,command:guardianCommand("runner")});
 const op=async(frame:unknown)=>{
  const route="op-"+(++seq);let finish!:(v:any)=>void;const exited=new Promise<any>(r=>{finish=r;}),n={text:"",resolve:finish};notifications.set(route,n);
  const ch=await open(route);await rpc("duplexChannelWrite",{...ch,data:encodeChannelBytes(Buffer.from(wire(frame)))});
  const end=await exited;await rpc("duplexChannelClose",{hostRouteId:route});return{reply:n.text ? JSON.parse(n.text) : null,end};
 };
 const start=async()=>{for(const [frame,status] of [[f.q,"qualified"],[f.l,"launched"],[observe,"observed"]])expect((await op(frame)).reply.status).toBe(status);};
 return{rpc,acquire,open,op,start,ctl,initialized,carrier:()=>warm.mock.instances[0] as any};
}
