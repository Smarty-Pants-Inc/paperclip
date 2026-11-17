// Full unmodified server launcher/probe + emitted Boat plugin + real authenticated
// durable Runner transport. Only Boat HTTP/guest filesystem are simulated.
// Keep: #20974 / F-04F, an observation-budget exhaustion cannot prove exit.
// Run from repo root after building Boat and the two Cargo binaries:
// node --import ./server/node_modules/tsx/dist/loader.mjs \
//   packages/plugins/sandbox-providers/boat/test/real-server-monitor.mjs \
//   ROOT RUNNERD FAKE_CODEX OUTPUT_DIR [all|within|outlast|absent|unavailable|unavailable-gone]
// Row 14 modes inject ONE HTTP network reset on an actual supervision call.
// They assert the built plugin's exact possibly-ran error, real process
// re-inspection, one provider turn and one answer. unavailable holds a turn
// in flight across the reset; unavailable-gone kills only the owned runner,
// waits for exit45 + durable restart, then submits one turn to the successor.
// The Codex provider is a local fixture, NOT a real model or live-org proof.
// TMPDIR must name a private scratch directory. The outlast case is a known RED
// until the separately authorized native monitor owner fix; no server is patched.
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import assert from 'node:assert/strict';
const [R, binary, fakeCodex, OUT, CASE='all']=process.argv.slice(2);
const {default:plugin}=await import(pathToFileURL(R+'/packages/plugins/sandbox-providers/boat/dist/plugin.js'));
const {createRemoteRunnerProcessLauncher}=await import(pathToFileURL(R+'/server/src/services/native-runtime/native-session-executor.ts'));
const {REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT}=await import(pathToFileURL(R+'/server/src/services/native-runtime/remote-runner-recovery-diagnostics.ts'));
const {createCapabilityRunnerdCodexTransport}=await import(pathToFileURL(R+'/packages/paperclip-runner/src/live/runnerd-codex-transport.ts'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const oldFetch=globalThis.fetch;
const rows=[];
for(const mode of (CASE==='all'?['within','outlast','absent']:[CASE])) {
 const root=path.join(process.env.TMPDIR,'monitor-'+mode+'-'+process.pid);await fs.mkdir(root,{recursive:true});
 const guestEnv=path.join(root,'guest-env');await fs.mkdir(guestEnv,{recursive:true});
 const id='bx_f47np3kk',scope={driverKey:'boat',companyId:'f04f-real-monitor',environmentId:'e-'+mode,config:{apiKey:'synthetic-no-network',type:'small',ttlSeconds:1800,labels:{}}};
 const unavailableMode=['unavailable','unavailable-gone'].includes(mode);
 let injected=0,activeSupervision=false,monitorSuccessAfterUnavailable=0,turnStarts=0;
 const providerCalls=path.join(root,'provider-calls.log'),releaseGate=path.join(root,'turn-release');
 const received=[],answerTexts=[],completedTurnIds=new Set();
 let state='ready',armed=false,archivedAt=0,resumes=0,monitorRuns=0,monitorSuccessAfterResume=0,launches=0,exit45=0,monitorError=null;
 let upstream=null,blocked=false;const sockets=new Set();
 const proxy=net.createServer(client=>{if(blocked){client.destroy();return;} const remote=net.connect(upstream.port,upstream.hostname);sockets.add(client);sockets.add(remote);client.on('error',()=>{});remote.on('error',()=>{});client.on('close',()=>{sockets.delete(client);remote.destroy();});remote.on('close',()=>{sockets.delete(remote);client.destroy();});client.pipe(remote);remote.pipe(client);});
 if(mode==='disconnect')await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const calls=[],handles=[],pids=new Set(),diagnostics=[];
 const now=Date.now(),at=()=>Date.now()-now;
 const map=s=>s.replaceAll('/tmp/paperclip-boat-env-',guestEnv+'/paperclip-boat-env-');
 const json=(body,status=200)=>new Response(JSON.stringify(body),{status});
 const executeLocal=(command,timeout=20000)=>new Promise(resolve=>{
  execFile('/bin/sh',['-c',map(command)],{cwd:root,env:{PATH:process.env.PATH,HOME:root,TMPDIR:process.env.TMPDIR},timeout,maxBuffer:8*1024*1024},(error,stdout,stderr)=>resolve({exitCode:error?(typeof error.code==='number'?error.code:1):0,stdout,stderr,timedOut:!!error?.killed}));
 });
 globalThis.fetch=async(url,init={})=>{
  const u=new URL(String(url));assert.equal(u.hostname,'boat.dev','No real external requests allowed');
  const route=u.pathname.replace('/api/v1',''),method=init.method??'GET';
  const row={at:at(),route,method,state};calls.push(row);
  if(method==='GET'&&route===`/sandboxes/${id}`){
   if(armed&&state==='archiving'&&Date.now()>=archivedAt)state='archived';
   row.observed=state;return json({sandbox:{id,state}});
  }
  if(route.endsWith('/resume')){
   resumes++;
   if(mode==='absent'&&armed){
    // Boat documents detached processes die on archive/resume. Kill only our
    // locally launched runner, preserving its marker and durable journal.
    for(const pid of pids){try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
    await sleep(100);
   }
   state='ready';blocked=false;return json({sandbox:{id,state}});
  }
  if(route.endsWith('/commands')){
   const payload=JSON.parse(init.body);
   if(unavailableMode&&armed&&activeSupervision&&injected===0){
    injected++;
    row.event='injected-supervision-network-reset';row.command=payload.command;
    if(mode==='unavailable-gone'){
     for(const pid of pids){try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
     await sleep(100);
    }
    // Throw only from the fake HTTP boundary. The REAL emitted Boat plugin
    // must manufacture boat_command_possibly_ran, evidence=unknown itself.
    throw Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new Error('socket reset'),{code:'ECONNRESET'})});
   }
   if(armed&&state!=='ready'){row.refused=true;return new Response('{}',{status:409});}
   const result=await executeLocal(payload.command,Math.max(20000,(payload.timeout??10)*1000));
   row.exitCode=result.exitCode;
   if(result.exitCode===45)exit45++;
   return json(result);
  }
  if(route.endsWith('/files')){
   if(method==='PUT'){const p=JSON.parse(init.body);await fs.mkdir(path.dirname(map(p.path)),{recursive:true});await fs.writeFile(map(p.path),p.content,p.encoding==='base64'?'base64':'utf8');return json({ok:true});}
   if(method==='DELETE'){await fs.rm(map(u.searchParams.get('path')),{force:true});return json({ok:true});}
  }
  if(route.endsWith('/command-history'))return json({commands:[]});
  throw Error('Unexpected fake HTTP '+method+' '+route);
 };
 await plugin.definition.setup({logger:{info(){},warn(){},error(){},debug(){}}});
 const runner={execute:async(request)=>{
  const label=request.args?.[2];
  activeSupervision=label==='paperclip-runner-monitor';
  if(label==='paperclip-runner-monitor'){monitorRuns++;calls.push({at:at(),event:'monitor-call',timeoutMs:request.timeoutMs,scriptMatches:request.args[1]===REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT});}
  try{
   const result=await plugin.definition.onEnvironmentExecute({...scope,lease:{providerLeaseId:id},...request});
   if(label==='paperclip-runner-monitor'){
    calls.push({at:at(),event:'monitor-result',exitCode:result.exitCode,timedOut:result.timedOut,resumes});
    if(resumes>0&&result.exitCode===0&&!result.timedOut)monitorSuccessAfterResume++;
    if(injected>0&&result.exitCode===0&&!result.timedOut)monitorSuccessAfterUnavailable++;
   }
   return result;
  }
  catch(e){if(label==='paperclip-runner-monitor')monitorError={at:at(),message:e.message,code:e.code};throw e;}
  finally {activeSupervision=false;}
 }};
 const bundle=createCapabilityRunnerdCodexTransport({
  runnerBinary:binary,codexCommand:fakeCodex,codexArgs:['--state-file',path.join(root,'fake-state.json'),
   ...(unavailableMode?['--call-log',providerCalls,'--durable-turn-ids','--emit-structured-activity',
     ...(mode==='unavailable'?['--turn-started-gate',releaseGate]:[])]:[])],
  stateDirectory:path.join(root,'controller'),environment:{},sourceCodexHome:'',
  lifecyclePolicy:{mode:'warm',idleTimeoutMs:120000},runnerReconnectGraceMs:10000,
  ...(mode==='disconnect'?{runnerProcessReconnectGraceMs:120000}:{}),
  onDiagnostic:m=>diagnostics.push({at:at(),message:m}),
  runnerProcessLauncher:spec=>{
   if(mode==='disconnect'){const i=spec.args.findIndex(x=>typeof x==='string'&&/^wss?:\/\//.test(x));assert.ok(i>=0,'real connect URL present');upstream=new URL(spec.args[i]);spec={...spec,args:[...spec.args]};spec.args[i]=spec.args[i].replace(upstream.host,'127.0.0.1:'+proxy.address().port);calls.push({at:at(),event:'real-prp-proxy-installed'});}
   launches++;
   const handle=createRemoteRunnerProcessLauncher({target:{kind:'remote',transport:'sandbox',environmentId:scope.environmentId,leaseId:id,remoteCwd:root},runner,remoteBinary:binary,
    processIdentityPath:path.join(root,'process.identity'),stateDirectory:spec.nativeRunner.stateDirectory,
    diagnosticsDirectory:path.join(root,'diagnostics'),runnerInstanceId:spec.nativeRunner.identity.runnerInstanceId,
    requireProcessStartFingerprint:true,onSpawn:async({pid})=>{pids.add(pid);calls.push({at:at(),event:'spawn',pid});}})(spec);
   handles.push(handle);void handle.completion.then(result=>calls.push({at:at(),event:'handle-resolved',exitConfirmed:handle.isExitConfirmed(),code:result.code}),error=>calls.push({at:at(),event:'handle-rejected',exitConfirmed:handle.isExitConfirmed(),message:error.message}));return handle;
  }
 });
 let failure=null,notifications,done=false,result,pendingTurn;
 const sendTurn=()=>{turnStarts++;pendingTurn=bundle.transport.request('turn/start',{input:[{type:'text',text:'Row 14: answer exactly once after the supervision observation.'}]}).catch(e=>{failure=e.message;});};
 try{
  await bundle.transport.request('thread/start',{cwd:root});
  calls.push({at:at(),event:'authenticated-thread-start'});
  notifications=(async()=>{try{for await(const event of bundle.transport.notifications()){
   received.push(event);
   const events=event?.method==='provider.event'?(event.params?.events??[]):[event];
   for(const e of events){
    if(e?.method==='turn/completed')completedTurnIds.add(e.params?.turn?.id??e.params?.turnId??'missing-id');
    if(e?.method==='item/completed'&&e.params?.item?.type==='agentMessage')answerTexts.push(e.params.item.text);
   }
  }}catch(e){failure=e.message;}finally{done=true;}})();
  armed=true;state=unavailableMode?'ready':'archiving';archivedAt=Date.now()+(['outlast','disconnect'].includes(mode)?45000:1000);
  if(mode==='unavailable')sendTurn();
  if(mode==='disconnect'){blocked=true;for(const socket of sockets)socket.destroy();calls.push({at:at(),event:'actual-prp-sockets-destroyed'});}
  const deadline=Date.now()+65000;
  while(Date.now()<deadline){
   if(failure)break;
   if(unavailableMode){
    if(mode==='unavailable'&&monitorSuccessAfterUnavailable>0)await fs.writeFile(releaseGate,'release');
    if(mode==='unavailable-gone'&&turnStarts===0&&exit45>0&&launches===2&&diagnostics.some(d=>d.message.includes('restored its durable PRP session')))sendTurn();
    if(completedTurnIds.size>0&&answerTexts.length>0)break;
   }
   if(['within','outlast','disconnect'].includes(mode)&&monitorSuccessAfterResume>=2)break;
   if(mode==='absent'&&launches>=2&&diagnostics.some(d=>d.message.includes('restored its durable PRP session')))break;
   await sleep(100);
  }
  const evidence=bundle.evidence();
  const callLog=await fs.readFile(providerCalls,'utf8').catch(()=>''),providerTurnStarts=callLog.split('\n').filter(x=>x.trim()==='turn/start').length;
  const expectedPluginMessage='Boat POST /sandboxes/{sandboxId}/commands failed (unavailable): result_unconfirmed, evidence=unknown (possibly ran)';
  const row14Checks={
   injectedExactlyOnce:injected===1,
   realPluginPossiblyRan:monitorError?.code==='boat_command_possibly_ran'&&monitorError?.message===expectedPluginMessage,
   answeredOnce:answerTexts.length===1&&completedTurnIds.size===1,
   noDuplicateTurns:turnStarts===1&&providerTurnStarts===1,
   noUnconfirmedTermination:![failure,...diagnostics.map(d=>d.message)].some(s=>s?.includes('runner_process_termination_unconfirmed')),
   boundedReinspect:calls.some(c=>c.event==='monitor-result'&&c.at>(monitorError?.at??Infinity)&&c.at-(monitorError?.at??0)<=10000),
   launches:launches===(mode==='unavailable'?1:2),
   ...(mode==='unavailable-gone'?{confirmedExitThenDurableRestart:exit45>0&&diagnostics.some(d=>d.message.includes('restored its durable PRP session'))}:{aliveObserved:monitorSuccessAfterUnavailable>0}),
  };
  const pass=unavailableMode?!failure&&Object.values(row14Checks).every(Boolean):mode==='absent'?!failure&&exit45>0&&launches>=2&&diagnostics.some(d=>d.message.includes('restored its durable PRP session')):!failure&&monitorSuccessAfterResume>=2;
  calls.push({at:at(),event:'case-verdict',verdict:pass?'PASS':'FAIL'});
  result={mode,verdict:pass?'PASS':'FAIL',observedAtMs:at(),failure,
   ...(unavailableMode?{row14Checks,injected,turnStarts,providerTurnStarts,callLog,answerTexts,completedTurnIds:[...completedTurnIds],received}:{}),resumes,launches,monitorRuns,monitorSuccessAfterResume,exit45,monitorError,evidence,diagnostics,calls,
   endLine:failure?'packages/paperclip-runner/src/live/runnerd-codex-transport.ts':mode==='absent'||mode==='unavailable-gone'?'packages/paperclip-runner/src/live/runnerd-codex-transport.ts':'server/src/services/native-runtime/native-session-executor.ts'};
 }catch(e){result={mode,verdict:'HARNESS_ERROR',message:e.message,stack:e.stack,calls,diagnostics,evidence:bundle.evidence()};}
 finally{
  calls.push({at:at(),event:'cleanup-start'});
  armed=false;state='ready';
  await fs.writeFile(releaseGate,'cleanup-release');
  // Close runs the real remote signal and confirmed-exit cleanup, not a fake receipt.
  try{await bundle.transport.close();}catch(e){result.cleanupCloseError=e.message;await bundle.detachControllerForRestart().catch(()=>{});}
  const providerPid=bundle.evidence().codexPid;
  for(const pid of [...pids,...(providerPid?[providerPid]:[])]){try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
  await Promise.allSettled(handles.map(h=>h.completion));
  if(notifications)await notifications;
  if(pendingTurn)await pendingTurn;
  for(const socket of sockets)socket.destroy();if(proxy.listening)await new Promise(r=>proxy.close(r));
  await plugin.definition.onShutdown?.();globalThis.fetch=oldFetch;
 }
 rows.push(result);await fs.mkdir(OUT,{recursive:true});await fs.writeFile(path.join(OUT,'real-monitor-'+mode+'.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({mode:result.mode,verdict:result.verdict,failure:result.failure,message:result.message,resumes:result.resumes,launches:result.launches,exit45:result.exit45,endLine:result.endLine}));
}
await fs.writeFile(path.join(OUT,'real-monitor-summary.json'),JSON.stringify(rows.map(({mode,verdict,failure,message,resumes,launches,exit45,endLine})=>({mode,verdict,failure,message,resumes,launches,exit45,endLine})),null,2)+'\n');
if(rows.some(r=>r.verdict!=='PASS'))process.exitCode=1;
