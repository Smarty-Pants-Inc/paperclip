import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

const runner = process.env.PAPERCLIP_RUNNERD_PATH ?? defaultCapabilityRunnerdBinary();
const pi = process.env.PI_TEST_BINARY;
const servers: Server[] = [];
const digest = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

async function fakeOpenAiServer(): Promise<{ url: string; requests: string[] }> {
  let sequence = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages?: Array<{ content?: string | Array<{ text?: string }> }> };
      const content = parsed.messages?.at(-1)?.content;
      requests.push(Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "");
      sequence += 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      response.write(`data: ${JSON.stringify({ id: `fake-${sequence}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `local faux reply ${sequence}` }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: `fake-${sequence}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake OpenAI server did not bind a TCP port");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function makeRuntimeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await makeRuntimeWritable(path);
    else if (entry.isFile()) await chmod(path, 0o600);
  }
}

async function makeRuntimeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeRuntimeReadOnly(path);
      await chmod(path, 0o555);
    } else if (entry.isFile()) {
      await chmod(path, (await stat(path)).mode & 0o555);
    } else {
      throw new Error(`Unexpected Pi distribution entry: ${path}`);
    }
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
  const nodeModules = closures[0]!;
  const executableRelative = relative(nodeModules, executable);
  if (isAbsolute(executableRelative) || executableRelative === ".." || executableRelative.startsWith(`..${sep}`)) throw new Error("Pi executable escapes its installed closure");
  return { nodeModules, executableRelative };
}

function piChildPid(runnerPid: number): number | null {
  // Follow the real runnerd -> proxy -> Pi process tree. Do not infer residency
  // from an in-process mock or from a provider-session file alone.
  const children = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(tail[1]);
      const pid = Number(entry);
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    } catch { /* process exited during the snapshot */ }
  }
  const descendants: number[] = [];
  const visit = (pid: number) => { for (const child of children.get(pid) ?? []) { descendants.push(child); visit(child); } };
  visit(runnerPid);
  return descendants.find(pid => {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase();
      return comm === "pi" || (cmdline.includes("dist/bundle/cli.js") && cmdline.includes("--mode rpc"));
    } catch { return false; }
  }) ?? null;
}

it.skipIf(process.platform !== "linux" || !pi)("keeps one Pi RPC child resident for two turns through runnerd and its production proxy", async () => {
  const { url, requests } = await fakeOpenAiServer();
  const root = await mkdtemp(join(process.env.PI_PROOF_PATH ? dirname(process.env.PI_PROOF_PATH) : tmpdir(), "runnerd-pi-rpc-proof-"));
  if (process.env.PI_DEBUG_ROOT_PATH) await writeFile(process.env.PI_DEBUG_ROOT_PATH, `${root}\n`);
  const workspace = join(root, "workspace");
  const agentDirectory = join(root, "pi-agent");
  await mkdir(workspace);
  await mkdir(agentDirectory);
  await writeFile(join(agentDirectory, "models.json"), JSON.stringify({
    "$schema": "https://pi.dev/schemas/models.schema.json",
    providers: { localFaux: { baseUrl: url, api: "openai-completions", apiKey: "local-only-not-a-real-model-key",
      models: [{ id: "faux", name: "local faux", contextWindow: 8192, maxTokens: 256 }] } },
  }));
  const piPackageRoot = join(root, "pi-package");
  // Reuse the frozen authority fixture's installed closure and official layout.
  const closure = installedPiClosure(pi!);
  await mkdir(piPackageRoot);
  await cp(closure.nodeModules, join(piPackageRoot, "node_modules"), { recursive: true, dereference: true });
  await makeRuntimeReadOnly(piPackageRoot);
  const piExecutable = join(piPackageRoot, "node_modules", closure.executableRelative);
  expect(execFileSync(process.execPath, [piExecutable, "--version"], { encoding: "utf8", timeout: 10_000 }).trim()).toBe("1.5.2");
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
  const diagnostics: string[] = [];
  const notifications: unknown[] = [];
  const { transport } = createRunnerdCodexTransport({
    provider: "pi_rpc", runnerBinary: runner, stateDirectory: join(root, "runner-state"), sourceCodexHome: "",
    providerNodeCommand: process.execPath, providerNodeCommandSha256: digest(process.execPath),
    piCommand: piExecutable, piCommandSha256: digest(piExecutable), piProxyPath: proxy, piProxySha256: digest(proxy),
    piRuntimeDirectory: join(root, "pi-runtime"), piRpcThinkingLevel: "off",
    environment: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDirectory, PI_OFFLINE: "1" },
    onDiagnostic: message => { diagnostics.push(message); },
  });
  const turns: Array<{ turn: number; sentToFirstModelEventMs: number; sentToCompletedMs: number }> = [];
  let primaryError: unknown;
  try {
    const start = await transport.request("thread/start", { cwd: workspace, model: "localFaux/faux" }) as Record<string, unknown>;
    const thread = start.thread as Record<string, unknown> | undefined;
    expect(thread?.sessionId, "actual native Pi session, never a host/thread alias fallback").toBeTypeOf("string");
    const sessionId = String(thread!.sessionId);
    expect(sessionId).not.toBe("");
    const runnerPid = transport.processInfo!().pid;
    if (runnerPid === null) throw new Error("runnerd process PID is missing");
    const pids: Array<number | null> = [piChildPid(runnerPid)];
    const sessionIds = [sessionId];
    const nativeSessionIds: string[] = [];
    for (const [index, prompt] of ["return the first faux reply", "return the second faux reply"].entries()) {
      const turn = index + 1;
      let firstEventAt: number | null = null;
      let terminal: (() => void) | undefined;
      const done = new Promise<void>((resolveDone, reject) => {
        terminal = resolveDone;
        void (async () => {
          try {
            for await (const event of transport.notifications()) {
              notifications.push(event);
              if (event.method === "item/agentMessage/delta" && firstEventAt === null) firstEventAt = performance.now();
              if (event.method === "turn/completed") { terminal?.(); return; }
              if (event.method === "turn/failed") throw new Error(`runnerd turn failed: ${JSON.stringify(event.params)}`);
            }
            throw new Error("runnerd notifications ended before turn completion");
          } catch (error) { reject(error); }
        })();
      });
      const startedAt = performance.now();
      await transport.request("turn/start", { input: [{ type: "text", text: prompt }] });
      await done;
      if (firstEventAt === null) throw new Error("runnerd emitted no model event");
      turns.push({ turn, sentToFirstModelEventMs: firstEventAt - startedAt, sentToCompletedMs: performance.now() - startedAt });
      pids.push(piChildPid(runnerPid));
      const read = await transport.request("thread/read", {});
      const observed = record(read.thread).sessionId;
      expect(observed, "authenticated thread/read must expose actual Pi sessionId").toBeTypeOf("string");
      sessionIds.push(String(observed));
      const journals = (await readdir(join(root, "pi-runtime"))).filter(name => name.endsWith(".jsonl"));
      expect(journals).toHaveLength(1);
      const header = record(JSON.parse(readFileSync(join(root, "pi-runtime", journals[0]!), "utf8").split("\n")[0]!));
      expect(header.type).toBe("session");
      expect(header.id).toBe(sessionId);
      nativeSessionIds.push(String(header.id));
    }
    expect(requests).toEqual(["return the first faux reply", "return the second faux reply"]);
    expect(pids[0]).not.toBeNull();
    expect(pids[1]).toBe(pids[0]);
    expect(pids[2]).toBe(pids[0]);
    expect(sessionIds).toEqual([sessionId, sessionId, sessionId]);
    expect(nativeSessionIds).toEqual([sessionId, sessionId]);
    const proof = { source: "real Rust runnerd -> Pi app-server proxy -> PiRpcDriver -> Pi 1.5.2; local faux OpenAI-compatible streaming server; no real keys",
      runnerPid, piChildPids: { beforeTurn1: pids[0], afterTurn1: pids[1], afterTurn2: pids[2] }, piSessionIds: sessionIds, nativePiSessionIds: nativeSessionIds, root,
      turns, replies: ["local faux reply 1", "local faux reply 2"], requests };
    const proofPath = process.env.PI_PROOF_PATH;
    if (proofPath) await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try { await transport.close(); }
    catch (cleanupError) { if (primaryError) throw new AggregateError([primaryError, cleanupError], "runnerd Pi proof and cleanup failed", { cause: primaryError }); throw cleanupError; }
    finally {
      await writeFile(join(root, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`);
      await writeFile(join(root, "notifications.json"), `${JSON.stringify(notifications, null, 2)}\n`);
      if (!process.env.PI_KEEP_ROOT) {
        await makeRuntimeWritable(piPackageRoot);
        await rm(root, { recursive: true, force: true });
      }
      await Promise.all(servers.splice(0).map(server => new Promise<void>(resolveClose => server.close(() => resolveClose()))));
    }
  }
}, 60_000);
