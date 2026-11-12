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
  write(chunk: string) { this.frames.push(JSON.parse(chunk) as Frame); return true; }
  once() { return this; }
}

class ControlledSession {
  runId = "run-1";
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

  ids() { return { driverSessionId: "pi-session", providerSessionId: "pi-session" }; }
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

async function setup() {
  const sink = new FakeSink();
  const session = new ControlledSession();
  const logs: string[] = [];
  let config!: PiRpcDriverLaunchConfig;
  const driver: HarnessDriver = {
    async descriptor() { throw new Error("not used"); },
    async openSession() { return session as unknown as HarnessSession; },
  };
  const proxy = createPiRpcAppServerProxy({
    stdout: sink, environment: { PAPERCLIP_RUN_ID: "run-1" },
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
    .toMatchObject({ id: 0, result: { thread: { id: "pi-session" } } });
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

  it("does not let an in-flight callback return after its session closes", async () => {
    const h = await setup();
    const outcome = h.invoke(call()).then(() => undefined, (error: Error) => error);
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
