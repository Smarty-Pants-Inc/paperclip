import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
vi.mock('node:timers/promises', () => ({ setTimeout: (ms=0, value?: unknown, opts?: {signal?: AbortSignal}) => new Promise((resolve,reject) => {
 if(opts?.signal?.aborted) return reject(opts.signal.reason);
 const t=setTimeout(()=>resolve(value),ms); opts?.signal?.addEventListener('abort',()=>{clearTimeout(t); reject(opts.signal!.reason);},{once:true});
}) }));
// Keep: never-OK winner-stop and paid-life guards. J9 is re-pinned under
// rf-4's shipped 19:40Z ruling (RF4-SP16-VERDICT-AND-RULING.md); all other
// original rows retain their assertions. S18 covers the BRIEF ADDED condition.
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
function boat(opts:{ttlRefused?:boolean;stopsRefused?:boolean;primaryReady?:number;hedgeReady?:number;hideHedgeUntil?:number;extension?:'500'|'late'|'short'|'retry'|'delayed';patchGate?:(id:string,body:any)=>Promise<void>}={}) {
 const boxes=new Map<string,any>(), requests:any[]=[]; let extensions=0;
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
   if(id==='bx_judge1'&&body.ttlSeconds>600){
    extensions++;
    if(opts.extension==='500'||(opts.extension==='retry'&&extensions===1)){trace.status=500;return response({error:'controlled extension failure'},500);}
    if(opts.extension==='delayed')await new Promise<void>(r=>setTimeout(r,2000));
    if(opts.extension==='late')return await new Promise<Response>((resolve,reject)=>{
     // Boat applies the request despite the caller timing out. The provider
     // timer is independent of the aborted client transport.
     setTimeout(()=>{b.ttl=body.ttlSeconds;b.deadline=Date.now()+b.ttl*1000;Object.assign(trace,{appliedAt:Date.now(),priorDeadline:prior,newDeadline:b.deadline});resolve(response({sandbox:snapshot(id,b)}));},7000);
     init.signal.addEventListener('abort',()=>{trace.abortedAt=Date.now();reject(init.signal.reason);},{once:true});
    });
   }
   if('ttlSeconds'in body){b.ttl=opts.extension==='short'&&id==='bx_judge1'&&body.ttlSeconds>600?120:body.ttlSeconds;b.deadline=b.ttl===null?Infinity:Date.now()+b.ttl*1000;}
   if(body.name)b.name=body.name;if(body.labels)b.labels=body.labels;
   Object.assign(trace,{status:200,appliedAt:Date.now(),priorDeadline:prior,newDeadline:b.deadline});return response({sandbox:snapshot(id,b),...(opts.extension==='short'?{giftLimitNotice:'controlled cap'}:{})});
  }
  if(method==='POST'&&path.endsWith('/stop')){if(opts.stopsRefused)return response({error:'stop refused'},403);b.explicitStop=true;return response({stop:{id:'stop_'+id,status:'pending'}},202);}
  if(method==='GET')return response({sandbox:snapshot(id,b)});
  throw new Error(`Unexpected ${method} ${path}`);
 }));
 return {boxes,requests,snapshot,live:(id:string)=>snapshot(id,boxes.get(id)).state!=='archived',patches:()=>requests.filter(r=>r.method==='PATCH'&&r.body?.ttlSeconds===300),stops:()=>requests.filter(r=>r.path.endsWith('/stop'))};
}
function receipt(name:string,w:ReturnType<typeof boat>,extra:any={}){const dir=process.env.JUDGE_TRACES||'judge-traces';mkdirSync(dir,{recursive:true});writeFileSync(`${dir}/${name}.json`,JSON.stringify({name,target,at:Date.now(),...extra,requests:w.requests,boxes:[...w.boxes].map(([id,b])=>({...b,id,observation:w.snapshot(id,b)})),state:[...store]},null,2));}
async function advance(work:Promise<any>,ms:number){const result=caught(work);await vi.advanceTimersByTimeAsync(ms);return result;}

// Keep: never-OK money guards. rf-4's shipped ruling and BRIEF ADDED 20:12Z.
const longRequest={...p,config:{...cfg,ttlSeconds:36000}};
it.each([180,36000])('S18 never-resumed unfinished hedge auto-stops with no call within min(env TTL %i, 600)',async ttl=>{
 const request={...p,config:{...cfg,ttlSeconds:ttl}},w=boat({stopsRefused:true});
 void caught(plugin.definition.onEnvironmentAcquireLease(request));await vi.advanceTimersByTimeAsync(76000);await restart();await plugin.definition.onHealth();
 const count=w.requests.length,hedge=w.boxes.get('bx_judge1'),bound=Math.min(ttl,600);
 expect(w.requests.filter(r=>r.method==='POST'&&r.path==='/sandboxes').map(r=>r.body.ttlSeconds)).toEqual([ttl,bound]);
 expect(w.requests.filter(r=>r.method==='PATCH')).toEqual([]);expect(w.stops()).toEqual([]);
 await vi.advanceTimersByTimeAsync(hedge.at+bound*1000-1-Date.now());expect(w.live('bx_judge1')).toBe(true);
 await vi.advanceTimersByTimeAsync(1);receipt('S18-never-resumed-'+ttl,w,{count,bound});
 expect(w.live('bx_judge1')).toBe(false);expect(w.requests).toHaveLength(count);
});
it('S18 resumed unfinished hedge extends to 36000 before handoff; terminal primary stop and PATCH',async()=>{
 const w=boat({stopsRefused:true});void caught(plugin.definition.onEnvironmentAcquireLease(longRequest));await vi.advanceTimersByTimeAsync(76000);await restart();
 await plugin.definition.onEnvironmentInspectLease({...longRequest,providerLeaseId:'judgeop',creationOperation:{id:'judgeop',runId:'judgerun'}});
 expect(w.requests.filter(r=>r.method==='PATCH')).toEqual([]);expect(w.stops()).toEqual([]);
 const a:any=await advance(plugin.definition.onEnvironmentAcquireLease({...longRequest}),40000);
 receipt('S18-resumed-extension',w,{a});expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge1');
 expect(w.boxes.get('bx_judge1').ttl).toBe(36000);expect(w.boxes.get('bx_judge1').deadline).toBeGreaterThanOrEqual(a.settledAt+36000*1000);
 expect(w.requests.some(r=>r.method==='PATCH'&&r.path.endsWith('/bx_judge1')&&r.body.ttlSeconds===36000&&r.appliedAt<=a.settledAt)).toBe(true);
 expect(w.patches().map(r=>r.path)).toEqual(['/sandboxes/bx_judge0']);expect(w.stops().map(r=>r.path)).toEqual(['/sandboxes/bx_judge0/stop']);
});
it.each(['winner','failed'])('S18 unfinished becomes terminal %s elsewhere: loser stop plus PATCH within one inspection maintenance pass',async disposition=>{
 const w=boat({stopsRefused:true});void caught(plugin.definition.onEnvironmentAcquireLease(longRequest));await vi.advanceTimersByTimeAsync(76000);await restart();
 const key=[...store.keys()].find(k=>k.includes('boat-provision-hedges'))!,record=store.get(key);
 if(disposition==='winner'){record.winnerId='bx_judge0';record.handedOut=true;}else record.failed=true;
 await plugin.definition.onEnvironmentInspectLease({...longRequest,providerLeaseId:'judgeop',creationOperation:{id:'judgeop',runId:'judgerun'}});
 await vi.advanceTimersByTimeAsync(0);receipt('S18-one-terminal-pass-'+disposition,w);
 expect(w.patches().map(r=>r.path)).toEqual(['/sandboxes/bx_judge1']);expect(w.stops().map(r=>r.path)).toEqual(['/sandboxes/bx_judge1/stop']);
 expect(w.requests.filter(r=>r.method==='PATCH'&&r.path.endsWith('/bx_judge0'))).toEqual([]);
});
it('S18 normally extended winner is alive at env TTL minus one second without another call',async()=>{
 const w=boat({stopsRefused:true});const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(longRequest),116000);
 expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge1');
 await restart();await plugin.definition.onHealth();const count=w.requests.length;
 await vi.advanceTimersByTimeAsync(a.settledAt+36000*1000-1000-Date.now());receipt('S18-winner-normal-life',w,{a,count});
 expect(w.live(a.lease.providerLeaseId)).toBe(true);expect(w.requests).toHaveLength(count);
});
it.each(['500','late','short'] as const)('S18 extension %s is never a short-TTL handoff; primary serves once',async extension=>{
 const w=boat({extension,primaryReady:140000});let a:any;
 const pending=caught(plugin.definition.onEnvironmentAcquireLease(longRequest)).then(value=>a=value);
 await vi.advanceTimersByTimeAsync(116000);expect(a).toBeUndefined();
 await vi.advanceTimersByTimeAsync(54000);await pending;receipt('S18-extension-'+extension,w,{a});
 expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge0');
 const attempted=w.requests.filter(r=>r.method==='PATCH'&&r.path.endsWith('/bx_judge1')&&r.body.ttlSeconds===36000);
 expect(attempted.length).toBeGreaterThan(0);if(extension==='late')expect(attempted.some(r=>r.appliedAt>r.abortedAt)).toBe(true);
 const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...longRequest}),1000);expect(b.lease).toEqual(a.lease);
 expect(w.requests.filter(r=>r.path==='/sandboxes'&&r.method==='POST')).toHaveLength(2);expect(w.stops().some(r=>r.path.endsWith('/bx_judge0/stop'))).toBe(false);
 expect(w.stops().some(r=>r.path.endsWith('/bx_judge1/stop'))).toBe(true);
});
it('S18 transient extension 500 retries within acquire deadline, then serves a confirmed long-lived hedge',async()=>{
 const w=boat({extension:'retry'});const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(longRequest),170000);
 receipt('S18-extension-retry',w,{a});expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge1');
 const extensions=w.requests.filter(r=>r.method==='PATCH'&&r.path.endsWith('/bx_judge1')&&r.body.ttlSeconds===36000);
 expect(extensions[0].status).toBe(500);expect(extensions.some(r=>r.status===200&&r.appliedAt<=a.settledAt&&r.newDeadline>=a.settledAt+36000*1000-60000)).toBe(true);
});
it('S18 a hedge is NOT handed out while its extension confirmation is in flight',async()=>{
 const w=boat({extension:'delayed'});let a:any;
 const pending=caught(plugin.definition.onEnvironmentAcquireLease(longRequest)).then(value=>a=value);
 await vi.advanceTimersByTimeAsync(116000);expect(a).toBeUndefined();
 await vi.advanceTimersByTimeAsync(2000);await pending;receipt('S18-confirm-before-handoff',w,{a});
 expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge1');
 const confirmed=w.requests.find(r=>r.method==='PATCH'&&r.path.endsWith('/bx_judge1')&&r.body.ttlSeconds===36000);
 expect(confirmed.appliedAt).toBeLessThanOrEqual(a.settledAt);expect(confirmed.newDeadline).toBeGreaterThanOrEqual(a.settledAt+36000*1000-60000);
});

it('S18 confirmed extended hedge crash before handoff reconciles once after credentialed restart',async()=>{
 const w=boat();const save=context.state.set;let crash:any,original:any;
 // Crash after Boat's confirmed extension AND the durable winner reservation,
 // before any handoff. The old worker is abandoned at this write boundary;
 // restart() reloads the real plugin with the same durable state/provider.
 context.state.set=async(scope:any,value:any)=>{
  await save(scope,value);
  if(scope.namespace==='boat-provision-hedges'&&value.winnerId==='bx_judge1'&&!value.handedOut){
   crash={at:Date.now(),record:structuredClone(value)};
   await new Promise<void>(()=>{});
  }
 };
 void caught(plugin.definition.onEnvironmentAcquireLease(longRequest)).then(value=>original=value);
 await vi.advanceTimersByTimeAsync(116000);context.state.set=save;
 expect(crash?.record.winnerId).toBe('bx_judge1');expect(crash.record.handedOut).not.toBe(true);expect(original).toBeUndefined();
 const extension=w.requests.find(r=>r.method==='PATCH'&&r.path.endsWith('/bx_judge1')&&r.body.ttlSeconds===36000);
 expect(extension.status).toBe(200);expect(extension.appliedAt).toBeLessThanOrEqual(crash.at);
 expect(extension.newDeadline).toBeGreaterThanOrEqual(crash.at+36000*1000-60000);
 receipt('S18-confirmed-crash-before-restart',w,{crash,extension});
 await restart();
 let a:any;const resumed=caught(plugin.definition.onEnvironmentAcquireLease({...longRequest})).then(value=>a=value);
 for(let waited=0;a===undefined&&waited<170000;waited+=1000)await vi.advanceTimersByTimeAsync(1000);
 await resumed;
 const chat=new Set<string>();if(a.lease)chat.add(a.lease.providerLeaseId);
 const matching=()=>[...w.boxes].filter(([,b])=>b.labels.owner==='paperclip:judgeco'&&b.labels.environment==='judgeenv'&&b.labels.run==='judgerun'&&b.labels['paperclip-acquire']==='judgeop');
 const liveIds=()=>matching().filter(([id])=>w.live(id)).map(([id])=>id);
 receipt('S18-confirmed-crash-reconciled',w,{crash,a,chat:[...chat],liveIds:liveIds()});
 expect(liveIds()).toEqual(['bx_judge1']);expect(chat.size).toBeLessThanOrEqual(1);
 expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge1');
 // The primary has exactly one disposition: never handed, one terminal stop.
 expect(chat.has('bx_judge0')).toBe(false);expect(w.live('bx_judge0')).toBe(false);
 expect(w.stops().filter(r=>r.path==='/sandboxes/bx_judge0/stop')).toHaveLength(1);
 expect(w.stops().filter(r=>r.path==='/sandboxes/bx_judge1/stop')).toEqual([]);
 const settled=structuredClone(w.requests);await restart();
 const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...longRequest}),1000);
 if(b.lease)chat.add(b.lease.providerLeaseId);
 receipt('S18-confirmed-crash-replayed',w,{crash,a,b,chat:[...chat],liveIds:liveIds()});
 expect(b.error).toBeUndefined();expect(b.lease).toEqual(a.lease);expect(chat.size).toBe(1);expect(liveIds()).toEqual(['bx_judge1']);
 expect(matching()).toHaveLength(2);
 expect(w.requests.filter(r=>r.method==='POST'&&r.path==='/sandboxes')).toHaveLength(2);
 // A second restart must not reconcile the winner or stop the primary twice.
 expect(w.requests.filter(r=>r.method==='PATCH'||r.path.endsWith('/stop'))).toEqual(settled.filter(r=>r.method==='PATCH'||r.path.endsWith('/stop')));
});

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

it('J9 terminal loser PATCH delayed 2s races settled handoff; zero provider PATCHes to returned id',async()=>{
 let gated=0;
 const w=boat({primaryReady:100000,stopsRefused:true,patchGate:async(id,body)=>{
  if(id==='bx_judge1'&&body.ttlSeconds===300){gated++;await new Promise<void>(r=>setTimeout(r,2000));}
 }});
 let a:any;const pending=caught(plugin.definition.onEnvironmentAcquireLease(p)).then(value=>a=value);
 await vi.advanceTimersByTimeAsync(76000);
 // This unfinished record has no disposition: neither contender may be PATCHed.
 await plugin.definition.onEnvironmentInspectLease({...p,providerLeaseId:'judgeop',creationOperation:{id:'judgeop',runId:'judgerun'}});
 expect(w.requests.filter(r=>r.method==='PATCH')).toEqual([]);
 await vi.advanceTimersByTimeAsync(25000);await pending;
 expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge0');expect(gated).toBe(1);
 const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),0);
 expect(b.lease).toEqual(a.lease);receipt('J9-before-release',w,{a,b,gated});
 await vi.advanceTimersByTimeAsync(1000);receipt('J9-after-release',w,{a,b,gated});
 const loser=w.patches()[0];expect(loser.appliedAt-loser.at).toBe(2000);
 expect(w.requests.filter(r=>r.method==='PATCH'&&r.path.endsWith('/'+a.lease.providerLeaseId))).toEqual([]);
 await vi.advanceTimersByTimeAsync(300000);receipt('J9-expiry',w,{a,b,gated});expect(w.live(a.lease.providerLeaseId)).toBe(true);
});

it('J10 failed TTL receipt persistence must not allow replay to extend the prior applied deadline',async()=>{const w=boat({stopsRefused:true});const save=context.state.set;context.state.set=async(scope:any,value:any)=>{if(scope.stateKey==='stop-owed'&&value.owed?.some((x:any)=>Object.keys(x.acquisition?.loserTtls||{}).length))throw new Error('controlled state receipt outage');return save(scope,value);};const a:any=await advance(plugin.definition.onEnvironmentAcquireLease(p),170000);receipt('J10-before-restart',w,{a});context.state.set=save;await restart();vi.setSystemTime(175000);const b:any=await advance(plugin.definition.onEnvironmentAcquireLease({...p}),1000);receipt('J10-after-restart',w,{a,b});expect(a.error).toBeUndefined();expect(b.error).toBeUndefined();expect(w.patches()).toHaveLength(1);});
