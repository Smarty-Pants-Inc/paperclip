// Keep: never-OK paid-loser and handed-chat-box guards.
// Derived from rf-4 spare.18 E3, retained unchanged except the nonnegative
// post-expiry clock step; a successful short bound is already past at restart.
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
vi.mock('node:timers/promises', () => ({ setTimeout: (ms=0, value?: unknown, opts?: {signal?: AbortSignal}) => new Promise((resolve,reject) => {
 if(opts?.signal?.aborted) return reject(opts.signal.reason);
 const t=setTimeout(()=>resolve(value),ms); opts?.signal?.addEventListener('abort',()=>{clearTimeout(t);reject(opts.signal!.reason);},{once:true});
}) }));
const target=process.env.JUDGE_TARGET ?? new URL("./plugin.ts", import.meta.url).href;
let plugin:any, store:Map<string,any>, context:any, world:ReturnType<typeof boat>|undefined;
const cfg={apiKey:'boat_judge_fake_not_a_credential',type:'small',ttlSeconds:36000,reuseLease:false,labels:{}};
const p={driverKey:'boat',companyId:'judgeco',environmentId:'judgeenv',runId:'judgerun',creationOperationId:'judgeop',config:cfg};
const key=(s:any)=>JSON.stringify([s.scopeId,s.namespace,s.stateKey]);
const caught=(work:Promise<any>)=>work.then(lease=>({lease,settledAt:Date.now()}),e=>({error:{name:e.name,message:e.message,code:e.code},settledAt:Date.now()}));
const response=(v:any,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
async function restart(){const now=Date.now();vi.clearAllTimers();vi.resetModules();plugin=(await import(target)).default;vi.setSystemTime(now);world?.rearm();await plugin.definition.setup(context);}
beforeEach(async()=>{world=undefined;store=new Map();context={state:{get:async(s:any)=>structuredClone(store.get(key(s))),set:async(s:any,v:any)=>{store.set(key(s),structuredClone(v));}},logger:{info(){},warn(){},error(){},debug(){}}};vi.useFakeTimers();vi.setSystemTime(0);vi.spyOn(AbortSignal,'timeout').mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(new DOMException('timeout','TimeoutError')),ms);return c.signal;});await restart();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
type Options={primaryReady?:number;hedgeReady?:number;stopsRefused?:boolean;extension?:'500'|'late'|'short'|'retry';lateMs?:number;patchDelayMs?:number;onPatch?:(id:string,body:any,trace:any)=>Promise<void>};
// Stateful provider: TTL is a wall-clock deadline, PATCH SETS now+ttl, not adds.
// Its autonomous deadlines/late side effects survive client-worker replacement.
function boat(opts:Options={}){
 const boxes=new Map<string,any>(),requests:any[]=[],events:any[]=[],handoffs:any[]=[];let extensions=0;
 const pending=new Set<any>();
 function schedule(at:number,fn:()=>void){const e={at,fn,timer:undefined as any};pending.add(e);e.timer=setTimeout(()=>{pending.delete(e);fn();},Math.max(0,at-Date.now()));}
 function refresh(b:any){if(!b.stopped&&Date.now()>=b.deadline){b.stopped=true;events.push({at:b.deadline,kind:'auto-stop',id:b.id});}}
 function arm(b:any){const epoch=b.epoch;schedule(b.deadline,()=>{if(b.epoch===epoch)refresh(b);});}
 function snapshot(id:string){const b=boxes.get(id);refresh(b);return {id,labels:b.labels,name:b.name,state:b.stopped?'archived':Date.now()>=b.ready?'running':'provisioning',hydrated:true,setupStatus:'done',ttlSeconds:b.ttl,archiveAfter:new Date(b.deadline).toISOString(),...(b.stopped?{stoppedAt:new Date().toISOString()}:{})};}
 function apply(id:string,body:any,t:any){const b=boxes.get(id);refresh(b);if(b.stopped){t.applyRefusedAt=Date.now();return response({error:'already archived'},409);}const prior=b.deadline;
  if('ttlSeconds'in body){b.ttl=opts.extension==='short'&&id==='bx_judge1'&&body.ttlSeconds===cfg.ttlSeconds?120:body.ttlSeconds;b.deadline=Date.now()+b.ttl*1000;b.epoch++;arm(b);}
  if(body.name)b.name=body.name;if(body.labels)b.labels=body.labels;
  Object.assign(t,{appliedAt:Date.now(),priorDeadline:prior,newDeadline:b.deadline,status:200});events.push({kind:'patch-applied',id,at:Date.now(),ttl:b.ttl,priorDeadline:prior,newDeadline:b.deadline});
  return response({sandbox:snapshot(id),...(opts.extension==='short'&&id==='bx_judge1'?{giftLimitNotice:'controlled cap'}:{})});
 }
 vi.stubGlobal('fetch',vi.fn(async(input:any,init:any={})=>{
  const u=new URL(String(input)),path=u.pathname.replace('/api/v1',''),method=init.method||'GET',raw=init.body,body=raw?JSON.parse(raw):undefined;
  const t:any={at:Date.now(),method,path,query:u.search,body,rawBody:raw};requests.push(t);
  if(method==='POST'&&path==='/sandboxes'){
   const idempotencyKey=new Headers(init.headers).get('Idempotency-Key');t.idempotencyKey=idempotencyKey;
   let pair=[...boxes].find(([,b])=>b.key===idempotencyKey);
   if(pair){if(pair[1].raw!==raw)return response({error:'idempotency_key_reused'},409);}
   else{const n=boxes.size,id=`bx_judge${n}`,ttl=body.ttlSeconds??3600,b={id,key:idempotencyKey,raw,labels:body.labels,name:body.name||'Box',at:Date.now(),ready:Date.now()+(n===0?opts.primaryReady??240000:opts.hedgeReady??40000),ttl,deadline:Date.now()+ttl*1000,stopped:false,epoch:0};boxes.set(id,b);arm(b);pair=[id,b];}
   return response({sandbox:snapshot(pair[0])},202);
  }
  if(method==='GET'&&path==='/sandboxes'){const labels=u.searchParams.getAll('label').map(s=>s.split('='));return response({sandboxes:[...boxes].filter(([,b])=>labels.every(([k,v])=>b.labels[k]===v)).map(([id])=>snapshot(id)),pageInfo:{nextCursor:null}});}
  const id=path.split('/')[2];if(!boxes.has(id))return response({error:'missing'},404);
  if(method==='PATCH'){
   if(opts.onPatch)await opts.onPatch(id,body,t);
   if(id==='bx_judge1'&&body.ttlSeconds===cfg.ttlSeconds){extensions++;
    if(opts.extension==='500'||(opts.extension==='retry'&&extensions===1)){t.status=500;return response({error:'controlled failure'},500);}
    if(opts.extension==='late')return new Promise<Response>((resolve,reject)=>{
     // The provider is not cancelled by a client abort. Its completion is traced.
     schedule(Date.now()+(opts.lateMs??7000),()=>resolve(apply(id,body,t)));
     if(init.signal.aborted){t.abortedAt=Date.now();reject(init.signal.reason);}else init.signal.addEventListener('abort',()=>{t.abortedAt=Date.now();reject(init.signal.reason);},{once:true});
    });
   }
   if(opts.patchDelayMs&&body.ttlSeconds===300)return new Promise<Response>((resolve,reject)=>{
    let finished=false;schedule(Date.now()+opts.patchDelayMs!,()=>{finished=true;resolve(apply(id,body,t));});
    const abort=()=>{if(!finished){t.abortedAt=Date.now();reject(init.signal.reason);}};
    if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});
   });
   return apply(id,body,t);
  }
  if(method==='POST'&&path.endsWith('/stop')){t.status=opts.stopsRefused?403:202;if(opts.stopsRefused)return response({error:'refused'},403);boxes.get(id).stopped=true;events.push({kind:'stop',id,at:Date.now()});return response({stop:{id:'stop_'+id,status:'pending'}},202);}
  if(method==='GET')return response({sandbox:snapshot(id)});
  throw new Error(`Unexpected ${method} ${path}`);
 }));
 const w={boxes,requests,events,handoffs,snapshot,live:(id:string)=>snapshot(id).state!=='archived',patches:(ttl?:number)=>requests.filter(r=>r.method==='PATCH'&&(ttl===undefined||r.body?.ttlSeconds===ttl)),stops:()=>requests.filter(r=>r.path.endsWith('/stop')),
  rearm(){for(const e of pending){e.timer=setTimeout(()=>{pending.delete(e);e.fn();},Math.max(0,e.at-Date.now()));}},
  hand(a:any){if(a.lease){handoffs.push({id:a.lease.providerLeaseId,at:a.settledAt,deadline:boxes.get(a.lease.providerLeaseId)?.deadline});}return a;}};
 world=w;return w;
}
function receipt(name:string,w:ReturnType<typeof boat>,extra:any={}){const dir=process.env.JUDGE_TRACES;if(!dir)return;mkdirSync(dir,{recursive:true});writeFileSync(`${dir}/${name}.json`,JSON.stringify({name,target,at:Date.now(),...extra,requests:w.requests,events:w.events,handoffs:w.handoffs,boxes:[...w.boxes].map(([id,b])=>({...b,observation:w.snapshot(id)})),state:[...store]},null,2));}
async function advance(work:Promise<any>,ms:number){const result=caught(work);await vi.advanceTimersByTimeAsync(ms);return result;}
async function acquire(w:ReturnType<typeof boat>,request=p,ms=170000){const result=caught(plugin.definition.onEnvironmentAcquireLease(request)).then(a=>w.hand(a));await vi.advanceTimersByTimeAsync(ms);return result;}
function assertWinnerImmutable(w:ReturnType<typeof boat>,a:any){expect(a.error).toBeUndefined();const id=a.lease.providerLeaseId;expect(w.live(id)).toBe(true);expect(w.requests.filter(r=>(r.method==='PATCH'||r.path.endsWith('/stop'))&&r.path.split('/')[2]===id&&r.at>a.settledAt)).toEqual([]);expect(w.patches(300).filter(r=>r.path.split('/')[2]===id)).toEqual([]);}

it.each([7000,10000])('E3 late extension (%i ms) cannot overwrite terminal loser bound when non-force stop is refused',async lateMs=>{
 const w=boat({extension:'late',lateMs,primaryReady:140000,stopsRefused:true});const a:any=await acquire(w);const primaryAt=a.settledAt,hedge=w.boxes.get('bx_judge1');const count=w.requests.length;
 await vi.advanceTimersByTimeAsync(Math.max(0,hedge.at+600000+1-Date.now()));receipt('E3-late-overwrite',w,{a,primaryAt,count,finalCount:w.requests.length});
 expect(a.error).toBeUndefined();expect(a.lease.providerLeaseId).toBe('bx_judge0');expect(a.settledAt).toBeLessThan(180000);expect(hedge.deadline).toBeLessThanOrEqual(hedge.at+600000);expect(w.patches().filter(r=>r.path.endsWith('/'+a.lease.providerLeaseId))).toEqual([]);expect.soft(w.patches(cfg.ttlSeconds).some(r=>r.appliedAt>primaryAt)).toBe(false);
 expect.soft(w.live('bx_judge1')).toBe(false);expect(w.requests.length).toBe(count);assertWinnerImmutable(w,a);
 const end=hedge.deadline;await restart();await plugin.definition.onHealth();await vi.advanceTimersByTimeAsync(Math.max(0,end-Date.now()));receipt('E3-finite-final-expiry',w,{a,count,end});expect(w.live('bx_judge1')).toBe(false);expect(w.requests.length).toBe(count);
});
