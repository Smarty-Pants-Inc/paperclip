// Judge-only controlled SOURCE probes; never a real Boat or live latency claim.
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {appendFileSync,mkdirSync} from 'node:fs';
import {createServer,type Server} from 'node:http';
import plugin from './plugin.js';
const id='bx_23456789',foreign='bx_98765432',cwd='/home/user/paperclip-workspace',token='c'.repeat(64);
const t0=Date.parse('2026-11-20T12:00:00Z'),old='2026-11-20T12:10:00.000Z',next='2026-11-20T12:30:00.000Z';
const sentinel={path:cwd+'/.paperclip-runtime/reusable-sandbox-lease.json',token,result:'written'};
const base={driverKey:'boat',companyId:'rf11-own-company',environmentId:'rf11-own-env',providerLeaseId:id,
 config:{apiKey:'boat_rf11_readonly_fixture',reuseLease:true,ttlSeconds:1800,duplexCarrier:'off'},
 leaseMetadata:{adapterType:'paperclip_runner',sandboxId:id,remoteCwd:cwd,reuseLease:true,boatOrgId:'org_saved',workspaceSentinel:sentinel}};
const reply=(b:unknown,status=200)=>new Response(JSON.stringify(b),{status});
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};
let traces:any[],receipt:any[],servers:Server[]=[];
beforeEach(async()=>{traces=[];receipt=[];vi.spyOn(Date,'now').mockReturnValue(t0);await plugin.definition.setup({logger:{info:(m:any,d:any)=>receipt.push({level:'info',m,d}),warn:(m:any,d:any)=>receipt.push({level:'warn',m,d}),error:()=>{},debug:()=>{}}} as any);});
afterEach(async(ctx)=>{
 try{await plugin.definition.onShutdown?.();}finally{
  for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
  if(process.env.TASK_OUT){
   const dir=process.env.TASK_OUT+'/judge-traces';mkdirSync(dir,{recursive:true,mode:0o700});
   appendFileSync(dir+'/'+(process.env.JUDGE_VARIANT??'unknown')+'.jsonl',JSON.stringify({row:ctx.task.name,traces,receipt})+'\n',{mode:0o600});
  }
  vi.unstubAllGlobals();vi.restoreAllMocks();
 }
});
type Mode='ok'|'409'|'404'|'timeout'|'redirect'|'wrong-id'|'state-change'|'generation-change';
function transport(mode:Mode='ok',opts:{cat?:'match'|'mismatch'|'missing'|'timeout';patchGate?:ReturnType<typeof gate>;catGate?:ReturnType<typeof gate>;getWrong?:boolean;catPoison?:boolean;redirectUrl?:string}={}){
 let stopped=false;
 const nativeFetch=globalThis.fetch;
 vi.stubGlobal('fetch',async(url:any,init:RequestInit={})=>{
  const path=String(url).replace('https://boat.dev/api/v1',''),method=init.method??'GET';
  traces.push({event:'send',method,path,scopeOrg:new Headers(init.headers).get('X-Boat-Org'),redirect:init.redirect,lease:id,source:'judge-controlled-provider-fixture',fixtureGeneration:stopped?'stopped':'G0',body:init.body?JSON.parse(String(init.body)):null});
  if(path===`/sandboxes/${id}/stop`){stopped=true;return reply({stop:{id:'stop_123456789abcdef0',status:'completed'}});}
  if(method==='GET'&&path===`/sandboxes/${id}`)return reply({sandbox:{id:opts.getWrong?foreign:id,state:stopped?'archived':'running',team:{id:'org_get'},archiveAfter:old,updatedAt:'2026-11-20T11:00:00Z',lastReboot:{at:'2026-11-20T10:00:00Z',reason:'clean'}}});
  if(method==='PATCH'&&path===`/sandboxes/${id}`){
   await opts.patchGate?.promise;
   if(mode==='timeout')return await new Promise<Response>((_,reject)=>{init.signal!.addEventListener('abort',()=>{traces.push({event:'actual-signal-abort',reason:init.signal!.reason?.name});reject(init.signal!.reason);},{once:true});});
   if(mode==='redirect')return nativeFetch(opts.redirectUrl!,{method:'PATCH',body:init.body,headers:{'content-type':'application/json'},redirect:init.redirect,signal:init.signal});
   if(mode==='409'||mode==='404')return reply({ok:false,status:Number(mode),code:mode==='409'?'sandbox_not_ready':'not_found',error:{code:mode==='409'?'sandbox_not_ready':'not_found',status:Number(mode),details:{state:'archived'}}},Number(mode));
   const sandbox={id:mode==='wrong-id'?foreign:id,state:mode==='state-change'?'archived':'running',team:{id:'org_patch'},archiveAfter:next,updatedAt:mode==='generation-change'?'2026-11-20T12:00:01Z':'2026-11-20T11:00:00Z',lastReboot:{at:mode==='generation-change'?'2026-11-20T12:00:01Z':'2026-11-20T10:00:00Z',reason:'clean'}};
   traces.push({event:'patch-response',sandbox});return reply({sandbox});
  }
  if(method==='POST'&&path===`/sandboxes/${id}/commands`){
   expect(JSON.parse(String(init.body)).command).toContain(`cat '${sentinel.path}'`);
   await opts.catGate?.promise;
   const parsed={version:1,provider:'boat',token:opts.cat==='mismatch'?'d'.repeat(64):token,...(opts.catPoison?{id:foreign,state:'archived',team:{id:'org_cat'},archiveAfter:'2099-01-01T00:00:00Z'}:{})};
   traces.push({event:'cat-response',fixtureGeneration:mode==='generation-change'?'G0-stale-after-G1':'G0',parsed});
   return reply({exitCode:opts.cat==='missing'?1:0,stdout:JSON.stringify(parsed),stderr:'',timedOut:opts.cat==='timeout'});
  }
  throw Error('Unexpected judge request '+method+' '+path);
 });
}
async function resume(params:any=base){const lease=await plugin.definition.onEnvironmentResumeLease!(params);traces.push({event:'returned',lease});return lease;}
it('J-AUTH-OK: PATCH alone supplies owner/deadline; cat extra state and owner are inert',async()=>{
 transport('ok',{catPoison:true});const lease=await resume();
 expect(lease).toMatchObject({providerLeaseId:id,expiresAt:next,metadata:{boatOrgId:'org_patch',resumedFromState:'running',ttlRefresh:{status:'ok'},workspaceSentinel:{result:'matched'}}});
 expect(lease.metadata?.workspaceSentinel).not.toHaveProperty('team');
});
it.each(['409','404','wrong-id'] as const)('J-BASELINE-PATCH-%s: failed PATCH retains GET authority and still uses matched cat (conflicting bar)',async mode=>{
 transport(mode);const lease=await resume();
 expect(lease).toMatchObject({providerLeaseId:id,expiresAt:old,metadata:{boatOrgId:'org_get',resumedFromState:'running',ttlRefresh:{status:'failed',httpStatus:mode==='wrong-id'?200:Number(mode)},workspaceSentinel:{result:'matched'}}});
 expect(traces.filter(x=>x.event==='send'&&x.method==='PATCH')).toHaveLength(1);
 expect(traces.filter(x=>x.event==='send'&&x.path.endsWith('/resume'))).toHaveLength(0);
});
it('J-BASELINE-REDIRECT: actual native 307 is refused, foreign endpoint never reached, matched cat still used',async()=>{
 const server=createServer((req,res)=>{traces.push({event:'loopback-http',method:req.method,url:req.url});res.writeHead(307,{location:'/foreign'});res.end();});servers.push(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address() as {port:number};
 transport('redirect',{redirectUrl:`http://127.0.0.1:${address.port}/redirect`});const lease=await resume();
 expect(lease).toMatchObject({providerLeaseId:id,expiresAt:old,metadata:{boatOrgId:'org_get',ttlRefresh:{status:'failed',category:'network_error',httpStatus:null},workspaceSentinel:{result:'matched'}}});
 expect(traces.filter(x=>x.event==='loopback-http').map(x=>x.url)).toEqual(['/redirect']);
});
it('J-BASELINE-TIMEOUT: actual PATCH AbortSignal deadline, receipt awaited; no retry; matched cat still used',async()=>{
 transport('timeout');const lease=await resume();
 expect(lease).toMatchObject({providerLeaseId:id,expiresAt:old,metadata:{boatOrgId:'org_get',ttlRefresh:{status:'failed',category:'network_error',httpStatus:null},workspaceSentinel:{result:'matched'}}});
 expect(traces.filter(x=>x.event==='actual-signal-abort')).toHaveLength(1);
 expect(traces.filter(x=>x.event==='send'&&x.method==='PATCH')).toHaveLength(1);
},40_000);
it('J-GET-ID: wrong GET allocation cannot authorize PATCH or cat',async()=>{
 transport('ok',{getWrong:true});await expect(resume()).rejects.toThrow('different allocation');expect(traces.filter(x=>x.event==='send')).toHaveLength(1);
});
it('J-ALLOCATION-ID: foreign persisted allocation receipt expires before any provider I/O',async()=>{
 transport();const lease=await resume({...base,leaseMetadata:{...base.leaseMetadata,workspaceAllocationFiles:{providerLeaseId:foreign,remoteCwd:cwd,files:[]}}});
 expect(lease.providerLeaseId).toBeNull();expect(traces.filter(x=>x.event==='send')).toHaveLength(0);
});
it.each(['mismatch','missing'] as const)('J-SENTINEL-%s: stale/missing proof cannot hand out a live allocation',async cat=>{
 transport('ok',{cat});const lease=await resume();expect(lease).toMatchObject({providerLeaseId:null,metadata:{expired:true,ttlRefresh:{status:'ok'},workspaceSentinel:{result:cat}}});
});
it('J-CAT-TIMEOUT: successful PATCH receipt logged before preserve-lease throw',async()=>{
 transport('ok',{cat:'timeout'});await expect(resume()).rejects.toThrow('preserve the lease');
 expect(receipt).toContainEqual({level:'info',m:'Boat warm lease TTL refresh',d:{providerLeaseId:id,status:'ok',category:null}});
});
it('J-BASELINE-STATE: same-ID PATCH changes state to archived; existing path still returns matched lease',async()=>{
 transport('state-change');const lease=await resume();expect(lease).toMatchObject({providerLeaseId:id,metadata:{resumedFromState:'running',boatOrgId:'org_patch',workspaceSentinel:{result:'matched'}}});
});
it('J-PROVIDER-GENERATION-GAP: changed updatedAt/lastReboot plus stale matching token is not a generation binding',async()=>{
 transport('generation-change');const lease=await resume();expect(lease).toMatchObject({providerLeaseId:id,metadata:{boatOrgId:'org_patch',workspaceSentinel:{result:'matched'}}});
 // Observational baseline compatibility, NOT a passing same-provider-generation guarantee.
});
it('J-STATE-RACE: a PATCH that observes archive after an early live cat must retain baseline recovery before handoff',async()=>{
 let providerState='running';
 vi.stubGlobal('fetch',async(url:any,init:RequestInit={})=>{
  const path=String(url).replace('https://boat.dev/api/v1',''),method=init.method??'GET';
  traces.push({event:'state-race-send',source:'judge-controlled-stateful-provider',method,path,lease:id,stateAtSend:providerState,redirect:init.redirect,body:init.body?JSON.parse(String(init.body)):null});
  if(path===`/sandboxes/${id}`&&method==='GET')return reply({sandbox:{id,state:providerState,team:{id:'org_get'},archiveAfter:old}});
  if(path===`/sandboxes/${id}`&&method==='PATCH'){
   // A pending response lets an already-authorized read finish on the live box.
   // The provider then archives it before returning its exact-ID PATCH receipt.
   await new Promise<void>(r=>setImmediate(r));providerState='archived';
   const sandbox={id,state:providerState,team:{id:'org_patch'},archiveAfter:next};traces.push({event:'state-race-patch-receipt',sandbox});return reply({sandbox});
  }
  if(path===`/sandboxes/${id}/resume`){providerState='running';return reply({sandbox:{id,state:providerState}});}
  if(path===`/sandboxes/${id}/commands`){
   if(providerState==='archived')return reply({code:'sandbox_not_ready',state:'archived',retryable:false,error:{code:'sandbox_not_ready',details:{state:'archived'}}},409);
   return reply({exitCode:0,timedOut:false,stdout:JSON.stringify({version:1,provider:'boat',token}),stderr:''});
  }
  throw Error('Unexpected state race request '+method+' '+path);
 });
 const lease=await resume();traces.push({event:'state-race-handoff',lease,providerState});
 expect(lease.providerLeaseId).toBe(id);
 expect(providerState,'A matching cat read before the PATCH observed archived is stale; baseline recovers the archived box before return').toBe('running');
});
it('J-STOP-REVISION: stop while warm PATCH is in flight forbids a late handoff under old admission',async()=>{
 const patchGate=gate(),catGate=gate();transport('ok',{patchGate,catGate});
 const work=resume().then(value=>({value}),error=>({error}));
 let stopped:Promise<unknown>|undefined;
 try{
  await vi.waitFor(()=>expect(traces.some(x=>x.event==='send'&&x.method==='PATCH')).toBe(true));
  stopped=plugin.definition.onEnvironmentStopLease!({...base,cancelActiveWork:true});
  await vi.waitFor(()=>expect(traces.some(x=>x.event==='send'&&x.path.endsWith('/stop'))).toBe(true));
 }finally{patchGate.resolve();catGate.resolve();await stopped;await work;}
 const result=await work;expect(result).toHaveProperty('error');expect(result).not.toHaveProperty('value');
 const stopAt=traces.findIndex(x=>x.event==='send'&&x.path.endsWith('/stop'));
 expect(traces.slice(stopAt+1).filter(x=>x.event==='send'&&x.path.endsWith('/commands'))).toHaveLength(0);
});
