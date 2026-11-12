// Keep: real Pi 1.5.2 first-selection/extension-registration boundary. H8C caught
// config limits/caps being replaced; no fake Pi, prompts, keys, or upstream calls.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createPiProviderBinding } from "../acpx/pi-provider-loopback.js";
import { sendPiBindRequest } from "./pi-bind-protocol.js";
import { loadPiBuiltinModelCatalog, mergedPiModelsJson, piManagedModelFromSnapshot } from "./pi-models-merge.js";
import { PiRpcTransport } from "./pi-rpc-transport.js";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";

const binary = process.env.PI_TEST_BINARY;
const output = process.env.PI_MANAGED_MODEL_OUT;
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native managed model proof deadline")), 15000); })]); }
  finally { clearTimeout(timer); }
}

it.skipIf(!binary || !output)("real Pi preserves snapshot caps/catalog limits on first selection and warm rebind", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-proof-"));
  await mkdir(output!, { recursive: true });
  const catalog = await loadPiBuiltinModelCatalog(binary!, { PATH: process.env.PATH });
  expect(catalog).toBeDefined();
  const matches = catalog!.getBuiltinProviders().flatMap(provider => catalog!.getBuiltinModels(provider).filter(model => model.id === "claude-opus-5-5"));
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.every(model => model.contextWindow === 1000000 && model.maxTokens === 128000 && model.reasoning)).toBe(true);
  const extension = fileURLToPath(new URL("./extension/index.ts", import.meta.url));
  const version = JSON.parse(await readFile(join(dirname(dirname(dirname(binary!))), "package.json"), "utf8")).version;
  expect(version).toBe("1.5.2");
  const report: Record<string, any> = { root, version, binary, binarySha256: hash(binary!), extension, extensionSha256: hash(extension), cases: [], catalog: matches, status: "running" };
  const cases = [
    { name: "catalog-uncapped", id: "claude-opus-5-5", snapshot: {}, thinking: "max", effective: "max", contextWindow: 1000000, maxTokens: 128000 },
    { name: "cross-provider-cap", id: "claude-opus-5-5", snapshot: { providers: { "cliproxyapi-anthropic": { api: "anthropic-messages", baseUrl: "http://127.0.0.1:2", apiKey: "fixture-not-a-key", models: [{ id: "claude-opus-5-5", thinkingLevelMap: { max: null } }] } } }, thinking: "max", effective: "xhigh", contextWindow: 1000000, maxTokens: 128000 },
    { name: "config-limit-override", id: "claude-opus-5-5", snapshot: { providers: { "cliproxyapi-anthropic": { models: [{ id: "claude-opus-5-5", contextWindow: 333333, maxTokens: 64000 }] } } }, thinking: "max", effective: "max", contextWindow: 333333, maxTokens: 64000 },
    { name: "managed-entry-precedence", id: "claude-opus-5-5", snapshot: { providers: { paperclip: { baseUrl: "http://127.0.0.1:2", apiKey: "must-be-replaced", models: [{ id: "claude-opus-5-5", contextWindow: 444444, thinkingLevelMap: { max: null } }] }, "cliproxyapi-anthropic": { models: [{ id: "claude-opus-5-5", contextWindow: 555555 }] } } }, thinking: "max", effective: "xhigh", contextWindow: 444444, maxTokens: 128000 },
    { name: "unknown-defaults", id: "unknown-pi-managed-proof", snapshot: {}, thinking: "off", effective: "off", contextWindow: 128000, maxTokens: 8192 },
  ] as const;
  try {
    for (const item of cases) {
      const directory = join(root, item.name), agent = join(directory, "agent"), workspace = join(directory, "workspace");
      await mkdir(agent, { recursive: true }); await mkdir(workspace); await chmod(directory, 0o700);
      const file = join(agent, "models.json");
      await writeFile(file, JSON.stringify(item.snapshot));
      await writeFile(join(output!, `${item.name}-snapshot.json`), JSON.stringify(item.snapshot, null, 2));
      const environment = { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none" };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const metadata = await piManagedModelFromSnapshot(file, `paperclip/${item.id}`, binary!, environment);
      const diagnostics = warn.mock.calls.map(call => String(call[0])); warn.mockRestore();
      expect(diagnostics.length).toBe(item.name === "unknown-defaults" ? 1 : 0);
      expect(diagnostics.every(line => line.length <= 256 && !line.includes("\n"))).toBe(true);
      const first = await createPiProviderBinding({ model: `paperclip/${item.id}`, environment, thinkingLevel: item.effective, modelConfiguration: metadata });
      const { name, ...configuration } = first.provider;
      const generated = await mergedPiModelsJson(file, JSON.stringify({ providers: { [name]: configuration } }));
      await writeFile(file, generated, { mode: 0o600 });
      const disk = JSON.parse(generated);
      expect(disk.providers.paperclip.models[0]).toMatchObject({ id: item.id, contextWindow: item.contextWindow, maxTokens: item.maxTokens });
      expect(disk.providers.paperclip.baseUrl).toBe(first.provider.baseUrl);
      expect(disk.providers.paperclip.apiKey).toBe(first.provider.apiKey);
      const sessionId = `proof-${item.name}`, socketPath = join(directory, "bind.sock");
      const initial = { schema: 1, sessionId, epoch: 1, runId: "first", model: `paperclip/${item.id}`, thinkingLevel: item.effective, instructions: "", tools: [] };
      const native = new PiRpcTransport({ command: binary!, cwd: workspace, shutdownTimeoutMs: 1000, killTimeoutMs: 1000,
        args: ["--mode", "rpc", "--no-approve", "--no-themes", "--no-extensions", "--extension", extension, "--session", join(directory, "session.jsonl"), "--model", initial.model, "--thinking", item.thinking],
        env: { PATH: process.env.PATH, HOME: directory, TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PAPERCLIP_PI_BIND_SOCKET: socketPath, PAPERCLIP_PI_BIND_INITIAL: JSON.stringify(initial) },
      });
      const events: unknown[] = [];
      const collected = (async () => { for await (const event of native.events()) events.push(event); })();
      let second: Awaited<ReturnType<typeof createPiProviderBinding>> | undefined;
      const proof: Record<string, any> = { name: item.name, requestedThinking: item.thinking, expectedThinking: item.effective, metadata, diagnostics, pid: native.pid, disk: disk.providers.paperclip, directory, status: "running" };
      report.cases.push(proof);
      try {
        const state = (await bounded(native.request("get_state"))).data as any;
        proof.first = state;
        expect(state.model).toMatchObject({ id: item.id, provider: "paperclip", contextWindow: item.contextWindow, maxTokens: item.maxTokens, reasoning: item.name !== "unknown-defaults" });
        expect(state.thinkingLevel).toBe(item.effective);
        expect(state.model.baseUrl).toBe(first.provider.baseUrl);
        // Rotate only the capability; the exact resolved descriptor must survive.
        second = await createPiProviderBinding({ model: initial.model, environment, thinkingLevel: item.effective, modelConfiguration: metadata });
        proof.bind = await sendPiBindRequest(socketPath, { schema: 1, type: "bind", nonce: "warm-proof", sessionId, expectedPriorEpoch: 1, epoch: 2, runId: "warm", model: initial.model, thinkingLevel: item.effective, instructions: "", tools: [], provider: second.provider });
        const warm = (await bounded(native.request("get_state"))).data as any;
        proof.warm = warm;
        expect(warm.model).toEqual({ ...state.model, baseUrl: second.provider.baseUrl });
        expect(warm.thinkingLevel).toBe(item.effective);
        expect(warm.sessionId).toBe(state.sessionId);
        expect(native.pid).toBe(proof.pid);
        proof.status = "passed";
      } catch (error) { proof.status = "failed"; proof.error = String(error); throw error; }
      finally {
        await native.close(); await collected;
        await second?.close(); await first.close();
        expect(native.exited).toBe(true);
        proof.exit = native.exitInfo;
        await writeFile(join(output!, `${item.name}-records.json`), JSON.stringify(events, null, 2));
        await writeFile(join(output!, `${item.name}-proof.json`), JSON.stringify(proof, null, 2));
      }
    }
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = String(error); throw error; }
  finally { await writeFile(join(output!, "report.json"), JSON.stringify(report, null, 2)); }
}, 120000);

it.skipIf(!binary || !output)("the real native driver retains the resolved snapshot across a settled turn and attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-driver-managed-proof-"));
  const agent = join(root, "agent"), workspace = join(root, "workspace");
  await mkdir(agent); await mkdir(workspace); await mkdir(output!, { recursive: true });
  // The source is ONLY the other provider, exactly like the agent-home snapshot.
  await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { "cliproxyapi-anthropic": { baseUrl: "http://127.0.0.1:2", apiKey: "never-route-here", api: "anthropic-messages", models: [{ id: "claude-opus-5-5", thinkingLevelMap: { max: null } }] } } }));
  const requests: unknown[] = [];
  const peer = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [{ choices: [{ index: 0, delta: { content: "local managed proof" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }]) res.write(`data: ${JSON.stringify({ id: `proof-${requests.length}`, object: "chat.completion.chunk", ...chunk })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(done => peer.listen(0, "127.0.0.1", done));
  const address = peer.address(); if (!address || typeof address === "string") throw new Error("local proof peer failed");
  let native: PiRpcTransport | undefined, session: PiRpcHarnessSession | undefined;
  const proof: Record<string, any> = { root, evidenceLevel: "real_dependency_with_controlled_loopback_peer", upstreamRequests: requests, status: "running" };
  try {
    session = await new PiRpcDriver({ command: binary!, model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "xhigh", runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 15000,
      environment: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      transportFactory: options => { native = new PiRpcTransport(options); return native; },
    }).openSession({ runId: "first", normalizedSessionId: "managed-driver-proof", workingDirectory: workspace }) as PiRpcHarnessSession;
    const pid = session.processPid(); proof.pid = pid;
    proof.first = (await bounded(native!.request("get_state"))).data;
    proof.disk = JSON.parse(await readFile(join(agent, "models.json"), "utf8"));
    expect(proof.disk.providers.paperclip.models[0]).toMatchObject({ contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinkingLevelMap: { max: null, xhigh: "xhigh" } });
    const events = session.events()[Symbol.asyncIterator]();
    proof.events = [];
    for (const runId of ["first", "warm"]) {
      if (runId === "warm") await session.attachRun({ runId });
      const state = (await bounded(native!.request("get_state"))).data as any;
      expect(state.model).toMatchObject({ provider: "paperclip", id: "claude-opus-5-5", contextWindow: 1000000, maxTokens: 128000, reasoning: true, thinkingLevelMap: { max: null, xhigh: "xhigh" } });
      expect(state.thinkingLevel).toBe("xhigh");
      expect(session.processPid()).toBe(pid);
      if (runId === "warm") proof.warm = state;
      await session.startTurn({ message: { role: "user", text: "Return the local fixture reply." } });
      for (;;) {
        const next = await bounded(events.next()); if (next.done) throw new Error("native proof stream ended");
        proof.events.push(next.value);
        if (next.value.eventType === "turn.failed") throw new Error(JSON.stringify(next.value));
        if (next.value.eventType === "turn.completed") break;
      }
    }
    expect(requests).toHaveLength(2);
    expect(proof.warm.model.baseUrl).not.toBe(proof.first.model.baseUrl);
    proof.status = "passed";
  } catch (error) { proof.status = "failed"; proof.error = String(error); throw error; }
  finally {
    await session?.close();
    peer.closeAllConnections(); await new Promise<void>(done => peer.close(() => done()));
    proof.childExited = native?.exited; expect(native?.exited).toBe(true);
    await writeFile(join(output!, "driver-proof.json"), JSON.stringify(proof, null, 2));
  }
}, 60000);
