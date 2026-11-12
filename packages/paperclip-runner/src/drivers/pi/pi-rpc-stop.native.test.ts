import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

function alive(pid: number): boolean {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z"; }
  catch { return false; }
}
// Explicit real Pi + real bash + native transcript continuity. Scripted loopback
// model, no live LLM/account: not Boat/daily-work acceptance.
describe.skipIf(!process.env.PI_TEST_BINARY || process.platform !== "linux")("real Pi Stop stays warm", () => {
  it("cancels sleep 60, removes its PID, then recalls assistant-only history on the same Pi PID/session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-stop-native-"));
    const fact = `PRIVATE_ASSISTANT_FACT_${randomUUID()}`;
    const command = `echo $$ > ${join(root, "bash.pid")}; sleep 60 & child=$!; echo $child > ${join(root, "sleep.pid")}; wait $child; echo SHOULD_NOT_RUN > ${join(root, "after-stop.txt")}`;
    const requests: Record<string, unknown>[] = [], native: PiRpcRecord[] = [], events: PrpEvent[] = [];
    let server: Server | undefined, session: PiRpcHarnessSession | undefined, drain: Promise<void> | undefined;
    const proof: Record<string, unknown> = { root, binary: process.env.PI_TEST_BINARY, source: "actual driver -> Pi 1.5.2 -> native bash; loopback scripted Anthropic model, no live LLM or Boat" };
    try {
      server = createServer((req, res) => {
        let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const parsed = JSON.parse(body); requests.push(parsed);
          const first = requests.length === 1;
          const recalled = parsed.messages?.some((message: { role: string; content: unknown }) => message.role === "assistant" && JSON.stringify(message.content).includes(fact));
          res.writeHead(200, { "content-type": "text/event-stream" });
          const emit = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          emit("message_start", { message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "faux", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
          emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
          emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: first ? fact : recalled ? `RECALLED ${fact}` : "HISTORY_LOST" } });
          emit("content_block_stop", { index: 0 });
          if (first) {
            emit("content_block_start", { index: 1, content_block: { type: "tool_use", id: "native-stop-sleep", name: "bash", input: {} } });
            emit("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) } });
            emit("content_block_stop", { index: 1 });
          }
          emit("message_delta", { delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
          emit("message_stop", {}); res.end();
        });
      });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("No local model listener");
      await mkdir(join(root, "agent"));
      session = await new PiRpcDriver({ command: process.env.PI_TEST_BINARY!, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"),
        environment: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
        transportFactory: options => { const transport = new PiRpcTransport(options); const records = transport.events.bind(transport); transport.events = async function* () { for await (const record of records()) { native.push(record); yield record; } }; return transport; },
      }).openSession({ runId: "stop-native", normalizedSessionId: "same-conversation", workingDirectory: root }) as PiRpcHarnessSession;
      drain = (async () => { for await (const event of session!.events()) events.push(event); })();
      const piPid = session.processPid()!, nativeSessionId = session.ids().providerSessionId;
      const turn = await session.startTurn({ message: { role: "user", text: "Run the long tool now." } });
      let bashPid = 0, sleepPid = 0;
      await vi.waitFor(() => { bashPid = Number(readFileSync(join(root, "bash.pid"), "utf8")); sleepPid = Number(readFileSync(join(root, "sleep.pid"), "utf8")); expect(alive(bashPid) && alive(sleepPid)).toBe(true); }, { timeout: 15_000, interval: 25 });
      expect(await readFile((await session.snapshot()).sessionFile, "utf8")).toContain(fact);
      const start = performance.now();
      await session.interrupt({ turnId: turn.turnId });
      const cancelMs = performance.now() - start;
      expect(cancelMs).toBeLessThan(2000);
      expect(alive(bashPid)).toBe(false); expect(alive(sleepPid)).toBe(false);
      expect(alive(piPid)).toBe(true); expect(session.processPid()).toBe(piPid); expect(session.ids().providerSessionId).toBe(nativeSessionId);
      expect(events.filter(e => e.turnId === turn.turnId && /^turn\.(cancelled|completed|failed)$/.test(e.eventType))).toMatchObject([{ eventType: "turn.cancelled" }]);
      await session.attachRun({ runId: "after-stop-native" });
      const next = await session.startTurn({ message: { role: "user", text: "Recall the private fact from your own previous assistant history." } });
      await vi.waitFor(() => expect(events.some(e => e.turnId === next.turnId && e.eventType === "turn.completed")).toBe(true), { timeout: 15_000 });
      expect(events.some(e => e.turnId === next.turnId && e.eventType === "item.completed" && String(e.payload.text).includes(`RECALLED ${fact}`))).toBe(true);
      expect(session.processPid()).toBe(piPid); expect(session.ids().providerSessionId).toBe(nativeSessionId); expect(alive(piPid)).toBe(true);
      expect(requests).toHaveLength(2); expect(JSON.stringify(requests[1]!.messages)).toContain(fact);
      expect(JSON.stringify((requests[1]!.messages as Array<{ role: string; content: unknown }>).filter(m => m.role === "user"))).not.toContain(fact);
      const snapshot = await session.snapshot();
      Object.assign(proof, { pass: true, cancelMs, piPidBefore: piPid, piPidAfter: session.processPid(), nativeSessionIdBefore: nativeSessionId, nativeSessionIdAfter: session.ids().providerSessionId, bashPid, sleepPid, bashAlive: alive(bashPid), sleepAlive: alive(sleepPid), sessionFile: snapshot.sessionFile, assistantHistoryRecalled: true });
      await expect(readFile(join(root, "after-stop.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } catch (error) { proof.error = error instanceof Error ? error.stack : String(error); throw error; }
    finally {
      await session?.close(); await drain;
      if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
      const out = process.env.PI_STOP_PROOF_DIR ?? root; await mkdir(out, { recursive: true });
      await writeFile(join(out, "real-pi-proof.json"), JSON.stringify(proof, null, 2) + "\n");
      await writeFile(join(out, "real-pi-native.jsonl"), native.map(record => JSON.stringify(record)).join("\n") + "\n");
      await writeFile(join(out, "real-pi-host-events.jsonl"), events.map(record => JSON.stringify(record)).join("\n") + "\n");
      await writeFile(join(out, "real-pi-model-requests.json"), JSON.stringify(requests, null, 2) + "\n");
    }
  }, 45_000);
});
