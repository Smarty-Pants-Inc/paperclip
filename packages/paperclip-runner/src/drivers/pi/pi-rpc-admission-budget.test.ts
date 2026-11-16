import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { bindContent, sendPiBindRequest, type PiBindCommand } from "./pi-bind-protocol.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { PROVIDER_PERFORMANCE_DIAGNOSTIC, parseProviderPerformanceSpans } from "../../contracts/provider-performance.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: the shared admission budget is the bound that keeps a native Pi
// admission inside the facade's 30 s receive wait, and its timeout evidence is
// the trust-boundary diagnostic. Exercise the real driver, real private socket
// (with its own deadline) and the real span parser; only the external Pi
// process (transport) and host broker latency are controlled.
const knobs = vi.hoisted(() => ({ createDelayMs: 0, created: 0, closed: 0 }));
vi.mock("../acpx/pi-provider-loopback.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../acpx/pi-provider-loopback.js")>();
  return { ...actual, createPiProviderBinding: async (...args: Parameters<typeof actual.createPiProviderBinding>) => {
    const delayMs = knobs.createDelayMs;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const binding = await actual.createPiProviderBinding(...args);
    knobs.created++;
    const close = binding.close;
    return { ...binding, close: async () => { knobs.closed++; await close(); } };
  } };
});

const BUDGET_MS = 1000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
class Transport {
  closed = false; exited = false; pid = null;
  ready: Promise<void> = Promise.resolve();
  commands: string[] = [];
  delays: Record<string, number> = {};
  wake?: () => void;
  async request(type: string): Promise<PiRpcRecord> {
    await this.ready;
    this.commands.push(type);
    if (this.delays[type]) await delay(this.delays[type]!);
    const model = { provider: "paperclip", id: "faux" };
    return { success: true, data: type === "get_state" ? { sessionId: "native-budget", model, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model
      : type === "get_available_thinking_levels" ? { levels: ["off"] }
      : type === "get_available_models" ? { models: [model] }
      : type === "prompt" ? { disposition: "started" } : undefined };
  }
  async *events(): AsyncIterable<PiRpcRecord> { while (!this.closed) await new Promise<void>(resolve => { this.wake = resolve; }); }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  knobs.createDelayMs = 0; knobs.created = 0; knobs.closed = 0;
  vi.restoreAllMocks();
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-admission-budget-"));
  const transport = new Transport();
  const commands: PiBindCommand[] = [];
  const exchangeDelays: Record<string, number> = {};
  const silent = new Set<string>();
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let peer: Server | undefined;
  const driver = new PiRpcDriver({ model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), startupTimeoutMs: BUDGET_MS,
    environment: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    transportFactory: options => {
      peer = createServer(socket => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
        let buffer = ""; socket.setEncoding("utf8"); socket.on("data", chunk => {
          buffer += chunk; if (!buffer.endsWith("\n")) return;
          const request = JSON.parse(buffer) as PiBindCommand; commands.push(request);
          if (silent.has(request.type)) return;
          const receipt = request.type === "tool_inventory" ? { ...request, nativeTools: ["read"] }
            : request.type === "bind" ? { schema: 1, type: "bind", nonce: request.nonce, sessionId: request.sessionId, epoch: request.epoch, runId: request.runId, provider: request.provider.name, model: request.model, thinkingLevel: request.thinkingLevel, ...bindContent(request) }
            : request.type === "stop_children" ? { ...request, settled: [], uncertain: [] }
            : request.type === "park_ready" ? { ...request, ready: true, reasons: [] } : { ...request, ack: true };
          const timer = setTimeout(() => { timers.delete(timer); socket.end(`${JSON.stringify(receipt)}\n`); }, exchangeDelays[request.type] ?? 0);
          timers.add(timer);
        });
      });
      transport.ready = new Promise<void>((resolve, reject) => { peer!.once("error", reject); peer!.listen(options.env!.PAPERCLIP_PI_BIND_SOCKET!, resolve); });
      return transport as unknown as PiRpcTransport;
    },
    bindRequest: sendPiBindRequest,
  });
  let session: PiRpcHarnessSession | undefined;
  let drained: Promise<void> | undefined;
  const events: PrpEvent[] = [];
  cleanups.push(async () => {
    silent.clear(); for (const key of Object.keys(exchangeDelays)) delete exchangeDelays[key];
    transport.delays = {};
    if (session) await session.close().catch(() => undefined);
    await drained; await transport.close();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (peer?.listening) await new Promise<void>(resolve => peer!.close(() => resolve()));
  });
  const open = async () => {
    session = await driver.openSession({ runId: "run-a", normalizedSessionId: "host-budget", workingDirectory: root }) as PiRpcHarnessSession;
    drained = (async () => { for await (const event of session!.events()) events.push(event); })();
    await tick(); return session;
  };
  /** A changed-run attach after the bootstrap origin is settled: inventory, broker, bind, then admission. */
  const released = async () => { const opened = await open(); await opened.releaseInitialBindingForRecovery(); return opened; };
  const spans = () => events.flatMap(event => parseProviderPerformanceSpans(event.payload, Date.now()));
  return { open, released, transport, commands, exchangeDelays, silent, events, spans };
}
const elapsed = async (work: Promise<unknown>) => {
  const startedAtMs = performance.now();
  const error = await work.then(() => undefined, (error: unknown) => error);
  return { error: error as (Error & { code?: string; timeoutCode?: string }) | undefined, elapsedMs: performance.now() - startedAtMs };
};
/** Failed opens have no session; their spans are the stderr diagnostic batch. */
function stderrSpans(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== "string" || !line.startsWith("{")) return [];
    const parsed = JSON.parse(line) as { payload?: { code?: string } };
    return parsed.payload?.code === PROVIDER_PERFORMANCE_DIAGNOSTIC ? parseProviderPerformanceSpans(parsed.payload, Date.now()) : [];
  });
}

describe("Pi admission budget timeout evidence (F1)", () => {
  it("a budgeted attach inventory timeout fails as the admission deadline and its span keeps pi_bind_timeout", async () => {
    const f = await fixture(); const session = await f.released();
    f.silent.add("tool_inventory");
    const { error } = await elapsed(session.attachRun({ runId: "run-b" })); await tick();
    expect(error).toMatchObject({ code: "pi_admission_deadline_exceeded" });
    const inventory = f.spans().filter(span => span.name === "runner.pi.tool_inventory");
    expect(inventory).toEqual([expect.objectContaining({ outcome: "failed", attributes: { timeoutCode: "pi_bind_timeout" } })]);
    expect(f.spans().filter(span => span.name === "runner.pi.attach")).toEqual([expect.objectContaining({ outcome: "failed", attributes: { timeoutCode: "pi_bind_timeout" } })]);
    expect(f.transport.commands).not.toContain("prompt");
  });

  it("a budgeted cold-open inventory timeout keeps pi_bind_timeout on the failed-open diagnostic", async () => {
    const f = await fixture(); f.silent.add("tool_inventory");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { error } = await elapsed(f.open());
    expect(error).toMatchObject({ code: "pi_admission_deadline_exceeded" });
    expect(stderrSpans(stderr).filter(span => span.name === "runner.pi.open.tool_inventory"))
      .toEqual([expect.objectContaining({ outcome: "failed", attributes: { timeoutCode: "pi_bind_timeout" } })]);
  });

  it("a budget-exhausted admission RPC records the safe pi_admission_deadline_exceeded timeout code", async () => {
    const f = await fixture(); const session = await f.released();
    f.transport.delays = { set_model: BUDGET_MS + 500 };
    const { error } = await elapsed(session.attachRun({ runId: "run-b" })); await tick();
    expect(error).toMatchObject({ code: "pi_admission_deadline_exceeded", timeoutCode: "pi_admission_deadline_exceeded" });
    expect(f.spans().filter(span => span.name === "runner.pi.admission.set_model"))
      .toEqual([expect.objectContaining({ outcome: "failed", attributes: { timeoutCode: "pi_admission_deadline_exceeded" } })]);
  });

  it("the parser keeps only the fixed safe timeout codes", () => {
    const row = (timeoutCode: unknown) => ({ code: PROVIDER_PERFORMANCE_DIAGNOSTIC, spans: [{ name: "runner.pi.bind", startedAtMs: 1, endedAtMs: 2, outcome: "failed", attributes: { timeoutCode } }] });
    expect(parseProviderPerformanceSpans(row("pi_admission_deadline_exceeded"), 3)[0]).toMatchObject({ attributes: { timeoutCode: "pi_admission_deadline_exceeded" } });
    expect(parseProviderPerformanceSpans(row("pi_bind_timeout"), 3)[0]).toMatchObject({ attributes: { timeoutCode: "pi_bind_timeout" } });
    expect(parseProviderPerformanceSpans(row("PRIVATE nonce"), 3)[0]!.attributes).toBeUndefined();
  });
});

// Each segment below fits the budget alone; only one shared budget fails the
// sum. A mutation that gives any segment its own budget therefore succeeds.
describe("Pi admission budget sharing beyond the open path's private exchanges (F3)", () => {
  it("attach path: inventory, bind and re-admission spend one budget (kills M1b)", async () => {
    const f = await fixture(); const session = await f.released();
    // 400 + 400 + (150 + 150 + 100) = 1200 ms > 1000 ms; any two segments = 800 ms.
    Object.assign(f.exchangeDelays, { tool_inventory: 400, bind: 400 });
    f.transport.delays = { set_model: 150, get_available_thinking_levels: 150, set_thinking_level: 100 };
    const { error, elapsedMs } = await elapsed(session.attachRun({ runId: "run-b" }));
    expect(error).toMatchObject({ code: "pi_admission_deadline_exceeded" });
    expect(elapsedMs).toBeLessThan(BUDGET_MS + 400);
    expect(f.commands.map(command => command.type)).toContain("bind");
    expect(f.transport.commands).not.toContain("prompt");
  });

  it("attach path control: the same exchanges admit when their sum fits the budget", async () => {
    const f = await fixture(); const session = await f.released();
    Object.assign(f.exchangeDelays, { tool_inventory: 200, bind: 200 });
    f.transport.delays = { set_model: 100, get_available_thinking_levels: 100, set_thinking_level: 50 };
    await expect(session.attachRun({ runId: "run-b" })).resolves.toBeUndefined();
  });

  it("open path: a model/thinking admission RPC is cut at the shared budget, not by its own fresh budget (kills M1c)", async () => {
    const f = await fixture();
    // 150 + 150 ms, then set_thinking_level needs 900 ms: each RPC fits a fresh
    // 1000 ms budget, but the shared budget expires inside set_thinking_level.
    f.transport.delays = { set_model: 150, get_available_thinking_levels: 150, set_thinking_level: 900 };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { error, elapsedMs } = await elapsed(f.open());
    expect(error).toMatchObject({ code: "pi_admission_deadline_exceeded", timeoutCode: "pi_admission_deadline_exceeded" });
    expect(elapsedMs).toBeLessThan(BUDGET_MS + 400);
    expect(stderrSpans(stderr).filter(span => span.name === "runner.pi.open.admission"))
      .toEqual([expect.objectContaining({ outcome: "failed", attributes: { timeoutCode: "pi_admission_deadline_exceeded" } })]);
    expect(f.commands).toEqual([]);
    expect(f.transport.commands).not.toContain("get_available_models");
    expect(f.transport.commands).not.toContain("prompt");
  });

  it("open path control: the same RPCs admit when their sum fits the budget", async () => {
    const f = await fixture();
    Object.assign(f.exchangeDelays, { tool_inventory: 200 });
    f.transport.delays = { set_model: 100, get_available_thinking_levels: 100, set_thinking_level: 100, get_available_models: 100 };
    await expect(f.open()).resolves.toBeDefined();
  });
});

// F6: host-local broker revocation/creation is accounted INSIDE the same
// wall-clock budget (it guards the facade's 30 s receive wait), and is
// therefore bounded by its remaining time instead of overrunning it.
describe("Pi admission budget bounds host-local broker work (F6)", () => {
  it("a slow broker creation is cut at the budget and the late broker is still revoked", async () => {
    const f = await fixture(); const session = await f.released();
    const before = { created: knobs.created, closed: knobs.closed };
    knobs.createDelayMs = BUDGET_MS + 800;
    const { error, elapsedMs } = await elapsed(session.attachRun({ runId: "run-b" }));
    expect(error).toMatchObject({ code: "pi_admission_deadline_exceeded", timeoutCode: "pi_admission_deadline_exceeded" });
    expect(elapsedMs).toBeLessThan(BUDGET_MS + 300);
    expect(f.commands.filter(command => command.type === "bind")).toEqual([]);
    // The broker that arrives after the deadline is owned and closed, never leaked.
    await vi.waitFor(() => expect(knobs.created - before.created).toBe(1), { timeout: 3000 });
    await vi.waitFor(() => expect(knobs.closed - before.closed).toBe(knobs.created - before.created), { timeout: 3000 });
  });
});
