import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindContent, validateBindRequest, validateBindingConfig, type BindRequest, type PiBindCommand, type PiBindingConfig } from "./pi-bind-protocol.js";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcCommandError, PiRpcRequestTimeoutError, type PiRpcRecord, type PiRpcTransport } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: prepared-epoch reuse crosses native identity, prompt acceptance,
// private receipt, and revocable capability trust boundaries. Only the native
// port is fake: use the public driver/session API and the real private IPC client.
// Deliberately independent of resident-binding.test.ts (no test-file exports).
const sessions: PiRpcHarnessSession[] = [];
const peers: Server[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(peers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  // Preserve temporary roots for first-failure inspection, as the resident fixture does.
});
const fullAdmission = ["get_state", "set_model", "get_available_thinking_levels", "set_thinking_level", "get_state"];
const configuration = ["set_model", "get_available_thinking_levels", "set_thinking_level"];
const context = { baseInstructions: "warm instructions", dynamicTools: [{ name: "read_current", description: "Read current", inputSchema: { type: "object" } }], runtimeContext: { revision: 2 } };
type Initial = PiBindingConfig & { schema: 1; sessionId: string; turnId: string };
type Capability = { baseUrl: string; apiKey: string };
type Fault = "rejected-bind" | "stale-bind" | "lost-bind" | "lost-begin";

class NativePort {
  pid = 42;
  exited = false;
  closed = false;
  ready: Promise<void> = Promise.resolve();
  sessionId = "native-warm-session";
  model = { provider: "paperclip", id: "faux" };
  // Requested max legitimately lowers to xhigh. Warm checks must preserve the
  // admitted EFFECTIVE effort, not compare the native state to requested max.
  thinkingLevel = "xhigh";
  state: PiRpcRecord = { isStreaming: false, isCompacting: false, pendingMessageCount: 0 };
  prompt: "started" | "rejected" | "unknown" = "started";
  failState = false;
  rejectModelAck = false;
  calls: Array<{ type: string; params: PiRpcRecord; epoch: number; runId: string }> = [];
  order: string[] = [];
  epoch = 1;
  runId = "run-a";
  #records: PiRpcRecord[] = [];
  #wake?: (value: IteratorResult<PiRpcRecord>) => void;
  async request(type: string, params: PiRpcRecord = {}): Promise<PiRpcRecord> {
    await this.ready;
    if (this.closed) throw new Error("fake native port closed");
    if (this.calls.length >= 160) throw new Error("bounded native request budget exceeded");
    this.calls.push({ type, params: structuredClone(params), epoch: this.epoch, runId: this.runId });
    this.order.push(type);
    if (type === "get_state") {
      if (this.failState) throw new Error("native state unavailable");
      return { success: true, data: { ...this.state, sessionId: this.sessionId, model: { ...this.model }, thinkingLevel: this.thinkingLevel } };
    }
    if (type === "set_model") {
      this.model = { provider: String(params.provider), id: String(params.modelId) };
      return { success: true, data: this.rejectModelAck ? { provider: "paperclip", id: "not-acknowledged" } : { ...this.model } };
    }
    if (type === "get_available_thinking_levels") return { success: true, data: { levels: ["off", "high", "xhigh"] } };
    if (type === "set_thinking_level") {
      this.thinkingLevel = params.level === "max" ? "xhigh" : String(params.level);
      return { success: true };
    }
    if (type === "get_available_models") return { success: true, data: { models: [{ ...this.model, name: "Fixture", api: "openai-completions" }] } };
    if (type === "prompt") {
      if (this.prompt === "rejected") throw new PiRpcCommandError(type, { success: false, error: "rejected before acceptance" });
      if (this.prompt === "unknown") throw new PiRpcRequestTimeoutError(type, 20);
      return { success: true, data: { disposition: "started" } };
    }
    throw new Error(`Unexpected native request: ${type}`);
  }
  send(record: PiRpcRecord) {
    if (this.#wake) { const wake = this.#wake; this.#wake = undefined; wake({ value: record, done: false }); }
    else this.#records.push(record);
  }
  events(): AsyncIterable<PiRpcRecord> {
    return { [Symbol.asyncIterator]: () => ({ next: async () => {
      const value = this.#records.shift();
      if (value) return { value, done: false };
      if (this.closed) return { value: undefined, done: true };
      return new Promise<IteratorResult<PiRpcRecord>>(resolve => { this.#wake = resolve; });
    } }) };
  }
  async close() { this.closed = this.exited = true; this.#wake?.({ value: undefined, done: true }); this.#wake = undefined; }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-warm-admission-"));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const native = new NativePort();
  const ipc: PiBindCommand[] = [];
  let fault: Fault | undefined;
  let initial!: Initial;
  let initialProvider!: Capability;
  const driver = new PiRpcDriver({ model: "paperclip/faux", piRpcThinkingLevel: "max", runtimeDirectory: join(root, "sessions"),
    systemInstructions: "initial instructions", runtimeContext: { revision: 1 }, startupTimeoutMs: 120, promptTimeoutMs: 20,
    environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1",
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "warm-fixture-unused-upstream" },
    transportFactory: options => {
      native.ready = (async () => {
        initial = JSON.parse(await readFile(options.env!.PAPERCLIP_PI_BIND_INITIAL_FILE!, "utf8"));
        expect(validateBindingConfig(initial)).toBe(true);
        initialProvider = JSON.parse(await readFile(join(options.env!.PI_CODING_AGENT_DIR!, "models.json"), "utf8")).providers.paperclip;
        const server = createServer(socket => {
          sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => undefined);
          let buffer = ""; socket.setEncoding("utf8"); socket.on("data", chunk => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
            if (!buffer.endsWith("\n")) return;
            const request = JSON.parse(buffer) as PiBindCommand;
            if (request.type !== "tool_inventory") { ipc.push(request); native.order.push(`ipc:${request.type}`); }
            if (request.type === "bind") {
              expect(validateBindRequest(request)).toBe(true);
              expect(request.sessionId).toBe(initial.sessionId);
              expect(request.expectedPriorEpoch).toBe(native.epoch);
              expect(request.epoch).toBe(native.epoch + 1);
              if (fault === "rejected-bind") { socket.end(`${JSON.stringify({ success: false, error: "bind rejected" })}\n`); return; }
              // Native application precedes the receipt; losing it is uncertain,
              // never permission to retry or spend this capability.
              native.epoch = request.epoch; native.runId = request.runId;
              native.model = { provider: "paperclip", id: "faux" }; native.thinkingLevel = "xhigh";
              if (fault === "lost-bind") return;
              socket.end(`${JSON.stringify({ schema: 1, type: "bind", nonce: request.nonce, sessionId: request.sessionId,
                epoch: fault === "stale-bind" ? request.epoch - 1 : request.epoch, runId: request.runId,
                provider: request.provider.name, model: request.model, thinkingLevel: request.thinkingLevel, ...bindContent(request) })}\n`);
            } else if (request.type === "tool_inventory") {
              socket.end(`${JSON.stringify({ ...request, nativeTools: [] })}\n`);
            } else if (request.type === "stop_children") {
              socket.end(`${JSON.stringify({ ...request, settled: [], uncertain: [] })}\n`);
            } else if (request.type === "park_ready") {
              socket.end(`${JSON.stringify({ ...request, ready: true, reasons: [] })}\n`);
            } else {
              if (request.type === "begin_turn" && fault === "lost-begin") return;
              socket.end(`${JSON.stringify({ ...request, ack: true })}\n`);
            }
          });
        });
        peers.push(server);
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.env!.PAPERCLIP_PI_BIND_SOCKET!, resolve); });
      })();
      return native as unknown as PiRpcTransport;
    },
  });
  const session = await driver.openSession({ runId: "run-a", normalizedSessionId: "host-warm", workingDirectory: workspace }) as PiRpcHarnessSession;
  sessions.push(session);
  const events: PrpEvent[] = [];
  void (async () => { for await (const event of session.events()) events.push(event); })();
  return { session, native, ipc, events, initial, initialProvider, setFault(value: Fault) { fault = value; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const types = (f: Fixture, from = 0) => f.native.calls.slice(from).map(call => call.type);
const writes = (f: Fixture, from = 0) => types(f, from).filter(type => configuration.includes(type));
const binds = (f: Fixture) => f.ipc.filter((command): command is BindRequest => command.type === "bind");
const prompts = (f: Fixture) => f.native.calls.filter(call => call.type === "prompt");
async function reachable(provider: Capability): Promise<boolean> {
  const address = new URL(provider.baseUrl);
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host: address.hostname, port: Number(address.port) });
    socket.setTimeout(500, () => { socket.destroy(); reject(new Error("capability probe timed out (not revocation proof)")); });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", error => { if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve(false); else reject(error); });
  });
}
async function finish(f: Fixture, turnId: string, runId: string) {
  f.native.send({ type: "agent_start" });
  const message = { role: "assistant", responseId: turnId, timestamp: Date.now(), provider: "paperclip", model: "faux", content: [{ type: "text", text: "answer" }], stopReason: "stop" };
  f.native.send({ type: "message_start", message }); f.native.send({ type: "message_end", message }); f.native.send({ type: "agent_settled", aborted: false });
  await vi.waitFor(() => expect(f.events.some(event => event.eventType === "turn.completed" && event.turnId === turnId && event.runId === runId)).toBe(true));
  expect((await f.session.snapshot()).binding?.preparedTurnId).toBeNull();
}
async function coldTerminal(f: Fixture) {
  const first = await f.session.startTurn({ message: { role: "user", text: "first" } });
  expect(first.turnId).toBe(f.initial.turnId);
  await finish(f, first.turnId, "run-a");
  expect(await reachable(f.initialProvider)).toBe(false);
}
async function prepared(f: Fixture) {
  await coldTerminal(f);
  await f.session.attachRun({ runId: "run-b", ...context });
  expect(binds(f)).toHaveLength(1);
  expect((await f.session.snapshot()).binding).toMatchObject({ epoch: 2, preparedTurnId: expect.any(String) });
  expect(await reachable(binds(f)[0]!.provider)).toBe(true);
}
async function refuseAndRevoke(f: Fixture, operation: () => Promise<unknown>) {
  const before = prompts(f).length;
  const provider = binds(f).at(-1)?.provider ?? f.initialProvider;
  await expect(operation()).rejects.toThrow();
  expect(prompts(f)).toHaveLength(before);
  expect(f.session.ids().providerSessionId).toBe("native-warm-session");
  expect(f.native.closed).toBe(true);
  expect((await f.session.snapshot()).binding?.preparedTurnId).toBeNull();
  expect(await reachable(provider)).toBe(false);
  await expect(f.session.startTurn({ message: { role: "user", text: "forbidden retry" } })).rejects.toThrow();
  expect(prompts(f)).toHaveLength(before);
}

// Same-context attach here intentionally mirrors proxy session.revalidate's
// attach-before-revalidate and turn/start's attach-before-start, without changing
// the proxy/PRP contract or reaching inside session-private state.
describe("Pi prepared-epoch native admission reuse", () => {
  it("fully admits cold INITIAL once, then proves same-epoch state without rewriting configuration", async () => {
    const f = await fixture();
    expect(types(f)).toEqual(["get_state", ...fullAdmission, "get_available_models"]);
    expect(await reachable(f.initialProvider)).toBe(true);
    await f.session.attachRun({ runId: "run-a" });
    const claim = f.native.calls.length;
    await f.session.attachRun({ runId: "run-a" }); await f.session.revalidateAfterClaim();
    expect(types(f, claim)).toContain("get_state");
    await f.session.attachRun({ runId: "run-a" });
    const prePrompt = f.native.calls.length;
    const turn = await f.session.startTurn({ message: { role: "user", text: "initial" } });
    expect(types(f, prePrompt)).toContain("get_state");
    expect(turn.turnId).toBe(f.initial.turnId);
    expect(prompts(f)).toMatchObject([{ epoch: 1, runId: "run-a" }]);
    expect(f.ipc).toEqual([]);
    expect((await f.session.snapshot()).binding).toMatchObject({ epoch: 1, preparedTurnId: turn.turnId });
    expect((await f.session.snapshot()).piRpcThinkingLevel).toBe("xhigh");
    await finish(f, turn.turnId, "run-a");
    expect(await reachable(f.initialProvider)).toBe(false);
    expect(writes(f)).toEqual(configuration);
  });

  it("cross-run attach -> proxy post-claim -> prepared attach -> prompt spends one full batch for the new epoch", async () => {
    const f = await fixture(); await coldTerminal(f);
    const from = f.native.calls.length;
    await f.session.attachRun({ runId: "run-b", ...context });
    const provider = binds(f)[0]!.provider;
    const preparedId = (await f.session.snapshot()).binding!.preparedTurnId;
    expect(binds(f)[0]).toMatchObject({ sessionId: "host-warm", expectedPriorEpoch: 1, epoch: 2, runId: "run-b", tools: context.dynamicTools });
    expect(binds(f)[0]!.instructions).toContain("warm instructions");
    expect(await reachable(provider)).toBe(true);
    const claim = f.native.calls.length;
    await f.session.attachRun({ runId: "run-b", ...context }); await f.session.revalidateAfterClaim();
    expect(types(f, claim)).toContain("get_state");
    await f.session.attachRun({ runId: "run-b", ...context });
    const prePrompt = f.native.calls.length;
    const turn = await f.session.startTurn({ message: { role: "user", text: "warm" } });
    expect(types(f, prePrompt)).toContain("get_state");
    expect(turn.turnId).toBe(preparedId);
    expect(f.session.ids().providerSessionId).toBe("native-warm-session"); expect(f.session.processPid()).toBe(42);
    expect(prompts(f)).toMatchObject([{ epoch: 1, runId: "run-a" }, { epoch: 2, runId: "run-b" }]);
    expect(f.ipc.filter(command => command.type === "begin_turn")).toMatchObject([{ epoch: 2, runId: "run-b", turnId: turn.turnId }]);
    expect(binds(f)).toHaveLength(1);
    await finish(f, turn.turnId, "run-b");
    expect(await reachable(provider)).toBe(false);
    expect(writes(f, from)).toEqual(configuration);
  });

  it("terminal revocation requires another full admission and replacement capability even on the same run", async () => {
    const f = await fixture(); await coldTerminal(f);
    const from = f.native.calls.length;
    const turn = await f.session.startTurn({ message: { role: "user", text: "same run next epoch" } });
    expect(binds(f)).toMatchObject([{ expectedPriorEpoch: 1, epoch: 2, runId: "run-a" }]);
    expect(turn.turnId).not.toBe(f.initial.turnId);
    expect(binds(f)[0]!.provider.apiKey).not.toBe(f.initialProvider.apiKey);
    expect(await reachable(binds(f)[0]!.provider)).toBe(true);
    expect(prompts(f).at(-1)).toMatchObject({ epoch: 2, runId: "run-a" });
    expect(types(f, from)).toEqual([...fullAdmission, "prompt"]);
    await finish(f, turn.turnId, "run-a");
    expect(await reachable(binds(f)[0]!.provider)).toBe(false);
  });

  it("changed context needs a fresh bound epoch; a prepared context cannot silently change", async () => {
    const f = await fixture(); await prepared(f);
    const provider = binds(f)[0]!.provider;
    const id = (await f.session.snapshot()).binding!.preparedTurnId;
    await expect(f.session.attachRun({ runId: "run-b", ...context, runtimeContext: { revision: 3 } })).rejects.toThrow(/context/i);
    expect(prompts(f)).toHaveLength(1); expect(binds(f)).toHaveLength(1);
    expect((await f.session.snapshot()).binding).toMatchObject({ epoch: 2, preparedTurnId: id });
    expect(await reachable(provider)).toBe(true);
    const turn = await f.session.startTurn({ message: { role: "user", text: "unchanged prepared context" } });
    expect(turn.turnId).toBe(id); await finish(f, turn.turnId, "run-b");
    const from = f.native.calls.length;
    await f.session.attachRun({ runId: "run-b", ...context, runtimeContext: { revision: 3 } });
    expect(types(f, from)).toEqual(fullAdmission);
    expect(binds(f).at(-1)).toMatchObject({ expectedPriorEpoch: 2, epoch: 3, runId: "run-b" });
    expect(binds(f).at(-1)!.instructions).toContain('"revision":3');
    const next = await f.session.startTurn({ message: { role: "user", text: "new context" } });
    expect(prompts(f).at(-1)).toMatchObject({ epoch: 3, runId: "run-b" });
    await finish(f, next.turnId, "run-b");
    expect(await reachable(provider)).toBe(false); expect(await reachable(binds(f).at(-1)!.provider)).toBe(false);
    expect(writes(f, from)).toEqual(configuration);
  });

  it("explicit reconnect must fully re-admit but does not mint a second prepared epoch", async () => {
    const f = await fixture(); await prepared(f);
    const id = (await f.session.snapshot()).binding!.preparedTurnId;
    const from = f.native.calls.length;
    await f.session.reconnect();
    expect(types(f, from)).toEqual(fullAdmission);
    expect((await f.session.snapshot()).binding).toMatchObject({ epoch: 2, preparedTurnId: id });
    const turn = await f.session.startTurn({ message: { role: "user", text: "after reconnect" } });
    expect(turn.turnId).toBe(id); expect(binds(f)).toHaveLength(1);
    expect(prompts(f).at(-1)).toMatchObject({ epoch: 2, runId: "run-b" });
    await finish(f, turn.turnId, "run-b"); expect(await reachable(binds(f)[0]!.provider)).toBe(false);
    expect(writes(f, from)).toEqual(configuration);
  });

  it.each(["streaming", "compacting", "queued", "malformed", "failed", "identity", "model", "effective-effort"] as const)("refuses %s drift at the post-claim correctness fence", async fault => {
    const f = await fixture(); await prepared(f);
    await f.session.attachRun({ runId: "run-b", ...context });
    if (fault === "streaming") f.native.state.isStreaming = true;
    if (fault === "compacting") f.native.state.isCompacting = true;
    if (fault === "queued") f.native.state.pendingMessageCount = 1;
    if (fault === "malformed") delete f.native.state.pendingMessageCount;
    if (fault === "failed") f.native.failState = true;
    if (fault === "identity") f.native.sessionId = "tampered-same-process";
    if (fault === "model") f.native.model = { provider: "paperclip", id: "wrong" };
    if (fault === "effective-effort") f.native.thinkingLevel = "high";
    await refuseAndRevoke(f, () => f.session.revalidateAfterClaim());
    expect(binds(f)).toHaveLength(1); expect(f.native.pid).toBe(42);
  });

  it.each(["identity", "model", "effective-effort", "busy"] as const)("fresh pre-prompt proof catches %s tamper after successful post-claim", async fault => {
    const f = await fixture(); await prepared(f);
    await f.session.attachRun({ runId: "run-b", ...context }); await f.session.revalidateAfterClaim();
    await f.session.attachRun({ runId: "run-b", ...context });
    if (fault === "identity") f.native.sessionId = "same-pid-different-native-session";
    if (fault === "model") f.native.model = { provider: "other", id: "faux" };
    if (fault === "effective-effort") f.native.thinkingLevel = "high";
    if (fault === "busy") f.native.state.isStreaming = true;
    await refuseAndRevoke(f, () => f.session.startTurn({ message: { role: "user", text: "must not prompt" } }));
    expect(binds(f)).toHaveLength(1);
  });

  it("reconnect cannot reuse the old native session identity even in the same process", async () => {
    const f = await fixture(); await prepared(f); f.native.sessionId = "replacement-native-session";
    await refuseAndRevoke(f, () => f.session.reconnect());
    expect(f.native.pid).toBe(42); expect(binds(f)).toHaveLength(1);
  });

  it("reconnect requires a new exact model acknowledgement, not merely matching final state", async () => {
    const f = await fixture(); await prepared(f); f.native.rejectModelAck = true;
    await refuseAndRevoke(f, () => f.session.reconnect());
    expect(f.native.model).toEqual({ provider: "paperclip", id: "faux" });
    expect(binds(f)).toHaveLength(1);
  });

  it.each(["rejected-bind", "stale-bind", "lost-bind", "lost-begin"] as const)("fences %s receipt with no retry, no new prompt, and physical capability revocation", async fault => {
    const f = await fixture(); await coldTerminal(f); f.setFault(fault);
    await refuseAndRevoke(f, () => fault === "lost-begin"
      ? f.session.startTurn({ message: { role: "user", text: "uncertain begin" } })
      : f.session.attachRun({ runId: "run-b", ...context }));
    expect(binds(f)).toHaveLength(1);
    expect(await reachable(binds(f)[0]!.provider)).toBe(false);
    expect((await f.session.snapshot()).binding?.epoch).toBe(fault === "lost-begin" ? 2 : 1);
    expect(f.ipc.filter(command => command.type === "begin_turn")).toHaveLength(fault === "lost-begin" ? 1 : 0);
  });

  it("a definite prompt rejection revokes that epoch but permits a freshly bound next turn", async () => {
    const f = await fixture(); await prepared(f); f.native.prompt = "rejected";
    const rejectedId = (await f.session.snapshot()).binding!.preparedTurnId;
    await expect(f.session.startTurn({ message: { role: "user", text: "rejected" } })).rejects.toThrow("rejected before acceptance");
    expect(f.events.some(event => event.eventType === "turn.failed" && event.turnId === rejectedId && event.runId === "run-b")).toBe(true);
    expect((await f.session.snapshot()).binding?.preparedTurnId).toBeNull();
    expect(await reachable(binds(f)[0]!.provider)).toBe(false); expect(f.native.closed).toBe(false);
    f.native.prompt = "started";
    const from = f.native.calls.length;
    const next = await f.session.startTurn({ message: { role: "user", text: "new input, not retry" } });
    expect(next.turnId).not.toBe(rejectedId); expect(types(f, from)).toEqual([...fullAdmission, "prompt"]);
    expect(binds(f).at(-1)).toMatchObject({ expectedPriorEpoch: 2, epoch: 3, runId: "run-b" });
    expect(prompts(f)).toHaveLength(3); expect(prompts(f).at(-1)).toMatchObject({ epoch: 3, runId: "run-b" });
    await finish(f, next.turnId, "run-b"); expect(await reachable(binds(f).at(-1)!.provider)).toBe(false);
  });

  it("an unknown prompt ACK without owned native lifecycle is never retried and retires the capability", async () => {
    const f = await fixture(); await prepared(f); f.native.prompt = "unknown";
    const id = (await f.session.snapshot()).binding!.preparedTurnId;
    await expect(f.session.startTurn({ message: { role: "user", text: "unknown acceptance" } })).rejects.toThrow(/unknown|deadline/i);
    expect(prompts(f)).toHaveLength(2); expect(prompts(f).at(-1)).toMatchObject({ epoch: 2, runId: "run-b" });
    expect(f.events.some(event => event.eventType === "turn.failed" && event.turnId === id && event.runId === "run-b")).toBe(true);
    expect(f.native.closed).toBe(true); expect(await reachable(binds(f)[0]!.provider)).toBe(false);
    expect((await f.session.snapshot()).binding?.preparedTurnId).toBeNull();
    await expect(f.session.startTurn({ message: { role: "user", text: "forbidden retry" } })).rejects.toThrow();
    expect(prompts(f)).toHaveLength(2); expect(binds(f)).toHaveLength(1);
  });
});
