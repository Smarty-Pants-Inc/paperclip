import { createServer as httpServer, type Server as HttpServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindContent, sendPiBindRequest, sendPiToolRequest, type Origin, type PiBindCommand, type PiToolCallRequest } from "./pi-bind-protocol.js";
import { PiRpcDriver, type PiRpcDriverOptions, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord, type PiRpcTransportOptions } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: actual driver + real Unix IPC crosses the semantic-effects trust boundary.
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const tool = { name: "context", description: "Read context", inputSchema: { type: "object", properties: {} } };
class FakeTransport {
  pid = 42; exited = false; closed = false; ready = Promise.resolve();
  writes: PiRpcRecord[] = []; order: string[] = []; state: PiRpcRecord = {}; uiGate = Promise.resolve();
  #queue: PiRpcRecord[] = []; #wake?: (value: IteratorResult<PiRpcRecord>) => void;
  async request(type: string) { await this.ready; this.order.push(type); if (type === "abort") { this.send({ type: "agent_end", messages: [] }); this.send({ type: "agent_settled", aborted: true }); } return { success: true, data: type === "get_state" ? { sessionId: "native", model: { provider: "paperclip", id: "faux" }, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0, ...this.state } : type === "get_available_models" ? { models: [{ provider: "paperclip", id: "faux", name: "Fixture", api: "openai-completions" }] } : type === "set_model" ? { provider: "paperclip", id: "faux" } : type === "get_available_thinking_levels" ? { levels: ["off"] } : type === "prompt" ? { disposition: "started" } : undefined }; }
  async sendExtensionUiResponse(value: PiRpcRecord) { this.writes.push(structuredClone(value)); await this.uiGate; }
  send(value: PiRpcRecord) { if (this.#wake) { const wake = this.#wake; this.#wake = undefined; wake({ value, done: false }); } else this.#queue.push(value); }
  events(): AsyncIterable<PiRpcRecord> { return { [Symbol.asyncIterator]: () => ({ next: async () => { const value = this.#queue.shift(); if (value) return { value, done: false }; if (this.closed) return { value: undefined, done: true }; return new Promise<IteratorResult<PiRpcRecord>>(r => { this.#wake = r; }); } }) }; }
  async close() { this.order.push("physical_close"); this.closed = this.exited = true; this.#wake?.({ value: undefined, done: true }); this.#wake = undefined; }
}
async function fixture(options: Partial<PiRpcDriverOptions> = {}, Driver: typeof PiRpcDriver = PiRpcDriver) {
  const root = await mkdtemp(join(tmpdir(), "pi-live-c2-")); await mkdir(join(root, "workspace"));
  const transport = new FakeTransport(); const ipc: PiBindCommand[] = []; const sockets = new Set<Socket>();
  let peer!: Server; let launch!: PiRpcTransportOptions; let stop = { settled: [] as string[], uncertain: [] as string[] }; let park = { ready: true, reasons: [] as string[] };
  let stopGate = Promise.resolve();
  const effects: unknown[] = [];
  const driver = new Driver({ model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), dynamicTools: [tool], startupTimeoutMs: 180,
    environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "faux-only" },
    dynamicToolHandler: async call => { effects.push(call); return { contentItems: [{ type: "inputText", text: "accepted" }], success: true }; }, ...options,
    transportFactory: opts => { launch = opts; peer = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); let buffer = ""; socket.setEncoding("utf8"); socket.on("data", chunk => { buffer += chunk; if (!buffer.endsWith("\n")) return; const req = JSON.parse(buffer) as PiBindCommand; ipc.push(req); transport.order.push(`ipc:${req.type}`); const receipt = req.type === "bind" ? { schema: 1, type: "bind", nonce: req.nonce, sessionId: req.sessionId, epoch: req.epoch, runId: req.runId, provider: req.provider.name, model: req.model, thinkingLevel: req.thinkingLevel, ...bindContent(req) } : req.type === "park_ready" ? { ...req, ...park } : req.type === "stop_children" ? { ...req, ...stop } : { ...req, ack: true }; void (req.type === "stop_children" ? stopGate : Promise.resolve()).then(() => socket.end(`${JSON.stringify(receipt)}\n`)); }); }); transport.ready = new Promise<void>(r => peer.listen(opts.env!.PAPERCLIP_PI_BIND_SOCKET!, r)); return transport as unknown as PiRpcTransport; },
  });
  const session = await driver.openSession({ runId: "run-1", normalizedSessionId: "host", workingDirectory: join(root, "workspace") }) as PiRpcHarnessSession;
  cleanups.push(async () => { await session.close().catch(() => {}); for (const socket of sockets) socket.destroy(); await new Promise<void>(r => peer.close(() => r())); });
  const initial = JSON.parse(readFileSync(launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8")); const events: PrpEvent[] = []; void (async () => { for await (const e of session.events()) events.push(e); })();
  function call(id = "call", change: Partial<PiToolCallRequest> = {}): PiToolCallRequest { return { schema: 1, type: "tool_call", nonce: id, sessionId: "host", origin: { epoch: initial.epoch, runId: initial.runId, turnId: initial.turnId }, toolCallId: id, tool: "context", arguments: {}, ...change }; }
  async function start() { const turn = await session.startTurn({ message: { role: "user", text: "one" } }); transport.send({ type: "agent_start" }); await tick(); return turn; }
  async function announce(request: PiToolCallRequest) { transport.send({ type: "tool_execution_start", toolCallId: request.toolCallId, toolName: request.tool, args: request.arguments }); await tick(); }
  async function settle(n = 1) { const message = { role: "assistant", id: `m-${n}`, responseId: `receipt-${n}`, timestamp: n, provider: "paperclip", model: "faux", content: [{ type: "text", text: "done" }], usage: {}, stopReason: "stop" }; transport.send({ type: "message_start", message }); transport.send({ type: "message_end", message }); transport.send({ type: "agent_settled" }); await vi.waitFor(() => expect(events.filter(e => e.eventType === "turn.completed")).toHaveLength(n)); }
  return { root, session, transport, launch, ipc, initial, events, effects, call, start, announce, settle, setStop: (value: typeof stop) => { stop = value; }, setPark: (value: typeof park) => { park = value; }, setStopGate: (value: Promise<void>) => { stopGate = value; } };
}

async function packagedDriver(verified = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-c2-pack-")); const dist = join(root, "dist"); await mkdir(join(dist, "cli"), { recursive: true });
  const output = join(dist, "cli", "pi-rpc-app-server-proxy.cjs");
  const proxy = fileURLToPath(new URL("../../cli/pi-rpc-app-server-proxy.ts", import.meta.url)); const driver = fileURLToPath(new URL("./pi-rpc-driver.ts", import.meta.url));
  // The wrapper adds only a test export of the SAME driver imported by the real
  // proxy. Bundle location and CJS banner/defines mirror the official script.
  await build({ stdin: { contents: `export {createPiRpcAppServerProxy} from ${JSON.stringify(proxy)}; export {PiRpcDriver} from ${JSON.stringify(driver)};`, resolveDir: fileURLToPath(new URL(".", import.meta.url)), loader: "ts" }, outfile: output, bundle: true, platform: "node", format: "cjs", target: "node24", packages: "bundle", splitting: false, sourcemap: false, legalComments: "none", treeShaking: true, logLevel: "silent",
    ...(verified ? { banner: { js: 'const __paperclipVerifiedEntrypointUrl = require("node:url").pathToFileURL(__filename).href;' }, define: { "import.meta.dirname": "__dirname", "import.meta.url": "__paperclipVerifiedEntrypointUrl" } } : {}),
  });
  await writeFile(join(dist, "package.json"), '{"type":"module"}');
  await Promise.all([
    build({ entryPoints: [fileURLToPath(new URL("./extension/index.ts", import.meta.url))], outfile: join(dist, "drivers/pi/extension/index.js"), platform: "node", format: "esm", target: "node24", bundle: false, logLevel: "silent" }),
    build({ entryPoints: [fileURLToPath(new URL("./pi-bind-protocol.ts", import.meta.url))], outfile: join(dist, "drivers/pi/pi-bind-protocol.js"), platform: "node", format: "esm", target: "node24", bundle: false, logLevel: "silent" }),
    build({ entryPoints: [fileURLToPath(new URL("./extension/subagents/child-bridge.ts", import.meta.url))], outfile: join(dist, "drivers/pi/extension/child-bridge.js"), platform: "node", format: "esm", target: "node24", bundle: true, logLevel: "silent" }),
  ]);
  const path = "dist/drivers/pi/extension/child-bridge.js";
  const sha256 = `sha256:${createHash("sha256").update(await readFile(join(root, path))).digest("hex")}`;
  await writeFile(join(root, "provider-pack.json"), JSON.stringify({ payload: { artifacts: { piChildBridge: { path, sha256 } } } }));
  return { root, Driver: (createRequire(import.meta.url)(output) as { PiRpcDriver: typeof PiRpcDriver }).PiRpcDriver };
}

describe("live host Pi C2 authority", () => {
  it.each([false, true])("counts host callbacks AND native execution independently (native ends first: %s)", async nativeEndsFirst => {
    const entered = deferred<void>(), result = deferred<unknown>();
    const f = await fixture({ turnIdleTimeoutMs: 100, dynamicToolHandler: async () => { entered.resolve(); return result.promise; } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pending: Promise<unknown> | undefined;
    try {
      await f.start(); const request = f.call("idle-active"); await f.announce(request);
      pending = sendPiToolRequest(f.initial.toolSocketPath, request);
      const receipt = expect(pending).resolves.toMatchObject({ content: [{ text: "callback result" }] });
      await entered.promise;
      if (nativeEndsFirst) {
        f.transport.send({ type: "tool_execution_end", toolCallId: request.toolCallId, toolName: request.tool, result: { content: [] } }); await tick();
      }
      await vi.advanceTimersByTimeAsync(500);
      expect(f.transport.closed).toBe(false);
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      result.resolve({ content: [{ type: "text", text: "callback result" }], details: {} });
      await receipt;
      if (!nativeEndsFirst) {
        // The callback result is not Pi's execution_end. Native execution still
        // suppresses expiry until its exact terminal receipt arrives.
        await vi.advanceTimersByTimeAsync(500);
        expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
        f.transport.send({ type: "tool_execution_end", toolCallId: request.toolCallId, toolName: request.tool, result: { content: [] } }); await tick();
      }
      await vi.advanceTimersByTimeAsync(99); expect(f.transport.order).not.toContain("abort");
      await vi.advanceTimersByTimeAsync(1); await tick(); await tick();
      vi.useRealTimers();
      await vi.waitFor(() => expect(f.events.filter(event => event.eventType === "turn.failed")).toMatchObject([{ payload: { error: { code: "pi_turn_idle_timeout" } } }]));
      expect(f.transport.closed).toBe(false);
      expect(f.transport.order).toContain("abort");
      expect(f.ipc.some(command => command.type === "stop_children")).toBe(false);
      await f.session.attachRun({ runId: "run-after-timeout" });
      await f.start(); await f.settle();
      expect(f.transport.closed).toBe(false);
      expect(f.ipc.some(command => command.type === "bind")).toBe(true);
    } finally {
      result.resolve({ content: [], details: {} });
      vi.useRealTimers(); await pending?.catch(() => {});
    }
  });
  it("keeps an aborted callback's native tool active until its execution_end", async () => {
    const entered = deferred<void>(), result = deferred<unknown>();
    const f = await fixture({ turnIdleTimeoutMs: 100, dynamicToolTimeoutMs: 50, dynamicToolHandler: async () => { entered.resolve(); return result.promise; } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let pending: Promise<unknown> | undefined;
    try {
      await f.start(); const request = f.call("idle-aborted"); await f.announce(request);
      pending = sendPiToolRequest(f.initial.toolSocketPath, request);
      const refused = expect(pending).rejects.toThrow();
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50); await refused;
      await vi.advanceTimersByTimeAsync(500);
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      f.transport.send({ type: "tool_execution_end", toolCallId: request.toolCallId, toolName: request.tool, result: { content: [] }, isError: true }); await tick();
      await vi.advanceTimersByTimeAsync(99); expect(f.transport.order).not.toContain("abort");
      await vi.advanceTimersByTimeAsync(1); await tick(); await tick();
      vi.useRealTimers();
      await vi.waitFor(() => expect(f.events.filter(event => event.eventType === "turn.failed")).toMatchObject([{ payload: { error: { code: "pi_turn_idle_timeout" } } }]));
      expect(f.transport.closed).toBe(false);
    } finally { result.resolve({ content: [], details: {} }); vi.useRealTimers(); await pending?.catch(() => {}); }
  });
  it("returns a seven-second dynamic tool's real result independently of the startup deadline", async () => {
    const f = await fixture({ dynamicToolHandler: async call => {
      await new Promise<void>(resolve => setTimeout(resolve, 7000));
      call.signal.throwIfAborted();
      return { content: [{ type: "text", text: "seven-second-real-result" }], details: {} };
    } });
    await f.start(); const request = f.call("slow"); await f.announce(request);
    await expect(sendPiToolRequest(f.initial.toolSocketPath, request, { timeoutMs: 60000 })).resolves.toMatchObject({ content: [{ text: "seven-second-real-result" }] });
    await f.settle(); expect(f.transport.closed).toBe(false);
  }, 12_000);
  it("resolves the real owned extension in official verified CJS cli layout, not cwd", async () => {
    const packaged = await packagedDriver(); const f = await fixture({}, packaged.Driver);
    expect(f.launch.fatalSessionStartExtensionPaths).toEqual([
      join(packaged.root, "dist/drivers/pi/extension/index.js"),
      join(packaged.root, "dist/drivers/pi/extension/child-bridge.js"),
    ]);
    expect(f.initial.toolSocketPath.startsWith(tmpdir())).toBe(true);
    expect(Buffer.byteLength(f.initial.toolSocketPath)).toBeLessThanOrEqual(103);
    expect(f.initial.toolSocketPath).not.toMatch(/^\/tmp\/pcpi-/);
    await f.start(); await f.settle();
  });
  it("refuses raw CJS without the official import-meta banner instead of searching cwd/env", async () => {
    const packaged = await packagedDriver(false);
    await expect(fixture({}, packaged.Driver)).rejects.toThrow(/owned extension|entrypoint/i);
  });
  it("opens the private semantic socket before spawn and allows only a native-announced exact once-only call", async () => {
    const f = await fixture(); expect(typeof f.initial.toolSocketPath).toBe("string"); expect((await stat(f.initial.toolSocketPath)).mode & 0o777).toBe(0o600);
    await f.start(); const request = f.call(); await f.announce(request);
    expect(await sendPiToolRequest(f.initial.toolSocketPath, request)).toMatchObject({ content: [{ type: "text", text: "accepted" }], isError: false });
    await expect(sendPiToolRequest(f.initial.toolSocketPath, { ...request, nonce: "duplicate" })).rejects.toThrow(); expect(f.effects).toHaveLength(1); expect(f.effects[0]).toMatchObject({ runId: "run-1", turnId: f.initial.turnId, tool: "context", callId: "call", arguments: {}, signal: expect.any(AbortSignal) });
  });
  it.each(["missing", "unannounced", "wrongrun", "wrongsession", "wrongturn", "wrongepoch", "tool", "args", "builtin"])("rejects %s without effects", async kind => {
    const f = await fixture(); await f.start(); let request = f.call(); if (!["unannounced", "builtin"].includes(kind)) await f.announce(request);
    if (kind === "missing") request = { ...request, toolCallId: undefined as unknown as string };
    if (kind === "wrongrun") request = { ...request, origin: { ...request.origin, runId: "old" } };
    if (kind === "wrongturn") request = { ...request, origin: { ...request.origin, turnId: "old" } };
    if (kind === "wrongepoch") request = { ...request, origin: { ...request.origin, epoch: 2 } };
    if (kind === "wrongsession") request = { ...request, sessionId: "other" };
    if (kind === "tool" || kind === "builtin") request = { ...request, tool: "bash" };
    if (kind === "args") request = { ...request, arguments: { changed: true } };
    await expect(sendPiToolRequest(f.initial.toolSocketPath, request, { timeoutMs: 1200 })).rejects.toThrow(); expect(f.effects).toEqual([]);
  });
  it("joins IPC-before-stdout without self announcement or premature effects", async () => {
    const f = await fixture(); await f.start(); const request = f.call(); let done = false;
    const pending = sendPiToolRequest(f.initial.toolSocketPath, request).then(value => { done = true; return value; }); await tick(); await tick(); expect(f.effects).toEqual([]); expect(done).toBe(false);
    await f.announce(request); await expect(pending).resolves.toMatchObject({ content: [{ text: "accepted" }] });
  });
  it("rejects a real old callback result during run two; current call still succeeds", async () => {
    const entered = deferred<void>(); const result = deferred<unknown>(); let signal!: AbortSignal;
    const f = await fixture({ dynamicToolHandler: async call => { if (call.callId === "old") { signal = call.signal!; entered.resolve(); return result.promise; } return { content: [{ type: "text", text: "new" }], details: {} }; } });
    await f.start(); const old = f.call("old"); await f.announce(old); const pending = sendPiToolRequest(f.initial.toolSocketPath, old); const refusal = expect(pending).rejects.toThrow(); await entered.promise;
    await f.settle(); await f.session.attachRun({ runId: "run-2" }); const second = await f.start(); const origin = { epoch: 2, runId: "run-2", turnId: second.turnId };
    expect(signal.aborted).toBe(true); result.resolve({ content: [{ type: "text", text: "late" }], details: {} }); await refusal;
    await expect(sendPiToolRequest(f.initial.toolSocketPath, old)).rejects.toThrow(); const current = f.call("new", { origin }); await f.announce(current); await expect(sendPiToolRequest(f.initial.toolSocketPath, current)).resolves.toMatchObject({ content: [{ text: "new" }] });
    expect(f.ipc.find(r => r.type === "bind")).toMatchObject({ toolSocketPath: f.initial.toolSocketPath });
  });
  it("routes captured UI zero/empty once, cancels malformed anonymous UI and never relabels explicit unknown/old origins", async () => {
    const f = await fixture(); await f.start(); const origin = f.call().origin;
    f.transport.send({ type: "extension_ui_request", id: 0, method: "input", title: "Value?", origin });
    await vi.waitFor(() => expect(f.events.some(e => e.eventType === "runtime_request.created")).toBe(true));
    const request = f.events.find(e => e.eventType === "runtime_request.created")!.payload.request as Record<string, unknown>;
    const resolution = { runId: "run-1", turnId: origin.turnId, requestId: "0", origin: request.origin, resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { text: "" } } } } };
    await f.session.resolveRuntimeRequest!(resolution as never); expect(f.transport.writes).toEqual([{ id: 0, value: "" }]); await expect(f.session.resolveRuntimeRequest!(resolution as never)).rejects.toThrow();
    f.transport.send({ type: "extension_ui_request", id: "anonymous", method: "confirm" });
    f.transport.send({ type: "extension_ui_request", id: "unknown", method: "input", title: "Value?", origin: { ...origin, runId: "unknown" } }); await tick(); await tick();
    expect(f.transport.writes).toContainEqual({ id: "anonymous", cancelled: true }); expect(f.events.filter(e => e.eventType === "runtime_request.created")).toHaveLength(1);
    f.transport.send({ type: "extension_ui_request", id: "old", method: "input", title: "Value?", origin }); await vi.waitFor(() => expect(f.events.filter(e => e.eventType === "runtime_request.created")).toHaveLength(2));
    const oldRequest = f.events.filter(e => e.eventType === "runtime_request.created")[1]!.payload.request as Record<string, unknown>; await f.settle(); await f.session.attachRun({ runId: "run-2" }); await f.start();
    const count = f.transport.writes.length; await expect(f.session.resolveRuntimeRequest!({ ...resolution, requestId: "old", origin: oldRequest.origin } as never)).rejects.toThrow(); expect(f.transport.writes).toHaveLength(count);
    f.transport.send({ type: "extension_ui_request", id: "late", method: "input", title: "Value?", origin }); await tick(); expect(f.events.filter(e => e.eventType === "runtime_request.created")).toHaveLength(2);
  });
  it("fences immediately while child cleanup is pending, then aborts and keeps Pi warm", async () => {
    const f = await fixture(); const turn = await f.start(); const request = f.call(); await f.announce(request);
    const gate = deferred<void>(); f.setStopGate(gate.promise);
    const stopping = f.session.interrupt({ turnId: turn.turnId });
    await vi.waitFor(() => expect(f.ipc.some(command => command.type === "stop_children")).toBe(true));
    expect(f.transport.closed).toBe(false);
    await expect(sendPiToolRequest(f.initial.toolSocketPath, request)).rejects.toThrow(); expect(f.effects).toEqual([]);
    gate.resolve(); await stopping; expect(f.transport.closed).toBe(false);
    expect(f.transport.order.indexOf("clear_queue")).toBeLessThan(f.transport.order.indexOf("abort"));
    await vi.waitFor(() => expect(f.events.some(event => event.eventType === "turn.cancelled" && event.turnId === turn.turnId)).toBe(true));
  });
  it("ignores idle or stale interrupts, and aborts an active turn without retiring Pi", async () => {
    const f = await fixture(); const turn = await f.start(); await f.session.interrupt({ turnId: "old-turn" }); expect(f.transport.closed).toBe(false); await f.settle();
    await f.session.interrupt(); expect(f.transport.closed).toBe(false);
    expect(f.ipc.some(command => command.type === "stop_children")).toBe(false); expect(turn.turnId).toBe(f.initial.turnId);
    const next = await f.start(); await f.session.interrupt({ turnId: turn.turnId }); expect(f.transport.closed).toBe(false);
    await f.session.interrupt({ turnId: next.turnId }); expect(f.transport.closed).toBe(false); expect(f.ipc.some(command => command.type === "stop_children")).toBe(true);
  });
  it("accepts a UI request attributed by a previously captured native message owner", async () => {
    const f = await fixture(); await f.start(); const message = { role: "assistant", id: "native-message", provider: "paperclip", model: "faux", timestamp: 1, content: [] };
    f.transport.send({ type: "message_start", message }); f.transport.send({ type: "extension_ui_request", id: "known", method: "input", title: "Value?", messageId: "native-message" });
    await vi.waitFor(() => expect(f.events.some(event => event.eventType === "runtime_request.created")).toBe(true));
    const request = f.events.find(event => event.eventType === "runtime_request.created")!.payload.request as Record<string, unknown>;
    await f.session.resolveRuntimeRequest!({ requestId: "known", runId: "run-1", turnId: f.initial.turnId, origin: request.origin, resolution: { action: "cancel" } } as never); expect(f.transport.writes).toEqual([{ id: "known", cancelled: true }]);
  });
  it("does not spend a prepared epoch before the actual host prompt", async () => {
    const f = await fixture(); await expect(sendPiToolRequest(f.initial.toolSocketPath, f.call())).rejects.toThrow(); expect(f.effects).toEqual([]);
    await f.start(); await f.announce(f.call()); await expect(sendPiToolRequest(f.initial.toolSocketPath, f.call())).resolves.toHaveProperty("content");
  });
  it("captures UI identity before awaits and preserves cancellation and false confirmation", async () => {
    const f = await fixture(); await f.start(); const origin = f.call().origin;
    const ui = async (id: string, method: string) => { f.transport.send({ type: "extension_ui_request", id, method, title: "Value?", ...(method === "confirm" ? { message: "Continue?" } : {}), origin }); await vi.waitFor(() => expect(f.events.some(e => e.eventType === "runtime_request.created" && (e.payload.request as Record<string, unknown>).requestId === id)).toBe(true)); const request = f.events.find(e => e.eventType === "runtime_request.created" && (e.payload.request as Record<string, unknown>).requestId === id)!.payload.request as Record<string, unknown>; return { requestId: id, runId: origin.runId, turnId: origin.turnId, origin: request.origin }; };
    const captured = await ui("captured", "input"); const input = { ...captured, resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { text: "" } } } } };
    const pending = f.session.resolveRuntimeRequest!(input as never); input.requestId = "relabeled"; input.runId = "old"; input.resolution.response.answers.value.text = "changed";
    await pending; expect(f.transport.writes).toContainEqual({ id: "captured", value: "" }); expect(f.events.find(e => e.eventType === "runtime_request.resolved")!.payload.requestId).toBe("captured");
    await f.session.resolveRuntimeRequest!({ ...await ui("cancel", "editor"), resolution: { action: "cancel" } } as never);
    await f.session.resolveRuntimeRequest!({ ...await ui("false", "confirm"), resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { selectedOptionIds: ["no"] } } } } } as never);
    expect(f.transport.writes).toContainEqual({ id: "cancel", cancelled: true }); expect(f.transport.writes).toContainEqual({ id: "false", confirmed: false });
  });
  it("refuses stale UI before stdin and rechecks after transport awaits", async () => {
    const f = await fixture(); await f.start(); const origin = f.call().origin;
    f.transport.send({ type: "extension_ui_request", id: "closing", method: "input", title: "Value?", origin });
    await vi.waitFor(() => expect(f.events.some(e => e.eventType === "runtime_request.created")).toBe(true));
    const request = f.events.find(e => e.eventType === "runtime_request.created")!.payload.request as Record<string, unknown>;
    const pending = f.session.resolveRuntimeRequest!({ requestId: "closing", runId: origin.runId, turnId: origin.turnId, origin: request.origin, resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { text: "late" } } } } } as never);
    const refused = expect(pending).rejects.toThrow(); const close = f.session.close(); await refused; await close; expect(f.transport.writes).toEqual([]);
    const g = await fixture(); await g.start(); const secondOrigin = g.call().origin;
    g.transport.send({ type: "extension_ui_request", id: "draining", method: "input", title: "Value?", origin: secondOrigin }); await vi.waitFor(() => expect(g.events.some(e => e.eventType === "runtime_request.created")).toBe(true));
    const second = g.events.find(e => e.eventType === "runtime_request.created")!.payload.request as Record<string, unknown>;
    const gate = deferred<void>(); g.transport.uiGate = gate.promise;
    const draining = g.session.resolveRuntimeRequest!({ requestId: "draining", runId: secondOrigin.runId, turnId: secondOrigin.turnId, origin: second.origin, resolution: { action: "cancel" } } as never); const stale = expect(draining).rejects.toThrow();
    await tick(); await g.settle(); gate.resolve(); await stale; expect(g.events.filter(e => e.eventType === "runtime_request.resolved")).toEqual([]);
  });
  it.each([undefined, { contentItems: [{ type: "image", text: "bad" }], success: true }, { contentItems: [{ type: "text", text: "bad" }] }])("refuses invalid controller results %j rather than coercing to success", async result => {
    const f = await fixture({ dynamicToolHandler: async () => result }); await f.start(); const request = f.call(); await f.announce(request); await expect(sendPiToolRequest(f.initial.toolSocketPath, request)).rejects.toThrow();
  });
  it("does not relabel explicitly old/unknown UI message identities onto current native work", async () => {
    const f = await fixture(); await f.start(); const origin = f.call().origin;
    f.transport.send({ type: "extension_ui_request", id: "unknown-message", method: "input", title: "Value?", messageId: "unknown-native-message", origin }); await tick(); await tick();
    expect(f.events.filter(e => e.eventType === "runtime_request.created")).toEqual([]); expect(f.transport.writes).toEqual([{ id: "unknown-message", cancelled: true }]);
  });
  it("keeps unfinished native tools as park blockers even after settlement", async () => {
    const f = await fixture(); await f.start(); const request = f.call(); await f.announce(request); await f.settle(); expect((await f.session.parkReady()).reasons).toContain("pending tools");
    f.transport.send({ type: "tool_execution_end", toolCallId: request.toolCallId, toolName: request.tool, result: { content: [], details: {} } }); await tick(); expect(await f.session.parkReady()).toEqual({ ready: true, reasons: [] });
  });
  it("aggregates native idle/queue and private blockers; fences before child cleanup and preserves uncertain failure", async () => {
    const f = await fixture(); await f.start(); expect((await f.session.parkReady()).ready).toBe(false); await f.settle(); expect(await f.session.parkReady()).toEqual({ ready: true, reasons: [] });
    f.transport.state = { pendingMessageCount: 1 }; expect((await f.session.parkReady()).ready).toBe(false); f.transport.state = {};
    f.setPark({ ready: false, reasons: ["attached child"] }); expect((await f.session.parkReady()).reasons).toContain("attached child");
    f.setStop({ settled: [], uncertain: ["child-uncertain"] }); await expect(f.session.close()).rejects.toThrow(/uncertain|cleanup/i); expect(f.transport.closed).toBe(true); expect(f.transport.order.indexOf("ipc:stop_children")).toBeLessThan(f.transport.order.indexOf("physical_close"));
  });
});

describe.skipIf(!process.env.PI_TEST_BINARY)("real Pi semantic roundtrip", () => {
  it.each(["source", "official-cjs"] as const)("executes %s native registered semantic tool over host Unix IPC then refuses replay at idle", async layout => {
    const Driver = layout === "official-cjs" ? (await packagedDriver()).Driver : PiRpcDriver;
    const root = await mkdtemp(join(tmpdir(), "pi-real-c2-")); await mkdir(join(root, "workspace")); const requests: unknown[] = []; let effects = 0; let captured: unknown; let initial!: Record<string, any>; let native!: PiRpcTransport; const privateCommands: string[] = []; const nativeRecords: PiRpcRecord[] = [];
    const server: HttpServer = httpServer((req, res) => { let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; }); req.on("end", () => { requests.push(JSON.parse(body)); const first = requests.length === 1; res.writeHead(200, { "content-type": "text/event-stream" }); const chunks = first ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "native-semantic", type: "function", function: { name: "context", arguments: "{}" } }] }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }] : [{ choices: [{ index: 0, delta: { content: "roundtrip complete" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }]; for (const chunk of chunks) res.write(`data: ${JSON.stringify({ id: `faux-${requests.length}`, object: "chat.completion.chunk", ...chunk })}\n\n`); res.end("data: [DONE]\n\n"); }); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }); const address = server.address(); if (!address || typeof address === "string") throw new Error("bind");
    const session = await new Driver({ bindRequest: async (path, command, options) => { privateCommands.push(command.type); return sendPiBindRequest(path, command, options); }, command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), dynamicTools: [tool], dynamicToolHandler: async call => { ++effects; captured = { ...call, signal: undefined }; return { contentItems: [{ type: "inputText", text: "HOST_SEMANTIC_OK" }], success: true }; }, environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "local-faux-only" }, transportFactory: options => { initial = JSON.parse(readFileSync(options.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8")); native = new PiRpcTransport(options); const stream = native.events.bind(native); native.events = () => ({ async *[Symbol.asyncIterator]() { for await (const event of stream()) { nativeRecords.push(structuredClone(event)); yield event; } } }); return native; }, shutdownTimeoutMs: 1000 }).openSession({ runId: "real-run", normalizedSessionId: "real-host", workingDirectory: join(root, "workspace") }) as PiRpcHarnessSession;
    cleanups.push(() => session.close()); const events: PrpEvent[] = []; const iterator = session.events()[Symbol.asyncIterator](); await session.startTurn({ message: { role: "user", text: "call context" } });
    for (;;) { const next = await iterator.next(); if (next.done) throw new Error("early close"); events.push(next.value); if (next.value.eventType === "turn.failed") throw new Error(JSON.stringify(next.value)); if (next.value.eventType === "turn.completed") break; }
    expect(privateCommands.filter(type => type === "bind" || type === "begin_turn")).toEqual([]);
    expect((await native.request("prompt", { message: "unsolicited idle prompt" })).data).toMatchObject({ disposition: "handled" }); expect(requests).toHaveLength(2);
    expect(effects).toBe(1); expect(JSON.stringify(requests[1])).toContain("HOST_SEMANTIC_OK"); expect(captured).toMatchObject({ runId: "real-run", turnId: initial.turnId, callId: "native-semantic" });
    await expect(sendPiToolRequest(initial.toolSocketPath, { schema: 1, type: "tool_call", nonce: "replay", sessionId: "real-host", origin: { epoch: 1, runId: "real-run", turnId: initial.turnId }, toolCallId: "native-semantic", tool: "context", arguments: {} })).rejects.toThrow(); expect(await session.parkReady()).toEqual({ ready: true, reasons: [] });
    const snapshot = await session.snapshot(); await writeFile(join(root, "proof.json"), JSON.stringify({ requests, events, captured, snapshot, pid: native.pid, privateCommands }, null, 2)); expect(await readFile(snapshot.sessionFile, "utf8")).toContain("HOST_SEMANTIC_OK"); console.log(`LIVE_C2_PROOF ${join(root, "proof.json")}`); await session.close(); expect(session.processExited()).toBe(true); await writeFile(join(root, "native-records.jsonl"), nativeRecords.map(event => JSON.stringify(event)).join("\n") + "\n");
  }, 30000);
});
