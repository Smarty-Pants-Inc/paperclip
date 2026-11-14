import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AcpxRuntimeHost, type AcpxRuntimeHostDependencies } from './runtime-host.js';

const cleanups:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
// Trust-boundary/recovery regression. Real legacy host + real HTTP broker; only
// the native harness port is substituted, as in pi-provider-loopback-host.test.ts.
it('judge: a legacy managed Chat session recovers on its next fitting turn after a provider tool-cap refusal',async()=>{
  const root=await mkdtemp(join(tmpdir(),'legacy-cap-'));const workspace=join(root,'workspace');await mkdir(workspace);await mkdir(join(root,'runtime'));
  const upstreamCounts:number[]=[];const statuses:number[]=[];const sessions:string[]=[];let opened=0;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);upstreamCounts.push(body.tools.length);
    if(body.tools.length>128)res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'Controlled upstream tool limit'}}));
    else res.writeHead(200,{'content-type':'application/json'}).end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const port=(server.address() as {port:number}).port;
  const options={agent:'pi' as const,model:'paperclip/vendor/model',piThinkingLevel:'low' as const,permissionMode:'approve-reads' as const,
    providerPolicy:{readOnly:false},normalizedSessionId:'legacy-cap',runtimeDirectory:join(root,'runtime'),workingDirectory:workspace,
    environment:{PATH:process.env.PATH,PI_OFFLINE:'1',PAPERCLIP_AI_PROVIDER_URL:`http://127.0.0.1:${port}/v1`,PAPERCLIP_AI_PROVIDER_PROTOCOL:'chat',PAPERCLIP_AI_PROVIDER_AUTH:'none'}};
  const dependencies:AcpxRuntimeHostDependencies={
    verifyInstallation:async profile=>({commandDigest:profile.commandDigest,agentServerPackageJsonPath:join(root,'package.json'),agentRuntimePackageJsonPath:null,
      openCommand:async()=>({spawn:()=>{throw new Error('No native process in controlled lifetime test');},close:async()=>{}})}),
    openRuntime:async launch=>{
      const id=`native-${++opened}`;
      return {
        identity:async()=>({acpxRecordId:id,backendSessionId:id,agentSessionId:id,piThinkingLevel:'low'}),
        getStatus:async()=>({models:{currentModelId:options.model}}),
        startTurn:input=>({requestId:input.requestId,promptStarted:Promise.resolve(),events:(async function*(){})(),
          result:(async()=>{
            // Select only the provider fields this test needs; never dump config.
            const config=JSON.parse(await readFile(join(launch.launchEnvironment.PI_CODING_AGENT_DIR!,'models.json'),'utf8'));
            const {baseUrl,apiKey}=config.providers.paperclip;
            const count=input.requestId==='over-cap'?129:4;sessions.push(id);
            const response=await fetch(`${baseUrl}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model:'vendor/model',messages:[],tools:Array.from({length:count},(_,i)=>({type:'function',function:{name:`t${i}`}}))})});
            statuses.push(response.status);await response.text();
            return response.status===200 ? {status:'completed' as const,stopReason:'end_turn'} : {status:'failed' as const,error:{message:'Controlled provider refusal',retryable:false}};
          })(),cancel:async()=>{},closeStream:async()=>{}}),
        close:async()=>{},
      };
    },reportRetainedCleanupFailure:failure=>{throw new Error(`cleanup failure ${failure.resource}`);}
  };
  const host=await AcpxRuntimeHost.open(options,dependencies);cleanups.push(()=>host.close({reason:'judge cleanup'}));
  const first=await host.startTurn({requestId:'over-cap',text:'first turn'}).result;
  const second=await host.startTurn({requestId:'fitting-next-turn',text:'a new next turn'}).result;
  expect(first.status).toBe('failed');
  if (process.env.TASK_OUT) await writeFile(join(process.env.TASK_OUT,'legacy-lifetime-proof.json'),JSON.stringify({statuses,upstreamCounts,sessions,opened,first,second},null,2));
  expect(opened).toBe(1);expect(sessions).toEqual(['native-1','native-1']);
  expect(statuses).toEqual([400,200]);
  expect(upstreamCounts.at(-1)).toBe(4);
},30000);
