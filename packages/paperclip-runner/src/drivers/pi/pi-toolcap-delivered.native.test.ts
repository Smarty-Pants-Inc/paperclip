import { createServer } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import names from "./fixtures/d981-dynamic-tool-names.json";

// Recorded catch: d981 lost core actions downstream of discovery. Assert the
// provider's DELIVERED catalog, not a bootstrap file or a versioned IPC fixture.
// Frozen round-2 regression: run these exact bytes on 4d30b7f1 and the repair.
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const core = names.filter(name => !name.startsWith("app_"));
const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });
const connections = Array.from({ length: 200 }, (_, i) => ({ ...tool(`app_${String(i).padStart(3, "0")}`),
  paperclipToolSource: { kind: "connection", connectionId: `connection-${String(i).padStart(3, "0")}`, connectionName: `App ${i}`,
    installedAt: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString() } }));

describe.skipIf(!process.env.PI_TEST_BINARY)("delivered native tool catalog", () => {
  it.each(["chat", "messages"] as const)("retains every core action with 200 connections on %s", async protocol => {
    expect(core).toHaveLength(61);
    const requests: Array<Record<string, any>> = [];
    const server = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (protocol === "messages") {
          for (const event of [
            { type: "message_start", message: { id: "delivered", type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          res.end();
        } else {
          for (const chunk of [
            { choices: [{ index: 0, delta: { content: "Done" }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
          ]) res.write(`data: ${JSON.stringify({ id: "delivered", object: "chat.completion.chunk", ...chunk })}\n\n`);
          res.end("data: [DONE]\n\n");
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const root = await mkdtemp(join(tmpdir(), "pi-delivered-")); const workspace = join(root, "workspace"); await mkdir(workspace);
    const port = (server.address() as { port: number }).port;
    const session = await new PiRpcDriver({ command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off",
      runtimeDirectory: join(root, "sessions"), shutdownTimeoutMs: 1000,
      dynamicTools: [...connections, ...core.map(name => ({ ...tool(name), paperclipToolSource: { kind: "core" } }))],
      environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${port}/v1`,
        PAPERCLIP_AI_PROVIDER_PROTOCOL: protocol, PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    }).openSession({ runId: "delivered", normalizedSessionId: "delivered", workingDirectory: workspace }) as PiRpcHarnessSession;
    cleanups.push(() => session.close());
    const iterator = session.events()[Symbol.asyncIterator]();
    await session.startTurn({ message: { role: "user", text: "Say done. Do not call tools." } });
    for (;;) {
      const next = await iterator.next(); if (next.done) throw new Error("event stream ended");
      if (["turn.completed", "turn.failed", "turn.cancelled"].includes(next.value.eventType)) {
        expect(next.value.eventType, JSON.stringify(next.value.payload)).toBe("turn.completed"); break;
      }
    }
    expect(requests).toHaveLength(1);
    const delivered = requests[0]!.tools as Array<{ name?: string; function?: { name: string } }>;
    const deliveredNames = delivered.map(entry => entry.function?.name ?? entry.name);
    // Keep this first: base must fail for missing core, not merely a wrong count.
    expect(deliveredNames).toEqual(expect.arrayContaining(core));
    const external = deliveredNames.filter(name => name?.startsWith("app_"));
    const nativeCount = delivered.length - external.length - core.length;
    expect(nativeCount).toBeGreaterThan(0);
    if (protocol === "chat") {
      expect(delivered).toHaveLength(128);
      expect(external).toEqual(connections.slice(0, 128 - nativeCount - core.length).map(entry => entry.name));
    } else {
      expect(external).toEqual(connections.map(entry => entry.name));
      expect(delivered).toHaveLength(261 + nativeCount);
    }
  }, 60_000);
});
