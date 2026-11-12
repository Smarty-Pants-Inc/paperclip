import { createServer } from "node:http";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport } from "./pi-rpc-transport.js";

// expected-skip: PI_TEST_BINARY unset: real Pi smoke uses a local SSE peer, never a paid provider.
// Keep reason: release canary across native Pi's queued-input/settlement boundary.
describe.skipIf(!process.env.PI_TEST_BINARY)("real Pi RPC active-turn steering", () => {
  it("consumes steer once with the same process, session, run and turn after the current response boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-real-steer-"));
    let releaseFirst = () => {};
    const requests: unknown[] = [];
    const commands: Array<{ type: string; params: unknown }> = [];
    const events: PrpEvent[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        const sequence = requests.length;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta: unknown, finish_reason: string | null) => response.write(`data: ${JSON.stringify({ id: `steer-reply-${sequence}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        chunk({ content: sequence === 1 ? "Initial response." : "Steering input consumed." }, null);
        const finish = () => { if (!response.writableEnded) { chunk({}, "stop"); response.end("data: [DONE]\n\n"); } };
        if (sequence === 1) releaseFirst = finish;
        else finish();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("local steering peer did not bind");
    let session: PiRpcHarnessSession | undefined;
    let pump: Promise<void> | undefined;
    try {
      session = await new PiRpcDriver({
        command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"),
        environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), HOME: root, PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
        transportFactory: options => {
          const transport = new PiRpcTransport(options);
          const request = transport.request.bind(transport);
          transport.request = (type, params) => { commands.push({ type, params }); return request(type, params); };
          return transport;
        },
        shutdownTimeoutMs: 1000,
      }).openSession({ runId: "real-steer-run", normalizedSessionId: "real-steer-session", workingDirectory: root }) as PiRpcHarnessSession;
      const pid = session.processPid();
      const providerSessionId = session.ids().providerSessionId;
      pump = (async () => { for await (const event of session!.events()) events.push(event); })();
      const { turnId } = await session.startTurn({ message: { role: "user", text: "Initial work." } });
      await expect.poll(() => requests.length, { timeout: 10000 }).toBe(1);
      await session.steer!({ turnId, message: { role: "user", text: "real-steering-marker" } });
      const consumed = () => events.filter(event => event.eventType === "item.completed" && event.payload.kind === "userMessage" && event.payload.text === "real-steering-marker");
      expect(consumed()).toEqual([]);
      expect(requests).toHaveLength(1);
      releaseFirst();
      await expect.poll(() => events.some(event => event.eventType === "turn.completed"), { timeout: 10000 }).toBe(true);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain("real-steering-marker");
      expect(consumed()).toHaveLength(1);
      expect(consumed()[0]).toMatchObject({ runId: "real-steer-run", turnId });
      expect(events.filter(event => event.eventType === "turn.started")).toHaveLength(1);
      expect(events.filter(event => event.eventType === "turn.completed")).toHaveLength(1);
      expect(events.every(event => event.runId === "real-steer-run" && event.turnId === turnId)).toBe(true);
      expect(session.processPid()).toBe(pid);
      expect(session.ids().providerSessionId).toBe(providerSessionId);
      expect(commands.filter(command => ["prompt", "steer", "follow_up", "abort"].includes(command.type))).toEqual([
        { type: "prompt", params: { message: "Initial work." } }, { type: "steer", params: { message: "real-steering-marker" } },
      ]);
      if (process.env.PI_STEER_PROOF_PATH) {
        const snapshot = await session.snapshot();
        await copyFile(snapshot.sessionFile, `${process.env.PI_STEER_PROOF_PATH}.session.jsonl`);
        await writeFile(process.env.PI_STEER_PROOF_PATH, JSON.stringify({ source: "real Pi 1.5.2 with a controlled local SSE peer; no live hq or paid provider", binary: process.env.PI_TEST_BINARY, pid, providerSessionId, turnId, commands, requests, events }, null, 2));
      }
    } finally {
      releaseFirst();
      try { await session?.close(); await pump; }
      finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 20000);
});
