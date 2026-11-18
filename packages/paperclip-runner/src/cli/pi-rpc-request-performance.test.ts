import { describe, expect, it } from "vitest";
import type { HarnessDriver, HarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { createPiRpcAppServerProxy, type PiRpcProxyFrameSink } from "./pi-rpc-app-server-proxy.js";

type Frame = { id?: number; method?: string; params?: Record<string, unknown>; error?: unknown };
class Sink implements PiRpcProxyFrameSink {
  frames: Frame[] = [];
  write(chunk: string) { this.frames.push(JSON.parse(chunk)); return true; }
  once(_event: "drain", _listener: () => void) { return this; }
}
class Session {
  queue: PrpEvent[] = [];
  waiter: ((event: PrpEvent | null) => void) | undefined;
  ended = false;
  sequence = 0;
  ids() { return { driverSessionId: "opened-native-thread", providerSessionId: "opened-native-thread" }; }
  async *events(): AsyncIterable<PrpEvent> {
    while (!this.ended) {
      const event = await new Promise<PrpEvent | null>(resolve => {
        const queued = this.queue.shift();
        if (queued) resolve(queued); else this.waiter = resolve;
      });
      if (!event) return;
      yield event;
    }
  }
  push(eventType: string, payload: Record<string, unknown>, turnId: string, runId = "source-run") {
    const seq = ++this.sequence;
    const event = {
      schema: "paperclip.prp.event.v1", sourceEventId: `performance-${seq}`, sourceSeq: seq,
      sourceInstanceId: "admitted-runner", sourceKind: "runner", runId,
      normalizedSessionId: "normalized-not-native-thread", eventType, schemaVersion: 1, priority: 1,
      emittedAt: new Date(Date.now() - 500).toISOString(), turnId, payload,
    } as PrpEvent;
    const waiter = this.waiter; this.waiter = undefined;
    if (waiter) waiter(event); else this.queue.push(event);
  }
  async startTurn() { return { turnId: "mutable-current-turn" }; }
  async attachRun() {}
  async close() { this.ended = true; this.waiter?.(null); this.waiter = undefined; }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const sink = new Sink(), session = new Session();
  const driver: HarnessDriver = {
    async descriptor() { return { kind: "pi_rpc", displayName: "Pi", version: "test", capabilities: {} as never }; },
    async openSession() { return session as unknown as HarnessSession; },
  };
  const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => driver, environment: { PAPERCLIP_RUN_ID: "source-run" } });
  let nextId = 0;
  async function request(method: string, params: Record<string, unknown>) {
    const id = ++nextId;
    proxy.acceptLine(JSON.stringify({ id, method, params }));
    // One event-loop boundary drains the in-memory, nonblocking facade; no poller/timer.
    await tick();
    const response = sink.frames.find(frame => frame.id === id);
    expect(response, method).toBeDefined();
    expect(response).not.toHaveProperty("error");
  }
  return { sink, session, proxy, request };
}
const instant = (at: number) => ({ name: "pi.request.sent", startedAtMs: at, endedAtMs: at, outcome: "ok" });

// Keep reason: trust boundary between captured PRP identities and the Rust-facing facade protocol.
describe("Pi performance diagnostic -> existing providerPerformance facade", () => {
  it("preserves the source event's exact turn and hook timestamp after another turn/run becomes current (logical pre-dispatch, not physical HTTP-attempt proof)", async () => {
    const { sink, session, proxy, request } = fixture();
    try {
      await request("thread/start", { model: "paperclip/m" });
      await request("run.attach", { runId: "later-run" });
      await request("turn/start", { input: [{ type: "text", text: "new task" }] });
      const at = Date.now() - 250;
      session.push("harness.diagnostic", {
        code: "provider_performance_spans", spans: [{ ...instant(at), attributes: { prompt: "PRIVATE_PROMPT" }, runId: "forged", turnId: "forged" }],
        threadId: "forged-thread", turnId: "forged-turn", message: "PRIVATE_DIAGNOSTIC",
      }, "captured-old-turn", "source-run");
      await tick();
      expect(sink.frames.filter(frame => frame.method === "paperclip/providerPerformance")).toEqual([{
        method: "paperclip/providerPerformance",
        params: { threadId: "opened-native-thread", turnId: "captured-old-turn", spans: [instant(at)] },
      }]);
      expect(sink.frames.filter(frame => frame.method === "warning")).toEqual([]);
      expect(JSON.stringify(sink.frames)).not.toMatch(/PRIVATE|forged/);
    } finally { await proxy.close(); }
  });

  it("forwards all 24 per-hook instants including equal timestamps without converting performance into warnings; ordinary diagnostics remain warnings", async () => {
    const { sink, session, proxy, request } = fixture();
    try {
      await request("thread/start", { model: "paperclip/m" });
      const at = Date.now();
      for (let index = 0; index < 24; index++) {
        session.push("harness.diagnostic", { code: "provider_performance_spans", spans: [instant(at + Math.floor(index / 2))] }, "captured-turn");
      }
      session.push("harness.diagnostic", { code: "pi_native_activity", message: "ordinary notice" }, "captured-turn");
      await tick();
      expect(sink.frames.filter(frame => frame.method === "paperclip/providerPerformance")).toEqual(Array.from({ length: 24 }, (_, index) => ({
        method: "paperclip/providerPerformance",
        params: { threadId: "opened-native-thread", turnId: "captured-turn", spans: [instant(at + Math.floor(index / 2))] },
      })));
      expect(sink.frames.filter(frame => frame.method === "warning")).toEqual([{
        method: "warning", params: { threadId: "opened-native-thread", message: "ordinary notice" },
      }]);
    } finally { await proxy.close(); }
  });
});
