import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver } from "../drivers/pi/pi-rpc-driver.js";
import { createPiSteerRecordingPeer } from "../../test-support/pi-rpc-steer-peer.js";
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

  // Keep reason: real facade -> driver -> Pi JSONL contract and input ownership.
  it("bridges the executor's turn/steer to Pi and consumes it in the same facade turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-proxy-steer-"));
    const peer = createPiSteerRecordingPeer(join(root, "commands.jsonl"));
    const sink = new FakeSink();
    const proxy = createPiRpcAppServerProxy({
      stdout: sink,
      createDriver: () => new PiRpcDriver({ ...peer.driverOptions, runtimeDirectory: root }),
      environment: { PAPERCLIP_RUN_ID: "steer-run", PAPERCLIP_NORMALIZED_SESSION_ID: "steer-session" },
    });
    try {
      const opened = await request(proxy, sink, 31, "thread/start", { cwd: root, model: "provider/model" });
      const threadId = (opened.result as { thread: { id: string } }).thread.id;
      const started = await request(proxy, sink, 32, "turn/start", { input: [{ type: "text", text: "scenario:queue" }] });
      const turnId = ((started.result as { turn: { id: string } }).turn.id);
      const params = { threadId, expectedTurnId: turnId, input: [{ type: "text", text: "steering-marker", text_elements: [] }] };
      for (const [index, expectedTurnId] of ["wrong-turn", "", undefined].entries()) {
        expect(await request(proxy, sink, 33 + index, "turn/steer", { ...params, expectedTurnId })).toMatchObject({ error: { code: -32000, message: expect.stringMatching(/not the active turn/) } });
      }
      expect(await request(proxy, sink, 36, "turn/steer", { ...params, mode: "follow_up" })).toMatchObject({ error: { code: -32000, message: expect.stringMatching(/follow.up.*unavailable/i) } });
      expect(await request(proxy, sink, 37, "turn/steer", params)).toEqual({ id: 37, result: { accepted: true } });
      const consumed = () => sink.decoded().filter(frame => frame.method === "item/completed" && (frame.params as { item?: { type?: string; text?: string } })?.item?.type === "userMessage" && (frame.params as { text?: string }).text === "steering-marker");
      expect(consumed()).toEqual([]);
      await peer.releaseConsumption();
      await waitFor(() => sink.decoded().some(frame => frame.method === "turn/completed"));
      expect(consumed()).toHaveLength(1);
      expect(consumed()[0]).toMatchObject({ params: { threadId, turnId, item: { type: "userMessage", content: [{ type: "text", text: "steering-marker" }] } } });
      expect(sink.decoded().filter(frame => frame.method === "turn/started")).toHaveLength(1);
      expect(sink.decoded().filter(frame => frame.method === "turn/completed")).toHaveLength(1);
      expect(await request(proxy, sink, 38, "turn/steer", params)).toMatchObject({ error: { code: -32000, message: expect.stringMatching(/not the active turn/) } });
      expect((await peer.commands()).filter(command => ["prompt", "steer", "abort", "follow_up"].includes(command.type))).toEqual([
        expect.objectContaining({ type: "prompt", message: "scenario:queue" }),
        expect.objectContaining({ type: "steer", message: "steering-marker" }),
      ]);
    } finally {
      await proxy.close();
      await peer.transport.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["started", "handled", ""])("returns an error instead of accepting a non-queued Pi steer (%j)", async disposition => {
    const root = await mkdtemp(join(tmpdir(), "pi-rpc-proxy-ack-"));
    const peer = createPiSteerRecordingPeer(join(root, "commands.jsonl"), disposition);
    const sink = new FakeSink();
    const proxy = createPiRpcAppServerProxy({
      stdout: sink,
      createDriver: () => new PiRpcDriver({ ...peer.driverOptions, runtimeDirectory: root }),
    });
    try {
      await request(proxy, sink, 41, "thread/start", { cwd: root, model: "provider/model" });
      const started = await request(proxy, sink, 42, "turn/start", { input: [{ type: "text", text: "scenario:queue" }] });
      const turnId = (started.result as { turn: { id: string } }).turn.id;
      expect(await request(proxy, sink, 43, "turn/steer", { expectedTurnId: turnId, input: [{ type: "text", text: "steering-marker" }] }))
        .toMatchObject({ error: { code: -32000, message: expect.stringContaining("did not queue") } });
    } finally {
      await proxy.close();
      await peer.transport.close();
      await rm(root, { recursive: true, force: true });
    }
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
