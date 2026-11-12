import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// expected-skip: missing PI_TEST_BINARY: requires the installed native Pi 1.5.2 runtime.
// Keep reason: release canary across the real driver/Pi/broker/private-bind boundary.
// Only the upstream model is scripted. No production-org or browser acceptance is claimed.
describe.skipIf(!process.env.PI_TEST_BINARY)("native Pi manual compaction", () => {
  it("runs two turns, compacts, then a third in the same PID and JSONL with a real compaction entry", async () => {
    const binary = process.env.PI_TEST_BINARY!;
    const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
    expect(version).toBe("1.5.2");
    const root = process.env.PI_COMPACTION_OUT ?? await mkdtemp(join(tmpdir(), "pi-compact-native-"));
    await mkdir(root, { recursive: true });
    const workspace = join(root, "workspace"), home = join(root, "agent");
    await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.json"), JSON.stringify({ retry: { enabled: false }, cacheWarming: "off", compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 } }));
    const requests: Record<string, any>[] = [];
    const peer = createServer((req, res) => {
      let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        const n = requests.length;
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of [{ choices: [{ index: 0, delta: { content: `Kept decision ${n}: native Pi compaction preserves session identity.` }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100 + n, completion_tokens: 12, total_tokens: 112 + n } }]) {
          res.write(`data: ${JSON.stringify({ id: `compact-receipt-${n}`, object: "chat.completion.chunk", ...chunk })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>(resolve => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address(); if (!address || typeof address === "string") throw new Error("peer not bound");
    let session: PiRpcHarnessSession | undefined;
    const raw: PiRpcRecord[] = [], rpc: Array<{ type: string; params: unknown }> = [], events: PrpEvent[] = [];
    const states: unknown[] = [];
    try {
      session = await new PiRpcDriver({ command: binary, runtimeDirectory: join(root, "sessions"), model: "paperclip/faux", piRpcThinkingLevel: "off", shutdownTimeoutMs: 1000,
        environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: home, PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
        transportFactory: options => {
          const native = new PiRpcTransport(options);
          const request = native.request.bind(native);
          native.request = (type, params, options) => { rpc.push({ type, params }); return request(type, params, options); };
          const source = native.events.bind(native);
          native.events = () => ({ async *[Symbol.asyncIterator]() { for await (const event of source()) { raw.push(event); yield event; } } });
          return native;
        },
      }).openSession({ runId: "compact-proof", normalizedSessionId: "compact-proof", workingDirectory: workspace }) as PiRpcHarnessSession;
      const pid = session.processPid(), id = session.ids().providerSessionId;
      const first = await session.snapshot();
      const iterator = session.events()[Symbol.asyncIterator]();
      async function turn(n: number) {
        const started = await session!.startTurn({ message: { role: "user", text: `Decision ${n}: preserve the native Pi conversation; answer briefly without tools.` } });
        for (;;) {
          const next = await iterator.next(); if (next.done) throw new Error("native event stream ended");
          events.push(next.value);
          if (next.value.turnId !== started.turnId) continue;
          if (["turn.failed", "turn.cancelled"].includes(next.value.eventType)) throw new Error(JSON.stringify(next.value));
          if (next.value.eventType === "turn.completed") break;
        }
        const snapshot = await session!.snapshot();
        states.push({ n, pid: session!.processPid(), ...snapshot });
        expect(session!.processPid()).toBe(pid); expect(session!.ids().providerSessionId).toBe(id); expect(snapshot.sessionFile).toBe(first.sessionFile);
      }
      await turn(1); await turn(2);
      const turnsBefore = rpc.filter(call => call.type === "prompt").length;
      const result = await session.compact({ customInstructions: "Retain decisions about session identity." });
      expect(rpc.filter(call => call.type === "prompt")).toHaveLength(turnsBefore);
      states.push({ phase: "compacted", pid: session.processPid(), ...await session.snapshot() });
      await turn(3);
      expect(rpc.filter(call => call.type === "compact")).toHaveLength(1);
      expect(rpc.filter(call => call.type === "prompt")).toHaveLength(3);
      expect(events.filter(event => event.eventType === "turn.started")).toHaveLength(3);
      expect(events.filter(event => event.eventType === "turn.completed")).toHaveLength(3);
      expect(events.filter(event => event.eventType === "context.compacted")).toHaveLength(1);
      expect(raw.filter(event => event.type === "compaction_start")).toHaveLength(1);
      expect(raw.filter(event => event.type === "compaction_end")).toHaveLength(1);
      const sessionText = await readFile(first.sessionFile, "utf8");
      const entries = sessionText.trim().split("\n").map(line => JSON.parse(line));
      expect(entries.filter(entry => entry.type === "compaction")).toHaveLength(1);
      expect(entries.find(entry => entry.type === "compaction")).toMatchObject({ summary: result.summary });
      await session.close();
      expect(session.processExited()).toBe(true);
      await writeFile(join(root, "proof.json"), JSON.stringify({ binary, version, pid, providerSessionId: id, sessionFile: first.sessionFile,
        sessionSha256: createHash("sha256").update(sessionText).digest("hex"), states, result, upstreamRequests: requests.length, exited: session.processExited() }, null, 2));
      console.log(`PI_COMPACTION_PROOF ${join(root, "proof.json")}`);
    } finally {
      await session?.close();
      peer.closeAllConnections(); await new Promise<void>(resolve => peer.close(() => resolve()));
      await Promise.all([["native.jsonl", raw], ["rpc.jsonl", rpc], ["events.jsonl", events], ["upstream.jsonl", requests]].map(([file, rows]) => writeFile(join(root, file as string), (rows as unknown[]).map(row => JSON.stringify(row)).join("\n") + "\n")));
    }
  }, 60_000);
});
