import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { warmAgentFilesRefreshFixture } from "./helpers/warm-agent-files-refresh.js";
import { canRefreshNativeAgentFiles } from "../services/native-runtime/runtime-context.js";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";

async function fixture() {
  const f = await warmAgentFilesRefreshFixture();
  await fs.writeFile(path.join(f.root, "KEEP.md"), "checkpoint bytes\n");
  await fs.writeFile(path.join(f.root, "OBSOLETE.md"), "obsolete checkpoint\n");
  await fs.mkdir(path.join(f.root, "old-dir"));
  await fs.writeFile(path.join(f.root, "old-dir/child"), "old child\n");
  const a = await f.prepare("session-a"), b = await f.prepare("session-b");
  await f.copies.checkpointWarm({companyId:f.companyId, runId:a.copy.runId, target:a.target});
  await fs.rename(path.join(b.copy.executionRoot,"OBSOLETE.md"), path.join(f.home,"peer-obsolete-preserved"));
  await fs.rename(path.join(b.copy.executionRoot,"old-dir"), path.join(f.home,"peer-old-dir-preserved"));
  await fs.mkdir(path.join(b.copy.executionRoot,"nested"));
  await fs.writeFile(path.join(b.copy.executionRoot,"nested/PEER.md"),"peer save\n");
  await f.copies.checkpointWarm({companyId:f.companyId, runId:b.copy.runId, target:b.target});
  const refresh = () => f.copies.refreshWarm({companyId:f.companyId, agentId:f.agentId, runId:a.copy.runId, target:a.target,
    canRefresh:(canonicalRoot,entryFile)=>canRefreshNativeAgentFiles({runtimeContext:a.context,canonicalRoot,entryFile,
      runtimeConfig:f.runtimeConfig,runtimeSkillEntries:f.runtimeSkillEntries,adapterType:f.agent.adapterType})});
  const collect = () => f.copies.collectStopped({companyId:f.companyId,runId:a.copy.runId,target:a.target});
  return {f,a,b,refresh,collect};
}

describe("judge2 independent refresh variants",()=>{
  it.each(["new", "deleted", "mode"])("saves an unsaved %s change through normal retirement",async kind=>{
    const {f,a,refresh,collect}=await fixture();
    try {
      if(kind==="new") await fs.writeFile(path.join(a.copy.executionRoot,"NEW.md"),"owner new\n");
      if(kind==="deleted") await fs.rename(path.join(a.copy.executionRoot,"KEEP.md"),path.join(f.home,"owner-deleted-preserved"));
      if(kind==="mode") await fs.chmod(path.join(a.copy.executionRoot,"KEEP.md"),0o755);
      expect(await refresh()).toBe(false);
      const collected=await collect();
      expect(collected?.state).toBe("saved");
      if(kind==="new") expect(await fs.readFile(path.join(f.root,"NEW.md"),"utf8")).toBe("owner new\n");
      if(kind==="deleted") await expect(fs.stat(path.join(f.root,"KEEP.md"))).rejects.toHaveProperty("code","ENOENT");
      if(kind==="mode") expect((await fs.stat(path.join(f.root,"KEEP.md"))).mode&0o777).toBe(0o755);
      console.log(JSON.stringify({case:"dirty-"+kind,state:collected?.state,home:f.home}));
    } finally {await f.cleanup();}
  },90000);

  it.each(["KEEP.md","OBSOLETE.md"])("does not erase %s edited after the final hash, before mutation",async name=>{
    const {f,a,refresh}=await fixture();
    const runner=a.target.runner!, execute=runner.execute;
    let injected=false;
    runner.execute=async input=>{
      const args=[...(input.args??[])];
      if(args[1]?.includes("Descriptor-relative refresh unavailable")){
        const needle="const parentOf=name=>";
        expect(args[1]).toContain(needle);
        args[1]=args[1].replace(needle,`fs.writeFileSync(root+\"/${name}\",\"UNSAVED BETWEEN HASH AND WRITE\\n\"); const parentOf=name=>`);
        injected=true;
      }
      return execute({...input,args});
    };
    try {
      const accepted=await refresh();
      const after=await fs.readFile(path.join(a.copy.executionRoot,name),"utf8").catch(()=>"MISSING");
      const row=await f.copies.get(f.companyId,a.copy.runId);
      console.log(JSON.stringify({case:"after-final-hash",name,injected,accepted,after,state:row?.state,home:f.home}));
      expect(injected).toBe(true);
      expect({accepted,after}).toEqual({accepted:false,after:"UNSAVED BETWEEN HASH AND WRITE\n"});
    } finally {runner.execute=execute;await f.cleanup();}
  },90000);

  it("saves an owner edit made after observation but before the guarded transfer",async()=>{
    const {f,a,refresh,collect}=await fixture();
    const original=executionTargetTools.prepareAdapterExecutionTargetRuntime;
    const spy=vi.spyOn(executionTargetTools,"prepareAdapterExecutionTargetRuntime");
    let injected=false;
    spy.mockImplementation(async input=>{
      if(input.adapterKey==="agent-files" && input.workspaceRefreshGuard){
        await fs.writeFile(path.join(a.copy.executionRoot,"KEEP.md"),"UNSAVED BEFORE GUARD\n");injected=true;
      }
      return original(input);
    });
    try {
      const accepted=await refresh(), before=await fs.readFile(path.join(a.copy.executionRoot,"KEEP.md"),"utf8");
      const collected=await collect(), after=await fs.readFile(path.join(f.root,"KEEP.md"),"utf8");
      const exists=await fs.stat(a.copy.executionRoot).then(()=>true,()=>false);
      console.log(JSON.stringify({case:"after-observation",injected,accepted,before,collected:collected?.state,after,liveExists:exists,home:f.home}));
      expect(injected).toBe(true);expect(accepted).toBe(false);
      expect(after).toBe("UNSAVED BEFORE GUARD\n");
    } finally {spy.mockRestore();await f.cleanup();}
  },90000);

  it("a crash after the mark and before the first write leaves canonical and live bytes clean",async()=>{
    const {f,a,refresh,collect}=await fixture();
    const original=executionTargetTools.prepareAdapterExecutionTargetRuntime;
    const spy=vi.spyOn(executionTargetTools,"prepareAdapterExecutionTargetRuntime");let marked=false;
    spy.mockImplementation(async input=>{
      if(input.workspaceRefreshGuard){
        const row=await f.copies.get(f.companyId,a.copy.runId);
        marked=row?.state==="unavailable"&&row?.errorCode==="AGENT_FILES_REFRESH_INCOMPLETE";
        throw Error("simulated crash before first mutation");
      }
      return original(input);
    });
    try {
      expect(await refresh()).toBe(false);expect(marked).toBe(true);
      expect(await fs.readFile(path.join(a.copy.executionRoot,"OBSOLETE.md"),"utf8")).toBe("obsolete checkpoint\n");
      expect(await fs.readFile(path.join(a.copy.localRoot,"OBSOLETE.md"),"utf8")).toBe("obsolete checkpoint\n");
      expect((await collect())?.state).toBe("unavailable");
      expect(await fs.readFile(path.join(f.root,"nested/PEER.md"),"utf8")).toBe("peer save\n");
      expect(await fs.readFile(path.join(f.root,"AGENTS.md"),"utf8")).toBe("# Loaded policy\n");
      console.log(JSON.stringify({case:"crash-before-first-write",marked,home:f.home}));
    } finally {spy.mockRestore();await f.cleanup();}
  },90000);

  it.each([
    ["unlink","fs.unlinkSync(filename);"],
    ["rmdir","fs.rmdirSync(filename);"],
    ["mkdir","fs.mkdirSync(filename,{mode:0o700});"],
    ["open","const file=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);"],
    ["write","fs.writeFileSync(file,Buffer.from(e.data,'base64'));"],
    ["chmod","fs.fchmodSync(file,e.mode&0o777);"],
    ["fsync","fs.fsyncSync(file);"],
    ["rename","fs.renameSync(temporary,filename);"],
  ])("never publishes a transfer failed at %s",async(step,needle)=>{
    const {f,a,refresh,collect}=await fixture();const runner=a.target.runner!,execute=runner.execute;let injected=false,marked=false;
    runner.execute=async input=>{
      const args=[...(input.args??[])];
      if(args[1]?.includes("Descriptor-relative refresh unavailable")){
        const row=await f.copies.get(f.companyId,a.copy.runId);marked=row?.state==="unavailable"&&row?.errorCode==="AGENT_FILES_REFRESH_INCOMPLETE";
        // The command is shell-quoted. Mutate the unquoted source then apply the same quoting.
        const quoted=needle.replaceAll("'",`'"'"'`);
        expect(args[1]).toContain(quoted);
        args[1]=args[1].replace(quoted,quoted+`throw Error("judge2 fail after ${step}");`);injected=true;
      }
      return execute({...input,args});
    };
    try {
      expect(await refresh()).toBe(false);expect(injected).toBe(true);expect(marked).toBe(true);
      expect((await collect())?.state).toBe("unavailable");
      expect(await fs.readFile(path.join(f.root,"AGENTS.md"),"utf8")).toBe("# Loaded policy\n");
      expect(await fs.readFile(path.join(f.root,"KEEP.md"),"utf8")).toBe("checkpoint bytes\n");
      expect(await fs.readFile(path.join(f.root,"nested/PEER.md"),"utf8")).toBe("peer save\n");
      await expect(fs.stat(path.join(f.root,"OBSOLETE.md"))).rejects.toHaveProperty("code","ENOENT");
      console.log(JSON.stringify({case:"failure-step",step,marked,home:f.home}));
    } finally {runner.execute=execute;await f.cleanup();}
  },90000);

  it("rejects a file above 8 MiB without truncation and prepares its full bytes afresh",async()=>{
    const {f,a,refresh,collect}=await fixture();
    const content=Buffer.alloc(8*1024*1024+1,0x61);
    try {
      // A canonical save equivalent under the same lock-free test isolation; no selected skill/instruction changes.
      await fs.writeFile(path.join(f.root,"LARGE.bin"),content);
      expect(await refresh()).toBe(false);
      expect(await fs.readFile(path.join(f.root,"LARGE.bin"))).toEqual(content);
      expect(await fs.readFile(path.join(a.copy.executionRoot,"KEEP.md"),"utf8")).toBe("checkpoint bytes\n");
      expect((await collect())?.state).toBe("unavailable");
      const next=await f.prepare("session-fresh");
      expect(await fs.readFile(path.join(next.copy.executionRoot,"LARGE.bin"))).toEqual(content);
      console.log(JSON.stringify({case:"over-8mib",bytes:content.length,fresh:true,home:f.home}));
    } finally {await f.cleanup();}
  },90000);
});
