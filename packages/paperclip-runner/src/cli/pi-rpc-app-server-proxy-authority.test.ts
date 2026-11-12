import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessDriver, HarnessSession } from "../contracts/harness-driver.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import {
  createPiRpcAppServerProxy,
  type PiRpcDriverLaunchConfig,
  type PiRpcProxyFrameSink,
} from "./pi-rpc-app-server-proxy.js";

// Every case injects a HarnessDriver; keep the provider process out of this boundary test.
vi.mock("../drivers/pi/pi-rpc-driver.js", () => ({ PiRpcDriver: class {} }));

// Keep reason: the resident-session callback trust boundary must reject an old
// run's response without blocking an announced call from the current run.
type Frame = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type ToolCall = Parameters<PiRpcDriverLaunchConfig["dynamicToolHandler"]>[0];

class FakeSink implements PiRpcProxyFrameSink {
  readonly frames: Frame[] = [];
  backpressured = false;
  drain: (() => void) | undefined;
  write(chunk: string) { this.frames.push(JSON.parse(chunk) as Frame); return !this.backpressured; }
  once(_event: "drain", listener: () => void) { this.drain = listener; return this; }
}

class ControlledSession {
  runId = "run-1";
  nativeSessionId = "pi-session";
  readonly attachments: Record<string, unknown>[] = [];
  readonly resolutions: Record<string, unknown>[] = [];
  readonly turns: unknown[] = [];
  readonly announcements = new Set<string>();
  admission: (() => Promise<void>) | undefined;
  revalidationFailure: Error | undefined;
  revalidations = 0;
  reconnects = 0;
  park = { ready: true, reasons: [] as string[] };
  closeFailure: Error | undefined;
  #sequence = 0;
  #queue: PrpEvent[] = [];
  #reader: ((event: PrpEvent | null) => void) | undefined;
  #closed = false;

  ids() { return { driverSessionId: this.nativeSessionId, providerSessionId: this.nativeSessionId }; }
  async *events(): AsyncIterable<PrpEvent> {
    while (!this.#closed) {
      const event = this.#queue.shift() ?? await new Promise<PrpEvent | null>((resolve) => { this.#reader = resolve; });
      if (!event) return;
      yield event;
    }
  }
  emit(runId: string | undefined, turnId: string | undefined, eventType: string, payload: Record<string, unknown> = {}) {
    const event = {
      schema: "paperclip.prp.event.v3", schemaVersion: 3,
      sourceEventId: `event-${++this.#sequence}`, sourceSeq: this.#sequence,
      sourceInstanceId: "controlled-pi", sourceKind: "runner", priority: 1,
      normalizedSessionId: "session-1", emittedAt: new Date().toISOString(),
      runId, turnId, eventType, payload,
    } as PrpEvent;
    const reader = this.#reader;
    this.#reader = undefined;
    if (reader) reader(event);
    else this.#queue.push(event);
    return event;
  }
  announce(runId: string, turnId: string, callId: string | number) {
    this.announcements.add(JSON.stringify([runId, turnId, callId]));
    this.emit(runId, turnId, "tool.execution.started", {
      schema: "paperclip.tool.execution.v1", executionId: String(callId),
      transport: "dynamic", name: "read_context", status: "running",
    });
  }
  async attachRun(input: Record<string, unknown>) {
    this.attachments.push(input);
    await this.admission?.();
    this.runId = String(input.runId);
  }
  async startTurn(input: unknown) {
    this.turns.push(input);
    const turnId = `turn-${this.turns.length}`;
    this.emit(this.runId, turnId, "turn.started");
    return { turnId };
  }
  async resolveRuntimeRequest(input: Record<string, unknown>) { this.resolutions.push(input); }
  async revalidateAfterClaim() {
    this.revalidations += 1;
    if (this.revalidationFailure) throw this.revalidationFailure;
  }
  async reconnect() { this.reconnects += 1; }
  async parkReady() { return structuredClone(this.park); }
  async close() { this.#closed = true; this.#reader?.(null); this.#reader = undefined; if (this.closeFailure) throw this.closeFailure; }
}

const proxies: Array<ReturnType<typeof createPiRpcAppServerProxy>> = [];
afterEach(async () => { await Promise.all(proxies.splice(0).map((proxy) => proxy.close())); });

async function setup(options: { runId?: string; nativeSessionId?: string; normalizedSessionId?: string } = {}) {
  const sink = new FakeSink();
  const session = new ControlledSession();
  session.runId = options.runId ?? "run-1";
  session.nativeSessionId = options.nativeSessionId ?? "pi-session";
  const logs: string[] = [];
  let config!: PiRpcDriverLaunchConfig;
  const driver: HarnessDriver = {
    async descriptor() { throw new Error("not used"); },
    async openSession() { return session as unknown as HarnessSession; },
  };
  const proxy = createPiRpcAppServerProxy({
    stdout: sink, environment: {
      PAPERCLIP_RUN_ID: session.runId,
      PAPERCLIP_NORMALIZED_SESSION_ID: options.normalizedSessionId ?? "host-bootstrap-not-native",
    },
    writeStderr: (message) => logs.push(message),
    createDriver: (value) => { config = value; return driver; },
  });
  proxies.push(proxy);
  let id = 0;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const requestId = id++;
    proxy.acceptLine(JSON.stringify({ id: requestId, method, params }));
    await vi.waitFor(() => expect(sink.frames.some((frame) => frame.id === requestId)).toBe(true));
    return sink.frames.find((frame) => frame.id === requestId)!;
  };
  expect(await request("thread/start", { model: "test/model", baseInstructions: "run one" }))
    .toMatchObject({ id: 0, result: { thread: { id: session.nativeSessionId } } });
  const respond = (frame: Frame, result: unknown) => proxy.acceptLine(JSON.stringify({ id: frame.id, result }));
  const controllerFrames = (method: string) => sink.frames.filter((frame) => frame.method === method);
  const nextController = async (method: string, index = 0) => {
    await vi.waitFor(() => expect(controllerFrames(method).length).toBeGreaterThan(index));
    return controllerFrames(method)[index]!;
  };
  const invoke = (call: Record<string, unknown>) => config.dynamicToolHandler(call as unknown as ToolCall);
  return { proxy, sink, session, config, logs, request, respond, controllerFrames, nextController, invoke };
}

const call = (runId = "run-1", turnId = "turn-1", callId: string | number = "call-1") => ({
  runId, turnId, callId, tool: "read_context", arguments: {},
});
const origin = { adapter: "pi_rpc", provider: "pi", method: "extension_ui_request.input" };
const runtimeRequest = (turnId = "turn-1", requestId: string | number = "request-1") => ({
  requestId, turnId, requestKind: "user_input", method: "extension_ui_request", status: "pending",
  itemId: "ui-1", prompt: "Value?", details: {}, origin: { ...origin },
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Keep: a finish-only Pi answer must reach the same final channel as native
// text, without promoting rejected reports, duplicate text, or failed turns.
describe("Pi RPC finish answer presentation", () => {
  it.each([
    { accepted: true, nativeFinal: false, status: "turn.completed", expected: ["accepted answer"] },
    { accepted: true, nativeFinal: true, status: "turn.completed", expected: ["native answer"] },
    { accepted: false, nativeFinal: false, status: "turn.completed", expected: [] },
    { accepted: true, nativeFinal: false, status: "turn.failed", expected: [] },
    { accepted: true, nativeFinal: false, status: "turn.cancelled", expected: [] },
    { accepted: true, nativeFinal: false, status: "turn.interrupted", expected: [] },
  ])("publishes only the settled accepted answer: %j", async ({ accepted, nativeFinal, status, expected }) => {
    const h = await setup();
    await h.request("turn/start", { input: [{ type: "text", text: "Answer" }] });
    h.session.emit("run-1", "turn-1", "item.completed", { kind: "agentMessage", channel: "progress", text: "working" });
    const pending = h.invoke({ ...call(), tool: "paperclip_finish", arguments: { summary: "accepted answer" } });
    h.respond(await h.nextController("item/tool/call"), { success: accepted });
    await pending;
    if (nativeFinal) h.session.emit("run-1", "turn-1", "item.completed", { kind: "agentMessage", channel: "final", text: "native answer" });
    h.session.emit("run-1", "turn-1", status);
    await h.nextController(status.replace(".", "/"));
    const completed = h.controllerFrames("item/completed").map(f => f.params!);
    expect(completed.filter(p => p.channel === "final").map(p => p.text)).toEqual(expected);
    expect(completed.find(p => p.text === "working")?.channel).toBe("progress");
    // A duplicate terminal must not publish the accepted summary again.
    h.session.emit("run-1", "turn-1", status);
    await h.nextController(status.replace(".", "/"), 1);
    expect(h.controllerFrames("item/completed").filter(f => f.params?.channel === "final")).toHaveLength(expected.length);
  });
});

// Keep reason: native Responses composite IDs cross a bounded-ID trust boundary.
// This replaces the frozen draft's per-RPC/opencode allocator contract: durable
// replay requires SAME run/native session/original ID => SAME full-SHA256 alias,
// even for changed arguments. No turn, counter, random epoch, or registry belongs
// in this identity. Native receipts/history remain a separate real-provider proof.
describe("Pi RPC proxy stateless controller tool identity", () => {
  const prefix = "pi_tool_";
  // Unlike `$`, this absolute end assertion cannot accept a trailing newline.
  const boundedId = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}(?![\s\S])/;
  const alias = (nativeId: string, runId = "run-1", nativeSessionId = "pi-session") =>
    prefix + createHash("sha256")
      .update("paperclip.pi.tool-call-id\0")
      .update(JSON.stringify(["v1", runId, nativeSessionId, nativeId]))
      .digest("hex");
  const receipt = (text: string) => ({
    success: false, contentItems: [{ type: "inputText", text }, { type: "inputText", text: "" }],
    structuredContent: { zero: 0, falseValue: false, nested: [null, { intact: "π" }] },
  });

  it.each([
    "nativecaller/1", "call_x|fc_y", "call_x|fc_z", "call_x_fc_y|fc_z", "_leading", "with space",
    "unicode-π", "x".repeat(161), "valid-with-trailing-newline\n", "pi_tool_", "pi_tool_native",
  ])("uses the full stable digest for native %j, preserving the exact callback and full receipt", async (nativeId) => {
    const h = await setup();
    const input = { ...call("run-1", "turn-1", nativeId), arguments: { marker: nativeId } };
    const captured = structuredClone(input);
    // Model only the existing native owner's retained immutable await closure,
    // not actual native journal or SDK history acceptance.
    const pending = h.invoke(input).then(result => ({ toolCallId: nativeId, result }));
    const frame = await h.nextController("item/tool/call");
    const result = receipt(`semantic result for ${nativeId}`);
    // Settle on RED too, so cleanup cannot mask the boundary failure.
    h.respond(frame, result);
    await expect(pending).resolves.toEqual({ toolCallId: nativeId, result });
    expect(frame.params).toMatchObject({ threadId: "pi-session", turnId: "turn-1", tool: "read_context", arguments: captured.arguments });
    expect(frame.params?.callId).toMatch(boundedId);
    expect(frame.params?.callId).toBe("pi_tool_" + createHash("sha256").update("paperclip.pi.tool-call-id\0")
      .update(JSON.stringify(["v1", h.session.runId, h.session.nativeSessionId, input.callId])).digest("hex"));
    expect(String(frame.params?.callId)).toMatch(/^pi_tool_[a-f0-9]{64}$/);
    expect(frame.params?.callId).not.toBe(nativeId);
    expect(input).toEqual(captured);
  });

  it.each(["toolu_01MessagesControl_aB9", "A_-.:", "Z".repeat(160), "opencode-1"])("passes bounded IDs outside the reserved namespace unchanged: %j", async (nativeId) => {
    const h = await setup();
    const pending = h.invoke(call("run-1", "turn-1", nativeId));
    const frame = await h.nextController("item/tool/call");
    const result = receipt("MESSAGES_CONTROL_OK");
    h.respond(frame, result);
    await expect(pending).resolves.toEqual(result);
    expect(frame.params?.callId).toBe(nativeId);
  });

  it("is restart-stable for the same actual native session despite different RPC counters, turns and host bootstrap IDs", async () => {
    const nativeId = "nativecaller/1";
    const first = await setup({ normalizedSessionId: "host-first" });
    const pending = first.invoke(call("run-1", "turn-before-restart", nativeId));
    const frame = await first.nextController("item/tool/call");
    first.respond(frame, receipt("first"));
    await pending;
    await first.proxy.close();
    const reopened = await setup({ normalizedSessionId: "host-reopened" });
    for (let index = 0; index < 3; index++) {
      const burn = reopened.invoke(call("run-1", "unrelated-turn", `toolu_counter_${index}`));
      reopened.respond(await reopened.nextController("item/tool/call", index), receipt(`burn-${index}`));
      await burn;
    }
    const replay = reopened.invoke(call("run-1", "turn-after-restart", nativeId));
    const replayFrame = await reopened.nextController("item/tool/call", 3);
    reopened.respond(replayFrame, receipt("replay"));
    await replay;
    expect(replayFrame.id).not.toBe(frame.id);
    expect(frame.params?.callId).toBe(alias(nativeId));
    expect(replayFrame.params?.callId).toBe(frame.params?.callId);
  });

  it.each([
    { runId: "run-2", nativeSessionId: "pi-session", nativeId: "nativecaller/1" },
    { runId: "run-1", nativeSessionId: "other-native-session", nativeId: "nativecaller/1" },
    { runId: "run-1", nativeSessionId: "pi-session", nativeId: "nativecaller/2" },
  ])("separates the stable tuple dimension $runId/$nativeSessionId/$nativeId", async (keys) => {
    const h = await setup(keys);
    const pending = h.invoke(call(keys.runId, "turn-1", keys.nativeId));
    const frame = await h.nextController("item/tool/call");
    h.respond(frame, receipt("independent origin"));
    await pending;
    expect(frame.params?.callId).toBe(alias(keys.nativeId, keys.runId, keys.nativeSessionId));
    expect(frame.params?.callId).not.toBe(alias("nativecaller/1"));
  });

  it("JSON-frames the tuple instead of ambiguously concatenating run and native session", async () => {
    const frames: Frame[] = [];
    for (const keys of [{ runId: "run-ab", nativeSessionId: "c" }, { runId: "run-a", nativeSessionId: "bc" }]) {
      const h = await setup(keys);
      const pending = h.invoke(call(keys.runId, "turn-1", "call_x|fc_y"));
      const frame = await h.nextController("item/tool/call");
      h.respond(frame, receipt("framed"));
      await pending;
      expect(frame.params?.callId).toBe(alias("call_x|fc_y", keys.runId, keys.nativeSessionId));
      frames.push(frame);
    }
    expect(frames[0]?.params?.callId).not.toBe(frames[1]?.params?.callId);
  });

  it("keeps the same original ID with changed arguments stable for the unchanged durable replay/conflict gate", async () => {
    const h = await setup();
    const nativeId = "call_replay|fc_replay";
    const frames: Frame[] = [];
    for (const input of [{ path: "first" }, { path: "changed" }]) {
      const pending = h.invoke({ ...call("run-1", "turn-1", nativeId), arguments: input });
      const frame = await h.nextController("item/tool/call", frames.length);
      h.respond(frame, receipt("controller-owned replay decision"));
      await pending;
      expect(frame.params?.arguments).toEqual(input);
      frames.push(frame);
    }
    // Unit scope proves identity preservation, NOT the real Rust conflict verdict.
    expect(frames[0]?.id).not.toBe(frames[1]?.id);
    expect(frames[0]?.params?.callId).toBe(alias(nativeId));
    expect(frames[1]?.params?.callId).toBe(frames[0]?.params?.callId);
  });

  it.each(["unsafe-first", "alias-native-first"])("escapes a valid native ID equal to a generated alias in either arrival order: %s", async (order) => {
    const h = await setup();
    const original = "call_x|fc_y";
    const generated = alias(original);
    const nativeIds = order === "unsafe-first" ? [original, generated] : [generated, original];
    const inputs = nativeIds.map((id, index) => ({ ...call("run-1", "turn-1", id), arguments: { index } }));
    const pending = inputs.map(input => {
      const originalId = input.callId;
      return h.invoke(input).then(result => ({ toolCallId: originalId, result }));
    });
    const frames = await Promise.all(inputs.map((_, index) => h.nextController("item/tool/call", index)));
    const results = nativeIds.map((id) => receipt(`exact native result ${id}`));
    h.respond(frames[1]!, results[1]);
    h.respond(frames[0]!, results[0]);
    await expect(Promise.all(pending)).resolves.toEqual(nativeIds.map((toolCallId, index) => ({ toolCallId, result: results[index] })));
    expect(frames.map(frame => frame.params?.callId)).toEqual(nativeIds.map(id => alias(id)));
    expect(new Set(frames.map(frame => frame.params?.callId)).size).toBe(2);
    expect(inputs.map(input => input.callId)).toEqual(nativeIds);
  });

  it("does not reuse a completed generated alias when a later native ID has that exact valid spelling", async () => {
    const h = await setup();
    const original = "call_completed|fc_completed";
    const first = h.invoke(call("run-1", "turn-1", original));
    const firstFrame = await h.nextController("item/tool/call");
    const firstResult = receipt("completed result, never the next native result");
    h.respond(firstFrame, firstResult);
    await expect(first).resolves.toEqual(firstResult);
    // Exact expected generated spelling, even on RED where the old proxy leaks
    // the composite. A native ID in this namespace must itself be hashed.
    const nextNativeId = alias(original);
    const secondInput = call("run-1", "turn-2", nextNativeId);
    const second = h.invoke(secondInput);
    const secondFrame = await h.nextController("item/tool/call", 1);
    const secondResult = receipt("second independent semantic result");
    h.respond(secondFrame, secondResult);
    await expect(second).resolves.toEqual(secondResult);
    expect(firstFrame.params?.callId).toBe(nextNativeId);
    expect(secondFrame.params?.callId).toBe(alias(nextNativeId));
    expect(secondFrame.params?.callId).not.toBe(firstFrame.params?.callId);
    expect(secondInput.callId).toBe(nextNativeId);
  });

  it("keeps distinct composites and lossy-normalization spellings independently correlated", async () => {
    const h = await setup();
    const nativeIds = ["call_x|fc_y", "call_x_fc_y", "call_x|fc_z"];
    const pending = nativeIds.map(id => h.invoke(call("run-1", "turn-1", id)));
    const frames = await Promise.all(nativeIds.map((_, index) => h.nextController("item/tool/call", index)));
    const results = nativeIds.map(id => receipt(id));
    for (const index of [2, 0, 1]) h.respond(frames[index]!, results[index]);
    await expect(Promise.all(pending)).resolves.toEqual(results);
    expect(frames.map(frame => frame.params?.callId)).toEqual([alias(nativeIds[0]!), nativeIds[1], alias(nativeIds[2]!)]);
    expect(new Set(frames.map(frame => frame.params?.callId)).size).toBe(3);
  });

  it.each(["", undefined, 0])("refuses an unsafe ID when the admitted native session identity is unavailable: %j", async (missing) => {
    const h = await setup();
    h.session.nativeSessionId = missing as unknown as string;
    const outcome = h.invoke(call("run-1", "turn-1", "call_x|fc_y"))
      .then(value => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
    // Settle an erroneous baseline dispatch without waiting for a timeout.
    const frames = h.controllerFrames("item/tool/call");
    if (frames[0]) h.respond(frames[0], receipt("must not dispatch"));
    expect((await outcome).error?.message).toMatch(/native|session|identity|admi/i);
    expect(frames).toEqual([]);
  });

  it("refuses an unsafe pre-admission callback rather than inventing a session identity", async () => {
    const sink = new FakeSink();
    const session = new ControlledSession();
    let refused: Error | undefined;
    const proxy = createPiRpcAppServerProxy({
      stdout: sink, environment: { PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_NORMALIZED_SESSION_ID: "not-native" },
      createDriver: config => ({
        async descriptor() { throw new Error("not used"); },
        async openSession() {
          try { await config.dynamicToolHandler(call("run-1", "turn-1", "call_early|fc_early")); }
          catch (error) { refused = error as Error; }
          return session as unknown as HarnessSession;
        },
      }),
    });
    proxies.push(proxy);
    proxy.acceptLine(JSON.stringify({ id: 0, method: "thread/start", params: { model: "test/model" } }));
    await vi.waitFor(() => expect(sink.frames.some(frame => frame.id === 0)).toBe(true));
    expect(refused?.message).toMatch(/authority|captured|stale|identity/i);
    expect(sink.frames.filter(frame => frame.method === "item/tool/call")).toEqual([]);
  });

  it("retains cancellation for a normalized tool request queued behind stdout backpressure", async () => {
    const h = await setup();
    h.sink.backpressured = true;
    await h.request("thread/read");
    const controller = new AbortController();
    const outcome = h.invoke({ ...call("run-1", "turn-1", "nativecaller/1"), signal: controller.signal })
      .then(() => undefined, (error: Error) => error);
    expect(h.proxy.queuedOutputFrames).toBe(1);
    expect(h.controllerFrames("item/tool/call")).toEqual([]);
    controller.abort();
    expect((await outcome)?.message).toMatch(/abandoned.*did not run/i);
    expect(h.proxy.queuedOutputFrames).toBe(0);
    h.sink.backpressured = false;
    h.sink.drain?.();
    expect(h.controllerFrames("item/tool/call")).toEqual([]);
  });

  it("uses captured old/current runs and admitted session IDs even when the native composite is identical", async () => {
    const h = await setup();
    await h.request("turn/start", { input: [] });
    const nativeId = "nativecaller/1";
    const input = call("run-1", "turn-1", nativeId);
    const old = h.invoke(input).then(value => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
    const oldFrame = await h.nextController("item/tool/call");
    await h.request("turn/start", { paperclipRunId: "run-2", input: [] });
    input.runId = "run-2"; input.turnId = "turn-2";
    const current = h.invoke(call("run-2", "turn-2", nativeId));
    const currentFrame = await h.nextController("item/tool/call", 1);
    h.respond(currentFrame, receipt("current only"));
    await expect(current).resolves.toEqual(receipt("current only"));
    h.respond(oldFrame, receipt("stale"));
    const oldResult = await old;
    expect(oldResult.error?.message).toMatch(/authority|stale|identity/i);
    expect(oldResult.value).toBeUndefined();
    expect(oldFrame.params).toMatchObject({ turnId: "turn-1", callId: alias(nativeId, "run-1") });
    expect(currentFrame.params).toMatchObject({ turnId: "turn-2", callId: alias(nativeId, "run-2") });
  });

  it.each([
    { ...call("run-1", "turn-1", "nativecaller/1"), runId: undefined },
    { ...call("run-1", "turn-1", "nativecaller/1"), turnId: undefined },
    call("old-run", "old-turn", "nativecaller/1"),
  ])("does not guess current origin to normalize an unbound/stale native call: %j", async (input) => {
    const h = await setup();
    await h.request("turn/start", { input: [] });
    await expect(h.invoke(input)).rejects.toThrow(/authority|captured|stale|identity/i);
    expect(h.controllerFrames("item/tool/call")).toEqual([]);
  });
});

describe("Pi RPC proxy captured run authority", () => {
  it("refreshes from session.revalidate baseInstructions before post-claim admission", async () => {
    const h = await setup();
    await h.request("run.attach", { runId: "run-2" });
    expect(await h.request("session.revalidate", { baseInstructions: "SECOND" })).toMatchObject({ result: true });
    expect(h.session.attachments.at(-1)).toEqual({ runId: "run-2", baseInstructions: "SECOND" });
    expect(h.session.revalidations).toBe(1);
    expect(await h.request("session.revalidate", { baseInstructions: 42 })).toHaveProperty("error");
    expect(h.session.revalidations).toBe(1);
  });
  it("routes the actual host park method with an empty parameter object and private blockers", async () => {
    const h = await setup();
    expect(await h.request("paperclip/host_park_ready")).toMatchObject({ result: { ready: true, reasons: [] } });
    h.session.park = { ready: false, reasons: ["pending child"] };
    expect(await h.request("paperclip/host_park_ready")).toMatchObject({ result: { ready: false, reasons: ["pending child"] } });
    expect(await h.request("paperclip/host_park_ready", { runId: "wrong" })).toHaveProperty("error");
  });
  it("retains controller success/contentItems envelope for safe driver normalization", async () => {
    const h = await setup(); const pending = h.invoke(call());
    const frame = await h.nextController("item/tool/call");
    const result = { contentItems: [{ type: "inputText", text: "" }], success: false };
    h.respond(frame, result); await expect(pending).resolves.toEqual(result);
  });
  it("does not turn uncertain physical close into proxy success", async () => {
    const h = await setup(); h.session.closeFailure = new Error("child cleanup uncertain");
    await expect(h.proxy.close()).rejects.toThrow("uncertain");
  });
  it.each([
    { ...call(), runId: "wrong-run" },
    { turnId: "turn-1", callId: "missing-run", tool: "read_context", arguments: {} },
    { ...call(), runId: "" },
    { ...call(), turnId: undefined },
  ])("refuses wrong/missing captured callback identity before dispatch: %j", async (input) => {
    const h = await setup();
    const outcome = h.invoke(input).then(() => undefined, (error: Error) => error);
    expect(h.controllerFrames("item/tool/call")).toEqual([]);
    expect((await outcome)?.message).toMatch(/authority|captured|stale|identity/i);
  });

  it("rejects an old awaited callback during run two, but permits an announced current call with zero ID and empty input", async () => {
    const h = await setup();
    await h.request("turn/start", { input: [] });
    h.session.announce("run-1", "turn-1", "old-call");
    const mutableCall = call("run-1", "turn-1", "old-call");
    const oldOutcome = h.invoke(mutableCall).then(
      (value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }),
    );
    const oldRequest = await h.nextController("item/tool/call");
    expect(await h.request("turn/start", { paperclipRunId: "run-2", input: [] }))
      .toHaveProperty("result");
    // A caller mutating its object cannot rewrite the identity captured before await.
    mutableCall.runId = "run-2";
    mutableCall.turnId = "turn-2";
    h.respond(oldRequest, { contentItems: [{ text: "old result" }] });
    expect((await oldOutcome).error?.message).toMatch(/authority|stale|identity/i);
    expect((await oldOutcome).value).toBeUndefined();

    h.session.announce("run-2", "turn-2", 0);
    await vi.waitFor(() => expect(h.sink.frames.some((frame) =>
      frame.method === "item/started" && frame.params?.turnId === "turn-2" && frame.params?.itemId === "0",
    )).toBe(true));
    const currentOutcome = h.invoke({ ...call("run-2", "turn-2", 0), arguments: "" });
    const currentRequest = await h.nextController("item/tool/call", 1);
    expect(currentRequest.params).toMatchObject({ turnId: "turn-2", callId: 0, arguments: "" });
    expect(h.session.announcements.has(JSON.stringify(["run-2", "turn-2", 0]))).toBe(true);
    h.respond(currentRequest, { contentItems: [{ text: "" }] });
    await expect(currentOutcome).resolves.toEqual({ contentItems: [{ text: "" }] });
    expect(h.session.turns).toEqual([
      { message: { role: "user", text: "" } }, { message: { role: "user", text: "" } },
    ]);
  });

  it.each(["call-1", "nativecaller/1"])("does not let in-flight callback %j return after its session closes", async (nativeId) => {
    const h = await setup();
    const outcome = h.invoke(call("run-1", "turn-1", nativeId)).then(() => undefined, (error: Error) => error);
    const frame = await h.nextController("item/tool/call");
    await h.request("thread/close");
    h.respond(frame, { text: "late" });
    expect((await outcome)?.message).toMatch(/authority|stale|closed|identity/i);
  });

  it("forwards captured runtime-request run and origin, preserving numeric zero and an explicitly empty answer", async () => {
    const h = await setup();
    const request = runtimeRequest("turn-1", 0);
    h.session.emit("run-1", "turn-1", "runtime_request.created", { request });
    const frame = await h.nextController("paperclip/runtimeRequest");
    request.origin.method = "mutated-after-dispatch";
    h.respond(frame, { resolution: { action: "submit", content: { value: "" } } });
    await vi.waitFor(() => expect(h.session.resolutions).toHaveLength(1));
    expect(h.session.resolutions[0]).toEqual({
      requestId: "0", runId: "run-1", turnId: "turn-1", origin,
      resolution: { action: "submit", content: { value: "" } },
    });
  });

  it("refuses a runtime answer captured in run one after run two attaches", async () => {
    const h = await setup();
    const event = h.session.emit("run-1", "turn-1", "runtime_request.created", { request: runtimeRequest() });
    const frame = await h.nextController("paperclip/runtimeRequest");
    await h.request("turn/start", { paperclipRunId: "run-2", input: [] });
    event.runId = "run-2";
    event.turnId = "turn-2";
    h.respond(frame, { resolution: { action: "accept" } });
    await vi.waitFor(() => expect(h.logs.some((line) => /authority|stale|identity/i.test(line))).toBe(true));
    expect(h.session.resolutions).toEqual([]);
  });

  it.each([
    { runId: "wrong-run", turnId: "turn-1", request: runtimeRequest() },
    { runId: undefined, turnId: "turn-1", request: runtimeRequest() },
    { runId: "run-1", turnId: undefined, request: { ...runtimeRequest(), turnId: undefined } },
    { runId: "run-1", turnId: "turn-1", request: runtimeRequest("other-turn") },
  ])("does not inherit current authority for stale or unbound runtime requests: %j", async (input) => {
    const h = await setup();
    await h.request("turn/start", { input: [] });
    h.session.emit(input.runId, input.turnId, "runtime_request.created", { request: input.request });
    await vi.waitFor(() => expect(h.logs.some((line) => /authority|captured|stale|identity/i.test(line))).toBe(true));
    expect(h.controllerFrames("paperclip/runtimeRequest")).toEqual([]);
    expect(h.session.resolutions).toEqual([]);
  });

  it.each(["run.attach", "turn/start"])("%s forwards refreshed attachment inputs, including explicit empty instructions/tools", async (method) => {
    const h = await setup();
    const frame = await h.request(method, {
      ...(method === "run.attach" ? { runId: "run-2" } : { paperclipRunId: "run-2" }),
      baseInstructions: "", dynamicTools: [], runtimeContext: null, input: [],
    });
    expect(frame).toHaveProperty("result");
    expect(h.session.attachments).toEqual([{
      runId: "run-2", baseInstructions: "", dynamicTools: [], runtimeContext: null,
    }]);
  });

  it("refreshes an explicitly attached current run rather than skipping admission", async () => {
    const h = await setup();
    expect(await h.request("turn/start", {
      paperclipRunId: "run-1", baseInstructions: "refreshed", dynamicTools: [], input: [],
    })).toHaveProperty("result");
    expect(h.session.attachments).toEqual([{
      runId: "run-1", baseInstructions: "refreshed", dynamicTools: [],
    }]);
  });

  it("does not publish new run authority until native run.attach admission succeeds", async () => {
    const h = await setup();
    const admission = deferred();
    h.session.admission = () => admission.promise;
    const attachment = h.request("run.attach", { runId: "run-2" });
    await vi.waitFor(() => expect(h.session.attachments).toHaveLength(1));
    await expect(h.invoke(call("run-2"))).rejects.toThrow(/authority|stale|identity/i);
    admission.reject(new Error("admission denied"));
    expect(await attachment).toMatchObject({ error: { message: "admission denied" } });
    await expect(h.invoke(call("run-2"))).rejects.toThrow(/authority|stale|identity/i);
    const oldCall = h.invoke(call());
    h.respond(await h.nextController("item/tool/call"), { text: "still run one" });
    await expect(oldCall).resolves.toEqual({ text: "still run one" });
  });

  it("exposes post-claim revalidation and reconnect, and surfaces admission failures", async () => {
    const h = await setup();
    expect(await h.request("session.revalidate")).toMatchObject({ result: true });
    expect(h.session.revalidations).toBe(1);
    h.session.revalidationFailure = new Error("post-claim model mismatch");
    expect(await h.request("session.revalidate"))
      .toMatchObject({ error: { message: "post-claim model mismatch" } });
    expect(await h.request("session.reconnect")).toMatchObject({ result: true });
    expect(h.session.reconnects).toBe(1);
  });
});
