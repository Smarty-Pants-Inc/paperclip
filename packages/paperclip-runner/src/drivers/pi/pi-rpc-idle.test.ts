import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: L15's silent-provider failure cannot be reached cheaply in a
// live user flow. Exercise the real session pump, abort and same-session reuse.
class IdleTransport {
  closed = false; exited = false; pid = null;
  abortSettles = true;
  requests: string[] = [];
  queue: PiRpcRecord[] = []; wake?: () => void;
  async request(type: string) {
    this.requests.push(type);
    if (type === "abort" && this.abortSettles) this.send({ type: "agent_settled", aborted: true });
    return { data: type === "get_state" ? { sessionId: "native", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
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
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(turnIdleTimeoutMs: number | null = 100) {
  const root = await mkdtemp(join(tmpdir(), "pi-idle-"));
  const transport = new IdleTransport();
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
    turnIdleTimeoutMs: turnIdleTimeoutMs ?? undefined, environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport,
  }).openSession({ runId: "run-old", normalizedSessionId: "normalized", workingDirectory: root }) as PiRpcHarnessSession;
  const events: PrpEvent[] = [];
  const drained = (async () => { for await (const event of session.events()) events.push(event); })();
  return { session, transport, events, async close() { await session.close(); await drained; await rm(root, { recursive: true, force: true }); } };
}
function complete(transport: IdleTransport, id: string) {
  transport.send({ type: "agent_start" });
  const message = { role: "assistant", responseId: id, provider: "neutral", model: "model", content: [{ type: "text", text: "done" }], stopReason: "stop" };
  transport.send({ type: "message_start", message }); transport.send({ type: "message_end", message }); transport.send({ type: "agent_settled" });
}

describe("Pi RPC active-turn event-idle deadline (L15)", () => {
  it("defaults to ten minutes, above the runner's configured 60-second tool deadline plus margin", async () => {
    const f = await fixture(null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await f.session.startTurn({ message: { role: "user", text: "default bound" } });
      await vi.advanceTimersByTimeAsync(599_999);
      expect(f.transport.requests).not.toContain("abort");
      await vi.advanceTimersByTimeAsync(1); await tick();
      expect(f.transport.requests).toContain("abort");
      expect(f.events.find(event => event.eventType === "turn.failed")?.payload.error).toMatchObject({ code: "pi_turn_idle_timeout", message: expect.stringContaining("600000") });
      expect(f.transport.closed).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it.each([false, true])("aborts only a silent turn (agent started: %s), then completes on the SAME session", async started => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.transport.closed).toBe(false);
      const identity = f.session.ids(); const snapshot = await f.session.snapshot();
      const turn = await f.session.startTurn({ message: { role: "user", text: "work" } });
      if (started) { f.transport.send({ type: "agent_start" }); await tick(); }
      await vi.advanceTimersByTimeAsync(99);
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await tick();
      expect(f.events.filter(event => event.eventType.startsWith("turn.") && event.eventType !== "turn.started")).toMatchObject([
        { eventType: "turn.failed", runId: "run-old", turnId: turn.turnId, payload: { status: "failed", error: { code: "pi_turn_idle_timeout", recoverable: false, message: expect.stringContaining("100") } } },
      ]);
      expect(f.transport.requests.filter(type => type === "abort")).toHaveLength(1);
      expect(f.transport.closed).toBe(false);
      const next = await f.session.startTurn({ message: { role: "user", text: "reuse the conversation" } });
      complete(f.transport, "after-timeout"); await tick();
      expect(f.events.find(event => event.eventType === "turn.completed" && event.turnId === next.turnId)).toBeDefined();
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
      expect(f.session.ids()).toEqual(identity);
      expect((await f.session.snapshot()).sessionFile).toBe(snapshot.sessionFile);
      expect(f.transport.closed).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it("does not mistake an abort ACK for settlement, and queues the next turn until agent_settled", async () => {
    const f = await fixture(); f.transport.abortSettles = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = await f.session.startTurn({ message: { role: "user", text: "silent" } });
      f.transport.send({ type: "agent_start" }); await tick();
      await vi.advanceTimersByTimeAsync(100); await tick();
      expect(f.transport.requests).toContain("abort");
      let nextStarted = false;
      const next = f.session.startTurn({ message: { role: "user", text: "after abort" } }).then(turn => { nextStarted = true; return turn; });
      await vi.advanceTimersByTimeAsync(1000); await tick();
      expect(nextStarted).toBe(false);
      // A successful-looking receipt while abort drains must not complete the expired turn.
      const message = { role: "assistant", responseId: "late", content: [{ type: "text", text: "late" }], stopReason: "stop" };
      f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message });
      f.transport.send({ type: "agent_settled", aborted: true }); await tick();
      const second = await next;
      expect(f.events.find(event => event.turnId === first.turnId && event.eventType === "turn.failed")?.payload.error).toMatchObject({ code: "pi_turn_idle_timeout" });
      complete(f.transport, "second"); await tick();
      expect(f.events.find(event => event.turnId === second.turnId && event.eventType === "turn.completed")).toBeDefined();
      expect(f.transport.closed).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it("retires only an abort that does not settle within the short bound", async () => {
    const f = await fixture(); f.transport.abortSettles = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await f.session.startTurn({ message: { role: "user", text: "unresponsive" } });
      await vi.advanceTimersByTimeAsync(100); await tick();
      expect(f.transport.requests).toContain("abort"); expect(f.transport.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(4999); expect(f.transport.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await tick();
      expect(f.transport.closed).toBe(true);
      expect(f.events.filter(event => event.eventType === "turn.failed")).toMatchObject([{ payload: { error: { code: "pi_turn_idle_timeout" } } }]);
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it.each(["process_exit", "transport_error", "eof", "throw"])("keeps the timeout classification if abort instead produces %s", async outcome => {
    const f = await fixture(); f.transport.abortSettles = false;
    // A throwing event exercises the pump's catch path as well as its EOF path.
    const request = f.transport.request.bind(f.transport);
    f.transport.request = async type => {
      const result = await request(type);
      if (type === "abort") {
        if (outcome !== "eof") {
          f.transport.send(outcome === "throw" ? { get type(): string { throw new Error("abort stream failed"); } } : { type: outcome, message: "abort transport ended" });
          await tick();
        }
        await f.transport.close();
      }
      return result;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await f.session.startTurn({ message: { role: "user", text: "abort exits" } });
      await vi.advanceTimersByTimeAsync(100); await tick(); await tick();
      expect(f.transport.closed).toBe(true);
      expect(f.events.filter(event => event.eventType === "turn.failed")).toMatchObject([{ payload: { error: { code: "pi_turn_idle_timeout" } } }]);
      expect(f.events.some(event => event.eventType === "session.failed")).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it("resets on every Pi event, including hidden thinking, retries and compaction progress", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await f.session.startTurn({ message: { role: "user", text: "work" } });
      const message = { role: "assistant", responseId: "thinking", provider: "neutral", model: "model", content: [] };
      f.transport.send({ type: "agent_start" }); f.transport.send({ type: "message_start", message }); await tick();
      for (const event of [
        { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hidden thinking" } },
        { type: "auto_retry_start", attempt: 1 }, { type: "auto_retry_end", success: true },
        { type: "compaction_start", reason: "threshold" }, { type: "summarization_retry_attempt_start", source: "compaction" },
        { type: "entry_appended", entry: {} },
      ]) {
        await vi.advanceTimersByTimeAsync(90); f.transport.send(event); await tick();
        expect(f.transport.requests).not.toContain("abort");
      }
      await vi.advanceTimersByTimeAsync(99); expect(f.transport.requests).not.toContain("abort");
      await vi.advanceTimersByTimeAsync(1); await tick();
      expect(f.transport.requests.filter(type => type === "abort")).toHaveLength(1);
      expect(f.events.filter(event => event.eventType === "turn.failed")).toHaveLength(1);
      expect(f.transport.closed).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it("counts silent native tools, including nested IDs, until EVERY execution ends", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await f.session.startTurn({ message: { role: "user", text: "silent long tools" } });
      f.transport.send({ type: "agent_start" });
      for (const id of ["parent", "parent/child", "other"]) f.transport.send({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "silent long work" } });
      await tick(); await vi.advanceTimersByTimeAsync(1000);
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      expect(f.transport.closed).toBe(false);
      expect(f.transport.requests).not.toContain("abort");
      for (const id of ["parent", "other"]) f.transport.send({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: {} });
      // An unknown end cannot clear the outstanding child execution.
      f.transport.send({ type: "tool_execution_end", toolCallId: "unknown", toolName: "bash", result: {} });
      await tick(); await vi.advanceTimersByTimeAsync(1000);
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      expect(f.transport.requests).not.toContain("abort");
      f.transport.send({ type: "tool_execution_end", toolCallId: "parent/child", toolName: "bash", result: {} }); await tick();
      await vi.advanceTimersByTimeAsync(99); expect(f.transport.requests).not.toContain("abort");
      await vi.advanceTimersByTimeAsync(1); await tick();
      expect(f.events.filter(event => event.eventType === "turn.failed")).toHaveLength(1);
      expect(f.transport.closed).toBe(false);
    } finally { vi.useRealTimers(); await f.close(); }
  });

  it("keeps a long tool with periodic updates alive, clears the deadline on settlement, and gives the next turn a fresh deadline", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = await f.session.startTurn({ message: { role: "user", text: "long tool" } });
      f.transport.send({ type: "agent_start" });
      f.transport.send({ type: "tool_execution_start", toolCallId: "long", toolName: "bash", args: { command: "long work" } }); await tick();
      for (let i = 0; i < 10; ++i) {
        await vi.advanceTimersByTimeAsync(90);
        f.transport.send({ type: "tool_execution_update", toolCallId: "long", toolName: "bash", partialResult: { content: [{ type: "text", text: `progress ${i}` }] } }); await tick();
        expect(f.transport.closed).toBe(false);
      }
      f.transport.send({ type: "tool_execution_end", toolCallId: "long", toolName: "bash", result: { content: [{ type: "text", text: "done" }] }, isError: false });
      const message = { role: "assistant", responseId: "done", provider: "neutral", model: "model", content: [{ type: "text", text: "done" }], stopReason: "stop" };
      f.transport.send({ type: "message_start", message }); f.transport.send({ type: "message_end", message }); f.transport.send({ type: "agent_settled" }); await tick();
      expect(f.events.some(event => event.eventType === "turn.completed" && event.turnId === first.turnId)).toBe(true);
      await vi.advanceTimersByTimeAsync(1000); expect(f.transport.closed).toBe(false);
      await f.session.attachRun!({ runId: "run-next" });
      const next = await f.session.startTurn({ message: { role: "user", text: "silent next" } });
      await vi.advanceTimersByTimeAsync(100); await tick();
      expect(f.events.filter(event => event.eventType === "turn.failed")).toMatchObject([{ runId: "run-next", turnId: next.turnId, payload: { error: { code: "pi_turn_idle_timeout" } } }]);
    } finally { vi.useRealTimers(); await f.close(); }
  });
});
