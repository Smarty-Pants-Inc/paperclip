// Keep: native Pi/proxy -> strict Rust request validation trust boundary (#20214).
// Real runnerd and Pi 1.5.2; loopback model and one explicitly injected proxy
// protocol fault. Not live-provider acceptance or a fake ProviderBackend test.
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, watch } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalNativeRuntimeContextDigest } from "../contracts/runtime-context.js";
import { paperclipSemanticAction } from "../catalog/semantic-action-catalog.js";
import { createRunnerdCodexTransport } from "./runnerd-codex-transport.js";
const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const digest = (p: string) => `sha256:${hash(p)}`;
const lines = (p: string): any[] => existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
function identity(pid: number): any { try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"), f = s.slice(s.lastIndexOf(")") + 2).split(" "); return { pid, ppid: Number(f[1]), pgid: Number(f[2]), birth: f[19], state: f[0] }; } catch (e: any) { if (["ENOENT", "ESRCH"].includes(e.code)) return null; throw e; } }
const processes = (): any[] => readdirSync("/proc").filter(p => /^\d+$/.test(p)).map(p => identity(Number(p))).filter(Boolean);
function descendants(pid: number): any[] { const all = processes(), out: any[] = []; const walk = (p: number) => { for (const c of all.filter(x => x.ppid === p)) { out.push(c); walk(c.pid); } }; walk(pid); return out; }
async function within<T>(promise: Promise<T>, ms = 20000): Promise<T> { let t: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<never>((_, fail) => { t = setTimeout(() => fail(new Error("native runtime-request deadline")), ms); })]); } finally { clearTimeout(t); } }
const enabled = process.env.PI_TEST_BINARY && process.env.PAPERCLIP_RUNNERD_PATH && process.env.PI_N1_FROZEN_BUNDLE && process.env.PI_N1_EVIDENCE;
it.skipIf(!enabled)("invalid Pi runtimeRequest is RPC-local; real runnerd and fresh normal callback survive", async () => {
  const evidence = process.env.PI_N1_EVIDENCE!; await mkdir(evidence, { recursive: true });
  const root = await mkdtemp(join(evidence, "native-")); await writeFile(join(evidence, "root"), root + "\n");
  const proof: any = { root, sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runnerSha: digest(process.env.PAPERCLIP_RUNNERD_PATH!), testSha: digest(join(process.cwd(), "src/live/runnerd-pi-runtime-request.integration.test.ts")), started: new Date().toISOString(), status: "running", fault: "injected at actual frozen production proxy stdout; real Pi SDK, loopback Messages only" };
  const requests: any[] = [], calls: any[] = [], runtimeCalls: any[] = [], notifications: any[] = [], owned: any[] = [], launches: any[] = [];
  // The loopback model emits the normal callback only AFTER the independent
  // strict OpenCode control has been answered. Filesystem events, not a delay,
  // order the native proof; the test's existing deadline bounds a lost event.
  let ready!: () => void;
  const controlAnswered = new Promise<void>(resolve => { ready = resolve; });
  const watcher = watch(root, () => { if (existsSync(join(root, "strict-control-answered"))) ready(); });
  const original = childProcess.spawn;
  const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: any[]) => {
    const child = (original as any)(...args), birth = identity(child.pid); launches.push({ command: args[0], args: args[1], birth });
    const prefix = join(root, `launch-${child.pid}-${birth?.birth}`);
    for (const stream of ["stdout", "stderr"] as const) child[stream]?.on("data", (chunk: Buffer) => appendFileSync(`${prefix}.${stream}`, chunk));
    child.on("exit", (code: number, signal: string) => { const fact = { pid: child.pid, birth: birth?.birth, code, signal }; appendFileSync(`${prefix}.exit.jsonl`, JSON.stringify(fact) + "\n"); proof.runnerExit = fact; }); return child;
  }) as typeof childProcess.spawn); syncBuiltinESMExports();
  let transport: ReturnType<typeof createRunnerdCodexTransport>["transport"] | undefined, primary: unknown;
  const model = createServer((req, res) => { let raw = ""; req.setEncoding("utf8"); req.on("data", c => { raw += c; }); req.on("end", async () => {
    await controlAnswered;
    const item: any = { raw, url: req.url, at: new Date().toISOString(), sse: "" }; requests.push(item);
    try {
      const body = JSON.parse(raw); res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, fields: any) => { const s = `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`; item.sse += s; res.write(s); };
      event("message_start", { message: { id: `fixture-${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
      const last = body.messages.at(-1), results = Array.isArray(last.content) ? last.content.filter((v: any) => v.type === "tool_result") : [];
      if (results.length) {
        item.results = results;
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }); event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Normal fresh call returned." } }); event("content_block_stop", { index: 0 });
      } else {
        event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "n1-fresh-normal-tool", name: "list_projects", input: {} } }); event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }); event("content_block_stop", { index: 0 });
      }
      event("message_delta", { delta: { stop_reason: results.length ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } }); event("message_stop", {}); res.end();
    } catch (e) { item.error = String(e); res.destroy(e as Error); } finally { appendFileSync(join(root, "model-http.jsonl"), JSON.stringify(item) + "\n"); }
  }); });
  await new Promise<void>(done => model.listen(0, "127.0.0.1", done)); const address = model.address(); if (!address || typeof address === "string") throw new Error("loopback unavailable");
  try {
    const frozen = process.env.PI_N1_FROZEN_BUNDLE!, proxy = join(root, "cli/pi-rpc-app-server-proxy.cjs"), extension = join(root, "drivers/pi/extension/index.js"), tap = join(root, "fault-tap.cjs");
    await mkdir(dirname(proxy), { recursive: true }); await mkdir(dirname(extension), { recursive: true }); await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await cp(join(frozen, "drivers/pi/extension/index.js"), extension);
    // Adopt PiRpcSession.#captureUi's actual non-OpenCode envelope, including
    // user_input/method/details and the Pi origin. Never translate it.
    await writeFile(tap, `
const fs=require('node:fs'), cp=require('node:child_process');
const root=${JSON.stringify(root)};
let injected=false, turnId, input=''; const write=process.stdout.write;
function send(frame) { const raw=JSON.stringify(frame)+'\\n'; fs.appendFileSync(root+'/proxy.stdout',raw); write.call(process.stdout,raw); }
process.stdin.on('data',chunk=>{
  fs.appendFileSync(root+'/proxy.stdin',chunk); input+=String(chunk);
  for(let i;(i=input.indexOf('\\n'))>=0;) {
    const line=input.slice(0,i); input=input.slice(i+1); let frame; try { frame=JSON.parse(line); } catch { continue; }
    if(frame.id==='n1-invalid-pi-runtime-request' && frame.error?.code===-32602) {
      // Independent canonical control, NOT a conversion of the invalid Pi request.
      const control={id:'n1-valid-opencode-control',method:'paperclip/runtimeRequest',params:{request:{
        schema:'paperclip.runtime_request.v2',requestKind:'runtime',requestId:'strict-control',type:'input',status:'pending',
        prompt:'Strict control.',turnId,itemId:'strict-control',
        origin:{adapter:'opencode-server',provider:'opencode',method:'question.asked'},
        input:{schema:'paperclip.question_set.v1',questions:[{id:'target',prompt:'Strict control.',required:true,answerMode:'single_select',options:[{id:'yes',label:'Yes'}]}]}
      }}};
      fs.writeFileSync(root+'/strict-control.json',JSON.stringify(control)); send(control);
    }
    if(frame.id==='n1-valid-opencode-control' && frame.result) fs.writeFileSync(root+'/strict-control-answered',JSON.stringify(frame));
  }
});
process.stdout.write=function(chunk,...rest){
  fs.appendFileSync(root+'/proxy.stdout',chunk); const result=write.call(this,chunk,...rest);
  for(const line of String(chunk).split('\\n').filter(Boolean)) {
    let f; try{f=JSON.parse(line)}catch{continue}
    if(!injected && f.method==='turn/started') {
      injected=true; turnId=f.params.turnId;
      const bad={id:'n1-invalid-pi-runtime-request',method:'paperclip/runtimeRequest',params:{request:{
        requestId:'pi-question-1',requestKind:'user_input',method:'extension_ui_request.input',turnId,itemId:'pi-ui-pi-question-1',
        status:'pending',prompt:'Pi requests input',details:{type:'extension_ui_request',id:'pi-question-1',method:'input',title:'Pi requests input'},
        origin:{adapter:'pi_rpc',provider:'pi',method:'extension_ui_request.input',runId:'run-n1',turnId}
      }}};
      fs.writeFileSync(root+'/injected.json',JSON.stringify(bad)); send(bad);
    }
  }
  return result;
};
const spawn=cp.spawn; cp.spawn=function(...args){
  const p=spawn.apply(this,args), prefix=root+'/pi-'+p.pid;
  fs.writeFileSync(prefix+'.birth',fs.readFileSync('/proc/'+p.pid+'/stat'));
  for(const stream of ['stdout','stderr']) p[stream]?.on('data',c=>fs.appendFileSync(prefix+'.'+stream,c));
  if(p.stdin){const w=p.stdin.write;p.stdin.write=function(c,...r){fs.appendFileSync(prefix+'.stdin',c);return w.call(this,c,...r)}}
  p.on('exit',(code,signal)=>fs.writeFileSync(prefix+'.exit',JSON.stringify({code,signal}))); return p;
};
require('node:module').syncBuiltinESMExports();
`);
    await writeFile(proxy, `require(${JSON.stringify(tap)});\n` + readFileSync(join(frozen, "cli/pi-rpc-app-server-proxy.cjs"), "utf8").replace(/^#![^\n]*\n/u, ""));
    proof.frozenProxySha = digest(join(frozen, "cli/pi-rpc-app-server-proxy.cjs")); proof.faultProxySha = digest(proxy); proof.extensionSha = digest(extension);
    const executable = realpathSync(process.env.PI_TEST_BINARY!); proof.piSha = digest(executable); proof.piVersion = execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8" }).trim(); expect(proof.piVersion).toBe("1.5.2");
    const workspace = join(root, "workspace"), agent = join(root, "agent"), registered = join(root, "registered"), bundle = join(root, "bundle"); await Promise.all([workspace, agent, registered, bundle].map(p => mkdir(p)));
    const instruction = "# Native N1 private regression\nUse loopback fixture only.\n", sha = createHash("sha256").update(instruction).digest("hex"); await Promise.all([registered, bundle].map(p => writeFile(join(p, "AGENTS.md"), instruction)));
    const value: any = { prompt: { revision: "n1", text: instruction, digest: sha }, instructions: { entryPath: "AGENTS.md", bundle: { schema: "paperclip.runtime-asset.v1", digest: sha, manifestDigest: sha, rootPath: bundle, fileCount: 1, totalBytes: Buffer.byteLength(instruction) }, workingCopy: { kind: "agent_files", rootPath: registered, entryPath: "AGENTS.md" } }, skills: [], mcp: { assignmentSetId: "none", digest: sha, bindingId: null } };
    const definition = paperclipSemanticAction("list_projects")!;
    ({ transport } = createRunnerdCodexTransport({ provider: "pi_rpc", runnerBinary: process.env.PAPERCLIP_RUNNERD_PATH, stateDirectory: join(root, "runner-state"), sourceCodexHome: "", providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath), piCommand: executable, piCommandSha256: digest(executable), piProxyPath: proxy, piProxySha256: digest(proxy), piRuntimeDirectory: join(root, "pi-runtime"), piRpcThinkingLevel: "off", baseInstructions: instruction, runtimeContext: { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) }, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 }, prpIdentity: { runnerInstanceId: "runner-n1", environmentLeaseId: "lease-n1", runId: "run-n1", normalizedSessionId: "session-n1", turnId: "turn-n1", itemId: "item-n1" }, environment: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, AGENT_HOME: registered, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" }, onDiagnostic: s => appendFileSync(join(root, "diagnostics.txt"), s + "\n") }));
    transport.setServerRequestHandler(async request => {
      appendFileSync(join(root, "controller-calls.jsonl"), JSON.stringify(request) + "\n");
      if (request.method === "item/tool/requestUserInput") {
        runtimeCalls.push(request); proof.atStrictControl = identity(transport!.processInfo!().pid!);
        await transport!.resolveRuntimeRequest!({ requestId: String(request.id), turnId: String(request.params.turnId), resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { target: { selectedOptionIds: ["yes"] } } } } });
        return {};
      }
      calls.push(request); expect(request.method).toBe("item/tool/call"); expect(request.params.tool).toBe("list_projects"); proof.atFreshCall = identity(transport!.processInfo!().pid!); return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ projects: [], marker: "n1-normal-return" }) }] }; });
    proof.opened = await within(transport.request("thread/start", { cwd: workspace, model: "paperclip/claude-opus-5-5", dynamicTools: [{ name: "list_projects", description: definition.description, inputSchema: definition.inputSchema }] }), 60000);
    const pid = transport.processInfo!().pid!; proof.runnerBirth = identity(pid); owned.push(proof.runnerBirth, ...descendants(pid));
    const iterator = transport.notifications()[Symbol.asyncIterator]();
    proof.turnStart = await within(transport.request("turn/start", { input: [{ type: "text", text: "Run the normal list_projects callback then finish." }] }));
    for (;;) { const n = await within(iterator.next()); if (n.done) throw new Error("native stream ended before completion"); notifications.push(n.value); appendFileSync(join(root, "notifications.jsonl"), JSON.stringify(n.value) + "\n"); if (n.value.method === "turn/failed") throw new Error(JSON.stringify(n.value)); if (n.value.method === "turn/completed") break; }
    proof.replies = lines(join(root, "proxy.stdin")).filter(f => f.id === "n1-invalid-pi-runtime-request"); expect(proof.replies).toHaveLength(1); expect(proof.replies[0].error.code).toBe(-32602); expect(proof.replies[0].error.message).toContain("contains an unknown field");
    proof.strictControlReplies = lines(join(root, "proxy.stdin")).filter(f => f.id === "n1-valid-opencode-control");
    expect(runtimeCalls).toHaveLength(1); expect(proof.strictControlReplies).toHaveLength(1);
    expect(proof.atStrictControl.pid).toBe(pid); expect(proof.atStrictControl.birth).toBe(proof.runnerBirth.birth);
    expect(proof.strictControlReplies[0].result.resolution).toEqual({ action: "submit", response: { schema: "paperclip.question_response.v1", answers: { target: { selectedOptionIds: ["yes"] } } } });
    expect(calls).toHaveLength(1); expect(proof.atFreshCall.birth).toBe(proof.runnerBirth.birth); expect(proof.atFreshCall.pid).toBe(pid); expect(JSON.stringify(requests)).toContain("n1-normal-return");
    proof.runnerAfterCompletion = identity(pid); expect(proof.runnerAfterCompletion?.birth).toBe(proof.runnerBirth.birth); expect(proof.runnerAfterCompletion?.state).not.toBe("Z");
    await vi.waitFor(() => { proof.state = JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8")); expect(proof.state.pendingEvents).toEqual([]); expect(proof.state.queuedEvents).toEqual([]); expect(proof.state.toolBridge.pending).toEqual({}); expect(proof.state.activeProviderTurnId).toBeNull(); }, { timeout: 5000, interval: 50 });
    proof.status = "passed";
  } catch (e) { primary = e; proof.status = "failed"; proof.error = String(e); proof.stack = e instanceof Error ? e.stack : undefined; }
  finally {
    const pid = transport?.processInfo?.().pid; if (pid) for (const p of [identity(pid), ...descendants(pid)].filter(Boolean)) if (!owned.some(x => x.pid === p.pid && x.birth === p.birth)) owned.push(p);
    proof.ownedBeforeStop = owned; proof.launches = launches; if (existsSync(join(root, "runner-state"))) await cp(join(root, "runner-state"), join(root, "archived-before-stop"), { recursive: true }); await writeFile(join(root, "pre-stop-proof.json"), JSON.stringify(proof, null, 2));
    try { await within(transport?.close("n1-runtime-request-stop") ?? Promise.resolve(), 15000); } catch (e) { proof.stopError = String(e); if (proof.status === "passed") primary ??= e; }
    try { const groups = new Set(owned.map(p => p.pgid)); expect(groups.has(identity(process.pid)?.pgid)).toBe(false); await vi.waitFor(() => { expect(processes().filter(p => groups.has(p.pgid))).toEqual([]); for (const p of owned) expect(identity(p.pid)?.birth === p.birth).toBe(false); }, { timeout: 5000, interval: 50 }); proof.physicalRetirementVerified = true; } catch (e) { primary ??= e; proof.retirementError = String(e); }
    if (existsSync(join(root, "runner-state/runner/codex-provider-state.json"))) proof.canonicalAfterStop = JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8"));
    if (proof.status === "passed") {
      try {
        proof.runnerAfterStop = JSON.parse(readFileSync(join(root, "runner-state/runner/runner-state.json"), "utf8"));
        proof.controlAfterStop = JSON.parse(readFileSync(join(root, "runner-state/control-plane/control-plane-state.json"), "utf8"));
        expect(proof.runnerAfterStop.lifecycle).toBe("suspended"); expect(proof.runnerAfterStop.pendingTerminalDelivery ?? null).toBeNull();
        expect(proof.controlAfterStop.commands.every((c: any) => c.status === "completed")).toBe(true);
        expect(proof.canonicalAfterStop.pendingEvents).toEqual([]); expect(proof.canonicalAfterStop.queuedEvents).toEqual([]);
        expect(proof.canonicalAfterStop.toolBridge.pending).toEqual({}); expect(proof.canonicalAfterStop.activeProviderTurnId).toBeNull();
        proof.durableSettlementVerified = true;
      } catch (e) { primary ??= e; proof.settlementError = String(e); }
    }
    watcher.close(); ready(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done())); spy.mockRestore(); syncBuiltinESMExports(); proof.ended = new Date().toISOString(); if (primary) proof.status = "failed"; await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2)); await writeFile(join(evidence, "proof.json"), JSON.stringify(proof, null, 2));
  }
  if (primary) throw primary;
}, 110000);
