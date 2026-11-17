import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PiRpcDriver, type PiRpcHarnessSession } from './pi-rpc-driver.js';
import { PiRpcTransport } from './pi-rpc-transport.js';

it('independent actual managed driver: cold recover retains identity AND delivers it to gateway', async () => {
  const root = await mkdtemp(join(tmpdir(), 'judge-affinity-'));
  const home = join(root,'home'), agent = join(home,'agent'), workspace = join(root,'workspace');
  await mkdir(agent,{recursive:true}); await mkdir(workspace);
  const requests:any[]=[]; const launches:any[]=[]; const events:any[]=[]; const native:PiRpcTransport[]=[];
  const peer=createServer((req,res)=>{ let text=''; req.setEncoding('utf8'); req.on('data',c=>text+=c); req.on('end',()=>{
    requests.push({headers:req.headers,body:JSON.parse(text)});
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const c of [{choices:[{index:0,delta:{content:'ok'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}])res.write(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',...c})}\n\n`);
    res.end('data: [DONE]\n\n');
  });});
  await new Promise<void>(r=>peer.listen(0,'127.0.0.1',r)); const address=peer.address() as any;
  const binary=resolve('node_modules/.bin/pi');
  const driver=()=>new PiRpcDriver({ command:binary,model:'paperclip/affinity-proof',piRpcThinkingLevel:'off',runtimeDirectory:join(root,'sessions'), startupTimeoutMs:20000,
    environment:{PATH:process.env.PATH,HOME:home,PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1',PI_SKIP_VERSION_CHECK:'1',PAPERCLIP_AI_PROVIDER_URL:`http://127.0.0.1:${address.port}/v1`,PAPERCLIP_AI_PROVIDER_PROTOCOL:'chat',PAPERCLIP_AI_PROVIDER_AUTH:'none'},
    transportFactory:options=>{ launches.push({args:options.args,env:options.env,cwd:options.cwd}); const transport=new PiRpcTransport(options);native.push(transport);return transport; }
  });
  let session:PiRpcHarnessSession|undefined; const proof:any={root,binary,status:'running',requests,launches,events};
  async function turn(s:PiRpcHarnessSession){ const iterator=s.events()[Symbol.asyncIterator](); await s.startTurn({message:{role:'user',text:'Reply ok.'}}); for(;;){ const next=await iterator.next(); if(next.done)throw Error('events ended');events.push(next.value);if(next.value.eventType==='turn.completed')break;if(next.value.eventType==='turn.failed')throw Error(JSON.stringify(next.value)); } }
  try{
    session=await driver().openSession({runId:'first',normalizedSessionId:'judge-one',workingDirectory:workspace}) as PiRpcHarnessSession;
    proof.first={pid:session.processPid(),ids:session.ids()}; await turn(session); const snapshot=await session.snapshot();proof.snapshot=snapshot; await session.close({reason:'cold relaunch'});session=undefined;
    proof.firstExited=native[0].exited;expect(proof.firstExited).toBe(true);
    const recovered=await driver().recoverSession(snapshot,{signal:new AbortController().signal}); expect(recovered.recovered).toBe(true);session=recovered.session as PiRpcHarnessSession;
    proof.recovered={pid:session.processPid(),ids:session.ids()}; await turn(session);await session.close({reason:'done'});session=undefined;
    session=await driver().openSession({runId:'other',normalizedSessionId:'judge-two',workingDirectory:workspace}) as PiRpcHarnessSession;
    proof.other={pid:session.processPid(),ids:session.ids()};await turn(session);await session.close({reason:'done'});session=undefined;
    expect(proof.recovered.ids.providerSessionId).toBe(proof.first.ids.providerSessionId);
    expect(proof.recovered.pid).not.toBe(proof.first.pid);
    expect(proof.other.ids.providerSessionId).not.toBe(proof.first.ids.providerSessionId);
    expect(requests).toHaveLength(3);
    proof.bodyLeaks=requests.map((r,i)=>JSON.stringify(r.body).includes(i===2?proof.other.ids.providerSessionId:proof.first.ids.providerSessionId));
    proof.envLeaks=launches.map((l,i)=>JSON.stringify(l.env).includes(i===2?proof.other.ids.providerSessionId:proof.first.ids.providerSessionId));
    proof.eventIdentityOccurrences=events.filter(e=>JSON.stringify(e).includes(proof.first.ids.providerSessionId)).map(e=>({eventType:e.eventType,payload:e.payload}));
    proof.sessionHeader=requests.map(r=>r.headers['x-session-id']??null);
    proof.status='captured';
    expect(proof.bodyLeaks).toEqual([false,false,false]);
    expect(proof.envLeaks).toEqual([false,false,false]);
    expect(proof.sessionHeader).toEqual([proof.first.ids.providerSessionId,proof.first.ids.providerSessionId,proof.other.ids.providerSessionId]);
  }catch(e){proof.error=String(e);proof.status='failed';throw e;}
  finally{await session?.close({reason:'cleanup'});for(const t of native)if(!t.exited)await t.close();peer.closeAllConnections();await new Promise<void>(r=>peer.close(()=>r()));proof.children=native.map(t=>({pid:t.pid,exited:t.exited,absent:!existsSync(`/proc/${t.pid}`)}));await writeFile(join(process.env.TASK_OUT!,'driver-cold-proof.json'),JSON.stringify(proof,null,2));}
},100000);
