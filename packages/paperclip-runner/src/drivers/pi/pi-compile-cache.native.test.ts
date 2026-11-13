// Keep reason: Boat's recorded shared-cache EACCES and H29C's refused Pi start.
// expected-skip: PI_TEST_BINARY unset: requires the pinned local Pi 1.5.2 CLI.
// Real Pi RPC via the production driver; controlled loopback inference, no credentials.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiRpcDriver, type PiRpcHarnessSession } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";

const binary = process.env.PI_TEST_BINARY;
const cases = ["private", "unwritable", "absent-cache-directory"] as const;
describe.skipIf(!binary || process.platform === "win32" || process.getuid?.() === 0)("real Pi compile-cache launch policy", () => {
  it.each(cases)("starts 2/2 RPC children with %s cache and an unwritable shared TMPDIR cache", async kind => {
    expect(execFileSync(binary!, ["--version"], { env: { PATH: process.env.PATH, NODE_DISABLE_COMPILE_CACHE: "1" }, encoding: "utf8", timeout: 15_000 }).trim()).toBe("1.5.2");
    const root = await mkdtemp(join(tmpdir(), "pi-cache-proof-"));
    const shared = join(root, "node-compile-cache");
    await mkdir(shared, { mode: 0o555 });
    await expect(writeFile(join(shared, "permission-probe"), "denied")).rejects.toMatchObject({ code: "EACCES" });
    let requests = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        ++requests;
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [delta, finish_reason] of [[{ content: "CACHE_POLICY_OK" }, null], [{}, "stop"]]) {
          response.write(`data: ${JSON.stringify({ id: "cache-proof", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      });
    });
    const proof: Record<string, unknown> = { runtime: "Pi 1.5.2", scenario: kind, noLiveProvider: true, sharedCacheMode: "0555", launches: [], status: "running" };
    const launches = proof.launches as Record<string, unknown>[];
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No loopback port");
      for (let attempt = 1; attempt <= 2; ++attempt) {
        const run = join(root, String(attempt)), home = join(run, "agent"), workspace = join(run, "workspace"), sessions = join(run, "sessions");
        const cache = join(sessions, "node-compile-cache"), probe = join(run, "native-cache.json"), mcpProbe = join(run, "mcp-cache.json");
        await mkdir(join(home, "extensions"), { recursive: true, mode: 0o700 });
        await mkdir(workspace); await mkdir(sessions, { mode: 0o700 });
        if (kind === "unwritable") await mkdir(cache, { mode: 0o500 });
        if (kind === "absent-cache-directory") await writeFile(cache, "directory unavailable: occupied by a file");
        await writeFile(join(home, "settings.json"), JSON.stringify({ packages: [], cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: "never" }));
        await writeFile(join(home, "models.json"), JSON.stringify({ providers: { "cache-proof": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "unused-loopback-placeholder", models: [{ id: "faux" }] } } }));
        // Native stdio MCP must inherit the same policy, not merely Pi itself.
        const mcp = join(run, "cache-mcp.cjs");
        await writeFile(mcp, `const fs=require('node:fs'); const result=require('node:module').enableCompileCache(); fs.writeFileSync(${JSON.stringify(mcpProbe)},JSON.stringify({pid:process.pid,result,cache:process.env.NODE_COMPILE_CACHE,disabled:process.env.NODE_DISABLE_COMPILE_CACHE})); require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line); if(message.id===undefined)return; const result=message.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'cache-policy',version:'1'}}:message.method==='tools/list'?{tools:[]}:{}; console.log(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));});\n`);
        await writeFile(join(home, "mcp.json"), JSON.stringify({ mcpServers: { "cache-policy": { command: process.execPath, args: [mcp], exposure: "direct" } } }));
        // Observe the native Node API INSIDE Pi, not only the driver's env object.
        await writeFile(join(home, "extensions", "cache-probe.ts"), `import {enableCompileCache} from 'node:module'; import {writeFileSync} from 'node:fs'; export default function(pi) { pi.on('session_start', () => writeFileSync(${JSON.stringify(probe)}, JSON.stringify({pid: process.pid, argv: process.argv, result: enableCompileCache(), cache: process.env.NODE_COMPILE_CACHE, disabled: process.env.NODE_DISABLE_COMPILE_CACHE}))); }\n`);
        let transport: PiRpcTransport | undefined, session: PiRpcHarnessSession | undefined;
        let launched: NodeJS.ProcessEnv | undefined;
        const records: PiRpcRecord[] = [];
        const launch: Record<string, unknown> = { attempt, status: "running" }; launches.push(launch);
        try {
          session = await new PiRpcDriver({ command: binary!, model: "cache-proof/faux", piRpcThinkingLevel: "off", runtimeDirectory: sessions, startupTimeoutMs: 15_000, shutdownTimeoutMs: 1000,
            environment: { HOME: run, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", OTEL_SDK_DISABLED: "true", TMPDIR: root, NODE_COMPILE_CACHE: shared, NODE_DISABLE_COMPILE_CACHE: "0" },
            transportFactory(options) {
              launched = options.env;
              launch.command = options.command;
              launch.argv = options.args;
              expect(options.args?.slice(0, 2)).toEqual(["--mode", "rpc"]);
              transport = new PiRpcTransport(options);
              const events = transport.events.bind(transport);
              transport.events = async function* () { for await (const record of events()) { records.push(record); yield record; } };
              return transport;
            },
          }).openSession({ runId: `cache-${kind}-${attempt}`, normalizedSessionId: `cache-${attempt}`, workingDirectory: workspace }) as PiRpcHarnessSession;
          const native = JSON.parse(await readFile(probe, "utf8"));
          launch.native = native;
          if (process.platform === "linux") {
            const commandLine = (await readFile(`/proc/${session.processPid()}/cmdline`, "utf8")).split("\0").filter(Boolean);
            // Pi changes process.title to "pi", which rewrites /proc/cmdline.
            // Its original JS argv is observed by the extension inside Pi.
            launch.processCommandLine = commandLine;
          }
          expect(native.argv[native.argv.indexOf("--mode") + 1]).toBe("rpc");
          expect(native.pid).toBe(session.processPid());
          expect(native.cache).toBe(cache);
          expect(launched?.NODE_COMPILE_CACHE).toBe(cache);
          if (kind === "private") {
            expect(launched?.NODE_DISABLE_COMPILE_CACHE).toBeUndefined();
            expect(native.disabled).toBeUndefined();
            expect([1, 2]).toContain(native.result.status); // ENABLED / ALREADY_ENABLED
            expect(native.result.directory === cache || native.result.directory.startsWith(`${cache}/`)).toBe(true);
          } else {
            expect(launched?.NODE_DISABLE_COMPILE_CACHE).toBe("1");
            expect(native.disabled).toBe("1");
            expect(native.result.status).toBe(3); // DISABLED
          }
          await session.startTurn({ message: { role: "user", text: "prove the resident answers" } });
          let reply = "";
          for await (const event of session.events()) {
            if (event.eventType === "item.completed" && event.payload.kind === "agentMessage") reply = String(event.payload.text);
            if (event.eventType === "turn.completed") break;
            if (["turn.failed", "turn.cancelled"].includes(event.eventType)) throw new Error(JSON.stringify(event));
          }
          expect(reply).toBe("CACHE_POLICY_OK");
          const stdio = JSON.parse(await readFile(mcpProbe, "utf8"));
          expect(stdio.cache).toBe(cache);
          if (kind === "private") {
            expect(stdio.disabled).toBeUndefined();
            expect([1, 2]).toContain(stdio.result.status);
          } else {
            expect(stdio.disabled).toBe("1");
            expect(stdio.result.status).toBe(3);
          }
          Object.assign(launch, { status: "passed", native, stdio, reply, pid: session.processPid() });
        } catch (error) { launch.error = String(error); launch.status = "failed"; throw error; }
        finally {
          await session?.close(); await transport?.close();
          launch.processAbsentAfterClose = !transport?.pid || !existsSync(`/proc/${transport.pid}`);
          launch.records = records;
          expect(launch.processAbsentAfterClose).toBe(true);
          const stdioPid = (launch.stdio as { pid?: number } | undefined)?.pid;
          launch.stdioProcessAbsentAfterClose = !stdioPid || !existsSync(`/proc/${stdioPid}`);
          expect(launch.stdioProcessAbsentAfterClose).toBe(true);
          if (kind === "unwritable") await chmod(cache, 0o700);
        }
      }
      expect(requests).toBe(2);
      expect(await readdir(shared)).toEqual([]);
      proof.status = "passed";
      proof.starts = "2/2";
      proof.requests = requests;
    } catch (error) { proof.status = "failed"; proof.error = String(error); throw error; }
    finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (process.env.PI_COMPILE_CACHE_PROOF_DIRECTORY) {
        await mkdir(process.env.PI_COMPILE_CACHE_PROOF_DIRECTORY, { recursive: true, mode: 0o700 });
        await writeFile(join(process.env.PI_COMPILE_CACHE_PROOF_DIRECTORY, `${kind}.json`), `${JSON.stringify(proof, null, 2)}\n`);
      }
      await chmod(shared, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
