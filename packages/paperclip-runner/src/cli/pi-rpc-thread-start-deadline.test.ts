import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPiRpcAppServerProxy } from "./pi-rpc-app-server-proxy.js";
import { PiRpcDriver } from "../drivers/pi/pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "../drivers/pi/pi-rpc-transport.js";
import type { PiBindCommand } from "../drivers/pi/pi-bind-protocol.js";
import { createCapabilityRunnerdProviderEnvironment } from "../live/runnerd-codex-transport.js";

// Keep reason: runner-core's facade waits 30 s (Duration::from_secs(30) in
// CodexProvider::request_classified_until) for the proxy's thread/start reply.
// Gate 2 run d63e01ed saw only the facade's generic "Codex thread/start
// response timed out". The proxy's own named startup deadline, carrying the
// phase it expired in, must answer inside that window instead. Real timers,
// production proxy config; only the external Pi is a fake.
const FACADE_RECEIVE_WAIT_MS = 30_000;

function runnerEnvironment(root: string) {
  return createCapabilityRunnerdProviderEnvironment({
    provider: "pi_rpc", model: "paperclip/faux",
    options: { provider: "pi_rpc", piRpcThinkingLevel: "off", piRuntimeDirectory: join(root, "sessions"), environment: {
      PI_CODING_AGENT_DIR: join(root, "agent"),
      PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1",
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer",
      PAPERCLIP_AI_PROVIDER_KEY: "thread-start-deadline-test-only",
    } },
    identity: { runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1", normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1" },
    codexHome: root, runtimeContextPath: join(root, "context.json"), hasRuntimeContext: false,
  });
}

/** Every admission exchange answers inside its own 10 s bound; together they exceed the facade wait. */
class SlowAdmissionTransport {
  closed = false;
  exited = false;
  pid = null;
  ready = Promise.resolve();
  commands: string[] = [];
  wake?: () => void;
  timers = new Set<ReturnType<typeof setTimeout>>();
  async request(type: string) {
    await this.ready;
    this.commands.push(type);
    const model = { provider: "paperclip", id: "faux" };
    // The first get_state is the process-startup exchange; answer it promptly.
    if (this.commands.length > 1) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 9_000); this.timers.add(timer); });
    return { success: true, data: type === "get_state"
      ? { sessionId: "native-session", model, thinkingLevel: "off", isStreaming: false, isCompacting: false, pendingMessageCount: 0 }
      : type === "set_model" ? model
      : type === "get_available_thinking_levels" ? { levels: ["off"] }
      : type === "get_available_models" ? { models: [model] } : undefined };
  }
  async *events(): AsyncIterable<PiRpcRecord> {
    while (!this.closed) await new Promise<void>(resolve => { this.wake = resolve; });
  }
  async close() { this.closed = this.exited = true; for (const timer of this.timers) clearTimeout(timer); this.wake?.(); }
}

async function threadStart(fakePi: "silent-process" | "slow-admission") {
  const root = await mkdtemp(join(tmpdir(), "pi-thread-start-deadline-"));
  // A real spawned Pi stand-in that reads its RPC stdin and never answers get_state.
  const silentPi = join(root, "silent-pi");
  await writeFile(silentPi, "#!/bin/sh\nexec cat >/dev/null\n");
  await chmod(silentPi, 0o700);
  const sockets = new Set<Socket>();
  const peer = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.endsWith("\n")) return;
      const request = JSON.parse(buffer) as PiBindCommand;
      socket.end(`${JSON.stringify(request.type === "tool_inventory" ? { ...request, nativeTools: [] } : { ...request, ack: true })}\n`);
    });
  });
  const slow = new SlowAdmissionTransport();
  let complete!: (frame: PiRpcRecord) => void;
  const reply = new Promise<PiRpcRecord>(resolve => { complete = resolve; });
  const proxy = createPiRpcAppServerProxy({
    environment: runnerEnvironment(root),
    stdout: { write(chunk) { const frame = JSON.parse(chunk); if (frame.id === 1) complete(frame); return true; }, once() {} },
    createDriver: config => new PiRpcDriver({ ...config, transportFactory: options => {
      if (fakePi === "silent-process") return new PiRpcTransport({ ...options, command: silentPi, args: [], commandFd: undefined });
      slow.ready = new Promise<void>((resolve, reject) => {
        peer.once("error", reject); peer.listen(options.env!.PAPERCLIP_PI_BIND_SOCKET!, resolve);
      });
      return slow as unknown as PiRpcTransport;
    } }),
  });
  let facadeTimer: ReturnType<typeof setTimeout> | undefined;
  const startedAt = Date.now();
  try {
    proxy.acceptLine(JSON.stringify({ id: 1, method: "thread/start", params: { cwd: root, model: "paperclip/faux", piRpcThinkingLevel: "off" } }));
    const frame = await Promise.race([reply, new Promise<"facade response timed out">(resolve => {
      facadeTimer = setTimeout(() => resolve("facade response timed out"), FACADE_RECEIVE_WAIT_MS);
    })]);
    return { frame, elapsedMs: Date.now() - startedAt, commands: [...slow.commands] };
  } finally {
    if (facadeTimer) clearTimeout(facadeTimer);
    await proxy.close();
    await proxy.endInput();
    await slow.close();
    for (const socket of sockets) socket.destroy();
    if (peer.listening) await new Promise<void>(resolve => peer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

describe("production Pi proxy thread/start deadline inside the facade's 30 s wait", () => {
  it("names the first get_state phase when a spawned Pi never answers, before the facade wait", async () => {
    const { frame, elapsedMs } = await threadStart("silent-process");
    expect(frame).not.toBe("facade response timed out");
    expect(frame).toMatchObject({ id: 1, error: { code: -32000,
      message: expect.stringMatching(/^pi_startup_deadline: .*phase first_get_state/u),
      data: { code: "pi_startup_deadline", phase: "first_get_state" } } });
    expect(elapsedMs).toBeLessThan(FACADE_RECEIVE_WAIT_MS);
  }, 45_000);

  it("names the thread/start phase when admission exchanges each answer in time but together outlast the window", async () => {
    const { frame, elapsedMs, commands } = await threadStart("slow-admission");
    expect(frame).not.toBe("facade response timed out");
    expect(frame).toMatchObject({ id: 1, error: { code: -32000,
      message: expect.stringMatching(/^pi_startup_deadline: .*phase thread_start/u),
      data: { code: "pi_startup_deadline", phase: "thread_start" } } });
    expect(elapsedMs).toBeLessThan(FACADE_RECEIVE_WAIT_MS);
    expect(commands).not.toContain("prompt");
  }, 45_000);
});
