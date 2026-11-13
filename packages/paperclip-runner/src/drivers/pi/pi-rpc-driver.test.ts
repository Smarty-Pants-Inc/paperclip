import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCapabilityRunnerdProviderEnvironment } from "../../live/runnerd-codex-transport.js";
import { mapPiRpcRecord, PiRpcDriver } from "./pi-rpc-driver.js";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { createPiRpcAppServerProxy } from "../../cli/pi-rpc-app-server-proxy.js";
import * as piTurnImages from "./pi-turn-images.js";
import { bindContent, type PiBindCommand } from "./pi-bind-protocol.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { questionSetSchema, requestSchema } from "../../protocol/generated/schema-bundle.js";

// Keep reason: recorded large-output incident439 and failure attribution across
// resident runs. Drive the real session pump rather than a projector surrogate.
class FailureTransport {
  closed = false;
  exited = false;
  pid = null;
  wake?: () => void;
  queue: PiRpcRecord[] = [];
  failure?: Error;
  requests: Array<{ type: string; input?: PiRpcRecord }> = [];
  ui: PiRpcRecord[] = [];
  async sendExtensionUiResponse(response: PiRpcRecord) { this.ui.push(structuredClone(response)); }
  promptDisposition = "started";
  onPrompt?: () => void;
  async request(type: string, input?: PiRpcRecord) {
    this.requests.push({ type, input });
    if (type === "prompt") this.onPrompt?.();
    return { data: type === "get_state" ? { sessionId: "native-session", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
      : type === "get_available_thinking_levels" ? { levels: ["high"] }
      : type === "prompt" ? { disposition: this.promptDisposition } : type === "steer" ? { disposition: "queued" } : undefined };
  }
  send(value: PiRpcRecord) { this.queue.push(value); this.wake?.(); }
  fail(error: Error) { this.failure = error; this.wake?.(); }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const value = this.queue.shift();
      if (value) { yield value; continue; }
      if (this.failure) throw this.failure;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}
const flushFailure = () => new Promise<void>(resolve => setImmediate(resolve));
async function failureFixture(capture = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-failure-"));
  const transport = new FailureTransport();
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "runtime"), model: "neutral/model", piRpcThinkingLevel: "high", environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport })
    .openSession({ runId: "run-old", normalizedSessionId: "normalized", workingDirectory: root });
  const events: PrpEvent[] = [];
  const drained = capture ? (async () => { try { for await (const event of session.events()) events.push(event); } catch { /* terminal message must precede iterator rejection */ } })() : Promise.resolve();
  return { session, transport, events, async close() { await session.close({ reason: "unit cleanup" }); await drained; await rm(root, { recursive: true, force: true }); } };
}

async function inputProxyFixture() {
  const f = await failureFixture(false); const frames: PiRpcRecord[] = [];
  const proxy = createPiRpcAppServerProxy({ stdout: { write(frame) { frames.push(JSON.parse(frame)); return true; }, once() {} },
    environment: { PAPERCLIP_RUN_ID: "run-old" }, createDriver: () => ({ async descriptor() { throw new Error("unused"); }, async openSession() { return f.session; } }) });
  let nextId = 0;
  const request = async (method: string, params: PiRpcRecord = {}) => {
    const id = ++nextId; proxy.acceptLine(JSON.stringify({ id, method, params }));
    await vi.waitFor(() => expect(frames.some(frame => frame.id === id)).toBe(true));
    return frames.find(frame => frame.id === id)! as { result?: any; error?: { message: string } };
  };
  await request("thread/start", { model: "neutral/model" });
  return { ...f, frames, request, async close() { await proxy.close(); await f.close(); } };
}
describe("PiRpcDriver", () => {
  it("drains failed direct-env admission timings without requiring a turn or session close", async () => {
    const f = await failureFixture();
    const request = f.transport.request.bind(f.transport);
    f.transport.request = async (type, input) => {
      const response = await request(type, input);
      return type === "get_state" ? { data: { ...response.data, model: { provider: "neutral", id: "wrong" } } } : response;
    };
    try {
      await expect(f.session.startTurn({ message: { role: "user", text: "must not start" } })).rejects.toThrow(/model/);
      await flushFailure();
      const timings = f.events.filter(event => event.payload.code === "provider_performance_spans");
      expect(timings).toHaveLength(1);
      expect(timings[0]).toMatchObject({ runId: "run-old" });
      expect(timings[0]!.turnId).toBeUndefined();
      expect(timings[0]!.payload.spans).toEqual(expect.arrayContaining([expect.objectContaining({ name: "runner.pi.admission.get_state" })]));
      expect(f.events.some(event => event.eventType === "turn.started")).toBe(false);
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["native", "data-url", "mixed-native", "mixed-data-url"])("passes %s images through the facade into prompt and steer RPC images", async shape => {
    const f = await inputProxyFixture();
    const image = shape.endsWith("native") ? { type: "image", data: "aGVsbG8=", mimeType: "image/png" } : { type: "image", url: "data:image/png;base64,aGVsbG8=" };
    const input = [...(shape.startsWith("mixed") ? [{ type: "text", text: "look" }] : []), image];
    const expected = { message: shape.startsWith("mixed") ? "look" : "", images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };
    try {
      const started = await f.request("turn/start", { input }); expect(started.error).toBeUndefined();
      expect(f.transport.requests.find(req => req.type === "prompt")?.input).toEqual(expected);
      const steered = await f.request("turn/steer", { expectedTurnId: started.result.turn.id, input }); expect(steered.error).toBeUndefined();
      expect(f.transport.requests.find(req => req.type === "steer")?.input).toEqual(expected);
    } finally { await f.close(); }
  });
  it.each([[], [null], [{ type: "audio", text: "not text input" }], [{ type: "image", url: "https://example.invalid/image.png" }], [{ type: "localImage", path: "/not-read.png" }], [{ type: "image", data: "not base64!", mimeType: "image/png" }], [{ type: "image", url: "data:image/png;base64," }]].map(input => ({ input })))("refuses unmappable input $input only for that prompt or steer, never sending an empty prompt", async ({ input }) => {
    const f = await inputProxyFixture();
    try {
      expect((await f.request("turn/start", { input })).error?.message).toMatch(/Pi.*input/i);
      expect(f.transport.requests.filter(req => req.type === "prompt")).toEqual([]);
      expect(f.transport.closed).toBe(false);
      const started = await f.request("turn/start", { input: [{ type: "text", text: "valid next prompt" }] }); expect(started.error).toBeUndefined();
      expect((await f.request("turn/steer", { expectedTurnId: started.result.turn.id, input })).error?.message).toMatch(/Pi.*input/i);
      expect(f.transport.requests.filter(req => req.type === "steer")).toEqual([]);
      expect((await f.request("turn/steer", { expectedTurnId: started.result.turn.id, input: [{ type: "text", text: "valid steer" }] })).error).toBeUndefined();
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });
  it.each([undefined, "", "unknown"])("does not retire an idle session for interrupt turnId=%s", async turnId => {
    const f = await failureFixture();
    try {
      await f.session.interrupt!({ turnId });
      expect(f.transport.closed).toBe(false);
      await expect(f.session.startTurn({ message: { role: "user", text: "still usable" } })).resolves.toHaveProperty("turnId");
    } finally { await f.close(); }
  });
  it.each(["interrupt", "failure"])("reuses warm Pi after interrupt or replaces failed Pi (%s), then completes the next turn through the facade", async mode => {
    const first = await failureFixture(false), second = await failureFixture(false);
    const firstRequest = first.transport.request.bind(first.transport);
    first.transport.request = async (type, input) => {
      if (type === "abort") { first.transport.send({ type: "agent_end", messages: [] }); first.transport.send({ type: "agent_settled", aborted: true }); }
      return firstRequest(type, input);
    };
    const frames: string[] = []; let opens = 0;
    const proxy = createPiRpcAppServerProxy({ stdout: { write(frame) { frames.push(frame); return true; }, once() {} },
      environment: { PAPERCLIP_RUN_ID: "run-old" }, createDriver: () => ({ async descriptor() { throw new Error("unused"); },
        async openSession() { return opens++ === 0 ? first.session : second.session; } }) });
    const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
      proxy.acceptLine(JSON.stringify({ id, method, params }));
      await vi.waitFor(() => expect(frames.map(frame => JSON.parse(frame)).some(frame => frame.id === id)).toBe(true));
      return frames.map(frame => JSON.parse(frame)).find(frame => frame.id === id);
    };
    try {
      await request(1, "thread/start", { model: "neutral/model" });
      const firstTurn = await request(2, "turn/start", { input: [{ text: "first" }] });
      first.transport.send({ type: "agent_start" }); await flushFailure();
      if (mode === "interrupt") {
        expect((await request(3, "turn/interrupt", { turnId: firstTurn.result.turn.id })).error).toBeUndefined();
        expect(first.transport.closed).toBe(false);
        expect(first.transport.requests.map(req => req.type)).toEqual(expect.arrayContaining(["clear_queue", "abort"]));
      }
      else { first.transport.send({ type: "process_exit", code: 1 }); await vi.waitFor(() => expect(first.transport.closed).toBe(true)); }
      await flushFailure();
      const opened = await request(4, "thread/start", { model: "neutral/model" }); expect(opened.error).toBeUndefined();
      expect(opens).toBe(mode === "interrupt" ? 1 : 2);
      const next = await request(5, "turn/start", { input: [{ text: "next" }] }); expect(next.error).toBeUndefined();
      const active = mode === "interrupt" ? first : second;
      active.transport.send({ type: "agent_start" });
      const message = { role: "assistant", responseId: "next", provider: "neutral", model: "model", content: [{ type: "text", text: "next Pi answer" }], stopReason: "stop" };
      active.transport.send({ type: "message_start", message }); active.transport.send({ type: "message_end", message }); active.transport.send({ type: "agent_settled" });
      await vi.waitFor(() => expect(frames.map(frame => JSON.parse(frame)).some(frame => frame.method === "turn/completed" && frame.params.turnId === next.result.turn.id)).toBe(true));
    } finally { await proxy.close(); await first.close(); await second.close(); }
  });
  // Keep: D2 real setup failure hid Pi 1.5.2 provider errors as empty answers.
  it.each(["error", "aborted", "later-empty", "agent-end", "stream-error", "retry-exhausted"])("keeps Pi 1.5.2 %s records as provider errors without requiring errorMessage", async shape => {
    const f = await failureFixture();
    try {
      const turn = await f.session.startTurn({ message: { role: "user", text: "provider failure" } });
      f.transport.send({ type: "agent_start" });
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const message = { role: "assistant", api: "openai-completions", provider: "neutral", model: "model", timestamp: 1,
        content: [], usage, stopReason: shape === "aborted" ? "aborted" : "error" };
      if (shape === "agent-end") f.transport.send({ type: "agent_end", messages: [message], willRetry: false });
      else {
        f.transport.send({ type: "message_start", message });
        if (shape === "stream-error") f.transport.send({ type: "message_update", usage, assistantMessageEvent: { type: "error", reason: "error", error: message } });
        else if (shape === "retry-exhausted") f.transport.send({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" });
        else f.transport.send({ type: "message_end", message });
        if (["later-empty", "stream-error", "retry-exhausted"].includes(shape)) {
          const empty = { ...message, timestamp: 2, stopReason: "stop" };
          f.transport.send({ type: "message_start", message: empty });
          f.transport.send({ type: "message_end", message: empty });
        }
      }
      f.transport.send({ type: "agent_settled", aborted: false });
      await flushFailure();
      const terminal = f.events.find(event => event.eventType === "turn.failed");
      expect(terminal).toMatchObject({ turnId: turn.turnId, payload: { error: { code: "pi_provider_error", message: expect.any(String) } } });
      if (shape === "retry-exhausted") expect(terminal?.payload).toMatchObject({ error: { message: "529 overloaded" } });
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });
  it("forwards Pi provider error items and the last errorMessage on turn/failed", async () => {
    const f = await failureFixture(false); const frames: string[] = [];
    const proxy = createPiRpcAppServerProxy({ stdout: { write(frame) { frames.push(frame); return true; }, once() {} },
      environment: { PAPERCLIP_RUN_ID: "run-old" }, createDriver: () => ({ async descriptor() { throw new Error("unused"); }, async openSession() { return f.session; } }) });
    try {
      proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { model: "neutral/model" } })); await flushFailure();
      proxy.acceptLine(JSON.stringify({ id: 2, method: "turn/start", params: { input: [{ text: "work" }] } })); await flushFailure();
      f.transport.send({ type: "agent_start" });
      for (const [id, errorMessage] of [["first", "earlier provider error"], ["last", "Provider context window exceeded: 321 > 123"]]) {
        const message = { role: "assistant", id, responseId: id, provider: "neutral", model: "model", content: [], stopReason: "error", errorMessage, usage: {} };
        f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message });
      }
      f.transport.send({ type: "agent_settled", aborted: false }); await flushFailure();
      const decoded = frames.map(frame => JSON.parse(frame));
      expect(decoded.filter(frame => frame.method === "item/failed")).toHaveLength(2);
      expect(decoded.find(frame => frame.method === "turn/failed")?.params).toMatchObject({ turn: { error: { message: "Provider context window exceeded: 321 > 123" } } });
      expect(f.transport.closed).toBe(false);
    } finally { await proxy.close(); await f.close(); }
  });
  it("refuses a corrupt staged image only for that request and then accepts image-only prompt and steer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-staged-request-"));
    const path = join(root, "image");
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const input = [{ type: "localImage", path }];
    const f = await inputProxyFixture();
    try {
      await writeFile(path, "%PDF-1.7\n");
      expect((await f.request("turn/start", { input })).error?.message).toMatch(/Pi image input/);
      expect(f.transport.requests.filter(req => req.type === "prompt")).toEqual([]);
      expect(f.frames.some(frame => frame.method === "turn/started" || frame.method === "turn/failed")).toBe(false);
      expect(f.transport.closed).toBe(false);
      await writeFile(path, png);
      const started = await f.request("turn/start", { input }); expect(started.error).toBeUndefined();
      const expected = { message: "", images: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      expect(f.transport.requests.find(req => req.type === "prompt")?.input).toEqual(expected);
      await writeFile(path, "%PDF-1.7\n");
      expect((await f.request("turn/steer", { expectedTurnId: started.result.turn.id, input })).error?.message).toMatch(/Pi image input/);
      expect(f.transport.requests.filter(req => req.type === "steer")).toEqual([]);
      expect(f.frames.some(frame => frame.method === "turn/failed")).toBe(false);
      expect(f.transport.closed).toBe(false);
      await writeFile(path, png);
      expect((await f.request("turn/steer", { expectedTurnId: started.result.turn.id, input })).error).toBeUndefined();
      expect(f.transport.requests.find(req => req.type === "steer")?.input).toEqual(expected);
    } finally { await f.close(); await rm(root, { recursive: true, force: true }); }
  });
  it("does not send a late prompt when image preparation outlives close", async () => {
    const fixture = await failureFixture();
    let release!: (message: { message: string }) => void;
    let began!: () => void;
    const reading = new Promise<void>(resolve => { began = resolve; });
    const held = new Promise<{ message: string }>(resolve => { release = resolve; });
    const imageRead = vi.spyOn(piTurnImages, "piTurnImageInput").mockImplementationOnce(() => { began(); return held; });
    const requests = vi.spyOn(fixture.transport, "request");
    const started = fixture.session.startTurn({ message: { role: "user", text: "Inspect staged PNG", localImagePaths: ["/runner/image.png"] } })
      .then(() => null, error => error);
    try {
      await reading;
      await fixture.session.close();
      release({ message: "Inspect staged PNG" });
      expect(await started).toBeInstanceOf(Error);
      expect(requests.mock.calls.some(([type]) => type === "prompt")).toBe(false);
    } finally {
      release({ message: "Inspect staged PNG" });
      await started;
      imageRead.mockRestore();
      requests.mockRestore();
      await fixture.close();
    }
  });

  it("does not inherit ambient AGENT_HOME when server omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-home-ambient-"));
    vi.stubEnv("AGENT_HOME", root);
    let launched: NodeJS.ProcessEnv | undefined;
    const environment = createCapabilityRunnerdProviderEnvironment({ provider: "pi_rpc", options: {},
      identity: { runnerInstanceId: "runner", environmentLeaseId: "lease", runId: "home", normalizedSessionId: "home", turnId: "turn", itemId: "item" },
      codexHome: root, runtimeContextPath: join(root, "context.json"), hasRuntimeContext: false });
    const transport = new FailureTransport();
    try {
      const session = await new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
        environment: { ...environment, PI_CODING_AGENT_DIR: join(root, "agent"), NODE_COMPILE_CACHE: "/tmp/node-compile-cache", NODE_DISABLE_COMPILE_CACHE: "0" },
        transportFactory: options => { launched = options.env; return transport as unknown as PiRpcTransport; },
      }).openSession({ runId: "home", normalizedSessionId: "home", workingDirectory: root });
      try {
        expect(launched?.AGENT_HOME).toBeUndefined();
        expect(launched?.NODE_COMPILE_CACHE).toBe(join(root, "sessions/node-compile-cache"));
        expect(launched?.NODE_DISABLE_COMPILE_CACHE).toBeUndefined();
      } finally { await session.close(); }
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});

async function dialogFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-dialog-"));
  const transport = new class extends FailureTransport {
    override async request(type: string) {
      return { data: type === "get_state" ? { sessionId: "native-dialog", model: { provider: "paperclip", id: "faux" }, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
        : type === "set_model" ? { provider: "paperclip", id: "faux" }
        : type === "get_available_models" ? { models: [{ provider: "paperclip", id: "faux", contextWindow: 200000 }] }
        : type === "get_available_thinking_levels" ? { levels: ["off"] }
        : type === "prompt" ? { disposition: "started" } : undefined };
    }
  }();
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "runtime"), model: "paperclip/faux", piRpcThinkingLevel: "off",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    transportFactory: () => transport as unknown as PiRpcTransport,
    bindRequest: (async (_path: string, command: PiBindCommand) => command.type === "bind"
      ? { schema: 1, type: "bind", nonce: command.nonce, sessionId: command.sessionId, epoch: command.epoch, runId: command.runId, provider: command.provider.name, model: command.model, thinkingLevel: command.thinkingLevel, ...bindContent(command) }
      : command.type === "stop_children" ? { ...command, settled: [], uncertain: [] } : { ...command, ack: true }) as never,
  }).openSession({ runId: "run-dialog", normalizedSessionId: "dialog", workingDirectory: root });
  const events: PrpEvent[] = [];
  const drained = (async () => { for await (const event of session.events()) events.push(event); })();
  const turn = await session.startTurn({ message: { role: "user", text: "ask" } });
  transport.send({ type: "agent_start" }); await flushFailure();
  return { root, transport, session, events, turn, async close() { await session.close({ reason: "unit cleanup" }); await drained; await rm(root, { recursive: true, force: true }); } };
}

describe("Pi canonical SDK dialogs", () => {
  it.each([
    { method: "select", fields: { options: ["Alpha", "Beta"] }, answer: { selectedOptionIds: ["option-2"] }, reply: { value: "Beta" } },
    { method: "confirm", fields: { message: "Continue?" }, answer: { selectedOptionIds: ["no"] }, reply: { confirmed: false } },
    { method: "input", fields: { placeholder: "Type here" }, answer: { text: "hello\nworld" }, reply: { value: "hello\nworld" } },
    { method: "editor", fields: { prefill: "old\ntext" }, answer: { text: "new\ntext\n" }, reply: { value: "new\ntext\n" } },
  ])("normalizes genuine unannotated SDK $method and returns its exact native reply", async ({ method, fields, answer, reply }) => {
    const f = await dialogFixture();
    try {
      f.transport.send({ type: "extension_ui_request", id: "sdk-id", method, title: "Choose", ...fields });
      await vi.waitFor(() => expect(f.events.some(e => e.eventType === "runtime_request.created")).toBe(true), { timeout: 500 });
      const request = f.events.find(e => e.eventType === "runtime_request.created")!.payload.request as Record<string, any>;
      expect(request).toMatchObject({ schema: "paperclip.runtime_request.v2", requestKind: "runtime", type: "input", origin: { adapter: "pi-rpc", provider: "pi_rpc", method: "extension_ui_request" } });
      expect(Object.keys(request.origin).sort()).toEqual(["adapter", "method", "provider"]);
      const ajv = new Ajv2020({ strict: true, strictRequired: false });
      ajv.addSchema(questionSetSchema);
      const validate = ajv.compile(requestSchema); expect(validate(request), JSON.stringify(validate.errors)).toBe(true);
      expect(ajv.compile(questionSetSchema)(request.input)).toBe(true);
      if (method === "editor") expect(request.input.questions[0].initialText).toBe("old\ntext");
      await f.session.resolveRuntimeRequest!({ requestId: request.requestId, turnId: f.turn.turnId, runId: "run-dialog", origin: request.origin,
        resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: answer } } } } as never);
      expect(f.transport.ui).toEqual([{ id: "sdk-id", ...reply }]);
      expect(f.events.some(e => e.eventType === "runtime_request.resolved")).toBe(true);
    } finally { await f.close(); }
  });

  it("preserves an accepted dialog wait without fabricating an assistant answer (F5)", async () => {
    const f = await dialogFixture();
    try {
      f.transport.send({ type: "extension_ui_request", id: "wait", method: "input", title: "Your answer?" });
      const message = { role: "assistant", responseId: "empty-wait", timestamp: 1, provider: "paperclip", model: "faux", content: [], usage: {}, stopReason: "stop" };
      f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message });
      f.transport.send({ type: "agent_settled", aborted: false });
      await vi.waitFor(() => expect(f.events.some(e => e.eventType === "turn.completed")).toBe(true));
      expect(f.events.some(e => e.eventType === "runtime_request.created")).toBe(true);
      expect(f.events.some(e => e.payload.kind === "agentMessage" && String(e.payload.text ?? "").trim())).toBe(false);
    } finally { await f.close(); }
  });

  it("does not treat a refused dialog as an accepted wait (F5)", async () => {
    const f = await dialogFixture();
    try {
      f.transport.send({ type: "extension_ui_request", id: "refused", method: "input" });
      const message = { role: "assistant", responseId: "empty-refused", timestamp: 1, provider: "paperclip", model: "faux", content: [], usage: {}, stopReason: "stop" };
      f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message });
      f.transport.send({ type: "agent_settled", aborted: false });
      await vi.waitFor(() => expect(f.events.some(e => e.eventType === "turn.failed")).toBe(true));
      expect(f.events.find(e => e.eventType === "turn.failed")?.payload).toMatchObject({ error: { code: "opencode_empty_response" } });
      expect(f.events.some(e => e.eventType === "runtime_request.created")).toBe(false);
    } finally { await f.close(); }
  });

  it("captures queued old SDK UI before settlement; late answers cannot borrow the warm run", async () => {
    const f = await dialogFixture();
    try {
      // Queue without yielding: native FIFO is UI -> old settlement. The
      // downstream controller may consume the saved UI only after warm attach.
      f.transport.send({ type: "extension_ui_request", id: "old-sdk", method: "input", title: "Old?" });
      const message = { role: "assistant", id: "old-done", responseId: "old-receipt", timestamp: 1, provider: "paperclip", model: "faux", content: [{ type: "text", text: "done" }], usage: {}, stopReason: "stop" };
      f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message }); f.transport.send({ type: "agent_settled" });
      await vi.waitFor(() => expect(f.events.some(e => e.eventType === "turn.completed")).toBe(true));
      const oldEvent = f.events.find(e => e.eventType === "runtime_request.created")!;
      expect(oldEvent).toMatchObject({ runId: "run-dialog", turnId: f.turn.turnId });
      const old = oldEvent.payload.request as Record<string, any>;
      const answer = { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { text: "late" } } } };
      f.transport.send({ type: "extension_ui_request", id: "idle-sdk", method: "input", title: "Idle?" });
      await vi.waitFor(() => expect(f.transport.ui).toContainEqual({ id: "idle-sdk", cancelled: true }));
      await f.session.attachRun!({ runId: "run-new" });
      const next = await f.session.startTurn({ message: { role: "user", text: "new" } }); f.transport.send({ type: "agent_start" }); await flushFailure();
      const writes = f.transport.ui.length;
      for (const runId of ["run-dialog", "run-new"]) await expect(f.session.resolveRuntimeRequest!({ requestId: old.requestId, runId, turnId: runId === "run-dialog" ? f.turn.turnId : next.turnId, origin: old.origin, resolution: answer } as never)).rejects.toThrow();
      expect(f.transport.ui).toHaveLength(writes);
      // Old explicit attribution never falls through into the new lifecycle.
      f.transport.send({ type: "extension_ui_request", id: "forged-sdk", method: "input", title: "Forged?", origin: { epoch: 1, runId: "run-dialog", turnId: f.turn.turnId } });
      f.transport.send({ type: "extension_ui_request", id: "new-sdk", method: "input", title: "New?" });
      await vi.waitFor(() => expect(f.events.filter(e => e.eventType === "runtime_request.created")).toHaveLength(2));
      const current = f.events.filter(e => e.eventType === "runtime_request.created")[1]!;
      expect(current).toMatchObject({ runId: "run-new", turnId: next.turnId });
      const request = current.payload.request as Record<string, any>;
      await f.session.resolveRuntimeRequest!({ requestId: request.requestId, runId: "run-new", turnId: next.turnId, origin: request.origin, resolution: answer } as never);
      expect(f.transport.ui).toContainEqual({ id: "new-sdk", value: "late" }); expect(f.transport.ui).toContainEqual({ id: "forged-sdk", cancelled: true });
      expect(f.transport.ui.some(value => value.id === "old-sdk")).toBe(false);
    } finally { await f.close(); }
  });

  it("keeps malformed frames, unknown choices, duplicate IDs and cross-run answers fail-closed", async () => {
    const f = await dialogFixture();
    try {
      for (const [id, fields] of Object.entries({ blank: { method: "input" }, badOptions: { method: "select", title: "Choose", options: [42] }, noMessage: { method: "confirm", title: "Confirm" }, badPrefill: { method: "editor", title: "Edit", prefill: {} } })) f.transport.send({ type: "extension_ui_request", id, ...fields });
      await vi.waitFor(() => expect(f.transport.ui).toHaveLength(4)); expect(f.events.filter(e => e.eventType === "runtime_request.created")).toEqual([]);
      f.transport.send({ type: "extension_ui_request", id: "choice", method: "select", title: "Choose", options: ["Same", "Same"] });
      await vi.waitFor(() => expect(f.events.some(e => e.eventType === "runtime_request.created")).toBe(true));
      const request = f.events.find(e => e.eventType === "runtime_request.created")!.payload.request as Record<string, any>;
      const input = { requestId: request.requestId, turnId: f.turn.turnId, runId: "run-dialog", origin: request.origin };
      for (const response of [
        { schema: "paperclip.question_response.v1", answers: { value: { selectedOptionIds: ["not-offered"] } } },
        { schema: "paperclip.question_response.v1", answers: { value: { selectedOptionIds: ["option-1", "option-2"] } } },
        { schema: "paperclip.question_response.v1", answers: { value: { text: "Same" } } },
        { schema: "paperclip.question_response.v1", answers: { unexpected: { text: "bad" } } },
      ]) await expect(f.session.resolveRuntimeRequest!({ ...input, resolution: { action: "submit", response } } as never)).rejects.toThrow();
      expect(f.transport.ui).toHaveLength(4);
      const resolution = { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { value: { selectedOptionIds: ["option-2"] } } } };
      await expect(f.session.resolveRuntimeRequest!({ ...input, runId: "wrong", resolution } as never)).rejects.toThrow();
      await f.session.resolveRuntimeRequest!({ ...input, resolution } as never); expect(f.transport.ui).toContainEqual({ id: "choice", value: "Same" });
      f.transport.send({ type: "extension_ui_request", id: "choice", method: "select", title: "Changed", options: ["Malicious"] }); await flushFailure();
      await expect(f.session.resolveRuntimeRequest!({ ...input, resolution } as never)).rejects.toThrow(); expect(f.transport.ui).toHaveLength(5); expect(f.events.filter(e => e.eventType === "runtime_request.created")).toHaveLength(1);
    } finally { await f.close(); }
  });
});

// Audit A's transport inputs, through the real session pump.
function auditToolRound(transport: FailureTransport, id: string, stamp: number, args: unknown = { path: "a" }, output = "ok") {
  const message = { role: "assistant", provider: "neutral", model: "model", timestamp: stamp, responseId: `response-${stamp}`, stopReason: "toolUse", content: [{ type: "toolCall", id, name: "read", arguments: args }] };
  const result = { role: "toolResult", toolCallId: id, toolName: "read", timestamp: stamp + 1, content: [{ type: "text", text: output }], isError: false };
  transport.send({ type: "message_start", message: { ...message, responseId: undefined, content: [] } });
  transport.send({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] } });
  transport.send({ type: "message_end", message });
  transport.send({ type: "tool_execution_start", toolCallId: id, toolName: "read", args });
  transport.send({ type: "tool_execution_end", toolCallId: id, toolName: "read", result, isError: false });
  transport.send({ type: "message_start", message: result });
  transport.send({ type: "message_end", message: result });
  transport.send({ type: "turn_end", message, toolResults: [result] });
  return [message, result];
}
function auditFinal(transport: FailureTransport, stamp: number, messages: unknown[] = []) {
  const message = { role: "assistant", provider: "neutral", model: "model", timestamp: stamp, responseId: `response-${stamp}`, stopReason: "stop", content: [{ type: "text", text: "done" }] };
  transport.send({ type: "message_start", message: { ...message, responseId: undefined, content: [] } });
  transport.send({ type: "message_end", message });
  transport.send({ type: "agent_end", messages: [...messages, message], willRetry: false });
  transport.send({ type: "agent_settled", aborted: false });
}

describe("PiRpcDriver P0 regressions", () => {
  it("P0-3 completes a 70KB write and the next prompt without closing Pi", async () => {
    const f = await failureFixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "write a large file" } });
      f.transport.send({ type: "agent_start" });
      auditFinal(f.transport, 100, auditToolRound(f.transport, "large-write", 1, { path: "big.txt", content: "y".repeat(70_000) }));
      await flushFailure();
      expect(f.events.filter(event => event.eventType.startsWith("turn.")).map(event => event.eventType)).toEqual(["turn.started", "turn.completed"]);
      expect(f.transport.closed).toBe(false);
      await f.session.startTurn({ message: { role: "user", text: "continue" } });
      f.transport.send({ type: "agent_start" }); auditFinal(f.transport, 200); await flushFailure();
      expect(f.events.filter(event => event.eventType === "turn.completed")).toHaveLength(2);
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
    } finally { await f.close(); }
  // Real-sized homogeneous argument previews exercise diagnostic redaction too.
  }, 30_000);
  it("P0-1 completes six 50KB reads despite agent_end carrying all results", async () => {
    const f = await failureFixture();
    try {
      const turn = await f.session.startTurn({ message: { role: "user", text: "read six files" } });
      f.transport.send({ type: "agent_start" });
      const messages = Array.from({ length: 6 }, (_, i) => auditToolRound(f.transport, `read-${i}`, i * 10 + 1, { path: `f${i}` }, "x".repeat(50_000))).flat();
      auditFinal(f.transport, 100, messages); await flushFailure();
      expect(f.events.filter(event => event.eventType.startsWith("turn.")).map(event => event.eventType)).toEqual(["turn.started", "turn.completed"]);
      expect(f.events.at(-1)).toMatchObject({ turnId: turn.turnId, payload: { status: "completed" } });
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  }, 30_000);
  it("P0-1 completes after a 300KB image tool result without closing Pi", async () => {
    const f = await failureFixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "read an image" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "image", toolName: "read", args: { path: "shot.png" } });
      const result = { role: "toolResult", toolCallId: "image", toolName: "read", timestamp: 1, content: [{ type: "image", data: "A".repeat(300_000), mimeType: "image/png" }] };
      f.transport.send({ type: "tool_execution_end", toolCallId: "image", toolName: "read", result, isError: false });
      f.transport.send({ type: "message_start", message: result }); f.transport.send({ type: "message_end", message: result });
      auditFinal(f.transport, 100, [result]); await flushFailure();
      expect(f.events.filter(event => event.eventType.startsWith("turn.")).map(event => event.eventType)).toEqual(["turn.started", "turn.completed"]);
      expect(f.events.some(event => event.eventType === "tool.execution.completed" && event.payload.status === "completed")).toBe(true);
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });
  it.each([true, false])("P0-2 replays Pi 1.5.2 auto-retry inside the admitted prompt (success=%s)", async success => {
    const f = await failureFixture();
    try {
      const turn = await f.session.startTurn({ message: { role: "user", text: "retry a transient failure" } });
      const records: PiRpcRecord[] = (await readFile(new URL("../../../test-fixtures/pi-rpc/retry-1.5.2.jsonl", import.meta.url), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(records.filter(record => record.type === "agent_start")).toHaveLength(2);
      for (const event of records.slice(records.findIndex(record => record.type === "agent_start"))) {
        if (event.type === "response") continue;
        if (!success && event.type === "message_end" && (event.message as Record<string, unknown>)?.stopReason === "stop") {
          f.transport.send({ ...event, message: { ...(event.message as Record<string, unknown>), stopReason: "error", errorMessage: "500 exhausted retries" } });
        } else if (!success && event.type === "auto_retry_end") f.transport.send({ ...event, success: false, finalError: "500 exhausted retries" });
        else f.transport.send(event);
      }
      await flushFailure();
      expect(f.events.filter(event => /^(turn\.(completed|failed|cancelled)|session\.failed)$/.test(event.eventType))).toMatchObject([{ eventType: success ? "turn.completed" : "turn.failed", turnId: turn.turnId }]);
      expect(f.transport.closed).toBe(false);
      await f.session.startTurn({ message: { role: "user", text: "next prompt" } });
      f.transport.send({ type: "agent_start" }); auditFinal(f.transport, 999); await flushFailure();
      expect(f.events.at(-1)).toMatchObject({ eventType: "turn.completed" });
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });
  it.each([false, true])("P0-2 still refuses unrequested agent_start (active duplicate=%s)", async active => {
    const f = await failureFixture();
    try {
      if (active) {
        await f.session.startTurn({ message: { role: "user", text: "one prompt only" } });
        f.transport.send({ type: "agent_start" });
      } else f.transport.send({ type: "auto_retry_start", attempt: 1 });
      f.transport.send({ type: "agent_start" }); await flushFailure();
      expect(f.events.find(event => event.eventType === "session.failed")?.payload.code).toBe("pi_unrequested_agent_start");
      expect(f.transport.closed).toBe(true);
    } finally { await f.close(); }
  });
  it("P0-4 admits 1400 assistant receipts inside one long prompt", async () => {
    const f = await failureFixture();
    try {
      const turn = await f.session.startTurn({ message: { role: "user", text: "one long real prompt" } });
      f.transport.send({ type: "agent_start" });
      for (let i = 0; i < 1400; i++) {
        const message = { role: "assistant", provider: "neutral", model: "model", id: `native-id-${i}`, responseId: `response-${i}`, timestamp: i + 1, content: i === 1399 ? [{ type: "text", text: "finished the long prompt" }] : [], stopReason: "stop", usage: {} };
        f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message });
      }
      f.transport.send({ type: "agent_end", messages: [], willRetry: false }); f.transport.send({ type: "agent_settled", aborted: false });
      await flushFailure();
      expect(f.events.filter(event => /^(turn\.(completed|failed)|session\.failed)$/.test(event.eventType))).toMatchObject([{ eventType: "turn.completed", turnId: turn.turnId }]);
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  }, 30_000);
  it("P0-4 releases identities across 2100 settled turns on the same warm Pi", async () => {
    const f = await failureFixture();
    try {
      for (let i = 0; i < 2100; i++) {
        const turn = await f.session.startTurn({ message: { role: "user", text: `prompt ${i}` } });
        f.transport.send({ type: "agent_start" }); auditFinal(f.transport, i + 1); await flushFailure();
        expect(f.events.at(-1)).toMatchObject({ eventType: "turn.completed", turnId: turn.turnId });
        expect(f.transport.closed).toBe(false);
      }
      expect(f.events.filter(event => event.eventType === "turn.completed")).toHaveLength(2100);
    } finally { await f.close(); }
  }, 30_000);
  it("P0-4 retains an unfinished tool's park blocker and rejects mixed-owner completion", async () => {
    const f = await failureFixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "old" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "old-pending", toolName: "read", args: { path: "a" } });
      auditFinal(f.transport, 1); await flushFailure();
      expect((await f.session.parkReady!()).reasons).toContain("pending tools");
      await f.session.startTurn({ message: { role: "user", text: "new" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "message_start", message: { role: "assistant", id: "new-message" } }); await flushFailure();
      f.transport.send({ type: "tool_execution_end", toolCallId: "old-pending", messageId: "new-message", toolName: "read", result: {} }); await flushFailure();
      expect((await f.session.parkReady!()).reasons).toContain("pending tools");
      f.transport.send({ type: "tool_execution_end", toolCallId: "old-pending", toolName: "read", result: {} }); await flushFailure();
      expect((await f.session.parkReady!()).reasons).not.toContain("pending tools");
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });
});

// Merge regression: K1 must supersede transient failure without losing K2 length classification.
describe("merged K1/K2 final assistant classification", () => {
  it.each([
    ["error", "stop", "completed"],
    ["error", "length", "failed"],
    ["length", "stop", "completed"],
    ["stop", "length", "failed"],
    ["stop", "error", "failed"],
    ["error", "aborted", "failed"],
  ] as const)("uses only %s -> %s at settlement (%s, K1/K2)", async (first, last, status) => {
    const f = await failureFixture();
    try {
      const turn = await f.session.startTurn({ message: { role: "user", text: "retry without a failure latch" } });
      for (const [index, stopReason] of [first, last].entries()) {
        const message = { role: "assistant", provider: "paperclip", model: "faux", timestamp: index + 1,
          responseId: `attempt-${index}`, content: [{ type: "text", text: `attempt ${index}: ${stopReason}` }], usage: {}, stopReason };
        f.transport.send({ type: "agent_start" });
        f.transport.send({ type: "message_start", message });
        f.transport.send({ type: "message_end", message });
        f.transport.send({ type: "agent_end", messages: [message], willRetry: index === 0 });
        await flushFailure();
        expect(f.events.filter(event => /^turn\.(completed|failed|cancelled)$/.test(event.eventType))).toEqual([]);
      }
      f.transport.send({ type: "agent_settled", aborted: false }); await flushFailure();
      const terminals = f.events.filter(event => /^turn\.(completed|failed|cancelled)$/.test(event.eventType));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({ eventType: `turn.${status}`, turnId: turn.turnId });
      if (last === "length") expect(terminals[0]?.payload).toMatchObject({ error: { code: "pi_output_truncated", recoverable: false } });
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });
});

describe("PiRpcDriver", () => {
  it.each([true, false])("keeps known old receipts on their original turn while handled input owns no new work (before ACK=%s, K4)", async beforeAck => {
    const f = await failureFixture();
    try {
      const old = await f.session.startTurn({ message: { role: "user", text: "old" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "old-tool", toolName: "bash", args: { command: "old" } });
      f.transport.send({ type: "message_start", message: { role: "assistant", id: "old-message" } });
      f.transport.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "old" } });
      f.transport.send({ type: "agent_settled", aborted: false });
      await flushFailure();
      const receipt = () => f.transport.send({ type: "tool_execution_end", toolCallId: "old-tool", toolName: "bash", result: { content: [{ type: "text", text: "late old receipt" }] } });
      f.transport.promptDisposition = "handled";
      if (beforeAck) f.transport.onPrompt = receipt;
      const handled = await f.session.startTurn({ message: { role: "user", text: "/handled" } });
      if (!beforeAck) receipt();
      await flushFailure();
      expect(f.events.find(event => event.eventType === "item.completed" && event.payload.output === "late old receipt")).toMatchObject({ turnId: old.turnId, runId: "run-old" });
      expect(f.events.some(event => event.turnId === handled.turnId && event.eventType.startsWith("item."))).toBe(false);
      expect(f.events.find(event => event.turnId === handled.turnId && event.eventType === "turn.completed")?.payload).toMatchObject({ outcome: "handled", modelOutput: false });
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
    } finally { await f.close(); }
  });
  it("projects a late outstanding tool terminal once on its old run without reviving work", async () => {
    const f = await failureFixture();
    try {
      const old = await f.session.startTurn({ message: { role: "user", text: "old" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "old-pending", toolName: "bash", args: { command: "old" } });
      auditFinal(f.transport, 1); await flushFailure();
      const itemId = f.events.find(event => event.turnId === old.turnId && event.eventType === "item.started")?.itemId;
      await f.session.attachRun!({ runId: "run-new" });
      const current = await f.session.startTurn({ message: { role: "user", text: "new" } });
      f.transport.send({ type: "agent_start" });
      // Reusing the retired ID cannot announce work for the new prompt.
      f.transport.send({ type: "tool_execution_start", toolCallId: "old-pending", toolName: "bash", args: { command: "new" } });
      const terminal = { type: "tool_execution_end", toolCallId: "old-pending", toolName: "bash", result: { content: [{ type: "text", text: "late old final" }] } };
      f.transport.send({ ...terminal, messageId: "unknown-extra-owner" });
      f.transport.send({ ...terminal, toolName: "read" }); await flushFailure();
      expect((await f.session.parkReady!()).reasons).toContain("pending tools");
      expect(f.events.some(event => event.payload.output === "late old final")).toBe(false);
      f.transport.send(terminal); f.transport.send(terminal); await flushFailure();
      expect(f.events.filter(event => event.eventType === "item.completed" && event.payload.output === "late old final")).toMatchObject([{ runId: "run-old", turnId: old.turnId, itemId }]);
      expect(f.events.filter(event => event.eventType === "tool.execution.completed" && event.payload.output === "late old final")).toHaveLength(1);
      expect(f.events.some(event => event.turnId === current.turnId && /^(item\.|tool\.execution\.)/.test(event.eventType))).toBe(false);
      expect((await f.session.parkReady!()).reasons).not.toContain("pending tools");
      auditFinal(f.transport, 2); await flushFailure();
      expect(f.events.at(-1)).toMatchObject({ eventType: "turn.completed", runId: "run-new", turnId: current.turnId });
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });

  it("opens a partial runtime context without granting an agent-files home", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-home-partial-"));
    const transport = new FailureTransport();
    let launched: NodeJS.ProcessEnv | undefined;
    try {
      const session = await new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
        runtimeContext: { skills: [] },
        environment: { PI_CODING_AGENT_DIR: join(root, "agent"), AGENT_HOME: "/controller/stale-copy", PAPERCLIP_PI_AGENT_HOME: "/caller/forged-copy" },
        transportFactory: options => { launched = options.env; return transport as unknown as PiRpcTransport; },
      }).openSession({ runId: "partial", normalizedSessionId: "partial", workingDirectory: root });
      try {
        expect(launched).toBeDefined();
        expect(launched?.AGENT_HOME).toBeUndefined();
        expect(launched?.PAPERCLIP_PI_AGENT_HOME).toBeUndefined();
      } finally { await session.close({ reason: "unit cleanup" }); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["registered", "controller-path", "unregistered", "legacy", "symlink", "overlap"] as const)("binds AGENT_HOME from the authenticated runtime context, never env (%s)", async mode => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-home-"));
    const home = join(root, "instruction-copy"); await mkdir(home);
    const runtime = join(root, "sessions"); await mkdir(runtime);
    const link = join(root, "linked-copy"); if (mode === "symlink") await symlink(home, link);
    const rootPath = mode === "overlap" ? runtime : mode === "symlink" ? link : home;
    let launched: NodeJS.ProcessEnv | undefined;
    const transport = new FailureTransport();
    const opening = new PiRpcDriver({ runtimeDirectory: runtime, model: "neutral/model", piRpcThinkingLevel: "high",
      environment: { PI_CODING_AGENT_DIR: join(root, "agent"), ...(mode === "registered" ? {} : { AGENT_HOME: "/controller/stale-copy", PAPERCLIP_PI_AGENT_HOME: "/caller/forged-copy" }) },
      ...(mode === "unregistered" ? {} : { runtimeContext: { instructions: { workingCopy: { ...(mode === "legacy" ? {} : { kind: "agent_files" }), rootPath, entryPath: "AGENTS.md" } }, skills: [] } }),
      transportFactory: options => { launched = options.env; return transport as unknown as PiRpcTransport; },
    }).openSession({ runId: "home", normalizedSessionId: "home", workingDirectory: root });
    try {
      if (mode === "symlink" || mode === "overlap") {
        await expect(opening).rejects.toThrow(mode === "symlink" ? "real directory" : "overlaps");
        expect(launched).toBeUndefined();
      } else {
        const session = await opening;
        try {
          const expected = mode === "registered" || mode === "controller-path" ? home : undefined;
          expect(launched?.AGENT_HOME).toBe(expected);
          expect(launched?.PAPERCLIP_PI_AGENT_HOME).toBe(expected);
        } finally { await session.close({ reason: "unit cleanup" }); }
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("replays >4096 updates, >4MiB cumulative output and a >256KiB terminal through driver/projector/proxy without mutating native final", async () => {
    const f = await failureFixture(false);
    const frames: string[] = [];
    const proxy = createPiRpcAppServerProxy({ stdout: { write(frame) { frames.push(frame); return true; }, once() {} }, environment: { PAPERCLIP_RUN_ID: "run-old" }, createDriver: () => ({ async descriptor() { throw new Error("unused"); }, async openSession() { return f.session; } }) });
    try {
      proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { model: "neutral/model" } }));
      await flushFailure();
      proxy.acceptLine(JSON.stringify({ id: 2, method: "turn/start", params: { input: [{ text: "find and cat" }] } }));
      await flushFailure();
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "bulk", toolName: "bash", args: { command: "find . -type f -exec cat {} +" } });
      for (let i = 0; i < 4100; i++) {
        f.transport.send({ type: "tool_execution_update", toolCallId: "bulk", toolName: "bash", partialResult: { content: [{ type: "text", text: `${i}:` + "x".repeat(1100) }] } });
        if (i % 100 === 0) await flushFailure();
      }
      const finalText = "NATIVE_FINAL_" + "f".repeat(49_750);
      const nativeFinal = { content: [{ type: "text", text: finalText }], details: { fullOutputPath: "/native/spill", structuredContent: { output: "raw".repeat(400_000) } } };
      const original = JSON.stringify(nativeFinal);
      f.transport.send({ type: "tool_execution_end", toolCallId: "bulk", toolName: "bash", result: nativeFinal });
      await flushFailure();
      const decoded = frames.map(frame => JSON.parse(frame));
      expect(decoded.some(frame => frame.method === "turn/failed" || frame.method === "error")).toBe(false);
      expect(decoded.some(frame => frame.method === "item/completed" && frame.params.output === finalText)).toBe(true);
      expect(JSON.stringify(nativeFinal)).toBe(original);
      for (const frame of frames) expect(Buffer.byteLength(frame)).toBeLessThan(16 * 1024 * 1024);
    } finally { await proxy.close(); await f.close(); }
  // Real-sized 4100-update replay and digest/redaction work exceeds Vitest's 5s default on shared hosts.
  }, 20_000);

  it.each([true, false])("publishes the underlying iterator failure before drain (active=%s)", async active => {
    const f = await failureFixture();
    try {
      const turn = active ? await f.session.startTurn({ message: { role: "user", text: "work" } }) : undefined;
      f.transport.fail(new Error("connect ECONNREFUSED 127.0.0.1:49999"));
      await flushFailure();
      const failure = f.events.find(event => event.eventType === (active ? "turn.failed" : "session.failed"));
      expect(failure).toMatchObject({ runId: "run-old", normalizedSessionId: "normalized", ...(turn ?? {}), payload: active ? { error: { code: "pi_rpc_transport_failed", message: "connect ECONNREFUSED 127.0.0.1:49999" } } : { code: "pi_rpc_transport_failed", message: "connect ECONNREFUSED 127.0.0.1:49999" } });
    } finally { await f.close(); }
  });

  it.each([true, false])("P0-4 refuses stale callbacks after releasing the completed projector (stale=%s)", async oldFails => {
    const f = await failureFixture();
    try {
      const old = await f.session.startTurn({ message: { role: "user", text: "old" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "old-tool", toolName: "bash", args: { command: "old" } });
      f.transport.send({ type: "message_start", message: { role: "assistant", id: "old-message" } });
      f.transport.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "old" } });
      f.transport.send({ type: "agent_settled", aborted: false });
      await flushFailure();
      await f.session.attachRun!({ runId: "run-new" });
      const current = await f.session.startTurn({ message: { role: "user", text: "new" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "current-tool", toolName: "bash", args: { command: "new" } });
      if (!oldFails) f.transport.send({ type: "tool_execution_update", toolCallId: "old-tool", toolName: "bash", partialResult: { content: [{ type: "text", text: "late old" }] } });
      f.transport.send({ type: "tool_execution_end", toolCallId: oldFails ? "old-tool" : "current-tool", toolName: "read", result: { content: [{ type: "text", text: "conflicting native tool name" }] } });
      await flushFailure();
      const failure = f.events.find(event => event.eventType === "session.failed");
      if (oldFails) {
        expect(failure).toBeUndefined();
        expect(f.events.some(event => event.turnId === current.turnId && event.payload.output === "late old")).toBe(false);
        auditFinal(f.transport, 777); await flushFailure();
        expect(f.events.at(-1)).toMatchObject({ eventType: "turn.completed", runId: "run-new", turnId: current.turnId });
        expect(f.transport.closed).toBe(false);
      } else expect(failure).toMatchObject({ runId: "run-new", turnId: current.turnId, payload: { code: "pi_rpc_transport_failed", message: "pi_projection_tool_name_changed" } });
      expect(f.events.some(event => event.turnId === old.turnId && event.eventType === "turn.completed")).toBe(true);
    } finally { await f.close(); }
  });

  it("retains transport_error.message on the normalized terminal", async () => {
    const f = await failureFixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "transport_error", message: "Pi RPC record exceeded 4194304 bytes" });
      await flushFailure();
      expect(f.events.find(event => event.eventType === "turn.failed")?.payload).toMatchObject({ error: { code: "pi_rpc_transport_failed", message: "Pi RPC record exceeded 4194304 bytes" } });
    } finally { await f.close(); }
  });

  it.each(["normal", "\\u0000\\u0001\\n\\\"\\\\", "😀漢字"])("bounds only large projected partial text (%s), retaining raw and final receipts", async alphabet => {
    const f = await failureFixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "tool", toolName: "bash", args: { command: "find . -type f -exec cat {} +" } });
      const body = alphabet.repeat(Math.ceil(3 * 1024 * 1024 / alphabet.length));
      const partial = { type: "tool_execution_update", toolCallId: "tool", toolName: "bash", partialResult: { content: [{ type: "text", text: body }] } };
      f.transport.send(partial);
      await flushFailure();
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      const projected = f.events.find(event => event.eventType === "item.delta" && typeof event.payload.output === "string");
      expect(projected?.payload.output).toContain("[Pi tool output truncated");
      expect(projected?.debug).toMatchObject({ piProjection: { truncated: true, recordBytes: Buffer.byteLength(JSON.stringify(partial)), recordSha256: createHash("sha256").update(JSON.stringify(partial)).digest("hex") } });
      expect(validatePrpEvent(projected).ok).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(1024 * 1024);
      expect(partial.partialResult.content[0]?.text).toBe(body);
      const final = "FINAL_NATIVE_SPILL_RECEIPT_" + "z".repeat(49_750);
      f.transport.send({ type: "tool_execution_end", toolCallId: "tool", toolName: "bash", result: { content: [{ type: "text", text: final }], details: { fullOutputPath: "/native/spill.txt" } } });
      await flushFailure();
      expect(f.events.find(event => event.eventType === "item.completed" && event.payload.output === final)?.payload.output).toBe(final);
    } finally { await f.close(); }
  // The >4MiB digest replay also crosses the 5s default on shared gate hosts.
  }, 20_000);

  it("declares the pi_rpc native driver and conservative capabilities", async () => {
    const descriptor = await new PiRpcDriver({ runtimeDirectory: "/tmp/pi-test" }).descriptor();
    expect(descriptor).toMatchObject({ kind: "pi_rpc", displayName: "Pi RPC", version: "1.5.2" });
    expect(descriptor.capabilities).toMatchObject({ interruption: true, resume: true, steering: true, queuedFollowUp: false, structuredResult: false, dynamicTools: true });
    expect(descriptor.capabilities.unsupported).not.toContain("steering");
    expect(descriptor.capabilities.unsupported).not.toContain("resume");
    expect(descriptor.capabilities.unsupported).not.toContain("dynamicTools");
  });

  it("fails closed on an unknown managed credential mode before spawning Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-mode-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const driver = new PiRpcDriver({
      runtimeDirectory: join(root, "runtime"),
      environment: { PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "unknown" },
      transportFactory: () => { throw new Error("Pi must not spawn for an unknown mode"); },
    });
    try {
      await expect(driver.openSession({ runId: "mode-test", normalizedSessionId: "mode-test", workingDirectory: workspace }))
        .rejects.toThrow("PAPERCLIP_PI_RPC_CREDENTIAL_MODE must be broker|env");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps Pi deltas, tool lifecycle, and agent settlement into bound PRP events", () => {
    const turnId = "turn-test";
    expect(mapPiRpcRecord({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } }, turnId)).toEqual([
      { eventType: "item.delta", payload: { kind: "agentMessage", text: "hello" }, turnId, itemId: "text-0" },
    ]);
    expect(mapPiRpcRecord({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "README.md" } }, turnId)[0]).toMatchObject({
      eventType: "tool.execution.started", turnId, itemId: "call-1", payload: { schema: "paperclip.tool.execution.v1", executionId: "call-1", operation: "read", name: "read", status: "running", subject: "{\"path\":\"README.md\"}", output: null, outputBytes: 0, outputTruncated: false, outputDigest: null },
    });
    const toolResult = mapPiRpcRecord({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false }, turnId)[0]!;
    expect(toolResult).toMatchObject({
      eventType: "tool.execution.completed", turnId, itemId: "call-1", payload: { schema: "paperclip.tool.execution.v1", executionId: "call-1", operation: "read", name: "read", status: "completed", output: "ok", outputBytes: 2, outputTruncated: false },
    });
    expect(validatePrpEvent({ schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: "test:run:1", sourceSeq: 1, sourceInstanceId: "test", sourceKind: "runner", runId: "run", normalizedSessionId: "session", turnId, itemId: toolResult.itemId, eventType: toolResult.eventType, priority: 1, emittedAt: "2026-11-12T00:00:00.000Z", payload: toolResult.payload }).ok).toBe(true);
    expect(mapPiRpcRecord({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 12, output: 3, totalTokens: 15 } } }, turnId)).toEqual([
      { eventType: "item.completed", payload: { kind: "agentMessage", channel: "final", text: "done" }, turnId, itemId: "final" },
      { eventType: "item.completed", payload: { kind: "usage", usage: { runDelta: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }, runDeltaComplete: true } }, turnId, itemId: "usage" },
    ]);
    expect(mapPiRpcRecord({ type: "agent_settled", aborted: false }, turnId)).toEqual([
      { eventType: "turn.completed", payload: { status: "completed", piAgentSettled: true }, turnId },
    ]);
  });
});
