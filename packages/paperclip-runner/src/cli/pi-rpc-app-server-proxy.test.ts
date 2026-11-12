import { describe, expect, it } from "vitest";
import type { HarnessDriver, HarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { createPiEventProjector } from "../drivers/pi/pi-event-projector.js";
import {
  createPiRpcAppServerProxy,
  parsePiThinkingLevel,
  type PiRpcProxyFrameSink,
} from "./pi-rpc-app-server-proxy.js";
import {
  TRUSTED_PI_EXECUTABLE_ARG,
  trustedPiLaunchBinding,
  withoutAmbientPiCommand,
} from "./pi-proxy-command.js";

class FakeSink implements PiRpcProxyFrameSink {
  readonly frames: string[] = [];
  #blocked = false;
  #drain: (() => void) | undefined;

  write(chunk: string): boolean {
    this.frames.push(chunk);
    return !this.#blocked;
  }

  once(event: "drain", listener: () => void): unknown {
    if (event === "drain") this.#drain = listener;
    return this;
  }

  block(): void { this.#blocked = true; }
  release(): void {
    this.#blocked = false;
    const drain = this.#drain;
    this.#drain = undefined;
    drain?.();
  }
  decoded(): Array<Record<string, unknown>> {
    return this.frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }
}

class FakeSession {
  readonly id = "pi-session";
  readonly closed: string[] = [];
  readonly interrupted: string[] = [];
  readonly turnInputs: unknown[] = [];
  #queued: PrpEvent[] = [];
  #waiter: ((event: PrpEvent | null) => void) | undefined;
  #ended = false;

  ids() { return { driverSessionId: this.id, providerSessionId: this.id }; }

  async *events(): AsyncIterable<PrpEvent> {
    while (!this.#ended) {
      const event = await new Promise<PrpEvent | null>((resolve) => {
        const queued = this.#queued.shift();
        if (queued) resolve(queued);
        else this.#waiter = resolve;
      });
      if (!event) return;
      yield event;
    }
  }

  push(eventType: string, payload: Record<string, unknown> = {}, turnId?: string, itemId?: string, runId = "run-1") {
    const event = {
      schema: "paperclip.prp.event.v3",
      sourceEventId: `e-${Date.now()}-${Math.random()}`,
      sourceSeq: this.#queued.length + 1,
      sourceInstanceId: "fake",
      sourceKind: "runner",
      runId,
      normalizedSessionId: "session-1",
      eventType,
      schemaVersion: 3,
      priority: 1,
      emittedAt: new Date().toISOString(),
      payload,
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
    } as PrpEvent;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter) waiter(event);
    else this.#queued.push(event);
  }

  async startTurn(input: unknown) {
    this.turnInputs.push(input);
    this.push("turn.started", {}, "turn-1");
    this.push("item.started", { kind: "agentMessage", text: "hello" }, "turn-1", "item-1");
    this.push("item.delta", { kind: "agentMessage", text: "hello" }, "turn-1", "item-1");
    this.push("item.completed", { kind: "agentMessage", text: "hello" }, "turn-1", "item-1");
    this.push("usage.reported", {
      provider: "pi", model: "test",
      cumulative: { inputTokens: 12, outputTokens: 3 },
      runDelta: { inputTokens: 12, outputTokens: 3 },
      runDeltaAvailable: true,
      context: { usedTokens: 15, windowTokens: 1000 },
    }, "turn-1");
    this.push("turn.completed", {}, "turn-1");
    return { turnId: "turn-1" };
  }

  async interrupt(input: { turnId?: string }) { this.interrupted.push(input.turnId ?? ""); }
  async close(input: { reason: string }) {
    this.closed.push(input.reason);
    this.#ended = true;
    this.#waiter?.(null);
    this.#waiter = undefined;
  }
}

function makeDriver(session: FakeSession): HarnessDriver {
  return {
    async descriptor() {
      return {
        kind: "pi_rpc", displayName: "Pi RPC", version: "test",
        capabilities: {} as never,
      };
    },
    async openSession() { return session as unknown as HarnessSession; },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for proxy output");
}

function lastResult(sink: FakeSink, id: number): Record<string, unknown> | undefined {
  return sink.decoded().find((frame) => frame.id === id);
}

async function request(
  proxy: ReturnType<typeof createPiRpcAppServerProxy>,
  sink: FakeSink,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
) {
  await proxy.acceptLine(JSON.stringify({ id, method, params }));
  await waitFor(() => lastResult(sink, id) !== undefined);
  return lastResult(sink, id)!;
}

describe("Pi RPC app-server facade proxy", () => {
  // Keep reason: real Pi 1.5.2 -> Rust lost 14/8 usage at this wire boundary.
  // provider_events.rs:1146-1171 reads tokenUsage.total/last (not cumulative/runDelta).
  it.each([false, true])("maps exact receipt totals and deltas for Rust, including warm model metadata (%s)", async warm => {
    const sink = new FakeSink();
    const session = Object.assign(new FakeSession(), { async attachRun() {} });
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1" } });
    try {
      await request(proxy, sink, 100, "thread/start", { model: "not-receipt/model" });
      if (warm) await request(proxy, sink, 101, "run.attach", { runId: "run-2" });
      const cumulative = { inputTokens: warm ? 114 : 14, outputTokens: warm ? 58 : 8, cacheReadTokens: 6, cacheWriteTokens: 2, requests: 2, providerCostUsd: 0.03 };
      const runDelta = { inputTokens: 14, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 1, requests: 1, providerCostUsd: 0.01 };
      const payload = { provider: "pi_rpc", model: "receipt/actual-model", providerRequestId: "receipt-request", cumulative, runDelta, runDeltaAvailable: true, costProvenance: "provider_reported" };
      session.push("usage.reported", payload, "receipt-turn", undefined, warm ? "run-2" : "run-1");
      await waitFor(() => sink.decoded().some(frame => frame.method === "thread/tokenUsage/updated"));
      expect(sink.decoded().find(frame => frame.method === "thread/tokenUsage/updated")).toEqual({
        method: "thread/tokenUsage/updated",
        params: { ...payload, threadId: "pi-session", turnId: "receipt-turn", tokenUsage: { total: cumulative, last: runDelta } },
      });
    } finally { await proxy.close(); }
  });

  it("passes actual Pi projector receipts without inventing totals, model or provider billing", async () => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1" } });
    try {
      await request(proxy, sink, 110, "thread/start", { model: "not-receipt/model" });
      const projector = createPiEventProjector({ runId: "run-1", turnId: "native-turn" });
      for (const responseId of ["native-1", "native-2"]) {
        for (const event of projector.project({ type: "message_end", message: {
          role: "assistant", responseId, timestamp: responseId === "native-1" ? 1 : 2,
          stopReason: "stop", content: [{ type: "text", text: responseId }],
          usage: { input: 7, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { total: 0.02 } },
        } })) if (event.eventType === "usage.reported") session.push(event.eventType, event.payload, event.turnId, event.itemId);
      }
      await waitFor(() => sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated").length === 2);
      const frames = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated");
      for (const frame of frames) expect(frame).toMatchObject({ params: {
        threadId: "pi-session", turnId: "native-turn", provider: "pi_rpc", model: null,
        providerRequestId: expect.any(String), costProvenance: "catalog_estimate", estimatedCostUsd: 0.02,
        tokenUsage: { total: {}, last: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      } });
      expect(JSON.stringify(frames)).not.toContain("providerCostUsd");
      expect(JSON.stringify(frames)).not.toContain("not-receipt/model");
    } finally { await proxy.close(); }
  });

  it("omits unavailable deltas after cancellation and never attributes old-run usage to a warm run", async () => {
    const sink = new FakeSink();
    const session = Object.assign(new FakeSession(), { async attachRun() {} });
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1" } });
    try {
      await request(proxy, sink, 120, "thread/start", { model: "not-receipt/model" });
      await request(proxy, sink, 121, "turn/interrupt", { turnId: "old-turn" });
      await request(proxy, sink, 122, "run.attach", { runId: "run-2" });
      session.push("usage.reported", { model: "stale-model", runDeltaAvailable: true, runDelta: { inputTokens: 999 } }, "old-turn");
      const cumulative = { inputTokens: 114, outputTokens: 58 };
      session.push("usage.reported", { cumulative, runDelta: { inputTokens: 999 }, runDeltaAvailable: false }, "new-turn", undefined, "run-2");
      await waitFor(() => sink.decoded().some(frame => frame.method === "thread/tokenUsage/updated"));
      const frames = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated");
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ params: { threadId: "pi-session", turnId: "new-turn", tokenUsage: { total: cumulative } } });
      const params = frames[0].params as Record<string, unknown>;
      expect(params.tokenUsage).not.toHaveProperty("last");
      expect(params).not.toHaveProperty("model");
      expect(JSON.stringify(frames)).not.toContain("stale-model");
    } finally { await proxy.close(); }
  });
  // Keep reason: incident439 lost the actionable cause at the facade/Rust wire
  // boundary. A stale diagnostic must not poison a later current-run failure.
  it("forwards session failure cause to the receiver, rejects stale origin, then accepts a legitimate current failure", async () => {
    const sink = new FakeSink();
    const session = Object.assign(new FakeSession(), { async attachRun() {} });
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1" } });
    try {
      await request(proxy, sink, 80, "thread/start", { model: "neutral/model" });
      await request(proxy, sink, 81, "run.attach", { runId: "run-2" });
      session.push("session.failed", { code: "pi_rpc_transport_failed", message: "OLD_ECONNREFUSED" }, "old-turn", undefined, "run-1");
      session.push("turn.failed", { error: { code: "pi_rpc_transport_failed", message: "OLD_CONTINUATION" } }, "old-turn", undefined, "run-1");
      session.push("session.failed", { code: "pi_rpc_transport_failed", message: "CURRENT_ECONNREFUSED" }, undefined, undefined, "run-2");
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(sink.frames.join("")).not.toContain("OLD_ECONNREFUSED");
      expect(sink.frames.join("")).not.toContain("OLD_CONTINUATION");
      expect(sink.decoded().find(frame => frame.method === "error")).toMatchObject({ params: { threadId: "pi-session", message: "CURRENT_ECONNREFUSED", error: { code: "pi_rpc_transport_failed", message: "CURRENT_ECONNREFUSED" } } });
    } finally { await proxy.close(); }
  });

  it.each(["plain", "\\u0000\\u0001\\n\\\"\\\\", "😀漢字"])("bounds projected partial facade frames with a visible marker (%s) and leaves final/short text untouched", async alphabet => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1" } });
    try {
      await request(proxy, sink, 90, "thread/start", { model: "neutral/model" });
      const large = alphabet.repeat(Math.ceil(4 * 1024 * 1024 / alphabet.length));
      const payload = { kind: "commandExecution", output: large, item: { id: "tool", type: "tool_use", name: "bash", input: { command: "cat" }, arguments: { command: "cat" } } };
      session.push("item.delta", payload, "turn-1", "tool");
      session.push("item.delta", { ...payload, output: "short output" }, "turn-1", "short");
      const final = "FINAL_" + "z".repeat(49_750);
      session.push("item.completed", { ...payload, text: final, output: final }, "turn-1", "tool");
      await new Promise<void>(resolve => setImmediate(resolve));
      const frames = sink.decoded().filter(frame => typeof frame.method === "string" && frame.method.startsWith("item/"));
      expect(JSON.stringify(frames[0])).toContain("[Pi tool output truncated");
      for (const frame of frames) expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(1024 * 1024);
      expect(frames[1]).toMatchObject({ params: { output: "short output" } });
      expect(frames[2]).toMatchObject({ params: { output: final, text: final } });
      expect(payload.output).toBe(large);
    } finally { await proxy.close(); }
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
    "preserves the Pi thinking level %s verbatim",
    (level) => expect(parsePiThinkingLevel(level)).toBe(level),
  );

  it("requires the runner-owned Pi executable binding and strips ambient command overrides", () => {
    expect(() => trustedPiLaunchBinding([])).toThrow(/refusing ambient PATH/);
    expect(() => trustedPiLaunchBinding([TRUSTED_PI_EXECUTABLE_ARG, "/tmp/unverified-pi"])).toThrow(/unavailable/);
    const original = { PAPERCLIP_PI_RPC_COMMAND: "/tmp/unverified-pi", MODEL_API_KEY: "kept" };
    expect(withoutAmbientPiCommand(original)).toEqual({ MODEL_API_KEY: "kept" });
    expect(original.PAPERCLIP_PI_RPC_COMMAND).toBe("/tmp/unverified-pi");
    if (process.platform === "linux") {
      // Node cannot run a JS entrypoint from a sealed memfd, so runnerd must
      // also pass the verified original path; the descriptor alone is refused.
      expect(() => trustedPiLaunchBinding([TRUSTED_PI_EXECUTABLE_ARG, "/proc/self/fd/7"]))
        .toThrow(/unavailable/);
    }
  });

  it("initializes, starts, submits turns, forwards events in order, interrupts, and closes", async () => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({
      stdout: sink,
      createDriver: () => makeDriver(session),
      environment: { PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" },
    });

    expect(await request(proxy, sink, 1, "initialize")).toMatchObject({
      result: { serverInfo: { name: "pi_rpc" } },
    });
    expect(await request(proxy, sink, 2, "thread/start", {
      cwd: "/workspace", model: "openrouter/test", piThinkingLevel: "high",
    })).toMatchObject({ result: { thread: { id: "pi-session", cwd: "/workspace" } } });
    expect(await request(proxy, sink, 3, "turn/start", {
      input: [{ type: "text", text: "hello" }], piThinkingLevel: "high",
    })).toMatchObject({ result: { turn: { id: "turn-1", status: "inProgress" } } });
    await waitFor(() => sink.decoded().some((frame) =>
      (frame.params as Record<string, unknown> | undefined)?.turnId === "turn-1"
      && (frame.method === "turn/completed")));

    const eventMethods = sink.decoded().map((frame) => frame.method).filter((method) =>
      typeof method === "string" && [
        "turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed",
      ].includes(method));
    expect(eventMethods).toEqual([
      "turn/started", "item/started", "item/agentMessage/delta", "item/completed", "turn/completed",
    ]);
    expect(sink.decoded().find((frame) => frame.method === "thread/tokenUsage/updated"))
      .toMatchObject({ params: {
        cumulative: { inputTokens: 12, outputTokens: 3 },
        runDelta: { inputTokens: 12, outputTokens: 3 },
        runDeltaAvailable: true,
        context: { usedTokens: 15, windowTokens: 1000 },
      } });
    expect(session.turnInputs[0]).toMatchObject({ piThinkingLevel: "high" });

    await request(proxy, sink, 4, "turn/interrupt", { turnId: "turn-1" });
    expect(session.interrupted).toEqual(["turn-1"]);
    await request(proxy, sink, 5, "thread/close");
    expect(session.closed).toEqual(["thread_close"]);
    await proxy.close();
  });

  it("returns a facade error on driver bootstrap failure and does not hang later requests", async () => {
    const sink = new FakeSink();
    const proxy = createPiRpcAppServerProxy({
      stdout: sink,
      createDriver: () => ({
        async descriptor() { throw new Error("unused"); },
        async openSession() { throw new Error("pi bootstrap failed"); },
      }),
    });
    expect(await request(proxy, sink, 11, "thread/start", { model: "provider/model" })).toMatchObject({
      id: 11, error: { code: -32000, message: "pi bootstrap failed" },
    });
    expect(await request(proxy, sink, 12, "turn/start")).toMatchObject({
      id: 12, error: { code: -32000, message: expect.stringContaining("bootstrap failed") },
    });
    await proxy.close();
  });

  it("honors stdout backpressure and preserves response frame order", async () => {
    const sink = new FakeSink();
    sink.block();
    const proxy = createPiRpcAppServerProxy({
      stdout: sink,
      createDriver: () => makeDriver(new FakeSession()),
    });
    await proxy.acceptLine('{"id":21,"method":"initialize","params":{}}');
    await proxy.acceptLine('{"id":22,"method":"initialize","params":{}}');
    expect(sink.frames).toHaveLength(1);
    sink.release();
    await waitFor(() => sink.frames.length === 2);
    expect(sink.decoded().map((frame) => frame.id)).toEqual([21, 22]);
    await proxy.close();
  });
});
