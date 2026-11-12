// Native admission regression: actual Pi SDK select -> production proxy -> exact
// Rust -> existing controller request.resolve -> native Promise -> normal tool.
// Loopback model/business data only; no paid provider or live HQ acceptance.
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalNativeRuntimeContextDigest } from "../contracts/runtime-context.js";
import { paperclipSemanticAction } from "../catalog/semantic-action-catalog.js";
import { createRunnerdCodexTransport } from "./runnerd-codex-transport.js";
const digest = (p: string) => `sha256:${createHash("sha256").update(readFileSync(p)).digest("hex")}`;
const lines = (p: string): any[] => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
function identity(pid: number): any { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"), f = s.slice(s.lastIndexOf(")") + 2).split(" "); return { pid, ppid: Number(f[1]), pgid: Number(f[2]), birth: f[19], state: f[0], cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") }; } catch (e: any) { if (["ENOENT", "ESRCH"].includes(e.code)) return null; throw e; } }
function processes(): any[] { return readdirSync("/proc").filter(s => /^\d+$/.test(s)).map(s => identity(Number(s))).filter(Boolean); }
function descendants(pid: number): any[] { const all = processes(), out: any[] = []; const walk = (p: number) => { for (const c of all.filter(x => x.ppid === p)) { out.push(c); walk(c.pid); } }; walk(pid); return out; }
async function within<T>(p: Promise<T>, ms = 15000): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([p, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error("native SDK dialog deadline")), ms); })]); } finally { clearTimeout(timer); } }
const enabled = Boolean(process.env.PI_TEST_BINARY && process.env.PAPERCLIP_RUNNERD_PATH && process.env.PI_SDK_FROZEN_BUNDLE && process.env.PI_SDK_EVIDENCE);
it.skipIf(!enabled)("malformed runtime RPC stays local; genuine SDK select resolves on the same PIDs then normal callback settles", async () => {
  const evidence = process.env.PI_SDK_EVIDENCE!, frozen = process.env.PI_SDK_FROZEN_BUNDLE!;
  await mkdir(evidence, { recursive: true }); const root = await mkdtemp(join(evidence, "raw-"));
  await writeFile(join(evidence, "root"), root + "\n");
  const proof: any = { root, scope: "native Pi SDK dialog, loopback model and fixture business data; not live HQ", status: "running", started: new Date().toISOString(), runnerSha: digest(process.env.PAPERCLIP_RUNNERD_PATH!) };
  let transport: ReturnType<typeof createRunnerdCodexTransport>["transport"] | undefined, primary: unknown;
  const owned: any[] = [], launches: any[] = [], requests: any[] = [], runtimeCalls: any[] = [], calls: any[] = [];
  const spawn = childProcess.spawn;
  const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: any[]) => {
    const child = (spawn as any)(...args); launches.push({ command: args[0], args: args[1], birth: identity(child.pid) });
    const prefix = join(root, `launch-${child.pid}`);
    for (const stream of ["stdout", "stderr"] as const) child[stream]?.on("data", (c: Buffer | string) => appendFileSync(`${prefix}.${stream}`, c));
    child.on("exit", (code: number, signal: string) => appendFileSync(`${prefix}.exit`, JSON.stringify({ code, signal }))); return child;
  }) as typeof childProcess.spawn); syncBuiltinESMExports();
  const model = createServer((req, res) => { let raw = ""; req.setEncoding("utf8"); req.on("data", c => { raw += c; }); req.on("end", () => {
    const item: any = { raw, at: new Date().toISOString() }; requests.push(item);
    try {
      const body = JSON.parse(raw); item.body = body; expect(req.url).toBe("/v1/messages?beta=true");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (type: string, fields: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      emit("message_start", { message: { id: `sdk-${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
      const last = body.messages.at(-1), results = Array.isArray(last.content) ? last.content.filter((v: any) => v.type === "tool_result") : [];
      if (!results.length) {
        expect(requests).toHaveLength(1); expect(body.tools.map((v: any) => v.name)).toContain("list_projects");
        emit("content_block_start", { index: 0, content_block: { type: "tool_use", id: "sdk-normal-tool", name: "list_projects", input: {} } });
        emit("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }); emit("content_block_stop", { index: 0 });
        emit("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } });
      } else {
        item.results = results; expect(JSON.stringify(results)).toContain("sdk-normal-return");
        expect(JSON.parse(readFileSync(join(root, "sdk-observed.json"), "utf8"))).toEqual({ selected: "Beta" });
        emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } }); emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Native SDK selection and normal callback consumed." } }); emit("content_block_stop", { index: 0 });
        emit("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
      }
      emit("message_stop", {}); res.end();
    } catch (e) { item.error = String(e); res.destroy(e as Error); }
    appendFileSync(join(root, "model.jsonl"), JSON.stringify(item) + "\n");
  }); });
  await new Promise<void>(done => model.listen(0, "127.0.0.1", done)); const address = model.address(); if (!address || typeof address === "string") throw Error("loopback bind failed");
  try {
    const proxy = join(root, "cli/pi-rpc-app-server-proxy.cjs"), extension = join(root, "drivers/pi/extension/index.js"), tap = join(root, "fault-tap.cjs");
    await mkdir(dirname(proxy), { recursive: true }); await mkdir(dirname(extension), { recursive: true }); await cp(join(frozen, "drivers/pi/extension/index.js"), extension); await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(tap, `const cp=require('node:child_process'),fs=require('node:fs');const root=${JSON.stringify(root)};let injected=false;
const upstream=process.stdout.write;process.stdout.write=function(chunk,...rest){fs.appendFileSync(root+'/proxy.stdout',chunk);const result=upstream.call(this,chunk,...rest);for(const line of String(chunk).trim().split('\\n')){try{const frame=JSON.parse(line);if(!injected&&frame.method==='turn/started'){injected=true;const bad={id:'sdk-invalid-runtime',method:'paperclip/runtimeRequest',params:{request:{schema:'paperclip.runtime_request.v2',requestId:'bad-native',requestKind:'runtime',type:'input',status:'pending',turnId:frame.params.turn.id,origin:{adapter:'pi-rpc',provider:'pi_rpc',method:'extension_ui_request'},unexpected:true}}};fs.appendFileSync(root+'/injected.jsonl',JSON.stringify(bad)+'\\n');upstream.call(this,JSON.stringify(bad)+'\\n')}}catch{}}return result};
process.stdin.on('data',chunk=>{fs.appendFileSync(root+'/proxy.stdin',chunk);for(const line of String(chunk).trim().split('\\n')){try{const f=JSON.parse(line);if(f.id==='sdk-invalid-runtime'){fs.writeFileSync(root+'/malformed-ack.tmp',JSON.stringify(f));fs.renameSync(root+'/malformed-ack.tmp',root+'/malformed-ack.json')}}catch{}}});
const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn.apply(this,args),p=root+'/pi-'+child.pid;fs.writeFileSync(p+'.birth',fs.readFileSync('/proc/'+child.pid+'/stat'));for(const s of ['stdout','stderr'])child[s]?.on('data',chunk=>fs.appendFileSync(p+'.'+s,chunk));if(child.stdin){const w=child.stdin.write;child.stdin.write=function(chunk,...rest){fs.appendFileSync(p+'.stdin',chunk);return w.call(this,chunk,...rest)}}child.on('exit',(code,signal)=>fs.writeFileSync(p+'.exit',JSON.stringify({code,signal})));return child};require('node:module').syncBuiltinESMExports();`);
    await writeFile(proxy, `require(${JSON.stringify(tap)});\n` + readFileSync(join(frozen, "cli/pi-rpc-app-server-proxy.cjs"), "utf8").replace(/^#![^\n]*\n/u, ""));
    proof.frozenProxySha = digest(join(frozen, "cli/pi-rpc-app-server-proxy.cjs")); proof.faultProxySha = digest(proxy); proof.extensionSha = digest(extension);
    const executable = realpathSync(process.env.PI_TEST_BINARY!); proof.piSha = digest(executable); proof.piVersion = execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8" }).trim(); expect(proof.piVersion).toBe("1.5.2");
    const workspace = join(root, "workspace"), agent = join(root, "agent"), registered = join(root, "registered"), bundle = join(root, "bundle"); await Promise.all([workspace, agent, registered, bundle].map(p => mkdir(p)));
    await mkdir(join(agent, "extensions"));
    // Official extension API, no stdout serialization, provider IDs or annotations.
    // Permission-gate the real tool; SDK itself generates and waits on select.
    await writeFile(join(agent, "extensions/sdk-dialog.ts"), `import {writeFileSync,readFileSync,existsSync,watch} from 'node:fs';export default function(pi){pi.on('tool_call',async(event,ctx)=>{if(event.toolName!=='list_projects')return;const ackPath=${JSON.stringify(join(root, "malformed-ack.json"))};if(!existsSync(ackPath))await new Promise((resolve,reject)=>{const w=watch(${JSON.stringify(root)},()=>{if(existsSync(ackPath)){clearTimeout(t);w.close();resolve()}});const t=setTimeout(()=>{w.close();reject(Error('missing local malformed RPC receipt'))},10000);if(existsSync(ackPath)){clearTimeout(t);w.close();resolve()}});const ack=JSON.parse(readFileSync(ackPath,'utf8'));if(ack.id!=='sdk-invalid-runtime'||ack.error?.code!==-32602)throw Error('malformed RPC was not locally rejected first');const selected=await ctx.ui.select('SDK native choice',['Alpha','Beta']);writeFileSync(${JSON.stringify(join(root, "sdk-observed.json"))},JSON.stringify({selected}));if(selected!=='Beta')throw Error('SDK selection did not resume exactly');});}`);
    const instruction = "# Native SDK regression\nUse local loopback fixtures only.\n", sha = createHash("sha256").update(instruction).digest("hex"); await Promise.all([registered, bundle].map(p => writeFile(join(p, "AGENTS.md"), instruction)));
    const value: any = { prompt: { revision: "sdk", text: instruction, digest: sha }, instructions: { entryPath: "AGENTS.md", bundle: { schema: "paperclip.runtime-asset.v1", digest: sha, manifestDigest: sha, rootPath: bundle, fileCount: 1, totalBytes: Buffer.byteLength(instruction) }, workingCopy: { kind: "agent_files", rootPath: registered, entryPath: "AGENTS.md" } }, skills: [], mcp: { assignmentSetId: "none", digest: sha, bindingId: null } };
    const definition = paperclipSemanticAction("list_projects")!;
    ({ transport } = createRunnerdCodexTransport({ provider: "pi_rpc", runnerBinary: process.env.PAPERCLIP_RUNNERD_PATH, stateDirectory: join(root, "runner-state"), sourceCodexHome: "", providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath), piCommand: executable, piCommandSha256: digest(executable), piProxyPath: proxy, piProxySha256: digest(proxy), piRuntimeDirectory: join(root, "pi-runtime"), piRpcThinkingLevel: "off", baseInstructions: instruction, runtimeContext: { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) }, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 }, prpIdentity: { runnerInstanceId: "runner-sdk", environmentLeaseId: "lease-sdk", runId: "run-sdk", normalizedSessionId: "session-sdk", turnId: "turn-sdk", itemId: "item-sdk" }, environment: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, AGENT_HOME: registered, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" }, onDiagnostic: s => appendFileSync(join(root, "diagnostics.txt"), s + "\n") }));
    transport.setServerRequestHandler(async request => {
      appendFileSync(join(root, "controller-calls.jsonl"), JSON.stringify(request) + "\n");
      if (request.method === "item/tool/requestUserInput") {
        runtimeCalls.push(request); proof.atSdkRequest = identity(transport!.processInfo!().pid!); proof.treeAtSdkRequest = descendants(proof.atSdkRequest.pid);
        const rawFrames = lines(join(root, "proxy.stdout")); proof.rawRuntime = rawFrames.filter(f => f.method === "paperclip/runtimeRequest");
        expect(proof.rawRuntime).toHaveLength(1); expect(proof.rawRuntime[0].params.request.origin).toEqual({ adapter: "pi-rpc", provider: "pi_rpc", method: "extension_ui_request" });
        expect(proof.rawRuntime[0].params.request.input.questions[0]).toMatchObject({ id: "value", answerMode: "single_select", options: [{ id: "option-1", label: "Alpha" }, { id: "option-2", label: "Beta" }] });
        proof.malformedReplyBeforeSdk = JSON.parse(readFileSync(join(root, "malformed-ack.json"), "utf8")); expect(proof.malformedReplyBeforeSdk.error.code).toBe(-32602);
        await transport!.resolveRuntimeRequest!({ requestId: String(request.id), turnId: String(request.params.turnId), resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { selectedOptionIds: ["option-2"] } } } } }); return {};
      }
      calls.push(request); expect(request.method).toBe("item/tool/call"); expect(request.params.tool).toBe("list_projects"); proof.atFreshCall = identity(transport!.processInfo!().pid!); proof.treeAtFreshCall = descendants(proof.atFreshCall.pid);
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ projects: [], marker: "sdk-normal-return" }) }] };
    });
    proof.opened = await within(transport.request("thread/start", { cwd: workspace, model: "paperclip/claude-opus-5-5", dynamicTools: [{ name: "list_projects", description: definition.description, inputSchema: definition.inputSchema }] }), 60000);
    const pid = transport.processInfo!().pid!; proof.runnerBirth = identity(pid); owned.push(proof.runnerBirth, ...descendants(pid)); proof.initialTree = descendants(pid);
    const iterator = transport.notifications()[Symbol.asyncIterator](); proof.turnStart = await within(transport.request("turn/start", { input: [{ type: "text", text: "Use list_projects, answer its native permission question, then finish." }] }));
    for (;;) { const n = await within(iterator.next()); if (n.done) throw Error("stream ended before completion"); appendFileSync(join(root, "notifications.jsonl"), JSON.stringify(n.value) + "\n"); if (n.value.method === "turn/failed") throw Error(JSON.stringify(n.value)); if (n.value.method === "turn/completed") { expect((n.value.params as any).turn.status).toBe("completed"); break; } }
    expect(runtimeCalls).toHaveLength(1); expect(calls).toHaveLength(1); expect(requests).toHaveLength(2); expect(JSON.stringify(requests)).toContain("sdk-normal-return");
    const replies = lines(join(root, "proxy.stdin")); proof.malformedReplies = replies.filter(f => f.id === "sdk-invalid-runtime"); expect(proof.malformedReplies).toHaveLength(1); expect(proof.malformedReplies[0].error.code).toBe(-32602);
    proof.sdkResolution = replies.filter(f => f.id === proof.rawRuntime[0].id); expect(proof.sdkResolution).toHaveLength(1); expect(proof.sdkResolution[0].result.resolution).toEqual({ action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { selectedOptionIds: ["option-2"] } } } });
    const sdkFiles = readdirSync(root).filter(p => /^pi-\d+\.stdout$/.test(p)); expect(sdkFiles).toHaveLength(1); const prefix = sdkFiles[0]!.replace(/\.stdout$/, "");
    proof.nativeRequests = lines(join(root, `${prefix}.stdout`)).filter(f => f.type === "extension_ui_request"); expect(proof.nativeRequests).toHaveLength(1); expect(proof.nativeRequests[0]).toEqual({ type: "extension_ui_request", id: expect.any(String), method: "select", title: "SDK native choice", options: ["Alpha", "Beta"] });
    proof.nativeResponses = lines(join(root, `${prefix}.stdin`)).filter(f => f.type === "extension_ui_response"); expect(proof.nativeResponses).toEqual([{ type: "extension_ui_response", id: proof.nativeRequests[0].id, value: "Beta" }]);
    proof.sdkObserved = JSON.parse(readFileSync(join(root, "sdk-observed.json"), "utf8")); expect(proof.sdkObserved).toEqual({ selected: "Beta" });
    for (const phase of [proof.atSdkRequest, proof.atFreshCall, identity(pid)]) { expect(phase?.pid).toBe(pid); expect(phase?.birth).toBe(proof.runnerBirth.birth); expect(phase?.state).not.toBe("Z"); }
    expect(proof.treeAtSdkRequest.map((p: any) => [p.pid, p.birth])).toEqual(proof.initialTree.map((p: any) => [p.pid, p.birth])); expect(proof.treeAtFreshCall.map((p: any) => [p.pid, p.birth])).toEqual(proof.initialTree.map((p: any) => [p.pid, p.birth]));
    await vi.waitFor(() => { proof.state = JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8")); expect(proof.state.pendingEvents).toEqual([]); expect(proof.state.queuedEvents).toEqual([]); expect(proof.state.toolBridge.pending).toEqual({}); expect(proof.state.activeProviderTurnId).toBeNull(); }, { timeout: 5000, interval: 50 }); proof.status = "passed";
  } catch (e) { primary = e; proof.status = "failed"; proof.error = String(e); proof.stack = e instanceof Error ? e.stack : undefined; }
  finally {
    const pid = transport?.processInfo?.().pid; if (pid) for (const p of [identity(pid), ...descendants(pid)].filter(Boolean)) if (!owned.some(x => x.pid === p.pid && x.birth === p.birth)) owned.push(p);
    proof.ownedBeforeStop = owned; proof.launches = launches; if (existsSync(join(root, "runner-state"))) await cp(join(root, "runner-state"), join(root, "archived-before-stop"), { recursive: true }); await writeFile(join(root, "pre-stop-proof.json"), JSON.stringify(proof, null, 2));
    try { await within(transport?.close("sdk-dialog-stop") ?? Promise.resolve(), 15000); } catch (e) { proof.stopError = String(e); primary ??= e; }
    try { const groups = new Set(owned.map(p => p.pgid)); expect(groups.has(identity(process.pid)?.pgid)).toBe(false); await vi.waitFor(() => { expect(processes().filter(p => groups.has(p.pgid))).toEqual([]); for (const p of owned) expect(identity(p.pid)?.birth === p.birth).toBe(false); }, { timeout: 5000, interval: 50 }); proof.physicalRetirementVerified = true; } catch (e) { primary ??= e; proof.retirementError = String(e); }
    if (proof.status === "passed") { try {
      proof.canonicalAfterStop = JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8")); proof.runnerAfterStop = JSON.parse(readFileSync(join(root, "runner-state/runner/runner-state.json"), "utf8")); proof.controlAfterStop = JSON.parse(readFileSync(join(root, "runner-state/control-plane/control-plane-state.json"), "utf8"));
      expect(proof.runnerAfterStop.lifecycle).toBe("suspended"); expect(proof.runnerAfterStop.pendingTerminalDelivery ?? null).toBeNull(); expect(proof.controlAfterStop.commands.every((c: any) => c.status === "completed")).toBe(true); expect(proof.canonicalAfterStop.pendingEvents).toEqual([]); expect(proof.canonicalAfterStop.queuedEvents).toEqual([]); expect(proof.canonicalAfterStop.toolBridge.pending).toEqual({}); expect(proof.canonicalAfterStop.activeProviderTurnId).toBeNull(); proof.durableSettlementVerified = true;
    } catch (e) { primary ??= e; proof.settlementError = String(e); } }
    model.closeAllConnections(); await new Promise<void>(done => model.close(() => done())); spy.mockRestore(); syncBuiltinESMExports(); proof.ended = new Date().toISOString(); if (primary) proof.status = "failed"; await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2)); await writeFile(join(evidence, "proof.json"), JSON.stringify(proof, null, 2));
  }
  if (primary) throw primary;
}, 110000);
