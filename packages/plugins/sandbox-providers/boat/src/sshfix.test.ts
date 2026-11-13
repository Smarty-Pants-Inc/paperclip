// Keep: F1–F6 trust-boundary and transport regressions, ported to Route A's real S9.
// Original legacy judge probes are retained and run separately; not relabeled green.
import { expect, it, vi } from "vitest";
import { readFile, lstat, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BoatSshCarrier, connectSsh, sshRoundTrip, type SshEndpoint } from "./ssh-carrier.js";
import { BoatDuplexChannels } from "./duplex.js";
import { guardianCommand } from "./guardian-contract.js";
import { fixture, sdk, scope, cleanups, obs, exec, masterPid, waitEffect } from "./test-fixtures/ssh-local.js";
// @ts-expect-error Dependency-free S9 frames.
import { observe, park, claim, retire, wire } from "./test-fixtures/s9-frames.mjs";
const state=(carrier:any)=>[...carrier.states.values()][0] as any;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function settle<T>(p:Promise<T>){const t=performance.now();try{return{ok:true as const,value:await p,ms:performance.now()-t};}catch(e:any){return{ok:false as const,code:e.code??e.message,ms:performance.now()-t};}}

it.each(["environmentStopLease","environmentReleaseLease","environmentDestroyLease"])("F1/J10 %s proceeds after three failed retire attempts, retains the guest and warns",async(method)=>{
 const f=await fixture(),s=await sdk(f);await s.acquire();await s.start();
 s.ctl.failRetire=true;const old={...state(s.carrier()).key},before=s.ctl.retireCalls;
 const receipt=await s.rpc(method,scope);
 expect(receipt).toMatchObject({state:"stopped",warnings:[{code:"BOAT_SSH_RETIRE_FAILED",attempts:3}]});
 expect(s.ctl.retireCalls-before).toBe(3);expect(s.ctl.stopCalls).toBe(1);expect(s.ctl.destroyCalls).toBe(0);
 expect(state(s.carrier()).retirePending).toEqual(old);expect(state(s.carrier()).retiring).toBe(false);
 await obs("F1_LIFECYCLE",{method,receipt,attempts:3,providerStops:s.ctl.stopCalls,providerDeletes:s.ctl.destroyCalls,pendingRetained:true});
},30000);

it.each(["resume","acquire"])("RP1/J9b %s removes OLD key before any new registration on SAME guest",async(next)=>{
 const f=await fixture(),s=await sdk(f),acquired=await s.acquire();await s.start();
 const old={...state(s.carrier()).key},oldLine=(await readFile(f.keys,"utf8")).split("\n").find(l=>l.includes("paperclip-boat-carrier:"))!;
 s.ctl.failRetire=true;await s.rpc("environmentStopLease",scope);expect(state(s.carrier()).retirePending).toEqual(old);
 s.ctl.failRetire=false;const before=s.ctl.retireCalls,registrationViews:string[]=[],request=f.api.request;
 f.api.request=async(path,init)=>{if(path.endsWith("/sshkey"))registrationViews.push(await readFile(f.keys,"utf8"));return request(path,init);};
 const result=next==="resume"?await s.rpc("environmentResumeLease",{...scope,leaseMetadata:acquired.metadata}):await s.acquire();
 expect(result.providerLeaseId).toBe(scope.providerLeaseId);expect(s.ctl.retireCalls-before).toBe(1);
 expect(await readFile(f.keys,"utf8")).toBe("# operator-owned sentinel\n");expect(registrationViews).toEqual([]);
 // Route A cannot authenticate before Core supplies its exact Runner ID.
 const op=await s.op(park);expect(op.reply.status).toBe("parked");expect(registrationViews).toEqual(["# operator-owned sentinel\n"]);
 expect(await readFile(f.keys,"utf8")).not.toContain(oldLine);expect(state(s.carrier()).retirePending).toBeUndefined();
 await obs("RP1",{next,sameGuest:true,oldLineRemovedBeforeRegistration:true,pendingCleared:true,op:op.reply,registrationAtFirstOpen:true});
},30000);

it("RP2 failed resume cleanup refuses typed; later resume clears pending without a stale op",async()=>{
 const f=await fixture(),s=await sdk(f),acquired=await s.acquire();await s.start();const old={...state(s.carrier()).key};
 s.ctl.failRetire=true;await s.rpc("environmentStopLease",scope);const registrations=f.registrations(),before=s.ctl.retireCalls;
 await expect(s.rpc("environmentResumeLease",{...scope,leaseMetadata:acquired.metadata})).rejects.toMatchObject({message:"BOAT_SSH_RETIRE_PENDING"});
 await expect(s.open()).rejects.toMatchObject({message:"BOAT_SSH_RETIRE_PENDING"});
 await expect(s.carrier().prepare(f.lease)).rejects.toMatchObject({code:"BOAT_SSH_RETIRE_PENDING"});
 expect(s.ctl.retireCalls-before).toBe(1);expect(state(s.carrier()).retirePending).toEqual(old);expect(f.registrations()).toBe(registrations);
 expect(JSON.parse(await readFile(f.proof,"utf8"))).toEqual({});
 s.ctl.failRetire=false;await s.rpc("environmentResumeLease",{...scope,leaseMetadata:acquired.metadata});const op=await s.op(park);
 expect(op.reply.status).toBe("parked");expect(state(s.carrier()).retirePending).toBeUndefined();
 await obs("RP2",{refusedResume:true,refusedOpen:true,noRegistrationOnFailure:true,pendingCleared:true,op:op.reply});
},30000);

it("RP2 race: pending removal keeps opens fenced until acquire/resume finishes",async()=>{
 const f=await fixture(),s=await sdk(f),acquired=await s.acquire();await s.start();
 s.ctl.failRetire=true;await s.rpc("environmentStopLease",scope);s.ctl.failRetire=false;
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;}),run=f.api.run;
 f.api.run=async(c,t,signal)=>{if(c.includes("-retire.mjs")){entered();await gate;}return run(c,t,signal);};
 // Fail loudly if the real SDK/route path reaches transport while removal is
 // pending. The guard avoids leaking a newly authenticated master in the RED.
 let earlyPrepare=0;const guard=vi.spyOn(s.carrier(),"prepare").mockImplementation(async()=>{earlyPrepare++;throw Error("EARLY_PREPARE");});
 const resume=s.rpc("environmentResumeLease",{...scope,leaseMetadata:acquired.metadata});
 try {await started;await expect(s.open()).rejects.toMatchObject({message:"BOAT_SSH_LEASE_UNBOUND"});expect(earlyPrepare).toBe(0);expect(await readFile(f.keys,"utf8")).toContain("paperclip-boat-carrier:");}
 finally {release();await resume;guard.mockRestore();}
 expect((await s.op(park)).reply.status).toBe("parked");await obs("RP2_PENDING_OPEN_RACE",{earlyPrepare,refusedUntilRemoval:true,recovered:true});
},30000);

it("RP3 Route A destroy retains pending; only confirmed external destruction forgets it",async()=>{
 const f=await fixture();let fail=false,calls=0;const carrier=new BoatSshCarrier(()=>({...f.api,run:async(c,t,signal)=>{if(c.includes("-retire.mjs")){calls++;if(fail)return{exitCode:1,timedOut:false,stdout:"",stderr:""};}return f.api.run(c,t,signal);}}));cleanups.push(()=>carrier.close());
 await carrier.prepare(f.lease);fail=true;await expect(carrier.retire(f.lease)).rejects.toMatchObject({code:"BOAT_SSH_RETIRE_FAILED"});
 expect(state(carrier).retirePending).toBeTruthy();carrier.forgetDestroyed(f.lease);const before=calls;
 await carrier.invalidate(f.lease);await carrier.retire(f.lease);await carrier.close();expect(calls).toBe(before);expect((carrier as any).states.size).toBe(0);
 await obs("RP3_EXTERNAL_DESTRUCTION",{pendingForgotten:true,guestEditsAfterConfirmation:calls-before,providerDeleteNotImplemented:true});
},30000);

it("F1/J9 bounded retirement retries and settles; exact retry removes the retained public identity",async()=>{
 const f=await fixture();let failures=0;const carrier=new BoatSshCarrier(()=>({...f.api,run:async(c,t,signal)=>{if(c.includes("-retire.mjs")&&failures++<2)return{exitCode:1,timedOut:false,stdout:"",stderr:""};return f.api.run(c,t,signal);}}));cleanups.push(()=>carrier.close());
 await carrier.prepare(f.lease);await carrier.retire(f.lease);expect(failures).toBe(3);expect(await readFile(f.keys,"utf8")).toBe("# operator-owned sentinel\n");
},30000);

it("F1 nonresponding key-editor API aborts after three bounded attempts",async()=>{
 const f=await fixture();let blocked=false,attempts=0;
 const carrier=new BoatSshCarrier(()=>({...f.api,request:async(path,init)=>{if(blocked&&init?.method==="PUT"&&String(init.body).includes("-retire.mjs")){attempts++;return await new Promise((_,reject)=>{init!.signal!.addEventListener("abort",()=>reject(init!.signal!.reason),{once:true});});}return f.api.request(path,init);}}));cleanups.push(()=>carrier.close());
 await carrier.prepare(f.lease);blocked=true;const result=await settle(carrier.retire(f.lease));blocked=false;
 expect(result).toMatchObject({ok:false,code:"BOAT_SSH_RETIRE_FAILED"});expect(attempts).toBe(3);expect(result.ms).toBeGreaterThan(14000);expect(result.ms).toBeLessThan(20000);
 await carrier.retire(f.lease);await obs("F1_ABORT_DEADLINE",{...result,attempts});
},30000);

it("F2 boundary: acquire cannot prewarm an unknown Runner; first exact open authenticates",async()=>{
 const f=await fixture(),s=await sdk(f);const acquired=await s.acquire();expect(acquired.metadata.runnerGuardianVersion).toBe(1);
 expect(f.registrations()).toBe(0);expect(await readFile(f.keys,"utf8")).toBe("# operator-owned sentinel\n");
 const t=performance.now();const op=await s.op(f.q);expect(op.reply.status).toBe("qualified");expect(f.registrations()).toBe(1);
 await obs("F2_ACQUIRE_PREWARM_BLOCKED",{registrationsAtAcquire:0,registrationsAtFirstOpen:1,firstQualificationMs:performance.now()-t,reason:"Core selects Runner at first open; exact forced-command binding preserved"});
},30000);

it("F2/J7 idle expiry restarts only the handshake with cached exact key and API pin",async()=>{
 const f=await fixture(),e=await f.carrier.prepare(f.lease);await f.start(e);await f.rpc(e,park);
 await sleep(63000);const before=performance.now(),fresh=await f.carrier.prepare(f.lease);
 expect(fresh).not.toBe(e);expect(f.registrations()).toBe(1);expect(f.preflights()).toBe(1);expect((await f.rpc(fresh,claim())).status).toBe("claimed");
 await obs("J7_IDLE_EXPIRY",{idleSeconds:63,handshakeAndClaimMs:performance.now()-before,registrations:f.registrations(),preflights:f.preflights(),authentications:((await f.log()).match(/Accepted publickey/g)??[]).length});
},90000);

it("F3/J13 8200 routes evict settled tombstones; pending-close capacity refuses typed and recovers",async()=>{
 const ch=new BoatDuplexChannels({prepare:async()=>({} as any),connect:async()=>({write:async()=>{},close:async()=>{}}),notify:{data(){},exit(){}},activity:(_l,run)=>run()});
 ch.bind({...scope,guardianPreflight:{usable:true}});cleanups.push(()=>ch.shutdown());
 for(let i=0;i<8200;i++){const route=await ch.open({...scope,hostRouteId:`r-${i}`,command:guardianCommand("runner")});await ch.close(route);}
 await expect(ch.open({...scope,hostRouteId:"r-8199",command:guardianCommand("runner")})).rejects.toThrow(/used|closed/);
 const table=(ch as any).routes;for(const e of table.values())e.closing=Promise.resolve();
 await expect(ch.close({hostRouteId:"overflow"})).rejects.toMatchObject({code:"BOAT_SSH_ROUTE_LIMIT"});for(const e of table.values())e.closing=undefined;
 await ch.close({hostRouteId:"after-settlement"});await obs("F3_J13",{completed:8200,typedFullRefusal:true,recovered:true});
});

it.each(["SIGKILL","SIGTERM","SIGHUP","SIGINT"] as const)("F5/J1/J1b %s master loss replays once and preserves another worker",async(signal)=>{
 const f=await fixture("delay-claim"),other=new BoatSshCarrier(()=>f.api);cleanups.push(()=>other.close());
 const e=await f.carrier.prepare(f.lease),b=await other.prepare(f.lease);await f.start(e);await f.rpc(e,park);
 const lost=settle(sshRoundTrip(e,Buffer.from(wire(claim()))));await waitEffect(f.proof,claim().id);process.kill(await masterPid(e),signal);const result=await lost;
 expect(result).toMatchObject({ok:false,code:"BOAT_SSH_SESSION_LOST"});const stale=await lstat(e.controlPath).then(s=>s.isSocket(),()=>false);
 const fresh=await f.carrier.prepare(f.lease);expect(fresh).not.toBe(e);expect((await f.rpc(fresh,claim())).status).toBe("claimed");expect(JSON.parse(await readFile(f.proof,"utf8"))[claim().id]).toBe(1);
 expect(await other.prepare(f.lease)).toBe(b);expect(f.registrations()).toBe(2);expect(f.preflights()).toBe(2);
 await obs("F5_J1",{signal,staleSocket:stale,typedLoss:true,claimApplications:1,registrations:f.registrations(),otherWorkerPreserved:true});
},30000);

it("J3/F4 slave kill settles typed loss and leaves the healthy master reusable",async()=>{
 const f=await fixture("delay-claim"),e=await f.carrier.prepare(f.lease);await f.start(e);await f.rpc(e,park);
 const pending=settle(sshRoundTrip(e,Buffer.from(wire(claim()))));await waitEffect(f.proof,claim().id);
 const pids=(await exec("pgrep",["-f",`ControlMaster=no.*${e.controlPath}`])).stdout.trim().split("\n").map(Number);expect(pids.length).toBeGreaterThan(0);for(const pid of pids)process.kill(pid,"SIGKILL");
 expect(await pending).toMatchObject({ok:false,code:"BOAT_SSH_SESSION_LOST"});expect(await f.carrier.prepare(f.lease)).toBe(e);expect((await f.rpc(e,claim())).status).toBe("claimed");expect(JSON.parse(await readFile(f.proof,"utf8"))[claim().id]).toBe(1);
},30000);

async function descendants(pid:number):Promise<number[]>{const result:number[]=[];for(const p of (await exec("pgrep",["-P",String(pid)]).catch(()=>({stdout:""}))).stdout.trim().split("\n").filter(Boolean).map(Number)){result.push(p,...await descendants(p));}return result;}

it("F4 healthy SSH but frozen client hits its operation deadline and preserves master",async()=>{
 const f=await fixture(),e=await f.carrier.prepare(f.lease);await f.start(e);let finish!:(v:any)=>void;
 const ended=new Promise<any>(r=>{finish=r;}),start=performance.now();const session=await connectSsh(e,guardianCommand("runner"),{data(){},exit:finish});let client=0;
 try {
  await vi.waitFor(async()=>{for(const p of await descendants(f.sshdPid)){const cmd=await readFile(`/proc/${p}/cmdline`,"utf8").catch(()=>"");if(cmd.includes("\u0000client\u0000--protocol\u00001\u0000--runner-id\u0000runner")){client=p;break;}}expect(client).toBeGreaterThan(0);},{timeout:3000,interval:20});
  process.kill(client,"SIGSTOP");await session.write(Buffer.from(wire(f.q)));const result=await ended,ms=performance.now()-start;
  expect(result.transportClosed).toBe(true);expect(ms).toBeGreaterThan(39000);expect(ms).toBeLessThan(45000);
  await obs("F4_OPERATION_DEADLINE",{ms,transportClosed:true,keepalivesHealthy:true});
 } finally {if(client)try{process.kill(client,"SIGCONT");}catch{}await session.close();}
 expect(await f.carrier.prepare(f.lease)).toBe(e);expect((await f.rpc(e,park)).status).toBe("parked");
},60000);

it("F4/J8c frozen SSH peer settles typed loss while frozen",async()=>{
 const f=await fixture(),e=await f.carrier.prepare(f.lease);await f.start(e);const peers=await descendants(f.sshdPid);expect(peers.length).toBeGreaterThan(0);
 try {for(const pid of peers)process.kill(pid,"SIGSTOP");const result=await settle(sshRoundTrip(e,Buffer.from(wire(park))));expect(result).toMatchObject({ok:false,code:"BOAT_SSH_SESSION_LOST"});expect(result.ms).toBeLessThan(45000);await obs("J8c_FROZEN_PEER",result);}
 finally {for(const pid of peers)try{process.kill(pid,"SIGCONT");}catch{}}
},60000);

it("J2 server-side kill after native admission yields loss and exact replay once",async()=>{
 const f=await fixture("delay-claim"),e=await f.carrier.prepare(f.lease);await f.start(e);await f.rpc(e,park);
 const pending=settle(sshRoundTrip(e,Buffer.from(wire(claim()))));await waitEffect(f.proof,claim().id);
 for(const pid of await descendants(f.sshdPid))try{process.kill(pid,"SIGKILL");}catch{}
 expect(await pending).toMatchObject({ok:false,code:"BOAT_SSH_SESSION_LOST"});const fresh=await f.carrier.prepare(f.lease);expect((await f.rpc(fresh,claim())).status).toBe("claimed");expect(JSON.parse(await readFile(f.proof,"utf8"))[claim().id]).toBe(1);
},30000);

it("J4/J5/J6 key hygiene, strict pins, keepalives and exact command refusal",async()=>{
 const f=await fixture(),e=await f.carrier.prepare(f.lease),dir=dirname(e.controlPath);
 expect((await lstat(dir)).mode&0o777).toBe(0o700);
 for(const name of await readdir(dir)){const p=join(dir,name);if((await lstat(p)).isFile())expect(await readFile(p,"utf8")).not.toMatch(/PRIVATE KEY|BEGIN OPENSSH/);}
 const g=await exec("ssh",["-G",...e.args],{env:e.env});expect(g.stdout).toContain("stricthostkeychecking true");expect(g.stdout).toContain("serveraliveinterval 5");expect(g.stdout).toContain("serveralivecountmax 3");
 const command=await exec("ssh",["-o","ControlMaster=no","-o","ProxyCommand=/bin/false",...e.args,"echo PWNED"],{env:e.env}).catch((x:any)=>x);
 expect(command.stdout).not.toContain("PWNED");expect(JSON.parse(command.stdout).error.code).toBe("UNTRUSTED_SSH_COMMAND");
 await f.carrier.retire(f.lease);expect(await readFile(f.keys,"utf8")).toBe("# operator-owned sentinel\n");await obs("J4_J5_J6",{publicOnly:true,strictPins:true,keepaliveSeconds:5,keepaliveCount:3,exactCommandRefused:true});
},30000);

it("J12 SDK transport loss after claim admission is typed; exact replay applies once",async()=>{
 const f=await fixture("delay-claim"),s=await sdk(f);await s.acquire();await s.start();expect((await s.op(park)).reply.status).toBe("parked");
 const lost=s.op(claim());await waitEffect(f.proof,claim().id);
 const endpoint=state(s.carrier()).endpoint as SshEndpoint;process.kill(await masterPid(endpoint),"SIGKILL");
 const first=await lost;expect(first.end.transportClosed).toBe(true);expect(first.reply).toBeNull();const replay=await s.op(claim());expect(replay.end.transportClosed).toBe(false);expect(replay.reply.status).toBe("claimed");
 expect(JSON.parse(await readFile(f.proof,"utf8"))[claim().id]).toBe(1);await obs("J12_SDK_LOSS",{first,replay:replay.reply,claimApplications:1});
},30000);

it.each([
 ["scenario3", "acquire"], ["scenario3", "resume"],
 ["scenario4", "acquire"], ["scenario4", "resume"],
] as const)("off boundary %s: next %s retires the key with zero transport opens and no marker",async(scenario,next)=>{
 const f=await fixture(),s=await sdk(f),acquired=await s.acquire();await s.start();
 const oldKey=await readFile(f.keys,"utf8");expect(oldKey).toContain("paperclip-boat-carrier:");
 // A saved environment row changes, not the captured SSH-on run or the hook
 // input. Core sends no config event to this plugin when that row is saved.
 const savedConfig={...scope.config,duplexCarrier:"off"};
 const prepare=vi.spyOn(s.carrier(),"prepare");
 const operations=scenario==="scenario3"?[f.q]:[observe,park];
 for(const frame of operations)expect((await s.op(frame)).reply.status).toBe(frame.op==="qualify"?"qualified":frame.op==="observe"?"observed":"parked");
 expect(prepare).toHaveBeenCalledTimes(scenario==="scenario3"?1:2);
 expect(await readFile(f.keys,"utf8")).toBe(oldKey);
 if(scenario==="scenario4")expect(JSON.parse(await readFile(f.proof,"utf8"))[park.id]).toBe(1);
 const opensInBoundaryRun=prepare.mock.calls.length,registrations=f.registrations(),authentications=((await f.log()).match(/Accepted publickey/g)??[]).length;
 prepare.mockClear();
 const disabled=await s.rpc(next==="acquire"?"environmentAcquireLease":"environmentResumeLease",{
  ...scope,config:savedConfig,runId:"next-run",agentId:"agent",executionWorkspaceId:"workspace",adapterType:"paperclip_runner",leaseMetadata:acquired.metadata,
 });
 expect(disabled.providerLeaseId).toBe(scope.providerLeaseId);
 expect(disabled.metadata.runnerGuardianVersion).toBeUndefined();
 expect(disabled.metadata.guardianPreflight).toBeUndefined();
 expect(await readFile(f.keys,"utf8")).toBe("# operator-owned sentinel\n");
 // Defense in depth: even a caller ignoring the dropped marker cannot connect.
 await expect(s.open()).rejects.toMatchObject({message:"BOAT_SSH_LEASE_UNBOUND"});
 expect(prepare).not.toHaveBeenCalled();expect(f.registrations()).toBe(registrations);
 expect(((await f.log()).match(/Accepted publickey/g)??[]).length).toBe(authentications);
 await obs("OFF_NEXT_LIFECYCLE",{scenario,next,opensInBoundaryRun,nextTransportOpens:prepare.mock.calls.length,markerRemoved:true,preflightRemoved:true,keyRetired:true,newRegistrations:0,newAuthentications:0,parkApplications:scenario==="scenario4"?1:undefined});
},30000);

it("F6/J11 unrelated company/global config preserves keys; scoped off clears marker and retires",async()=>{
 const f=await fixture(),s=await sdk(f),acquired=await s.acquire();await s.start();const before=await readFile(f.keys,"utf8");
 for(const params of [{companyId:scope.companyId,config:{unrelated:1}},{config:{duplexCarrier:"off"}},{companyId:"foreign",config:{duplexCarrier:"off"}}])await s.rpc("configChanged",params);
 expect(await readFile(f.keys,"utf8")).toBe(before);expect((await s.op(park)).reply.status).toBe("parked");
 const disabled=await s.rpc("environmentResumeLease",{...scope,config:{...scope.config,duplexCarrier:"off"},leaseMetadata:acquired.metadata});
 expect(disabled.metadata.runnerGuardianVersion).toBeUndefined();expect(disabled.metadata.guardianPreflight).toBeUndefined();expect(await readFile(f.keys,"utf8")).toBe("# operator-owned sentinel\n");
 await expect(s.open()).rejects.toMatchObject({message:"BOAT_SSH_LEASE_UNBOUND"});await obs("F6_J11",{unrelatedSavesPreserved:true,scopedOffRetired:true,staleMarkerRemoved:true});
},30000);
