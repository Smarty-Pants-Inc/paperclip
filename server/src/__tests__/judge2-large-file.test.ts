import { it,expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import { canRefreshNativeAgentFiles } from "../services/native-runtime/runtime-context.js";

it("above-8-MiB canonical save retires without truncation, then cold-prepares all bytes using real piped stdin",async()=>{
 const f=await warmAgentFilesRefreshFixture();let restore=()=>{};
 const content=Buffer.alloc(8*1024*1024+1,0x61),hash=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
 try {
  const a=await f.prepare("session-a"),b=await f.prepare("session-b");
  await f.copies.checkpointWarm({companyId:f.companyId,runId:a.copy.runId,target:a.target});
  const runner=a.target.runner!,original=runner.execute;restore=()=>{runner.execute=original;};
  // The inherited first-judge fixture tunnels stdin through an environment value.
  // That test-only shim hits Linux's per-argument limit for ordinary archive chunks.
  // Use actual stdin here, as the adapter's process contract specifies.
  runner.execute=async input=>{
   const startedAt=new Date().toISOString();
   return new Promise((resolve,reject)=>{
    const child=spawn(input.command,[...(input.args??[])],{cwd:input.cwd,env:{...process.env,...input.env},stdio:["pipe","pipe","pipe"],timeout:input.timeoutMs,killSignal:"SIGKILL"});
    const stdout:Buffer[]=[],stderr:Buffer[]=[];
    child.stdout.on("data",data=>stdout.push(Buffer.from(data)));child.stderr.on("data",data=>stderr.push(Buffer.from(data)));
    child.on("error",reject);child.stdin.on("error",()=>{});
    child.on("close",(exitCode,signal)=>resolve({exitCode:exitCode??1,signal,timedOut:signal==="SIGKILL",stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString(),pid:null,startedAt}));
    child.stdin.end(input.stdin??"");
   });
  };
  await fs.writeFile(path.join(b.copy.executionRoot,"LARGE.bin"),content);
  expect((await f.copies.checkpointWarm({companyId:f.companyId,runId:b.copy.runId,target:b.target}))?.state).toBe("warm_saved");
  const accepted=await f.copies.refreshWarm({companyId:f.companyId,agentId:f.agentId,runId:a.copy.runId,target:a.target,
   canRefresh:(canonicalRoot,entryFile)=>canRefreshNativeAgentFiles({runtimeContext:a.context,canonicalRoot,entryFile,runtimeConfig:f.runtimeConfig,runtimeSkillEntries:f.runtimeSkillEntries,adapterType:f.agent.adapterType})});
  expect(accepted).toBe(false);
  expect(await fs.readFile(path.join(a.copy.executionRoot,"AGENTS.md"),"utf8")).toBe("# Loaded policy\n");
  expect((await f.copies.collectStopped({companyId:f.companyId,runId:a.copy.runId,target:a.target}))?.state).toBe("unavailable");
  const canonical=await fs.readFile(path.join(f.root,"LARGE.bin"));
  const fresh=await f.prepare("session-fresh"),remote=await fs.readFile(path.join(fresh.copy.executionRoot,"LARGE.bin"));
  const evidence={case:"over-8mib-real-stdin",accepted,expectedBytes:content.length,canonicalBytes:canonical.length,remoteBytes:remote.length,expectedHash:hash(content),canonicalHash:hash(canonical),remoteHash:hash(remote),home:f.home};
  console.log(JSON.stringify(evidence));
  expect(canonical.length).toBe(content.length);expect(remote.length).toBe(content.length);
  expect(hash(canonical)).toBe(hash(content));expect(hash(remote)).toBe(hash(content));
 }finally{restore();await f.cleanup();}
},90000);
