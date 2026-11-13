import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { expect, it, vi } from "vitest";
import { paperclipSemanticAction } from "../catalog/semantic-action-catalog.js";
import type { CodexRpcNotification } from "../drivers/codex/app-server-transport.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

// Trust-boundary regression: no mocked Pi SDK, extension, proxy, or Runner.
// Only the local model service and authenticated server-side tool authority are
// faux. This proves native registration/result delivery, NOT server API auth.
const pi = process.env.PI_TEST_BINARY;
const normalizedSessionId = "session-pi-runner-api-tools";
const runIds = ["run-pi-api-first", "run-pi-api-second"] as const;
const instructions = ["Runner API FIRST instruction marker.", "Runner API REFRESHED instruction marker."] as const;
const catalogMarkers = ["first-api-catalog", "refreshed-api-catalog"] as const;
const toolNames = ["get_task_context", "list_agents", "search_api", "call_api"] as const;
const callIds = ["pi-api-context-call", "pi-api-agents-call"] as const;
const results = [
  { company: { id: "company-local-proof" }, activeTask: { id: "task-local-proof", title: "Runner API native tools" }, marker: "context-returned-to-real-Pi" },
  { actors: [{ id: "actor-local-proof", name: "Local proof teammate" }], marker: "agents-returned-to-real-Pi" },
] as const;
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function toolsForRun(index: number) {
  return toolNames.map(name => {
    const descriptor = paperclipSemanticAction(name);
    if (!descriptor) throw new Error(`canonical Runner API tool missing: ${name}`);
    return { name, description: `${descriptor.description} Catalog snapshot: ${catalogMarkers[index]}.`, inputSchema: structuredClone(descriptor.inputSchema) };
  });
}

async function within<T>(label: string, promise: Promise<T>, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

type ProcessIdentity = { pid: number; ppid: number; pgid: number; started: string; cmdline: string };
function processIdentity(pid: number): ProcessIdentity | null {
  try {
    const value = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), started: fields[19]!, cmdline: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ") };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}
function processes(): ProcessIdentity[] {
  return readdirSync("/proc").filter(entry => /^\d+$/.test(entry)).map(entry => processIdentity(Number(entry))).filter((entry): entry is ProcessIdentity => entry !== null);
}
function descendants(root: number): ProcessIdentity[] {
  const all = processes(), result: ProcessIdentity[] = [];
  const visit = (pid: number) => { for (const child of all.filter(entry => entry.ppid === pid)) { result.push(child); visit(child.pid); } };
  visit(root);
  return result;
}
function piIdentity(runnerPid: number): ProcessIdentity {
  const children = descendants(runnerPid).filter(entry => entry.cmdline.trim() === "pi" || entry.cmdline.includes("--mode rpc"));
  expect(children, "one real installed Pi beneath actual runnerd").toHaveLength(1);
  return children[0]!;
}

// Same installation/CJS-FD profile pattern as the frozen resident-authority
// fixture. Copy the entire exact installed closure, including jiti/typebox.
function installedPiClosure(binary: string): { nodeModules: string; executableRelative: string } {
  const executable = realpathSync(binary), packageRoots: string[] = [];
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
  const packageRoot = packageRoots[0]!, closures: string[] = [];
  for (let directory = dirname(packageRoot);; directory = dirname(directory)) {
    const installedPackage = join(directory, "@earendil-works/pi-coding-agent");
    if (basename(directory) === "node_modules" && existsSync(installedPackage) && realpathSync(installedPackage) === packageRoot) closures.push(directory);
    if (dirname(directory) === directory) break;
  }
  if (closures.length !== 1) throw new Error("installed Pi node_modules closure is missing or ambiguous");
  const nodeModules = closures[0]!, executableRelative = relative(nodeModules, executable);
  if (isAbsolute(executableRelative) || executableRelative === ".." || executableRelative.startsWith(`..${sep}`)) throw new Error("Pi executable escapes installed closure");
  return { nodeModules, executableRelative };
}
async function runtimeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await runtimeReadOnly(path);
    else if (entry.isFile()) await chmod(path, (await stat(path)).mode & 0o555);
    else throw new Error(`unexpected installed runtime entry: ${path}`);
  }
  await chmod(directory, 0o555);
}
async function productionRuntime(root: string) {
  const pack = process.env.PI_TEST_PROVIDER_PACK;
  if (pack) {
    const executable = join(pack, "provider-assets/pi_rpc/linux-x64/runtime/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
    expect(execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("1.5.2");
    return { executable, proxy: join(pack, "dist/cli/pi-rpc-app-server-proxy.cjs"),
      extension: join(pack, "dist/drivers/pi/extension/index.js"), closure: installedPiClosure(executable) };
  }
  const closure = installedPiClosure(pi!);
  const packageRoot = join(root, "pi-package");
  await mkdir(packageRoot);
  await cp(closure.nodeModules, join(packageRoot, "node_modules"), { recursive: true, dereference: true });
  await runtimeReadOnly(packageRoot);
  const executable = join(packageRoot, "node_modules", closure.executableRelative);
  expect(execFileSync(process.execPath, [executable, "--version"], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("1.5.2");
  const proxy = join(root, "dist", "cli", "pi-rpc-app-server-proxy.cjs");
  const extension = join(root, "dist", "drivers", "pi", "extension", "index.js");
  const artifacts = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { build } from "esbuild";
    import { builtinModules } from "node:module";
    import { bundlePiExtensions } from "./scripts/build-verified-provider-entrypoints.mjs";
    const common = { bundle: true, platform: "node", target: "node24", packages: "bundle", splitting: false, sourcemap: false, legalComments: "none", metafile: true, treeShaking: true, write: false, logLevel: "silent" };
    const proxy = await build({ ...common, entryPoints: ["src/cli/pi-rpc-app-server-proxy.ts"], outfile: "cli/pi-rpc-app-server-proxy.cjs", format: "cjs",
      banner: { js: 'const __paperclipVerifiedEntrypointUrl = require("node:url").pathToFileURL(__filename).href;' },
      define: { "import.meta.dirname": "__dirname", "import.meta.url": "__paperclipVerifiedEntrypointUrl" },
    });
    const extensions = await bundlePiExtensions({ write: false });
    const extension = extensions[0].result, childBridge = extensions[1].result;
    const builtins = new Set([...builtinModules, ...builtinModules.map(name => "node:" + name)]);
    for (const result of [proxy, extension]) {
      const entries = Object.values(result.metafile.outputs).filter(output => output.entryPoint !== undefined);
      if (entries.length !== 1 || entries[0].imports.some(dependency => !dependency.external || !builtins.has(dependency.path))) throw new Error("production proof bundle is not self-contained");
    }
    process.stdout.write(JSON.stringify({ proxy: proxy.outputFiles[0].text, extension: extension.outputFiles[0].text, childBridge: childBridge.outputFiles[0].text, proxyMetafile: proxy.metafile, extensionMetafile: extension.metafile }));
  `], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })) as { proxy: string; extension: string; childBridge: string; proxyMetafile: unknown; extensionMetafile: unknown };
  await mkdir(dirname(proxy), { recursive: true });
  await mkdir(dirname(extension), { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  await writeFile(proxy, artifacts.proxy, { mode: 0o755 });
  await writeFile(extension, artifacts.extension, { mode: 0o444 });
  const childBridge = join(dirname(extension), "child-bridge.js");
  await writeFile(childBridge, artifacts.childBridge, { mode: 0o444 });
  const hardening = join(dirname(proxy), "linux-process-hardening.node");
  if (process.platform === "linux") execFileSync(process.execPath, ["--input-type=module", "-e",
    'import {buildLinuxProcessHardening} from "./scripts/build-linux-process-hardening.mjs"; buildLinuxProcessHardening(process.argv[1]);', hardening]);
  await writeFile(join(root, "provider-pack.json"), JSON.stringify({ payload: { artifacts: {
    piChildBridge: { path: relative(root, childBridge), sha256: digest(childBridge) },
    ...(process.platform === "linux" ? { piProcessHardening: { path: relative(root, hardening), sha256: digest(hardening) } } : {}),
  } } }));
  await writeFile(join(root, "production-bundle-metafiles.json"), `${JSON.stringify({ proxy: artifacts.proxyMetafile, extension: artifacts.extensionMetafile }, null, 2)}\n`);
  return { executable, proxy, extension, closure };
}

type ModelRequest = { body: Record<string, unknown> };
async function fauxOpenAi() {
  const requests: ModelRequest[] = [], returnedTools: Record<string, unknown>[] = [];
  let probeCommand = "", probeOutput = "";
  const apiCall = () => ({ role: "assistant", tool_calls: [{ index: 0, id: callIds[0], type: "function", function: { name: toolNames[0], arguments: "{}" } }] });
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      try {
        const parsed = record(JSON.parse(body));
        requests.push({ body: parsed });
        const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).map(record);
        const latest = messages.at(-1) ?? {};
        const content = Array.isArray(latest.content) ? latest.content.map(part => String(record(part).text ?? "")).join("") : String(latest.content ?? "");
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => {
          response.write(`data: ${JSON.stringify({ id: `local-api-${requests.length}`, object: "chat.completion.chunk", model: "faux", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        };
        if (latest.role === "tool" && latest.tool_call_id === "credential-probe") {
          probeOutput = String(latest.content);
          chunk(apiCall());
          chunk({}, "tool_calls");
        } else if (latest.role === "tool") {
          returnedTools.push(structuredClone(latest));
          chunk({ role: "assistant", content: `Pi consumed Runner API result ${String(latest.tool_call_id)}` });
          chunk({}, "stop");
        } else {
          if (!content.includes("API proof first run") && !content.includes("API proof second run")) throw new Error("unexpected faux model input");
          const index = content.includes("API proof second run") ? 1 : 0;
          chunk(index === 0
            ? { role: "assistant", tool_calls: [{ index: 0, id: "credential-probe", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: probeCommand }) } }] }
            : { role: "assistant", tool_calls: [{ index: 0, id: callIds[index], type: "function", function: { name: toolNames[index], arguments: "{}" } }] });
          chunk({}, "tool_calls");
        }
        response.write(`data: ${JSON.stringify({ id: `local-api-${requests.length}`, choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
        response.end("data: [DONE]\n\n");
      } catch (error) { response.destroy(error as Error); }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("local faux model did not bind");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests, returnedTools,
    setProbe: (command: string) => { probeCommand = command; }, probeOutput: () => probeOutput, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  } };
}
function assertNativeCatalog(request: ModelRequest, index: number) {
  const functions = (Array.isArray(request.body.tools) ? request.body.tools : []).map(entry => record(record(entry).function));
  for (const tool of toolsForRun(index)) {
    const matches = functions.filter(fn => fn.name === tool.name);
    expect(matches, `native function ${tool.name} must be declared once`).toHaveLength(1);
    expect(matches[0]!.description).toBe(tool.description);
    expect(matches[0]!.parameters).toEqual(tool.inputSchema);
  }
  const system = (Array.isArray(request.body.messages) ? request.body.messages : []).map(record)
    .filter(message => message.role === "system" || message.role === "developer").map(message => String(message.content ?? "")).join("\n");
  expect(system).toContain(instructions[index]);
  expect(system).not.toContain(instructions[1 - index]);
}

it.skipIf(process.platform !== "linux" || !pi)("real runnerd/Pi returns Runner API tool results and refreshes all four native catalog schemas on the same process", async () => {
  const proofPath = process.env.PI_PROOF_PATH;
  const evidenceDirectory = proofPath ? dirname(proofPath) : tmpdir();
  await mkdir(evidenceDirectory, { recursive: true });
  const root = await mkdtemp(join(evidenceDirectory, "runnerd-pi-api-tools-"));
  const runnerBinary = process.env.PAPERCLIP_RUNNERD_PATH ?? defaultCapabilityRunnerdBinary();
  // Decoys only. Inject at runnerd exec, after the TS sanitizer, to exercise the
  // Rust boundary even when a caller bypasses the normal controller builder.
  // Agent-intended by Paperclip's design: the Ed25519 identity (doc/AGENT-IDENTITY.md:61-71) and the
  // Langfuse export credentials (doc/architecture/runner-pi-capabilities.md:72-76, :108-111).
  const identityKeys = ["PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_AGENT_PUBLIC_KEY", "PAPERCLIP_AGENT_PRIVATE_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_PUBLIC_KEY"];
  const decoys = Object.fromEntries([
    ...identityKeys, "PAPERCLIP_API_KEY", "PAPERCLIP_AGENT_API_KEY", "PAPERCLIP_AGENT_JWT_SECRET", "ASCII_TOKEN",
    "RUNNER_INTERNAL_CANARY",
  ].map(name => [name, `C44_DECOY_${name}_NOT_A_CREDENTIAL`]));
  const seededRunner = join(root, "seeded-runnerd.sh");
  await writeFile(seededRunner, `#!/bin/sh\n${Object.entries(decoys).map(([name, value]) => `export ${name}='${value}'`).join("\n")}\nexport LANGFUSE_TRACING_ENABLED=true\nexport PAPERCLIP_CONFIGURED_ENV_KEYS='["ASCII_TOKEN","LANGFUSE_SECRET_KEY","LANGFUSE_PUBLIC_KEY","RUNNER_INTERNAL_CANARY"]'\nexec '${runnerBinary}' "$@"\n`, { mode: 0o755 });
  const proof: Record<string, unknown> = {
    schema: "paperclip.pi.runner-api-tools.proof.v1", status: "running", root,
    source: "real runnerd -> production CJS proxy -> PiRpcDriver -> owned extension -> installed Pi 1.5.2; local faux model and server-side authority only",
    coverageGaps: ["No external model, production credentials, real HTTP API authorization, or assigned-MCP token-lifetime qualification."],
    runnerdSha256: digest(runnerBinary),
    sourceHashes: Object.fromEntries([
      "src/live/runnerd-pi-runner-api-tools.integration.test.ts", "src/live/runnerd-codex-transport.ts",
      "src/cli/pi-rpc-app-server-proxy.ts", "src/cli/linux-process-hardening.ts", "src/drivers/pi/pi-rpc-driver.ts",
      "src/drivers/pi/pi-process-environment.ts", "scripts/linux-process-hardening.c", "scripts/build-linux-process-hardening.mjs",
      "runner/crates/runner-core/src/bin/paperclip-runnerd.rs", "runner/crates/runner-core/src/codex_provider.rs",
      "runner/crates/runner-core/src/process_supervisor.rs", "src/drivers/pi/extension/index.ts",
      "src/drivers/pi/pi-bind-protocol.ts", "src/drivers/pi/pi-rpc-callback-server.ts", "src/catalog/semantic-action-catalog.ts",
    ].map(path => [path, digest(path)])),
  };
  const runtime = await productionRuntime(root);
  Object.assign(proof, { piVersion: "1.5.2", piSha256: digest(runtime.executable), proxySha256: digest(runtime.proxy), extensionSha256: digest(runtime.extension), installedClosure: runtime.closure });
  const workspace = join(root, "workspace"), agentDirectory = join(root, "pi-agent");
  await mkdir(workspace); await mkdir(agentDirectory);
  const faux = await fauxOpenAi();
  await writeFile(join(agentDirectory, "models.json"), JSON.stringify({ providers: { localFaux: {
    baseUrl: faux.url, api: "openai-completions", apiKey: "local-only-no-credentials",
    models: [{ id: "faux", name: "local faux", contextWindow: 16384, maxTokens: 256 }],
  } } }));
  const diagnostics: string[] = [];
  const { transport } = createRunnerdCodexTransport({
    provider: "pi_rpc", runnerBinary: seededRunner, stateDirectory: join(root, "runner-state"), sourceCodexHome: "",
    providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath),
    piCommand: runtime.executable, piCommandSha256: digest(runtime.executable), piProxyPath: runtime.proxy, piProxySha256: digest(runtime.proxy),
    piRuntimeDirectory: join(root, "pi-runtime"), baseInstructions: instructions[0], piRpcThinkingLevel: "off",
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 },
    prpIdentity: { runnerInstanceId: "runner-pi-api-tools", environmentLeaseId: "lease-pi-api-tools", runId: runIds[0], normalizedSessionId, turnId: "turn-pi-api-tools-1", itemId: "item-pi-api-tools-1" },
    environment: {
      PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1",
      PAPERCLIP_AI_PROVIDER_URL: faux.url, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none",
      PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker",
    },
    onDiagnostic: message => { diagnostics.push(message); },
  });
  const semanticCalls: Record<string, unknown>[] = [], notifications: CodexRpcNotification[] = [];
  const pids: ProcessIdentity[] = [], turnIds: string[] = [], sessionIds: string[] = [];
  let runnerPid: number | null = null, owned: ProcessIdentity[] = [], primaryError: unknown, cleanupError: unknown;
  const iterator = transport.notifications()[Symbol.asyncIterator]();
  const readCompleted = async (turnId: string) => {
    for (;;) {
      const next = await within("Runner API notification", iterator.next());
      if (next.done) throw new Error("runnerd notifications ended before completion");
      notifications.push(next.value);
      if (next.value.method === "turn/failed") throw new Error(`runnerd turn failed: ${JSON.stringify(next.value.params)}`);
      if (next.value.method === "turn/completed" && next.value.params.turnId === turnId) return;
    }
  };
  transport.setServerRequestHandler(async request => {
    const index = semanticCalls.length;
    expect(index, "only the two intended calls reach the authenticated authority").toBeLessThan(2);
    expect(request.method).toBe("item/tool/call");
    expect(request.params).toMatchObject({ tool: toolNames[index], callId: callIds[index], arguments: {} });
    semanticCalls.push(structuredClone(request.params));
    // This is the existing Runner controller result format, not a Pi bypass.
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(results[index]) }] };
  });
  try {
    const opened = await transport.request("thread/start", { cwd: workspace, model: "paperclip/faux", baseInstructions: instructions[0], dynamicTools: toolsForRun(0) });
    const sessionId = record(opened.thread).sessionId;
    expect(sessionId).toBeTypeOf("string");
    expect(sessionId).not.toBe(normalizedSessionId);
    runnerPid = transport.processInfo!().pid;
    expect(runnerPid).not.toBeNull();
    owned = [processIdentity(runnerPid!)!, ...descendants(runnerPid!)];
    const nativePi = piIdentity(runnerPid!);
    const proxyPid = nativePi.ppid;
    // Real Pi bash, not a host-side inspection. Capture all three process envs,
    // including the proxy (which retains the upstream model-broker capability).
    faux.setProbe(`env > tool-env.txt; cat /proc/${runnerPid}/environ > runner-env.bin 2> runner-env.err; printf 'runner-read-exit=%s\\n' "$?"; cat /proc/${proxyPid}/environ > proxy-env.bin 2> proxy-env.err; printf 'proxy-read-exit=%s\\n' "$?"; cat /proc/${nativePi.pid}/environ > pi-env.bin; printf 'pi-read-exit=%s\\n' "$?"; cat tool-env.txt; tr '\\0' '\\n' < runner-env.bin; tr '\\0' '\\n' < proxy-env.bin; tr '\\0' '\\n' < pi-env.bin; cat runner-env.err proxy-env.err`);
    for (const index of [0, 1]) {
      proof.phase = `run-${index + 1}`;
      if (index === 1) {
        expect(transport.attachRun).toBeTypeOf("function");
        await transport.attachRun!({ runId: runIds[1], turnId: "turn-pi-api-tools-2", itemId: "item-pi-api-tools-2",
          currentRunGrant: { instructions: instructions[1], runtimeContext: null }, dynamicTools: toolsForRun(1) });
      }
      pids.push(piIdentity(runnerPid!));
      const accepted = await transport.request("turn/start", { input: [{ type: "text", text: index === 0 ? "API proof first run: get_task_context" : "API proof second run: list_agents" }] });
      const turnId = String(record(accepted.turn).id);
      turnIds.push(turnId);
      await readCompleted(turnId);
      expect(semanticCalls).toHaveLength(index + 1);
      expect(semanticCalls[index]!.turnId, "originating native turn must survive every boundary").toBe(turnId);
      expect(faux.returnedTools).toHaveLength(index + 1);
      expect(faux.returnedTools[index]!.tool_call_id, "native result preserves the model's tool-call ID").toBe(callIds[index]);
      expect(JSON.parse(String(faux.returnedTools[index]!.content))).toEqual(results[index]);
      const read = await transport.request("thread/read", {});
      sessionIds.push(String(record(read.thread).sessionId));
      expect(sessionIds[index]).toBe(sessionId);
      const header = record(JSON.parse(readFileSync(join(root, "pi-runtime", `${normalizedSessionId}.jsonl`), "utf8").split("\n")[0]!));
      expect(header.id, "independent real Pi journal identity").toBe(sessionId);
      pids.push(piIdentity(runnerPid!));
    }
    expect(new Set(pids.map(identity => `${identity.pid}:${identity.started}`)).size, "same birth-attested Pi across both runs").toBe(1);
    expect(faux.requests).toHaveLength(5);
    for (const [index, request] of faux.requests.entries()) assertNativeCatalog(request, index < 3 ? 0 : 1);
    const observed = Object.fromEntries(["tool-env.txt", "runner-env.bin", "proxy-env.bin", "pi-env.bin", "runner-env.err", "proxy-env.err"].map(name => [name, readFileSync(join(workspace, name), "utf8")]));
    const decoyFindings = Object.fromEntries(Object.entries(observed).map(([name, value]) => [name, Object.keys(decoys).filter(key => value.includes(decoys[key]!))]));
    proof.credentialIsolation = { decoyFindings, permittedIdentityKeys: identityKeys, bashResult: faux.probeOutput(), proxyPid, piPid: nativePi.pid, langfuseEnabled: true };
    expect(Object.values(decoyFindings).flat().filter(key => !identityKeys.includes(key)), "no runner-only/API decoy reaches Pi, bash, or readable /proc envs").toEqual([]);
    for (const name of ["tool-env.txt", "pi-env.bin"]) {
      expect(decoyFindings[name], `agent-intended identity and Langfuse export remain in ${name}`).toEqual(identityKeys);
    }
    expect(observed["runner-env.bin"]).toBe("");
    expect(observed["proxy-env.bin"]).toBe("");
    expect(observed["runner-env.err"]).toContain("Permission denied");
    expect(observed["proxy-env.err"]).toContain("Permission denied");
    expect(faux.probeOutput()).toContain("pi-read-exit=0");
    expect(new Set(turnIds).size).toBe(2);
    proof.status = "passed-runner-api-tools-two-runs";
  } catch (error) {
    primaryError = error; proof.status = "failed"; proof.error = String(error);
  } finally {
    if (runnerPid !== null) {
      for (const identity of descendants(runnerPid)) if (!owned.some(prior => prior.pid === identity.pid && prior.started === identity.started)) owned.push(identity);
    }
    // Archive exact births and groups BEFORE any Stop, including failed runs.
    await writeFile(join(root, "owned-before-stop.json"), `${JSON.stringify(owned, null, 2)}\n`);
    try {
      await transport.close("runner-api-tools-proof-stop");
      const groups = new Set(owned.map(identity => identity.pgid));
      expect(groups.has(processIdentity(process.pid)!.pgid), "Runner must own separate groups, never the test's group").toBe(false);
      await vi.waitFor(() => {
        for (const before of owned) {
          const after = processIdentity(before.pid);
          expect(after === null || after.started !== before.started, `owned PID ${before.pid} physically absent`).toBe(true);
        }
        expect(processes().filter(identity => groups.has(identity.pgid)), "full owned process groups must be absent").toEqual([]);
      }, { timeout: 5_000, interval: 50 });
      proof.physicalRetirementVerified = true;
    } catch (error) { cleanupError = error; proof.cleanupError = String(error); proof.status = "failed"; }
    finally {
      await faux.close();
      Object.assign(proof, { runnerPid, semanticCalls, modelRequests: faux.requests, returnedTools: faux.returnedTools, piProcesses: pids, turnIds, nativeSessionIds: sessionIds, diagnostics,
        ownedAfterCleanup: owned.map(before => ({ before, after: processIdentity(before.pid) })), retainedRoot: true });
      await writeFile(join(root, "proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
      await writeFile(join(root, "notifications.json"), `${JSON.stringify(notifications, null, 2)}\n`);
      if (proofPath) await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
      if (process.env.PI_DEBUG_ROOT_PATH) await writeFile(process.env.PI_DEBUG_ROOT_PATH, `${root}\n`);
    }
  }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], "Runner API proof and cleanup failed");
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}, 90_000);
