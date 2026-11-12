import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcCommandError, PiRpcRequestTimeoutError, type PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: native control/data safety boundary. A compaction must never
// submit user input, acquire tool authority, reset identity or report a lost ACK as success.
class CompactTransport {
  closed = false; exited = false; pid = 123;
  queue: PiRpcRecord[] = []; wake?: () => void;
  calls: Array<{ type: string; params: unknown }> = [];
  compactError?: Error;
  onCompact?: () => Promise<void>;
  onAbort?: () => Promise<void>;
  skipEnd = false; aborted = false;
  result = { summary: "kept context", firstKeptEntryId: "entry", tokensBefore: 100, estimatedTokensAfter: 25 };
  send(event: PiRpcRecord) { this.queue.push(event); this.wake?.(); }
  async request(type: string, params?: unknown) {
    this.calls.push({ type, params });
    if (type === "abort") await this.onAbort?.();
    if (type === "compact") {
      this.send({ type: "compaction_start", reason: "manual" });
      await this.onCompact?.();
      if (this.compactError) throw this.compactError;
      if (!this.skipEnd) this.send({ type: "compaction_end", reason: "manual", result: this.result, aborted: this.aborted });
      return { data: this.result };
    }
    return { data: type === "get_state" ? { sessionId: "native-session", model: { provider: "neutral", id: "model" }, thinkingLevel: "high", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "get_available_models" ? { models: [{ provider: "neutral", id: "model" }] }
      : type === "set_model" ? { provider: "neutral", id: "model" }
      : type === "get_available_thinking_levels" ? { levels: ["high"] }
      : type === "prompt" ? { disposition: "started" } : undefined };
  }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) {
      const event = this.queue.shift();
      if (event) yield event;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-compact-unit-"));
  const transport = new CompactTransport();
  const session = await new PiRpcDriver({ startupTimeoutMs: 100, runtimeDirectory: join(root, "sessions"), model: "neutral/model", piRpcThinkingLevel: "high", environment: { PI_CODING_AGENT_DIR: join(root, "agent") }, transportFactory: () => transport as unknown as PiRpcTransport })
    .openSession({ runId: "compact-run", normalizedSessionId: "compact-host", workingDirectory: root }) as PiRpcHarnessSession;
  const events: PrpEvent[] = [];
  const drained = (async () => { for await (const event of session.events()) events.push(event); })();
  return { session, transport, events, async close() { await session.close(); await drained; await rm(root, { recursive: true, force: true }); } };
}

describe("Pi manual compaction", () => {
  it("sends native compact with optional instructions, returns the result and projects progress without a user turn", async () => {
    const f = await fixture();
    try {
      const before = await f.session.snapshot();
      expect(await f.session.compact({ customInstructions: "retain the decision" })).toEqual(f.transport.result);
      await vi.waitFor(() => expect(f.events.some(event => event.eventType === "context.compacted")).toBe(true));
      expect(f.transport.calls.filter(call => call.type === "compact")).toEqual([{ type: "compact", params: { customInstructions: "retain the decision" } }]);
      expect(f.transport.calls.some(call => call.type === "prompt")).toBe(false);
      expect(f.events.filter(event => event.eventType.startsWith("turn."))).toEqual([]);
      expect(f.events.filter(event => event.eventType === "provider.notice.recorded")).toHaveLength(2);
      expect(f.events.find(event => event.eventType === "context.compacted")).toMatchObject({ runId: "compact-run", payload: { reason: "manual", preTokens: 100, postTokens: 25, sameSession: true } });
      expect(await f.session.snapshot()).toMatchObject({ driverSessionId: before.driverSessionId, sessionFile: before.sessionFile, activeTurnId: null });
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });

  it("refuses to interrupt an active conversation turn", async () => {
    const f = await fixture();
    try {
      await f.session.startTurn({ message: { role: "user", text: "still working" } });
      await expect(f.session.compact()).rejects.toThrow(/active turn|busy/);
      expect(f.transport.calls.some(call => call.type === "compact")).toBe(false);
    } finally { await f.close(); }
  });

  // Keep reason: the line's Stop ladder must finish its native idle proof
  // before a new administrative operation can acquire the same session.
  it("waits for clean Stop settlement and its abort ACK before compacting the same session", async () => {
    const f = await fixture();
    let release!: () => void;
    try {
      const before = f.session.ids();
      const turn = await f.session.startTurn({ message: { role: "user", text: "stop before compact" } });
      f.transport.send({ type: "agent_start" });
      await new Promise<void>(resolve => setImmediate(resolve));
      f.transport.onAbort = async () => {
        f.transport.send({ type: "agent_settled", aborted: true });
        await new Promise<void>(resolve => { release = resolve; });
      };
      const stopping = f.session.interrupt({ turnId: turn.turnId });
      await vi.waitFor(() => expect(f.events.some(event => event.eventType === "turn.cancelled")).toBe(true));
      const compacting = f.session.compact();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(f.transport.calls.some(call => call.type === "compact")).toBe(false);
      release(); await stopping;
      expect(await compacting).toEqual(f.transport.result);
      expect(f.session.ids()).toEqual(before);
      expect(f.session.processPid()).toBe(123);
      expect(f.transport.closed).toBe(false);
      const commands = f.transport.calls.map(call => call.type);
      expect(commands.indexOf("clear_queue")).toBeLessThan(commands.indexOf("abort"));
      expect(commands.indexOf("abort")).toBeLessThan(commands.indexOf("compact"));
      expect(f.transport.calls.filter(call => call.type === "prompt")).toHaveLength(1);
    } finally { release?.(); await f.close(); }
  });

  it("surfaces native refusal and never fabricates a successful compaction", async () => {
    const f = await fixture();
    try {
      f.transport.compactError = new PiRpcCommandError("compact", { error: "Nothing to compact (session too small)" });
      await expect(f.session.compact()).rejects.toThrow("Nothing to compact");
      expect(f.events.some(event => event.eventType === "context.compacted")).toBe(false);
      expect(f.transport.calls.filter(call => call.type === "compact")).toHaveLength(1);
      expect(f.transport.closed).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["missing_end", "aborted_end", "missing_receipt"])("fences %s and never reports a successful compaction", async failure => {
    const f = await fixture();
    try {
      if (failure === "missing_end") f.transport.skipEnd = true;
      if (failure === "aborted_end") f.transport.aborted = true;
      if (failure === "missing_receipt") f.transport.result.firstKeptEntryId = "";
      await expect(f.session.compact()).rejects.toThrow(/end event missing|unsuccessfully|receipt/);
      expect(f.transport.closed).toBe(true);
      expect(f.events.some(event => event.eventType === "context.compacted")).toBe(false);
      expect(f.transport.calls.filter(call => call.type === "compact")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("fences an unknown compact response, does not retry and never admits later input", async () => {
    const f = await fixture();
    try {
      f.transport.compactError = new PiRpcRequestTimeoutError("compact", 1);
      await expect(f.session.compact()).rejects.toThrow("acceptance is unknown");
      expect(f.transport.closed).toBe(true);
      await expect(f.session.startTurn({ message: { role: "user", text: "forbidden" } })).rejects.toThrow();
      expect(f.transport.calls.filter(call => call.type === "compact")).toHaveLength(1);
    } finally { await f.close(); }
  });
});
