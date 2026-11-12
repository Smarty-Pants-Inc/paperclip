import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mapPiRpcRecord, PiRpcDriver } from "./pi-rpc-driver.js";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { createPiRpcAppServerProxy } from "../../cli/pi-rpc-app-server-proxy.js";
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
  ui: PiRpcRecord[] = [];
  async sendExtensionUiResponse(response: PiRpcRecord) { this.ui.push(structuredClone(response)); }
  promptDisposition = "started";
  onPrompt?: () => void;
  async request(type: string) {
    if (type === "prompt") this.onPrompt?.();
    return { data: type === "get_state" ? { sessionId: "native-session", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_thinking_levels" ? { levels: ["high"] }
      : type === "prompt" ? { disposition: this.promptDisposition } : undefined };
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
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "runtime"), model: "neutral/model", piThinkingLevel: "high", environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport })
    .openSession({ runId: "run-old", normalizedSessionId: "normalized", workingDirectory: root });
  const events: PrpEvent[] = [];
  const drained = capture ? (async () => { try { for await (const event of session.events()) events.push(event); } catch { /* terminal message must precede iterator rejection */ } })() : Promise.resolve();
  return { session, transport, events, async close() { await session.close({ reason: "unit cleanup" }); await drained; await rm(root, { recursive: true, force: true }); } };
}

async function dialogFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-dialog-"));
  const transport = new class extends FailureTransport {
    override async request(type: string) {
      return { data: type === "get_state" ? { sessionId: "native-dialog", model: { provider: "paperclip", id: "faux" }, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
        : type === "set_model" ? { provider: "paperclip", id: "faux" }
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
    const opening = new PiRpcDriver({ runtimeDirectory: runtime, model: "neutral/model", piThinkingLevel: "high",
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

  it.each([true, false])("keeps a projector failure's captured origin (old continuation fails=%s)", async oldFails => {
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
      expect(failure).toMatchObject({ runId: oldFails ? "run-old" : "run-new", turnId: oldFails ? old.turnId : current.turnId, payload: { code: "pi_rpc_transport_failed", message: "pi_projection_tool_name_changed" } });
      if (oldFails) expect(f.events.some(event => event.eventType === "turn.failed" && event.turnId === current.turnId)).toBe(false);
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
    expect(descriptor.capabilities).toMatchObject({ interruption: true, resume: false, steering: false, queuedFollowUp: false, structuredResult: false, dynamicTools: true });
    expect(descriptor.capabilities.unsupported).toContain("steering");
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
