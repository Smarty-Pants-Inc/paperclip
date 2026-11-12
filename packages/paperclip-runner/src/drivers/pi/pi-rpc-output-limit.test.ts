import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { createPiRpcAppServerProxy } from "../../cli/pi-rpc-app-server-proxy.js";
import { validatePrpEvent, type PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: final-output classification is a trust boundary. The real 1.5.2
// baseline supplies receipt shape/usage; cases override identity, stopReason and
// content to seed regressions (not claimed as native length recordings).
const baseline: PiRpcRecord[] = readFileSync(new URL("../../../test-fixtures/pi-rpc/baseline-1.5.2.jsonl", import.meta.url), "utf8").trim().split("\n").map(line => JSON.parse(line));
const nativeReceipt = baseline.find(event => event.type === "message_end" && (event.message as PiRpcRecord)?.role === "assistant" && (event.message as PiRpcRecord)?.stopReason === "stop")!.message as PiRpcRecord;
const receipt = (stopReason: string, content: unknown[], timestamp = 1): PiRpcRecord => ({ ...structuredClone(nativeReceipt), responseId: `output-limit-${timestamp}`, stopReason, content, timestamp });
const text = (value: string) => [{ type: "text", text: value }];
class OutputLimitTransport {
  closed = false;
  exited = false;
  pid = null;
  queue: PiRpcRecord[] = [];
  wake?: () => void;
  async request(type: string) {
    return { data: type === "get_state" ? { sessionId: "native", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_thinking_levels" ? { levels: ["high"] }
      : type === "prompt" ? { disposition: "started" } : undefined };
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
const terminals = (events: PrpEvent[]) => events.filter(event => ["turn.completed", "turn.failed", "turn.cancelled"].includes(event.eventType));
async function fixture(capture = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-output-limit-"));
  const transport = new OutputLimitTransport();
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "runtime"), model: "neutral/model", piRpcThinkingLevel: "high",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport,
  }).openSession({ runId: "owner", normalizedSessionId: "normalized", workingDirectory: root });
  const events: PrpEvent[] = [];
  const drained = capture ? (async () => { for await (const event of session.events()) events.push(event); })() : Promise.resolve();
  return { session, transport, events, async close() { await session.close(); await drained; await rm(root, { recursive: true, force: true }); } };
}
function sendMessage(transport: OutputLimitTransport, message: PiRpcRecord) {
  transport.send({ type: "message_start", message });
  transport.send({ type: "message_end", message });
}

// B6 guards the Rust consumer; F5 must also reject at the real TS pump/facade.
// Keep reason: usage is accounting, not an answer across this trust boundary.
describe("B6/F5 empty Pi completion with mandatory usage", () => {
  it.each([
    ["empty", []], ["empty text block", text("")], ["whitespace", text(" \t\n")],
    ["thinking only", [{ type: "thinking", thinking: "private reasoning" }]],
  ])("rejects %s despite a native usage receipt", async (_name, content) => {
    const f = await fixture();
    try {
      const turn = await f.session.startTurn({ message: { role: "user", text: "answer" } });
      f.transport.send({ type: "agent_start" });
      const message = receipt("stop", content as unknown[]);
      expect(message.usage).toBeDefined();
      sendMessage(f.transport, message);
      f.transport.send({ type: "agent_end" });
      await flush();
      expect(terminals(f.events)).toEqual([]);
      f.transport.send({ type: "agent_settled", aborted: false });
      await flush();
      expect(terminals(f.events)).toMatchObject([{ eventType: "turn.failed", turnId: turn.turnId,
        payload: { status: "failed", piAgentSettled: true, error: { code: "opencode_empty_response", recoverable: false } } }]);
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
      expect(f.transport.closed).toBe(false);
      for (const event of f.events) expect(validatePrpEvent(event).ok).toBe(true);
    } finally { await f.close(); }
  });

  it("does not let an earlier receipt or transient delta hide an empty final answer", async () => {
    const f = await fixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "answer" } });
      f.transport.send({ type: "agent_start" });
      sendMessage(f.transport, receipt("stop", text("earlier progress"), 1));
      const message = receipt("stop", [], 2);
      f.transport.send({ type: "message_start", message });
      f.transport.send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "discarded" } });
      f.transport.send({ type: "message_end", message });
      f.transport.send({ type: "agent_settled", aborted: false });
      await flush();
      expect(terminals(f.events)).toMatchObject([{ eventType: "turn.failed", payload: { error: { code: "opencode_empty_response" } } }]);
    } finally { await f.close(); }
  });

  it.each(["paperclip_finish", "paperclip_block"])("preserves a tool-only %s followed by an empty usage receipt", async name => {
    const f = await fixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "agent_start" });
      sendMessage(f.transport, receipt("toolUse", [{ type: "toolCall", id: "finish", name, arguments: {} }], 1));
      f.transport.send({ type: "tool_execution_start", toolCallId: "finish", toolName: name, args: {} });
      f.transport.send({ type: "tool_execution_end", toolCallId: "finish", toolName: name, result: { content: [], details: {}, isError: false }, isError: false });
      sendMessage(f.transport, receipt("stop", [], 2));
      f.transport.send({ type: "agent_settled", aborted: false });
      await flush();
      expect(terminals(f.events)).toMatchObject([{ eventType: "turn.completed" }]);
      expect(f.events.some(event => event.payload.kind === "agentMessage" && String(event.payload.text ?? "").trim())).toBe(false);
    } finally { await f.close(); }
  });
});

describe("K2 final Pi output limit is not successful completion", () => {
  it.each([
    ["empty", []], ["empty text block", text("")], ["whitespace", text(" \t\n")],
    ["thinking only", [{ type: "thinking", thinking: "private reasoning" }]],
    ["partial answer", text("The answer was cut off mid-")],
  ])("fails a final length receipt with %s despite mandatory usage", async (_name, content) => {
    const f = await fixture();
    try {
      const turn = await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "agent_start" });
      sendMessage(f.transport, receipt("length", content as unknown[]));
      f.transport.send({ type: "agent_end" });
      await flush();
      expect(terminals(f.events)).toHaveLength(0);
      expect(f.transport.closed).toBe(false);
      f.transport.send({ type: "agent_settled", aborted: false });
      await flush();
      expect(terminals(f.events)).toMatchObject([{ eventType: "turn.failed", runId: "owner", turnId: turn.turnId,
        payload: { status: "failed", piAgentSettled: true, error: { code: "pi_output_truncated", recoverable: false } } }]);
      for (const event of f.events) expect(validatePrpEvent(event).ok).toBe(true);
    } finally { await f.close(); }
  });

  it("never classifies an intermediate length that a final stop recovers", async () => {
    const f = await fixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "agent_start" });
      sendMessage(f.transport, receipt("length", text("intermediate"), 1));
      await flush();
      expect(terminals(f.events)).toHaveLength(0);
      expect(f.events.some(event => event.payload.code === "pi_output_truncated")).toBe(false);
      sendMessage(f.transport, receipt("stop", text("complete answer"), 2));
      f.transport.send({ type: "agent_settled", aborted: false });
      await flush();
      expect(terminals(f.events)).toMatchObject([{ eventType: "turn.completed" }]);
      expect(f.events.some(event => JSON.stringify(event.payload).includes("pi_output_truncated"))).toBe(false);
    } finally { await f.close(); }
  });

  it("does not let earlier usable text hide a final empty length", async () => {
    const f = await fixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "agent_start" });
      sendMessage(f.transport, receipt("stop", text("earlier text"), 1));
      sendMessage(f.transport, receipt("length", [], 2));
      f.transport.send({ type: "agent_settled", aborted: false });
      await flush();
      expect(terminals(f.events)).toMatchObject([{ eventType: "turn.failed", payload: { error: { code: "pi_output_truncated" } } }]);
    } finally { await f.close(); }
  });

  it("preserves explicit cancellation instead of relabeling it as truncation", async () => {
    const f = await fixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      f.transport.send({ type: "agent_start" });
      sendMessage(f.transport, receipt("length", text("partial")));
      f.transport.send({ type: "agent_settled", aborted: true });
      await flush();
      expect(terminals(f.events)).toMatchObject([{ eventType: "turn.cancelled" }]);
      expect(terminals(f.events)[0]?.payload.error).toBeUndefined();
    } finally { await f.close(); }
  });

  it("sends a typed failed terminal through the real facade, not turn/completed", async () => {
    const f = await fixture(false);
    const frames: string[] = [];
    const proxy = createPiRpcAppServerProxy({ stdout: { write(frame) { frames.push(frame); return true; }, once() {} },
      environment: { PAPERCLIP_RUN_ID: "owner" }, createDriver: () => ({ async descriptor() { throw new Error("unused"); }, async openSession() { return f.session; } }) });
    try {
      proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { model: "neutral/model" } }));
      await flush();
      proxy.acceptLine(JSON.stringify({ id: 2, method: "turn/start", params: { input: [{ text: "work" }] } }));
      await flush();
      f.transport.send({ type: "agent_start" });
      sendMessage(f.transport, receipt("length", text("partial answer")));
      await flush();
      expect(frames.map(frame => JSON.parse(frame)).some(frame => ["turn/completed", "turn/failed"].includes(frame.method))).toBe(false);
      f.transport.send({ type: "agent_settled", aborted: false });
      await flush();
      const decoded = frames.map(frame => JSON.parse(frame));
      expect(decoded.filter(frame => ["turn/completed", "turn/failed"].includes(frame.method))).toMatchObject([
        { method: "turn/failed", params: { turn: { status: "failed", error: { code: "pi_output_truncated" } } } },
      ]);
    } finally { await proxy.close(); await f.close(); }
  });
});
