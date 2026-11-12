import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";

const binary = process.env.PI_TEST_BINARY;
const integration = Boolean(binary);
const servers: Server[] = [];

async function fakeOpenAiServer(): Promise<{ server: Server; url: string; requests: string[] }> {
  let sequence = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: string | Array<{ type?: string; text?: string }> }> };
      const content = parsed.messages?.at(-1)?.content;
      requests.push(Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content ?? "");
      sequence += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`data: ${JSON.stringify({ id: `fake-${sequence}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `local faux reply ${sequence}` }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: `fake-${sequence}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake OpenAI server did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}/v1`, requests };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe.skipIf(!integration)("PiRpcDriver local faux-provider proof", () => {
  it("keeps one Pi child and provider session alive across two completed turns", async () => {
    const { url, requests } = await fakeOpenAiServer();
    const root = await mkdtemp(join(tmpdir(), "paperclip-pi-rpc-proof-"));
    const workspace = join(root, "workspace");
    const agentDirectory = join(root, "pi-agent");
    await mkdir(workspace);
    await mkdir(agentDirectory);
    await writeFile(join(agentDirectory, "models.json"), JSON.stringify({
      "$schema": "https://pi.dev/schemas/models.schema.json",
      providers: {
        localFaux: {
          baseUrl: url,
          api: "openai-completions",
          apiKey: "local-only-not-a-real-model-key",
          models: [{ id: "faux", name: "local faux", contextWindow: 8192, maxTokens: 256 }],
        },
      },
    }));
    const driver = new PiRpcDriver({
      command: binary!,
      model: "localFaux/faux",
      runtimeDirectory: join(root, "sessions"),
      environment: { PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" },
      shutdownTimeoutMs: 1000,
    });
    let session: PiRpcHarnessSession | null = null;
    try {
      session = await driver.openSession({ runId: "pi-proof", normalizedSessionId: "pi-proof-session", workingDirectory: workspace }) as PiRpcHarnessSession;
      const pidBeforeTurn1 = session.processPid();
      const sessionId = session.ids().providerSessionId;
      const iterator = session.events()[Symbol.asyncIterator]();
      const measurements: Array<{ turn: number; firstEventMs: number; completedMs: number }> = [];
      let pidAfterTurn1: number | null = null;
      let pidAfterTurn2: number | null = null;
      let sessionIdAfterTurn1: string | null | undefined;
      let sessionIdAfterTurn2: string | null | undefined;
      for (const [index, prompt] of ["return the first faux reply", "return the second faux reply"].entries()) {
        const turn = index + 1;
        const startedAt = performance.now();
        const start = session.startTurn({ message: { role: "user", text: prompt } });
        const first = await iterator.next();
        const firstEventMs = performance.now() - startedAt;
        expect(first.value?.eventType).toBe("turn.started");
        const { turnId } = await start;
        let completed = false;
        const turnEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
        while (!completed) {
          const next = await iterator.next();
          if (next.done) throw new Error("Pi event stream closed before terminal turn event");
          if (next.value.turnId !== turnId) continue;
          turnEvents.push(next.value);
          completed = next.value.eventType === "turn.completed";
          if (["turn.failed", "turn.cancelled"].includes(next.value.eventType)) throw new Error(`Pi turn ${next.value.eventType}: ${JSON.stringify(next.value.payload)}`);
        }
        expect(turnEvents.some((event) => event.eventType === "item.completed" && event.payload.kind === "agentMessage" && event.payload.text === `local faux reply ${turn}`)).toBe(true);
        expect(turnEvents.some((event) => event.eventType === "item.completed" && event.payload.kind === "usage")).toBe(true);
        measurements.push({ turn, firstEventMs, completedMs: performance.now() - startedAt });
        const currentPid = session.processPid();
        const currentSessionId = session.ids().providerSessionId;
        expect(currentPid).toBe(pidBeforeTurn1);
        expect(currentSessionId).toBe(sessionId);
        if (turn === 1) { pidAfterTurn1 = currentPid; sessionIdAfterTurn1 = currentSessionId; }
        else { pidAfterTurn2 = currentPid; sessionIdAfterTurn2 = currentSessionId; }
      }
      expect(requests).toEqual(["return the first faux reply", "return the second faux reply"]);
      const snapshot = await session.snapshot();
      expect(snapshot.providerSessionId).toBe(sessionId);
      expect(snapshot.sessionFile).toBeTruthy();
      expect((await stat(snapshot.sessionFile)).size).toBeGreaterThan(0);
      const sessionCopyPath = process.env.PI_SESSION_COPY_PATH;
      if (sessionCopyPath) await copyFile(snapshot.sessionFile, sessionCopyPath);
      const proof = {
        source: "Pi 1.5.2 RPC child with a local faux OpenAI-compatible streaming server; no real model key",
        command: binary,
        samePid: true,
        pids: { beforeTurn1: pidBeforeTurn1, afterTurn1: pidAfterTurn1, afterTurn2: pidAfterTurn2 },
        sessionIds: [sessionId, sessionIdAfterTurn1, sessionIdAfterTurn2],
        sessionFile: sessionCopyPath ?? snapshot.sessionFile,
        snapshotSessionFile: snapshot.sessionFile,
        turns: measurements,
        replies: ["local faux reply 1", "local faux reply 2"],
      };
      const proofPath = process.env.PI_PROOF_PATH;
      if (proofPath) await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
      expect(proof.samePid).toBe(true);
    } finally {
      await session?.close();
      expect(session?.processExited()).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
