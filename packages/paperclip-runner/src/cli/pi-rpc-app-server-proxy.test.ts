import { describe, expect, it, vi } from "vitest";
import { createPiEventProjector } from "../drivers/pi/pi-event-projector.js";
import type { HarnessDriver, HarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
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

it("thread/resume passes the saved native identity and execution-host cwd to driver recovery", async () => {
  const sink = new FakeSink(); const session = new FakeSession();
  const driver = makeDriver(session);
  driver.openSession = vi.fn(driver.openSession);
  driver.recoverSession = vi.fn(async () => ({ recovered: true, session: session as unknown as HarnessSession }));
  const proxy = createPiRpcAppServerProxy({ stdout: sink, environment: { PAPERCLIP_RUN_ID: "run-new", PAPERCLIP_NORMALIZED_SESSION_ID: "conversation" }, createDriver: () => driver });
  try {
    proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: session.id, cwd: "/workspace/remote-agent", model: "neutral/model" } }));
    await vi.waitFor(() => expect(sink.decoded().some(frame => frame.id === 1)).toBe(true));
    expect(sink.decoded().find(frame => frame.id === 1)).toMatchObject({ result: { thread: { id: session.id } } });
    expect(driver.openSession).not.toHaveBeenCalled();
    expect(driver.recoverSession).toHaveBeenCalledWith(expect.objectContaining({ driverKind: "pi_rpc", driverSessionId: session.id,
      providerSessionId: session.id, runId: "run-new", normalizedSessionId: "conversation", workingDirectory: "/workspace/remote-agent" }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  } finally { await proxy.close(); }
});

it("thread/resume refuses an invalid saved Pi file with its typed code and never opens a fresh one", async () => {
  const code = "pi_session_file_invalid";
  const sink = new FakeSink(); const driver = makeDriver(new FakeSession());
  driver.openSession = vi.fn(driver.openSession);
  driver.recoverSession = vi.fn(async () => { throw Object.assign(new Error("Saved Pi history could not be loaded"), { code }); });
  const proxy = createPiRpcAppServerProxy({ stdout: sink, environment: { PAPERCLIP_NORMALIZED_SESSION_ID: "conversation" }, createDriver: () => driver });
  try {
    proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "native-id", cwd: "/workspace", model: "neutral/model" } }));
    await vi.waitFor(() => expect(sink.decoded().some(frame => frame.id === 1)).toBe(true));
    expect(sink.decoded().find(frame => frame.id === 1)).toMatchObject({ error: { code: -32000, data: { code } } });
    expect(driver.openSession).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});

it("thread/resume with the saved Pi file missing on this box continues in a fresh Pi conversation under the same id", async () => {
  const sink = new FakeSink(); const session = new FakeSession(); const driver = makeDriver(session);
  driver.openSession = vi.fn(driver.openSession);
  driver.recoverSession = vi.fn(async () => { throw Object.assign(new Error("Saved Pi session file is missing"), { code: "pi_session_file_missing" }); });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const proxy = createPiRpcAppServerProxy({ stdout: sink, environment: { PAPERCLIP_RUN_ID: "run-new", PAPERCLIP_NORMALIZED_SESSION_ID: "conversation" }, createDriver: () => driver });
  try {
    proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "native-id", cwd: "/workspace", model: "neutral/model" } }));
    await vi.waitFor(() => expect(sink.decoded().some(frame => frame.id === 1)).toBe(true));
    expect(sink.decoded().find(frame => frame.id === 1)).toMatchObject({ result: { thread: { id: session.id } } });
    expect(driver.openSession).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-new", normalizedSessionId: "conversation", workingDirectory: "/workspace" }));
    expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain("pi_session_history_missing");
  } finally { stderr.mockRestore(); await proxy.close(); }
});

it.each(["thread/start", "thread/resume"])("%s refuses without the server-owned conversation id (no minted or thread-id fallback)", async method => {
  const sink = new FakeSink(); const driver = makeDriver(new FakeSession());
  driver.openSession = vi.fn(driver.openSession);
  driver.recoverSession = vi.fn(async () => ({ recovered: false, reason: "unused" }));
  const createDriver = vi.fn(() => driver);
  const proxy = createPiRpcAppServerProxy({ stdout: sink, environment: {}, createDriver });
  try {
    proxy.acceptLine(JSON.stringify({ id: 1, method, params: { threadId: "native-id", cwd: "/workspace", model: "neutral/model" } }));
    await vi.waitFor(() => expect(sink.decoded().some(frame => frame.id === 1)).toBe(true));
    expect(sink.decoded().find(frame => frame.id === 1)).toMatchObject({ error: { code: -32000 } });
    expect(createDriver).not.toHaveBeenCalled();
    expect(driver.recoverSession).not.toHaveBeenCalled();
    expect(driver.openSession).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});

it.each(["", "   "])("thread/start refuses an empty conversation id (%j)", async normalizedSessionId => {
  const sink = new FakeSink();
  const createDriver = vi.fn(() => makeDriver(new FakeSession()));
  const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver, environment: { PAPERCLIP_NORMALIZED_SESSION_ID: normalizedSessionId } });
  try {
    expect(await request(proxy, sink, 1, "thread/start", { model: "neutral/model" })).toMatchObject({
      error: { code: -32000, message: "Pi RPC thread/start requires PAPERCLIP_NORMALIZED_SESSION_ID" },
    });
    expect(createDriver).not.toHaveBeenCalled();
  } finally { await proxy.close(); }
});

it("thread/start passes the exact server-owned conversation id without minting", async () => {
  const sink = new FakeSink(); const driver = makeDriver(new FakeSession());
  driver.openSession = vi.fn(driver.openSession);
  const proxy = createPiRpcAppServerProxy({ stdout: sink, environment: { PAPERCLIP_RUN_ID: "run-new", PAPERCLIP_NORMALIZED_SESSION_ID: "server-conversation" }, createDriver: () => driver });
  try {
    expect(await request(proxy, sink, 1, "thread/start", { cwd: "/workspace", model: "neutral/model" })).toHaveProperty("result");
    expect(driver.openSession).toHaveBeenCalledExactlyOnceWith({ runId: "run-new", normalizedSessionId: "server-conversation", workingDirectory: "/workspace" });
  } finally { await proxy.close(); }
});

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
  it("adapts real Pi usage to Rust total/last without double counting warm turns", async () => {
    const sink = new FakeSink();
    const session = Object.assign(new FakeSession(), { async attachRun() {} });
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
    try {
      await request(proxy, sink, 101, "thread/start", { model: "neutral/model" });
      for (const [index, runId] of ["run-1", "run-2"].entries()) {
        if (index) await request(proxy, sink, 102, "run.attach", { runId });
        const projector = createPiEventProjector({ runId, turnId: `usage-${index}` });
        for (const receipt of [1, 2]) {
          const native = { type: "message_end", message: { role: "assistant", responseId: `${index}-${receipt}`, provider: "neutral", model: "model", stopReason: "stop", content: [], usage: { input: 11, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 16 } } };
          const events = projector.project(native);
          expect(projector.project(native)).toEqual([]);
          for (const event of events.filter(e => e.eventType === "usage.reported")) session.push(event.eventType, event.payload, event.turnId, event.itemId, runId);
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const usage = sink.decoded().filter(f => f.method === "thread/tokenUsage/updated");
      expect(usage).toHaveLength(4);
      for (const [index, frame] of usage.entries()) expect(frame).toMatchObject({ params: { tokenUsage: { total: { inputTokens: 11 * (index + 1), outputTokens: 3 * (index + 1), cacheReadTokens: 2 * (index + 1) }, last: { inputTokens: 11 * (index % 2 + 1), outputTokens: 3 * (index % 2 + 1), cacheReadTokens: 2 * (index % 2 + 1) } } } });
      // `last` is a turn snapshot, not another delta to sum on every update.
      expect([usage[1], usage[3]].reduce((sum, frame) => sum + ((frame.params as any).tokenUsage.last.inputTokens), 0)).toBe(44);
    } finally { await proxy.close(); }
  });
  // Keep reason: harness-comparison gap #4 corrupts persisted spend at the
  // native Pi -> facade -> Rust total/last contract boundary.
  it("deduplicates re-sent message usage at the facade, including after another turn", async () => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
    try {
      await request(proxy, sink, 120, "thread/start", { model: "neutral/model" });
      const payload = { providerRequestId: "receipt-1", runDelta: { inputTokens: 11, outputTokens: 0 }, runDeltaAvailable: true, accountingComplete: true };
      session.push("usage.reported", payload, "turn-a", "usage-1");
      session.push("usage.reported", { ...payload, runDelta: { outputTokens: 0, inputTokens: 11 } }, "turn-a", "usage-1");
      session.push("usage.reported", { ...payload, providerRequestId: "receipt-2" }, "turn-b", "usage-2");
      session.push("usage.reported", payload, "turn-a", "usage-1");
      await new Promise<void>(resolve => setImmediate(resolve));
      const usage = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated");
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({ params: { tokenUsage: { total: { inputTokens: 11 }, last: { inputTokens: 11 } } } });
      expect(usage[1]).toMatchObject({ params: { tokenUsage: { total: { inputTokens: 22 }, last: { inputTokens: 11 } } } });
    } finally { await proxy.close(); }
  });

  it("reconciles T1-T4 turn snapshots to the sum of native Pi message receipts", async () => {
    const sink = new FakeSink();
    const session = Object.assign(new FakeSession(), { async attachRun() {} });
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
    const turns = [[11, 11], [3, 7], [5], [2, 4, 8]];
    let sessionInput = 0;
    try {
      await request(proxy, sink, 130, "thread/start", { model: "neutral/model" });
      for (const [index, messages] of turns.entries()) {
        const runId = index < 2 ? "run-1" : "run-2";
        if (index === 2) await request(proxy, sink, 131, "run.attach", { runId });
        const turnId = `T${index + 1}`;
        const projector = createPiEventProjector({ runId, turnId });
        let turnInput = 0;
        for (const [message, input] of messages.entries()) {
          const events = projector.project({ type: "message_end", message: {
            role: "assistant", provider: "neutral", model: "model", responseId: `${turnId}-${message}`,
            stopReason: "stop", content: [], usage: { input, output: input, cacheRead: 1, cacheWrite: 2 },
          } });
          for (const event of events.filter(event => event.eventType === "usage.reported")) session.push(event.eventType, event.payload, event.turnId, event.itemId, runId);
          sessionInput += input; turnInput += input;
          await new Promise<void>(resolve => setImmediate(resolve));
          const latest = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated").at(-1)!;
          expect(latest).toMatchObject({ params: { turnId, tokenUsage: {
            total: { inputTokens: sessionInput, outputTokens: sessionInput },
            last: { inputTokens: turnInput, outputTokens: turnInput, cacheReadTokens: message + 1, cacheWriteTokens: 2 * (message + 1) },
          } } });
        }
      }
      const finals = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated")
        .filter((frame, index, all) => (all[index + 1]?.params as any)?.turnId !== (frame.params as any).turnId);
      expect(finals.map(frame => (frame.params as any).tokenUsage.last.inputTokens)).toEqual(turns.map(messages => messages.reduce((sum, value) => sum + value, 0)));
      expect((finals.at(-1)!.params as any).tokenUsage.total.inputTokens).toBe(51);
    } finally { await proxy.close(); }
  });

  it.each(["first", "last"])("does not label a turn complete when its %s message lacks usage", async missing => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
    try {
      await request(proxy, sink, 140, "thread/start", { model: "neutral/model" });
      const projector = createPiEventProjector({ runId: "run-1", turnId: "incomplete" });
      for (const [index, hasUsage] of (missing === "first" ? [false, true] : [true, false]).entries()) {
        const events = projector.project({ type: "message_end", message: {
          role: "assistant", provider: "neutral", model: "model", responseId: `message-${index}`, stopReason: "stop", content: [],
          ...(hasUsage ? { usage: { input: 11, output: 0, cacheRead: 0, cacheWrite: 0 } } : {}),
        } });
        for (const event of events) session.push(event.eventType, event.payload, event.turnId, event.itemId);
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      const latest = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated").at(-1)!;
      expect(latest).toMatchObject({ params: { tokenUsage: { total: { inputTokens: 11 } }, runDeltaAvailable: false } });
      // Rust uses the presence of tokenUsage.last as runDeltaAvailable. A
      // top-level accountingComplete:false alone does not survive normalization.
      expect((latest.params as any).tokenUsage).not.toHaveProperty("last");
    } finally { await proxy.close(); }
  });

  it("preserves explicit incomplete accounting even when the message has all token fields", async () => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
    try {
      await request(proxy, sink, 150, "thread/start", { model: "neutral/model" });
      session.push("usage.reported", { providerRequestId: "partial", runDelta: { inputTokens: 11 }, runDeltaAvailable: true, accountingComplete: false }, "partial", "partial");
      await new Promise<void>(resolve => setImmediate(resolve));
      const latest = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated").at(-1)!;
      expect(latest).toMatchObject({ params: { runDeltaAvailable: false, tokenUsage: { total: { inputTokens: 11 } } } });
      expect((latest.params as any).tokenUsage).not.toHaveProperty("last");
    } finally { await proxy.close(); }
  });

  // Keep reason: the Pi/Rust facade boundary must retain non-zero accounting.
  // Run usage is computed after this wire boundary in runner-core's
  // provider_events.rs (normalize_codex_notification reads total/last into
  // usage.reported); these TypeScript proxy/driver tests do not run Rust.
  it("emits Pi usage.reported as thread/tokenUsage/updated with non-zero total and last", async () => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
    try {
      await request(proxy, sink, 110, "thread/start", { model: "neutral/model" });
      const cumulative = { inputTokens: 24, outputTokens: 6, totalTokens: 30 };
      const runDelta = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
      session.push("usage.reported", { cumulative, runDelta, runDeltaAvailable: true }, "usage-turn");
      await waitFor(() => sink.decoded().some(frame => frame.method === "thread/tokenUsage/updated"));
      const frames = sink.decoded().filter(frame => frame.method === "thread/tokenUsage/updated");
      expect(frames).toEqual([{
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "pi-session", turnId: "usage-turn",
          tokenUsage: { total: cumulative, last: runDelta },
          cumulative, runDelta, runDeltaAvailable: true,
        },
      }]);
    } finally { await proxy.close(); }
  });

  // Keep reason: incident439 lost the actionable cause at the facade/Rust wire
  // boundary. Forward captured IDs; the receiver owns run/turn attribution.
  it.each([
    ["inactive run", "run-1"],
    ["inactive turn", "run-2"],
  ])("forwards session failure cause and every terminal event for an %s", async (_origin, runId) => {
    const sink = new FakeSink();
    const session = Object.assign(new FakeSession(), {
      async attachRun() {},
      async startTurn() { return { turnId: "current-turn" }; },
    });
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
    try {
      await request(proxy, sink, 80, "thread/start", { model: "neutral/model" });
      await request(proxy, sink, 81, "run.attach", { runId: "run-2" });
      await request(proxy, sink, 82, "turn/start", { input: [] });
      session.push("session.failed", { code: "pi_rpc_transport_failed", message: "CAPTURED_ECONNREFUSED" }, "old-turn", undefined, runId);
      const terminalTypes = ["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"];
      for (const eventType of terminalTypes) {
        session.push(eventType, { error: { code: "pi_rpc_transport_failed", message: "CAPTURED_CONTINUATION" } }, "old-turn", undefined, runId);
      }
      session.push("session.failed", { code: "pi_rpc_transport_failed", message: "CURRENT_ECONNREFUSED" }, undefined, undefined, "run-2");
      await waitFor(() => sink.decoded().some(frame => frame.method === "error"
        && (frame.params as Record<string, unknown>).message === "CURRENT_ECONNREFUSED"));
      expect(sink.decoded().filter(frame => frame.method === "error")).toEqual([
        { method: "error", params: { threadId: "pi-session", turnId: "old-turn", message: "CAPTURED_ECONNREFUSED", error: { code: "pi_rpc_transport_failed", message: "CAPTURED_ECONNREFUSED" }, willRetry: false } },
        { method: "error", params: { threadId: "pi-session", message: "CURRENT_ECONNREFUSED", error: { code: "pi_rpc_transport_failed", message: "CURRENT_ECONNREFUSED" }, willRetry: false } },
      ]);
      expect(sink.decoded().filter(frame => terminalTypes.some(type => frame.method === type.replace(".", "/"))))
        .toEqual(terminalTypes.map(type => ({
          method: type.replace(".", "/"),
          params: { threadId: "pi-session", turnId: "old-turn", turn: {
            id: "old-turn", status: type.slice("turn.".length),
            ...(type === "turn.failed" ? { error: { code: "pi_rpc_transport_failed", message: "CAPTURED_CONTINUATION" } } : {}),
          } },
        })));
      expect(await request(proxy, sink, 83, "thread/read")).toMatchObject({
        result: { thread: { turns: [{ id: "current-turn", status: "inProgress" }] } },
      });
    } finally { await proxy.close(); }
  });

  it.each(["plain", "\\u0000\\u0001\\n\\\"\\\\", "😀漢字"])("bounds projected partial facade frames with a visible marker (%s) and leaves final/short text untouched", async alphabet => {
    const sink = new FakeSink();
    const session = new FakeSession();
    const proxy = createPiRpcAppServerProxy({ stdout: sink, createDriver: () => makeDriver(session), environment: { PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" } });
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
      environment: { PAPERCLIP_NORMALIZED_SESSION_ID: "session-1" },
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
