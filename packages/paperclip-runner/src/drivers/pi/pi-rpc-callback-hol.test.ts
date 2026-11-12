import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: the recorded 130-call callback refusal, through real Pi's default
// parallel execution, native announcement join, and the real driver/Unix IPC.
// PI_TEST_BINARY must be the pinned Pi 1.5.2 CLI; no model or org credentials.
describe.skipIf(!process.env.PI_TEST_BINARY)("Pi callback head-of-line real-runtime regression", () => {
  beforeAll(async () => {
    // Match this test's explicit driver startup budget. This extra admission
    // probe is not a tool-call or host-execution timeout.
    const { stdout } = await promisify(execFile)(process.env.PI_TEST_BINARY!, ["--version"], { timeout: 30000 });
    expect(stdout.trim()).toBe("1.5.2");
  }, 45000);
  it.each(["after-batch", "same-batch"] as const)("finishes %s with 130 ordinary tools and no refused callbacks", async placement => {
    const root = await mkdtemp(join(tmpdir(), "pi-hol-"));
    const proofRoot = process.env.PI_HOL_PROOF_DIR ?? root;
    await mkdir(proofRoot, { recursive: true });
    await mkdir(join(root, "workspace"));
    const requests: Record<string, any>[] = [];
    const nativeRecords: PiRpcRecord[] = [];
    const announcedAt = new Map<string, number>();
    const completedAt = new Map<string, number>();
    let nativeInFlight = 0, maxNativeInFlight = 0;
    const dispatches: Array<{ id: string; tool: string; atMs: number; queueMs: number; endMs?: number }> = [];
    const errors: Array<{ id: unknown; result: unknown }> = [];
    let active = 0, maxActive = 0, ordinaryActive = 0, maxOrdinaryActive = 0;
    let batchEmittedAt = 0, finishEmittedAt = 0;
    const startedAt = performance.now();
    const ordinary = Array.from({ length: 130 }, (_, i) => ({ index: i, id: `ordinary-${i}`, type: "function", function: { name: "hol_work", arguments: "{}" } }));
    const finish = { index: placement === "same-batch" ? 130 : 0, id: "finish", type: "function", function: { name: "paperclip_finish", arguments: "{}" } };
    const server = createServer((request, response) => {
      let body = ""; request.setEncoding("utf8"); request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        const n = requests.length;
        const calls = n === 1 ? [...ordinary, ...(placement === "same-batch" ? [finish] : [])] : n === 2 && placement === "after-batch" ? [finish] : undefined;
        if (n === 1) batchEmittedAt = performance.now();
        if (calls?.some(call => call.id === "finish")) finishEmittedAt = performance.now();
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunks = calls ? [{ delta: { tool_calls: calls }, finish_reason: null }, { delta: {}, finish_reason: "tool_calls" }] : [{ delta: { content: "all callbacks completed" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }];
        for (const choice of chunks) response.write(`data: ${JSON.stringify({ id: `hol-response-${n}`, object: "chat.completion.chunk", choices: [{ index: 0, ...choice }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("HTTP bind failed");
    let session: PiRpcHarnessSession | undefined;
    const events: PrpEvent[] = [];
    try {
      session = await new PiRpcDriver({
        command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off",
        runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 30_000, shutdownTimeoutMs: 1000,
        dynamicTools: ["hol_work", "paperclip_finish"].map(name => ({ name, description: name, inputSchema: { type: "object", properties: {} } })),
        dynamicToolHandler: async call => {
          active++; maxActive = Math.max(maxActive, active);
          if (call.tool !== "paperclip_finish") { ordinaryActive++; maxOrdinaryActive = Math.max(maxOrdinaryActive, ordinaryActive); }
          const at = performance.now();
          const row = { id: call.callId, tool: call.tool, atMs: at - startedAt, queueMs: at - (announcedAt.get(call.callId) ?? at), endMs: undefined as number | undefined };
          dispatches.push(row);
          try {
            await new Promise<void>(resolve => setTimeout(resolve, 200));
            call.signal.throwIfAborted();
            return { content: [{ type: "text", text: `HOST_OK_${call.callId}` }], details: {} };
          } finally { row.endMs = performance.now() - startedAt; active--; if (call.tool !== "paperclip_finish") ordinaryActive--; }
        },
        environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: join(root, "agent"), PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "local-faux-only" },
        transportFactory: options => {
          const transport = new PiRpcTransport(options);
          const stream = transport.events.bind(transport);
          transport.events = () => ({ async *[Symbol.asyncIterator]() {
            for await (const event of stream()) {
              nativeRecords.push(structuredClone(event));
              if (event.type === "tool_execution_start") {
                announcedAt.set(String(event.toolCallId), performance.now());
                maxNativeInFlight = Math.max(maxNativeInFlight, ++nativeInFlight);
              }
              if (event.type === "tool_execution_end") {
                --nativeInFlight;
                if (event.isError) errors.push({ id: event.toolCallId, result: event.result });
                else completedAt.set(String(event.toolCallId), performance.now());
              }
              yield event;
            }
          } });
          return transport;
        },
      }).openSession({ runId: `hol-${placement}`, normalizedSessionId: `hol-${placement}`, workingDirectory: join(root, "workspace") }) as PiRpcHarnessSession;
      const iterator = session.events()[Symbol.asyncIterator]();
      await session.startTurn({ message: { role: "user", text: "exercise the callback batch and finish" } });
      for (;;) {
        const event = await iterator.next();
        if (event.done) throw new Error("early driver close");
        events.push(event.value);
        if (event.value.eventType === "turn.failed" || event.value.eventType === "turn.cancelled") throw new Error(JSON.stringify(event.value));
        if (event.value.eventType === "turn.completed") break;
      }
      const finishDispatch = dispatches.find(row => row.id === "finish");
      const proof = {
        runtime: "@earendil-works/pi-coding-agent@1.5.2", placement, hostRoundTripMs: 200,
        ordinaryCalls: 130, totalCalls: 131, dispatched: dispatches.length, refused: errors.length,
        maxActive, maxOrdinaryActive, maxNativeInFlight, nativeCompleted: completedAt.size,
        // Includes native preflight/scheduling and Unix IPC: an upper bound on
        // server queueing, not a claim to isolate pure queue residence time.
        maxNativeToHostQueueMs: Math.max(...dispatches.map(row => row.queueMs)),
        batchToCompletionMs: performance.now() - batchEmittedAt,
        finishLatencyMs: completedAt.has("finish") ? completedAt.get("finish")! - finishEmittedAt : null,
        finishQueueMs: finishDispatch?.queueMs ?? null, finishCompleted: completedAt.has("finish"),
        errors, dispatches, events,
      };
      await writeFile(join(proofRoot, `${placement}.json`), `${JSON.stringify(proof, null, 2)}\n`);
      await writeFile(join(proofRoot, `${placement}.native.jsonl`), nativeRecords.map(record => JSON.stringify(record)).join("\n") + "\n");
      await writeFile(join(proofRoot, `${placement}.requests.json`), JSON.stringify(requests, null, 2));
      const snapshot = await session.snapshot();
      await writeFile(join(proofRoot, `${placement}.session.jsonl`), await readFile(snapshot.sessionFile, "utf8"));
      console.log(`PI_HOL_MEASUREMENT ${JSON.stringify({ ...proof, dispatches: undefined, errors: undefined, events: undefined })}`);
      expect(errors, "native callback refusals").toEqual([]);
      expect(dispatches).toHaveLength(131);
      expect(completedAt.size).toBe(131);
      expect(nativeInFlight).toBe(0);
      expect(maxNativeInFlight).toBeGreaterThan(8);
      expect(finishDispatch?.endMs).toBeDefined();
      expect(proof.finishLatencyMs).toBeLessThan(10_000);
      expect(proof.maxOrdinaryActive).toBeLessThanOrEqual(8);
    } finally {
      try { await session?.close(); }
      finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    expect(session.processExited()).toBe(true);
  }, 45_000);
});
