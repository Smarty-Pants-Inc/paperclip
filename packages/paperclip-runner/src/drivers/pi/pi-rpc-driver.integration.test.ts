import { createServer, type Server } from "node:http";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";

const binary = process.env.PI_TEST_BINARY;
const integration = Boolean(binary);
const servers: Server[] = [];

async function fakeOpenAiServer(requiredKey?: string): Promise<{ server: Server; url: string; requests: string[] }> {
  let sequence = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    if (requiredKey && request.headers.authorization !== `Bearer ${requiredKey}`) {
      response.writeHead(401).end();
      return;
    }
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
  it("fails closed on unknown credential modes before spawning Pi", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-pi-rpc-mode-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const driver = new PiRpcDriver({
      runtimeDirectory: join(root, "sessions"),
      environment: { PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "unexpected" },
      transportFactory: () => { throw new Error("Pi must not spawn in an unknown credential mode"); },
    });
    try {
      await expect(driver.openSession({ runId: "mode-test", normalizedSessionId: "mode-test", workingDirectory: workspace }))
        .rejects.toThrow("PAPERCLIP_PI_RPC_CREDENTIAL_MODE must be broker|env");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps one Pi child and provider session alive across two completed turns", async () => {
    const realKey = "managed-provider-key-canary";
    const { url, requests } = await fakeOpenAiServer(realKey);
    const root = await mkdtemp(join(tmpdir(), "paperclip-pi-rpc-proof-"));
    const workspace = join(root, "workspace");
    const agentDirectory = join(root, "pi-agent");
    await mkdir(workspace);
    await mkdir(agentDirectory);

    const driver = new PiRpcDriver({
      command: binary!,
      model: "paperclip/faux",
      runtimeDirectory: join(root, "sessions"),
      environment: {
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_OFFLINE: "1",
        PAPERCLIP_AI_PROVIDER_URL: url,
        PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat",
        PAPERCLIP_AI_PROVIDER_AUTH: "bearer",
        PAPERCLIP_AI_PROVIDER_KEY: realKey,
      },
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
      const modelsPath = join(agentDirectory, "models.json");
      const modelsText = await readFile(modelsPath, "utf8");
      expect(modelsText).not.toContain(realKey);
      const models = JSON.parse(modelsText) as { providers: { paperclip: { baseUrl: string; apiKey: string } } };
      expect(models.providers.paperclip.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/u);
      expect(models.providers.paperclip.apiKey).not.toBe(realKey);
      const secretSurfaces = [
        await readFile(`/proc/${pidBeforeTurn1}/cmdline`, "utf8"),
        await readFile(`/proc/${pidBeforeTurn1}/environ`, "utf8"),
        modelsText,
        await readFile(snapshot.sessionFile, "utf8"),
      ];
      expect(secretSurfaces.filter(surface => surface.includes(realKey))).toEqual([]);
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
      const modelsPath = join(agentDirectory, "models.json");
      let provider: { baseUrl: string; apiKey: string } | undefined;
      try { provider = (JSON.parse(await readFile(modelsPath, "utf8")) as { providers: { paperclip: { baseUrl: string; apiKey: string } } }).providers.paperclip; } catch { /* startup may fail before configuration */ }
      await session?.close();
      expect(session?.processExited()).toBe(true);
      if (provider) {
        // After close the session capability is refused: the loopback listener is gone.
        const refused = await fetch(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: "faux", messages: [] }),
        }).then(response => response.status === 401, () => true);
        expect(refused).toBe(true);
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
