import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane, PrpWireConnection, TransportCloseReason } from "../control-plane/durable-prp-control-plane.js";
import { createRunnerdCodexTransport } from "./runnerd-codex-transport.js";

// Recorded incident: smarty-dev#20202, Clone L L3. Actual runnerd, production
// proxy and Pi 1.5.2; only the loopback model and ingress endpoint are fixtures.
// No external model, account credentials, or daily-work acceptance is claimed.
const pack = process.env.PI_IDLE_INGRESS_PACK;
const runner = process.env.PAPERCLIP_RUNNER_BINARY;
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback port");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

type OwnedSocket = { close(): void };
// A no-extension RFC6455 client, like the existing release/resume fixture.
// Node's global WebSocket requests extensions that runnerd deliberately refuses.
function openWire(port: number, path: string): Promise<{ wire: PrpWireConnection; socket: OwnedSocket }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: {
      Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    } });
    request.on("error", reject);
    request.on("response", response => { response.resume(); reject(new Error("loopback ingress upgrade refused")); });
    request.setTimeout(1_000, () => request.destroy(new Error("loopback ingress timeout")));
    request.on("upgrade", (_response, socket, head) => {
      request.setTimeout(0);
      let buffer = Buffer.alloc(0), listener: ((value: unknown) => void) | undefined;
      let reason: TransportCloseReason | undefined;
      const pending: unknown[] = [], closed = new Set<(reason: TransportCloseReason) => void>();
      const send = (opcode: number, payload: Buffer) => {
        const mask = randomBytes(4), bytes = Buffer.from(payload);
        for (let index = 0; index < bytes.length; index++) bytes[index] ^= mask[index % 4]!;
        const header = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65_536 ? 4 : 10);
        header[0] = 0x80 | opcode;
        if (header.length === 2) header[1] = 0x80 | payload.length;
        else if (header.length === 4) { header[1] = 0xfe; header.writeUInt16BE(payload.length, 2); }
        else { header[1] = 0xff; header.writeBigUInt64BE(BigInt(payload.length), 2); }
        socket.write(Buffer.concat([header, mask, bytes]));
      };
      const consume = (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          let length = buffer[1]! & 0x7f, offset = 2;
          if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
          else if (length === 127) {
            if (buffer.length < 10) return;
            const size = buffer.readBigUInt64BE(2);
            if (size > 4_194_304n) { socket.destroy(); return; }
            length = Number(size); offset = 10;
          }
          if (buffer.length < offset + length) return;
          const opcode = buffer[0]! & 0x0f, payload = buffer.subarray(offset, offset + length);
          buffer = buffer.subarray(offset + length);
          if (opcode === 8) { socket.destroy(); return; }
          if (opcode === 9) { send(10, payload); continue; }
          if (opcode !== 1) continue;
          const value: unknown = JSON.parse(payload.toString("utf8"));
          if (listener) listener(value); else pending.push(value);
        }
      };
      socket.on("data", consume); socket.on("error", () => {});
      socket.on("close", () => {
        reason = { message: "loopback ingress closed" };
        for (const receive of closed) receive(reason);
      });
      resolve({ socket: { close: () => socket.destroy() }, wire: {
        sendJson: value => send(1, Buffer.from(JSON.stringify(value))), close: () => socket.destroy(),
        onJson: receive => { listener = receive; for (const value of pending.splice(0)) receive(value); },
        onClose: receive => { if (reason) receive(reason); else closed.add(receive); },
      } });
      consume(head);
    });
    request.end();
  });
}

it.skipIf(!pack || !runner)("reopens an idle ingress before close, then cold-recovers Pi-only memory on the same native session", async () => {
  const root = await mkdtemp(join(process.env.PI_IDLE_INGRESS_EVIDENCE ?? tmpdir(), "pi-idle-ingress-"));
  const privateFact = `PI_ONLY_${randomUUID()}`;
  const requests: Array<{ phase: number; remembers: boolean; userHasFact: boolean }> = [];
  const events: unknown[] = [], diagnostics: string[] = [];
  let phase = 1;
  const model = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const messages = parsed.messages as Array<{ role: string; content: unknown }>;
      const remembers = messages.some(message => message.role === "assistant" && JSON.stringify(message.content).includes(privateFact));
      const userHasFact = messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(privateFact));
      requests.push({ phase, remembers, userHasFact });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: "idle-proof", object: "chat.completion.chunk", model: "faux", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: "assistant", content: phase === 1 ? `Private fact: ${privateFact}` : remembers ? `Recalled: ${privateFact}` : "PRIVATE FACT MISSING" }, null);
      emit({}, "stop"); response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelAddress = model.address();
  if (!modelAddress || typeof modelAddress === "string") throw new Error("missing model port");
  const agentDirectory = join(root, "pi-agent"), workspace = join(root, "workspace");
  await mkdir(agentDirectory); await mkdir(workspace);
  await writeFile(join(agentDirectory, "models.json"), JSON.stringify({ providers: { paperclip: {
    baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`, api: "openai-completions", apiKey: "local-only-no-credentials",
    models: [{ id: "faux", name: "faux", contextWindow: 16384, maxTokens: 256 }],
  } } }));
  const executable = join(pack!, "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const node = join(pack!, "node_modules/node/bin/node");
  const proxy = join(pack!, "dist/cli/pi-rpc-app-server-proxy.cjs");
  for (const path of [runner!, executable, node, proxy]) expect(existsSync(path), path).toBe(true);
  const stateDirectory = join(root, "runner-state");
  const sockets = new Set<OwnedSocket>();
  let active: OwnedSocket | undefined, authority: DurablePrpControlPlane | undefined;
  let reopens = 0;
  const create = (runId: string) => createRunnerdCodexTransport({
    provider: "pi_rpc", runnerBinary: runner!, stateDirectory, sourceCodexHome: "",
    providerNodeCommand: node, providerNodeCommandSha256: digest(node),
    piCommand: executable, piCommandSha256: digest(executable), piProxyPath: proxy, piProxySha256: digest(proxy),
    piRuntimeDirectory: join(root, "pi-runtime"), piRpcThinkingLevel: "off",
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 3_600_000 }, closeGraceMs: 10_000,
    prpIdentity: { runnerInstanceId: "idle-runner", environmentLeaseId: "idle-lease", runId,
      normalizedSessionId: "idle-native-session", turnId: `turn-${runId}`, itemId: `item-${runId}` },
    environment: { PATH: process.env.PATH, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDirectory,
      PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${modelAddress.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none",
      PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker" },
    onDiagnostic: message => diagnostics.push(message),
    controlPlaneRegistration: async core => {
      authority = core;
      const port = await freePort(), path = `/api/runner/v1/connect/${runId}`;
      const connect = async (deadline: number, signal?: AbortSignal) => {
        while (Date.now() < deadline && !signal?.aborted) {
          try {
            const peer = await openWire(port, path);
            if (signal?.aborted) { peer.socket.close(); throw new Error("ingress reopen cancelled"); }
            sockets.add(peer.socket); active = peer.socket;
            const attachment = core.attachWireConnection(peer.wire);
            await vi.waitFor(() => expect(attachment.isAuthenticated()).toBe(true), { timeout: Math.max(1, deadline - Date.now()), interval: 10 });
            return;
          } catch (error) {
            if (Date.now() >= deadline || signal?.aborted) throw error;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        throw new Error("ingress reopen deadline exceeded");
      };
      return {
        connection: { mode: "listen" as const, listenAddress: "0.0.0.0" as const, listenPort: port, listenPath: path },
        activate: () => connect(Date.now() + 5_000),
        // Existing authenticated route, never another process or identity.
        ensureConnected: async ({ deadline, signal }: { deadline: number; signal: AbortSignal }) => {
          if (core.activeRunnerConnectionCount() === 1) return;
          reopens++; await connect(deadline, signal);
        },
        release: () => { for (const socket of sockets) socket.close(); },
      };
    },
  });
  const first = create("first");
  let second: ReturnType<typeof create> | undefined;
  let nativeSessionId: unknown, nextSessionId: unknown;
  const turn = async (bundle: ReturnType<typeof create>, text: string) => {
    const iterator = bundle.transport.notifications()[Symbol.asyncIterator]();
    await bundle.transport.request("turn/start", { input: [{ type: "text", text }] });
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw new Error("native turn stream ended");
      events.push(next.value);
      if (next.value.method === "turn/failed") throw new Error(JSON.stringify(next.value));
      if (next.value.method === "turn/completed") return;
    }
  };
  let failure: unknown;
  try {
    const opened = await first.transport.request("thread/start", { cwd: workspace, model: "paperclip/faux", baseInstructions: "Reply briefly.", dynamicTools: [] });
    nativeSessionId = (opened.thread as { sessionId: string }).sessionId;
    await turn(first, "Remember a private fact in your response.");
    await new Promise(resolve => setTimeout(resolve, Number(process.env.PI_IDLE_INGRESS_IDLE_MS ?? 100)));
    expect(authority!.activeRunnerConnectionCount()).toBe(1);
    active!.close();
    await vi.waitFor(() => expect(authority!.activeRunnerConnectionCount()).toBe(0));
    // The next-turn admission retires the idle warm owner before cold recovery.
    await first.transport.close("next turn retires idle owner");
    expect(reopens).toBe(1);
    phase = 2; second = create("second");
    const recovered = await second.transport.request("thread/read", {});
    nextSessionId = (recovered.thread as { sessionId: string }).sessionId;
    expect(nextSessionId).toBe(nativeSessionId);
    await turn(second, "Recall the earlier private fact. It is not in this request.");
    expect(requests.at(-1)).toMatchObject({ phase: 2, remembers: true, userHasFact: false });
    await second.transport.close();
    expect(first.evidence().runnerExited).toBe(true);
    expect(second.evidence().runnerExited).toBe(true);
  } catch (error) { failure = error; throw error; }
  finally {
    await first.transport.close().catch(() => undefined);
    await second?.transport.close().catch(() => undefined);
    for (const socket of sockets) socket.close();
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await writeFile(join(root, "proof.json"), JSON.stringify({ root, status: failure ? "failed" : "passed", error: String(failure ?? ""), nativeSessionId, nextSessionId,
      reopens, requests, diagnostics, first: first.evidence(), second: second?.evidence(), events,
      idleMs: Number(process.env.PI_IDLE_INGRESS_IDLE_MS ?? 100), fault: "controller-originated ingress socket closed after idle; automatic fixture reconnect disabled" }, null, 2));
    console.log(`Idle ingress evidence retained at ${root}`);
  }
}, 60_000);
