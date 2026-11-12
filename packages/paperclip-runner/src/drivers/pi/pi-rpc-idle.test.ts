import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: L15's silent-provider failure cannot be reached cheaply in a
// live user flow. Exercise the real session pump and physical retirement path.
class IdleTransport {
  closed = false; exited = false; pid = null;
  queue: PiRpcRecord[] = []; wake?: () => void;
  async request(type: string) {
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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-idle-"));
  const transport = new IdleTransport();
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
    turnIdleTimeoutMs: 100, environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport,
  }).openSession({ runId: "run-old", normalizedSessionId: "normalized", workingDirectory: root });
  const events: PrpEvent[] = [];
  const drained = (async () => { for await (const event of session.events()) events.push(event); })();
  return { session, transport, events, async close() { await session.close(); await drained; await rm(root, { recursive: true, force: true }); } };
}

describe("Pi RPC active-turn event-idle deadline (L15)", () => {
  it.each([false, true])("fails and retires a silent turn (agent started: %s), never an idle session", async started => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.transport.closed).toBe(false);
      const turn = await f.session.startTurn({ message: { role: "user", text: "work" } });
      if (started) { f.transport.send({ type: "agent_start" }); await tick(); }
      await vi.advanceTimersByTimeAsync(99);
      expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await tick();
      expect(f.events.filter(event => event.eventType.startsWith("turn.") && event.eventType !== "turn.started")).toMatchObject([
        { eventType: "turn.failed", runId: "run-old", turnId: turn.turnId, payload: { status: "failed", error: { code: "pi_turn_idle_timeout", recoverable: false, message: expect.stringContaining("100") } } },
      ]);
      expect(f.transport.closed).toBe(true);
      await expect(f.session.startTurn({ message: { role: "user", text: "never reuse" } })).rejects.toThrow(/closed/);
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
        expect(f.transport.closed).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(99); expect(f.transport.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await tick(); expect(f.transport.closed).toBe(true);
      expect(f.events.filter(event => event.eventType === "turn.failed")).toHaveLength(1);
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
