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
const knobs = vi.hoisted(() => ({ createDelayMs: 0, created: 0, closed: 0, writeDelayMs: 0, skillsDelayMs: 0, imageDelayMs: 0 }));
vi.mock("./pi-company-skills.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pi-company-skills.js")>();
  return { ...actual, syncPiCompanySkills: async (...args: Parameters<typeof actual.syncPiCompanySkills>) => {
    if (knobs.skillsDelayMs > 0) await new Promise(resolve => setTimeout(resolve, knobs.skillsDelayMs));
    return actual.syncPiCompanySkills(...args);
  } };
});
vi.mock("./pi-turn-images.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pi-turn-images.js")>();
  return { ...actual, piTurnImageInput: async (...args: Parameters<typeof actual.piTurnImageInput>) => {
    if (knobs.imageDelayMs > 0) await new Promise(resolve => setTimeout(resolve, knobs.imageDelayMs));
    return actual.piTurnImageInput(...args);
  } };
});
vi.mock("../private-file.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../private-file.js")>();
  return { ...actual, writePrivateFile: async (path: string, value: string) => {
    if (knobs.writeDelayMs > 0 && path.endsWith(".instructions.md")) await new Promise(resolve => setTimeout(resolve, knobs.writeDelayMs));
    return actual.writePrivateFile(path, value);
  } };
});
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
  knobs.createDelayMs = 0; knobs.created = 0; knobs.closed = 0; knobs.writeDelayMs = 0;
  knobs.skillsDelayMs = 0; knobs.imageDelayMs = 0;
  vi.restoreAllMocks();
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

async function fixture(options: Partial<ConstructorParameters<typeof PiRpcDriver>[0]> = {}) {
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
    ...options,
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


// Judge's original probe: host-local instruction-file write inside a shared turn admission.
describe("JUDGE PROBE: unbudgeted host-local work spends the shared turn budget", () => {
  it("probe: a turn whose every exchange is fast fails when the attach's instruction write is slow", async () => {
    const f = await fixture(); const session = await f.released();
    knobs.writeDelayMs = BUDGET_MS + 100; // the attach's private instruction file write (fsync) only
    const admission = session as unknown as { beginTurnAdmission(): void; endTurnAdmission(): void };
    admission.beginTurnAdmission();
    let attachError: unknown; let turnError: unknown;
    try {
      attachError = await session.attachRun({ runId: "run-b" }).then(() => undefined, (error: unknown) => error);
      turnError = await session.startTurn({ message: { role: "user", text: "one" } }).then(() => undefined, (error: unknown) => error);
    } finally { admission.endTurnAdmission(); }
    await tick();
    const failed = f.spans().filter(span => span.outcome === "failed").map(span => `${span.name}:${span.endedAtMs - span.startedAtMs}ms:${span.attributes?.timeoutCode ?? "-"}`);
    console.log("PROBE attachError=", (attachError as Error | undefined)?.message, "turnError=", (turnError as { code?: string } | undefined)?.code, (turnError as Error | undefined)?.message, "failedSpans=", JSON.stringify(failed));
    // Expectation of a budget that only meters exchanges: the turn should be admitted.
    expect(attachError).toBeUndefined();
    expect(turnError).toBeUndefined();
  });
  it("probe control: the same slow write without a shared turn admission admits the turn", async () => {
    const f = await fixture(); const session = await f.released();
    knobs.writeDelayMs = BUDGET_MS + 100;
    await session.attachRun({ runId: "run-b" });
    await expect(session.startTurn({ message: { role: "user", text: "one" } })).resolves.toMatchObject({ turnId: expect.any(String) });
  });
});

// Keep reason: all local preparation paths can otherwise blame/fence the next
// healthy Pi exchange. Delays exceed the unchanged fixture budget on purpose.
describe("local preparation does not spend Pi exchange time", () => {
  it("cold-open instruction rewrite does not starve metadata discovery", async () => {
    const f = await fixture({ dynamicTools: [{ name: "local_tool", description: "local", inputSchema: { type: "object", properties: {} } }] });
    knobs.writeDelayMs = BUDGET_MS + 100;
    await expect(f.open()).resolves.toBeDefined();
    expect(f.commands.map(command => command.type)).toContain("bind");
    expect(f.transport.commands).toContain("get_available_models");
  });

  it.each(["skills", "images"] as const)("slow %s preparation keeps a shared resident turn usable", async kind => {
    const f = await fixture(); const session = await f.released();
    if (kind === "skills") knobs.skillsDelayMs = BUDGET_MS + 100;
    else knobs.imageDelayMs = BUDGET_MS + 100;
    session.beginTurnAdmission();
    try {
      await session.attachRun({ runId: "run-b" });
      await expect(session.startTurn({ message: { role: "user", text: "one" } })).resolves.toMatchObject({ turnId: expect.any(String) });
    } finally { session.endTurnAdmission(); }
    expect(f.transport.closed).toBe(false);
    expect(f.transport.commands).toContain("prompt");
    expect(f.spans().filter(span => span.outcome === "failed")).toEqual([]);
  });

  it("local write exclusion preserves earlier exchange spend across attach and turn", async () => {
    const f = await fixture(); const session = await f.released();
    knobs.writeDelayMs = BUDGET_MS + 100;
    Object.assign(f.exchangeDelays, { tool_inventory: 300, bind: 300, begin_turn: 500 });
    session.beginTurnAdmission();
    try {
      await session.attachRun({ runId: "run-b" });
      await expect(session.startTurn({ message: { role: "user", text: "one" } })).rejects.toMatchObject({ code: "pi_admission_deadline_exceeded" });
    } finally { session.endTurnAdmission(); }
    expect(f.transport.commands).not.toContain("prompt");
  });
});
