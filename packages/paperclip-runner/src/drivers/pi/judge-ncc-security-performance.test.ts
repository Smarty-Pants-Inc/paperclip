// Independent RFL checks; local Pi, no real account, network service, or credentials.
// Install in packages/paperclip-runner/src/drivers/pi/judge-ncc-security-performance.test.ts.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { piCompileCacheEnvironment } from "./pi-compile-cache-environment.js";
import { PiRpcDriver } from "./pi-rpc-driver.js";
const binary = process.env.PI_TEST_BINARY!;
const proofs = process.env.JUDGE_PROOF_DIRECTORY!;
const files = async (root: string) => (await readdir(root,{recursive:true}).catch(() => [])).filter(p => !p.endsWith("/"));
async function record(name: string, proof: unknown) { await mkdir(proofs,{recursive:true}); await writeFile(join(proofs,name+".json"),JSON.stringify(proof,null,2)+"\n"); }

it.each(["root-symlink","cache-symlink","public-root","foreign-owner-root"])("precreated %s is disabled in Node itself, not repaired or used", async kind => {
  const root = await mkdtemp(join(tmpdir(),"ncc-unsafe-"));
  const realUid = process.getuid!();
  const expectedUid = kind === "foreign-owner-root" ? realUid+1 : realUid;
  const namespace = join(root,`paperclip-pi-cache-${expectedUid}`), target=join(root,"outside");
  try {
    await mkdir(target,{mode:0o700}); await mkdir(join(root,"pi"),{mode:0o700});
    if (kind === "root-symlink") await symlink(target,namespace);
    else { await mkdir(namespace,{mode:kind === "public-root" ? 0o755 : 0o700}); if (kind === "cache-symlink") await symlink(target,join(namespace,"node-compile-cache")); }
    vi.stubEnv("TMPDIR",root);
    // Actual lstat owner differs from the simulated victim's uid. No lstat mock.
    const uidSpy = kind === "foreign-owner-root" ? vi.spyOn(process,"getuid").mockReturnValue(expectedUid) : null;
    let env: NodeJS.ProcessEnv;
    try { env = await piCompileCacheEnvironment(join(root,"pi")); } finally { uidSpy?.mockRestore(); }
    const native = spawnSync(process.execPath,["--input-type=module","-e",'import {enableCompileCache,getCompileCacheDir} from "node:module"; console.log(JSON.stringify({result:enableCompileCache(),dir:getCompileCacheDir()}))'],{env:{PATH:process.env.PATH,...env},encoding:"utf8"});
    expect(native.status).toBe(0); const observed=JSON.parse(native.stdout);
    const mode=(await lstat(namespace)).mode&0o777;
    await record(`unsafe-${kind}`,{kind,expectedUid,actualRootUid:(await lstat(namespace)).uid,ownerSimulation:kind === "foreign-owner-root",env,observed,mode,outsideEntries:await readdir(target)});
    expect(env.NODE_DISABLE_COMPILE_CACHE).toBe("1"); expect(observed.result.status).toBe(3); expect(observed.dir).toBeUndefined();
    expect(await readdir(target)).toEqual([]); if (kind === "public-root") expect(mode).toBe(0o755);
  } finally {vi.restoreAllMocks();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

async function startup(root: string, index: string, extraSource?: { literal: string; history: string; environment: string }) {
  const home=join(root,`h-${index}`), runtime=join(root,`p-${index}`), probe=join(root,`probe-${index}.json`);
  await mkdir(join(home,"extensions"),{recursive:true,mode:0o700}); await mkdir(runtime,{mode:0o700});
  await writeFile(join(home,"models.json"),JSON.stringify({providers:{judge:{baseUrl:"http://127.0.0.1:1/v1",api:"openai-completions",apiKey:"unused-local-placeholder",models:[{id:"faux"}]}}}));
  await writeFile(join(home,"settings.json"),JSON.stringify({packages:[],cacheWarming:"off",defaultProjectTrust:"never",compaction:{enabled:false},retry:{enabled:false}}));
  const literal=extraSource?.literal??"NO_PRIVATE_SOURCE";
  // Pi auto-discovers .ts/.js, not .mjs. A normal .ts extension requires its private JS dependency.
  const privateModule=join(home,"private-source.cjs");
  await writeFile(privateModule,`module.exports={sourceLiteral:${JSON.stringify(literal)}};\n`);
  await writeFile(join(home,"extensions","cache-probe.ts"),`import {enableCompileCache,getCompileCacheDir,flushCompileCache,createRequire} from 'node:module'; import {writeFileSync} from 'node:fs'; const {sourceLiteral}=createRequire(${JSON.stringify(privateModule)})(${JSON.stringify(privateModule)}); export default function(pi){pi.on('session_start',()=>{flushCompileCache();writeFileSync(${JSON.stringify(probe)},JSON.stringify({cache:process.env.NODE_COMPILE_CACHE,directory:getCompileCacheDir(),status:enableCompileCache().status,sourceLiteral}));});}\n`);
  if(extraSource) await writeFile(join(runtime,`${index}.jsonl`),[
    {type:"session",version:3,id:index,timestamp:"2026-11-14T00:00:00.000Z",cwd:root},
    {type:"message",id:"u1",parentId:null,timestamp:"2026-11-14T00:00:01.000Z",message:{role:"user",content:[{type:"text",text:extraSource.history}],timestamp:1}},
  ].map(x=>JSON.stringify(x)).join("\n")+"\n");
  let session; const started=performance.now();
  try {
    session=await new PiRpcDriver({command:binary,model:"judge/faux",piRpcThinkingLevel:"off",runtimeDirectory:runtime,shutdownTimeoutMs:1000,
      environment:{PI_CODING_AGENT_DIR:home,HOME:home,PI_OFFLINE:"1",PI_SKIP_VERSION_CHECK:"1",OTEL_SDK_DISABLED:"true",JUDGE_PRIVATE_RUNTIME_VALUE:extraSource?.environment},
    }).openSession({runId:index,normalizedSessionId:index,workingDirectory:root});
    const elapsedMs=performance.now()-started;
    const observed=JSON.parse(await readFile(probe,"utf8"));
    return {elapsedMs,observed};
  } finally {await session?.close();}
}

it("shared uid cache retains private compiled-module literals (but not plain session/environment data)",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ncc-sharing-"));
  try {
    const hostTmp=join(root,"t");await mkdir(hostTmp);vi.stubEnv("TMPDIR",hostTmp);
    vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"not-operator-home"));
    const secrets={literal:`JUDGE_SOURCE_PRIVATE_${randomUUID()}`,history:`JUDGE_HISTORY_PRIVATE_${randomUUID()}`,environment:`JUDGE_ENV_PRIVATE_${randomUUID()}`};
    const a=await startup(root,"tenant-a",secrets),b=await startup(root,"tenant-b");
    expect(a.observed.cache).toBe(b.observed.cache);
    const hits:{path:string;source:boolean;history:boolean;environment:boolean}[]=[];
    let fileCount=0;
    for(const p of await files(b.observed.cache)) {const full=join(b.observed.cache,p);if(!(await lstat(full)).isFile())continue;fileCount++;const bytes=await readFile(full);const hit={path:p,source:bytes.includes(Buffer.from(secrets.literal)),history:bytes.includes(Buffer.from(secrets.history)),environment:bytes.includes(Buffer.from(secrets.environment))};if(hit.source||hit.history||hit.environment)hits.push(hit);}
    await record("shared-uid",{cacheA:a.observed.cache,cacheB:b.observed.cache,sameCache:a.observed.cache===b.observed.cache,uid:process.getuid!(),fileCount,hits,sourceLiteralReadable:hits.some(x=>x.source),historyLiteralReadable:hits.some(x=>x.history),environmentLiteralReadable:hits.some(x=>x.environment),note:"Synthetic sentinels only. Same-uid shared-filesystem probe, not cross-UID isolation test."});
    expect(fileCount).toBeGreaterThan(0);expect(hits.some(x=>x.source)).toBe(true);expect(hits.some(x=>x.history||x.environment)).toBe(false);
  }finally{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
},60_000);

it("measures first-start cost when a legacy snapshot cache is present versus the new namespace warm",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ncc-timing-"));
  try {
    const hostTmp=join(root,"t");await mkdir(hostTmp);vi.stubEnv("TMPDIR",hostTmp);vi.stubEnv("PI_CODING_AGENT_DIR",join(root,"not-operator-home"));
    const legacyCache=join(hostTmp,"node-compile-cache"), newCache=join(hostTmp,`paperclip-pi-cache-${process.getuid!()}`,"node-compile-cache");
    await mkdir(legacyCache,{mode:0o700});
    const seed=spawnSync(binary,["--version"],{env:{PATH:process.env.PATH,HOME:root,TMPDIR:hostTmp,PI_OFFLINE:"1",PI_SKIP_VERSION_CHECK:"1",NODE_COMPILE_CACHE:legacyCache},encoding:"utf8",timeout:15_000});
    expect(seed.status).toBe(0);expect(seed.stdout.trim()).toBe("1.5.2");
    const legacyEntries=(await files(legacyCache)).length;
    const samples:unknown[]=[];const cold:number[]=[],warm:number[]=[];
    for(let i=0;i<5;i++){
      await rm(newCache,{recursive:true,force:true});
      const before=(await files(newCache)).length;
      const first=await startup(root,`cold-${i}`),afterCold=(await files(newCache)).length;
      const next=await startup(root,`warm-${i}`);
      cold.push(first.elapsedMs);warm.push(next.elapsedMs);
      samples.push({index:i,before,afterCold,firstMs:first.elapsedMs,warmMs:next.elapsedMs,usedCache:first.observed.cache,usedOldSnapshotCache:first.observed.cache===legacyCache});
    }
    const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
    await record("startup-timing",{runtime:"Node "+process.version+"; Pi 1.5.2",host:"ryzen3",legacyCache,newCache,legacyEntries,legacyEntriesAfter:(await files(legacyCache)).length,samples,medianFirstMs:median(cold),medianWarmMs:median(warm),medianPenaltyMs:median(cold)-median(warm),limitations:"Same host/OS page cache, local installed Pi, controlled startup without inference. Emulates a preseeded old cache location; not the actual Boat snapshot or a production cold-VM measurement."});
    expect(legacyEntries).toBeGreaterThan(0);
    // This is a measurement, not an unstable latency gate.
    expect(samples).toHaveLength(5);
  }finally{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
},120_000);
