import { createServer, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import type { CodexRpcNotification } from "../drivers/codex/app-server-transport.js";
import { sendPiToolRequest, validateOrigin, type PiToolCallRequest } from "../drivers/pi/pi-bind-protocol.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

// Trust-boundary regression: actual Rust runnerd, production proxy/driver, and
// installed Pi. Only the model service and authenticated controller are faux.
const pi = process.env.PI_TEST_BINARY;
const run1 = "run-pi-resident-first";
const run2 = "run-pi-resident-second";
const instructions1 = "Resident authority FIRST instructions: first-run-marker-1.";
const instructions2 = "Resident authority SECOND instructions: refreshed-run-marker-2.";
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(label: string, promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

type ProcessIdentity = { pid: number; ppid: number; started: string; cmdline: string; state: string };
function processIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(fields[1]), started: fields[19]!, state: fields[0]!, cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error; // Unreadable is not evidence of retirement.
  }
}

function descendants(root: number): ProcessIdentity[] {
  const processes = readdirSync("/proc").filter(entry => /^\d+$/.test(entry)).map(entry => processIdentity(Number(entry))).filter((entry): entry is ProcessIdentity => entry !== null);
  const result: ProcessIdentity[] = [];
  const visit = (pid: number) => {
    for (const child of processes.filter(entry => entry.ppid === pid)) { result.push(child); visit(child.pid); }
  };
  visit(root);
  return result;
}

function piIdentity(runnerPid: number): ProcessIdentity {
  const children = descendants(runnerPid).filter(entry => entry.cmdline.trim() === "pi" || entry.cmdline.includes("--mode rpc"));
  expect(children, "exactly one real Pi RPC child beneath runnerd").toHaveLength(1);
  return children[0]!;
}

async function runtimeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await runtimeReadOnly(path);
    else if (entry.isFile()) await chmod(path, (await stat(path)).mode & 0o555);
    else throw new Error(`unexpected copied Pi runtime entry: ${path}`);
  }
  await chmod(directory, 0o555);
}

function installedPiClosure(binary: string): { nodeModules: string; executableRelative: string } {
  const executable = realpathSync(binary);
  const packageRoots: string[] = [];
  for (let directory = dirname(executable);; directory = dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const value = record(JSON.parse(readFileSync(manifest, "utf8")));
      if (value.name === "@earendil-works/pi-coding-agent") {
        if (value.version !== "1.5.2") throw new Error("supplied Pi package version differs from 1.5.2");
        const entrypoint = record(value.bin).pi;
        if (typeof entrypoint !== "string" || realpathSync(join(directory, entrypoint)) !== executable) throw new Error("supplied binary is not the installed Pi entrypoint");
        packageRoots.push(directory);
      }
    }
    if (dirname(directory) === directory) break;
  }
  if (packageRoots.length !== 1) throw new Error("supplied Pi package root is missing or ambiguous");
  const packageRoot = packageRoots[0]!;
  const closures: string[] = [];
  for (let directory = dirname(packageRoot);; directory = dirname(directory)) {
    const installedPackage = join(directory, "@earendil-works/pi-coding-agent");
    if (basename(directory) === "node_modules" && existsSync(installedPackage) && realpathSync(installedPackage) === packageRoot) closures.push(directory);
    if (dirname(directory) === directory) break;
  }
  if (closures.length !== 1) throw new Error("installed Pi node_modules closure is missing or ambiguous");
  const nodeModules = closures[0]!; // Nearest exact package owner, never ambient/global resolution.
  const executableRelative = relative(nodeModules, executable);
  if (isAbsolute(executableRelative) || executableRelative === ".." || executableRelative.startsWith(`..${sep}`)) throw new Error("Pi executable escapes its installed closure");
  return { nodeModules, executableRelative };
}

const tool = (name: string, marker: string) => ({
  name, description: `Read only the current run's proof context (${marker}).`,
  inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
});
const tools1 = [tool("first_run_context", "first-tool-marker")];
const tools2 = [tool("read_proof_context", "refreshed-tool-marker")];
const firstCallId = "proof-semantic-run1";
const secondCallId = "proof-semantic-run2";

type InitialAuthority = { schema: 1; sessionId: string; epoch: number; runId: string; turnId: string; toolSocketPath: string };
function initialAuthority(pid: number): InitialAuthority {
  // Never print or retain /proc environ. Select this one nonsecret entry, then
  // immediately discard every field except the authority allowlist below.
  const entry = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find(value => value.startsWith("PAPERCLIP_PI_BIND_INITIAL="));
  if (!entry) throw new Error("actual Pi has no INITIAL authority");
  const value = record(JSON.parse(entry.slice("PAPERCLIP_PI_BIND_INITIAL=".length)));
  if (value.schema !== 1 || !validateOrigin(value) || typeof value.sessionId !== "string" || typeof value.toolSocketPath !== "string") throw new Error("actual Pi INITIAL authority is incomplete");
  return { schema: 1, sessionId: value.sessionId, epoch: value.epoch, runId: value.runId, turnId: value.turnId, toolSocketPath: value.toolSocketPath };
}

function nativeSessionId(root: string): string {
  const journal = join(root, "pi-runtime", "session-pi-resident-proof.jsonl");
  const header = record(JSON.parse(readFileSync(journal, "utf8").split("\n")[0]!));
  expect(header.type).toBe("session");
  expect(header.id, "session identity read from the real Pi JSONL header").toBeTypeOf("string");
  return String(header.id);
}

function brokerAddress(agentDirectory: string): string {
  const models = record(JSON.parse(readFileSync(join(agentDirectory, "models.json"), "utf8")));
  const address = record(record(models.providers).paperclip).baseUrl;
  if (typeof address !== "string") throw new Error("managed broker address unavailable");
  const url = new URL(address);
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.protocol).toBe("http:");
  return address; // Deliberately never return/record the provider apiKey.
}

async function assertBrokerRefused(address: string): Promise<void> {
  const url = new URL(address);
  const code = await within("settled broker physical connection refusal", new Promise<string>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("broker refusal probe timed out")); });
    socket.once("connect", () => { socket.destroy(); reject(new Error("settled broker still accepts TCP connections")); });
    socket.once("error", error => resolve((error as NodeJS.ErrnoException).code ?? String(error)));
  }));
  expect(code, "idle capability must be physically closed, not merely HTTP-denied").toBe("ECONNREFUSED");
}

async function rootManifest(root: string) {
  const files: Array<{ path: string; sha256: string }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path !== join(root, "root-manifest.json")) files.push({ path: relative(root, path), sha256: digest(path) });
    }
  };
  await walk(root);
  return { schema: 1, root, excludes: ["root-manifest.json (self)"], files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

type ModelRequest = { at: string; body: Record<string, unknown> };
async function fauxOpenAi() {
  const requests: ModelRequest[] = [];
  const held = new Set<ServerResponse>();
  const firstResult = deferred<Record<string, unknown>>();
  const continuation = deferred<Record<string, unknown>>();
  const thirdRequest = deferred<ModelRequest>();
  const permitRun2Tool = deferred<void>();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      try {
        const parsed = record(JSON.parse(body));
        requests.push({ at: new Date().toISOString(), body: parsed });
        const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).map(record);
        const latest = messages.at(-1) ?? {};
        const latestText = Array.isArray(latest.content) ? latest.content.map(part => String(record(part).text ?? "")).join("") : String(latest.content ?? "");
        const sequence = requests.length;
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
          response.write(`data: ${JSON.stringify({ id: `local-faux-${sequence}`, object: "chat.completion.chunk", model: "faux", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        };
        const finish = (reason: string) => {
          chunk({}, reason);
          response.write(`data: ${JSON.stringify({ id: `local-faux-${sequence}`, choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
          response.end("data: [DONE]\n\n");
        };
        if (latest.role === "tool" && latest.tool_call_id === firstCallId) {
          firstResult.resolve(latest);
          chunk({ role: "assistant", content: "first semantic result received" });
          finish("stop");
        } else if (latest.role === "tool" && latest.tool_call_id === secondCallId) {
          chunk({ role: "assistant", content: "semantic result received; pending physical Stop" });
          held.add(response);
          response.on("close", () => held.delete(response));
          continuation.resolve(latest);
          // Deliberately pending real model work. Stop, not a fixture timer,
          // must cancel this stream and retire the owned Pi process.
        } else if (latestText.includes("proof turn 1")) {
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: firstCallId, type: "function", function: { name: "first_run_context", arguments: JSON.stringify({ marker: "first-run-marker-1" }) } }] });
          finish("tool_calls");
        } else if (latestText.includes("proof turn 3")) {
          thirdRequest.resolve(requests.at(-1)!);
          // A finite test-owned event gate, not polling: the host rejects the
          // captured run-1 callback while run 2 is active, BEFORE this genuine
          // run-2 execution is announced. No forged stdout announcements.
          held.add(response);
          response.on("close", () => held.delete(response));
          void permitRun2Tool.promise.then(() => {
            if (response.destroyed) return;
            held.delete(response);
            chunk({ role: "assistant", tool_calls: [{ index: 0, id: secondCallId, type: "function", function: { name: "read_proof_context", arguments: JSON.stringify({ marker: "refreshed-run-marker-2" }) } }] });
            finish("tool_calls");
          });
        } else {
          chunk({ role: "assistant", content: `local faux reply ${sequence}` });
          finish("stop");
        }
      } catch (error) { response.destroy(error as Error); }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local faux model did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/v1`, requests, firstResult: firstResult.promise, continuation: continuation.promise,
    thirdRequest: thirdRequest.promise, permitRun2Tool: () => permitRun2Tool.resolve(), heldCount: () => held.size,
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    },
  };
}

function systemText(request: ModelRequest): string {
  return (Array.isArray(request.body.messages) ? request.body.messages : []).map(record).filter(message => message.role === "system" || message.role === "developer").map(message => String(message.content ?? "")).join("\n");
}
function modelToolNames(request: ModelRequest): string[] {
  return (Array.isArray(request.body.tools) ? request.body.tools : []).map(entry => String(record(record(entry).function).name ?? ""));
}

it.skipIf(process.platform !== "linux" || !pi)("FINAL AUTHORITY PROOF: real runnerd retains Pi across three turns/two runs, rejects old-owner replay, returns semantic results, and physically Stops", async () => {
  const proofPath = process.env.PI_PROOF_PATH;
  const evidenceDirectory = proofPath ? dirname(proofPath) : tmpdir();
  await mkdir(evidenceDirectory, { recursive: true });
  const root = await mkdtemp(join(evidenceDirectory, "runnerd-pi-resident-authority-"));
  const runnerBinary = process.env.PAPERCLIP_RUNNERD_PATH ?? defaultCapabilityRunnerdBinary();
  const proof: Record<string, unknown> = {
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runnerdSha256: digest(runnerBinary),
    schema: "paperclip.pi.resident-authority.final-proof.v1", status: "running", root,
    source: "current Rust runnerd -> production Pi proxy -> PiRpcDriver -> real Pi 1.5.2; local faux OpenAI stream only; no external model or credentials",
    sourceHashes: Object.fromEntries([
      "src/live/runnerd-pi-resident-authority.integration.test.ts", "src/live/runnerd-codex-transport.ts",
      "src/cli/pi-rpc-app-server-proxy.ts", "src/drivers/pi/pi-rpc-driver.ts", "src/drivers/pi/pi-rpc-transport.ts",
      "src/drivers/pi/pi-rpc-callback-server.ts", "src/drivers/pi/pi-bind-protocol.ts", "src/drivers/pi/extension/index.ts",
      "runner/crates/runner-core/src/codex_provider.rs", "runner/crates/runner-core/src/provider_backend.rs",
      "scripts/build-verified-provider-entrypoints.mjs",
    ].map(path => [path, digest(path)])),
    delegatedEvidence: { report: ".local/driver-bind-result.md", assertions: ["actual-Pi applied bind with lost ACK fences before prompt", "actual-Pi idle unsolicited raw prompt handled without upstream work", "bootstrap no private bind/begin IPC (driver transport observation)"] },
    coverageGaps: ["runnerd facade exposes no supported unsolicited raw-Pi-input/private-bind-injection seam; those negative journeys are delegated, not claimed integrated"],
  };
  const faux = await fauxOpenAi();
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "pi-agent");
  await mkdir(workspace);
  await mkdir(agentDirectory);
  await writeFile(join(agentDirectory, "models.json"), JSON.stringify({ providers: { localFaux: {
    baseUrl: faux.url, api: "openai-completions", apiKey: "local-only-no-credentials",
    models: [{ id: "faux", name: "local faux", contextWindow: 16384, maxTokens: 256 }],
  } } }));
  const piPackageRoot = join(root, "pi-package");
  // Mirror materialize-pi-rpc-distribution.mjs: retain the whole installed
  // node_modules graph, not just the SDK package (jiti/typebox load at runtime).
  // Resolve .bin first and admit only the exact installed package owner.
  const closure = installedPiClosure(pi!);
  await mkdir(piPackageRoot);
  await cp(closure.nodeModules, join(piPackageRoot, "node_modules"), { recursive: true, dereference: true });
  await runtimeReadOnly(piPackageRoot);
  const executable = join(piPackageRoot, "node_modules", closure.executableRelative);
  proof.piRuntimeClosure = { source: closure.nodeModules, executableRelative: closure.executableRelative, copiedRoot: piPackageRoot };
  proof.piVersion = execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  expect(proof.piVersion).toBe("1.5.2");
  // Mirror scripts/build-verified-provider-entrypoints.mjs's verified CJS
  // options and production relative layout. Raw CJS bundling erases import.meta
  // and would break the driver's OWNED extension resolver. No env/module-path
  // substitute or fake extension handler is permitted here.
  const proxy = join(root, "cli", "pi-rpc-app-server-proxy.cjs");
  const extension = join(root, "drivers", "pi", "extension", "index.js");
  const artifacts = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { build } from "esbuild";
    import { builtinModules } from "node:module";
    const common = { bundle: true, platform: "node", target: "node24", packages: "bundle", splitting: false, sourcemap: false, legalComments: "none", metafile: true, treeShaking: true, write: false, logLevel: "silent" };
    const proxy = await build({ ...common, entryPoints: ["src/cli/pi-rpc-app-server-proxy.ts"], outfile: "cli/pi-rpc-app-server-proxy.cjs", format: "cjs",
      banner: { js: 'const __paperclipVerifiedEntrypointUrl = require("node:url").pathToFileURL(__filename).href;' },
      define: { "import.meta.dirname": "__dirname", "import.meta.url": "__paperclipVerifiedEntrypointUrl" },
    });
    const extension = await build({ ...common, entryPoints: ["src/drivers/pi/extension/index.ts"], outfile: "drivers/pi/extension/index.js", format: "esm" });
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => "node:" + name)]);
    for (const result of [proxy, extension]) {
      const entries = Object.values(result.metafile.outputs).filter(output => output.entryPoint !== undefined);
      if (entries.length !== 1 || entries[0].imports.some(dependency => !dependency.external || !builtins.has(dependency.path))) throw new Error("proof production bundle is not self-contained");
    }
    process.stdout.write(JSON.stringify({ proxy: proxy.outputFiles[0].text, extension: extension.outputFiles[0].text, proxyMetafile: proxy.metafile, extensionMetafile: extension.metafile }));
  `], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as { proxy: string; extension: string; proxyMetafile: unknown; extensionMetafile: unknown };
  await mkdir(dirname(proxy), { recursive: true });
  await mkdir(dirname(extension), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  await writeFile(proxy, artifacts.proxy, { mode: 0o755 });
  await writeFile(extension, artifacts.extension, { mode: 0o444 });
  await writeFile(join(root, "production-bundle-metafiles.json"), `${JSON.stringify({ proxy: artifacts.proxyMetafile, extension: artifacts.extensionMetafile }, null, 2)}\n`);
  Object.assign(proof, { proxySha256: digest(proxy), extensionSha256: digest(extension), piSha256: digest(executable), productionLayout: { proxy, extension } });
  const diagnostics: string[] = [];
  let runnerPid: number | null = null;
  let owned: ProcessIdentity[] = [];
  const bundle = createRunnerdCodexTransport({
    provider: "pi_rpc", runnerBinary,
    stateDirectory: join(root, "runner-state"), sourceCodexHome: "",
    providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath),
    piCommand: executable, piCommandSha256: digest(executable), piProxyPath: proxy, piProxySha256: digest(proxy),
    piRuntimeDirectory: join(root, "pi-runtime"), baseInstructions: instructions1, piRpcThinkingLevel: "off",
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    prpIdentity: { runnerInstanceId: "runner-pi-resident-proof", environmentLeaseId: "lease-pi-resident-proof", runId: run1, normalizedSessionId: "session-pi-resident-proof", turnId: "turn-proof-authority-1", itemId: "item-proof-authority-1" },
    environment: {
      PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1",
      PAPERCLIP_AI_PROVIDER_URL: faux.url, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none",
      PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker",
    },
    onDiagnostic: message => { diagnostics.push(message); },
    onSpawn: async meta => {
      runnerPid = meta.pid;
      const identity = processIdentity(meta.pid);
      if (identity) owned.push(identity);
    },
  });
  const { transport } = bundle;
  const semanticCalls: Record<string, unknown>[] = [];
  const turns: Record<string, unknown>[] = [];
  const pids: ProcessIdentity[] = [];
  const sessions: string[] = [];
  const facadeThreadIds: string[] = [];
  const nativeSessions: string[] = [];
  const idleRevocations: Array<{ turn: number; address: string; code: "ECONNREFUSED" }> = [];
  let capturedRun1Call: PiToolCallRequest | undefined;
  const effects = { total: 0, first: 0, second: 0 };
  const notifications: CodexRpcNotification[] = [];
  const iterator = transport.notifications()[Symbol.asyncIterator]();
  let primaryError: unknown;
  const readUntil = async (predicate: (event: CodexRpcNotification) => boolean) => {
    for (;;) {
      const next = await within("runnerd notification", iterator.next());
      if (next.done) throw new Error("runnerd stream ended before expected notification");
      notifications.push(next.value);
      if (next.value.method === "turn/failed") throw new Error(`runnerd turn failed: ${JSON.stringify(next.value.params)}`);
      if (predicate(next.value)) return next.value;
    }
  };
  transport.setServerRequestHandler(async request => {
    expect(request.method).toBe("item/tool/call");
    const first = request.params.tool === "first_run_context";
    expect(request.params.tool).toBe(first ? "first_run_context" : "read_proof_context");
    expect(request.params.arguments).toEqual({ marker: first ? "first-run-marker-1" : "refreshed-run-marker-2" });
    expect(effects.total).toBe(first ? 0 : 1);
    semanticCalls.push(structuredClone(request.params));
    // These counters are effects at the authenticated controller boundary, not
    // callback-server/mocked dispatch counts. The negative MUST leave all three.
    effects.total++; effects[first ? "first" : "second"]++;
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, marker: first ? "accepted-under-run-1" : "accepted-under-run-2", runId: first ? run1 : run2 }) }] };
  });
  try {
    const opened = await transport.request("thread/start", { cwd: workspace, model: "paperclip/faux", baseInstructions: instructions1, dynamicTools: tools1 });
    const thread = record(opened.thread);
    expect(thread.sessionId, "production receiver must expose the actual native provider session, not a normalized/thread ID fallback").toBeTypeOf("string");
    const sessionId = String(thread.sessionId);
    expect(sessionId).not.toBe("");
    facadeThreadIds.push(String(thread.id));
    runnerPid = transport.processInfo!().pid;
    expect(runnerPid).not.toBeNull();
    const initialPi = piIdentity(runnerPid!);
    pids.push(initialPi);
    sessions.push(sessionId);
    owned = [processIdentity(runnerPid!)!, ...descendants(runnerPid!)];
    const initial = initialAuthority(initialPi.pid);
    proof.initialAuthority = initial;
    expect(initial.runId).toBe(run1);
    expect(initial.epoch).toBe(1);
    expect(initial.sessionId, "private INITIAL deliberately uses HOST normalized identity, not native Pi identity").toBe("session-pi-resident-proof");
    expect(initial.sessionId).not.toBe(sessionId);
    for (const turn of [1, 2]) {
      proof.phase = `run1-turn${turn}`;
      const sentAt = performance.now();
      const accepted = await transport.request("turn/start", { input: [{ type: "text", text: `proof turn ${turn}` }] });
      const address = brokerAddress(agentDirectory); // AFTER any same-run epoch rotation.
      const turnId = String(record(accepted.turn).id);
      if (turn === 1) {
        expect(turnId, "bootstrap must use INITIAL's preallocated native turn, not a replacement bind/begin turn").toBe(initial.turnId);
        proof.bootstrap = { preallocatedTurnId: initial.turnId, observedTurnId: turnId, epoch: initial.epoch, privateIpcObservation: "delegated driver-bind evidence; no proxy IPC tracing API" };
      }
      const first = await readUntil(event => event.params.turnId === turnId && event.method === "item/agentMessage/delta");
      const firstAt = performance.now();
      await readUntil(event => event.params.turnId === turnId && event.method === "turn/completed");
      if (turn === 1) {
        expect(String((await within("run1 semantic result at real model", faux.firstResult)).content)).toContain("accepted-under-run-1");
        expect(effects).toEqual({ total: 1, first: 1, second: 0 });
        const original = semanticCalls[0]!;
        expect(original.callId, "actual announced/captured call identity, not an invented replay ID").toBe(firstCallId);
        expect(original.turnId, "controller must retain INITIAL's originating native turn").toBe(initial.turnId);
        capturedRun1Call = {
          schema: 1, type: "tool_call", nonce: randomUUID(), sessionId: initial.sessionId,
          origin: { epoch: initial.epoch, runId: initial.runId, turnId: initial.turnId },
          toolCallId: String(original.callId), tool: String(original.tool), arguments: structuredClone(original.arguments),
        };
      }
      await assertBrokerRefused(address);
      idleRevocations.push({ turn, address, code: "ECONNREFUSED" });
      pids.push(piIdentity(runnerPid!));
      const read = await transport.request("thread/read", {});
      expect(record(read.thread).sessionId).toBeTypeOf("string");
      sessions.push(String(record(read.thread).sessionId));
      facadeThreadIds.push(String(record(read.thread).id));
      nativeSessions.push(nativeSessionId(root));
      turns.push({ turn, runId: run1, turnId: first.params.turnId, pi: pids.at(-1), nativePiSessionId: nativeSessions.at(-1), sentToFirstModelEventMs: firstAt - sentAt, sentToCompletedMs: performance.now() - sentAt });
    }
    proof.phase = "run2-attach";
    expect(transport.attachRun, "real transport must expose run.attach").toBeTypeOf("function");
    // The attaching run's explicit public grant must cross the real Runner
    // boundary; retaining the old catalog fails the model-boundary assertions.
    const refresh = {
      runId: run2, turnId: "turn-proof-authority-2", itemId: "item-proof-authority-2",
      currentRunGrant: { instructions: instructions2, runtimeContext: null }, dynamicTools: tools2,
    };
    await transport.attachRun!(refresh);
    pids.push(piIdentity(runnerPid!));
    proof.phase = "run2-turn3";
    const sentAt = performance.now();
    const accepted = await transport.request("turn/start", { input: [{ type: "text", text: "proof turn 3: call read_proof_context then remain pending for Stop" }] });
    const turnId = String(record(accepted.turn).id);
    await within("run2 model-boundary gate", faux.thirdRequest);
    proof.phase = "run2-old-owner-replay";
    expect(faux.requests).toHaveLength(4);
    const beforeReplay = structuredClone(effects);
    // Exact original owner + call ID, sent to the ACTUAL live host callback
    // socket. No mutable run fallback, self-announcement, stdout, or mock guard.
    if (!capturedRun1Call) throw new Error("run1 callback was never captured at the actual controller");
    let replayError: string | undefined;
    try { await sendPiToolRequest(initial.toolSocketPath, capturedRun1Call, { timeoutMs: 3_000 }); }
    catch (error) { replayError = error instanceof Error ? error.message : String(error); }
    expect(replayError, "host must explicitly reject old owner before any controller effect").toBe("Pi private request rejected");
    expect(effects).toEqual(beforeReplay);
    expect(semanticCalls).toHaveLength(1);
    expect(faux.requests).toHaveLength(4);
    proof.staleOwnerReplay = { request: capturedRun1Call, error: replayError, before: beforeReplay, after: structuredClone(effects), modelRequestsBeforeAndAfter: 4, rejectedBeforeController: true };
    faux.permitRun2Tool();
    proof.phase = "run2-legitimate-semantic-result";
    const first = await readUntil(event => event.params.turnId === turnId && ["item/started", "item/agentMessage/delta"].includes(event.method));
    const firstAt = performance.now();
    turns.push({ turn: 3, runId: run2, turnId: first.params.turnId, sentToFirstModelEventMs: firstAt - sentAt });
    const returnedToolMessage = await within("semantic result reaching the real Pi model", faux.continuation);
    expect(String(returnedToolMessage.content)).toContain("accepted-under-run-2");
    await readUntil(event => event.method === "item/agentMessage/delta" && String(event.params.delta).includes("semantic result received"));
    turns[2]!.pendingAtStop = true;
    pids.push(piIdentity(runnerPid!));
    const read = await transport.request("thread/read", {});
    expect(record(read.thread).sessionId).toBeTypeOf("string");
    sessions.push(String(record(read.thread).sessionId));
    facadeThreadIds.push(String(record(read.thread).id));
    nativeSessions.push(nativeSessionId(root));
    Object.assign(turns[2]!, { pi: pids.at(-1), nativePiSessionId: nativeSessions.at(-1) });
    expect(new Set(pids.map(identity => `${identity.pid}:${identity.started}`)).size, "Pi must remain the same physical process across run.attach").toBe(1);
    expect(new Set(sessions), "authenticated Pi session must be observed unchanged, not inferred").toEqual(new Set([sessionId]));
    expect(new Set(nativeSessions), "native JSONL session identity must independently match on every turn").toEqual(new Set([sessionId]));
    expect(semanticCalls).toHaveLength(2);
    expect(effects).toEqual({ total: 2, first: 1, second: 1 });
    expect(semanticCalls[1]!.callId).toBe(secondCallId);
    expect(faux.requests).toHaveLength(5);
    expect(systemText(faux.requests[0]!)).toContain(instructions1);
    expect(modelToolNames(faux.requests[0]!)).toContain("first_run_context");
    for (const request of faux.requests.slice(0, 3)) {
      expect(systemText(request)).toContain(instructions1);
      expect(modelToolNames(request)).toContain("first_run_context");
    }
    for (const request of faux.requests.slice(3)) {
      expect(systemText(request)).toContain(instructions2);
      expect(systemText(request)).not.toContain(instructions1);
      expect(modelToolNames(request)).toContain("read_proof_context");
      expect(modelToolNames(request)).not.toContain("first_run_context");
    }
    expect(turns).toHaveLength(3);
    expect(faux.heldCount(), "turn 3 must still have an actual pending model stream when Stop begins").toBe(1);
    expect(owned.some(identity => identity.pid === initialPi.pid)).toBe(true);
    expect(owned.some(identity => identity.pid === initialPi.ppid), "owned production proxy must be birth-attested too").toBe(true);
    proof.phase = "physical-stop";
    await within("Stop reaching pending native work", transport.request("turn/interrupt", { turnId }));
    await transport.close("first-proof-physical-stop");
    await vi.waitFor(() => {
      for (const identity of owned) {
        const current = processIdentity(identity.pid);
        expect(current === null || current.started !== identity.started, `owned PID ${identity.pid} must physically retire`).toBe(true);
      }
    }, { timeout: 5_000, interval: 50 });
    proof.status = "passed-full-resident-slice";
    proof.stop = { pendingModelStreamObserved: true, physicalRetirementVerified: true, owned };
  } catch (error) {
    primaryError = error;
    proof.status = "failed";
    proof.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (runnerPid !== null) {
      for (const identity of descendants(runnerPid)) {
        if (!owned.some(prior => prior.pid === identity.pid && prior.started === identity.started)) owned.push(identity);
      }
    }
    try { await transport.close(); }
    catch (error) {
      proof.cleanupError = String(error);
      proof.status = "failed";
      if (primaryError) throw new AggregateError([primaryError, error], "resident proof and cleanup failed");
      throw error;
    } finally {
      await faux.close();
      Object.assign(proof, { runnerPid, piProcesses: pids, providerPiSessionIds: sessions, facadeThreadIds, nativePiSessionIds: nativeSessions, turns, modelRequests: faux.requests, semanticCalls, effects, idleRevocations, diagnostics, ownedAfterCleanup: owned.map(identity => ({ before: identity, after: processIdentity(identity.pid) })), retainedRoot: true, rootManifest: join(root, "root-manifest.json") });
      await writeFile(join(root, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
      await writeFile(join(root, "notifications.json"), `${JSON.stringify(notifications, null, 2)}\n`);
      if (proofPath) await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
      if (process.env.PI_DEBUG_ROOT_PATH) await writeFile(process.env.PI_DEBUG_ROOT_PATH, `${root}\n`);
      await writeFile(join(root, "root-manifest.json"), `${JSON.stringify(await rootManifest(root), null, 2)}\n`);
      // Always preserve raw Pi JSONL, runnerd journals, and original failures.
      // PI_KEEP_ROOT=1 is set by the owned proof command; there is no rm path.
      expect(existsSync(root)).toBe(true);
    }
  }
}, 90_000);
