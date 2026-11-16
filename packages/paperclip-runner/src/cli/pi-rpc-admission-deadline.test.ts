import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPiRpcAppServerProxy } from "./pi-rpc-app-server-proxy.js";
import { PiRpcDriver } from "../drivers/pi/pi-rpc-driver.js";
import type { PiRpcRecord, PiRpcTransport } from "../drivers/pi/pi-rpc-transport.js";
import { bindContent, type PiBindCommand } from "../drivers/pi/pi-bind-protocol.js";
import { createPiNativeSessionBackend } from "../backends/pi-native-backend.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSession } from "../contracts/native-session-backend.js";
import { createCapabilityRunnerdProviderEnvironment } from "../live/runnerd-codex-transport.js";

// Keep reason: runner -> proxy -> native private admission is a trust boundary.
// Use the production launch config unchanged, replacing only the external Pi
// transport. Private requests still cross a real socket and use real deadlines.
class AdmissionTransport {
  closed = false;
  exited = false;
  pid = null;
  ready = Promise.resolve();
  commands: string[] = [];
  wake?: () => void;
  async request(type: string) {
    await this.ready;
    this.commands.push(type);
    const model = { provider: "paperclip", id: "faux" };
    return { success: true, data: type === "get_state"
      ? { sessionId: "native-session", model, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model
      : type === "get_available_thinking_levels" ? { levels: ["off"] }
      : type === "get_available_models" ? { models: [model] } : undefined };
  }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) await new Promise<void>(resolve => { this.wake = resolve; });
  }
  async close() { this.closed = this.exited = true; this.wake?.(); }
}

function runnerEnvironment(root: string, deadline?: string) {
  return createCapabilityRunnerdProviderEnvironment({
    provider: "pi_rpc", model: "paperclip/faux",
    options: { provider: "pi_rpc", piRpcThinkingLevel: "off", piRuntimeDirectory: join(root, "sessions"), environment: {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1",
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer",
      PAPERCLIP_AI_PROVIDER_KEY: "deadline-test-only",
      ...(deadline === undefined ? {} : { PAPERCLIP_PI_ADMISSION_TIMEOUT_MS: deadline }),
    } },
    identity: { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1", normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1" },
    codexHome: root, runtimeContextPath: join(root, "context.json"), hasRuntimeContext: false,
  });
}

async function openThroughProxy(delayMs: number, deadline?: string, mode: "proxy" | "multi-exchange" | "backend" = "proxy") {
  const root = await mkdtemp(join(tmpdir(), "pi-proxy-deadline-"));
  const transport = new AdmissionTransport();
  const exchanges: PiBindCommand[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const peer = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.endsWith("\n")) return;
      const request = JSON.parse(buffer) as PiBindCommand;
      exchanges.push(request);
      const receipt = request.type === "tool_inventory" ? { ...request, nativeTools: [] }
        : request.type === "stop_children" ? { ...request, settled: [], uncertain: [] }
        : request.type === "park_ready" ? { ...request, ready: true, reasons: [] }
        : request.type === "bind" ? { ...request, ...bindContent(request), provider: request.provider.name }
        : { ...request, ack: true };
      const timer = setTimeout(() => {
        timers.delete(timer);
        socket.end(`${JSON.stringify(receipt)}\n`);
      }, mode === "multi-exchange" || request.type === "tool_inventory" ? delayMs : 0);
      timers.add(timer);
    });
  });
  let complete!: (frame: PiRpcRecord) => void;
  const reply = new Promise<PiRpcRecord>(resolve => { complete = resolve; });
  const proxy = createPiRpcAppServerProxy({
    environment: runnerEnvironment(root, deadline),
    stdout: { write(chunk) { const frame = JSON.parse(chunk); if (frame.id === 1) complete(frame); return true; }, once() {} },
    createDriver: config => new PiRpcDriver({ ...config,
      ...(mode === "multi-exchange" ? { dynamicTools: [{ name: "deadline_tool", description: "Deadline regression tool", inputSchema: { type: "object" } }] } : {}),
      transportFactory: options => {
      transport.ready = new Promise<void>((resolve, reject) => {
        peer.once("error", reject); peer.listen(options.env!.PAPERCLIP_PI_BIND_SOCKET!, resolve);
      });
      return transport as unknown as PiRpcTransport;
    } }),
  });
  let nativeSession: NativeSession | undefined;
  const startedAtMs = performance.now();
  try {
    let frame: PiRpcRecord;
    if (mode === "backend") {
      const input = {
        schema: "paperclip.native-execution-input.v1",
        provider: { kind: "pi_rpc", model: "paperclip/faux", piRpcThinkingLevel: "off" },
        task: { prompt: "Complete the task.", workMode: "standard" },
        completionContract: { contract: { objective: "Complete the task.", revision: "r1", criteria: [] } },
      } as unknown as NativeExecutionInput;
      const backend = createPiNativeSessionBackend(input, {
        runtimeDirectory: join(root, "sessions"), environment: runnerEnvironment(root, deadline),
        transportFactory: options => {
          transport.ready = new Promise<void>((resolve, reject) => {
            peer.once("error", reject); peer.listen(options.env!.PAPERCLIP_PI_BIND_SOCKET!, resolve);
          });
          return transport as unknown as PiRpcTransport;
        },
      });
      try {
        nativeSession = await backend.openSession({
          identity: { runId: "run-1", sessionId: "session-1", companyId: "company-1", agentId: "agent-1", issueId: "task-1" },
          workingDirectory: root,
        });
        frame = { result: { thread: { id: (await nativeSession.snapshot()).providerSessionId } } };
      } catch (error) {
        frame = { error: { message: (error as Error).message } };
      }
    } else {
      proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: root, model: "paperclip/faux", piRpcThinkingLevel: "off" } }));
      frame = await reply;
    }
    return { frame, exchanges: [...exchanges], commands: [...transport.commands], elapsedMs: performance.now() - startedAtMs };
  } finally {
    await nativeSession?.close({ reason: "deadline regression cleanup" });
    await proxy.close();
    await proxy.endInput();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (peer.listening) await new Promise<void>(resolve => peer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

describe("production Pi proxy admission deadline", () => {
  it("shares one budget across four slow private exchanges instead of outliving the 30 s facade", async () => {
    // Each 7.9 s reply is below the 8 s per-exchange budget, but four take
    // 31.6 s. Admission must fail in its ONE 8 s budget, before prompt/facade.
    const { frame, exchanges, commands, elapsedMs } = await openThroughProxy(7900, "8000", "multi-exchange");
    expect(frame.error).toMatchObject({ code: -32000, data: { code: "pi_admission_deadline_exceeded" } });
    expect(elapsedMs).toBeGreaterThanOrEqual(7900);
    expect(elapsedMs).toBeLessThan(10_000);
    expect(exchanges.map(request => request.type)).toEqual(["tool_inventory", "settle"]);
    expect(commands).not.toContain("prompt");
  }, 40_000);

  it.each([undefined, "8000"])("in-process backend admits a 6 s inventory reply with deadline %s", async deadline => {
    const { frame, exchanges, commands } = await openThroughProxy(6000, deadline, "backend");
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ thread: { id: "native-session" } });
    expect(exchanges.map(request => request.type)).toEqual(["tool_inventory"]);
    expect(commands).not.toContain("prompt");
  }, 15_000);

  it.each([undefined, "8000"])("admits a 6 s tool_inventory reply with deadline %s", async deadline => {
    const { frame, exchanges, commands } = await openThroughProxy(6000, deadline);
    expect(frame.error).toBeUndefined();
    expect(frame.result).toMatchObject({ thread: { id: "native-session" } });
    expect(exchanges.map(request => request.type)).toEqual(["tool_inventory"]);
    expect(commands).not.toContain("prompt");
  }, 15_000);

  it("returns the private timeout outcome after the configured deadline, with one exchange and no prompt", async () => {
    const { frame, exchanges, commands } = await openThroughProxy(1000, "200");
    expect(frame.error).toMatchObject({ code: -32000, message: "Pi private request timed out" });
    expect(exchanges.map(request => request.type)).toEqual(["tool_inventory"]);
    expect(commands).not.toContain("prompt");
  });

  it.each(["30000", "30001", "60000"])("rejects deadline %s at or beyond the facade receive wait before native admission", async deadline => {
    const { frame, exchanges, commands } = await openThroughProxy(0, deadline);
    expect(frame.error).toMatchObject({ code: -32000, message: expect.stringContaining("pi_admission_deadline_invalid") });
    expect(exchanges).toEqual([]);
    expect(commands).toEqual([]);
  });
});
