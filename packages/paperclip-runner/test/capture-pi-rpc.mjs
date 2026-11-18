#!/usr/bin/env node
/** Real Pi RPC with a synthetic OpenAI-compatible peer; no account or model spend. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { admitPiRpcSession, resolvePiNativeConfig } from "../src/drivers/pi/pi-native-config.ts";

const args = process.argv.slice(2);
const entry = args[args.indexOf("--pi-entry") + 1];
const destination = args[args.indexOf("--out") + 1];
if (!args.includes("--pi-entry") || !args.includes("--out") || !entry || !destination) throw new Error("Usage: node test/capture-pi-rpc.mjs --pi-entry /verified/distribution/.../dist/cli.js --out /evidence");
const scenarioArg = args.includes("--scenario") ? args[args.indexOf("--scenario") + 1] : "baseline";
assert.ok(["baseline", "unsupported-thinking", "abort", "queue", "retry", "compaction", "extension", "subagent"].includes(scenarioArg));
const output = resolve(destination);
await mkdir(output, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "paperclip-pi-rpc-capture-"));
const agent = join(root, "agent");
const workspace = join(root, "workspace");
await mkdir(agent); await mkdir(workspace);
const environment = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", LANG: "C.UTF-8" };
const records = [];
const commands = [];
const requests = [];
const byScenario = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
    let data = "";
    for await (const chunk of req) { data += chunk; assert.ok(data.length < 1024 * 1024); }
    const body = JSON.parse(data);
    assert.equal(body.model, "neutral/vendor-model-not-in-bundled-catalog");
    const lastUser = body.messages.filter(message => message.role === "user").at(-1);
    const prompt = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content);
    const scenario = scenarioArg === "baseline" ? prompt.includes("scenario:tool-success") ? "tool-success" : prompt.includes("scenario:tool-error") ? "tool-error" : "text" : scenarioArg;
    const round = (byScenario.get(scenario) ?? 0) + 1; byScenario.set(scenario, round);
    requests.push({ method: req.method, path: req.url, model: body.model, scenario, round, roles: body.messages.map(message => message.role), tools: (body.tools ?? []).map(tool => tool.function.name) });
    if (scenario === "retry" && round === 1) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "500 controlled overloaded", type: "server_error" } })); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const id = `chatcmpl-${scenario}-${round}`;
    const chunk = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1700000000, model: body.model, choices: usage ? [] : [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    chunk({ role: "assistant", content: "" });
    const toolTurn = ["tool-success", "tool-error", "subagent"].includes(scenario) && round === 1;
    if (toolTurn) {
      const command = scenario === "tool-success" ? "printf 'pi-native-tool-ok\\n'" : "printf 'pi-native-tool-error\\n' >&2; exit 7";
      // Exercise the installed subagent tool's safe management action. No child
      // agent is launched: the task prohibits spawning agents.
      const serialized = JSON.stringify(scenario === "subagent" ? { action: "list", agentScope: "both" } : { command });
      chunk({ tool_calls: [{ index: 0, id: `call-${scenario}`, type: "function", function: { name: scenario === "subagent" ? "subagent" : "bash", arguments: "" } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: serialized.slice(0, 13) } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: serialized.slice(13) } }] });
      chunk({}, "tool_calls");
    } else {
      const text = scenario === "text" ? "Hello 🌍\u2028line" : scenario === "tool-success" ? "Tool succeeded." : "Tool failure was observed.";
      chunk({ content: text.slice(0, 6) });
      if (["abort", "queue", "extension"].includes(scenario) && round === 1) await sleep(500);
      chunk({ content: text.slice(6) }); chunk({}, "stop");
    }
    const promptTokens = scenario === "compaction" && round === 2 ? 3900 : 12 + round;
    chunk({}, null, { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3, prompt_tokens_details: { cached_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address();
await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { paperclip: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "credential-free-controlled-peer", models: [{ id: "neutral/vendor-model-not-in-bundled-catalog", name: "Controlled peer", reasoning: false, input: ["text"], contextWindow: scenarioArg === "compaction" ? 4096 : 32000, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }] } } }));
await writeFile(join(agent, "settings.json"), JSON.stringify({ cacheWarming: "off", retry: { enabled: true, maxRetries: 1, baseDelayMs: 10, maxAgentDelayMs: 100, provider: { maxRetries: 0 } }, compaction: { enabled: scenarioArg === "compaction", reserveTokens: 1024, keepRecentTokens: 128 } }));
const extension = join(root, "unprompted.ts");
if (scenarioArg === "extension") await writeFile(extension, 'export default function(pi) { pi.on("session_start", () => { setTimeout(() => { pi.sendMessage({customType:"controlled-autonomous",content:"Unrequested extension turn",display:false},{triggerTurn:true}); }, 50); }); }');
const commandArgs = [resolve(entry), "--mode", "rpc", "--no-session", "--provider", "paperclip", "--model", "neutral/vendor-model-not-in-bundled-catalog", "--thinking", "off", "--tools", scenarioArg === "subagent" ? "bash,subagent" : "bash", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline"];
if (scenarioArg === "extension") commandArgs.push("--extension", extension);
if (scenarioArg === "subagent") {
  assert.ok(args.includes("--subagents-entry"), "--subagents-entry required for installed package");
  commandArgs.push("--extension", resolve(args[args.indexOf("--subagents-entry") + 1]));
}
const child = spawn(process.execPath, commandArgs, { cwd: workspace, env: environment, stdio: ["pipe", "pipe", "pipe"] });
const exit = once(child, "exit");
let stderr = "", buffer = "", sequence = 0;
const pending = new Map();
const listeners = new Set();
const decoder = new TextDecoder("utf-8", { fatal: true });
child.stderr.on("data", chunk => { stderr += chunk; });
let streamError;
const consume = chunk => {
  try {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer) > 1024 * 1024) throw new Error("capture frame bound exceeded");
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, ""); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const record = JSON.parse(line);
      if (records.length >= 2048) throw new Error("capture record count bound exceeded");
      records.push(record);
      if (record.type === "response") {
        const request = pending.get(record.id);
        if (request) { pending.delete(record.id); record.success ? request.resolve(record.data) : request.reject(new Error(record.error)); }
      }
      for (const listener of listeners) listener(record);
    }
  } catch (error) { streamError = error; for (const request of pending.values()) request.reject(error); }
};
child.stdout.on("data", consume);
child.stdout.on("end", () => {
  try { buffer += decoder.decode(); if (buffer.length) throw new Error("incomplete terminal JSONL frame"); }
  catch (error) { streamError = error; for (const request of pending.values()) request.reject(error); }
});
const request = async command => {
  const id = `capture-${++sequence}`;
  let timeout;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject }); timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${command.type} timed out`)); }, 20000);
    commands.push({ ...command, id });
    child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
  });
  try { return await promise; } finally { clearTimeout(timeout); }
};
const settle = async message => {
  let timeout, listener;
  const settled = new Promise((resolve, reject) => {
    listener = event => { if (event.type === "agent_settled") resolve(event); };
    listeners.add(listener); timeout = setTimeout(() => reject(new Error("agent_settled timed out")), 25000);
  });
  try { const accepted = await request({ type: "prompt", message }); assert.equal(accepted.disposition, "started"); assert.equal((await settled).aborted, false); }
  finally { clearTimeout(timeout); listeners.delete(listener); }
};
const waitExit = async ms => {
  let timeout;
  try { return await Promise.race([exit.then(() => true), new Promise(resolve => { timeout = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timeout); }
};
const waitEvent = async (predicate, from = records.length) => {
  const existing = records.slice(from).find(predicate); if (existing) return existing;
  let timer, listener;
  try { return await new Promise((resolve, reject) => { listener = event => { if (predicate(event)) resolve(event); }; listeners.add(listener); timer = setTimeout(() => reject(new Error(`event deadline for ${scenarioArg}`)), 25000); }); }
  finally { clearTimeout(timer); listeners.delete(listener); }
};
try {
  if (scenarioArg === "extension") {
    // No prompt was admitted. Clear queues before abort: native abort alone
    // can continue queued input. Capture this real unauthorized start + fence.
    await waitEvent(event => event.type === "agent_start", 0);
    const from = records.length;
    await request({ type: "clear_queue" }); await request({ type: "abort" });
    await waitEvent(event => event.type === "agent_settled", from);
    assert.equal(requests.length <= 1, true);
  } else {
  await request({ type: "set_auto_retry", enabled: scenarioArg === "retry" });
  await request({ type: "set_auto_compaction", enabled: scenarioArg === "compaction" });
  const saved = JSON.parse(JSON.stringify({ provider: "pi_rpc", model: "paperclip/neutral/vendor-model-not-in-bundled-catalog", piRpcThinkingLevel: "off" }));
  const identity = await admitPiRpcSession({ request }, resolvePiNativeConfig(saved));
  assert.equal(identity.model, saved.model); assert.equal(identity.piRpcThinkingLevel, "off"); assert.ok(identity.providerSessionId);
  if (scenarioArg === "unsupported-thinking") {
    assert.deepEqual(await request({ type: "get_available_thinking_levels" }), { levels: ["off"] });
    await request({ type: "set_thinking_level", level: "high" });
    assert.equal((await request({ type: "get_state" })).thinkingLevel, "off");
  } else if (["abort", "queue"].includes(scenarioArg)) {
    const from = records.length;
    await request({ type: "prompt", message: `scenario:${scenarioArg}` });
    await waitEvent(event => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta", from);
    if (scenarioArg === "abort") {
      await request({ type: "clear_queue" }); await request({ type: "abort" });
      assert.equal((await waitEvent(event => event.type === "agent_settled", from)).aborted, true);
    } else {
      await request({ type: "steer", message: "steering-marker" });
      await request({ type: "follow_up", message: "followup-marker" });
      await waitEvent(event => event.type === "agent_settled", from);
      const messages = (await request({ type: "get_messages" })).messages;
      for (const marker of ["steering-marker", "followup-marker"]) assert.ok(messages.some(message => JSON.stringify(message.content).includes(marker)));
    }
  } else if (scenarioArg === "baseline") {
    for (const scenario of ["text", "tool-success", "tool-error"]) await settle(`scenario:${scenario}`);
    assert.equal(records.filter(event => event.type === "tool_execution_end").length, 2);
    assert.equal(records.filter(event => event.type === "tool_execution_end" && event.isError).length, 1);
  } else {
    if (scenarioArg === "compaction") await settle("scenario:compaction-prime " + "Controlled retained history. ".repeat(200));
    await settle(`scenario:${scenarioArg}` + (scenarioArg === "compaction" ? " Retained current turn. ".repeat(200) : ""));
    if (scenarioArg === "retry") assert.ok(records.some(event => event.type === "auto_retry_start"));
    if (scenarioArg === "compaction") assert.ok(records.some(event => event.type === "compaction_end" && event.result));
    if (scenarioArg === "subagent") {
      assert.ok(requests.some(request => request.tools.includes("subagent")), "installed tool must be advertised");
      assert.ok(records.some(event => event.type === "tool_execution_end" && event.toolName === "subagent" && !JSON.stringify(event.result).includes("Tool subagent not found")));
    }
  }
  }
  if (streamError) throw streamError;
} finally {
  child.stdin.end();
  if (!await waitExit(5000)) { child.kill("SIGTERM"); if (!await waitExit(2000)) { child.kill("SIGKILL"); await exit; } }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, "wire.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
  await writeFile(join(output, "requests.json"), JSON.stringify(requests, null, 2) + "\n");
  await writeFile(join(output, "commands.jsonl"), commands.map(command => JSON.stringify(command)).join("\n") + "\n");
  await writeFile(join(output, "stderr.log"), stderr);
  const packageRoot = resolve(dirname(entry), "..");
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  const version = spawnSync(process.execPath, [entry, "--version"], { env: environment, encoding: "utf8", timeout: 10000 });
  await writeFile(join(output, "provenance.json"), JSON.stringify({ runtimePackage: pkg.name, runtimeVersion: pkg.version, reportedVersion: version.stdout.trim(), cliSha256: createHash("sha256").update(await readFile(entry)).digest("hex"), captureScriptSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"), capturedAt: new Date().toISOString(), evidenceLevel: "real_dependency_with_controlled_peer", modelPeer: "synthetic loopback OpenAI chat completions", scenario: scenarioArg, nativeTools: scenarioArg === "subagent" ? "installed pi-subagents 0.88.0 subagent action:list; no child spawned" : "real Pi bash tool; finite printf and exit 7 where applicable", rpcRecords: records.length, modelRequests: requests.length, childExitCode: child.exitCode, childSignal: child.signalCode, noLiveProviderCalls: true }, null, 2) + "\n");
  await rm(root, { recursive: true, force: true });
}
if (streamError) throw streamError;
console.log(JSON.stringify({ records: records.length, requests: requests.length, output, exited: child.exitCode, signal: child.signalCode }));
