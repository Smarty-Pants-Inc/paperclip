import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcDriverOptions, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: Stop is a data-safety/authority boundary. Lost abort ACK and
// missing native settlement are cheap deterministic controls for escalation.
class StopTransport {
  pid = 42; exited = false; closed = false;
  commands: string[] = [];
  steering = ["queued steering"]; followUp = ["queued follow-up"];
  abort: () => Promise<void> = async () => { this.send({ type: "agent_end", messages: [] }); this.send({ type: "agent_settled", aborted: true }); };
  private queue: PiRpcRecord[] = [];
  private wake?: () => void;
  async request(type: string) {
    this.commands.push(type);
    if (type === "clear_queue") { this.steering = []; this.followUp = []; }
    if (type === "abort") await this.abort();
    return { success: true, data: type === "get_state" ? { sessionId: "native-stop", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: this.steering.length + this.followUp.length }
      : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
      : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_thinking_levels" ? { levels: ["high"] }
      : type === "prompt" ? { disposition: "started" } : undefined };
  }
  send(record: PiRpcRecord) { this.queue.push(record); this.wake?.(); }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const value = this.queue.shift();
      if (value) { yield value; continue; }
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.commands.push("physical_close"); this.closed = this.exited = true; this.wake?.(); }
}
async function fixture(options: Partial<PiRpcDriverOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-stop-unit-")); await mkdir(join(root, "agent"));
  const transport = new StopTransport();
  // Admission starts empty; enqueue only after opening the real driver.
  transport.steering = []; transport.followUp = [];
  const session = await new PiRpcDriver({ runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high",
    environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, ...options,
    transportFactory: () => transport as unknown as PiRpcTransport,
  }).openSession({ runId: "run-stop", normalizedSessionId: "stop", workingDirectory: root }) as PiRpcHarnessSession;
  const events: PrpEvent[] = [];
  const drain = (async () => { for await (const event of session.events()) events.push(event); })();
  const turn = await session.startTurn({ message: { role: "user", text: "long tool" } });
  transport.send({ type: "agent_start" }); await new Promise<void>(resolve => setImmediate(resolve));
  return { session, transport, turn, events, async close() { await session.close(); await drain; } };
}

describe("Pi Stop abort ladder", () => {
  it("clears both queues before abort, publishes cancelled once, then reuses the same transport/session", async () => {
    const f = await fixture();
    try {
      f.transport.steering = ["do not execute"]; f.transport.followUp = ["do not execute either"];
      const before = f.session.ids();
      await f.session.interrupt({ turnId: f.turn.turnId });
      expect(f.transport.commands.indexOf("clear_queue")).toBeLessThan(f.transport.commands.indexOf("abort"));
      expect(f.transport.steering).toEqual([]); expect(f.transport.followUp).toEqual([]);
      expect(f.transport.closed).toBe(false); expect(f.session.processPid()).toBe(42); expect(f.session.ids()).toEqual(before);
      expect(f.events.filter(e => /^turn\.(completed|cancelled|failed)$/.test(e.eventType))).toMatchObject([{ eventType: "turn.cancelled", turnId: f.turn.turnId }]);
      await f.session.attachRun({ runId: "run-after-stop" });
      const next = await f.session.startTurn({ message: { role: "user", text: "continue" } });
      expect(next.turnId).not.toBe(f.turn.turnId); expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["ack", "settlement"])("retires only when the abort %s never arrives within the bound", async missing => {
    const f = await fixture({ abortTimeoutMs: 30 } as Partial<PiRpcDriverOptions>);
    try {
      f.transport.abort = missing === "ack" ? () => new Promise<void>(() => {}) : async () => {};
      // A swallowed escalation looks identical to a clean reusable Stop to the
      // embedding owner. Keep the cleanup failure observable after retirement.
      await expect(f.session.interrupt({ turnId: f.turn.turnId })).rejects.toThrow();
      expect(f.transport.commands).toContain("abort"); expect(f.transport.closed).toBe(true);
      expect(f.events.some(e => e.eventType === "turn.cancelled")).toBe(true);
      expect(f.events.some(e => e.eventType === "harness.diagnostic" && e.payload.code === "pi_abort_escalated")).toBe(true);
    } finally { await f.close(); }
  });

  it("does not confuse agent_end with final settlement or report a racing successful end as completed", async () => {
    const f = await fixture(); let release!: () => void;
    try {
      f.transport.abort = async () => { f.transport.send({ type: "agent_end", messages: [] }); await new Promise<void>(resolve => { release = resolve; }); };
      const stopping = f.session.interrupt({ turnId: f.turn.turnId });
      await vi.waitFor(() => expect(f.transport.commands).toContain("abort"));
      expect(f.events.some(e => e.eventType === "turn.cancelled")).toBe(false); expect(f.transport.closed).toBe(false);
      f.transport.send({ type: "agent_settled", aborted: false }); release(); await stopping;
      expect(f.events.filter(e => /^turn\.(completed|cancelled|failed)$/.test(e.eventType))).toMatchObject([{ eventType: "turn.cancelled" }]);
      expect(f.transport.closed).toBe(false);
    } finally { release?.(); await f.close(); }
  });

  it("ignores stale turn-specific Stop and keeps an already idle resident warm", async () => {
    const f = await fixture();
    try {
      await f.session.interrupt({ turnId: "stale" }); expect(f.transport.commands).not.toContain("abort");
      await f.session.interrupt(); await f.session.interrupt();
      expect(f.transport.commands.filter(command => command === "abort")).toHaveLength(1); expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });
});
