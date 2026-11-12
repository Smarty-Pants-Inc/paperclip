import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";

// Keep reason: L15's silent-inference/long-tool failure paths need an actual Pi
// process as well as unit replay. Local deterministic inference needs no keys.
// PI_TEST_BINARY selects the pinned Pi runtime; no live provider is contacted.
describe.skipIf(!process.env.PI_TEST_BINARY)("L15 with native Pi and local inference", () => {
  it.each(["silent-inference", "silent-bash"] as const)("preserves the conversation after %s", async scenario => {
    const root = await mkdtemp(join(tmpdir(), "pi-idle-native-"));
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const agent = join(root, "agent"); await mkdir(agent);
    // Match the admitted runtime's real subagent liveness registration. No
    // children are requested; the extension must still prove idle for rebind.
    await writeFile(join(agent, "settings.json"), JSON.stringify({ extensions: [createRequire(import.meta.url).resolve("pi-subagents")],
      compaction: { enabled: false }, retry: { enabled: false } }));
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        ++requests;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (requests === 1 && scenario === "silent-inference") {
          response.flushHeaders(); // Deliberately no tokens or native tools.
          return;
        }
        const tool = requests === 1 && scenario === "silent-bash";
        const chunks = tool ? [
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "silent-native-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "sleep 1", timeout: 5 }) } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ] : [
          { choices: [{ index: 0, delta: { content: "native conversation continues" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } },
        ];
        for (const chunk of chunks) response.write(`data: ${JSON.stringify({ id: `faux-${requests}`, object: "chat.completion.chunk", ...chunk })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("local inference did not bind");
    let session: PiRpcHarnessSession | undefined;
    let drained: Promise<void> | undefined;
    let primaryFailure: unknown;
    const events: PrpEvent[] = [];
    try {
      session = await new PiRpcDriver({ command: process.env.PI_TEST_BINARY, model: "paperclip/faux", piRpcThinkingLevel: "off",
        runtimeDirectory: join(root, "sessions"), turnIdleTimeoutMs: 200, shutdownTimeoutMs: 1000,
        environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agent, PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`,
          PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      }).openSession({ runId: "native-l15", normalizedSessionId: "native-l15", workingDirectory: workspace }) as PiRpcHarnessSession;
      drained = (async () => { for await (const event of session!.events()) events.push(event); })();
      const pid = session.processPid(), ids = session.ids(), snapshot = await session.snapshot();
      const first = await session.startTurn({ message: { role: "user", text: scenario } });
      await expect.poll(() => events.find(event => event.turnId === first.turnId && /^turn\.(completed|failed|cancelled)$/.test(event.eventType)), { timeout: 10_000 })
        .toMatchObject(scenario === "silent-inference" ? { eventType: "turn.failed", payload: { error: { code: "pi_turn_idle_timeout" } } } : { eventType: "turn.completed" });
      if (scenario === "silent-bash") {
        expect(events.some(event => event.eventType === "tool.execution.started")).toBe(true);
        expect(events.some(event => event.eventType === "turn.failed")).toBe(false);
      }
      const next = await session.startTurn({ message: { role: "user", text: "next real native turn" } });
      await expect.poll(() => events.find(event => event.turnId === next.turnId && event.eventType === "turn.completed"), { timeout: 10_000 }).toBeDefined();
      expect(session.processExited()).toBe(false); expect(session.processPid()).toBe(pid); expect(session.ids()).toEqual(ids);
      expect((await session.snapshot()).sessionFile).toBe(snapshot.sessionFile);
      expect(events.some(event => event.eventType === "session.failed")).toBe(false);
      if (process.env.PI_IDLE_PROOF_DIR) {
        await mkdir(process.env.PI_IDLE_PROOF_DIR, { recursive: true });
        await writeFile(join(process.env.PI_IDLE_PROOF_DIR, `${scenario}.json`), JSON.stringify({
          scenario, source: "Pi 1.5.2 process, local deterministic SSE inference, real native bash when requested; no live provider",
          idleTimeoutMs: 200, nativeBashCommand: scenario === "silent-bash" ? "sleep 1" : null,
          pidBefore: pid, pidAfter: session.processPid(), idsBefore: ids, idsAfter: session.ids(),
          sessionFileBefore: snapshot.sessionFile, sessionFileAfter: (await session.snapshot()).sessionFile,
          providerRequests: requests, events,
        }, null, 2) + "\n");
      }
    } catch (error) {
      primaryFailure = error;
      console.error(JSON.stringify({ scenario, events }));
      throw error;
    } finally {
      try {
        try { await session?.close(); }
        catch (error) { if (!primaryFailure) throw error; console.error("Native cleanup also failed:", error); }
        await drained;
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
    }
  }, 30_000);
});
