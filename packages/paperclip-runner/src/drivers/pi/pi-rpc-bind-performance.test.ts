import { mkdtemp } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { bindContent, sendPiBindRequest, type PiBindCommand } from "./pi-bind-protocol.js";
import type { PiRpcRecord, PiRpcTransport } from "./pi-rpc-transport.js";
import { parseProviderPerformanceSpans } from "../../contracts/provider-performance.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: receipt failure/deadline paths and the diagnostic reader are
// trust boundaries; exercise the real private socket, driver and span parser.
class Transport {
  closed = false; exited = false; pid = null;
  ready: Promise<void> = Promise.resolve();
  wake?: () => void;
  async request(type: string): Promise<PiRpcRecord> {
    await this.ready;
    const model = { provider: "paperclip", id: "faux" };
    return { success: true, data: type === "get_state" ? { sessionId: "native-bind", model, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model
      : type === "get_available_thinking_levels" ? { levels: ["off"] }
      : type === "get_available_models" ? { models: [model] } : undefined };
  }
  async *events(): AsyncIterable<PiRpcRecord> { while (!this.closed) await new Promise<void>(resolve => { this.wake = resolve; }); }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function fixture(coldTimeout = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-bind-performance-"));
  const transport = new Transport();
  const commands: PiBindCommand[] = [];
  const sockets = new Set<Socket>();
  let peer: Server | undefined;
  let timeoutInventory = coldTimeout;
  let mismatchInventory = false;
  const driver = new PiRpcDriver({ model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 120,
    environment: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    transportFactory: options => {
      peer = createServer(socket => {
        sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
        let buffer = ""; socket.setEncoding("utf8"); socket.on("data", chunk => {
          buffer += chunk; if (!buffer.endsWith("\n")) return;
          const request = JSON.parse(buffer) as PiBindCommand; commands.push(request);
          if (request.type === "tool_inventory" && timeoutInventory) return;
          const receipt = request.type === "tool_inventory" ? { ...request, nonce: mismatchInventory ? "wrong" : request.nonce, nativeTools: ["read"] }
            : request.type === "bind" ? { schema: 1, type: "bind", nonce: request.nonce, sessionId: request.sessionId, epoch: request.epoch, runId: request.runId, provider: request.provider.name, model: request.model, thinkingLevel: request.thinkingLevel, ...bindContent(request) }
            : request.type === "stop_children" ? { ...request, settled: [], uncertain: [] }
            : request.type === "park_ready" ? { ...request, ready: true, reasons: [] } : { ...request, ack: true };
          socket.end(`${JSON.stringify(receipt)}\n`);
        });
      });
      transport.ready = new Promise<void>((resolve, reject) => { peer!.once("error", reject); peer!.listen(options.env!.PAPERCLIP_PI_BIND_SOCKET!, resolve); });
      return transport as unknown as PiRpcTransport;
    },
    // Use the actual socket deadline as well as the driver's outer deadline.
    bindRequest: sendPiBindRequest,
  });
  let session: PiRpcHarnessSession | undefined;
  let drained: Promise<void> | undefined;
  const events: PrpEvent[] = [];
  cleanups.push(async () => {
    timeoutInventory = false; mismatchInventory = false;
    if (session) await session.close();
    await drained; await transport.close();
    for (const socket of sockets) socket.destroy();
    if (peer) await new Promise<void>(resolve => peer!.close(() => resolve()));
  });
  const open = async () => {
    session = await driver.openSession({ runId: "run-a", normalizedSessionId: "host-bind", workingDirectory: root }) as PiRpcHarnessSession;
    drained = (async () => { for await (const event of session!.events()) events.push(event); })();
    await tick(); return session;
  };
  const spans = () => events.flatMap(event => parseProviderPerformanceSpans(event.payload, Date.now()));
  return { open, commands, events, spans, fault: (kind: "timeout" | "mismatch") => { timeoutInventory = kind === "timeout"; mismatchInventory = kind === "mismatch"; } };
}

describe("Pi private bind exchange performance", () => {
  it("records same-run inventory once with its kind, duration and outcome before any turn", async () => {
    const f = await fixture(); const session = await f.open();
    const start = Date.now(); await session.attachRun({ runId: "run-a" }); await tick();
    const spans = f.spans().filter(span => span.name === "runner.pi.tool_inventory");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: "runner.pi.tool_inventory", outcome: "ok" });
    expect(spans[0]!.startedAtMs).toBeGreaterThanOrEqual(start);
    expect(spans[0]!.endedAtMs - spans[0]!.startedAtMs).toBeGreaterThanOrEqual(0);
    expect(f.commands.filter(command => command.type === "tool_inventory")).toHaveLength(2); // one cold, one attach
    expect(f.events.some(event => event.eventType === "turn.started")).toBe(false);
  });

  it.each(["timeout", "mismatch"] as const)("records a failed inventory %s without inventing an outcome enum", async fault => {
    const f = await fixture(); const session = await f.open(); f.fault(fault);
    await expect(session.attachRun({ runId: "run-a" })).rejects.toThrow(/receipt|timed/i); await tick();
    const spans = f.spans().filter(span => span.name === "runner.pi.tool_inventory");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ outcome: "failed", ...(fault === "timeout" ? { attributes: { timeoutCode: "pi_bind_timeout" } } : {}) });
    expect(spans[0]!.endedAtMs - spans[0]!.startedAtMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(spans)).not.toMatch(/socket|instructions|nonce|apiKey/);
  });

  it("records settle and park_ready through the same reader but excludes cleanup stop_children", async () => {
    const f = await fixture(); const session = await f.open();
    await session.releaseInitialBindingForRecovery(); await session.parkReady(); await session.close(); await tick();
    for (const kind of ["settle", "park_ready"]) {
      const spans = f.spans().filter(span => span.name === `runner.pi.${kind}`);
      expect(spans, kind).toHaveLength(1);
      expect(spans[0], kind).toMatchObject({ name: `runner.pi.${kind}`, outcome: "ok" });
      expect(spans[0]!.endedAtMs - spans[0]!.startedAtMs).toBeGreaterThanOrEqual(0);
    }
    expect(f.commands.filter(command => command.type === "stop_children")).toHaveLength(1);
    expect(f.events.flatMap(event => event.payload.code === "provider_performance_spans"
      ? event.payload.spans as Array<{ name: string }> : [])
      .filter(span => span.name === "runner.pi.stop_children")).toEqual([]);
  });
});
