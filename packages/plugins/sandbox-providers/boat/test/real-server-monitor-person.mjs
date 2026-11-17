// F-04G: actual server launcher/probe + emitted Boat plugin + authenticated
// durable Runner transport AND the strict Codex harness session used by the
// native backend. Only Boat HTTP/guest filesystem/model provider are fixtures.
// Keep: an answered durable command must not also reject its start admission.
// Run from repo root after building Boat and the two Cargo binaries:
// node --import ./server/node_modules/tsx/dist/loader.mjs \
//   packages/plugins/sandbox-providers/boat/test/real-server-monitor-person.mjs \
//   ROOT RUNNERD FAKE_CODEX OUTPUT_DIR [all|within|outlast|absent]
// R-ONCE: queue one unique person message before archive while the old runner
// is frozen, then prove actual confirmed-exit recovery delivers it exactly once.
// TMPDIR must name a private scratch directory. No production module is patched.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ronceChecks,roncePass} from './ronce-verdict.mjs';
const [R, binary, fakeCodex, OUT, CASE='all']=process.argv.slice(2);
assert.ok(['all','within','outlast','absent'].includes(CASE),'unknown monitor case');
const {default:plugin}=await import(pathToFileURL(R+'/packages/plugins/sandbox-providers/boat/dist/plugin.js'));
const {createRemoteRunnerProcessLauncher}=await import(pathToFileURL(R+'/server/src/services/native-runtime/native-session-executor.ts'));
const {REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT}=await import(pathToFileURL(R+'/server/src/services/native-runtime/remote-runner-recovery-diagnostics.ts'));
const {createCapabilityRunnerdCodexTransport}=await import(pathToFileURL(R+'/packages/paperclip-runner/src/live/runnerd-codex-transport.ts'));
const {CodexAppServerDriver}=await import(pathToFileURL(R+'/packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.ts'));
const {createCodexTaskEnvelope}=await import(pathToFileURL(R+'/packages/paperclip-runner/src/contracts/codex.ts'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const oldFetch=globalThis.fetch;
const rows=[];
for(const mode of (CASE==='all'?['within','outlast','absent']:[CASE])) {
 const root=path.join(process.env.TMPDIR,'monitor-'+mode+'-'+process.pid);await fs.mkdir(root,{recursive:true});
 const guestEnv=path.join(root,'guest-env');await fs.mkdir(guestEnv,{recursive:true});
 const id='bx_f47np3kk',scope={driverKey:'boat',companyId:'f04f-real-monitor',environmentId:'e-'+mode,config:{apiKey:'synthetic-no-network',type:'small',ttlSeconds:1800,labels:{}}};
 let state='ready',armed=false,archivedAt=0,resumes=0,monitorRuns=0,monitorSuccessAfterResume=0,launches=0,exit45=0,monitorError=null;
 const calls=[],handles=[],pids=new Set(),diagnostics=[],events=[];
 const token=randomUUID(),personMessage=`The code word is ${token}. Tell me my code word.`;
 const providerLog=path.join(root,'provider-receipts.jsonl');
 const readReceipts=async()=>{try{return (await fs.readFile(providerLog,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const controllerState=()=>fs.readFile(path.join(root,'controller/control-plane/control-plane-state.json'),'utf8').then(JSON.parse);
 const tokenCommands=s=>s.commands.filter(c=>c.type==='turn.start'&&c.payload.text?.includes(token));
 let pendingAtArchive=null,turnPromise=null,turnResult=null,turnError=null,finalRunState=null,once=null;
 // Test-only, bounded safety-net checks; provider notifications and monitor
 // results drive the normal path. No product polling/timer is introduced.
 const waitFor=async(predicate,ms,label)=>{const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return;await sleep(20);}throw Error('Timed out: '+label);};
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
    // locally launched runner and provider, preserving their durable journals.
    const receipts=await readReceipts();
    const providerPids=receipts.filter(r=>r.event==='provider-start').flatMap(r=>[r.pid,r.upstreamPid]);
    for(const pid of [...pids,...providerPids]){try{process.kill(pid,'SIGKILL');calls.push({at:at(),event:'archive-process-killed',pid});}catch(e){if(e.code!=='ESRCH')throw e;}}
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
  runnerBinary:binary,
  codexCommand:mode==='absent'?process.execPath:fakeCodex,
  codexArgs:[...(mode==='absent'?[fileURLToPath(new URL('./ronce-fake-provider.mjs',import.meta.url)),fakeCodex,providerLog]:[]),'--state-file',path.join(root,'fake-state.json')],
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
 let failure=null,notifications,done=false,result,session;
 const personEvents=[];
 const driverTransport=new Proxy(bundle.transport,{get(target,key){
  if(key==='notifications')return async function*(){for await(const event of target.notifications()){events.push({at:at(),...event});yield event;}};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 try{
  const workspace=path.join(root,'workspace'),home=path.join(root,'home');
  await fs.mkdir(workspace,{recursive:true});await fs.mkdir(home,{recursive:true});
  session=await new CodexAppServerDriver({taskEnvelope:createCodexTaskEnvelope({objective:personMessage}),
   conversationMode:'direct',transportFactory:()=>driverTransport,environment:{HOME:home,PATH:process.env.PATH},
   capabilities:{goals:false}}).openSession({runId:'person-'+mode,normalizedSessionId:'person-session-'+mode,workingDirectory:workspace});
  calls.push({at:at(),event:'authenticated-thread-start'});
  notifications=(async()=>{try{for await(const event of session.events()){
   personEvents.push(event);
   if(/^(?:turn|session)\.failed$/.test(event.eventType))failure=`${event.eventType}: ${event.payload?.message??event.payload?.code??'strict session failed'}`;
  }}catch(e){failure=e.message;}finally{done=true;}})();
  if(mode==='absent'){
   // Freeze is a fault injection, not an exit receipt. The real process probe
   // must still establish absence after resume before a replacement may launch.
   for(const pid of pids)process.kill(pid,'SIGSTOP');
   await waitFor(async()=>{for(const pid of pids){if(!/^State:\s+T/m.test(await fs.readFile(`/proc/${pid}/status`,'utf8')))return false;}return true;},2000,'old runner stopped');
   turnPromise=session.startTurn({message:{role:'user',text:personMessage}}).then(r=>{turnResult=r;return r;},e=>{turnError=e.message;return null;});
   await waitFor(async()=>tokenCommands(await controllerState()).length===1,2000,'durable queued person message');
   const commands=tokenCommands(await controllerState());
   assert.equal(commands[0].status,'pending');
   const beforeArchiveReceipts=await readReceipts();
   const providerTokenTurns=beforeArchiveReceipts.filter(r=>r.event==='turn-input'&&JSON.stringify(r.input).includes(token)).length;
   const answerCount=beforeArchiveReceipts.filter(r=>r.event==='answer').length;
   assert.equal(beforeArchiveReceipts.filter(r=>r.event==='turn-input').length,0);
   assert.equal(answerCount,0);
   const oldRunnerStatuses=await Promise.all([...pids].map(async pid=>({pid,state:(await fs.readFile(`/proc/${pid}/status`,'utf8')).match(/^State:\s+(\S+)/m)?.[1]})));
   pendingAtArchive={at:at(),personMessage,commands,providerTokenTurns,answerCount,oldRunnerPids:[...pids],oldRunnerStatuses,beforeArchiveReceipts};
   calls.push({at:at(),event:'person-message-durably-pending-before-archive'});
  }
  armed=true;state='archiving';archivedAt=Date.now()+(mode==='outlast'?45000:1000);
  calls.push({at:at(),event:'archive-start'});
  const deadline=Date.now()+50000;
  while(Date.now()<deadline){
   if(failure||turnError)break;
   if((mode==='within'||mode==='outlast')&&monitorSuccessAfterResume>=2)break;
   if(mode==='absent'&&launches>=2&&diagnostics.some(d=>d.message.includes('restored its durable PRP session'))&&events.some(e=>e.method==='turn/completed'))break;
   await sleep(100);
  }
  let authenticatedAnswer=null;
  if(!failure&&!turnError){
   authenticatedAnswer=await bundle.transport.request('thread/read',{threadId:'codex-thread-1',includeTurns:true});
   assert.equal(authenticatedAnswer.thread.id,'codex-thread-1');
  }
  if(mode==='absent'){
   await waitFor(()=>turnResult!==null||turnError!==null,5000,'pending person turn result');
   // An authenticated round-trip plus two fresh supervision observations and a
   // bounded quiet period expose late duplicate turns on either generation.
   if(!failure&&!turnError){
    const healthy=monitorSuccessAfterResume;
    await waitFor(()=>monitorSuccessAfterResume>=healthy+2||failure,6000,'post-answer supervision');
    await sleep(1500);
   }
   const journal=await controllerState();
   const runnerState=JSON.parse(await fs.readFile(path.join(root,'controller/runner/runner-state.json'),'utf8'));
   finalRunState={controllerCommands:tokenCommands(journal),runnerLifecycle:runnerState.lifecycle,runnerActiveTurn:runnerState.activeTurn??null,providerState:JSON.parse(await fs.readFile(path.join(root,'fake-state.json'),'utf8')),thread:authenticatedAnswer?.thread,transportFailure:failure,turnResult,turnError,notificationsDone:done};
   const receipts=await readReceipts();
   const inputs=receipts.filter(r=>r.event==='turn-input');
   const answers=receipts.filter(r=>r.event==='answer');
   const visible=events.filter(e=>e.method==='item/completed'&&e.params?.item?.type==='agentMessage');
   once={token,personMessage,turnInputs:inputs,answers,visibleAnswers:visible,tokenTurnCount:inputs.filter(r=>JSON.stringify(r.input).includes(token)).length,tokenAnswerCount:answers.filter(r=>r.text.includes(token)).length,visibleTokenAnswerCount:visible.filter(r=>r.params.item.text?.includes(token)).length,completedTurnCount:events.filter(e=>e.method==='turn/completed'&&e.params?.turn?.status==='completed').length,providerReceipts:receipts};
  }
  const evidence=bundle.evidence();
  const observed={failure,once,pendingAtArchive,finalRunState,exit45,launches,calls,diagnostics,events};
  const checks=mode==='absent'?ronceChecks(observed):null;
  const requestAdmission=mode==='absent'?{verdict:turnError?'FAIL':'PASS',error:turnError,result:turnResult}:null;
  const personFailureEvents=personEvents.filter(e=>/^(?:turn|session)\.failed$/.test(e.eventType));
  const acceptedTurns=personEvents.filter(e=>e.eventType==='turn.accepted');
  const completedTurns=personEvents.filter(e=>e.eventType==='turn.completed');
  const personView={failureEvents:personFailureEvents,admissionRejected:turnError!==null,acceptedTurns:acceptedTurns.length,completedTurns:completedTurns.length,
   scope:'real server launcher/probe, durable transport and strict Codex harness session; not an HTTP/DB or browser acceptance claim'};
  const pass=!failure&&!!authenticatedAnswer&&(mode==='absent'?roncePass(observed)&&requestAdmission.verdict==='PASS'&&personFailureEvents.length===0&&acceptedTurns.length===1&&completedTurns.length===1:monitorSuccessAfterResume>=2);
  calls.push({at:at(),event:'case-verdict',verdict:pass?'PASS':'FAIL'});
  result={mode,verdict:pass?'PASS':'FAIL',observedAtMs:at(),failure,resumes,launches,monitorRuns,monitorSuccessAfterResume,exit45,monitorError,pendingAtArchive,once,checks,requestAdmission,personView,personEvents,finalRunState,authenticatedAnswer,evidence,diagnostics,calls,events,
   endLine:failure?'packages/paperclip-runner/src/live/runnerd-codex-transport.ts:8743-8748':mode==='absent'?'packages/paperclip-runner/src/live/runnerd-codex-transport.ts:8896-8898':'server/src/services/native-runtime/native-session-executor.ts:14980-14984'};
 }catch(e){result={mode,verdict:'HARNESS_ERROR',message:e.message,stack:e.stack,calls,diagnostics,evidence:bundle.evidence()};}
 finally{
  calls.push({at:at(),event:'cleanup-start'});
  armed=false;state='ready';
  // Close runs the real remote signal and confirmed-exit cleanup, not a fake receipt.
  try{if(session)await session.close({reason:'person proof complete'});await bundle.transport.close();}catch(e){result.cleanupCloseError=e.message;await bundle.detachControllerForRestart().catch(()=>{});}
  if(turnPromise)await turnPromise;
  const providerPid=bundle.evidence().codexPid;
  const allProviderPids=(await readReceipts()).filter(r=>r.event==='provider-start').flatMap(r=>[r.pid,r.upstreamPid]);
  for(const pid of [...pids,...allProviderPids,...(providerPid?[providerPid]:[])]){try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e;}}
  await Promise.allSettled(handles.map(h=>h.completion));
  if(notifications)await notifications;
  if(result.personView){
   result.personView.failureEvents=personEvents.filter(e=>/^(?:turn|session)\.failed$/.test(e.eventType));
   result.personView.cleanupCloseError=result.cleanupCloseError??null;
   if(result.personView.failureEvents.length||result.cleanupCloseError)result.verdict='FAIL';
  }
  if(mode==='absent'){
   await fs.mkdir(OUT,{recursive:true});
   await fs.copyFile(providerLog,path.join(OUT,'provider-receipts.jsonl')).catch(e=>{if(e.code!=='ENOENT')throw e;});
   const terminalReceipts=await readReceipts();
   const terminalInputs=terminalReceipts.filter(r=>r.event==='turn-input');
   const terminalAnswers=terminalReceipts.filter(r=>r.event==='answer');
   const ownedPids=[...pids,...allProviderPids];
   const processes=await Promise.all(ownedPids.map(async pid=>{try{const status=await fs.readFile(`/proc/${pid}/status`,'utf8');return {pid,state:status.match(/^State:\s+(\S+)/m)?.[1]};}catch(e){if(e.code==='ENOENT')return {pid,state:'absent'};throw e;}}));
   result.cleanup={turnRequestSettled:turnResult!==null||turnError!==null,notificationsDone:done,handleResults:await Promise.allSettled(handles.map(h=>h.completion)),ownedPids,processes,terminalReceipts,terminalInputCount:terminalInputs.length,terminalAnswerCount:terminalAnswers.length};
   if(result.verdict==='PASS'&&(terminalInputs.length!==1||terminalAnswers.length!==1||!processes.every(p=>p.state==='absent'||p.state==='Z'))){result.verdict='FAIL';result.cleanupFailure='late duplicate or owned live process';}
  }
  await plugin.definition.onShutdown?.();globalThis.fetch=oldFetch;
 }
 rows.push(result);await fs.mkdir(OUT,{recursive:true});await fs.writeFile(path.join(OUT,'real-monitor-'+mode+'.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({mode:result.mode,verdict:result.verdict,requestAdmission:result.requestAdmission?.verdict??null,requestError:result.requestAdmission?.error??null,failure:result.failure,message:result.message,resumes:result.resumes,launches:result.launches,exit45:result.exit45,endLine:result.endLine}));
}
await fs.writeFile(path.join(OUT,'real-monitor-summary.json'),JSON.stringify(rows.map(({mode,verdict,requestAdmission,failure,message,resumes,launches,exit45,endLine})=>({mode,verdict,requestAdmission:requestAdmission?.verdict??null,requestError:requestAdmission?.error??null,failure,message,resumes,launches,exit45,endLine})),null,2)+'\n');
if(rows.some(r=>r.verdict!=='PASS'))process.exitCode=1;
