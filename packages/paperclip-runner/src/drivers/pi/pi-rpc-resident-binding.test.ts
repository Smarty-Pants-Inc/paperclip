import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer as httpServer, type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindContent, sendPiBindRequest, sendPiToolRequest, validateBindingConfig, type PiBindCommand } from "./pi-bind-protocol.js";
import { PiRpcDriver, type PiRpcDriverOptions, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcCommandError, PiRpcTransport, type PiRpcExtensionUiResponseInput, type PiRpcRecord, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: revocable model capabilities, receipt admission, and callback refusal
// are trust boundaries. These tests exercise the actual driver with real brokers/IPC.
const sessions: PiRpcHarnessSession[] = [];
const peers: Server[] = [];
const httpPeers: HttpServer[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all(peers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(httpPeers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  // Do not delete roots: native JSONL and first-failure evidence must survive.
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const admission = ["get_state", "set_model", "get_available_thinking_levels", "set_thinking_level", "get_state"];
const tool = (name: string) => ({ name, description: `Read ${name}`, inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } });
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
class FakeTransport {
  pid = 42; exited = false; closed = false;
  commands: string[] = [];
  uiResponses: PiRpcExtensionUiResponseInput[] = [];
  order: string[] = [];
  ready: Promise<void> = Promise.resolve();
  mismatch = false;
  effortMismatch = false;
  thinkingLevel = "off";
  promptDisposition = "started";
  rejectPrompt = false;
  #records: PiRpcRecord[] = [];
  #wake?: (value: IteratorResult<PiRpcRecord>) => void;
  async request(type: string, _params: PiRpcRecord = {}): Promise<PiRpcRecord> {
    await this.ready; this.commands.push(type); this.order.push(type);
    if (type === "prompt" && this.rejectPrompt) throw new PiRpcCommandError(type, { success: false, error: "rejected before acceptance" });
    const model = { provider: "paperclip", id: this.mismatch ? "wrong" : "faux" };
    return { success: true, data: type === "get_state" ? { sessionId: "native-session", model, thinkingLevel: this.effortMismatch ? "high" : this.thinkingLevel, isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "get_available_models" ? { models: [{ ...model, name: "Fixture", api: "openai-completions" }] }
      : type === "set_model" ? model : type === "get_available_thinking_levels" ? { levels: [this.thinkingLevel] }
      : type === "prompt" ? { disposition: this.promptDisposition } : undefined };
  }
  async sendExtensionUiResponse(input: PiRpcExtensionUiResponseInput): Promise<void> {
    if (this.closed || this.exited) throw new Error("Pi RPC transport is closed");
    // Native UI responses are one-way writes, not correlated request() RPCs.
    this.uiResponses.push(structuredClone(input));
  }
  send(value: PiRpcRecord) { if (this.#wake) { const wake = this.#wake; this.#wake = undefined; wake({ value, done: false }); } else this.#records.push(value); }
  events(): AsyncIterable<PiRpcRecord> { return { [Symbol.asyncIterator]: () => ({ next: async () => {
    const value = this.#records.shift(); if (value) return { value, done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise<IteratorResult<PiRpcRecord>>(resolve => { this.#wake = resolve; });
  } }) }; }
  async close() { this.closed = this.exited = true; this.#wake?.({ value: undefined, done: true }); this.#wake = undefined; }
}
async function faux() {
  const requests: Array<Record<string, any>> = [];
  const server = httpServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer upstream-binding-canary") { res.writeHead(401).end(); return; }
      requests.push(JSON.parse(body)); const n = requests.length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [{ choices: [{ index: 0, delta: { content: `reply ${n}` }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }]) res.write(`data: ${JSON.stringify({ id: `faux-${n}`, object: "chat.completion.chunk", ...chunk })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); httpPeers.push(server);
  const address = server.address(); if (!address || typeof address === "string") throw new Error("faux bind failed");
  return { requests, environment: { PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "upstream-binding-canary" } };
}
async function fixture(options: Partial<PiRpcDriverOptions> = {}, fault?: "stale" | "lost" | "begin-lost") {
  const root = await mkdtemp(join(tmpdir(), "pi-resident-binding-")); const workspace = join(root, "workspace"); await mkdir(workspace);
  const upstream = await faux(); const transport = new FakeTransport(); const ipc: PiBindCommand[] = [];
  transport.thinkingLevel = options.piRpcThinkingLevel ?? "off";
  let launch!: PiRpcTransportOptions;
  const driver = new PiRpcDriver({ model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), systemInstructions: "initial π", dynamicTools: [tool("old_tool")], runtimeContext: { revision: 1 }, startupTimeoutMs: 120,
    environment: { ...upstream.environment, PI_CODING_AGENT_DIR: join(root, "agent") }, ...options,
    transportFactory: opts => {
      launch = opts;
      if (opts.env?.PAPERCLIP_PI_BIND_SOCKET) {
        const server = createServer(socket => {
          sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => undefined);
          let buffer = ""; socket.setEncoding("utf8"); socket.on("data", chunk => {
            buffer += chunk; if (!buffer.endsWith("\n")) return;
            const request = JSON.parse(buffer) as PiBindCommand; ipc.push(request); transport.order.push(`ipc:${request.type}`);
            if ((request.type === "bind" && fault === "lost") || (request.type === "begin_turn" && fault === "begin-lost")) return;
            const receipt = request.type === "bind" ? { schema: 1, nonce: request.nonce, sessionId: request.sessionId, type: "bind", epoch: fault === "stale" ? request.epoch - 1 : request.epoch, runId: request.runId, provider: request.provider.name, model: request.model, thinkingLevel: request.thinkingLevel, ...bindContent(request) }
              : request.type === "stop_children" ? { schema: 1, type: request.type, nonce: request.nonce, sessionId: request.sessionId, settled: [], uncertain: [] }
              : request.type === "park_ready" ? { schema: 1, type: request.type, nonce: request.nonce, sessionId: request.sessionId, ready: true, reasons: [] }
              : { ...request, ack: true };
            socket.end(`${JSON.stringify(receipt)}\n`);
          });
        }); peers.push(server);
        transport.ready = new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.env!.PAPERCLIP_PI_BIND_SOCKET!, resolve); });
      }
      return transport as unknown as PiRpcTransport;
    },
  });
  const session = await driver.openSession({ runId: "run-a", normalizedSessionId: "host-session", workingDirectory: workspace }) as PiRpcHarnessSession; sessions.push(session);
  const events: PrpEvent[] = []; void (async () => { for await (const event of session.events()) events.push(event); })();
  return { root, session, transport, launch, ipc, events, ...upstream };
}
async function finish(f: Awaited<ReturnType<typeof fixture>>, n = 1) {
  f.transport.send({ type: "agent_start" });
  const message = { role: "assistant", responseId: `m-${n}`, timestamp: n, provider: "paperclip", model: "faux", content: [{ type: "text", text: "answer" }], stopReason: "stop" };
  f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message }); f.transport.send({ type: "agent_settled", aborted: false });
  await vi.waitFor(() => expect(f.events.some(event => event.eventType === "turn.completed" && event.turnId === f.events.filter(event => event.eventType === "turn.started").at(-1)?.turnId)).toBe(true));
}
async function revoked(provider: { baseUrl: string; apiKey: string }) {
  // A 401, timeout or unrelated network failure is not physical revocation.
  return fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "faux", messages: [] }) }).then(() => false, error => error?.cause?.code === "ECONNREFUSED");
}

describe("resident Pi model binding", () => {
  it("boots a 200 KiB binding through a private file instead of an E2BIG environment entry", async () => {
    const large = { ...tool("large"), inputSchema: { type: "object", properties: { body: { type: "string", description: "x".repeat(200 * 1024) } } } };
    const f = await fixture({ dynamicTools: [large] });
    const path = f.launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE;
    expect(path).toBe(join(dirname(f.launch.env!.PAPERCLIP_PI_BIND_SOCKET!), "initial.json"));
    expect(f.launch.env!.PAPERCLIP_PI_BIND_INITIAL).toBeUndefined();
    expect((await stat(path!)).mode & 0o777).toBe(0o600);
    const initial = JSON.parse(await readFile(path!, "utf8"));
    expect(initial.tools).toEqual([large]);
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { env: f.launch.env });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
    await f.session.close();
    await expect(stat(path!)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("normalizes dynamic tools independently and maps native aliases back to controller names", async () => {
    const original = { name: "issues.create", description: "Create\n\tissue", inputSchema: { properties: {} } };
    const handler = vi.fn(async (_call: { tool: string }) => ({ content: [{ type: "text", text: "created" }], details: {} }));
    const f = await fixture({ dynamicTools: [original, { name: "empty", description: "", inputSchema: { type: "object" } },
      { name: "long", description: "😀".repeat(3000), inputSchema: { type: "object" } },
      { name: "bad", description: "bad", inputSchema: null }], dynamicToolHandler: handler });
    const initial = JSON.parse(await readFile(f.launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
    expect(validateBindingConfig(initial)).toBe(true);
    expect(initial.tools).toHaveLength(3);
    expect(initial.tools[0]).toMatchObject({ description: "Create issue", inputSchema: { type: "object", properties: {} } });
    expect(initial.tools[0].name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/u);
    expect(initial.tools[1].description).toBe("empty");
    expect(Buffer.byteLength(initial.tools[2].description)).toBeLessThanOrEqual(8192);
    expect(initial.tools[2].description).not.toContain("�");
    expect(original).toEqual({ name: "issues.create", description: "Create\n\tissue", inputSchema: { properties: {} } });
    await vi.waitFor(() => expect(f.events.some(event => event.eventType === "harness.diagnostic" && event.payload.code === "pi_dynamic_tool_dropped")).toBe(true));
    const turn = await f.session.startTurn({ message: { role: "user", text: "create" } });
    f.transport.send({ type: "agent_start" });
    f.transport.send({ type: "tool_execution_start", toolCallId: "mapped", toolName: initial.tools[0].name, args: {} });
    const result = await sendPiToolRequest(initial.toolSocketPath, { schema: 1, type: "tool_call", nonce: "mapped", sessionId: initial.sessionId,
      origin: { epoch: initial.epoch, runId: initial.runId, turnId: turn.turnId }, toolCallId: "mapped", tool: initial.tools[0].name, arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "created" }]);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ tool: "issues.create" });
    f.transport.send({ type: "agent_settled", aborted: true });
    await vi.waitFor(() => expect(f.events.some(event => event.eventType === "turn.cancelled")).toBe(true));
    await f.session.attachRun({ runId: "run-b" });
    expect(f.ipc.find(command => command.type === "bind")).toMatchObject({ tools: initial.tools });
  });
  it("keeps 128 usable tools and diagnoses an oversized catalog instead of rejecting the binding", async () => {
    const f = await fixture({ dynamicTools: Array.from({ length: 129 }, (_, i) => tool(`tool_${i}`)) });
    const initial = JSON.parse(await readFile(f.launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
    expect(initial.tools).toHaveLength(128);
    expect(initial.tools.at(-1).name).toBe("tool_127");
    await vi.waitFor(() => expect(f.events.some(event => event.eventType === "harness.diagnostic" && event.payload.code === "pi_dynamic_tool_limit")).toBe(true));
    await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
  });
  it("uses stable distinct aliases independent of catalog order and isolates unserializable schemas", async () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const tools = [tool("issues.create"), tool("issues_create"), tool("9/other"), { ...tool("circular"), inputSchema: circular }];
    const f = await fixture({ dynamicTools: tools });
    const initial = JSON.parse(await readFile(f.launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
    expect(initial.tools).toHaveLength(3);
    expect(new Set(initial.tools.map((entry: { name: string }) => entry.name)).size).toBe(3);
    await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
    await f.session.attachRun({ runId: "run-b", dynamicTools: tools.slice(0, 3).reverse() });
    const bind = f.ipc.find(command => command.type === "bind");
    expect(bind).toMatchObject({ tools: initial.tools.slice().reverse() });
  });
  it.each(["handled", "queued", "started", "rejected"])("keeps the resident session after %s prompt disposition and scopes settlement to that turn (K4)", async disposition => {
    const f = await fixture();
    f.transport.promptDisposition = disposition;
    f.transport.rejectPrompt = disposition === "rejected";
    if (disposition === "rejected") {
      await expect(f.session.startTurn({ message: { role: "user", text: "rejected" } })).rejects.toThrow("rejected before acceptance");
      expect(f.events.filter(event => event.eventType === "turn.failed")).toHaveLength(1);
    } else {
      const turn = await f.session.startTurn({ message: { role: "user", text: "one" } });
      if (disposition === "handled") {
        expect(f.events.filter(event => event.eventType === "turn.completed")).toMatchObject([
          { turnId: turn.turnId, payload: { outcome: "handled", modelOutput: false } },
        ]);
        expect(f.events.some(event => event.eventType.startsWith("item."))).toBe(false);
      } else {
        expect(f.events.some(event => event.eventType === "turn.completed")).toBe(false);
        await finish(f);
      }
    }
    expect(f.transport.closed).toBe(false);
    expect((await f.session.snapshot()).binding?.preparedTurnId).toBeNull();
    f.transport.promptDisposition = "started"; f.transport.rejectPrompt = false;
    await f.session.startTurn({ message: { role: "user", text: "next" } }); await finish(f, 2);
    expect(f.ipc.filter(command => command.type === "bind")).toHaveLength(1);
    expect(f.ipc.filter(command => command.type === "begin_turn")).toHaveLength(1);
    expect(f.ipc.some(command => command.type === "stop_children")).toBe(false);
    expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
  });
  it.each(["xhigh", "max"] as const)("carries only admitted %s metadata through initial bind and resident rebind", async level => {
    const f = await fixture({ piRpcThinkingLevel: level });
    const models = JSON.parse(await readFile(join(f.launch.env!.PI_CODING_AGENT_DIR!, "models.json"), "utf8"));
    const expected = { id: "faux", input: ["text"], contextWindow: 128000, maxTokens: 8192, reasoning: true, thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
    expect(models.providers.paperclip.models).toEqual([expected]);
    await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
    await f.session.attachRun({ runId: "run-b" });
    const bind = f.ipc.find(command => command.type === "bind");
    expect(bind).toMatchObject({ type: "bind", thinkingLevel: level, provider: { models: [expected] } });
  });
  it("bootstraps nonsecret INITIAL + merged models before spawn; turn 1 has zero bind/begin IPC", async () => {
    const f = await fixture();
    expect(f.launch.args).not.toContain("--no-extensions"); expect(f.launch.args).toContain("--extension");
    expect(f.launch.args).toContain("--append-system-prompt");
    const instructionFile = f.launch.args![f.launch.args!.indexOf("--append-system-prompt") + 1]!;
    expect((await stat(instructionFile)).mode & 0o777).toBe(0o600);
    expect(await readFile(instructionFile, "utf8")).toContain("initial π");
    const initial = JSON.parse(await readFile(f.launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
    expect(initial).toMatchObject({ schema: 1, sessionId: "host-session", epoch: 1, runId: "run-a", model: "paperclip/faux", thinkingLevel: "off", tools: [tool("old_tool")] });
    expect(initial.instructions).toContain("initial π"); expect(initial.instructions).toContain('"revision":1');
    expect(JSON.stringify(initial)).not.toContain("upstream-binding-canary");
    expect(f.launch.env!.PAPERCLIP_AI_PROVIDER_KEY).toBeUndefined();
    const socket = f.launch.env!.PAPERCLIP_PI_BIND_SOCKET!; expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
    expect((await stat(dirname(socket))).mode & 0o777).toBe(0o700);
    const turn = await f.session.startTurn({ message: { role: "user", text: "one" } }); expect(turn.turnId).toBe(initial.turnId);
    expect(f.ipc).toEqual([]); expect(f.transport.commands).toEqual([...admission, "get_available_models", ...admission, "prompt"]);
    await finish(f);
  });
  it("keeps INITIAL for initial/same-context attach and post-claim admission, without bind/begin IPC", async () => {
    const f = await fixture(); const initial = JSON.parse(await readFile(f.launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
    await f.session.attachRun({ runId: "run-a", baseInstructions: "initial π", dynamicTools: [tool("old_tool")], runtimeContext: { revision: 1 } });
    await f.session.revalidateAfterClaim();
    expect((await f.session.snapshot()).binding).toMatchObject({ epoch: 1, preparedTurnId: initial.turnId });
    const turn = await f.session.startTurn({ message: { role: "user", text: "one" } });
    expect(turn.turnId).toBe(initial.turnId); expect(f.ipc).toEqual([]);
    expect(f.transport.commands).toEqual([...admission, "get_available_models", ...admission, ...admission, ...admission, "prompt"]); await finish(f);
    await f.session.attachRun({ runId: "run-a", baseInstructions: "initial π", dynamicTools: [tool("old_tool")], runtimeContext: { revision: 1 } });
    await f.session.attachRun({ runId: "run-a", baseInstructions: "initial π", dynamicTools: [tool("old_tool")], runtimeContext: { revision: 1 } });
    await f.session.revalidateAfterClaim(); await f.session.startTurn({ message: { role: "user", text: "two" } });
    expect(f.ipc.map(command => command.type)).toEqual(["bind", "begin_turn"]); expect((await f.session.snapshot()).binding?.epoch).toBe(2); await finish(f, 2);
  });
  it("revokes at terminal publication, rotates same-run epochs, then binds refreshed attach before admission/prompt", async () => {
    const f = await fixture();
    const initialModels = JSON.parse(await readFile(join(f.launch.env!.PI_CODING_AGENT_DIR!, "models.json"), "utf8")); const firstProvider = initialModels.providers.paperclip;
    await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
    expect(await revoked(firstProvider)).toBe(true); expect(f.requests).toHaveLength(0);
    await f.session.startTurn({ message: { role: "user", text: "two" } });
    const secondBind = f.ipc.find(command => command.type === "bind")!;
    expect(secondBind).toMatchObject({ type: "bind", sessionId: "host-session", expectedPriorEpoch: 1, epoch: 2, runId: "run-a" });
    expect(f.transport.order.slice(12)).toEqual(["ipc:bind", ...admission, "ipc:begin_turn", "prompt"]);
    await finish(f, 2);
    expect(await revoked((secondBind as any).provider)).toBe(true);
    await f.session.attachRun({ runId: "run-b", baseInstructions: "", dynamicTools: [], runtimeContext: null });
    const thirdBind = f.ipc.filter(command => command.type === "bind").at(-1) as any;
    expect(thirdBind).toMatchObject({ expectedPriorEpoch: 2, epoch: 3, runId: "run-b", tools: [] });
    expect(thirdBind.instructions).not.toContain("initial π"); expect(thirdBind.instructions).toContain("null");
    const count = f.ipc.length; await tick(); expect(f.ipc).toHaveLength(count);
    await f.session.startTurn({ message: { role: "user", text: "three" } }); await finish(f, 3);
    expect(await revoked(thirdBind.provider)).toBe(true);
  });
  it.each(["stale", "lost", "begin-lost"] as const)("fences %s ACK without retry or prompt and closes the new capability", async fault => {
    const f = await fixture({}, fault); await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
    const operation = fault === "begin-lost" ? f.session.startTurn({ message: { role: "user", text: "two" } }) : f.session.attachRun({ runId: "run-b" });
    await expect(operation).rejects.toThrow(/receipt|private|channel|timed/i);
    expect(f.transport.commands.filter(command => command === "prompt")).toHaveLength(1);
    expect(f.ipc.filter(command => command.type === "bind")).toHaveLength(1);
    const next = f.ipc.find(command => command.type === "bind") as any; expect(await revoked(next.provider)).toBe(true);
    await expect(f.session.startTurn({ message: { role: "user", text: "not allowed" } })).rejects.toThrow(); expect(f.transport.closed).toBe(true);
  });
  it.each(["model", "effort"] as const)("refuses exact native %s mismatch after a valid bind receipt, never beginning/prompting", async kind => {
    const f = await fixture(); await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
    if (kind === "model") f.transport.mismatch = true; else f.transport.effortMismatch = true;
    await expect(f.session.attachRun({ runId: "run-b" })).rejects.toThrow(/model|thinking/i);
    // Cleanup IPC is required after the refusal; it is not a bind retry.
    expect(f.ipc.filter(command => command.type !== "stop_children").map(command => command.type)).toEqual(["bind"]);
    expect(f.ipc.filter(command => command.type === "stop_children")).toHaveLength(1);
    expect(f.transport.commands.filter(command => command === "prompt")).toHaveLength(1);
    expect(await revoked((f.ipc[0] as any).provider)).toBe(true);
  });
  it.each(["nonce", "sessionId", "runId", "model", "thinkingLevel", "instructionHash", "instructionLength", "toolRevision"])("independently rejects a forged %s receipt from a private-channel adapter", async field => {
    const client: typeof sendPiBindRequest = async (path, request, options) => {
      const receipt = await sendPiBindRequest(path, request, options);
      // Forge only the bind under test, not the independent Stop receipt.
      return request.type === "bind" ? { ...receipt, [field]: field === "instructionLength" ? -1 : "forged" } : receipt;
    };
    const f = await fixture({ bindRequest: client }); await f.session.startTurn({ message: { role: "user", text: "one" } }); await finish(f);
    await expect(f.session.attachRun({ runId: "run-b" })).rejects.toThrow(/receipt/i);
    expect(f.transport.commands.filter(command => command === "prompt")).toHaveLength(1); expect(await revoked((f.ipc[0] as any).provider)).toBe(true);
  });
  it("refuses unannounced semantic callbacks and cancels anonymous UI with the exact native ID", async () => {
    const handler = vi.fn(); const f = await fixture({ dynamicToolHandler: handler });
    await f.session.startTurn({ message: { role: "user", text: "one" } });
    f.transport.send({ type: "extension_ui_request", id: "old-ui", method: "confirm", title: "stale" });
    f.transport.send({ type: "extension_ui_request", id: 0, method: "input", title: "anonymous" });
    f.transport.send({ type: "tool_call", toolName: "old_tool", toolCallId: "old", args: {} }); await tick();
    expect(handler).not.toHaveBeenCalled();
    expect(f.transport.uiResponses).toEqual([{ id: "old-ui", cancelled: true }, { id: 0, cancelled: true }]);
    expect(f.events.some(event => event.eventType === "runtime_request.created")).toBe(false);
    expect(f.transport.commands).toEqual([...admission, "get_available_models", ...admission, "prompt"]);
    expect(f.ipc).toEqual([]);
  });
});

const real = describe.skipIf(!process.env.PI_TEST_BINARY);
real("real Pi 1.5.2 resident binding", () => {
  it("runs three turns across two runs in one PID/session with refreshed instructions and tools, idle revoked", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resident-real-")); const workspace = join(root, "workspace"); await mkdir(workspace);
    const upstream = await faux(); const agent = join(root, "agent"); await mkdir(agent);
    await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { preserved: { baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "unused", models: [{ id: "keep" }] } } }));
    const semantic = vi.fn(); let native!: PiRpcTransport; let launch!: PiRpcTransportOptions;
    const driver = new PiRpcDriver({ transportFactory: options => { launch = options; native = new PiRpcTransport(options); return native; }, command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), systemInstructions: "INSTRUCTIONS_A_π", dynamicTools: [tool("first_tool")], runtimeContext: { marker: "CTX_A" }, dynamicToolHandler: semantic, environment: { ...upstream.environment, PI_CODING_AGENT_DIR: agent }, shutdownTimeoutMs: 1000 });
    const session = await driver.openSession({ runId: "run-a", normalizedSessionId: "host-real", workingDirectory: workspace }) as PiRpcHarnessSession; sessions.push(session);
    const pid = session.processPid(); const id = session.ids().providerSessionId; const iterator = session.events()[Symbol.asyncIterator]();
    const turns: Array<Record<string, unknown>> = [];
    const firstModels = JSON.parse(await readFile(join(agent, "models.json"), "utf8")); expect(firstModels.providers.preserved.models[0].id).toBe("keep");
    for (let n = 1; n <= 3; n++) {
      if (n === 3) await session.attachRun({ runId: "run-b", baseInstructions: "INSTRUCTIONS_B_β", dynamicTools: [tool("second_tool")], runtimeContext: { marker: "CTX_B" } });
      const sent = Date.now(); const turn = await session.startTurn({ message: { role: "user", text: `answer ${n}; do not call tools` } }); let firstModelEvent: number | undefined;
      for (;;) {
        const next = await iterator.next(); if (next.done) throw new Error("event stream ended"); const event = next.value;
        if (event.turnId !== turn.turnId) continue;
        if (event.eventType === "item.delta") firstModelEvent ??= Date.now();
        if (["turn.failed", "turn.cancelled"].includes(event.eventType)) throw new Error(JSON.stringify(event));
        if (event.eventType === "turn.completed") break;
      }
      expect(session.processPid()).toBe(pid); expect(session.ids().providerSessionId).toBe(id);
      turns.push({ n, ...turn, runId: n === 3 ? "run-b" : "run-a", sent, firstModelEvent });
      if (n === 1) {
        const socket = launch.env!.PAPERCLIP_PI_BIND_SOCKET!;
        expect((await stat(dirname(socket))).mode & 0o777).toBe(0o700); expect((await stat(socket)).mode & 0o777).toBe(0o600);
        expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
        expect(await revoked(firstModels.providers.paperclip)).toBe(true);
      }
      // Exercise actual Pi's input gate while idle, not only absence of a timer.
      const idle = await native.request("prompt", { message: "unsolicited idle work" });
      expect(idle.data).toMatchObject({ disposition: "handled" });
      const count = upstream.requests.length; await new Promise(resolve => setTimeout(resolve, 80)); expect(upstream.requests).toHaveLength(count);
    }
    expect(upstream.requests).toHaveLength(3);
    expect(JSON.stringify(upstream.requests[0].messages)).toContain("INSTRUCTIONS_A_π"); expect(JSON.stringify(upstream.requests[0].messages)).toContain("CTX_A");
    expect(upstream.requests[0].tools.some((entry: any) => entry.function.name === "first_tool")).toBe(true);
    expect(JSON.stringify(upstream.requests[2].messages)).toContain("INSTRUCTIONS_B_β"); expect(JSON.stringify(upstream.requests[2].messages)).toContain("CTX_B");
    expect(upstream.requests[2].tools.some((entry: any) => entry.function.name === "second_tool")).toBe(true);
    expect(upstream.requests[2].tools.some((entry: any) => entry.function.name === "first_tool")).toBe(false);
    expect(semantic).not.toHaveBeenCalled();
    const snapshot = await session.snapshot(); const trace = await readFile(snapshot.sessionFile, "utf8");
    for (const surface of [trace, await readFile(`/proc/${pid}/cmdline`, "utf8"), await readFile(`/proc/${pid}/environ`, "utf8"), await readFile(join(agent, "models.json"), "utf8")]) expect(surface).not.toContain("upstream-binding-canary");
    await session.close(); expect(session.processExited()).toBe(true);
    await writeFile(join(root, "sessions", "proof.json"), JSON.stringify({ binary: process.env.PI_TEST_BINARY, pid, sessionId: id, turns, trace: snapshot.sessionFile, traceSha256: digest(trace), modelRequests: upstream.requests }, null, 2));
    console.log(`RESIDENT_PROOF ${join(root, "sessions", "proof.json")}`);
  }, 30_000);
  it("fences a lost real-Pi bind ACK after native application, closes both capabilities, and never prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resident-real-lost-")); const workspace = join(root, "workspace"); await mkdir(workspace); const upstream = await faux();
    let bound: { baseUrl: string; apiKey: string } | undefined; let binds = 0; let prompts = 0;
    const client: typeof sendPiBindRequest = async (path, request, options) => {
      const receipt = await sendPiBindRequest(path, request, options);
      if (request.type === "bind") { bound = request.provider; binds++; throw new Error("Pi private ACK lost after native application"); }
      return receipt;
    };
    const driver = new PiRpcDriver({ bindRequest: client, transportFactory: options => { const native = new PiRpcTransport(options); const original = native.request.bind(native); native.request = (type, params) => { if (type === "prompt") prompts++; return original(type, params); }; return native; }, command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), environment: { ...upstream.environment, PI_CODING_AGENT_DIR: join(root, "agent") }, shutdownTimeoutMs: 1000 });
    const session = await driver.openSession({ runId: "run-a", normalizedSessionId: "real-lost", workingDirectory: workspace }) as PiRpcHarnessSession; sessions.push(session);
    const old = JSON.parse(await readFile(join(root, "agent", "models.json"), "utf8")).providers.paperclip;
    const iterator = session.events()[Symbol.asyncIterator](); await session.startTurn({ message: { role: "user", text: "one" } });
    for (;;) { const next = await iterator.next(); if (next.done || next.value.eventType === "turn.failed") throw new Error("first turn failed"); if (next.value.eventType === "turn.completed") break; }
    expect(await revoked(old)).toBe(true);
    await expect(session.attachRun({ runId: "run-b" })).rejects.toThrow("ACK lost");
    expect(binds).toBe(1); expect(prompts).toBe(1); expect(bound).toBeDefined(); expect(await revoked(bound!)).toBe(true); expect(upstream.requests).toHaveLength(1); expect(session.processExited()).toBe(true);
    await expect(session.startTurn({ message: { role: "user", text: "forbidden retry" } })).rejects.toThrow();
    const snapshot = await session.snapshot(); await writeFile(join(root, "sessions", "proof.json"), JSON.stringify({ binary: process.env.PI_TEST_BINARY, outcome: "lost ACK fenced", binds, prompts, upstreamRequests: upstream.requests.length, trace: snapshot.sessionFile, traceSha256: digest(await readFile(snapshot.sessionFile, "utf8")) }, null, 2));
  }, 30_000);
  it("preserves explicit env-mode as a nonsecret-claim counterexample", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resident-env-")); const workspace = join(root, "workspace"); await mkdir(workspace); const upstream = await faux(); const agent = join(root, "agent");
    const session = await new PiRpcDriver({ command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), environment: { ...upstream.environment, PI_CODING_AGENT_DIR: agent, PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "env" }, shutdownTimeoutMs: 1000 }).openSession({ runId: "env", normalizedSessionId: "env", workingDirectory: workspace }) as PiRpcHarnessSession; sessions.push(session);
    const iterator = session.events()[Symbol.asyncIterator](); await session.startTurn({ message: { role: "user", text: "env opt-in" } });
    for (;;) { const next = await iterator.next(); if (next.done || next.value.eventType === "turn.failed") throw new Error("env turn failed"); if (next.value.eventType === "turn.completed") break; }
    expect(upstream.requests).toHaveLength(1); expect(await readFile(`/proc/${session.processPid()}/environ`, "utf8")).toContain("PAPERCLIP_AI_PROVIDER_KEY=upstream-binding-canary");
    expect(await readFile(join(agent, "models.json"), "utf8")).toContain("upstream-binding-canary");
    await session.close(); expect(session.processExited()).toBe(true);
  }, 30_000);
});
