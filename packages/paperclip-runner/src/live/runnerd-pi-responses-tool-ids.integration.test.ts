import { createServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { expect, it, vi } from "vitest";
import { paperclipSemanticAction } from "../catalog/semantic-action-catalog.js";
import { usesPiProviderLoopback } from "../drivers/acpx/pi-provider-loopback.js";
import type { CodexRpcNotification } from "../drivers/codex/app-server-transport.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

// Recorded trust-boundary regression: real runnerd rejects Pi Responses' call_x|fc_y.
// Adopted from the parked df8c0d4b proof; installation/CJS/process helpers retain
// the validated API-proof pattern. Only upstream SSE and tool authority are faux.
const pi = process.env.PI_TEST_BINARY;
const normalizedSessionId = "session-pi-responses-ids";
const modelProtocol = process.env.PI_PROOF_MODEL_PROTOCOL ?? "responses";
if (!["responses", "messages", "chat"].includes(modelProtocol)) throw new Error("PI_PROOF_MODEL_PROTOCOL must be responses, messages, or chat");
const modelId = modelProtocol === "messages" ? "claude-opus-5-5" : "gpt-5.4";
const model = `paperclip/${modelId}`;
const runIds = ["run-pi-responses-first", "run-pi-responses-second"] as const;
const callIds = ["call_x", "call_x_2"] as const;
const itemIds = ["fc_y", "fc_y_2"] as const;
const tools = ["get_task_context", "list_agents"] as const;
const results = [{ marker: "responses-context-result", nested: { ok: true }, values: [1, 2] }, { marker: "responses-agents-result", actors: [{ id: "local-proof-actor" }] }] as const;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const composite = (index: number) => `${callIds[index]}|${itemIds[index]}`;
const nativeId = (index: number) => modelProtocol === "responses" ? composite(index) : modelProtocol === "messages" ? `toolu_pi_proof_${index + 1}` : callIds[index];
function contentText(content: unknown): string {
  return Array.isArray(content) ? content.map(part => String(record(part).text ?? "")).join("") : String(content ?? "");
}
// Flatten only the upstream history assertions, never production payloads.
function wireHistory(body: Record<string, unknown>): Record<string, unknown>[] {
  if (modelProtocol === "responses") return (body.input as unknown[]).map(record);
  return (body.messages as unknown[]).map(record).flatMap<Record<string, unknown>>(message => {
    if (modelProtocol === "messages") return (Array.isArray(message.content) ? message.content : []).map(record).flatMap<Record<string, unknown>>(part =>
      part.type === "tool_use" ? [{ type: "function_call", name: part.name, arguments: JSON.stringify(part.input), call_id: part.id }]
        : part.type === "tool_result" ? [{ type: "function_call_output", call_id: part.tool_use_id, output: contentText(part.content) }] : []);
    if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: contentText(message.content) }];
    return (Array.isArray(message.tool_calls) ? message.tool_calls : []).map(record).map(call => ({ type: "function_call", name: record(call.function).name, arguments: record(call.function).arguments, call_id: call.id }));
  });
}
function dynamicTools() {
  return tools.map(name => {
    const tool = paperclipSemanticAction(name);
    if (!tool) throw new Error(`missing canonical tool ${name}`);
    return { name, description: tool.description, inputSchema: structuredClone(tool.inputSchema) };
  });
}
async function within<T>(label: string, promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
type ProcessIdentity = { pid: number; ppid: number; pgid: number; started: string; cmdline: string };
function processIdentity(pid: number): ProcessIdentity | null {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), started: fields[19]!, cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
function processes(): ProcessIdentity[] {
  return readdirSync("/proc").filter(entry => /^\d+$/.test(entry)).map(entry => processIdentity(Number(entry))).filter((entry): entry is ProcessIdentity => entry !== null);
}
function descendants(root: number): ProcessIdentity[] {
  const all = processes(), result: ProcessIdentity[] = [];
  const visit = (pid: number) => { for (const child of all.filter(entry => entry.ppid === pid)) { result.push(child); visit(child.pid); } };
  visit(root);
  return result;
}
function piIdentity(runnerPid: number): ProcessIdentity {
  const children = descendants(runnerPid).filter(entry => entry.cmdline.trim() === "pi" || entry.cmdline.includes("--mode rpc"));
  expect(children, "one installed Pi beneath actual runnerd").toHaveLength(1);
  return children[0]!;
}
function installedPiClosure(binary: string): { nodeModules: string; executableRelative: string } {
  const executable = realpathSync(binary), packageRoots: string[] = [];
  for (let directory = dirname(executable);; directory = dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const value = record(JSON.parse(readFileSync(manifest, "utf8")));
      if (value.name === "@earendil-works/pi-coding-agent") {
        if (value.version !== "1.5.2") throw new Error("supplied Pi package differs from 1.5.2");
        const entrypoint = record(value.bin).pi;
        if (typeof entrypoint !== "string" || realpathSync(join(directory, entrypoint)) !== executable) throw new Error("supplied binary is not installed Pi entrypoint");
        packageRoots.push(directory);
      }
    }
    if (dirname(directory) === directory) break;
  }
  if (packageRoots.length !== 1) throw new Error("Pi package root missing or ambiguous");
  const packageRoot = packageRoots[0]!, closures: string[] = [];
  for (let directory = dirname(packageRoot);; directory = dirname(directory)) {
    const candidate = join(directory, "@earendil-works/pi-coding-agent");
    if (basename(directory) === "node_modules" && existsSync(candidate) && realpathSync(candidate) === packageRoot) closures.push(directory);
    if (dirname(directory) === directory) break;
  }
  if (closures.length !== 1) throw new Error("installed Pi closure missing or ambiguous");
  const nodeModules = closures[0]!, executableRelative = relative(nodeModules, executable);
  if (isAbsolute(executableRelative) || executableRelative === ".." || executableRelative.startsWith(`..${sep}`)) throw new Error("Pi escapes closure");
  return { nodeModules, executableRelative };
}
async function runtimeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await runtimeReadOnly(path);
    else if (entry.isFile()) await chmod(path, (await stat(path)).mode & 0o555);
    else throw new Error(`unexpected installed runtime entry: ${path}`);
  }
  await chmod(directory, 0o555);
}
async function productionRuntime(root: string) {
  const closure = installedPiClosure(pi!);
  const packageRoot = join(root, "pi-package");
  await mkdir(packageRoot);
  await cp(closure.nodeModules, join(packageRoot, "node_modules"), { recursive: true, dereference: true });
  await runtimeReadOnly(packageRoot);
  const executable = join(packageRoot, "node_modules", closure.executableRelative);
  expect(execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("1.5.2");
  const proxy = join(root, "cli", "pi-rpc-app-server-proxy.cjs");
  const extension = join(root, "drivers", "pi", "extension", "index.js");
  const artifacts = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { build } from "esbuild";
    import { builtinModules } from "node:module";
    const common = { bundle: true, platform: "node", target: "node24", packages: "bundle", splitting: false, sourcemap: false, legalComments: "none", metafile: true, treeShaking: true, write: false, logLevel: "silent" };
    const proxy = await build({ ...common, entryPoints: ["src/cli/pi-rpc-app-server-proxy.ts"], outfile: "cli/pi-rpc-app-server-proxy.cjs", format: "cjs",
      banner: { js: 'const __paperclipVerifiedEntrypointUrl = require("node:url").pathToFileURL(__filename).href;' },
      define: { "import.meta.dirname": "__dirname", "import.meta.url": "__paperclipVerifiedEntrypointUrl" },
    });
    const extension = await build({ ...common, entryPoints: ["src/drivers/pi/extension/index.ts"], outfile: "drivers/pi/extension/index.js", format: "esm" });
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => "node:" + name)]);
    for (const result of [proxy, extension]) {
      const entries = Object.values(result.metafile.outputs).filter(output => output.entryPoint !== undefined);
      if (entries.length !== 1 || entries[0].imports.some(dependency => !dependency.external || !builtins.has(dependency.path))) throw new Error("production bundle is not self-contained");
    }
    process.stdout.write(JSON.stringify({ proxy: proxy.outputFiles[0].text, extension: extension.outputFiles[0].text, proxyMetafile: proxy.metafile, extensionMetafile: extension.metafile }));
  `], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as { proxy: string; extension: string; proxyMetafile: unknown; extensionMetafile: unknown };
  await mkdir(dirname(proxy), { recursive: true }); await mkdir(dirname(extension), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  await writeFile(proxy, artifacts.proxy, { mode: 0o755 });
  await writeFile(extension, artifacts.extension, { mode: 0o444 });
  await writeFile(join(root, "production-bundle-metafiles.json"), `${JSON.stringify({ proxy: artifacts.proxyMetafile, extension: artifacts.extensionMetafile }, null, 2)}\n`);
  return { executable, proxy, extension, closure };
}

type ModelRequest = { method: string | undefined; url: string | undefined; raw: string; body: Record<string, unknown>; rawSse: string };
// Frozen Messages frame logic from pi-messages-frozen-fixtures-v2. Native
// Anthropic event shapes, not a Response relabeled as a Message.
function anthropicStream(response: ServerResponse, captured: ModelRequest, sequence: number) {
  const event = (type: string, fields: Record<string, unknown>) => {
    const bytes = `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    captured.rawSse += bytes; response.write(bytes);
  };
  event("message_start", { message: { id: `local-faux-${sequence}`, type: "message", role: "assistant", model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
  return {
    text: (text: string) => {
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
      event("content_block_stop", { index: 0 });
    },
    tool: (id: string, name: string, args: string) => {
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id, name, input: {} } });
      event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: args } });
      event("content_block_stop", { index: 0 });
    },
    finish: (stop_reason: string) => {
      event("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 4 } });
      event("message_stop", {}); response.end();
    },
  };
}
async function fauxResponses(root: string) {
  const requests: ModelRequest[] = [], returnedTools: Record<string, unknown>[] = [], errors: string[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => {
      const captured: ModelRequest = { method: request.method, url: request.url, raw, body: {}, rawSse: "" };
      requests.push(captured);
      try {
        if (modelProtocol !== "responses") {
          const expectedUrl = modelProtocol === "messages" ? "/v1/messages?beta=true" : "/v1/chat/completions";
          if (request.method !== "POST" || request.url !== expectedUrl) throw new Error(`not the genuine ${modelProtocol} API route: ${request.url}`);
          const parsed = captured.body = record(JSON.parse(raw));
          if (parsed.model !== modelId || parsed.stream !== true || !Array.isArray(parsed.messages) || "input" in parsed) throw new Error(`not a ${modelProtocol} streaming request`);
          // Exact frozen Messages/chat body-reader logic. Messages results are
          // user content blocks; chat results are role=tool, never Responses input.
          const messages = parsed.messages.map(record), wireLatest = messages.at(-1) ?? {};
          const result = modelProtocol === "messages" && wireLatest.role === "user" && Array.isArray(wireLatest.content)
            ? wireLatest.content.map(record).find(part => part.type === "tool_result") : undefined;
          const latest = result ? { role: "tool", tool_call_id: result.tool_use_id, content: contentText(result.content) } : wireLatest;
          const text = messages.filter(message => message.role === "user").map(message => contentText(message.content)).join("\n");
          if (!text.includes("Responses proof first")) throw new Error("unexpected model input");
          const index = text.includes("Responses proof second") ? 1 : 0;
          const returned = latest.role === "tool";
          if (returned) returnedTools.push({ type: "function_call_output", call_id: latest.tool_call_id, output: contentText(latest.content) });
          const sequence = requests.length;
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const anthropic = modelProtocol === "messages" ? anthropicStream(response, captured, sequence) : undefined;
          const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
            if (anthropic) {
              if (typeof delta.content === "string") anthropic.text(delta.content);
              for (const call of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).map(record)) {
                const fn = record(call.function); anthropic.tool(String(call.id), String(fn.name), String(fn.arguments));
              }
            } else {
              const bytes = `data: ${JSON.stringify({ id: `local-faux-${sequence}`, object: "chat.completion.chunk", model: modelId, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
              captured.rawSse += bytes; response.write(bytes);
            }
          };
          const finish = (reason: string) => {
            if (anthropic) { anthropic.finish(reason === "tool_calls" ? "tool_use" : "end_turn"); return; }
            chunk({}, reason);
            const bytes = `data: ${JSON.stringify({ id: `local-faux-${sequence}`, choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`;
            captured.rawSse += bytes; response.end(bytes);
          };
          if (returned) {
            chunk({ role: "assistant", content: `Pi consumed Responses result ${nativeId(index)}` });
            if (index === 1) { held.add(response); response.once("close", () => held.delete(response)); return; }
            finish("stop");
          } else {
            chunk({ role: "assistant", tool_calls: [{ index: 0, id: nativeId(index), type: "function", function: { name: tools[index], arguments: "{}" } }] });
            finish("tool_calls");
          }
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") throw new Error("not the Responses API route");
        const body = captured.body = record(JSON.parse(raw));
        if (body.model !== "gpt-5.4" || body.stream !== true || !Array.isArray(body.input) || "messages" in body) throw new Error("not a Responses streaming request");
        const input = body.input.map(record), latest = input.at(-1) ?? {};
        const text = input.filter(item => item.role === "user").map(item => JSON.stringify(item.content)).join("\n");
        if (!text.includes("Responses proof first")) throw new Error("unexpected model input");
        const index = text.includes("Responses proof second") ? 1 : 0;
        const returned = latest.type === "function_call_output";
        if (returned) returnedTools.push(structuredClone(latest));
        const id = `resp_local_${requests.length}`;
        const base = { id, object: "response", created_at: 1, model: "gpt-5.4", status: "in_progress", output: [], error: null, incomplete_details: null };
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        let sequence_number = 0;
        const emit = (type: string, payload: Record<string, unknown>) => {
          const bytes = `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence_number++, ...payload })}\n\n`;
          captured.rawSse += bytes; response.write(bytes);
        };
        // Official Responses SSE: item.id and call_id are distinct components.
        // https://developers.openai.com/api/docs/guides/function-calling
        // https://developers.openai.com/api/reference/resources/responses/streaming-events
        emit("response.created", { response: base });
        emit("response.in_progress", { response: base });
        let finalItem: Record<string, unknown>;
        if (!returned) {
          const item = { type: "function_call", id: itemIds[index], call_id: callIds[index], name: tools[index], arguments: "", status: "in_progress" };
          emit("response.output_item.added", { output_index: 0, item });
          emit("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: "{}" });
          emit("response.function_call_arguments.done", { output_index: 0, item_id: item.id, arguments: "{}" });
          finalItem = { ...item, arguments: "{}", status: "completed" };
        } else {
          const item = { type: "message", id: `msg_local_${requests.length}`, role: "assistant", content: [], status: "in_progress" };
          const text = `Pi consumed Responses result ${callIds[index]}`;
          const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
          emit("response.output_item.added", { output_index: 0, item });
          emit("response.content_part.added", { output_index: 0, item_id: item.id, content_index: 0, part });
          emit("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text, logprobs: [] });
          // Keep run two genuinely streaming after its full tool result reached
          // native Pi/model history. Stop must interrupt actual pending work.
          if (index === 1) { held.add(response); response.once("close", () => held.delete(response)); return; }
          emit("response.output_text.done", { output_index: 0, item_id: item.id, content_index: 0, text, logprobs: [] });
          emit("response.content_part.done", { output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text } });
          finalItem = { ...item, status: "completed", content: [{ ...part, text }] };
        }
        emit("response.output_item.done", { output_index: 0, item: finalItem });
        emit("response.completed", { response: { ...base, status: "completed", output: [finalItem], usage: { input_tokens: 7, output_tokens: 4, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
        response.end();
      } catch (error) { errors.push(String(error)); response.destroy(error as Error); }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("faux Responses did not bind");
  return { url: `http://127.0.0.1:${address.port}${modelProtocol === "messages" ? "" : "/v1"}`, requests, returnedTools, errors, heldCount: () => held.size, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    for (const [index, captured] of requests.entries()) {
      await writeFile(join(root, `model-${index + 1}.request.json`), captured.raw);
      await writeFile(join(root, `model-${index + 1}.response.sse`), captured.rawSse);
    }
  } };
}
function brokerAddress(agentDirectory: string): string {
  const managed = record(record(record(JSON.parse(readFileSync(join(agentDirectory, "models.json"), "utf8"))).providers).paperclip);
  const address = managed.baseUrl;
  if (typeof address !== "string") throw new Error("managed broker address missing");
  expect(new URL(address).hostname).toBe("127.0.0.1");
  return address; // Never serialize the broker capability/apiKey.
}
async function assertBrokerClosed(address: string) {
  const url = new URL(address);
  const code = await within("broker physical close", new Promise<string>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("broker close probe timed out")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("broker still accepts connections")); });
    socket.once("error", error => resolve((error as NodeJS.ErrnoException).code ?? String(error)));
  }));
  expect(code).toBe("ECONNREFUSED");
}
function journalAt(root: string) {
  const file = join(root, "pi-runtime", `${normalizedSessionId}.jsonl`);
  return readFileSync(file, "utf8").trim().split("\n").map(line => record(JSON.parse(line)));
}

it.skipIf(process.platform !== "linux" || !pi)(`real runnerd/Pi ${modelProtocol} preserves native tool IDs and complete results across two runs with pending Stop`, async () => {
  const proofPath = process.env.PI_PROOF_PATH;
  const evidenceDirectory = proofPath ? dirname(proofPath) : tmpdir();
  await mkdir(evidenceDirectory, { recursive: true });
  const root = await mkdtemp(join(evidenceDirectory, "runnerd-pi-responses-ids-"));
  if (process.env.PI_DEBUG_ROOT_PATH) await writeFile(process.env.PI_DEBUG_ROOT_PATH, `${root}\n`);
  const runnerBinary = process.env.PAPERCLIP_RUNNERD_PATH ?? defaultCapabilityRunnerdBinary();
  const sourcePaths = [
    "src/live/runnerd-pi-responses-tool-ids.integration.test.ts", "src/live/runnerd-codex-transport.ts", "src/cli/pi-rpc-app-server-proxy.ts",
    "src/drivers/pi/pi-rpc-driver.ts", "src/drivers/pi/extension/index.ts", "src/drivers/pi/pi-bind-protocol.ts", "src/drivers/pi/pi-rpc-callback-server.ts",
    "src/drivers/pi/pi-native-config.ts", "src/drivers/acpx/pi-provider-loopback.ts", "src/drivers/provider-loopback/broker.ts", "src/drivers/provider-loopback/responses.ts", "src/drivers/provider-loopback/messages.ts", "src/drivers/provider-loopback/chat.ts",
  ];
  const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, digest(path)]));
  const proof: Record<string, unknown> = {
    schema: "paperclip.pi.responses-tool-ids.proof.v3", status: "running", phase: "setup", root, modelProtocol,
    source: `real runnerd -> production CJS proxy -> PiRpcDriver -> owned extension -> installed Pi 1.5.2 -> managed ${modelProtocol} broker -> local faux model`,
    coverageGaps: ["No external model/credentials/real server API authorization. Collision and stale-owner attacks are separate proxy unit evidence. Production facade does not expose raw get_state; exact native thinking is independently asserted from the real Pi journal and wire."],
    thinkingPolicy: modelProtocol === "messages" ? "native requested/admitted/journal xhigh; Pi 1.5.2 budget-based enabled thinking min(16384, max_tokens-1024), positive; not adaptive max effort" : `native xhigh; ${modelProtocol} wire xhigh`,
    supersededUnitExpectation: "Per-RPC uniqueness for identical native IDs is intentionally superseded by stable origin/native-ID aliases, preserving Rust durable replay/conflict semantics.",
    selectedModel: model, requestedThinkingLevel: "xhigh", credentialMode: "broker", upstreamAuth: "none",
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runnerdSha256: digest(runnerBinary), nodeSha256: digest(process.execPath), sourceHashes, retainedRoot: true,
  };
  await writeFile(join(root, "setup-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
  const runtime = await productionRuntime(root);
  Object.assign(proof, { piVersion: "1.5.2", piSha256: digest(runtime.executable), proxySha256: digest(runtime.proxy), extensionSha256: digest(runtime.extension), installedClosure: runtime.closure });
  expect(proof.piSha256, "exact installed Pi 1.5.2 CLI pin").toBe("sha256:e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774");
  expect(Object.fromEntries(sourcePaths.map(path => [path, digest(path)])), "source frozen during bundle").toEqual(sourceHashes);
  const workspace = join(root, "workspace"), agentDirectory = join(root, "pi-agent");
  await mkdir(workspace); await mkdir(agentDirectory);
  const faux = await fauxResponses(root);
  const environment = { PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: faux.url,
    PAPERCLIP_AI_PROVIDER_PROTOCOL: modelProtocol, PAPERCLIP_AI_PROVIDER_AUTH: "none", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker" };
  // No models.json shortcut: production selects and admits the real managed model.
  expect(usesPiProviderLoopback(model, environment)).toBe(true);
  const diagnostics: string[] = [], semanticCalls: Record<string, unknown>[] = [], notifications: CodexRpcNotification[] = [];
  const { transport } = createRunnerdCodexTransport({
    provider: "pi_rpc", runnerBinary, stateDirectory: join(root, "runner-state"), sourceCodexHome: "",
    providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath),
    piCommand: runtime.executable, piCommandSha256: digest(runtime.executable), piProxyPath: runtime.proxy, piProxySha256: digest(runtime.proxy),
    piRuntimeDirectory: join(root, "pi-runtime"), piRpcThinkingLevel: "xhigh", baseInstructions: "Responses composite ID proof.",
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    prpIdentity: { runnerInstanceId: "runner-pi-responses-ids", environmentLeaseId: "lease-pi-responses-ids", runId: runIds[0], normalizedSessionId, turnId: "turn-pi-responses-1", itemId: "item-pi-responses-1" },
    environment, onDiagnostic: message => { diagnostics.push(message); },
  });
  let runnerPid: number | null = null, owned: ProcessIdentity[] = [], primaryError: unknown, cleanupError: unknown;
  const pids: ProcessIdentity[] = [], turnIds: string[] = [], sessionIds: string[] = [], brokers: string[] = [];
  const iterator = transport.notifications()[Symbol.asyncIterator]();
  const until = async (predicate: (notification: CodexRpcNotification) => boolean) => {
    for (;;) {
      const next = await within("Responses notification", iterator.next());
      if (next.done) throw new Error("runnerd notifications ended before tool result delivery");
      notifications.push(next.value);
      if (next.value.method === "turn/failed") throw new Error(`runnerd turn failed: ${JSON.stringify(next.value.params)}`);
      if (predicate(next.value)) return;
    }
  };
  transport.setServerRequestHandler(async request => {
    const index = semanticCalls.length;
    semanticCalls.push(structuredClone(request.params));
    expect(index, "only intended calls reach authority").toBeLessThan(2);
    expect(request.method).toBe("item/tool/call");
    expect(request.params).toMatchObject({ tool: tools[index], arguments: {}, turnId: turnIds[index] });
    expect(request.params.callId, "bounded runnerd identifier, not Pi composite").toMatch(/^[a-zA-Z0-9._:-]+$/);
    expect(String(request.params.callId).length).toBeLessThanOrEqual(160);
    if (modelProtocol === "responses") expect(request.params.callId).not.toBe(nativeId(index));
    else expect(request.params.callId, "ordinary native IDs pass unchanged").toBe(nativeId(index));
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(results[index]) }] };
  });
  try {
    proof.phase = "thread-start-native-xhigh-admission";
    const opened = await within("thread start", transport.request("thread/start", { cwd: workspace, model, dynamicTools: dynamicTools() }));
    const sessionId = record(opened.thread).sessionId;
    expect(sessionId).toBeTypeOf("string"); expect(sessionId).not.toBe(normalizedSessionId);
    proof.admittedNativeSessionId = sessionId;
    runnerPid = transport.processInfo!().pid;
    expect(runnerPid).not.toBeNull();
    owned = [processIdentity(runnerPid!)!, ...descendants(runnerPid!)];
    expect((await stat(join(agentDirectory, "models.json"))).mode & 0o777).toBe(0o600);
    const managed = record(record(record(JSON.parse(readFileSync(join(agentDirectory, "models.json"), "utf8"))).providers).paperclip);
    const managedModel = record((managed.models as unknown[])[0]);
    proof.managedModel = { id: managedModel.id, reasoning: managedModel.reasoning, thinkingLevelMap: managedModel.thinkingLevelMap, api: managed.api };
    expect(managedModel.id).toBe(modelId); expect(managedModel.reasoning).toBe(true);
    expect(record(managedModel.thinkingLevelMap).xhigh).toBe("xhigh");
    for (const index of [0, 1]) {
      proof.phase = `run-${index + 1}`;
      if (index === 1) await within("attach second run", transport.attachRun!({ runId: runIds[1], turnId: "turn-pi-responses-2", itemId: "item-pi-responses-2",
        currentRunGrant: { instructions: "Responses composite ID second run.", runtimeContext: null }, dynamicTools: dynamicTools() }));
      pids.push(piIdentity(runnerPid!));
      const accepted = await within("turn start", transport.request("turn/start", { input: [{ type: "text", text: index === 0 ? "Responses proof first: get_task_context" : "Responses proof second: list_agents" }] }));
      const turnId = String(record(accepted.turn).id); turnIds.push(turnId);
      brokers.push(brokerAddress(agentDirectory));
      await until(event => index === 0 ? event.method === "turn/completed" && event.params.turnId === turnId
        : event.method === "item/agentMessage/delta" && String(event.params.delta).includes("Pi consumed Responses result"));
      expect(semanticCalls, "semantic authority actually receives each call").toHaveLength(index + 1);
      expect(faux.returnedTools).toHaveLength(index + 1);
      expect(JSON.parse(String(faux.returnedTools[index]!.output)), "full semantic result reaches model").toEqual(results[index]);
      const replay = wireHistory(faux.requests[index * 2 + 1]!.body);
      // Native Pi retains the exact composite; its SDK owns wire-history ID
      // normalization. Require a consistent non-surrogate call/output pair,
      // never an unsupported original fc item-ID or call_x_fc_y replay.
      for (let prior = 0; prior <= index; prior++) {
        const calls = replay.filter(item => item.type === "function_call" && item.name === tools[prior]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.arguments).toBe("{}");
        if (modelProtocol === "responses") {
          expect(calls[0]!.call_id).toBeTypeOf("string");
          expect(String(calls[0]!.call_id).trim(), "nonempty SDK history call ID").not.toBe("");
        } else expect(calls[0]!.call_id).toBe(nativeId(prior));
        const outputs = replay.filter(item => item.type === "function_call_output" && item.call_id === calls[0]!.call_id);
        expect(outputs).toHaveLength(1);
        expect(JSON.parse(String(outputs[0]!.output))).toEqual(results[prior]);
        if (modelProtocol === "responses") expect(replay.some(item => item.call_id === semanticCalls[prior]!.callId), "proxy surrogate never leaks into model history").toBe(false);
      }
      const journal = journalAt(root);
      expect(journal[0]!.id).toBe(sessionId);
      sessionIds.push(String(journal[0]!.id));
      const messages = journal.map(entry => record(entry.message));
      const nativeCalls = messages.filter(message => message.role === "assistant").flatMap(message => (Array.isArray(message.content) ? message.content : []).map(record)).filter(part => part.type === "toolCall" && part.id === nativeId(index));
      expect(nativeCalls, "native journal retains EXACT original call ID/name/arguments").toEqual([expect.objectContaining({ id: nativeId(index), name: tools[index], arguments: {} })]);
      const toolResults = messages.filter(message => message.role === "toolResult" && message.toolCallId === nativeId(index));
      expect(toolResults, "native journal retains exact original toolCallId").toHaveLength(1);
      expect(JSON.parse(String(record((toolResults[0]!.content as unknown[])[0]).text))).toEqual(results[index]);
      if (modelProtocol === "responses") expect(JSON.stringify(messages)).not.toContain(String(semanticCalls[index]!.callId));
      const thinkingChanges = journal.filter(entry => entry.type === "thinking_level_change");
      expect(thinkingChanges.length, "actual native journal thinking entries exist").toBeGreaterThan(0);
      expect(thinkingChanges.every(entry => entry.thinkingLevel === "xhigh"), "ALL native effective thinking entries retain exact xhigh").toBe(true);
      for (const request of faux.requests) {
        expect(request.body.model).toBe(modelId); expect(request.body.stream).toBe(true);
        if (modelProtocol === "messages") {
          expect(request.url, "EVERY native Messages query survives production broker").toBe("/v1/messages?beta=true");
          expect(record(request.body.thinking).type).toBe("enabled");
          expect(record(request.body.thinking).budget_tokens).toBe(Math.min(16384, Number(request.body.max_tokens) - 1024));
          expect(Number(record(request.body.thinking).budget_tokens)).toBeGreaterThan(0);
        } else if (modelProtocol === "chat") expect(request.body.reasoning_effort, "actual chat wire effort").toBe("xhigh");
        else expect(record(request.body.reasoning).effort, "actual Responses wire effort").toBe("xhigh");
        const definitions = (request.body.tools as unknown[]).map(record).map(definition => modelProtocol === "chat" ? record(definition.function) : definition);
        for (const tool of dynamicTools()) {
          const matching = definitions.filter(definition => definition.name === tool.name);
          if (modelProtocol === "messages") {
            const expectedSchema = { ...tool.inputSchema };
            // Pi's genuine Anthropic SDK omits only this unsupported false
            // keyword. Retain every other canonical field exactly, not a
            // recursive sanitizer or a permissive schema-subset assertion.
            const normalized = matching.map(definition => {
              const actualSchema = { ...record(definition.input_schema) };
              if (tool.inputSchema.additionalProperties === false && "additionalProperties" in actualSchema) {
                expect(actualSchema.additionalProperties, "Messages must never weaken canonical false to true").toBe(false);
                delete actualSchema.additionalProperties;
              }
              return { ...definition, input_schema: actualSchema };
            });
            if (expectedSchema.additionalProperties === false) delete expectedSchema.additionalProperties;
            expect(normalized).toEqual([expect.objectContaining({ name: tool.name, input_schema: expectedSchema, eager_input_streaming: true })]);
          } else expect(matching).toEqual([expect.objectContaining({ parameters: tool.inputSchema })]);
        }
      }
      pids.push(piIdentity(runnerPid!));
      if (index === 0) await assertBrokerClosed(brokers[index]!);
    }
    expect(new Set(pids.map(identity => `${identity.pid}:${identity.started}`)).size).toBe(1);
    expect(new Set(sessionIds)).toEqual(new Set([sessionId]));
    expect(new Set(turnIds).size).toBe(2);
    expect(faux.requests).toHaveLength(4); expect(faux.errors).toEqual([]);
    expect(faux.heldCount(), "actual pending stream at Stop").toBe(1);
    proof.pendingStop = { turnId: turnIds[1], pendingModelStreams: faux.heldCount() };
    proof.phase = "pending-stop";
    await within("pending interrupt", transport.request("turn/interrupt", { turnId: turnIds[1] }));
    proof.status = `passed-${modelProtocol}-native-ids-two-runs-pending-stop`;
  } catch (error) { primaryError = error; proof.status = "failed"; proof.error = String(error); proof.errorStack = error instanceof Error ? error.stack : undefined; }
  finally {
    if (runnerPid === null) runnerPid = transport.processInfo?.().pid ?? null;
    if (runnerPid !== null) for (const identity of [processIdentity(runnerPid), ...descendants(runnerPid)]) if (identity && !owned.some(prior => prior.pid === identity.pid && prior.started === identity.started)) owned.push(identity);
    await writeFile(join(root, "owned-before-stop.json"), `${JSON.stringify(owned, null, 2)}\n`);
    try {
      await within("physical native Stop", transport.close("responses-id-proof-stop"));
      for (const address of brokers) await assertBrokerClosed(address);
      const groups = new Set(owned.map(identity => identity.pgid));
      expect(groups.has(processIdentity(process.pid)!.pgid), "never stop test process group").toBe(false);
      await vi.waitFor(() => {
        for (const before of owned) {
          const after = processIdentity(before.pid);
          expect(after === null || after.started !== before.started, `owned PID ${before.pid} absent`).toBe(true);
        }
        expect(processes().filter(identity => groups.has(identity.pgid)), "full native PGIDs absent").toEqual([]);
      }, { timeout: 5_000, interval: 50 });
      proof.physicalRetirementVerified = true;
    } catch (error) { cleanupError = error; proof.cleanupError = String(error); proof.status = "failed"; }
    finally {
      await faux.close();
      Object.assign(proof, { runnerPid, semanticCalls, modelRequests: faux.requests, returnedTools: faux.returnedTools, fauxErrors: faux.errors, piProcesses: pids, turnIds, nativeSessionIds: sessionIds, brokers, diagnostics,
        nativeThinkingChanges: existsSync(join(root, "pi-runtime", `${normalizedSessionId}.jsonl`)) ? journalAt(root).filter(entry => entry.type === "thinking_level_change") : [],
        sourceHashesAfter: Object.fromEntries(sourcePaths.map(path => [path, digest(path)])), ownedAfterCleanup: owned.map(before => ({ before, after: processIdentity(before.pid) })) });
      await writeFile(join(root, "diagnostics.raw.txt"), diagnostics.join("\n"));
      await writeFile(join(root, "notifications.json"), `${JSON.stringify(notifications, null, 2)}\n`);
      await writeFile(join(root, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
      if (proofPath) await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "Responses proof and cleanup failed");
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}, 110_000);
