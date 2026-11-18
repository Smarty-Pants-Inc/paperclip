// Keep: 1b'' real Pi 1.5.2 config-cap admission regression. Reuses R7's
// actual-driver/local-loopback proof, with max requested (not pre-lowered).
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";
import { probePiNativeEnvironment } from "./pi-environment-probe.js";

const binary = process.env.PI_TEST_BINARY;
const output = process.env.PI_THINKING_ADMISSION_OUT;
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native thinking admission proof deadline")), 15000); })]); }
  finally { clearTimeout(timer); }
}
it.skipIf(!binary || !output).each([true, false])("real Pi max request completes initial/warm turns (config cap=%s)", async capped => {
  const name = capped ? "capped" : "uncapped";
  const root = await mkdtemp(join(tmpdir(), `pi-max-${name}-`));
  const agent = join(root, "agent"), workspace = join(root, "workspace");
  await mkdir(agent); await mkdir(workspace); await mkdir(output!, { recursive: true });
  const snapshot = capped ? { providers: { "cliproxyapi-anthropic": { baseUrl: "http://127.0.0.1:2", apiKey: "never-route-here", api: "anthropic-messages", models: [{ id: "claude-opus-5-5", thinkingLevelMap: { max: null } }] } } } : {};
  await writeFile(join(agent, "models.json"), JSON.stringify(snapshot));
  const version = JSON.parse(await readFile(join(dirname(dirname(dirname(binary!))), "package.json"), "utf8")).version;
  expect(version).toBe("1.5.2");
  const requests: unknown[] = [], records: PiRpcRecord[] = [], pids: number[] = [];
  const peer = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of [{ choices: [{ index: 0, delta: { content: "local max admission proof" }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }]) res.write(`data: ${JSON.stringify({ id: `proof-${requests.length}`, object: "chat.completion.chunk", ...chunk })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(done => peer.listen(0, "127.0.0.1", done));
  const address = peer.address(); if (!address || typeof address === "string") throw new Error("local proof peer failed");
  let native: PiRpcTransport | undefined, session: PiRpcHarnessSession | undefined;
  const proof: Record<string, any> = { name, root, version, binary, binarySha256: createHash("sha256").update(readFileSync(binary!)).digest("hex"),
    evidenceLevel: "real_dependency_with_controlled_loopback_peer", requested: "max", expected: capped ? "xhigh" : "max", snapshot, upstreamRequests: requests, pids, states: [], events: [], status: "running" };
  try {
    const driver = new PiRpcDriver({ command: binary!, model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "max", runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 15000,
      environment: { PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      transportFactory: options => { native = new PiRpcTransport(options); if (native.pid) pids.push(native.pid); const stream = native.events.bind(native); native.events = () => ({ async *[Symbol.asyncIterator]() { for await (const event of stream()) { records.push(structuredClone(event)); yield event; } } }); return native; },
    });
    session = await driver.openSession({ runId: "first", normalizedSessionId: `max-${name}-proof`, workingDirectory: workspace }) as PiRpcHarnessSession;
    proof.pid = session.processPid();
    proof.disk = JSON.parse(await readFile(join(agent, "models.json"), "utf8"));
    const events = session.events()[Symbol.asyncIterator]();
    for (const runId of ["first", "warm"]) {
      if (runId === "warm") await session.attachRun({ runId });
      await session.revalidateAfterClaim(); await session.reconnect();
      const state = (await bounded(native!.request("get_state"))).data as any;
      proof.states.push(state);
      expect(state.model).toMatchObject({ provider: "paperclip", id: "claude-opus-5-5", contextWindow: 1000000, maxTokens: 128000 });
      expect(state.thinkingLevel).toBe(proof.expected);
      expect(await session.snapshot()).toMatchObject({ piRpcThinkingLevel: proof.expected });
      expect(session.processPid()).toBe(proof.pid);
      const turn = await session.startTurn({ message: { role: "user", text: "Return the local fixture reply." } });
      for (;;) {
        const next = await bounded(events.next());
        if (next.done) throw new Error("Pi event stream ended before terminal");
        proof.events.push(next.value);
        if (["turn.failed", "session.failed"].includes(next.value.eventType)) throw new Error(JSON.stringify(next.value));
        if (next.value.eventType === "turn.completed" && next.value.turnId === turn.turnId) break;
      }
    }
    expect(requests).toHaveLength(2);
    expect(proof.states[1].model.baseUrl).not.toBe(proof.states[0].model.baseUrl);
    expect(proof.events.filter((event: any) => event.eventType === "turn.completed")).toHaveLength(2);
    expect(proof.events.filter((event: any) => event.eventType === "turn.started").every((event: any) => event.payload.context.piRpcThinkingLevel === proof.expected)).toBe(true);
    expect(proof.events.find((event: any) => event.eventType === "session.started")).toMatchObject({ payload: { context: { piRpcThinkingLevel: proof.expected } } });
    const diagnostics = proof.events.filter((event: any) => event.payload.code === "pi_thinking_lowered_by_config");
    expect(diagnostics).toHaveLength(capped ? 1 : 0);
    if (capped) expect(diagnostics[0].payload).toMatchObject({ code: "pi_thinking_lowered_by_config", requested: "max", effective: "xhigh", message: 'pi_thinking_lowered_by_config {"requested":"max","effective":"xhigh"}' });
    await session.close();
    proof.originalChildExited = native!.exited;
    expect(proof.originalChildExited).toBe(true);
    // The ordinary setup Test must not re-refuse the same admitted cap.
    proof.probe = await probePiNativeEnvironment({ driver, config: { provider: "pi_rpc", model: "paperclip/claude-opus-5-5", piRpcThinkingLevel: "max" },
      runId: "probe", normalizedSessionId: `max-${name}-hello`, workingDirectory: workspace, timeoutMs: 15000 });
    expect(proof.probe).toMatchObject({ helloProbePassed: true, piRpcThinkingLevel: proof.expected });
    expect(requests).toHaveLength(3);
    proof.status = "passed";
  } catch (error) { proof.status = "failed"; proof.error = String(error); throw error; }
  finally {
    await session?.close();
    peer.closeAllConnections(); await new Promise<void>(done => peer.close(() => done()));
    proof.childExited = native?.exited;
    await writeFile(join(output!, `${name}-records.json`), JSON.stringify(records, null, 2));
    await writeFile(join(output!, `${name}-proof.json`), JSON.stringify(proof, null, 2));
    if (native) expect(native.exited).toBe(true);
  }
}, 60000);
