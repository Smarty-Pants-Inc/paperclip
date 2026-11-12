import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcDriverOptions, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: native admission and delayed-event attribution are trust/data-safety
// boundaries. Exercise the live session pump, not just admission/projector helpers.
class FakeTransport {
  readonly commands: Array<{ type: string; params: PiRpcRecord }> = [];
  state: PiRpcRecord = { sessionId: "native-session", model: { provider: "neutral", id: "nested/model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  modelReceipt: PiRpcRecord = { provider: "neutral", id: "nested/model" };
  levels = ["off", "high", "max"];
  hold?: (type: string) => Promise<void>;
  closed = false;
  pid = 42;
  exited = false;
  #records: PiRpcRecord[] = [];
  #wake?: (value: IteratorResult<PiRpcRecord>) => void;

  async request(type: string, params: PiRpcRecord = {}): Promise<PiRpcRecord> {
    this.commands.push({ type, params });
    await this.hold?.(type);
    const data = type === "get_state" ? { ...this.state }
      : type === "set_model" ? this.modelReceipt
      : type === "get_available_thinking_levels" ? { levels: this.levels }
      : type === "prompt" ? { disposition: "started" } : undefined;
    return { type: "response", command: type, success: true, data };
  }
  send(value: PiRpcRecord): void {
    if (this.#wake) { const wake = this.#wake; this.#wake = undefined; wake({ value, done: false }); }
    else this.#records.push(value);
  }
  events(): AsyncIterable<PiRpcRecord> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => {
      const value = this.#records.shift();
      if (value) return { value, done: false };
      if (this.closed) return { value: undefined, done: true };
      return new Promise<IteratorResult<PiRpcRecord>>(resolve => { this.#wake = resolve; });
    } }) };
  }
  async close(): Promise<void> {
    this.closed = this.exited = true;
    this.#wake?.({ value: undefined, done: true });
    this.#wake = undefined;
  }
}

const roots: string[] = [];
const sessions: PiRpcHarnessSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const admission = ["get_state", "set_model", "get_available_thinking_levels", "set_thinking_level", "get_state"];
async function fixture(overrides: Partial<PiRpcDriverOptions> = {}, transport = new FakeTransport()) {
  const root = await mkdtemp(join(tmpdir(), "pi-l4-wiring-")); roots.push(root);
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const driver = new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/nested/model", piThinkingLevel: "high", transportFactory: () => transport as unknown as PiRpcTransport, ...overrides });
  const input = { runId: "run-a", normalizedSessionId: "session", workingDirectory: workspace };
  const open = async () => {
    const session = await driver.openSession(input) as PiRpcHarnessSession; sessions.push(session);
    const events: PrpEvent[] = [];
    const pump = (async () => { for await (const event of session.events()) events.push(event); })();
    return { session, events, pump };
  };
  return { driver, transport, input, open };
}
const message = (id: string, extra: PiRpcRecord = {}): PiRpcRecord => ({ role: "assistant", provider: "neutral", model: "nested/model", responseId: id, timestamp: id === "old" ? 1 : 2, stopReason: "stop", content: [{ type: "text", text: id }], ...extra });
const usage = (input: number) => ({ input, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: input + 2, cost: { total: 0.01 } });
const startMessage = (transport: FakeTransport, id: string) => transport.send({ type: "message_start", message: message(id, { content: [], stopReason: "pending" }) });
const delta = (id: string, text: string) => ({ type: "message_update", messageId: id, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
async function begin(session: PiRpcHarnessSession, transport: FakeTransport, id: string) {
  const turn = await session.startTurn({ message: { role: "user", text: "work" } });
  transport.send({ type: "agent_start" }); transport.send({ type: "turn_start" }); startMessage(transport, id); await flush();
  return turn;
}
async function settle(transport: FakeTransport, id: string) {
  transport.send({ type: "message_end", message: message(id, { usage: usage(3) }) });
  transport.send({ type: "agent_end", messages: [message(id)] });
  transport.send({ type: "agent_settled", aborted: false }); await flush();
}

describe("Pi RPC live-session L4 wiring", () => {
  it("adapts admission commands to the transport and unwraps response.data before returning a session", async () => {
    const f = await fixture(); const { session } = await f.open();
    expect(f.transport.commands.map(command => command.type)).toEqual(admission);
    expect(f.transport.commands[1]).toEqual({ type: "set_model", params: { provider: "neutral", modelId: "nested/model" } });
    expect(f.transport.commands[3]).toEqual({ type: "set_thinking_level", params: { level: "high" } });
    expect(session.ids().providerSessionId).toBe("native-session");
  });

  it.each([{ model: undefined }, { piThinkingLevel: undefined }, { piThinkingLevel: "ultra" }])("requires an explicit exact model/effort before spawn: %j", async overrides => {
    const f = await fixture(overrides);
    await expect(f.open()).rejects.toThrow(/model|thinking|effort/i);
    expect(f.transport.commands).toEqual([]);
  });

  it.each(["model", "effort", "busy"])("rejects inadmissible native %s and closes startup resources without prompt", async kind => {
    const f = await fixture();
    if (kind === "model") f.transport.modelReceipt = { provider: "neutral", id: "wrong" };
    if (kind === "effort") f.transport.state.thinkingLevel = "max";
    if (kind === "busy") f.transport.state.isStreaming = true;
    await expect(f.open()).rejects.toThrow(/model|thinking|busy/i);
    expect(f.transport.commands.some(command => command.type === "prompt")).toBe(false);
    expect(f.transport.closed).toBe(true);
  });

  it("repeats admission when opening an existing session file rather than trusting prior state", async () => {
    const f = await fixture(); const first = await f.open(); await first.session.close();
    f.transport.closed = false; f.transport.exited = false;
    f.transport.modelReceipt = { provider: "other", id: "model" };
    await expect(f.open()).rejects.toThrow(/model/i);
    expect(f.transport.commands.filter(command => command.type === "set_model")).toHaveLength(2);
  });

  it("admits run.attach before mutating run identity, and serializes prompt behind admission", async () => {
    const f = await fixture(); const { session } = await f.open();
    let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entering = new Promise<void>(resolve => { entered = resolve; });
    f.transport.hold = async type => { if (type === "set_model") { entered(); await blocked; } };
    const attach = session.attachRun!({ runId: "run-b" }); await entering;
    expect((await session.snapshot()).runId).toBe("run-a");
    const start = session.startTurn({ message: { role: "user", text: "after claim" } }); await flush();
    expect(f.transport.commands.some(command => command.type === "prompt")).toBe(false);
    release(); await attach; await start;
    expect((await session.snapshot()).runId).toBe("run-b");
    expect(f.transport.commands.map(command => command.type)).toEqual([...admission, ...admission, "prompt"]);
  });

  it("failed attach retains the old identity and blocks input until fresh post-claim admission", async () => {
    const f = await fixture(); const { session } = await f.open();
    f.transport.state.thinkingLevel = "max";
    await expect(session.attachRun!({ runId: "run-b" })).rejects.toThrow(/thinking/);
    expect((await session.snapshot()).runId).toBe("run-a");
    await expect(session.startTurn({ message: { role: "user", text: "must not send" } })).rejects.toThrow(/admi/i);
    f.transport.state.thinkingLevel = "high";
    await session.revalidateAfterClaim();
    await session.startTurn({ message: { role: "user", text: "admitted" } });
    expect(f.transport.commands.filter(command => command.type === "prompt")).toHaveLength(1);
  });

  it("revalidates exact model/effort on reconnect and after claim", async () => {
    const f = await fixture(); const { session } = await f.open();
    await session.reconnect(); await session.revalidateAfterClaim();
    expect(f.transport.commands.map(command => command.type)).toEqual([...admission, ...admission, ...admission]);
  });

  it("rejects a changed native session after claim and cannot prompt with the old admission", async () => {
    const f = await fixture(); const { session } = await f.open();
    f.transport.state.sessionId = "replacement-session";
    await expect(session.revalidateAfterClaim()).rejects.toThrow(/identity/);
    await expect(session.startTurn({ message: { role: "user", text: "must not send" } })).rejects.toThrow(/admission/);
    expect(f.transport.commands.some(command => command.type === "prompt")).toBe(false);
  });

  it("honors cancellation during admission and does not mutate the attached run", async () => {
    const f = await fixture(); const { session } = await f.open();
    const controller = new AbortController(); controller.abort(new Error("claim revoked"));
    await expect(session.attachRun({ runId: "run-b", signal: controller.signal })).rejects.toThrow("claim revoked");
    expect((await session.snapshot()).runId).toBe("run-a");
    expect(f.transport.commands.map(command => command.type)).toEqual(admission);
    await expect(session.startTurn({ message: { role: "user", text: "must not send" } })).rejects.toThrow(/admission/);
  });

  it("refuses unsupported thinking before input, even when the requested level is syntactically valid", async () => {
    const f = await fixture(); f.transport.levels = ["off"];
    await expect(f.open()).rejects.toThrow(/thinking/);
    expect(f.transport.commands.some(command => command.type === "prompt")).toBe(false);
    expect(f.transport.closed).toBe(true);
  });

  it("fences unrequested agent work while idle instead of admitting its callbacks", async () => {
    const f = await fixture(); const { session, events } = await f.open();
    f.transport.send({ type: "agent_start" }); await flush();
    expect(f.transport.closed).toBe(true);
    expect(events.some(event => event.eventType === "session.failed" && event.payload.code === "pi_unrequested_agent_start")).toBe(true);
    await expect(session.startTurn({ message: { role: "user", text: "must not send" } })).rejects.toThrow(/closed|admitted/);
    expect(f.transport.commands.some(command => command.type === "prompt")).toBe(false);
  });

  it.each([false, true])("retains originating projectors for late text/tool/usage after next turn (new run=%s)", async nextRun => {
    const f = await fixture(); const { session, events } = await f.open();
    const first = await begin(session, f.transport, "old");
    f.transport.send(delta("old", "old partial"));
    f.transport.send({ type: "tool_execution_start", messageId: "old", toolCallId: 0, toolName: "read", args: {} });
    // Settlement may precede a delayed final receipt. Both text and usage must
    // retain the old projector even after another run is attached.
    f.transport.send({ type: "agent_settled", aborted: false }); await flush();
    if (nextRun) await session.attachRun!({ runId: "run-b" });
    const second = await begin(session, f.transport, "new");
    const boundary = events.length;
    f.transport.send(delta("old", "late old text"));
    f.transport.send({ type: "message_end", message: { role: "toolResult", toolCallId: 0, toolName: "read", content: [{ type: "text", text: "late old output" }], usage: usage(7) } });
    f.transport.send({ type: "message_end", message: message("old", { usage: usage(11) }) });
    f.transport.send(delta("new", "new text")); await flush();
    const late = events.slice(boundary).filter(event => event.turnId === first.turnId);
    expect(late.some(event => event.payload.text === "late old text")).toBe(true);
    expect(late.some(event => event.eventType === "tool.execution.completed")).toBe(true);
    expect(late.filter(event => event.eventType === "usage.reported")).toHaveLength(2);
    for (const event of late) expect(event.runId).toBe("run-a");
    const current = events.slice(boundary).filter(event => event.turnId === second.turnId);
    expect(current.some(event => event.payload.text === "new text")).toBe(true);
    expect(current.some(event => event.eventType === "usage.reported")).toBe(false);
    await settle(f.transport, "new");
    const newUsage = events.filter(event => event.turnId === second.turnId && event.eventType === "usage.reported");
    expect(newUsage).toHaveLength(1); expect(newUsage[0].payload.runDelta).toMatchObject({ inputTokens: 3 });
    for (const event of events) expect(validatePrpEvent(event), event.eventType).toMatchObject({ ok: true });
  });

  it("does not assign unknown late IDs to the current turn or let forged payload origins win", async () => {
    const f = await fixture(); const { session, events } = await f.open();
    const first = await begin(session, f.transport, "old"); await settle(f.transport, "old");
    await session.attachRun!({ runId: "run-b" }); const second = await begin(session, f.transport, "new");
    const boundary = events.length;
    f.transport.send(delta("unknown", "unknown old text"));
    f.transport.send({ type: "tool_execution_end", toolCallId: "unknown", toolName: "read", result: { content: [{ type: "text", text: "unknown old tool" }] } });
    f.transport.send({ ...delta("old", "captured old text"), runId: "run-b", turnId: second.turnId }); await flush();
    expect(events.slice(boundary).some(event => JSON.stringify(event).includes("unknown old"))).toBe(false);
    expect(events.find(event => event.payload.text === "captured old text")).toMatchObject({ runId: "run-a", turnId: first.turnId });
  });

  it("uses the captured native stream scope for unlabelled Pi deltas, not a current run fallback", async () => {
    const f = await fixture(); const { session, events } = await f.open();
    const first = await begin(session, f.transport, "old");
    f.transport.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "native unlabelled text" } });
    await settle(f.transport, "old");
    await session.attachRun!({ runId: "run-b" });
    f.transport.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "unbound late text" } }); await flush();
    expect(events.find(event => event.payload.text === "native unlabelled text")).toMatchObject({ runId: "run-a", turnId: first.turnId });
    expect(events.some(event => event.payload.text === "unbound late text")).toBe(false);
  });
});

// expected-skip: PI_TEST_BINARY unset: credential-free real Pi smoke is opt-in.
describe.skipIf(!process.env.PI_TEST_BINARY)("L4 wiring with real Pi and a local faux provider", () => {
  it("admits two runs on one Pi/session and projects real native deltas/receipts before physical close", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      let body = ""; request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { messages: Array<{ content: unknown }> };
        requests.push(JSON.stringify(parsed.messages.at(-1)?.content));
        const index = requests.length;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        response.write(`data: ${JSON.stringify({ id: `faux-${index}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `real Pi faux reply ${index}` }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: `faux-${index}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("faux provider did not bind");
    // Preserve the native JSONL trace as handoff evidence, never delete it.
    const root = await mkdtemp(join(tmpdir(), "pi-l4-real-proof-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const agentHome = join(root, "agent");
    const driver = new PiRpcDriver({ command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), environment: { PI_CODING_AGENT_DIR: agentHome, PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "local-faux-only-key" }, shutdownTimeoutMs: 500 });
    let session: PiRpcHarnessSession | undefined;
    try {
      session = await driver.openSession({ runId: "real-run-a", normalizedSessionId: "real-session", workingDirectory: workspace }) as PiRpcHarnessSession;
      const pid = session.processPid(), providerSessionId = session.ids().providerSessionId;
      const iterator = session.events()[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ eventType: "session.started", payload: { context: { model: "paperclip/faux", piRpcThinkingLevel: "off" } } });
      const turns: Array<{ runId: string; turnId: string }> = [];
      for (const [index, runId] of ["real-run-a", "real-run-b"].entries()) {
        if (index > 0) { await session.attachRun({ runId }); await session.revalidateAfterClaim(); }
        const { turnId } = await session.startTurn({ message: { role: "user", text: `faux prompt ${index + 1}` } });
        turns.push({ runId, turnId });
        const events: PrpEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) throw new Error("native stream closed before settlement");
          const event = next.value; events.push(event);
          expect(event).toMatchObject({ runId, turnId });
          expect(validatePrpEvent(event), event.eventType).toMatchObject({ ok: true });
          if (event.eventType === "turn.completed") break;
          if (["turn.failed", "turn.cancelled", "session.failed"].includes(event.eventType)) throw new Error(JSON.stringify(event));
        }
        expect(events.some(event => event.eventType === "item.delta" && event.payload.kind === "agentMessage")).toBe(true);
        expect(events.some(event => event.eventType === "item.completed" && event.payload.text === `real Pi faux reply ${index + 1}`)).toBe(true);
        expect(events.filter(event => event.eventType === "usage.reported")).toHaveLength(1);
        expect(session.processPid()).toBe(pid); expect(session.ids().providerSessionId).toBe(providerSessionId);
      }
      expect(requests).toHaveLength(2);
      const snapshot = await session.snapshot();
      expect(await readFile(snapshot.sessionFile, "utf8")).toContain("real Pi faux reply 2");
      await session.close(); expect(session.processExited()).toBe(true);
      console.info("PI_L4_LIVE_PROOF", JSON.stringify({ binary: process.env.PI_TEST_BINARY, pid, providerSessionId, turns, sessionFile: snapshot.sessionFile, processExited: session.processExited(), provider: "local faux only; no paid model" }));
    } finally {
      await session?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 30_000);
});
