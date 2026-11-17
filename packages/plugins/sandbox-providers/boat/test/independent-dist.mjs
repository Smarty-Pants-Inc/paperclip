// Adapted from supplied independent-dist.mjs; F-04D replaces the six archiving expectations.
// Paths only otherwise changed; fixture imports the existing real server predicate copy.
import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const [R,S,out]=process.argv.slice(2),B=R+'/packages/plugins/sandbox-providers/boat';
const {default:plugin}=await import(pathToFileURL(B+'/dist/plugin.js'));
const {commandPossiblyRanError}=await import(pathToFileURL(B+'/dist/command-outcome.js'));
const {providerErrorDiagnostic}=await import(pathToFileURL(S+'/packages/plugins/sdk/dist/environment-resume-error.js'));
const {transientSandboxResumeFailure}=await import(pathToFileURL(B+'/src/test-fixtures/real-resume-predicate.ts'));
const rows=[];let seq=0,id,calls,fn;
const config={apiKey:'judge-no-live',type:'small',ttlSeconds:1800,reuseLease:false,labels:{}};
const scope={driverKey:'boat',companyId:'ic',environmentId:'ie',config};
const reply=(b,s=200)=>new Response(JSON.stringify(b),{status:s});
const network=()=>{throw Object.assign(new TypeError('private'),{cause:Object.assign(new Error('private'),{code:'ECONNRESET'})})};
async function setup(f){id='bx_f47np3kk';++seq;calls=[];fn=f;await plugin.definition.setup({logger:{info(){},warn(){},error(){},debug(){}}});globalThis.fetch=async(u,i={})=>{let route=new URL(u).pathname.replace('/api/v1',''),method=i.method??'GET';const c={route,method,...(route.endsWith('/commands')&&method==='POST'?{command:JSON.parse(i.body).command}:{})};calls.push(c);const a=await fn(c,i);if(a)return a;if(c.command)return reply({exitCode:0,stdout:'ok',stderr:''});if(route.endsWith('/command-history'))return reply({commands:[]});if(route.endsWith('/files'))return reply({ok:true});if(route.endsWith('/resume'))return reply({sandbox:{id,state:'ready'}});if(route.endsWith('/stop'))return reply({operation:{id:'stop',status:'completed'}});return reply({sandbox:{id,state:'ready'}})}}
const execute=extra=>plugin.definition.onEnvironmentExecute({...scope,lease:{providerLeaseId:id},command:'charge-once',timeoutMs:5000,...extra});
async function check(name,test){let row={name};try{Object.assign(row,await test());row.verdict='PASS'}catch(e){row.verdict='FAIL';row.failure=e.message;row.stack=e.stack}finally{await plugin.definition.onShutdown?.()}rows.push(row);console.log(JSON.stringify(row))}
for(const [message,retryable] of [['previous sandbox_restoring; this command was dispatched',false],['sandbox_restoring_x',undefined],['Sandbox_Restoring',undefined],['previous sandbox_restoring; this command was dispatched',undefined],['sandbox_restoring',false]])await check('R2 '+JSON.stringify({message,retryable}),async()=>{
 await setup(c=>c.command&&calls.filter(x=>x.command).length===1?reply({error:{code:'sandbox_direct_failed',message,details:{retryable}}},502):undefined);const e=await execute().catch(e=>e);const observed={posts:calls.filter(c=>c.command).length,code:e.code,message:e.message};rows.push({name:'R2 observed',...observed});assert.equal(observed.posts,1);assert.equal(e.code,'boat_command_possibly_ran');return observed;
});
await check('R1 second leg non-idempotent network stays possibly_ran zero resends',async()=>{await setup(c=>c.command?network():undefined);const e=await execute().catch(e=>e);const posts=calls.filter(c=>c.command).length;assert.equal(posts,1);assert.equal(e.code,'boat_command_possibly_ran');assert.equal(transientSandboxResumeFailure(e),false);return {posts,resends:posts-1,code:e.code}});
for(const reason of ['network_error','timeout','aborted','http_5xx','unreadable_response'])await check('R3 '+reason,async()=>{const e=commandPossiblyRanError(reason==='http_5xx'?502:null,'network_error',reason,'unknown');const direct=transientSandboxResumeFailure(e),rpc=transientSandboxResumeFailure(new Error(e.message)),sdk=providerErrorDiagnostic(e);assert.equal(direct,false);assert.equal(rpc,false);assert.equal(sdk,null);return {message:e.message,code:e.code,reason:e.reason,direct,rpc,sdk}});
await check('R4 exact sent prefix+command+EXTRA SUFFIX is not ran',async()=>{await setup(c=>c.command?network():c.route.endsWith('/command-history')?reply({commands:[{command:calls.find(c=>c.command).command+'; EXTRA-SUFFIX'}]}):undefined);const e=await execute().catch(e=>e);assert.equal(e.evidence,'unknown');return{evidence:e.evidence,posts:calls.filter(c=>c.command).length}});
for(const shape of ['unknown-code','unreadable','no-code'])for(const safe of [false,true])await check('LIVE archiving 409 '+shape+' '+(safe?'safe mkdir':'non-idempotent'),async()=>{
 let gets=0,resumed=false,posts=0;
 await setup(c=>{if(c.command){posts++;if(posts===1)return shape==='unreadable'?new Response('not JSON',{status:409}):reply(shape==='unknown-code'?{error:{code:'unlisted_archiving_conflict',message:'http_error'},state:'archiving'}:{},409)}if(c.route.endsWith('/resume')){resumed=true;return reply({sandbox:{id,state:'ready'}})}if(c.method==='GET'&&c.route===`/sandboxes/${id}`){gets++;return reply({sandbox:{id,state:resumed?'ready':gets===1?'archiving':'archived'}})}return undefined});
 const e=await execute(safe?{env:{F04B:'fixed'}}:{}).catch(e=>e);
 const observed={shape,safe,posts,gets,resumed,error:{message:e.message,code:e.code,category:e.category,status:e.status,boatCode:e.boatCode},calls};rows.push({name:'LIVE observed',...observed});
 assert.equal(e.exitCode,0,'all refused commands must poll archived, resume, wait ready, resend');assert.equal(resumed,true);assert(gets>=2);assert.equal(posts,safe?3:2,'safe variant has the separate private-env probe plus user command');return observed;
});
fs.writeFileSync(out,JSON.stringify(rows,null,2)+'\n');const summary={passed:rows.filter(r=>r.verdict==='PASS').length,failed:rows.filter(r=>r.verdict==='FAIL').length};console.log(JSON.stringify(summary));if(summary.failed)process.exitCode=1;
