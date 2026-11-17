// F-04G: actual server launcher/probe + emitted Boat plugin + real authenticated
// durable Runner transport. Only Boat HTTP/guest filesystem are simulated.
// A 660-second archive exceeds the unchanged ten-minute observation allowance.
// Require the permitted named, actionable fallback; never infer a process exit.
// Run from repo root after building Boat and the two Cargo binaries:
// node --import ./server/node_modules/tsx/dist/loader.mjs \
//   packages/plugins/sandbox-providers/boat/test/real-server-monitor-budget.mjs \
//   ROOT RUNNERD FAKE_CODEX OUTPUT_DIR budget
// TMPDIR must name a private scratch directory. Uses real time, not an injected
// shorter product budget. Run under an owned process reaper and await cleanup.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import assert from 'node:assert/strict';
const [R, binary, fakeCodex, OUT, CASE='budget']=process.argv.slice(2);
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
 let state='ready',armed=false,archivedAt=0,resumes=0,monitorRuns=0,monitorSuccessAfterResume=0,launches=0,exit45=0,monitorError=null;
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
   state='ready';return json({sandbox:{id,state}});
  }
  if(route.endsWith('/commands')){
   const payload=JSON.parse(init.body);
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
  if(label==='paperclip-runner-monitor'){monitorRuns++;calls.push({at:at(),event:'monitor-call',timeoutMs:request.timeoutMs,scriptMatches:request.args[1]===REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT});}
  try{
   const result=await plugin.definition.onEnvironmentExecute({...scope,lease:{providerLeaseId:id},...request});
   if(label==='paperclip-runner-monitor'){
    calls.push({at:at(),event:'monitor-result',exitCode:result.exitCode,timedOut:result.timedOut,resumes});
    if(resumes>0&&result.exitCode===0&&!result.timedOut)monitorSuccessAfterResume++;
   }
   return result;
  }
  catch(e){if(label==='paperclip-runner-monitor')monitorError={at:at(),message:e.message,code:e.code};throw e;}
 }};
 const bundle=createCapabilityRunnerdCodexTransport({
  runnerBinary:binary,codexCommand:fakeCodex,codexArgs:['--state-file',path.join(root,'fake-state.json')],
  stateDirectory:path.join(root,'controller'),environment:{},sourceCodexHome:'',
  lifecyclePolicy:{mode:'warm',idleTimeoutMs:120000},runnerReconnectGraceMs:10000,
  onDiagnostic:m=>diagnostics.push({at:at(),message:m}),
  runnerProcessLauncher:spec=>{
   launches++;
   const handle=createRemoteRunnerProcessLauncher({target:{kind:'remote',transport:'sandbox',environmentId:scope.environmentId,leaseId:id,remoteCwd:root},runner,remoteBinary:binary,
    processIdentityPath:path.join(root,'process.identity'),stateDirectory:spec.nativeRunner.stateDirectory,
    diagnosticsDirectory:path.join(root,'diagnostics'),runnerInstanceId:spec.nativeRunner.identity.runnerInstanceId,
    requireProcessStartFingerprint:true,onSpawn:async({pid})=>{pids.add(pid);calls.push({at:at(),event:'spawn',pid});}})(spec);
   handles.push(handle);void handle.completion.then(result=>calls.push({at:at(),event:'handle-resolved',exitConfirmed:handle.isExitConfirmed(),code:result.code}),error=>calls.push({at:at(),event:'handle-rejected',exitConfirmed:handle.isExitConfirmed(),message:error.message}));return handle;
  }
 });
 let failure=null,notifications,done=false,result;
 try{
  await bundle.transport.request('thread/start',{cwd:root});
  calls.push({at:at(),event:'authenticated-thread-start'});
  notifications=(async()=>{try{for await(const event of bundle.transport.notifications()){};}catch(e){failure=e.message;}finally{done=true;}})();
  armed=true;state='archiving';archivedAt=Date.now()+(mode==='budget'?660000:mode==='outlast'?45000:1000);
  const deadline=Date.now()+(mode==='budget'?615000:50000);
  while(Date.now()<deadline){
   if(failure)break;
   if(mode==='within'&&monitorSuccessAfterResume>=2)break;
   if(mode==='absent'&&launches>=2&&diagnostics.some(d=>d.message.includes('restored its durable PRP session')))break;
   await sleep(100);
  }
  const evidence=bundle.evidence();
  const pass=mode==='budget'?!!failure&&failure.startsWith('runner_process_observation_budget_exhausted:')&&/Wait for.*archiv.*finish.*recovery/i.test(failure)&&!failure.includes('runner_process_termination_unconfirmed')&&launches===1&&resumes===0&&exit45===0&&handles.every(h=>h.isExitConfirmed()===false):mode==='within'?!failure&&monitorSuccessAfterResume>=2:mode==='absent'?!failure&&exit45>0&&launches>=2&&diagnostics.some(d=>d.message.includes('restored its durable PRP session')):!failure;
  calls.push({at:at(),event:'case-verdict',verdict:pass?'PASS':'FAIL'});
  result={mode,archiveDurationMs:mode==='budget'?660000:null,clock:'real wall clock; no shortened constant or fake time',verdict:pass?'PASS':'FAIL',observedAtMs:at(),failure,resumes,launches,monitorRuns,monitorSuccessAfterResume,exit45,monitorError,evidence,diagnostics,calls,
   endLine:mode==='budget'?'native-session-executor.ts: remoteRunnerObservationExhausted -> runnerd-codex-transport.ts: #watchRunner closed observation outcome':failure?'runnerd-codex-transport.ts: #watchRunner':'native-session-executor.ts: confirmed process observation'};
 }catch(e){result={mode,verdict:'HARNESS_ERROR',message:e.message,stack:e.stack,calls,diagnostics,evidence:bundle.evidence()};}
 finally{
  calls.push({at:at(),event:'cleanup-start'});
  armed=false;state='ready';
  // Close runs the real remote signal and confirmed-exit cleanup, not a fake receipt.
  try{await bundle.transport.close();}catch(e){result.cleanupCloseError=e.message;await bundle.detachControllerForRestart().catch(()=>{});}
  const providerPid=bundle.evidence().codexPid;
  for(const pid of [...pids,...(providerPid?[providerPid]:[])]){try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
  await Promise.allSettled(handles.map(h=>h.completion));
  if(notifications)await notifications;
  await plugin.definition.onShutdown?.();globalThis.fetch=oldFetch;
 }
 rows.push(result);await fs.mkdir(OUT,{recursive:true});await fs.writeFile(path.join(OUT,'real-monitor-'+mode+'.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({mode:result.mode,verdict:result.verdict,failure:result.failure,message:result.message,resumes:result.resumes,launches:result.launches,exit45:result.exit45,endLine:result.endLine}));
}
await fs.writeFile(path.join(OUT,'real-monitor-summary.json'),JSON.stringify(rows.map(({mode,verdict,failure,message,resumes,launches,exit45,endLine})=>({mode,verdict,failure,message,resumes,launches,exit45,endLine})),null,2)+'\n');
if(rows.some(r=>r.verdict!=='PASS'))process.exitCode=1;
