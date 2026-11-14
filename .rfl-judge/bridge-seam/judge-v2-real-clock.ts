import { startSandboxCallbackBridgeWorker } from './sandbox-callback-bridge.js';
import { resolveSandboxCallbackBridgePollIntervalMs } from './execution-target.js';
const sleep = (ms:number) => new Promise<void>(r=>setTimeout(r,ms));
for (const interval of [100,resolveSandboxCallbackBridgePollIntervalMs('60000')]) {
  const start = Date.now(); let ready=false,delayed=false,handled=0;
  let settle!:()=>void;
  const received=new Promise<void>(resolve=>{settle=resolve});
  const responses:Array<{at:number;status:number}>=[];
  const failures:Array<{at:number;name:string;error:string}>=[];
  const worker=await startSandboxCallbackBridgeWorker({
    queueDir:'/judge-only/queue',pollIntervalMs:interval,
    client:{
      makeDir:async()=>{},makeDirs:async()=>{},
      listJsonFiles:async()=>{if(ready&&!delayed){delayed=true;await sleep(9000)} return ready?['judge.json']:[]},
      readTextFile:async()=>JSON.stringify({id:'judge',method:'POST',path:'/api/issues/judge/comments',query:'',headers:{},body:'{}'}),
      writeTextFile:async(_path,body)=>{responses.push({at:Date.now()-start,status:JSON.parse(body).status});settle()},
      rename:async()=>{},remove:async()=>{ready=false},
    },
    authorizeRequest:async()=>null,
    runtimeSpan:async(name,fn)=>{try{return await fn()}catch(error){failures.push({at:Date.now()-start,name,error:String(error)});throw error}},
    handleRequest:async(_request,options)=>{
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(resolve,9000);
        options?.signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(options.signal?.reason)},{once:true});
      });
      handled++;return {status:200,body:'ok'};
    },
  });
  await sleep(10);ready=true;
  let guard:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([received,new Promise<never>((_,reject)=>{guard=setTimeout(()=>reject(new Error('No response in 32s')),32000)})]);
    console.info(JSON.stringify({interval,listMs:9000,requestMs:9000,handled,responses,failures}));
  } finally {if(guard)clearTimeout(guard);await worker.stop();await sleep(interval+100)}
}
