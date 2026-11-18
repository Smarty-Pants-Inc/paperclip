// Dependency checks are opt-in: PI_NATIVE_RUNTIME_ROOT must be Pi 1.5.2 and
// PI_NATIVE_SUBAGENTS_ROOT pi-subagents 0.88.0. No provider/org calls or credentials.
// Keep reason: the real CLI startup and loader-owned provenance are admission trust boundaries.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeRoot = process.env.PI_NATIVE_RUNTIME_ROOT, subagentsRoot = process.env.PI_NATIVE_SUBAGENTS_ROOT;
const proofRoot = process.env.PI_NATIVE_TEST_OUT;
type Json = Record<string, any>;
async function nativeLoad(scenario: "good" | "disabled" | "factory-failure") {
  expect(JSON.parse(await readFile(join(runtimeRoot!, "package.json"), "utf8")).version).toBe("1.5.2");
  expect(JSON.parse(await readFile(join(subagentsRoot!, "package.json"), "utf8")).version).toBe("0.88.0");
  if (proofRoot) await mkdir(proofRoot, { recursive: true });
  const root = await mkdtemp(join(proofRoot ?? tmpdir(), `pi-load-${scenario}-`));
  const agentDir = join(root, "agent"), cwd = join(root, "workspace"), guard = join(root, "hook-only-guard-fixture");
  for (const path of [agentDir, cwd, guard]) await mkdir(path);
  await writeFile(join(guard, "package.json"), JSON.stringify({ name: "@smarty-pants-inc/tool-context-guard", version: "1.0.0", pi: { extensions: ["./index.js"] } }));
  // This is explicitly a hook-only fixture, NOT evidence of the production guard's behavior.
  await writeFile(join(guard, "index.js"), scenario === "factory-failure" ? "export default function(){ throw Error('F014_FATAL_FACTORY'); }\n" : "export default function(pi){ pi.on('tool_result', () => {}); }\n");
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [scenario === "disabled" ? { source: guard, extensions: [] } : guard, subagentsRoot], cacheWarming: "off", defaultProjectTrust: "never", compaction: { enabled: false }, retry: { enabled: false } }));
  await writeFile(join(agentDir, "models.json"), "{}");
  const audit = join(root, "audit.ts"), resultPath = join(root, "admission.json");
  const manifestModule = fileURLToPath(new URL("./manifest.ts", import.meta.url));
  const registrationModule = fileURLToPath(new URL("./register.ts", import.meta.url));
  await writeFile(audit, `import { VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson, computeNativeHomeManifest, sha256 } from ${JSON.stringify(manifestModule)};
import { registerNativeHome } from ${JSON.stringify(registrationModule)};
export default function(pi) {
  let admit;
  let manifestDigest;
  registerNativeHome(pi, fn => { admit = fn; return () => { admit = undefined; }; }).configure({
    piVersion: VERSION,
    collect: async ({signal}) => {
      const settings = pi.getSettings();
      const required = [{role:"tool-context-guard",root:${JSON.stringify(guard)},version:"1.0.0"},{role:"pi-subagents",root:${JSON.stringify(subagentsRoot)},version:"0.88.0"}];
      const environment = {PI_OFFLINE:process.env.PI_OFFLINE,PI_SKIP_VERSION_CHECK:process.env.PI_SKIP_VERSION_CHECK};
      const manifest = await computeNativeHomeManifest({agentDir:getAgentDir(),packages:required.map(pkg=>({source:pkg.root,root:pkg.root})),resources:[],allowedExternalRoots:[${JSON.stringify(root)},${JSON.stringify(dirname(subagentsRoot!))}],environment,runtime:{distributionDigest:sha256(await readFile(${JSON.stringify(join(runtimeRoot!, "dist", "cli.js"))})),cwd:${JSON.stringify(cwd)},argv:[],projectTrust:"denied",approvedProjectRoots:[]},effectiveMetadata:{packages:settings.packages},effectivePackages:settings.packages??[],effectiveExtensions:settings.extensions??[],signal});
      manifestDigest = manifest.digest;
      return {manifest,required,environment};
    }
  });
  pi.registerCommand("f014-admit", {handler:async (_args,ctx)=>{
    pi.setActiveTools(["read"]);
    let result;
    try {result={ok:true,...await admit({sessionId:ctx.sessionManager.getSessionId(),epoch:1,runId:"native-f014-proof",signal:new AbortController().signal})};}
    catch(error){result={ok:false,code:error.code,message:error.message};}
    result={...result,manifestDigest,piVersion:VERSION,sessionId:ctx.sessionManager.getSessionId(),subagent:pi.getAllTools().find(tool=>tool.name==="subagent"),active:pi.getActiveTools()};
    await writeFile(${JSON.stringify(resultPath)},JSON.stringify(result,null,2));
    ctx.ui.notify("F014 admission checked", "info");
  }});
}
`);
  const argv = [join(runtimeRoot!, "dist", "cli.js"), "--mode", "rpc", "--extension", audit, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline"];
  const child = spawn(process.execPath, argv, { cwd, env: { HOME: root, TMPDIR: root, PATH: process.env.PATH ?? "/usr/bin:/bin", PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", SMARTY_ALPHA: "0", LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "close"); let stderr = "", stdout = "", buffer = "", sequence = 0;
  const wire: Json[] = [], pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>();
  child.stderr.on("data", chunk => { stderr += chunk; }); child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    stdout += chunk; buffer += chunk; let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line.trim()) continue;
      let record: Json;
      try { record = JSON.parse(line); } catch { continue; }
      wire.push(record);
      const request = pending.get(record.id);
      if (record.type === "response" && request) { pending.delete(record.id); record.success ? request.resolve(record.data) : request.reject(new Error(record.error)); }
    }
  });
  async function request(command: Json) {
    const id = `f014-${++sequence}`; let timeout: ReturnType<typeof setTimeout>;
    try { return await new Promise<any>((resolve, reject) => { pending.set(id, { resolve, reject }); timeout = setTimeout(() => reject(new Error(`RPC deadline; ${stderr}`)), 20000); child.stdin.write(JSON.stringify({ ...command, id }) + "\n"); }); }
    finally { clearTimeout(timeout!); pending.delete(id); }
  }
  async function waitExit(ms: number) {
    let timeout: ReturnType<typeof setTimeout>;
    try { return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timeout!); }
  }
  try {
    if (scenario === "factory-failure") {
      child.stdin.write(JSON.stringify({ id: "must-not-start-rpc", type: "get_state" }) + "\n");
      expect(await waitExit(20000)).toBe(true); expect(child.exitCode).toBe(1);
      expect(stderr).toContain("F014_FATAL_FACTORY"); expect(wire.some(record => record.type === "response")).toBe(false);
    } else {
      const state = await request({ type: "get_state" }); expect(state.sessionId).toBeTruthy();
      await request({ type: "prompt", message: "/f014-admit" });
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      expect(result.piVersion).toBe("1.5.2"); expect(result.sessionId).toBe(state.sessionId);
      expect(result.active).not.toContain("subagent");
      if (scenario === "good") { expect(result.ok).toBe(true); expect(result.digest).toMatch(/^[a-f0-9]{64}$/); expect(result.digest).toBe(result.manifestDigest); expect(result.subagent.sourceInfo.baseDir).toBe(subagentsRoot); }
      else { expect(result.ok).toBe(false); expect(result.code).toBe("pi_home_required_disabled"); }
      expect(wire.filter(record => record.type === "extension_error")).toEqual([]);
      expect(wire.some(record => record.type === "agent_start")).toBe(false);
    }
  } finally {
    child.stdin.end();
    if (!await waitExit(5000)) { child.kill("SIGTERM"); if (!await waitExit(2000)) { child.kill("SIGKILL"); await exited; } }
    await writeFile(join(root, "wire.jsonl"), wire.map(record => JSON.stringify(record)).join("\n") + "\n");
    await writeFile(join(root, "stdout.log"), stdout); await writeFile(join(root, "stderr.log"), stderr);
    await writeFile(join(root, "provenance.json"), JSON.stringify({ scenario, argv, runtimeRoot, subagentsRoot, code: child.exitCode, signal: child.signalCode, evidenceLevel: "real_Pi_1.5.2_and_pi_subagents_0.88.0_with_hook_only_guard_fixture", noProviderOrOrgCalls: true, productionGuardBehaviorProven: false }, null, 2));
    if (!proofRoot) await rm(root, { recursive: true, force: true });
  }
  if (scenario !== "factory-failure") expect(child.exitCode).toBe(0);
}

describe("F014 actual pinned native loader (not daily-work/org acceptance)", () => {
  it.skipIf(!runtimeRoot || !subagentsRoot)("startup factory failure exits 1 before RPC", () => nativeLoad("factory-failure"), 40000);
  it.skipIf(!runtimeRoot || !subagentsRoot)("inactive real subagent tool admits the exact native-home digest", () => nativeLoad("good"), 40000);
  it.skipIf(!runtimeRoot || !subagentsRoot)("running Pi still refuses an effectively disabled hook-only guard", () => nativeLoad("disabled"), 40000);
});
