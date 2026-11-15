import { describe,it,expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import { canRefreshNativeAgentFiles } from "../services/native-runtime/runtime-context.js";
import { agentDirectoryWorkingCopyService } from "../services/agent-directory-working-copies.js";

describe("judge2 shell-fallback trace custody",()=>{
 it("retirement still preserves the Pi trace if persisting confined-cleanup authority fails",async()=>{
  const f=await warmAgentFilesRefreshFixture();
  try {
   const a=await f.prepare("session-a"),b=await f.prepare("session-b");
   await f.copies.checkpointWarm({companyId:f.companyId,runId:a.copy.runId,target:a.target});
   await fs.writeFile(path.join(b.copy.executionRoot,"NOTES.md"),"peer work\n");
   await f.copies.checkpointWarm({companyId:f.companyId,runId:b.copy.runId,target:b.target});
   const sessions=path.join(a.target.remoteCwd,".paperclip-runtime/paperclip-runner/sessions"),pi=path.join(sessions,a.copy.runId,"pi"),trace=path.join(pi,"session.jsonl");
   await fs.mkdir(pi,{recursive:true});await fs.writeFile(trace,"PI TRACE SENTINEL\n");
   const ancestor=path.dirname(a.copy.executionRoot);
   await fs.rename(ancestor,ancestor+"-preserved");await fs.symlink(sessions,ancestor);
   let attempted=false;
   const faulted=agentDirectoryWorkingCopyService(f.db,f.copies.get,async()=>{attempted=true;throw Error("injected DB failure persisting refresh cleanup authority");});
   const accepted=await faulted.refreshWarm({companyId:f.companyId,agentId:f.agentId,runId:a.copy.runId,target:a.target,canRefresh:async()=>true});
   const afterRefusal=await f.copies.get(f.companyId,a.copy.runId);
   const before=await fs.readFile(trace,"utf8");
   const collected=await f.copies.collectStopped({companyId:f.companyId,runId:a.copy.runId,target:a.target});
   const after=await fs.readFile(trace,"utf8").catch(()=>"MISSING");
   console.log(JSON.stringify({case:"cleanup-authority-write-failure",attempted,accepted,confined:afterRefusal?.receipt?.refreshConfinedCleanup??false,before,after,state:collected?.state,home:f.home}));
   expect(attempted).toBe(true);expect(accepted).toBe(false);expect(after).toBe("PI TRACE SENTINEL\n");
  }finally{await f.cleanup();}
 },90000);
 it.each(["ancestor-before-rename","hard-link","pi-jsonl"])("preserves Pi traces across refresh and stopped cleanup: %s",async kind=>{
  const f=await warmAgentFilesRefreshFixture();let restore=()=>{};
  try {
   const a=await f.prepare("session-a"),b=await f.prepare("session-b");
   await f.copies.checkpointWarm({companyId:f.companyId,runId:a.copy.runId,target:a.target});
   await fs.writeFile(path.join(b.copy.executionRoot,"NOTES.md"),"canonical peer work\n");
   await f.copies.checkpointWarm({companyId:f.companyId,runId:b.copy.runId,target:b.target});
   const sessions=path.join(a.target.remoteCwd,".paperclip-runtime/paperclip-runner/sessions"),pi=path.join(sessions,a.copy.runId,"pi"),trace=path.join(pi,"session.jsonl");
   await fs.mkdir(pi,{recursive:true});await fs.writeFile(trace,"PI TRACE SENTINEL\n");
   let injected=false;
   if(kind==="hard-link")await fs.link(trace,path.join(a.copy.executionRoot,"trace-link.jsonl"));
   if(kind==="pi-jsonl"){
    await fs.mkdir(path.join(a.copy.executionRoot,"pi"));
    await fs.writeFile(path.join(a.copy.executionRoot,"pi/session.jsonl"),"OTHER PI TRACE SENTINEL\n");
   }
   if(kind==="ancestor-before-rename"){
    const runner=a.target.runner!,execute=runner.execute;restore=()=>{runner.execute=execute;};
    const ancestor=path.dirname(a.copy.executionRoot);
    runner.execute=async input=>{
     const args=[...(input.args??[])];
     if(args[1]?.includes("Descriptor-relative refresh unavailable")){
      const needle="fs.renameSync(temporary,filename);";
      const insertion=`fs.renameSync(${JSON.stringify(ancestor)},${JSON.stringify(ancestor+"-preserved")});fs.symlinkSync(${JSON.stringify(sessions)},${JSON.stringify(ancestor)});`;
      expect(args[1]).toContain(needle);args[1]=args[1].replace(needle,insertion+needle);injected=true;
     }
     return execute({...input,args});
    };
   }
   const accepted=await f.copies.refreshWarm({companyId:f.companyId,agentId:f.agentId,runId:a.copy.runId,target:a.target,
    canRefresh:(canonicalRoot,entryFile)=>canRefreshNativeAgentFiles({runtimeContext:a.context,canonicalRoot,entryFile,runtimeConfig:f.runtimeConfig,runtimeSkillEntries:f.runtimeSkillEntries,adapterType:f.agent.adapterType})});
   expect(accepted).toBe(false);
   if(kind==="ancestor-before-rename")expect(injected).toBe(true);
   await f.copies.collectStopped({companyId:f.companyId,runId:a.copy.runId,target:a.target});
   await f.copies.collectStopped({companyId:f.companyId,runId:a.copy.runId,target:a.target});
   expect(await fs.readFile(trace,"utf8")).toBe("PI TRACE SENTINEL\n");
   if(kind==="pi-jsonl")expect(await fs.readFile(path.join(a.copy.executionRoot,"pi/session.jsonl"),"utf8")).toBe("OTHER PI TRACE SENTINEL\n");
   const row=await f.copies.get(f.companyId,a.copy.runId);
   console.log(JSON.stringify({case:"trace-custody",kind,accepted,injected,state:row?.state,cleanupPending:row?.receipt?.cleanupPending,home:f.home}));
  }finally{restore();await f.cleanup();}
 },90000);
});
