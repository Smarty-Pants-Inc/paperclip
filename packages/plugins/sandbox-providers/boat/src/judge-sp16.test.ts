import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
vi.mock('node:timers/promises', () => ({ setTimeout: (ms=0, value?: unknown, opts?: {signal?: AbortSignal}) => new Promise((resolve,reject) => {
 if(opts?.signal?.aborted) return reject(opts.signal.reason);
 const t=setTimeout(()=>resolve(value),ms); opts?.signal?.addEventListener('abort',()=>{clearTimeout(t); reject(opts.signal!.reason);},{once:true});
}) }));
// Keep: never-OK winner-stop and paid-life guards. Judge rows below are verbatim
// from the shipped rf-4 fixture; only its default import target is redirected.
const target = process.env.JUDGE_TARGET || './plugin.js';
let plugin:any, store:Map<string,any>, context:any;
const cfg={apiKey:'boat_judge_fake_not_a_credential',type:'small',ttlSeconds:1800,reuseLease:false,labels:{}};
const p={driverKey:'boat',companyId:'judgeco',environmentId:'judgeenv',runId:'judgerun',creationOperationId:'judgeop',config:cfg};
const caught=(work:Promise<any>)=>work.then(lease=>({lease,settledAt:Date.now()}),error=>({error:{name:error.name,message:error.message,code:error.code},settledAt:Date.now()}));
const response=(value:any,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
async function restart(setting='NONE') { const now=Date.now(); vi.clearAllTimers(); vi.resetModules(); plugin=(await import(target)).default;
 vi.useFakeTimers(); vi.setSystemTime(now);
 await plugin.definition.setup({...context,...(setting==='NONE'?{}:{config:{get:async()=>({spares:setting==='ON'?1:0,spareMax:3,spareEnvironmentIds:['judgeenv'],spareIdleMinutes:60})}})});
}
beforeEach(async()=>{store=new Map(); const key=(s:any)=>JSON.stringify([s.scopeId,s.namespace,s.stateKey]);
 context={state:{get:async(s:any)=>structuredClone(store.get(key(s))),set:async(s:any,v:any)=>{store.set(key(s),structuredClone(v));}},logger:{info(){},warn(){},error(){},debug(){}}};
 vi.useFakeTimers(); vi.setSystemTime(0); vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException('timeout','TimeoutError')),ms);return c.signal;});
 await restart(); vi.setSystemTime(0);
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
// Independent provider model: create TTL is real; PATCH is now+TTL (null disables);
// only Boat agent prompts defer expiry. Exec/SSH do NOT defer it.
function boat(opts:{ttlRefused?:boolean;stopsRefused?:boolean;primaryReady?:number;hedgeReady?:number;hideHedgeUntil?:number;patchGate?:(id:string,body:any)=>Promise<void>}={}) {
 const boxes=new Map<string,any>(), requests:any[]=[];
 function refresh(b:any){if(!b.explicitStop&&Date.now()>=b.deadline){if(b.promptActive){while(b.deadline<=Date.now())b.deadline+=b.ttl*1000;}else b.explicitStop=true;}}
 function snapshot(id:string,b:any){refresh(b);return {id,labels:b.labels,name:b.name,state:b.explicitStop?'archived':Date.now()>=b.ready?'running':'provisioning',hydrated:true,setupStatus:'done',ttlSeconds:b.ttl,archiveAfter:Number.isFinite(b.deadline)?new Date(b.deadline).toISOString():null,...(b.explicitStop?{stoppedAt:new Date().toISOString()}:{})};}
 vi.stubGlobal('fetch',vi.fn(async(input:any,init:any={})=>{
  const url=new URL(String(input)),path=url.pathname.replace('/api/v1',''), method=init.method||'GET', body=init.body?JSON.parse(init.body):undefined;
  const trace:any={at:Date.now(),method,path,body}; requests.push(trace);
  if(method==='POST'&&path==='/sandboxes') {const key=new Headers(init.headers).get('Idempotency-Key');let entry=[...boxes].find(([,b])=>b.key===key);
   if(!entry){const id=`bx_judge${boxes.size}`,n=boxes.size; const ttl=body.ttlSeconds===undefined?3600:body.ttlSeconds;
    const b={key,labels:body.labels,name:body.name||'Box',at:Date.now(),ready:Date.now()+(n===0?opts.primaryReady??240000:opts.hedgeReady??40000),ttl,deadline:ttl===null?Infinity:Date.now()+ttl*1000,explicitStop:false,promptActive:false};boxes.set(id,b);entry=[id,b];}
   return response({sandbox:snapshot(...entry)},202);
  }
  if(path==='/sandboxes'&&method==='GET'){const filters=url.searchParams.getAll('label').map(s=>s.split('='));return response({sandboxes:[...boxes].filter(([id,b])=>filters.every(([k,v])=>b.labels[k]===v)&&!(id==='bx_judge1'&&Date.now()<(opts.hideHedgeUntil??0))).map(([id,b])=>snapshot(id,b)),pageInfo:{nextCursor:null}});}
  const id=path.split('/')[2],b=boxes.get(id); if(!b)return response({error:'missing'},404);
  if(method==='PATCH'){await opts.patchGate?.(id,body);const prior=b.deadline; if(opts.ttlRefused&&body.ttlSeconds===300)return response({error:'refused'},403);
   if('ttlSeconds'in body){b.ttl=body.ttlSeconds;b.deadline=b.ttl===null?Infinity:Date.now()+b.ttl*1000;}
   if(body.name)b.name=body.name;if(body.labels)b.labels=body.labels;
   Object.assign(trace,{appliedAt:Date.now(),priorDeadline:prior,newDeadline:b.deadline});return response({sandbox:snapshot(id,b)});
  }
  if(method==='POST'&&path.endsWith('/stop')){if(opts.stopsRefused)return response({error:'stop refused'},403);b.explicitStop=true;return response({stop:{id:'stop_'+id,status:'pending'}},202);}
  if(method==='GET')return response({sandbox:snapshot(id,b)});
  throw new Error(`Unexpected ${method} ${path}`);
 }));
 return {boxes,requests,snapshot,live:(id:string)=>snapshot(id,boxes.get(id)).state!=='archived',patches:()=>requests.filter(r=>r.method==='PATCH'&&r.body?.ttlSeconds===300),stops:()=>requests.filter(r=>r.path.endsWith('/stop'))};
}
function receipt(name:string,w:ReturnType<typeof boat>,extra:any={}){const dir=process.env.JUDGE_TRACES||'judge-traces';mkdirSync(dir,{recursive:true});writeFileSync(`${dir}/${name}.json`,JSON.stringify({name,target,at:Date.now(),...extra,requests:w.requests,boxes:[...w.boxes].map(([id,b])=>({...b,id,observation:w.snapshot(id,b)})),state:[...store]},null,2));}
async function advance(work:Promise<any>,ms:number){const result=caught(work);await vi.advanceTimersByTimeAsync(ms);return result;}

// Additional never-OK rows do not replace or weaken the original J9 trigger.
it('S17 legacy loser TTL receipt cannot be handed out after replacement',async()=>{
 const w=boat({stopsRefused:true});void caught(plugin.definition.onEnvironmentAcquireLease(p));await vi.advanceTimersByTimeAsync(76000);
 const scope=JSON.stringify(['judgeco','boat-ready-spares','stop-owed']);
 // Shape written by spare.16: its unfinished hedge was already PATCHed, but
 // has no write-ahead admission in the provisioning record.
 w.boxes.get('bx_judge1').ttl=300;w.boxes.get('bx_judge1').deadline=376000;
 const acquisition={attemptId:'judgeop',runId:'judgerun',keepId:'bx_judge0',ids:['bx_judge0','bx_judge1'],settleUntil:76000,
  loserTtls:{bx_judge1:{ttlSeconds:300,outcome:'applied',attemptedAt:76000}}};
 store.set(scope,{holds:[],owed:[{environmentId:'judgeenv',configHash:'hedge:judgeop',spareId:'acquisition:judgeop',acquisition}]});
 await restart();const a:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),41000);
 receipt('S17-legacy-disposed-contender',w,{a});expect(a.lease).toBeUndefined();expect(a.error).toBeDefined();
});
it('S17 write-ahead delay cannot consume deadline slack and then extend a loser',async()=>{
 const w=boat({stopsRefused:true});const save=context.state.set;let release!:()=>void;const gate=new Promise<void>(r=>release=r);let gated=0;
 context.state.set=async(scope:any,value:any)=>{if(scope.namespace==='boat-provision-hedges'&&Object.keys(value.loserTtlAttempts||{}).length){gated++;await gate;}return save(scope,value);};
 const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),116000);expect(a.error).toBeUndefined();expect(gated).toBe(1);
 await vi.advanceTimersByTimeAsync(1400000);release();await vi.advanceTimersByTimeAsync(0);
 receipt('S17-deadline-slack-after-state',w,{a,gated});expect(w.patches()).toEqual([]);expect(w.boxes.get('bx_judge0').deadline).toBe(1800000);
 expect(w.live(a.lease.providerLeaseId)).toBe(true);expect(w.stops().some(r=>r.path.endsWith('/bx_judge0/stop'))).toBe(true);
});
it('S17 lost outcome never grants a second PATCH even if an external actor resets the loser deadline',async()=>{
 const w=boat({stopsRefused:true});const save=context.state.set;
 context.state.set=async(scope:any,value:any)=>{if(scope.stateKey==='stop-owed'&&value.owed?.some((x:any)=>Object.keys(x.acquisition?.loserTtls||{}).length))throw new Error('controlled state receipt outage');return save(scope,value);};
 const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);context.state.set=save;
 // An independent actor can set a later deadline. That does not confer another
 // send admission on this attempt; GET-only shortening is not idempotency.
 w.boxes.get('bx_judge0').ttl=1800;w.boxes.get('bx_judge0').deadline=1970000;
 await restart();vi.setSystemTime(175000);const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);
 receipt('S17-nonrenewable-admission',w,{a,b});expect(a.error).toBeUndefined();expect(b.error).toBeUndefined();
 expect(w.patches()).toHaveLength(1);expect(w.live(a.lease.providerLeaseId)).toBe(true);
});
it('S17 unfinished inspection issues no contender PATCH or stop before resumable handoff',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let gated=0;
 const w=boat({stopsRefused:true,patchGate:async(id,body)=>{if(id==='bx_judge1'&&body.ttlSeconds===300){gated++;await gate;}}});
 void caught(plugin.definition.onEnvironmentAcquireLease(p));await vi.advanceTimersByTimeAsync(114000);await restart();
 const inspection=caught(plugin.definition.onEnvironmentInspectLease({...p,providerLeaseId:'judgeop',creationOperation:{id:'judgeop',runId:'judgerun'}}));
 await vi.advanceTimersByTimeAsync(0);
 try { expect(gated).toBe(0);expect(w.patches()).toEqual([]);expect(w.stops()).toEqual([]); }
 finally { release();await vi.advanceTimersByTimeAsync(0);await inspection; }
 const a:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),2000);
 expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge1');release();await vi.advanceTimersByTimeAsync(300000);
 receipt('S17-unfinished-no-patch',w,{a,gated});expect(w.live(a.lease.providerLeaseId)).toBe(true);
 expect(w.patches().every(r=>!r.path.endsWith('/'+a.lease.providerLeaseId))).toBe(true);
});
it('S17 terminal loser PATCH held in flight cannot be returned on settled reentry',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let gated=0;
 const w=boat({stopsRefused:true,patchGate:async(id,body)=>{if(id==='bx_judge0'&&body.ttlSeconds===300){gated++;await gate;}}});
 let a:any;const pending=caught(plugin.definition.onEnvironmentAcquireLease(p)).then(value=>{a=value;return value;});
 await vi.advanceTimersByTimeAsync(116000);let b:any;
 try { expect(a).toBeDefined();expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge1');expect(gated).toBe(1);
  b=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);expect(b.lease).toEqual(a.lease); }
 finally { release();await vi.advanceTimersByTimeAsync(0);await pending; }
 await vi.advanceTimersByTimeAsync(300000);receipt('S17-terminal-pending-patch',w,{a,b,gated});
 expect(w.live(a.lease.providerLeaseId)).toBe(true);expect(w.live('bx_judge0')).toBe(false);
 expect(w.patches()).toHaveLength(1);expect(w.patches()[0].newDeadline).toBeLessThanOrEqual(w.patches()[0].priorDeadline);
});
it('S17 failed write-ahead admission sends no TTL PATCH but retains the non-force stop',async()=>{
 const w=boat({stopsRefused:true});const save=context.state.set;
 context.state.set=async(scope:any,value:any)=>{if(scope.namespace==='boat-provision-hedges'&&Object.keys(value.loserTtlAttempts||{}).length)throw new Error('controlled admission outage');return save(scope,value);};
 const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);
 receipt('S17-admission-outage',w,{a});expect(a.error).toBeUndefined();expect(w.patches()).toEqual([]);
 expect(w.stops()).toHaveLength(1);expect(w.stops()[0].body).toEqual({});expect(w.live(a.lease.providerLeaseId)).toBe(true);
});
it('J1 settled same operation at 190s returns same winner; no winner PATCH or stop',async()=>{const w=boat();const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),115000);await vi.advanceTimersByTimeAsync(75000);const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);receipt('J1',w,{a,b});expect(a.error).toBeUndefined();expect(b.lease).toEqual(a.lease);expect(w.requests.filter(r=>r.path==='/sandboxes'&&r.method==='POST')).toHaveLength(2);expect(w.patches().some(r=>r.path.includes(a.lease.providerLeaseId))).toBe(false);expect(w.stops().some(r=>r.path.includes(a.lease.providerLeaseId))).toBe(false);expect(w.live(a.lease.providerLeaseId)).toBe(true);});
it.each(['ON','OFF','NONE'])('J2 %s replacement setup health only: bounded loser, live winner',async setting=>{const w=boat({stopsRefused:true});const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);await restart(setting);await plugin.definition.onHealth();const count=w.requests.length;await vi.advanceTimersByTimeAsync(1000000);receipt('J2-'+setting,w,{a,count,nowCount:w.requests.length});expect(a.error).toBeUndefined();expect(w.live('bx_judge0')).toBe(false);expect(w.live(a.lease.providerLeaseId)).toBe(true);expect(w.requests.length).toBe(count);expect(w.stops().every(r=>JSON.stringify(r.body)==='{}')).toBe(true);});
it('J3 inspected unfinished hedge can NEVER later be handed out with loser TTL',async()=>{const w=boat({stopsRefused:true});void caught(plugin.definition.onEnvironmentAcquireLease(p));await vi.advanceTimersByTimeAsync(76000);await restart();const inspected=await plugin.definition.onEnvironmentInspectLease({...p,providerLeaseId:'judgeop',creationOperation:{id:'judgeop',runId:'judgerun'}});await vi.advanceTimersByTimeAsync(1000);const a:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),40000);receipt('J3-handoff',w,{inspected,a});expect(a.error).toBeUndefined();await vi.advanceTimersByTimeAsync(73000);const reentry:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);receipt('J3-settled190',w,{a,reentry});expect(reentry.lease).toEqual(a.lease);await vi.advanceTimersByTimeAsync(184999);receipt('J3-before-expiry',w,{a});await vi.advanceTimersByTimeAsync(1);receipt('J3-expiry',w,{inspected,a});expect(w.live(a.lease.providerLeaseId)).toBe(true);expect(w.patches().filter(r=>r.path.endsWith('/'+a.lease.providerLeaseId))).toEqual([]);});
it('J4 first loser PATCH must never extend earlier create TTL',async()=>{const w=boat({stopsRefused:true});const a:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p,config:{...cfg,ttlSeconds:180}}),170000);receipt('J4',w,{a});expect(a.error).toBeUndefined();expect(w.patches().filter(r=>r.newDeadline>r.priorDeadline)).toEqual([]);});
it('J5 failed TTL and refused stop after restart: no 300s bound, original TTL only',async()=>{const w=boat({stopsRefused:true,ttlRefused:true});const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);await restart();await plugin.definition.onHealth();const count=w.requests.length;await vi.advanceTimersByTimeAsync(1000000);receipt('J5-gap',w,{a,count});const debt:any=[...store].find(([key])=>key.includes('stop-owed'))?.[1];expect(w.live('bx_judge0')).toBe(true);expect(w.live(a.lease.providerLeaseId)).toBe(true);expect(w.requests.length).toBe(count);expect(debt.owed[0].acquisition.loserTtls.bx_judge0.outcome).toBe('failed');expect(w.stops()).toHaveLength(1);expect(w.stops()[0].body).toEqual({});await vi.advanceTimersByTimeAsync(630000);receipt('J5-original-ttl',w,{a});expect(w.live('bx_judge0')).toBe(false);});
it('J6 durable applied TTL is not renewed by a credentialed replacement replay',async()=>{const w=boat({stopsRefused:true});const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);await restart();const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);receipt('J6',w,{a,b});expect(b.error).toBeUndefined();expect(w.patches()).toHaveLength(1);expect(w.patches()[0].newDeadline).toBe(415000);});
it('J7 Boat prompt, unlike exec or SSH, can postpone loser auto-stop across TTL windows',async()=>{const w=boat({stopsRefused:true});const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);w.boxes.get('bx_judge0').promptActive=true;await restart();await plugin.definition.onHealth();await vi.advanceTimersByTimeAsync(1000000);receipt('J7',w,{a});expect(w.live('bx_judge0')).toBe(true);expect(w.boxes.get('bx_judge0').deadline).toBeGreaterThan(Date.now());});

it('J8 replacement error cleanup excludes durable returned winner',async()=>{const w=boat();const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);await restart();vi.setSystemTime(190000);const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);receipt('J8',w,{a,b});expect(a.error).toBeUndefined();expect(b.error).toBeDefined();expect(w.live(a.lease.providerLeaseId)).toBe(true);expect(w.stops().filter(r=>r.path.includes(a.lease.providerLeaseId))).toEqual([]);});

it('J9 pending discovery PATCH never lands after contender is handed to chat',async()=>{let release!:()=>void;const gate=new Promise<void>(r=>release=r);let gated=0;const w=boat({stopsRefused:true,patchGate:async(id,body)=>{if(id==='bx_judge1'&&body.ttlSeconds===300){gated++;await gate;}}});void caught(plugin.definition.onEnvironmentAcquireLease(p));await vi.advanceTimersByTimeAsync(114000);await restart();const inspection=caught(plugin.definition.onEnvironmentInspectLease({...p,providerLeaseId:'judgeop',creationOperation:{id:'judgeop',runId:'judgerun'}}));await vi.advanceTimersByTimeAsync(0);expect(gated).toBeGreaterThan(0);const a:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),2000);receipt('J9-before-release',w,{a,gated});expect(a.error).toBeUndefined();release();await vi.advanceTimersByTimeAsync(0);await inspection;receipt('J9-after-release',w,{a,gated});await vi.advanceTimersByTimeAsync(300000);receipt('J9-expiry',w,{a,gated});expect(w.live(a.lease.providerLeaseId)).toBe(true);});

it('J10 failed TTL receipt persistence must not allow replay to extend the prior applied deadline',async()=>{const w=boat({stopsRefused:true});const save=context.state.set;context.state.set=async(scope:any,value:any)=>{if(scope.stateKey==='stop-owed'&&value.owed?.some((x:any)=>Object.keys(x.acquisition?.loserTtls||{}).length))throw new Error('controlled state receipt outage');return save(scope,value);};const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);receipt('J10-before-restart',w,{a});context.state.set=save;await restart();vi.setSystemTime(175000);const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);receipt('J10-after-restart',w,{a,b});expect(a.error).toBeUndefined();expect(b.error).toBeUndefined();expect(w.patches()).toHaveLength(1);});
