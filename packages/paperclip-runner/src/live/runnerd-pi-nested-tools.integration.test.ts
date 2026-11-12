// Native callback regression: actual Pi 1.5.2, exact-source Rust, canonical dynamic tools.
// Keep reason: real Pi SDK -> proxy -> Rust callback authority/identifier trust boundary.
// Only loopback model and backing business API data are fixtures; NOT live HQ acceptance.
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile, chmod, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalNativeRuntimeContextDigest } from "../contracts/runtime-context.js";
import { paperclipSemanticAction } from "../catalog/semantic-action-catalog.js";
import { PRP_COMPLETION_RESULT_BRIDGE_INPUT_SCHEMA, PRP_COMPLETION_TOOL_DESCRIPTION } from "../contracts/completion-result.js";
import { createRunnerdCodexTransport } from "./runnerd-codex-transport.js";
const rec = (v: any): Record<string, any> => v && typeof v === "object" ? v : {};
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const digest = (p: string) => `sha256:${sha(readFileSync(p))}`;
const pi = process.env.PI_TEST_BINARY;
const expectedBase = process.env.PI_NESTED_EXPECTED_BASE ?? "03e89f8e294b67a7abe57664b415b978b222af2e";
const jsonLines = (p: string): any[] => readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s));
function identity(pid: number): any {
  try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"), f = s.slice(s.lastIndexOf(")") + 2).split(" "); return { pid, ppid: Number(f[1]), pgid: Number(f[2]), birth: f[19], state: f[0], cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") }; }
  catch (e: any) { if (["ENOENT", "ESRCH"].includes(e.code)) return null; throw e; }
}
function processes(): any[] { return readdirSync("/proc").filter(s => /^\d+$/.test(s)).map(s => identity(Number(s))).filter(Boolean); }
function descendants(pid: number): any[] { const all = processes(), out: any[] = []; const walk = (p: number) => { for (const c of all.filter(x => x.ppid === p)) { out.push(c); walk(c.pid); } }; walk(pid); return out; }
async function within<T>(p: Promise<T>, ms = 15000): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([p, new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error("native repro deadline")), ms); })]); } finally { clearTimeout(timer); } }
async function readonlyTree(p: string): Promise<void> { for (const e of await readdir(p, { withFileTypes: true })) { const f = join(p, e.name); if (e.isDirectory()) await readonlyTree(f); else await chmod(f, (await stat(f)).mode & 0o555); } await chmod(p, 0o555); }
async function runtime(root: string) {
  const executable = realpathSync(pi!); let closure = dirname(executable);
  while (!(basename(closure) === "node_modules" && existsSync(join(closure, "@earendil-works/pi-coding-agent")))) { if (dirname(closure) === closure) throw new Error("installed closure missing"); closure = dirname(closure); }
  expect(JSON.parse(readFileSync(join(closure, "@earendil-works/pi-coding-agent/package.json"), "utf8")).version).toBe("1.5.2");
  const pack = join(root, "pi-package"); await mkdir(pack); await cp(closure, join(pack, "node_modules"), { recursive: true, dereference: true }); await readonlyTree(pack);
  const command = join(pack, "node_modules", relative(closure, executable));
  expect(execFileSync(process.execPath, [command, "--version"], { encoding: "utf8" }).trim()).toBe("1.5.2");
  const proxy = join(root, "cli/pi-rpc-app-server-proxy.cjs"), extension = join(root, "drivers/pi/extension/index.js");
  const tap = join(root, "passive-proxy-tap.cjs");
  await writeFile(tap, `const cp=require('node:child_process'),fs=require('node:fs'),net=require('node:net');
const out=${JSON.stringify(root)}; const stamp=()=>new Date().toISOString();
const stdoutWrite=process.stdout.write;process.stdout.write=function(chunk,...rest){fs.appendFileSync(out+'/proxy-upstream.stdout',typeof chunk==='string'?Buffer.from(chunk,typeof rest[0]==='string'?rest[0]:undefined):chunk);return stdoutWrite.call(this,chunk,...rest)};
const spawn=cp.spawn;cp.spawn=function(...args){const child=spawn.apply(this,args);let birth=null;try{birth=fs.readFileSync('/proc/'+child.pid+'/stat','utf8')}catch{};const p=out+'/proxy-child-'+child.pid;fs.appendFileSync(p+'.lifecycle.jsonl',JSON.stringify({at:stamp(),pid:child.pid,birth,command:args[0],args:args[1]})+'\\n');for(const stream of ['stdout','stderr'])child[stream]?.on('data',chunk=>fs.appendFileSync(p+'.'+stream,chunk));if(child.stdin){const write=child.stdin.write;child.stdin.write=function(chunk,...rest){fs.appendFileSync(p+'.stdin',typeof chunk==='string'?Buffer.from(chunk,typeof rest[0]==='string'?rest[0]:undefined):chunk);return write.call(this,chunk,...rest)}}child.on('exit',(code,signal)=>fs.appendFileSync(p+'.lifecycle.jsonl',JSON.stringify({at:stamp(),code,signal})+'\\n'));return child};
const connect=net.connect;let n=0;net.connect=function(...args){const socket=connect.apply(this,args);if(typeof args[0]==='string'){const p=out+'/bind-socket-'+(++n);fs.appendFileSync(p+'.meta.jsonl',JSON.stringify({at:stamp(),path:args[0],fakeLoopbackOnly:true})+'\\n');socket.on('data',chunk=>fs.appendFileSync(p+'.read',chunk));const write=socket.write;socket.write=function(chunk,...rest){fs.appendFileSync(p+'.write',chunk);return write.call(this,chunk,...rest)}}return socket};require('node:module').syncBuiltinESMExports();`);
  const built = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { build } from 'esbuild';
    const tap = ${JSON.stringify(tap)};
    const common = {bundle:true,platform:'node',target:'node24',packages:'bundle',write:false,metafile:true,logLevel:'silent'};
    const proxy = await build({...common,entryPoints:['src/cli/pi-rpc-app-server-proxy.ts'],format:'cjs',banner:{js:'require('+JSON.stringify(tap)+'); const __paperclipVerifiedEntrypointUrl = require("node:url").pathToFileURL(__filename).href;'},define:{'import.meta.dirname':'__dirname','import.meta.url':'__paperclipVerifiedEntrypointUrl'}});
    const extension = await build({...common,entryPoints:['src/drivers/pi/extension/index.ts'],format:'esm'});
    process.stdout.write(JSON.stringify({proxy:proxy.outputFiles[0].text,extension:extension.outputFiles[0].text,metafiles:[proxy.metafile,extension.metafile]}));
  `], { encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 }));
  await mkdir(dirname(proxy), { recursive: true }); await mkdir(dirname(extension), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}\n'); await writeFile(proxy, built.proxy); await writeFile(extension, built.extension);
  await writeFile(join(root, "bundle-metafiles.json"), JSON.stringify(built.metafiles)); return { command, proxy, extension };
}
const calls: Array<{ name: string; args: Record<string, any> }> = [
  { name: "list_projects", args: {} },
  { name: "search_tasks", args: { limit: 100 } },
  { name: "list_agents", args: {} },
  { name: "call_api", args: { operationId: "GET /api/goals/{id}", pathParams: { id: "10000000-0000-4000-8000-000000000001" } } },
];
const tools = calls.map(c => { const d = paperclipSemanticAction(c.name as Parameters<typeof paperclipSemanticAction>[0]); if (!d) throw new Error(`canonical tool absent: ${c.name}`); return { name: c.name, description: d.description, inputSchema: structuredClone(d.inputSchema) }; });
// Adopt the image1b canonical completion fixture, not a generic ACK-shaped tool.
const completionContract = { revision: "1", criterionIds: ["native-proof"] };
const finishInput = { reportedWorkDisposition: "done", summary: "Local native proof complete.", completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "native-proof", status: "satisfied", evidenceRefs: ["native:local-proof"] }], remainingWork: [] }, evidence: [{ ref: "native:local-proof" }], verification: [] };
const finishTools = [{ name: "paperclip_finish", description: PRP_COMPLETION_TOOL_DESCRIPTION, inputSchema: structuredClone(PRP_COMPLETION_RESULT_BRIDGE_INPUT_SCHEMA) }];
const scenarios = process.env.PI_NESTED_CASES?.split(",") ?? ["nested-four-bash", "finish-warm"];
it.skipIf(!pi || !process.env.PAPERCLIP_RUNNERD_PATH).each(scenarios)("actual Rust/Pi native codemode callback %s", async scenario => {
  const finishWarm = scenario === "finish-warm", dynamicTools = finishWarm ? finishTools : tools;
  const evidence = process.env.PI_NESTED_EVIDENCE; if (!evidence) throw new Error("PI_NESTED_EVIDENCE must name a private persistent attempt directory");
  await mkdir(evidence, { recursive: true });
  // Allocate the complete raw run inside persistent evidence, outside test-env cleanup.
  const root = await mkdtemp(join(evidence, `pi-p0-${scenario}-`));
  await writeFile(join(evidence, `${scenario}.root`), root + "\n");
  const proof: any = { scenario, root, status: "running", sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), started: new Date().toISOString(), businessApi: "fixture data at authenticated-controller port, not live HQ", model: "loopback scripted Messages, no paid requests", runnerSha: digest(process.env.PAPERCLIP_RUNNERD_PATH!), phases: [] };
  const requests: any[] = [], notifications: any[] = [], accounting: any[] = [], handlerCalls: any[] = [], diagnostics: string[] = [], childBirths: any[] = [];
  const originalSpawn = childProcess.spawn;
  const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: any[]) => {
    const child = (originalSpawn as any)(...args), birth = identity(child.pid); childBirths.push({ command: args[0], args: args[1], birth, at: new Date().toISOString() });
    const prefix = join(root, `launch-${child.pid}-${birth?.birth ?? "unknown"}`);
    for (const stream of ["stdout", "stderr"] as const) child[stream]?.on("data", (chunk: Buffer | string) => { appendFileSync(`${prefix}.${stream}`, chunk); appendFileSync(`${prefix}.chunks.jsonl`, JSON.stringify({ at: new Date().toISOString(), stream, bytes: Buffer.byteLength(chunk) }) + "\n"); });
    child.on("exit", (code: number, signal: string) => appendFileSync(`${prefix}.lifecycle.jsonl`, JSON.stringify({ at: new Date().toISOString(), code, signal }) + "\n")); return child;
  }) as typeof childProcess.spawn); syncBuiltinESMExports();
  let transport: ReturnType<typeof createRunnerdCodexTransport>["transport"] | undefined, owned: any[] = [], primary: unknown;
  let activeStep = 0, turnRequests = 0;
  const model = createServer((req, res) => { let raw = ""; req.setEncoding("utf8"); req.on("data", c => { raw += c; }); req.on("end", () => {
    const item: any = { at: new Date().toISOString(), method: req.method, url: req.url, raw, sse: "" }; requests.push(item);
    try {
      const body = JSON.parse(raw); item.body = body; expect(req.url).toBe("/v1/messages?beta=true");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, fields: any) => { const s = `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`; item.sse += s; res.write(s); };
      event("message_start", { message: { id: `fixture-${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
      const emitTool = (index: number, id: string, name: string, input: any) => { event("content_block_start", { index, content_block: { type: "tool_use", id, name, input: {} } }); event("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }); event("content_block_stop", { index }); };
      const last = body.messages.at(-1), results = Array.isArray(last.content) ? last.content.filter((v: any) => v.type === "tool_result") : [];
      if (results.length) {
        item.returned = results; item.returnedAtMs = Date.now();
        if (finishWarm) {
          expect(results).toHaveLength(1); expect(results[0].tool_use_id).toBe(`native-finish-${activeStep}`);
          expect(results[0].is_error ?? false).toBe(false);
          const content = results[0].content;
          const text = typeof content === "string" ? content : content.filter((v: any) => v.type === "text").map((v: any) => v.text).join("");
          expect(JSON.parse(text)).toEqual({ accepted: true });
          item.stateAtNativeReturn = JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8"));
          expect(item.stateAtNativeReturn.toolBridge.pending).toEqual({});
        }
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }); event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "All native results consumed; settle normally." } }); event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
      } else {
        expect(++turnRequests).toBe(1); const names = body.tools.map((v: any) => v.name); expect(names).toContain("bash");
        const runnerPid = transport!.processInfo!().pid!;
        proof.beforeCalls = { at: new Date().toISOString(), runner: identity(runnerPid), descendants: descendants(runnerPid) };
        // Pi rewrites process.title/argv to `pi`; bind its exact spawn receipt, not a name match.
        const spawns = readdirSync(root).filter(p => /^proxy-child-\d+\.lifecycle\.jsonl$/.test(p)).flatMap(p => jsonLines(join(root, p))).filter(p => p.command === proof.piCommand);
        expect(spawns).toHaveLength(1); proof.piSpawn = spawns[0];
        const currentPi = identity(proof.piSpawn.pid);
        if (finishWarm && activeStep) {
          expect(currentPi?.birth).toBe(proof.piBeforeCalls.birth);
          expect(currentPi?.pid).toBe(proof.piBeforeCalls.pid);
          expect(proof.beforeCalls.runner.birth).toBe(proof.phases[0].afterTurn.runner.birth);
          expect(proof.beforeCalls.runner.pid).toBe(proof.phases[0].afterTurn.runner.pid);
        }
        proof.piBeforeCalls = currentPi; expect(proof.piBeforeCalls).not.toBeNull();
        expect(proof.piBeforeCalls.birth).toBe(proof.piSpawn.birth.slice(proof.piSpawn.birth.lastIndexOf(")") + 2).split(" ")[19]);
        expect(proof.beforeCalls.descendants.some((p: any) => p.pid === proof.piBeforeCalls.pid && p.birth === proof.piBeforeCalls.birth)).toBe(true);
        expect(proof.piBeforeCalls.state).not.toBe("Z");
        if (finishWarm) {
          expect(names).toContain("paperclip_finish");
          const definition = body.tools.find((v: any) => v.name === "paperclip_finish");
          const schema = PRP_COMPLETION_RESULT_BRIDGE_INPUT_SCHEMA;
          expect(definition.input_schema).toEqual({ type: schema.type, properties: schema.properties, required: schema.required });
          emitTool(0, `native-finish-${activeStep}`, "paperclip_finish", structuredClone(finishInput));
        }
        else if (scenario === "top-serial") { const c = calls[activeStep]!; emitTool(0, `top-${activeStep}`, c.name, c.args); }
        else {
          expect(names).toContain("codemode"); const selected = scenario === "nested-two" ? calls.slice(0, 2) : calls;
          const expressions = selected.map(c => `tools.${c.name}(${JSON.stringify(c.args)})`);
          const script = scenario === "nested-serial" ? `const r=[];${expressions.map(e => `r.push(await ${e});`).join("")}return r;` : `return await Promise.allSettled([${expressions.join(",")}]);`;
          emitTool(0, `native-${scenario}`, "codemode", { code: script });
          if (scenario === "nested-four-bash") emitTool(1, "native-parallel-bash", "bash", { command: `printf 'real-os-bash-marker\\n' > '${join(root, "bash.marker")}' ; printf 'real-os-bash-marker\\n'`, timeout: 10 });
        }
        event("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } });
      }
      event("message_stop", {}); res.end();
    } catch (e) { item.error = String(e); res.destroy(e as Error); }
    finally { appendFileSync(join(root, "model-http.jsonl"), JSON.stringify(item) + "\n"); }
  }); });
  await new Promise<void>(done => model.listen(0, "127.0.0.1", done)); const address = model.address(); if (!address || typeof address === "string") throw new Error("loopback bind failed");
  try {
    expect(proof.sourceHead).toBe(expectedBase);
    expect(process.env.PI_NESTED_RUNNER_SHA256).toBe(proof.runnerSha);
    const built = await runtime(root); proof.piSha = digest(built.command); proof.piCommand = built.command;
    proof.nodeSha = digest(process.execPath); proof.proxySha = digest(built.proxy); proof.extensionSha = digest(built.extension);
    proof.testSha = digest(join(process.cwd(), "src/live/runnerd-pi-nested-tools.integration.test.ts"));
    const workspace = join(root, "workspace"), agent = join(root, "agent"), registered = join(root, "registered"), bundle = join(root, "bundle");
    await Promise.all([workspace, agent, registered, bundle].map(p => mkdir(p)));
    const instruction = "# Native nested P0 private fixture\nUse only fake loopback data.\n";
    await Promise.all([registered, bundle].map(p => writeFile(join(p, "AGENTS.md"), instruction)));
    // Passive observer only: no invented native events or callback authority.
    await mkdir(join(agent, "extensions"));
    await writeFile(join(agent, "extensions/observe.js"), `import {appendFileSync} from 'node:fs'; export default function(pi){for(const type of ['tool_execution_start','tool_execution_end','tool_call','tool_result','agent_settled','extension_error'])pi.on(type,(event)=>{appendFileSync(${JSON.stringify(join(root, "native-events.jsonl"))},JSON.stringify({at:new Date().toISOString(),atMs:Date.now(),pid:process.pid,event})+'\\n')});}`);
    await writeFile(join(agent, "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
    const value: any = { prompt: { revision: "p0", text: instruction, digest: sha(instruction) }, instructions: { entryPath: "AGENTS.md", bundle: { schema: "paperclip.runtime-asset.v1", digest: sha(instruction), manifestDigest: sha(instruction), rootPath: bundle, fileCount: 1, totalBytes: Buffer.byteLength(instruction) }, workingCopy: { kind: "agent_files", rootPath: registered, entryPath: "AGENTS.md" } }, skills: [], mcp: { assignmentSetId: "none", digest: sha("none"), bindingId: null } };
    const grant = { ...value, aggregateDigest: canonicalNativeRuntimeContextDigest(value) };
    ({ transport } = createRunnerdCodexTransport({ provider: "pi_rpc", runnerBinary: process.env.PAPERCLIP_RUNNERD_PATH, stateDirectory: join(root, "runner-state"), sourceCodexHome: "", providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath), piCommand: built.command, piCommandSha256: digest(built.command), piProxyPath: built.proxy, piProxySha256: digest(built.proxy), piRuntimeDirectory: join(root, "pi-runtime"), piRpcThinkingLevel: "xhigh", baseInstructions: instruction, runtimeContext: grant, lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60000 },
      prpIdentity: { runnerInstanceId: `runner-${scenario}`, environmentLeaseId: `lease-${scenario}`, runId: `run-${scenario}`, normalizedSessionId: `session-${scenario}`, turnId: `turn-${scenario}`, itemId: `item-${scenario}` },
      environment: { PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, AGENT_HOME: registered, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" },
      onDiagnostic: s => { diagnostics.push(s); appendFileSync(join(root, "diagnostics.txt"), s + "\n"); }, onAccountingEvent: async e => { accounting.push(e); appendFileSync(join(root, "accounting.jsonl"), JSON.stringify(e) + "\n"); },
    }));
    transport.setServerRequestHandler(async request => { handlerCalls.push({ at: new Date().toISOString(), request }); appendFileSync(join(root, "handler-calls.jsonl"), JSON.stringify(handlerCalls.at(-1)) + "\n"); const name = String(request.params.tool);
      if (finishWarm) {
        expect(request.method).toBe("item/tool/call");
        expect(request.params).toMatchObject({ tool: "paperclip_finish", callId: `native-finish-${activeStep}`, arguments: finishInput });
        expect(request.paperclipTrace?.sourceEventId).toBeTypeOf("string");
        expect(request.paperclipTrace?.sourceEventType).toBe("semantic_tool.input");
        // Authenticated controller authority is the sole fixture. Real transport
        // submits semantic_tool.result; Rust admits terminal authority and RFL.
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ accepted: true }) }] };
      }
      expect(calls.map(c => c.name)).toContain(name); const result = { fixture: true, tool: name, marker: `returned-${name}`, data: name === "list_agents" ? { actors: [] } : name === "list_projects" ? { projects: [] } : name === "search_tasks" ? { tasks: [] } : { id: calls[3]!.args.pathParams!.id } }; return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] }; });
    // Cold private SDK copy/pack qualification is not a product latency assertion.
    const opened = await within(transport.request("thread/start", { cwd: workspace, model: "paperclip/claude-opus-5-5", dynamicTools, ...(finishWarm ? { completionContract } : {}) }), 60000); proof.opened = opened;
    const runnerPid = transport.processInfo!().pid!; owned = [identity(runnerPid), ...descendants(runnerPid)].filter(Boolean); proof.initialOwned = owned;
    const iterator = transport.notifications()[Symbol.asyncIterator]();
    const count = finishWarm ? 2 : scenario === "top-serial" ? 4 : 1;
    for (let i = 0; i < count; i++) {
      activeStep = i; turnRequests = 0;
      if (i) {
        const atMs = Date.now(), before = { runner: identity(runnerPid), pi: identity(proof.piBeforeCalls.pid) };
        const attached = await within(transport.attachRun!({ runId: `run-${scenario}-${i}`, turnId: `turn-${scenario}-${i}`, itemId: `item-${scenario}-${i}`, currentRunGrant: { instructions: instruction, runtimeContext: grant }, dynamicTools, ...(finishWarm ? { completionContract } : {}) }));
        if (finishWarm) {
          proof.warmAttach = { startMs: atMs, endMs: Date.now(), durationMs: Date.now() - atMs, attached, before, after: { runner: identity(runnerPid), pi: identity(proof.piBeforeCalls.pid) } };
          expect(proof.warmAttach.after.runner?.birth).toBe(before.runner.birth);
          expect(proof.warmAttach.after.pi?.birth).toBe(before.pi.birth);
          expect(JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8")).toolBridge.pending).toEqual({});
        }
      }
      const started = await within(transport.request("turn/start", { input: [{ type: "text", text: `Run exact ${scenario} step ${i}` }] })); proof.phases.push({ started });
      for (;;) { const n = await within(iterator.next(), 20000); if (n.done) throw new Error("native stream ended"); notifications.push(n.value); appendFileSync(join(root, "notifications.jsonl"), JSON.stringify(n.value) + "\n"); if (n.value.method === "turn/completed") { expect(n.value.params.status ?? rec(n.value.params.turn).status).toBe("completed"); proof.phases.at(-1).terminal = n.value; break; } if (n.value.method === "turn/failed") throw new Error(JSON.stringify(n.value)); }
      proof.phases.at(-1).completed = true;
      if (finishWarm) {
        const phase = proof.phases.at(-1), callId = `native-finish-${i}`;
        await vi.waitFor(() => {
          phase.state = JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8"));
          expect(phase.state.toolBridge.pending).toEqual({});
          expect(phase.state.pendingEvents).toEqual([]); expect(phase.state.queuedEvents).toEqual([]);
          expect(phase.state.activeProviderTurnId).toBeNull(); expect(phase.state.completedTurnAuthoritative).toBe(true);
          phase.control = JSON.parse(readFileSync(join(root, "runner-state/control-plane/control-plane-state.json"), "utf8"));
          expect(phase.control.commands.every((c: any) => c.status !== "pending")).toBe(true);
        }, { timeout: 5000, interval: 50 });
        expect(phase.state.toolBridge.settledResults[callId]).toEqual({ call: { callId, operationId: "paperclip_finish", input: finishInput }, result: { callId, operationId: "paperclip_finish", result: { accepted: true }, isError: false } });
        const native = jsonLines(join(root, "native-events.jsonl"));
        const starts = native.filter(e => e.event.type === "tool_execution_start" && e.event.toolCallId === callId);
        const ends = native.filter(e => e.event.type === "tool_execution_end" && e.event.toolCallId === callId);
        expect(starts).toHaveLength(1); expect(ends).toHaveLength(1);
        expect(starts[0].event.toolName).toBe("paperclip_finish"); expect(ends[0].event.isError).toBe(false);
        expect(starts[0].pid).toBe(proof.piBeforeCalls.pid); expect(ends[0].pid).toBe(proof.piBeforeCalls.pid);
        const text = ends[0].event.result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        expect(JSON.parse(text)).toEqual({ accepted: true });
        const returned = requests.find(r => r.returned?.some((v: any) => v.tool_use_id === callId)); expect(returned).toBeDefined();
        phase.finish = { start: starts[0], end: ends[0], returnedAtMs: returned.returnedAtMs, nativeDurationMs: ends[0].atMs - starts[0].atMs, returnedDurationMs: returned.returnedAtMs - starts[0].atMs, rpcResult: ends[0].event.result, modelResult: returned.returned, pendingAtReturn: returned.stateAtNativeReturn.toolBridge.pending };
        expect(phase.finish.nativeDurationMs).toBeGreaterThanOrEqual(0); expect(phase.finish.nativeDurationMs).toBeLessThan(1000);
        expect(phase.finish.returnedDurationMs).toBeGreaterThanOrEqual(phase.finish.nativeDurationMs); expect(phase.finish.returnedDurationMs).toBeLessThan(1000);
        const terminal = accounting.filter(e => e.eventType === "run.terminal").map(e => e.payload);
        expect(terminal).toHaveLength(i + 1);
        expect(terminal[i]).toEqual({ schema: "paperclip.prp.terminal.v1", provider: "pi_rpc", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" });
        phase.afterTurn = { runner: identity(runnerPid), pi: identity(proof.piBeforeCalls.pid) };
        expect(phase.afterTurn.runner?.birth).toBe(proof.initialOwned[0].birth);
        expect(phase.afterTurn.pi?.birth).toBe(proof.piBeforeCalls.birth);
        expect(phase.afterTurn.pi?.state).not.toBe("Z");
        const settled = native.filter(e => e.event.type === "agent_settled");
        expect(settled).toHaveLength(i + 1); expect(settled[i].event.aborted).toBe(false);
      }
    }
    const returns = requests.flatMap(r => r.returned ?? []); proof.returned = returns;
    expect(handlerCalls).toHaveLength(finishWarm ? 2 : scenario === "nested-two" ? 2 : 4);
    for (const c of (finishWarm ? [] : scenario === "nested-two" ? calls.slice(0, 2) : calls)) expect(JSON.stringify(returns)).toContain(`returned-${c.name}`);
    if (scenario === "nested-four-bash") expect(readFileSync(join(root, "bash.marker"), "utf8")).toBe("real-os-bash-marker\n");
    // Completion notification is the event source; wait only for its durable ACK suffix.
    await vi.waitFor(() => {
      proof.stateBeforeStop = JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8"));
      expect(rec(proof.stateBeforeStop.toolBridge).pending).toEqual({});
      expect(proof.stateBeforeStop.pendingEvents).toEqual([]); expect(proof.stateBeforeStop.queuedEvents).toEqual([]);
    }, { timeout: 5000, interval: 50 });
    proof.afterTurn = { at: new Date().toISOString(), runner: identity(runnerPid), pi: identity(proof.piBeforeCalls.pid), descendants: descendants(runnerPid) };
    expect(proof.afterTurn.runner?.birth).toBe(proof.beforeCalls.runner.birth);
    expect(proof.afterTurn.runner?.state).not.toBe("Z");
    expect(proof.afterTurn.pi?.birth).toBe(proof.piBeforeCalls.birth);
    expect(proof.afterTurn.pi?.state).not.toBe("Z");
    if (scenario === "nested-four-bash") {
      const events = jsonLines(join(root, "native-events.jsonl"));
      const starts = events.filter(e => e.event.type === "tool_execution_start" && calls.some(c => c.name === e.event.toolName));
      const ends = events.filter(e => e.event.type === "tool_execution_end" && calls.some(c => c.name === e.event.toolName));
      expect(starts).toHaveLength(4); expect(ends).toHaveLength(4);
      const ids = starts.map(e => e.event.toolCallId);
      expect(new Set(ids).size).toBe(4);
      expect([...ids].sort()).toEqual([1, 2, 3, 4].map(n => `native-${scenario}/${n}`));
      for (const e of [...starts, ...ends]) expect(e.pid).toBe(proof.piBeforeCalls.pid);
      for (const c of calls) {
        const end = ends.find(e => e.event.toolName === c.name);
        expect(end.event.isError).toBe(false);
        expect(JSON.stringify(end.event.result)).toContain(`returned-${c.name}`);
      }
      const codemode = returns.find(r => r.tool_use_id === `native-${scenario}`);
      expect(codemode).toBeDefined(); expect(codemode.is_error ?? false).toBe(false);
      const text = typeof codemode.content === "string" ? codemode.content : codemode.content.filter((v: any) => v.type === "text").map((v: any) => v.text).join("\n");
      expect(text).not.toMatch(/refused|rejected/);
      expect(text).toMatch(/^Script completed\n/);
      const settled = JSON.parse(text.slice(text.indexOf("Output:\n") + "Output:\n".length).trim());
      expect(settled).toHaveLength(4);
      for (const [i, c] of calls.entries()) {
        expect(settled[i].status).toBe("fulfilled");
        const value = JSON.parse(settled[i].value), payload = c.name === "call_api" ? value.result : value;
        if (c.name === "call_api") expect(value.ok).toBe(true);
        expect(payload).toEqual({ fixture: true, tool: c.name, marker: `returned-${c.name}`, data: c.name === "list_agents" ? { actors: [] } : c.name === "list_projects" ? { projects: [] } : c.name === "search_tasks" ? { tasks: [] } : { id: calls[3]!.args.pathParams!.id } });
      }
      proof.fulfilledValues = settled;
      const wire = jsonLines(join(root, "proxy-upstream.stdout")).filter(e => e.method === "item/tool/call");
      expect(wire).toHaveLength(4);
      expect(new Set(wire.map(e => e.params.callId)).size).toBe(4);
      for (const c of calls) {
        const call = wire.find(e => e.params.tool === c.name); expect(call).toBeDefined();
        expect(call.params.callId).toMatch(/^pi_tool_[a-f0-9]{64}$/);
        expect(call.params.arguments).toEqual(c.args);
      }
      proof.nativeChildIds = ids; proof.upstreamCalls = wire; proof.nativeResults = ends; proof.codemodeResult = codemode;
    }
    proof.controlBeforeStop = JSON.parse(readFileSync(join(root, "runner-state/control-plane/control-plane-state.json"), "utf8"));
    proof.runnerBeforeStop = JSON.parse(readFileSync(join(root, "runner-state/runner/runner-state.json"), "utf8"));
    expect(proof.controlBeforeStop.commands.every((c: any) => c.status !== "pending")).toBe(true);
    expect(proof.stateBeforeStop.activeProviderTurnId).toBeNull();
    expect(proof.stateBeforeStop.completedTurnAuthoritative).toBe(true);
    expect(proof.stateBeforeStop.pendingEvents).toEqual([]); expect(proof.stateBeforeStop.queuedEvents).toEqual([]);
    proof.status = "passed";
  } catch (e) { primary = e; proof.status = "failed"; proof.error = String(e); proof.stack = e instanceof Error ? e.stack : undefined; }
  finally {
    const pid = transport?.processInfo?.().pid; if (pid) for (const p of [identity(pid), ...descendants(pid)].filter(Boolean)) if (!owned.some(x => x.pid === p.pid && x.birth === p.birth)) owned.push(p);
    proof.ownedBeforeStop = owned; proof.childBirths = childBirths;
    if (existsSync(join(root, "runner-state"))) await cp(join(root, "runner-state"), join(root, "archived-before-stop"), { recursive: true });
    await writeFile(join(root, "pre-stop-proof.json"), JSON.stringify(proof, null, 2));
    try { await within(transport?.close("native-nested-repro-stop") ?? Promise.resolve(), 15000); } catch (e) { proof.stopError = String(e); primary ??= e; }
    try { const groups = new Set(owned.map(x => x.pgid)); expect(groups.has(identity(process.pid)?.pgid)).toBe(false); await vi.waitFor(() => { expect(processes().filter(p => groups.has(p.pgid))).toEqual([]); for (const p of owned) expect(identity(p.pid)?.birth === p.birth).toBe(false); }, { timeout: 5000, interval: 50 }); proof.physicalRetirementVerified = true; } catch (e) { proof.retirementError = String(e); primary ??= e; }
    proof.canonicalAfterStop = existsSync(join(root, "runner-state/runner/codex-provider-state.json")) ? JSON.parse(readFileSync(join(root, "runner-state/runner/codex-provider-state.json"), "utf8")) : null;
    try {
      proof.runnerAfterStop = JSON.parse(readFileSync(join(root, "runner-state/runner/runner-state.json"), "utf8"));
      proof.controlAfterStop = JSON.parse(readFileSync(join(root, "runner-state/control-plane/control-plane-state.json"), "utf8"));
      expect(proof.runnerAfterStop.lifecycle).toBe("suspended");
      expect(proof.runnerAfterStop.pendingTerminalDelivery ?? null).toBeNull();
      expect(proof.runnerAfterStop.pendingProviderCleanup ?? null).toBeNull();
      expect(proof.controlAfterStop.commands.some((c: any) => c.type === "runner.suspend" && c.status === "completed")).toBe(true);
      expect(proof.controlAfterStop.commands.every((c: any) => c.status !== "pending")).toBe(true);
      expect(proof.canonicalAfterStop.toolBridge.pending).toEqual({});
      expect(proof.canonicalAfterStop.activeProviderTurnId).toBeNull();
      expect(proof.canonicalAfterStop.pendingEvents).toEqual([]); expect(proof.canonicalAfterStop.queuedEvents).toEqual([]);
      proof.durableSettlementVerified = true;
    } catch (e) { proof.settlementError = String(e); primary ??= e; }
    model.closeAllConnections(); await new Promise<void>(done => model.close(() => done())); spy.mockRestore(); syncBuiltinESMExports();
    proof.ended = new Date().toISOString(); proof.handlerCalls = handlerCalls; proof.requests = requests.length; proof.diagnostics = diagnostics;
    if (primary) proof.status = "failed";
    proof.evidenceRoot = root;
    await writeFile(join(root, "model-requests.json"), JSON.stringify(requests, null, 2)); await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2)); await writeFile(join(evidence, `${scenario}.proof.json`), JSON.stringify(proof, null, 2));
  }
  if (primary) throw primary;
}, 110000);
