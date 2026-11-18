// Opt-in regression: actual pinned Pi -> managed Messages broker -> real local
// HTTP/SSE peer. Capture BOTH settled turns before asserting compat, so baseline
// RED evidence includes the legacy enabled/budget wire, not just missing config.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";

const binary = process.env.PI_TEST_BINARY;
const output = process.env.PI_COMPAT_OUT;
const modelId = "claude-opus-5-5";
const compat = {
  forceAdaptiveThinking: true,
  supportsMidConvoEffort: true,
  supportsMidConvoSystemMessages: true,
  // Distinctive false value: losing it cannot pass by inheriting Pi's defaults.
  supportsLongCacheRetention: false,
};
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const jsonl = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");

function nativeIdentity(pid: number | null) {
  if (pid === null) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, pgid: Number(fields[2]), start: fields[19], stat };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function bounded<T>(label: string, operation: Promise<T>, milliseconds = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Pi compat ${label} deadline (${milliseconds}ms)`)), Math.max(1, milliseconds));
    })]);
  } finally { clearTimeout(timer); }
}

function assertUnder(root: string, path: string) {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("PI_COMPAT_OUT must be under TMPDIR");
}

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  raw: string;
  body?: any;
  rawSse: string;
  error?: string;
};

it.skipIf(!binary || !output)("real Pi 1.5.2 preserves original-HOME Anthropic compat on initial and same-process warm wire", async () => {
  // All generated paths are retained beneath the caller's TMPDIR. Never remove
  // fixtures/evidence, even on RED; only production session.close owns its IPC.
  const temporary = await realpath(tmpdir());
  const destination = isAbsolute(output!) ? output! : join(process.cwd(), output!);
  assertUnder(temporary, destination);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const retained = await realpath(destination);
  assertUnder(temporary, retained);
  const root = await mkdtemp(join(retained, "pi-compat-"));
  const home = join(root, "home", "user");
  const runtime = join(root, "run"), agent = join(runtime, "agent"), workspace = join(root, "workspace");
  const userFile = join(home, ".pi", "agent", "models.json");
  const modelsFile = join(agent, "models.json");
  await mkdir(dirname(userFile), { recursive: true });
  await mkdir(agent, { recursive: true });
  await mkdir(workspace);
  const userBytes = Buffer.from(json({ providers: { "cliproxyapi-anthropic": {
    api: "anthropic-messages", baseUrl: "http://127.0.0.1:2", apiKey: "fixture-not-a-key",
    models: [{ id: modelId, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, compat }],
  } } }));
  const runtimeBytes = Buffer.from('{"providers":{}}\n');
  await writeFile(userFile, userBytes, { mode: 0o600 });
  await writeFile(modelsFile, runtimeBytes, { mode: 0o600 });
  await writeFile(join(root, "original-user-models.before.json"), userBytes);
  await writeFile(join(root, "runtime-models.before.json"), runtimeBytes);
  const requests: CapturedRequest[] = [], events: unknown[] = [], records: PiRpcRecord[] = [], commands: unknown[] = [];
  const turns: Array<Record<string, any>> = [];
  const cleanupErrors: string[] = [];
  const proof: Record<string, any> = {
    root, home, runtime, agent, workspace, userFile, modelsFile, binary,
    evidenceLevel: "real_dependency_with_controlled_loopback_peer",
    model: `paperclip/${modelId}`, requestedThinking: "xhigh", expectedCompat: compat,
    runtimeSnapshotBefore: JSON.parse(runtimeBytes.toString()),
    userSnapshotBefore: JSON.parse(userBytes.toString()), turns, cleanupErrors,
    traceContract: "complete observed RPC records and command results; native session JSONL; complete HTTP requests and SSE responses",
    status: "running",
  };
  const peer = createServer((request, response) => {
    const captured: CapturedRequest = { method: request.method, url: request.url,
      headers: { ...request.headers }, rawHeaders: [...request.rawHeaders], raw: "", rawSse: "" };
    requests.push(captured); // Also retain an incomplete/aborted request.
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { captured.raw += chunk; });
    request.on("error", error => { captured.error = String(error); response.destroy(); });
    request.on("end", () => {
      try {
        captured.body = JSON.parse(captured.raw);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, fields: Record<string, unknown>) => {
          const bytes = `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
          captured.rawSse += bytes;
          response.write(bytes);
        };
        event("message_start", { message: { id: `compat-local-${requests.length}`, type: "message", role: "assistant", model: modelId,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: `local compat reply ${requests.length}` } });
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
        event("message_stop", {});
        response.end();
      } catch (error) {
        captured.error = String(error);
        response.writeHead(400); response.end("invalid local fixture request");
      }
    });
  });
  peer.requestTimeout = 10_000;
  peer.headersTimeout = 10_000;
  let native: PiRpcTransport | undefined, session: PiRpcHarnessSession | undefined;
  let failure: unknown;
  let sessionFile: string | undefined;
  // Shared work deadline bounds an endless sequence of nonterminal events too;
  // cleanup has its own bounds and the Vitest timeout leaves room for both.
  const deadline = Date.now() + 60_000;
  const operation = <T>(label: string, pending: Promise<T>) => bounded(label, pending, Math.min(12_000, deadline - Date.now()));
  const persist = async () => {
    await writeFile(join(root, "requests.json"), json(requests));
    await writeFile(join(root, "events.jsonl"), jsonl(events));
    await writeFile(join(root, "native-records.jsonl"), jsonl(records));
    await writeFile(join(root, "native-commands.jsonl"), jsonl(commands));
    await writeFile(join(root, "proof.json"), json(proof));
    await writeFile(join(retained, "pi-compat-proof.json"), json(proof));
  };
  vi.stubEnv("HOME", home);
  vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  try {
    expect(process.platform, "exact Linux PID/PGID/start proof required").toBe("linux");
    proof.runnerHasPiAgentDir = Object.hasOwn(process.env, "PI_CODING_AGENT_DIR");
    expect(proof.runnerHasPiAgentDir).toBe(false);
    proof.runnerOriginalHome = process.env.HOME;
    const executable = await realpath(binary!);
    const packageRoot = dirname(dirname(dirname(executable)));
    const aiRoot = join(dirname(packageRoot), "pi-ai");
    proof.executable = executable;
    proof.packageVersion = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
    const version = await operation("real version", promisify(execFile)(executable, ["--version"], {
      timeout: 8_000, cwd: workspace, env: { PATH: process.env.PATH, HOME: home, TMPDIR: temporary, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    }));
    proof.realVersion = version.stdout.trim(); proof.versionStderr = version.stderr;
    expect(proof.realVersion).toBe("1.5.2"); expect(proof.packageVersion).toBe("1.5.2");
    const sourcePaths = [
      executable, join(packageRoot, "package.json"), join(aiRoot, "package.json"),
      join(aiRoot, "dist/api/anthropic-messages.js"), join(packageRoot, "docs/models-configuration.md"),
      ...["./pi-compat.native.test.ts", "./pi-rpc-driver.ts", "./pi-rpc-transport.ts", "./pi-managed-model.ts", "./pi-models-merge.ts",
        "./pi-bind-protocol.ts", "./extension/index.ts", "../acpx/pi-provider-loopback.ts", "../provider-loopback/messages.ts"]
        .map(path => fileURLToPath(new URL(path, import.meta.url))),
    ];
    proof.hashes = sourcePaths.map(path => ({ path, sha256: hash(path) }));
    await operation("peer listen", new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(0, "127.0.0.1", resolve); }));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("local Messages peer failed to bind");
    proof.peerUrl = `http://127.0.0.1:${address.port}`;
    // Explicit host root: Messages adapter appends /v1/messages itself. The
    // original config's dead port/key are capability sources, never routing.
    session = await operation("driver open", new PiRpcDriver({
      command: executable, model: `paperclip/${modelId}`, piRpcThinkingLevel: "xhigh",
      runtimeDirectory: runtime, startupTimeoutMs: 8_000, promptTimeoutMs: 8_000,
      shutdownTimeoutMs: 1_000, killTimeoutMs: 1_000,
      environment: { PATH: process.env.PATH, HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*",
        PAPERCLIP_AI_PROVIDER_URL: proof.peerUrl, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      transportFactory: options => {
        proof.launch = { command: options.command, args: options.args, HOME: options.env?.HOME,
          PI_CODING_AGENT_DIR: options.env?.PI_CODING_AGENT_DIR };
        native = new PiRpcTransport({ ...options, requestTimeoutMs: 8_000 });
        proof.nativeIdentity = nativeIdentity(native.pid);
        const request = native.request.bind(native);
        native.request = async (type, params, requestOptions) => {
          const command: Record<string, unknown> = { type, params, requestOptions };
          commands.push(command);
          try { const result = await request(type, params, requestOptions); command.result = result; return result; }
          catch (error) { command.error = String(error); throw error; }
        };
        const stream = native.events.bind(native);
        native.events = () => ({ async *[Symbol.asyncIterator]() {
          for await (const record of stream()) { records.push(record); yield record; }
        } });
        return native;
      },
    }).openSession({ runId: "first", normalizedSessionId: "compat-native-proof", workingDirectory: workspace,
      signal: AbortSignal.timeout(10_000) })) as PiRpcHarnessSession;
    proof.pid = session.processPid();
    sessionFile = (await operation("session snapshot", session.snapshot())).sessionFile;
    proof.sessionFile = sessionFile;
    const iterator = session.events()[Symbol.asyncIterator]();
    for (const runId of ["first", "warm"]) {
      if (runId === "warm") await operation("warm attach", session.attachRun({ runId }));
      const turn: Record<string, any> = { runId, pid: session.processPid(), nativeIdentity: nativeIdentity(native!.pid) };
      turns.push(turn);
      turn.state = (await operation(`${runId} state`, native!.request("get_state"))).data;
      turn.disk = JSON.parse(await readFile(modelsFile, "utf8"));
      turn.sessionIds = session.ids();
      turn.turn = await operation(`${runId} prompt`, session.startTurn({ message: { role: "user", text: "Return the local fixture reply." } }));
      for (;;) {
        const next = await operation(`${runId} settlement`, iterator.next());
        if (next.done) throw new Error("native compat event stream ended before settlement");
        events.push(next.value);
        if (next.value.eventType === "turn.failed") throw new Error(JSON.stringify(next.value));
        if (next.value.eventType === "turn.completed") { turn.completed = next.value; break; }
      }
      turn.afterState = (await operation(`${runId} settled state`, native!.request("get_state"))).data;
      turn.afterIdentity = nativeIdentity(native!.pid);
      await copyFile(sessionFile, join(root, `${runId}-session.jsonl`));
      await persist();
    }
    // Do not move compat assertions above this point: both real wire turns and
    // warm registration must remain available from the expected RED baseline.
    proof.wireSummary = requests.map(request => ({ thinking: request.body?.thinking,
      output_config: request.body?.output_config, finalMessage: request.body?.messages?.at(-1) }));
    proof.userFileUnchanged = userBytes.equals(await readFile(userFile));
    await persist();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.error).toBeUndefined(); expect(request.method).toBe("POST"); expect(request.url).toBe("/v1/messages?beta=true");
      expect(request.headers.authorization).toBeUndefined(); expect(request.headers["x-api-key"]).toBeUndefined();
      expect(request.body).toMatchObject({ model: modelId, stream: true });
      expect(request.body.thinking.type, "original-HOME compat must reach actual Pi Messages wire").toBe("adaptive");
      expect(request.body.thinking.budget_tokens).toBeUndefined();
      // Pi 1.5.2 fixes top-level effort to low for prefix caching; active effort
      // belongs to the LAST system message, not top-level output_config.
      expect(request.body.output_config).toMatchObject({ effort: "low" });
      expect(request.body.messages.at(-1)).toMatchObject({ role: "system", output_config: { effort: "xhigh" } });
    }
    expect(proof.nativeIdentity).not.toBeNull();
    expect(proof.launch.HOME).toBe(home); expect(proof.launch.PI_CODING_AGENT_DIR).toBe(agent);
    expect(proof.userFileUnchanged).toBe(true);
    for (const turn of turns) {
      expect(turn.pid).toBe(proof.pid);
      const birth = { pid: proof.nativeIdentity.pid, pgid: proof.nativeIdentity.pgid, start: proof.nativeIdentity.start };
      expect(turn.nativeIdentity).toMatchObject(birth);
      expect(turn.afterIdentity).toMatchObject(birth);
      expect(turn.state).toMatchObject({ thinkingLevel: "xhigh", model: { provider: "paperclip", id: modelId, api: "anthropic-messages", compat } });
      expect(turn.afterState).toMatchObject({ thinkingLevel: "xhigh", isStreaming: false });
      expect(turn.disk.providers.paperclip.models[0]).toMatchObject({ id: modelId, compat });
      expect(turn.completed.runId).toBe(turn.runId);
    }
    expect(turns[1].sessionIds).toEqual(turns[0].sessionIds);
    expect(turns[1].state.model.baseUrl).not.toBe(turns[0].state.model.baseUrl);
    expect(turns[1].state.model).toEqual({ ...turns[0].state.model, baseUrl: turns[1].state.model.baseUrl });
    proof.status = "passed";
  } catch (error) { failure = error; proof.status = "failed"; proof.error = String(error); }
  finally {
    // Always close both owners. A failed session close cannot skip native stop,
    // fixture closure, unchanged-user-file evidence, or final artifact writes.
    if (session) try { await bounded("session close", session.close(), 6_000); } catch (error) { cleanupErrors.push(String(error)); }
    if (native) try { await bounded("native close", native.close(), 4_000); } catch (error) { cleanupErrors.push(String(error)); }
    peer.closeAllConnections();
    if (peer.listening) try { await bounded("peer close", new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve())), 3_000); }
    catch (error) { cleanupErrors.push(String(error)); }
    proof.childExited = native?.exited; proof.exit = native?.exitInfo;
    proof.nativeIdentityAfterClose = nativeIdentity(native?.pid ?? null);
    proof.nativeBirthAbsent = Boolean(proof.nativeIdentity) && (!proof.nativeIdentityAfterClose
      || proof.nativeIdentityAfterClose.start !== proof.nativeIdentity.start);
    try {
      const after = await readFile(userFile);
      proof.userFileUnchanged = userBytes.equals(after);
      await writeFile(join(root, "original-user-models.after.json"), after);
      await copyFile(modelsFile, join(root, "runtime-models.after.json"));
      if (sessionFile) await copyFile(sessionFile, join(root, "native-session.jsonl"));
    } catch (error) { cleanupErrors.push(String(error)); }
    vi.unstubAllEnvs();
    if (cleanupErrors.length || !proof.childExited || !proof.nativeBirthAbsent || !proof.userFileUnchanged) proof.status = "failed";
    await persist();
    // Assert terminal birth absence even when the wire assertion was RED, after
    // evidence is durable. Preserve both causes rather than masking either one.
    try {
      expect(cleanupErrors, "cleanup proof retained in proof.json").toEqual([]);
      expect(proof.childExited).toBe(true);
      expect(proof.nativeBirthAbsent, "exact native PID/start birth must be absent").toBe(true);
      expect(proof.userFileUnchanged).toBe(true);
    } catch (error) { failure = failure ? new AggregateError([failure, error], "Pi compat assertion and cleanup failed") : error; }
  }
  if (failure) throw failure;
}, 90_000);
