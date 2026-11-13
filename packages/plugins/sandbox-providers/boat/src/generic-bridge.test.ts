// Keep: the ruling's accepted non-S9 consumer must actually fall back, not
// merely catch a unit-test exception. Uses the exact pinned Core implementation.
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAdapterExecutionTargetPaperclipBridge, type AdapterSandboxExecutionTarget } from '../../../../adapter-utils/src/execution-target.js';
import { runChildProcess } from '../../../../adapter-utils/src/server-utils.js';
import { DUPLEX_COUNTER_FALLBACK_TOTAL } from '../../../../adapter-utils/src/duplex-observability.js';
import plugin from './plugin.js';
it.each([undefined,true])('generic bridge on an SSH-off lease: setting=%s, typed refusal then working file bridge, no retry',async setting=>{
 const root=await mkdtemp(join(tmpdir(),'routea-bridge-'));
 const scope={driverKey:'boat',companyId:'bridge-company',environmentId:'bridge-env',config:{apiKey:'fixture'},runId:'bridge-run'};
 vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({sandbox:{id:'bx_bridgeoff',state:'ready'}})));
 try{const lease=await plugin.definition.onEnvironmentAcquireLease!(scope);expect(lease.metadata?.runnerGuardianVersion).toBeUndefined();}finally{vi.unstubAllGlobals();}
 const requests:string[]=[],api=createServer((req,res)=>{requests.push(req.url!);res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,transport:'file'}));});
 await new Promise<void>(r=>api.listen(0,'127.0.0.1',r));const address=api.address() as {port:number};
 let attempts=0,refusal:unknown,commands=0;const counters:any[]=[];
 const target:AdapterSandboxExecutionTarget={kind:'remote',transport:'sandbox',providerKey:'boat',remoteCwd:root,timeoutMs:15000,streamRunLogs:false,
  effectiveCapabilities:{reusableLeases:true,nativeSyncIn:false,nativeSyncOut:false,persistentProcessSessions:false,independentControlCommands:true,incrementalSessionOutput:false,concurrentSyncOperations:false,duplexCommandStream:true,runnerWebSocketIngress:true},
  runner:{
   execute:async input=>runChildProcess('routea-file-'+(++commands),input.command==='bash'?'/bin/bash':input.command,input.args??[],{cwd:input.cwd??root,env:input.env??{},stdin:input.stdin,timeoutSec:15,graceSec:2,onLog:input.onLog??(async()=>{})}),
   openDuplexChannel:async input=>{attempts++;try{await plugin.definition.onDuplexChannelOpen!({...scope,providerLeaseId:'bx_bridgeoff',hostRouteId:'generic-off-'+attempts,command:[...input.command]});}catch(e){refusal=e;throw e;}throw Error('must not open');}
  }};
 let bridge:Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>=null;
 const started=performance.now();
 try{
  bridge=await startAdapterExecutionTargetPaperclipBridge({runId:'routea-file',target,runtimeRootDir:join(root,'.runtime'),adapterKey:'codex',hostApiToken:'fixture-run-token',hostApiUrl:`http://127.0.0.1:${address.port}`,enableSandboxDuplexBridge:setting,duplexObservabilityRecorder:{recordSpan(){},emitEvent(){},incrementCounter(r){counters.push(r);}}});
  expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe('queue_v1');
  expect(attempts).toBe(setting?1:0);if(setting)expect(refusal).toMatchObject({code:'BOAT_SSH_LEASE_UNBOUND'});
  for(let i=0;i<2;i++){
   const response=await fetch(bridge!.env.PAPERCLIP_API_URL+'/api/agents/me',{headers:{authorization:'Bearer '+bridge!.env.PAPERCLIP_API_KEY},signal:AbortSignal.timeout(5000)});
   expect(response.status).toBe(200);expect(await response.json()).toEqual({ok:true,transport:'file'});
  }
  expect(attempts).toBe(setting?1:0);expect(requests).toEqual(['/api/agents/me','/api/agents/me']);
  const fallback=counters.filter(c=>c.metric===DUPLEX_COUNTER_FALLBACK_TOTAL);expect(fallback).toHaveLength(1);expect(fallback[0].dimensions.fallback_reason).toBe(setting?'channel_open_failed':'gate_off');
  if(process.env.ROUTEA_EVIDENCE)await writeFile(join(process.env.ROUTEA_EVIDENCE,setting?'generic-fallback.json':'generic-default-off.json'),JSON.stringify({target:'51d9a5afbd2a99b974ae060a372082352174df71',setting:setting??false,attempts,code:(refusal as any)?.code,fileRequests:requests.length,mode:bridge?.env.PAPERCLIP_API_BRIDGE_MODE,fallback:fallback[0],elapsedMs:performance.now()-started},null,2));
 }finally{await bridge?.stop();await new Promise<void>(r=>api.close(()=>r()));await rm(root,{recursive:true,force:true});}
},20000);
