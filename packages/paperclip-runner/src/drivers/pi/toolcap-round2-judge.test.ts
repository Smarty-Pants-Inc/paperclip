import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PiRpcDriver, type PiRpcHarnessSession } from './pi-rpc-driver.js';
import names from './fixtures/d981-dynamic-tool-names.json';
import type { PrpEvent } from '../../protocol/replay-contract.js';

// Independent extra coverage: real pinned Pi + controlled HTTP provider, no paid inference.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const core = names.filter(n => !n.startsWith('app_'));
const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
const connections = Array.from({length:200}, (_,i) => ({...tool(`app_${String(i).padStart(3,'0')}`), paperclipToolSource: {kind:'connection', connectionId:`connection-${i}`, connectionName:`App ${i}`, installedAt:new Date(Date.UTC(2026,0,1)+i*86400000).toISOString()}}));
const large = [...connections,...core.map(name => ({...tool(name),paperclipToolSource:{kind:'core'}}))];
async function fixture(protocol: 'chat'|'messages', tools: unknown[], rejectFirst=false, addon?: string) {
  const requests: any[]=[];
  const server=createServer((req,res)=>{
    let body=''; req.setEncoding('utf8'); req.on('data',c=>body+=c); req.on('end',()=>{
      requests.push(JSON.parse(body));
      if(rejectFirst&&requests.length===1) {res.writeHead(413,{'content-type':'application/json'}).end(JSON.stringify({type:'error',error:{type:'request_too_large',message:'Controlled 413 for a large catalog'}}));return;}
      res.writeHead(200,{'content-type':'text/event-stream'});
      if(protocol==='messages') for(const e of [
        {type:'message_start',message:{id:`m-${requests.length}`,type:'message',role:'assistant',model:'faux',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0}}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Done'}},
        {type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},
        {type:'message_stop'}]) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      else { for(const c of [{choices:[{index:0,delta:{content:'Done'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}}]) res.write(`data: ${JSON.stringify({id:'m',object:'chat.completion.chunk',...c})}\n\n`); res.write('data: [DONE]\n\n'); }
      res.end();
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  cleanups.push(()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());}));
  const root=await mkdtemp(join(tmpdir(),'judge-toolcap-round2-')); const workspace=join(root,'workspace'); await mkdir(workspace);
  const port=(server.address() as {port:number}).port;
  if (addon) { await mkdir(join(root,'agent','extensions'), {recursive:true}); await writeFile(join(root,'agent','extensions','late-payload.ts'), addon); }
  const session=await new PiRpcDriver({command:process.env.PI_TEST_BINARY,model:'paperclip/faux',piRpcThinkingLevel:'off',runtimeDirectory:join(root,'sessions'),dynamicTools:tools,startupTimeoutMs:10000,shutdownTimeoutMs:1000,
    environment:{PI_OFFLINE:'1',PI_CODING_AGENT_DIR:join(root,'agent'),PAPERCLIP_AI_PROVIDER_URL:`http://127.0.0.1:${port}/v1`,PAPERCLIP_AI_PROVIDER_PROTOCOL:protocol,PAPERCLIP_AI_PROVIDER_AUTH:'none'}
  }).openSession({runId:'round2-first',normalizedSessionId:'round2',workingDirectory:workspace}) as PiRpcHarnessSession;
  cleanups.push(()=>session.close());
  const iterator=session.events()[Symbol.asyncIterator](); const events: PrpEvent[]=[];
  async function turn(){await session.startTurn({message:{role:'user',text:'Say done without calling tools'}});for(;;){const next=await iterator.next();if(next.done)throw new Error('early end');events.push(next.value);if(['turn.completed','turn.failed','turn.cancelled'].includes(next.value.eventType))return next.value;}}
  const delivered=(index=0)=>requests[index].tools.map((t:any)=>t.function?.name??t.name);
  return {session,requests,events,turn,delivered};
}

it('judge round2: 261 Chat catalog preserves core, omits the newest 137, and emits exactly one truthful notice across two turns',async()=>{
  const f=await fixture('chat',large);
  expect((await f.turn()).eventType).toBe('turn.completed');
  expect(f.delivered()).toHaveLength(128); expect(f.delivered()).toEqual(expect.arrayContaining(core));
  expect(f.delivered().filter((n:string)=>n.startsWith('app_'))).toEqual(connections.slice(0,63).map(t=>t.name));
  await f.session.attachRun({runId:'round2-first'}); expect((await f.turn()).eventType).toBe('turn.completed');
  const notices=f.events.filter(e=>e.payload.code==='pi_dynamic_tool_limit');
  expect(notices).toHaveLength(1); expect(notices[0].payload).toMatchObject({nativeToolCount:4,coreToolCount:61,deliveredToolCount:124,omittedToolCount:137});
  expect(JSON.stringify(f.requests[0].messages)).toContain(String(notices[0].payload.message));
  await writeFile(join(process.env.TASK_OUT!,'round2-261-chat-proof.json'),JSON.stringify({delivered:f.requests.map((_,i)=>f.delivered(i)),notices},null,2));
},30000);

it('judge round2: 261 Messages catalog survives a real HTTP 413 without trim/retry, gives one next step, and the next message completes',async()=>{
  const f=await fixture('messages',large,true); const first=await f.turn();
  expect(first.eventType).toBe('turn.failed'); expect(first.payload).toMatchObject({error:{code:'pi_provider_error',message:expect.stringContaining("reduce this agent's tools or ask the board")}});
  expect(f.requests).toHaveLength(1);expect(f.delivered()).toHaveLength(265);expect(f.delivered()).toEqual(expect.arrayContaining(large.map(t=>t.name)));
  const firstEvents=f.events.slice(); const nativeId=f.session.ids().providerSessionId;
  await f.session.attachRun({runId:'round2-next'}); const second=await f.turn(); expect(second.eventType).toBe('turn.completed');
  expect(f.session.ids().providerSessionId).toBe(nativeId); expect(f.requests).toHaveLength(2);expect(f.delivered(1)).toEqual(f.delivered());
  expect(firstEvents.filter(e=>/reduce this agent's tools or ask the board/i.test(JSON.stringify(e.payload)))).toHaveLength(1);
  expect(f.events.filter(e=>e.payload.code==='pi_dynamic_tool_limit')).toHaveLength(0);
  await writeFile(join(process.env.TASK_OUT!,'round2-261-messages-413-proof.json'),JSON.stringify({requestTools:f.requests.map((_,i)=>f.delivered(i)),first,second,events:f.events},null,2));
},30000);

it.each([112,116])('judge round2: Messages fitting incident-path catalog of %i dynamic tools is unchanged through two turns',async count=>{
  const selected=names.slice(0,count);const f=await fixture('messages',selected.map(tool));
  expect((await f.turn()).eventType).toBe('turn.completed');expect(f.delivered()).toHaveLength(count+4);expect(f.delivered().filter((n:string)=>selected.includes(n))).toEqual(selected);
  await f.session.attachRun({runId:'round2-next'}); expect((await f.turn()).eventType).toBe('turn.completed');expect(f.delivered(1)).toEqual(f.delivered());
  expect(f.events.filter(e=>String(e.payload.code).includes('tool_limit'))).toHaveLength(0);
  await writeFile(join(process.env.TASK_OUT!,`round2-messages-${count}-dynamic-proof.json`),JSON.stringify({dynamicCount:count,totalCounts:f.requests.map(r=>r.tools.length),names:f.delivered(),events:f.events},null,2));
},30000);

it('judge round2: final-request guard covers tools added by a supported before_provider_request addon',async()=>{
  const addon=`export default function(pi) { pi.on("before_provider_request", event => ({...event.payload, tools:[...event.payload.tools,{type:"function",function:{name:"addon_after_guard",description:"Late payload tool",parameters:{type:"object",properties:{}}}}]})); }`;
  const f=await fixture('chat',large,false,addon); const terminal=await f.turn();
  await writeFile(join(process.env.TASK_OUT!,'round2-late-payload-proof.json'),JSON.stringify({requestCounts:f.requests.map(r=>r.tools.length),terminal,events:f.events},null,2));
  expect(f.requests,'actual serialized over-cap request must be refused before HTTP').toHaveLength(0);
  expect(terminal).toMatchObject({eventType:'turn.failed',payload:{error:{code:'pi_tool_limit_exceeded'}}});
},30000);
