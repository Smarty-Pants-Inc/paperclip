// AUTHORONLY preparation; run only after the production writer freezes.
// Expected skip: all three opt-ins below are required; normal suites do not
// launch Pi. Keep reason: real dependency/config/process trust-boundary regression.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
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
const packageInput = process.env.PI_COMPAT_SUBAGENTS_ROOT;
const output = process.env.PI_COMPAT_CHILD_OUT;
const modelId = "claude-opus-5-5";
const compat = { forceAdaptiveThinking: true, supportsMidConvoEffort: true,
  supportsMidConvoSystemMessages: true, supportsLongCacheRetention: false };
const systemMarker = "COMPAT_NATIVE_CHILD_SYSTEM_20185";
const taskMarker = "COMPAT_NATIVE_CHILD_TASK_20185";
const parentMarker = "COMPAT_NATIVE_PARENT_TASK_20185";
const childAnswer = "COMPAT_NATIVE_CHILD_FINISHED_20185";
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const jsonl = (values: unknown[]) => values.map(value => JSON.stringify(value)).join("\n") + (values.length ? "\n" : "");
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
type Birth = { pid: number; pgid: number; start: string; state: string; ppid: number };
function identity(pid: number | null): Birth | null {
  if (pid === null) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, pgid: Number(fields[2]), start: fields[19]!, state: fields[0]!, ppid: Number(fields[1]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
const sameBirth = (a: Birth | null, b: Birth) => Boolean(a && a.pid === b.pid && a.start === b.start && a.pgid === b.pgid);
function descendants(pid: number): Birth[] {
  const found: Birth[] = [], seen = new Set<number>([pid]);
  const visit = (parent: number) => {
    let children: string;
    try { children = readFileSync(`/proc/${parent}/task/${parent}/children`, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const value of children.trim().split(/\s+/).filter(Boolean)) {
      const child = Number(value);
      if (seen.has(child)) continue;
      seen.add(child);
      const birth = identity(child);
      if (birth) { found.push(birth); visit(child); }
    }
  };
  visit(pid); return found;
}
function under(root: string, path: string) {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("PI_COMPAT_CHILD_OUT must be beneath TMPDIR, without symlink escape");
}
async function bounded<T>(label: string, pending: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline`)), Math.max(1, ms));
  })]); } finally { clearTimeout(timer); }
}
// Event path is the incoming child request. The only poll is a 25ms /proc
// safety-net while this ONE case owns a live native parent (maximum 60s).
async function waitAbsent(births: Birth[], ms: number) {
  const end = Date.now() + ms;
  while (births.some(birth => sameBirth(identity(birth.pid), birth)) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return births.every(birth => !sameBirth(identity(birth.pid), birth));
}
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "node_modules" || entry.isSymbolicLink()) return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}
type Wire = { raw: string; rawHeaders: string[]; headers: unknown; method?: string; url?: string;
  body?: any; rawSse: string; kind?: string; error?: string; identities?: unknown };

it.skipIf(!binary || !packageInput || !output)("real public pi-subagents child inherits original-HOME compat through managed Pi Messages wire", async () => {
  const temporary = await realpath(tmpdir());
  const destination = isAbsolute(output!) ? output! : join(process.cwd(), output!);
  under(temporary, destination);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const retained = await realpath(destination); under(temporary, retained);
  const root = await mkdtemp(join(retained, "pi-compat-child-"));
  const home = join(root, "home", "user"), runtime = join(root, "run"), agent = join(runtime, "agent");
  const workspace = join(root, "workspace"), scratch = join(root, "tmp");
  const userFile = join(home, ".pi", "agent", "models.json"), modelsFile = join(agent, "models.json");
  for (const path of [dirname(userFile), agent, workspace, scratch, join(agent, "agents")]) await mkdir(path, { recursive: true });
  // EXACT original-HOME source shape of the frozen parent native proof. The
  // driver must generate paperclip metadata; this test never supplies it.
  const original = Buffer.from(json({ providers: { "cliproxyapi-anthropic": {
    api: "anthropic-messages", baseUrl: "http://127.0.0.1:2", apiKey: "fixture-not-a-key",
    models: [{ id: modelId, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, compat }],
  } } }));
  await writeFile(userFile, original, { mode: 0o600 });
  await writeFile(modelsFile, '{"providers":{}}\n', { mode: 0o600 });
  await writeFile(join(root, "original-models.before.json"), original);
  const definition = join(agent, "agents", "compat-child.md");
  await writeFile(definition, `---\nname: compat-child\ndescription: Local wire identity fixture\nmodel: paperclip/${modelId}\nthinking: xhigh\ntools:\nextensions:\ninheritProjectContext: false\ninheritGlobalContext: false\ninheritSkills: false\nsystemPromptMode: replace\ndefaultContext: fresh\nasync: true\ntimeoutMs: 20000\nacceptance: { level: none, reason: local wire fixture }\n---\n${systemMarker}\nReturn only the requested local fixture text.\n`);
  // No installed-home settings copied: a tiny fake runtime fixture only.
  await writeFile(join(agent, "settings.json"), json({ defaultProjectTrust: "no", subagents: { disableBuiltins: true } }));
  await mkdir(join(agent, "extensions", "subagent"), { recursive: true });
  await writeFile(join(agent, "extensions", "subagent", "config.json"), json({ toolActivation: "eager", autoResume: false }));
  const wires: Wire[] = [], events: unknown[] = [], records: PiRpcRecord[] = [], commands: unknown[] = [];
  const observed = new Map<string, Birth>();
  const cleanupErrors: string[] = [];
  const proof: Record<string, any> = { root, home, runtime, agent, workspace, scratch, userFile, modelsFile, definition,
    status: "running", evidenceLevel: "real_dependency_with_controlled_loopback_peer", requestedThinking: "xhigh",
    scope: "public npm pi-subagents only; NOT snapshot parity, tool-cap, Langfuse, or N3 acceptance", cleanupErrors };
  let native: PiRpcTransport | undefined, session: PiRpcHarnessSession | undefined, sessionFile: string | undefined;
  let watch: ReturnType<typeof setInterval> | undefined, watchStop: ReturnType<typeof setTimeout> | undefined;
  let parentStep = 0, childCount = 0, childReplied = false, failure: unknown;
  const remember = () => {
    if (!native?.pid || !sameBirth(identity(native.pid), proof.parentBirth)) return [];
    const births = descendants(native.pid);
    for (const birth of births) observed.set(`${birth.pid}:${birth.start}`, birth);
    return births;
  };
  const persist = async () => {
    proof.descendantBirths = [...observed.values()];
    await writeFile(join(root, "requests.json"), json(wires));
    await writeFile(join(root, "events.jsonl"), jsonl(events));
    await writeFile(join(root, "native-records.jsonl"), jsonl(records));
    await writeFile(join(root, "native-commands.jsonl"), jsonl(commands));
    await writeFile(join(root, "proof.json"), json(proof));
    await writeFile(join(retained, "pi-compat-child-proof.json"), json(proof));
  };
  const peer = createServer((request, response) => {
    const wire: Wire = { method: request.method, url: request.url, headers: { ...request.headers },
      rawHeaders: [...request.rawHeaders], raw: "", rawSse: "" };
    wires.push(wire); request.setEncoding("utf8");
    request.on("data", (chunk: string) => { wire.raw += chunk; });
    request.on("error", error => { wire.error = String(error); response.destroy(); });
    request.on("end", () => {
      try {
        if (wires.length > 8) throw new Error("unexpected extra model request");
        wire.body = JSON.parse(wire.raw);
        const child = JSON.stringify(wire.body.system).includes(systemMarker)
          && JSON.stringify(wire.body.messages).includes(taskMarker);
        wire.kind = child ? "child" : "parent";
        let tool: { name: string; input: unknown; id: string } | undefined;
        let text = childAnswer;
        if (child) {
          childCount++;
          const live = remember().map(birth => {
            try {
              const argv = readFileSync(`/proc/${birth.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
              const env = readFileSync(`/proc/${birth.pid}/environ`, "utf8").split("\0");
              return { ...birth, argv, agentDir: env.find(value => value.startsWith("PI_CODING_AGENT_DIR=")) };
            } catch { return { ...birth, argv: [], agentDir: undefined }; }
          });
          wire.identities = { parent: identity(native?.pid ?? null), descendants: live };
          // The actual detached Node runner is the child Pi session host. Public
          // npm background execution uses the real host SDK there, not a second
          // CLI --mode rpc. Require its installed-package argv and inherited dir.
          proof.childAtRequest = live.filter(birth => birth.argv.some(arg => arg.includes(proof.subagentsRoot))
            && birth.agentDir === `PI_CODING_AGENT_DIR=${agent}`);
          proof.parentAtChildRequest = identity(native?.pid ?? null);
        } else {
          parentStep++;
          if (parentStep === 1) {
            if (!JSON.stringify(wire.body.messages).includes(parentMarker)) throw new Error("unmarked parent request");
            tool = { name: "subagent", id: "compat_child_launch", input: { agent: "compat-child", task: taskMarker,
              async: true, options: { context: "fresh", timeoutMs: 20000, acceptance: false, agentScope: "user",
                sessionDir: join(root, "child-sessions") } } };
          } else if (parentStep === 2) {
            tool = { name: "bg_wait", id: "compat_child_wait", input: { timeoutMs: 20000, stopOnAttention: false } };
          } else {
            if (!childReplied) throw new Error("parent finishing before real child response");
            if (!JSON.stringify(wire.body.messages).includes('"tool_use_id":"compat_child_wait"')) throw new Error("missing public bg_wait tool result in parent wire");
            text = "COMPAT_NATIVE_PARENT_FINISHED_20185";
            proof.parentFinishingBirth = identity(native?.pid ?? null);
          }
        }
        if (tool && !wire.body.tools?.some((entry: any) => entry.name === tool!.name)) throw new Error(`public tool ${tool.name} not declared`);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, fields: Record<string, unknown>) => {
          const bytes = `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
          wire.rawSse += bytes; response.write(bytes);
        };
        event("message_start", { message: { id: `compat-child-${wires.length}`, type: "message", role: "assistant", model: modelId,
          content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 0 } } });
        event("content_block_start", { index: 0, content_block: tool
          ? { type: "tool_use", id: tool.id, name: tool.name, input: {} } : { type: "text", text: "" } });
        event("content_block_delta", { index: 0, delta: tool
          ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text } });
        event("content_block_stop", { index: 0 });
        event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } });
        event("message_stop", {});
        if (child) childReplied = true;
        response.end();
      } catch (error) { wire.error = String(error); response.writeHead(400); response.end("local fixture protocol failure"); }
    });
  });
  peer.requestTimeout = 10_000; peer.headersTimeout = 10_000;
  const deadline = Date.now() + 60_000;
  const operation = <T>(label: string, pending: Promise<T>) => bounded(label, pending, Math.min(25_000, deadline - Date.now()));
  vi.stubEnv("HOME", home); vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
  try {
    expect(process.platform).toBe("linux");
    const executable = await realpath(binary!), packageRoot = dirname(dirname(dirname(executable)));
    const subagentsRoot = await realpath(packageInput!); proof.subagentsRoot = subagentsRoot;
    const extension = join(subagentsRoot, "bundle", "index.js");
    proof.executable = executable; proof.extension = extension;
    proof.piVersion = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
    proof.subagentsVersion = JSON.parse(await readFile(join(subagentsRoot, "package.json"), "utf8")).version;
    const version = await operation("version", promisify(execFile)(executable, ["--version"], { timeout: 8000, cwd: workspace,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" } }));
    proof.cliVersion = version.stdout.trim(); proof.versionStderr = version.stderr;
    expect(proof.piVersion).toBe("1.5.2"); expect(proof.cliVersion).toBe("1.5.2"); expect(proof.subagentsVersion).toBe("0.88.0");
    proof.packageHashes = files(subagentsRoot).sort().map(path => ({ path, sha256: sha(path) }));
    proof.sourceHashes = [executable, join(packageRoot, "package.json"),
      join(dirname(packageRoot), "pi-ai", "dist", "api", "anthropic-messages.js"),
      ...["./pi-compat-child.native.test.ts", "./pi-rpc-driver.ts", "./pi-rpc-transport.ts", "./pi-managed-model.ts", "./pi-models-merge.ts"]
        .map(path => fileURLToPath(new URL(path, import.meta.url)))].map(path => ({ path, sha256: sha(path) }));
    await operation("peer listen", new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(0, "127.0.0.1", resolve); }));
    const address = peer.address(); if (!address || typeof address === "string") throw new Error("loopback peer did not bind");
    proof.peerUrl = `http://127.0.0.1:${address.port}`;
    session = await operation("driver open", new PiRpcDriver({ command: executable, model: `paperclip/${modelId}`, piRpcThinkingLevel: "xhigh",
      runtimeDirectory: runtime, startupTimeoutMs: 10000, promptTimeoutMs: 25000, shutdownTimeoutMs: 1000, killTimeoutMs: 1000,
      environment: { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*",
        PI_SUBAGENTS_TEMP_ROOT: join(root, "subagents"), PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: packageRoot,
        PAPERCLIP_AI_PROVIDER_URL: proof.peerUrl, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
      transportFactory: options => {
        // Real transport, unchanged except explicit public CLI extension argv and
        // observation. --no-extensions suppresses discovery, not explicit -e.
        const args = [...(options.args ?? []), "--extension", extension];
        proof.launch = { command: options.command, args, HOME: options.env?.HOME, PI_CODING_AGENT_DIR: options.env?.PI_CODING_AGENT_DIR };
        native = new PiRpcTransport({ ...options, args, requestTimeoutMs: 25000 });
        proof.parentBirth = identity(native.pid);
        const request = native.request.bind(native);
        native.request = async (type, params, requestOptions) => {
          const command: Record<string, unknown> = { type, params, requestOptions }; commands.push(command);
          try { const result = await request(type, params, requestOptions); command.result = result; return result; }
          catch (error) { command.error = String(error); throw error; }
        };
        const stream = native.events.bind(native);
        native.events = () => ({ async *[Symbol.asyncIterator]() { for await (const record of stream()) { records.push(record); yield record; } } });
        watch = setInterval(() => { try { remember(); } catch (error) { cleanupErrors.push(String(error)); } }, 25);
        watchStop = setTimeout(() => clearInterval(watch), 60_000);
        return native;
      },
    }).openSession({ runId: "child-proof", normalizedSessionId: "compat-real-child", workingDirectory: workspace,
      signal: AbortSignal.timeout(12000) })) as PiRpcHarnessSession;
    sessionFile = (await operation("snapshot", session.snapshot())).sessionFile; proof.sessionFile = sessionFile;
    proof.initialState = (await operation("state", native!.request("get_state"))).data;
    const iterator = session.events()[Symbol.asyncIterator]();
    await operation("prompt", session.startTurn({ message: { role: "user", text: `${parentMarker}: use compat-child once, wait for its result, then finish.` } }));
    for (;;) {
      const next = await operation("settlement", iterator.next());
      if (next.done) throw new Error("event stream ended before parent settlement");
      events.push(next.value);
      if (next.value.eventType === "turn.failed") throw new Error(JSON.stringify(next.value));
      if (next.value.eventType === "turn.completed") break;
    }
    proof.generatedModels = JSON.parse(await readFile(modelsFile, "utf8"));
    proof.childAbsentAfterToolCompletion = await waitAbsent(proof.childAtRequest ?? [], 3000);
    await copyFile(sessionFile, join(root, "parent-session.jsonl"));
    proof.retainedNativeJsonl = files(root).filter(path => path.endsWith(".jsonl"));
    await persist(); // Both native requests and completed tool result survive RED.
    expect(wires.filter(wire => wire.kind === "child")).toHaveLength(1);
    expect(childCount).toBe(1); expect(parentStep).toBe(3);
    expect(proof.childAtRequest, "one unambiguous real live detached Pi child required").toHaveLength(1);
    expect(proof.childAtRequest[0].state).not.toBe("Z");
    expect(proof.parentFinishingBirth).toMatchObject({ pid: proof.parentBirth.pid, pgid: proof.parentBirth.pgid, start: proof.parentBirth.start });
    expect(proof.parentAtChildRequest).toMatchObject({ pid: proof.parentBirth.pid, pgid: proof.parentBirth.pgid, start: proof.parentBirth.start });
    expect(proof.childAbsentAfterToolCompletion).toBe(true);
    expect(proof.launch.HOME).toBe(home); expect(proof.launch.PI_CODING_AGENT_DIR).toBe(agent);
    expect(proof.generatedModels.providers.paperclip.models[0]).toMatchObject({ id: modelId, compat });
    expect(proof.initialState).toMatchObject({ thinkingLevel: "xhigh", model: { provider: "paperclip", id: modelId, compat } });
    for (const wire of wires) {
      expect(wire.error).toBeUndefined(); expect(wire.method).toBe("POST"); expect(wire.url).toBe("/v1/messages?beta=true");
      expect(wire.body).toMatchObject({ model: modelId, stream: true, thinking: { type: "adaptive" } });
      expect(wire.body.thinking.budget_tokens).toBeUndefined();
      expect(wire.body.messages.at(-1)).toMatchObject({ role: "system", output_config: { effort: "xhigh" } });
    }
    const childLogs = files(join(root, "child-sessions")).filter(path => path.endsWith(".jsonl"));
    proof.childNativeJsonl = childLogs.filter(path => readFileSync(path, "utf8").includes(taskMarker)
      && readFileSync(path, "utf8").includes(childAnswer));
    expect(proof.childNativeJsonl.length, "separate native child session JSONL required, not RPC observation logs").toBeGreaterThan(0);
    const childEntries = proof.childNativeJsonl.flatMap((path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line)));
    expect(childEntries.some((entry: any) => entry.type === "thinking_level_change" && entry.thinkingLevel === "xhigh"), "public agent thinking xhigh persisted natively").toBe(true);
    proof.status = "passed";
  } catch (error) { failure = error; proof.status = "failed"; proof.error = String(error); }
  finally {
    clearInterval(watch); clearTimeout(watchStop);
    try { remember(); } catch (error) { cleanupErrors.push(String(error)); }
    if (session) try { await bounded("session close", session.close(), 6000); } catch (error) { cleanupErrors.push(String(error)); }
    if (native) try { await bounded("native close", native.close(), 4000); } catch (error) { cleanupErrors.push(String(error)); }
    // Detached public runners may outlive their parent on failure. Signal only
    // remembered descendants whose exact PID/PGID/start still matches. Never
    // scan the host, kill by name, or signal a potentially reused process group.
    const births = [...observed.values()];
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const birth of births) if (sameBirth(identity(birth.pid), birth)) {
        try { process.kill(birth.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupErrors.push(String(error)); }
      }
      await waitAbsent(births, 1000);
    }
    peer.closeAllConnections();
    if (peer.listening) try { await bounded("peer close", new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve())), 3000); }
    catch (error) { cleanupErrors.push(String(error)); }
    proof.parentAfterClose = identity(native?.pid ?? null); proof.parentExited = native?.exited; proof.exit = native?.exitInfo;
    proof.parentBirthAbsent = Boolean(proof.parentBirth) && !sameBirth(proof.parentAfterClose, proof.parentBirth);
    proof.descendantBirthsAbsent = births.every(birth => !sameBirth(identity(birth.pid), birth));
    proof.descendantsAfterClose = births.map(birth => ({ birth, now: identity(birth.pid) }));
    try {
      const after = await readFile(userFile); proof.originalUnchanged = after.equals(original);
      await writeFile(join(root, "original-models.after.json"), after);
      await copyFile(modelsFile, join(root, "managed-models.after.json"));
      if (sessionFile) await copyFile(sessionFile, join(root, "native-parent.final.jsonl"));
      proof.retainedNativeJsonl = files(root).filter(path => path.endsWith(".jsonl"));
    } catch (error) { cleanupErrors.push(String(error)); }
    vi.unstubAllEnvs();
    if (cleanupErrors.length || !proof.parentBirthAbsent || !proof.parentExited || !proof.descendantBirthsAbsent || !proof.originalUnchanged) proof.status = "failed";
    await persist();
    try {
      expect(cleanupErrors).toEqual([]); expect(proof.parentExited).toBe(true); expect(proof.parentBirthAbsent).toBe(true);
      expect(proof.descendantBirthsAbsent, "all exact owned child births absent, even on RED").toBe(true);
      expect(proof.originalUnchanged).toBe(true);
    } catch (error) { failure = failure ? new AggregateError([failure, error], "compat assertion and cleanup failed") : error; }
  }
  if (failure) throw failure;
}, 90_000);
