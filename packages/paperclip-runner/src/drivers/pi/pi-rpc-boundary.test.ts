import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiRpcAppServerProxy } from "../../cli/pi-rpc-app-server-proxy.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { bindContent, sendPiToolRequest, type PiBindCommand, type PiToolCallRequest } from "./pi-bind-protocol.js";
import { createPiEventProjector } from "./pi-event-projector.js";
import { PiRpcDriver, PiRpcHarnessSession } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";

// Keep reason: architecture-review catches at the native transport/projector/
// facade trust boundaries. Controlled transport, not real-Pi/provider or Rust
// qualification. Receipts use the checked-in native 1.5.2 recording's shape.
const baseline: PiRpcRecord[] = readFileSync(new URL("../../../test-fixtures/pi-rpc/baseline-1.5.2.jsonl", import.meta.url), "utf8")
  .trim().split("\n").map(line => JSON.parse(line));
const nativeReceipt = baseline.find(event => event.type === "message_end"
  && (event.message as PiRpcRecord)?.role === "assistant"
  && (event.message as PiRpcRecord)?.stopReason === "stop")!.message as PiRpcRecord;
function receipt(id: string, text = "done", stopReason = "stop"): PiRpcRecord {
  return { ...structuredClone(nativeReceipt), id, responseId: id, timestamp: 1, provider: "neutral", model: "model",
    content: text ? [{ type: "text", text }] : [], stopReason,
    usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

// Reuse the OutputLimitTransport/failureFixture pattern from
// pi-rpc-output-limit.test.ts and pi-rpc-driver.test.ts, rather than the probe's
// untyped ad-hoc transport. Those helpers are file-private; keep this regression
// file self-contained without importing another test file (and registering its
// entire suite), or changing a second file just to export test internals.
class BoundaryTransport {
  closed = false;
  exited = false;
  pid = null;
  queue: PiRpcRecord[] = [];
  wake?: () => void;
  promptDisposition = "started";
  constructor(readonly semantic = false) {}
  async request(type: string) {
    const model = this.semantic ? { provider: "paperclip", id: "faux" } : { provider: "neutral", id: "model" };
    const thinkingLevel = this.semantic ? "off" : "high";
    return { data: type === "get_state" ? { sessionId: "native", model, thinkingLevel,
      isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model
      : type === "get_available_models" ? { models: [model] }
      : type === "get_available_thinking_levels" ? { levels: [thinkingLevel] }
      : type === "prompt" ? { disposition: this.promptDisposition } : undefined };
  }
  send(value: PiRpcRecord) { this.queue.push(value); this.wake?.(); }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const value = this.queue.shift();
      if (value) { yield value; continue; }
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const terminals = (events: PrpEvent[]) => events.filter(event => /^turn\.(completed|failed|cancelled)$/.test(event.eventType));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Pi boundary fixture cleanup failed");
});

async function fixture(options: { capture?: boolean; semanticTool?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-boundary-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const transport = new BoundaryTransport(!!options.semanticTool);
  const effects: Array<{ tool: string; runId: string; turnId: string; callId: string }> = [];
  let initial: PiToolCallRequest["origin"] & { sessionId: string; toolSocketPath: string } | undefined;
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "runtime"),
    model: options.semanticTool ? "paperclip/faux" : "neutral/model", piRpcThinkingLevel: options.semanticTool ? "off" : "high",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent"), ...(options.semanticTool ? {
      PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none",
    } : {}) },
    ...(options.semanticTool ? {
      dynamicTools: [{ name: options.semanticTool, description: "Accept a semantic completion", inputSchema: { type: "object", properties: {} } }],
      dynamicToolHandler: async call => { effects.push(call); return { contentItems: [{ type: "inputText", text: "accepted" }], success: true }; },
      // Same private native-bind receipt fake as dialogFixture in
      // pi-rpc-driver.test.ts. The host semantic callback socket remains REAL.
      bindRequest: (async (_path: string, command: PiBindCommand) => command.type === "bind"
        ? { schema: 1, type: "bind", nonce: command.nonce, sessionId: command.sessionId, epoch: command.epoch, runId: command.runId,
          provider: command.provider.name, model: command.model, thinkingLevel: command.thinkingLevel, ...bindContent(command) }
        : command.type === "tool_inventory" ? { ...command, nativeTools: [] }
        : command.type === "stop_children" ? { ...command, settled: [], uncertain: [] } : { ...command, ack: true }) as never,
    } : {}),
    transportFactory: launch => {
      if (options.semanticTool) initial = JSON.parse(readFileSync(launch.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
      return transport as unknown as PiRpcTransport;
    },
  }).openSession({ runId: "boundary-run", normalizedSessionId: "boundary-session", workingDirectory: root });
  const events: PrpEvent[] = [];
  const iteratorErrors: unknown[] = [];
  const drained = options.capture === false ? Promise.resolve() : (async () => {
    try { for await (const event of session.events()) events.push(event); } catch (error) { iteratorErrors.push(error); }
  })();
  cleanups.push(async () => {
    try { await session.close({ reason: "boundary test cleanup" }); } finally { await drained; }
    expect(iteratorErrors).toEqual([]);
  });
  expect(session).toBeInstanceOf(PiRpcHarnessSession);
  return { session, transport, events, effects, initial };
}
function sendReceipt(transport: BoundaryTransport, message: PiRpcRecord) {
  transport.send({ type: "message_start", message: { ...message, content: [] } });
  transport.send({ type: "message_end", message });
}
function settle(transport: BoundaryTransport, messages: unknown[] = []) {
  transport.send({ type: "agent_end", messages, willRetry: false });
  transport.send({ type: "agent_settled", aborted: false });
}
function expectOpen(events: PrpEvent[], transport: BoundaryTransport) {
  expect(events.filter(event => event.eventType === "session.failed")).toEqual([]);
  expect(transport.closed).toBe(false);
}

// Run the org T4 turn-killer first. Unlike a mere tool-call block, this proves
// the real guarded host callback accepted an effect before the empty receipt.
describe("Pi RPC architecture-review boundaries", () => {
  it.each(["paperclip_finish", "paperclip_block"])("T4 completes an accepted %s effect followed by an empty final message", async name => {
    const f = await fixture({ semanticTool: name });
    const turn = await f.session.startTurn({ message: { role: "user", text: "work" } });
    f.transport.send({ type: "agent_start" });
    const toolMessage = { ...receipt("semantic-call", "", "toolUse"), provider: "paperclip", model: "faux",
      content: [{ type: "toolCall", id: "semantic-effect", name, arguments: {} }] };
    sendReceipt(f.transport, toolMessage);
    f.transport.send({ type: "tool_execution_start", toolCallId: "semantic-effect", toolName: name, args: {} });
    await flush();
    const initial = f.initial!;
    const accepted = await sendPiToolRequest(initial.toolSocketPath, { schema: 1, type: "tool_call", nonce: "semantic-effect",
      sessionId: initial.sessionId, origin: { epoch: initial.epoch, runId: initial.runId, turnId: initial.turnId },
      toolCallId: "semantic-effect", tool: name, arguments: {} });
    expect(accepted).toMatchObject({ content: [{ type: "text", text: "accepted" }], isError: false });
    expect(f.effects).toMatchObject([{ tool: name, runId: "boundary-run", turnId: turn.turnId, callId: "semantic-effect" }]);
    f.transport.send({ type: "tool_execution_end", toolCallId: "semantic-effect", toolName: name, result: accepted, isError: false });
    sendReceipt(f.transport, { ...receipt("semantic-empty", ""), provider: "paperclip", model: "faux", timestamp: 2 });
    settle(f.transport);
    await vi.waitFor(() => expect(terminals(f.events)).toHaveLength(1));
    expect(terminals(f.events)).toMatchObject([{ eventType: "turn.completed", turnId: turn.turnId }]);
    expect(f.events.some(event => event.payload.kind === "agentMessage" && String(event.payload.text ?? "").trim())).toBe(false);
    expectOpen(f.events, f.transport);
  });

  it("completes a recovered native retry and keeps the session open", async () => {
    const f = await fixture();
    const turn = await f.session.startTurn({ message: { role: "user", text: "retry" } });
    f.transport.send({ type: "agent_start" });
    sendReceipt(f.transport, receipt("retry-first", "", "error"));
    f.transport.send({ type: "agent_end", messages: [], willRetry: true });
    f.transport.send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1 });
    await flush();
    expect(terminals(f.events)).toEqual([]);
    f.transport.send({ type: "agent_start" });
    sendReceipt(f.transport, { ...receipt("retry-recovered", "recovered"), timestamp: 2 });
    f.transport.send({ type: "agent_end", messages: [], willRetry: false });
    f.transport.send({ type: "auto_retry_end", success: true, attempt: 2 });
    f.transport.send({ type: "agent_settled", aborted: false });
    await flush();
    expect(terminals(f.events)).toMatchObject([{ eventType: "turn.completed", turnId: turn.turnId }]);
    expectOpen(f.events, f.transport);
  });

  it("projects 70 KiB write arguments through the session without a failure or native mutation", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "write a large file" } });
    f.transport.send({ type: "agent_start" });
    const args = { path: "large.md", content: "x".repeat(70 * 1024) };
    const original = structuredClone(args);
    f.transport.send({ type: "tool_execution_start", toolCallId: "large-write", toolName: "write", args });
    f.transport.send({ type: "tool_execution_end", toolCallId: "large-write", toolName: "write", result: { content: [{ type: "text", text: "written" }] }, isError: false });
    sendReceipt(f.transport, receipt("write-done"));
    settle(f.transport);
    await flush();
    expect(terminals(f.events)).toMatchObject([{ eventType: "turn.completed" }]);
    expect(f.events.some(event => event.eventType === "tool.execution.completed")).toBe(true);
    expect(args).toEqual(original);
    expectOpen(f.events, f.transport);
  });

  it("accepts a 300 KiB agent_end aggregate without a session failure", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "read files" } });
    f.transport.send({ type: "agent_start" });
    sendReceipt(f.transport, receipt("aggregate-done"));
    const messages = Array.from({ length: 5 }, () => ({ role: "toolResult", content: [{ type: "text", text: "x".repeat(60 * 1024) }] }));
    f.transport.send({ type: "agent_end", messages });
    await flush();
    expect(terminals(f.events)).toEqual([]);
    expectOpen(f.events, f.transport);
    f.transport.send({ type: "agent_settled", aborted: false });
    await flush();
    expect(terminals(f.events)).toMatchObject([{ eventType: "turn.completed" }]);
    expectOpen(f.events, f.transport);
  });

  it.each([
    { name: "70 KiB arguments", event: { type: "tool_execution_start", toolCallId: "write", toolName: "write", args: { content: "x".repeat(70 * 1024) } } },
    { name: "300 KiB aggregate", event: { type: "agent_end", messages: [{ body: "x".repeat(300 * 1024) }] } },
  ])("never throws while projecting $name", ({ event }) => {
    const original = structuredClone(event);
    const projector = createPiEventProjector({ runId: "boundary-run", turnId: "projection-turn" });
    expect(() => projector.project(event)).not.toThrow();
    expect(event).toEqual(original);
    // The same projector remains usable after the oversized display record.
    const message = receipt("projector-next");
    projector.project({ type: "message_start", message: { ...message, content: [] } });
    expect(projector.project({ type: "message_end", message })).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "item.completed", payload: expect.objectContaining({ kind: "agentMessage", text: "done" }) }),
    ]));
  });

  it("accepts a handled prompt with outcome handled and no model output", async () => {
    const f = await fixture();
    f.transport.promptDisposition = "handled";
    const turn = await f.session.startTurn({ message: { role: "user", text: "/handled" } });
    await flush();
    expect(turn.turnId).toBeTruthy();
    expect(terminals(f.events)).toMatchObject([{ eventType: "turn.completed", turnId: turn.turnId,
      payload: { outcome: "handled", modelOutput: false } }]);
    expect(f.events.filter(event => event.turnId === turn.turnId && (event.eventType.startsWith("item.") || event.eventType === "usage.reported"))).toEqual([]);
    expectOpen(f.events, f.transport);
  });

  it("fails a final length stop reason with pi_output_truncated", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "answer" } });
    f.transport.send({ type: "agent_start" });
    sendReceipt(f.transport, receipt("truncated", "partial answer", "length"));
    settle(f.transport);
    await flush();
    expect(terminals(f.events)).toMatchObject([{ eventType: "turn.failed", payload: { error: { code: "pi_output_truncated" } } }]);
    expectOpen(f.events, f.transport);
  });

  it("does not complete an empty final answer just because it has usage", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "answer" } });
    f.transport.send({ type: "agent_start" });
    sendReceipt(f.transport, receipt("empty-usage", ""));
    settle(f.transport);
    await flush();
    expect(f.events.some(event => event.eventType === "usage.reported")).toBe(true);
    expect(terminals(f.events)).toMatchObject([{ eventType: "turn.failed", payload: { error: { code: "opencode_empty_response" } } }]);
    expectOpen(f.events, f.transport);
  });

  it.each([false, true])("reports two 11-token receipts as total/last 22, omitting last after an incomplete receipt=%s", async incomplete => {
    const f = await fixture({ capture: false });
    type Frame = { id?: number; method?: string; params?: Record<string, unknown>; error?: unknown };
    const frames: Frame[] = [];
    const proxy = createPiRpcAppServerProxy({ stdout: { write(frame) { frames.push(JSON.parse(frame)); return true; }, once() {} },
      environment: { PAPERCLIP_RUN_ID: "boundary-run" }, createDriver: () => ({ async descriptor() { throw new Error("unused"); }, async openSession() { return f.session; } }) });
    cleanups.push(() => proxy.close());
    proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { model: "neutral/model" } }));
    await vi.waitFor(() => expect(frames.some(frame => frame.id === 1)).toBe(true));
    expect(frames.find(frame => frame.id === 1)?.error).toBeUndefined();
    proxy.acceptLine(JSON.stringify({ id: 2, method: "turn/start", params: { input: [{ type: "text", text: "answer" }] } }));
    await vi.waitFor(() => expect(frames.some(frame => frame.id === 2)).toBe(true));
    expect(frames.find(frame => frame.id === 2)?.error).toBeUndefined();
    f.transport.send({ type: "agent_start" });
    for (let i = 1; i <= 2; i++) sendReceipt(f.transport, { ...receipt(`usage-${i}`), timestamp: i });
    await flush();
    const updates = () => frames.filter(frame => frame.method === "thread/tokenUsage/updated");
    expect(updates()).toHaveLength(2);
    expect(updates().at(-1)).toMatchObject({ params: { runDeltaAvailable: true,
      tokenUsage: { total: { inputTokens: 22, outputTokens: 0 }, last: { inputTokens: 22, outputTokens: 0 } } } });
    if (incomplete) {
      const message = { ...receipt("usage-incomplete"), timestamp: 3, usage: { input: 5 } };
      sendReceipt(f.transport, message);
      await flush();
      expect(updates().at(-1)).toMatchObject({ params: { runDeltaAvailable: false, tokenUsage: { total: { inputTokens: 27 } } } });
      expect(updates().at(-1)!.params!.tokenUsage).not.toHaveProperty("last");
    }
    settle(f.transport);
    await flush();
    expect(frames.filter(frame => /^(turn\/(completed|failed|cancelled)|error)$/.test(frame.method ?? ""))).toMatchObject([{ method: "turn/completed" }]);
    expect(f.transport.closed).toBe(false);
  });
});
