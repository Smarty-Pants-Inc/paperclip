// Keep reason: recorded HqT1/a29fe384 transport failure; native Pi/protocol boundary.
// Only the upstream model is faux. Bash, broker, driver, JSONL, and spills are real.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { connect } from "node:net";
import { expect, it, vi } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "../drivers/pi/pi-rpc-driver.js";
import { PiRpcTransport } from "../drivers/pi/pi-rpc-transport.js";

const binary = process.env.PI_TEST_BINARY;
const out = process.env.PI_LARGE_OUTPUT_OUT;
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const rec = (v: any): Record<string, any> => v && typeof v === "object" ? v : {};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
function identity(pid: number) {
  try { const text = readFileSync(`/proc/${pid}/stat`, "utf8"); const f = text.slice(text.lastIndexOf(")") + 2).split(" "); return { pid, birth: f[19], pgid: Number(f[2]), state: f[0] }; }
  catch (e: any) { if (e.code === "ENOENT" || e.code === "ESRCH") return null; throw e; }
}
async function within<T>(p: Promise<T>, ms = 20_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("native proof event deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}
async function refused(base: string) {
  const u = new URL(base);
  return within(new Promise<string>((done, reject) => {
    const s = connect({ host: u.hostname, port: Number(u.port) });
    s.once("error", (e: any) => done(e.code)); s.once("connect", () => { s.destroy(); reject(new Error("broker still listening")); });
  }), 2000);
}

it.skipIf(!binary || !out)("native Bash large output survives the production PiRpcDriver and broker without losing final results", async () => {
  await mkdir(out!, { recursive: true });
  const root = await mkdtemp(join(out!, "native-"));
  const home = join(root, "agent"), workspace = join(root, "workspace"), temp = join(root, "tmp");
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(temp)]);
  await writeFile(join(workspace, "SKILL.md"), "---\nname: native-output-proof\ndescription: Private installed SDK listing fixture.\n---\nNo real home or client data.\n");
  // One installed SDK package's actual files, not a synthetic file forest and
  // not another full runtime copy. GNU find uses its default no-follow policy.
  const sdk = process.env.PI_NATIVE_RUNTIME_ROOT!;
  const pack = join(home, "provider-pack", "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(dirname(pack), { recursive: true });
  await cp(sdk, pack, { recursive: true, dereference: false });
  const sourcePaths = ["src/live/pi-large-tool-output.integration.test.ts", "src/drivers/pi/pi-rpc-driver.ts", "src/drivers/pi/pi-rpc-transport.ts", "src/drivers/pi/pi-event-projector.ts", "src/drivers/provider-loopback/broker.ts", "src/drivers/acpx/pi-provider-loopback.ts"];
  const proof: Record<string, any> = { schema: 1, status: "running", root, sourceHead: childProcess.execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHashes: Object.fromEntries(sourcePaths.map(p => [p, sha(readFileSync(resolve(p)))])), piSha256: sha(readFileSync(binary!)), model: "paperclip/gpt-5.4", requestedThinking: "xhigh", auth: "none", rust: false, SDKCopy: { source: sdk, target: pack }, cases: [] };
  expect(childProcess.execFileSync(binary!, ["--version"], { encoding: "utf8" }).trim()).toBe("1.5.2");
  const rawPath = join(root, "native-stdout.jsonl");
  const wire: Array<{ type: unknown; bytes: number; tool?: unknown }> = [];
  const transportErrors: string[] = [];
  const requests: Array<Record<string, any>> = [];
  let rawBuffer = Buffer.alloc(0), native: PiRpcTransport | undefined;
  let initialPrivate: { directory: string; socket: string } | undefined;
  const actualSpawn = childProcess.spawn;
  const spy = vi.spyOn(childProcess, "spawn").mockImplementation(((...args: any[]) => {
    const child = (actualSpawn as any)(...args);
    if (args[0] === binary) {
      child.stdout.on("data", (chunk: Buffer) => {
        // Passive exact-byte read tap. Never rewrite, seed, pause, or replay SDK output.
        appendFileSync(rawPath, chunk);
        rawBuffer = Buffer.concat([rawBuffer, chunk]);
        for (;;) {
          const end = rawBuffer.indexOf(10); if (end < 0) break;
          const line = rawBuffer.subarray(0, end); rawBuffer = rawBuffer.subarray(end + 1);
          if (!line.length) continue;
          const r = JSON.parse(line.toString("utf8")); wire.push({ type: r.type, bytes: line.length, tool: r.toolName });
        }
      });
    }
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  let current: { name: string; command: string } | undefined;
  const server = createServer((req, res) => {
    let body = ""; req.setEncoding("utf8"); req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const p = JSON.parse(body); requests.push(p);
        expect(req.url).toBe("/v1/chat/completions"); expect(p.model).toBe("gpt-5.4"); expect(p.reasoning_effort).toBe("xhigh");
        const last = p.messages.at(-1);
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: any, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: `faux-${requests.length}`, object: "chat.completion.chunk", model: "gpt-5.4", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        if (last.role === "tool") { chunk({ role: "assistant", content: "native Bash result received" }); chunk({}, "stop"); }
        else {
          expect(p.tools.some((t: any) => t.function.name === "bash")).toBe(true);
          chunk({ role: "assistant", tool_calls: [{ index: 0, id: `native-${current!.name}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: current!.command, timeout: 15 }) } }] });
          chunk({}, "tool_calls");
        }
        res.end("data: [DONE]\n\n");
      } catch (e) { proof.fauxError = String(e); res.destroy(e as Error); }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const a = server.address(); if (!a || typeof a === "string") throw new Error("faux bind failed");
  let session: PiRpcHarnessSession | undefined, owned: ReturnType<typeof identity> = null;
  const events: any[] = [];
  try {
    session = await new PiRpcDriver({ command: binary, model: "paperclip/gpt-5.4", piRpcThinkingLevel: "xhigh", runtimeDirectory: join(root, "sessions"), systemInstructions: `Native proof instruction root AGENT_HOME=${home}`,
      runtimeContext: { instructions: { workingCopy: { rootPath: home } }, skills: [] },
      // The real registered runner environment must match the current-run grant.
      environment: { AGENT_HOME: home, HOME: root, TMPDIR: temp, PATH: process.env.PATH, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: home, PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${a.port}/v1`, PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none", PAPERCLIP_PI_RPC_CREDENTIAL_MODE: "broker", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost" },
      transportFactory: options => {
        initialPrivate = { directory: dirname(options.env!.PAPERCLIP_PI_BIND_SOCKET!), socket: options.env!.PAPERCLIP_PI_BIND_SOCKET! };
        native = new PiRpcTransport(options);
        const original = native.events.bind(native);
        native.events = () => ({ async *[Symbol.asyncIterator]() {
          try { for await (const r of original()) { if (r.type === "transport_error") transportErrors.push(String(r.message)); yield r; } }
          catch (e) { transportErrors.push(String(e)); throw e; }
        } });
        return native;
      },
    }).openSession({ runId: "native-output", normalizedSessionId: "native-output", workingDirectory: workspace }) as PiRpcHarnessSession;
    owned = identity(session.processPid()!); proof.initialProcess = owned; proof.providerSessionId = session.ids().providerSessionId;
    const iterator = session.events()[Symbol.asyncIterator]();
    const selectedCases = process.env.PI_LARGE_CASES?.split(",");
    const cases = [
      { name: "agent-home", command: "printf '%s\\n' \"$AGENT_HOME\"" },
      { name: "skill-find", command: `cat SKILL.md; cd ${quote(home)}; find . -type f` },
      { name: "seq-200k", command: "seq 1 200000" },
      { name: "ascii-8m", command: "python3 -c 'import sys;sys.stdout.write(\"x\"*8388608)'", expectedBytes: 8388608, expectedSha: sha(Buffer.alloc(8388608, 120)) },
      { name: "small-lines-20m", command: "python3 -c 'import sys;sys.stdout.write(\"x\\n\"*10485760)'", expectedBytes: 20971520, expectedSha: sha(Buffer.from("x\n".repeat(10485760))) },
    ].filter(c => !selectedCases || selectedCases.includes(c.name));
    for (const c of cases) {
      current = c;
      const item: Record<string, any> = { ...c, status: "running", firstRawIndex: wire.length, startedAt: new Date().toISOString() }; proof.cases.push(item);
      try {
        await within(session.startTurn({ message: { role: "user", text: `Execute native Bash scenario ${c.name}` } }));
        const models = JSON.parse(readFileSync(join(home, "models.json"), "utf8"));
        item.broker = models.providers.paperclip.baseUrl;
        for (;;) {
          const n = await within(iterator.next()); if (n.done) throw new Error("native stream ended"); events.push(n.value);
          if (["turn.failed", "turn.cancelled"].includes(n.value.eventType)) {
            item.failureEvent = n.value;
            // The pump's generic turn.failed masks the actual original cause.
            // Its next native driver event retains that cause; observe it before Stop.
            try { const cause = await within(iterator.next(), 2000); if (!cause.done) { events.push(cause.value); item.followingFailureEvent = cause.value; } }
            catch (e) { item.followingFailureReadError = String(e); }
            throw new Error(JSON.stringify(n.value));
          }
          if (n.value.eventType === "turn.completed") break;
        }
        if (c.name === "agent-home") {
          const returned = requests.at(-1)!.messages.at(-1);
          expect(returned.role).toBe("tool");
          item.agentHomeEcho = String(returned.content).trim();
          item.expectedInstructionRoot = home;
          expect(JSON.stringify(requests[0]!.messages)).toContain(`Native proof instruction root AGENT_HOME=${home}`);
          expect(item.agentHomeEcho).toBe(home);
        }
        item.processAfter = identity(session.processPid()!); expect(item.processAfter).toMatchObject({ pid: owned!.pid, birth: owned!.birth, pgid: owned!.pgid });
        expect(session.ids().providerSessionId).toBe(proof.providerSessionId);
        item.brokerAfterCompletion = await refused(item.broker); expect(item.brokerAfterCompletion).toBe("ECONNREFUSED");
        item.status = "passed";
      } catch (e) { item.status = "failed"; item.error = String(e); throw e; }
      finally { item.endedAt = new Date().toISOString(); item.raw = wire.slice(item.firstRawIndex); await writeFile(join(root, "progress.json"), JSON.stringify(proof, null, 2)); }
    }
    proof.status = "passed";
  } catch (e) { proof.status = "failed"; proof.error = String(e); throw e; }
  finally {
    proof.ownedBeforeStop = owned ?? null;
    await writeFile(join(root, "owned-before-stop.json"), JSON.stringify({ owned: owned ?? null, private: initialPrivate }, null, 2));
    await session?.close();
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    spy.mockRestore(); syncBuiltinESMExports();
    proof.transportErrors = transportErrors; proof.wire = wire; proof.partialRawBytes = rawBuffer.length;
    proof.rawMaxBytes = Math.max(0, ...wire.map(r => r.bytes));
    proof.rawCount = wire.length; proof.processAfterClose = owned ? identity(owned.pid) : null;
    proof.privateAfterClose = initialPrivate ? { directory: existsSync(initialPrivate.directory), socket: existsSync(initialPrivate.socket) } : null;
    // Retain the untouched native journal and every native final result/spill.
    // Metadata never replaces full bytes; no truncation or result rewriting.
    const journal = join(root, "sessions", "native-output.jsonl");
    proof.journal = journal;
    const nativeRecords = existsSync(journal) ? readFileSync(journal, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
    const results = nativeRecords.filter(r => r.type === "message" && r.message?.role === "toolResult");
    await writeFile(join(root, "native-final-results.json"), JSON.stringify(results, null, 2));
    proof.nativeThinkingChanges = nativeRecords.filter(r => r.type === "thinking_level_change");
    const paths = new Set<string>();
    const scan = (v: any) => { if (!v || typeof v !== "object") return; for (const [k, x] of Object.entries(v)) { if (["fullOutputPath", "full_output_path"].includes(k) && typeof x === "string") paths.add(x); else if (x && typeof x === "object") scan(x); } };
    scan(nativeRecords); scan(events);
    // All Bash spill files belong to the native test's private TMPDIR.
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile() && e.name.includes("pi-bash")) paths.add(p); } }; walk(temp);
    proof.spills = [...paths].filter(p => existsSync(p)).map(p => { const b = readFileSync(p), s = statSync(p); return { path: p, bytes: b.length, sha256: sha(b), mode: (s.mode & 0o777).toString(8) }; });
    for (const c of proof.cases.filter((c: any) => c.status === "passed" && c.expectedBytes)) {
      c.spillVerified = proof.spills.some((s: any) => s.bytes === c.expectedBytes && s.sha256 === c.expectedSha);
      expect(c.spillVerified, `full native spill retained for ${c.name}`).toBe(true);
    }
    proof.modelRequests = requests.length;
    await writeFile(join(root, "model-requests.json"), JSON.stringify(requests, null, 2));
    await writeFile(join(root, "events.json"), JSON.stringify(events, null, 2));
    await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2));
    await writeFile(join(out!, "latest-root.txt"), root + "\n");
    expect(proof.processAfterClose === null || proof.processAfterClose.birth !== owned?.birth).toBe(true);
    expect(proof.privateAfterClose).toEqual({ directory: false, socket: false });
  }
}, 100_000);
