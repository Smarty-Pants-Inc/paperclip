// Keep reason: the real Pi startup/driver boundary must fail visibly, not hang.
// Local Pi 1.5.2 only; no provider request, account, credential, or org data.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PiRpcDriver } from "./pi-rpc-driver.js";
import { PiRpcTransport, type PiRpcRecord } from "./pi-rpc-transport.js";

it("reports a real Pi 1.5.2 session_start exception as a bounded startup failure", async () => {
  const runtime = fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
  expect(JSON.parse(await readFile(join(runtime, "package.json"), "utf8")).version).toBe("1.5.2");
  const root = await mkdtemp(join(tmpdir(), "pi-startup-failure-"));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  await writeFile(join(home, "settings.json"), JSON.stringify({ packages: [], cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: "never" }));
  const injected = join(root, "throw-session-start.ts");
  const extension = fileURLToPath(new URL("./extension/index.ts", import.meta.url));
  // Test-only wrapper of the OWNED host extension's first session_start handler.
  // Its real handler runs, then throws. Pi's real loader/RPC startup owns the outcome.
  await writeFile(injected, `import factory from ${JSON.stringify(extension)};
export default function(pi) {
  let injected = false;
  factory(new Proxy(pi, { get(target, key) {
    if (key !== 'on') return Reflect.get(target, key);
    return (event, handler) => target.on(event, event === 'session_start' && !injected
      ? (injected = true, async (...args) => { await handler(...args); throw new Error('WIRE_SESSION_START_INJECTED'); })
      : handler);
  } }));
}
`);
  let transport: PiRpcTransport | undefined, reading: Promise<void> | undefined;
  const records: PiRpcRecord[] = [];
  const driver = new PiRpcDriver({ command: process.execPath, model: "paperclip/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 15000,
    environment: { HOME: root, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", OTEL_SDK_DISABLED: "true", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:9/v1", PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    transportFactory(options) {
      const args = [...options.args!];
      const index = args.indexOf("--extension"); expect(index).toBeGreaterThanOrEqual(0);
      args[index + 1] = injected;
      // The wrapper replaces the owned entry at the same trusted launch seam.
      transport = new PiRpcTransport({ ...options, fatalSessionStartExtensionPaths: [injected, ...(options.fatalSessionStartExtensionPaths?.slice(1) ?? [])], args: [join(runtime, "dist/bundle/cli.js"), ...args] });
      reading = (async () => { for await (const event of transport!.events()) records.push(event); })().catch(error => { records.push({ type: "reader_failure", message: String(error) }); });
      return transport;
    },
  });
  const started = Date.now();
  let failure = "";
  let openedSession: Awaited<ReturnType<PiRpcDriver["openSession"]>> | undefined;
  try {
    openedSession = await driver.openSession({ runId: "startup-failure", normalizedSessionId: "startup-failure", workingDirectory: workspace });
    throw new Error("Injected startup failure unexpectedly admitted a resident");
  } catch (error) {
    failure = String(error);
    expect(failure).toContain("Pi RPC extension session_start failed");
  } finally {
    let cleanupFailure: string | undefined;
    try { await openedSession?.close(); } catch (error) { cleanupFailure = String(error); }
    await transport?.close(); await reading;
    const elapsedMs = Date.now() - started;
    const proof = { piVersion: "1.5.2", injection: "owned extension session_start handler throws after execution", elapsedMs, residentAdmitted: !!openedSession, driverFailure: failure, pid: transport?.pid, exited: transport?.exited, exitInfo: transport?.exitInfo, processAbsentAfterClose: !transport || !existsSync(`/proc/${transport.pid}`), cleanupFailure, records, noProviderRequests: true };
    if (process.env.PI_STARTUP_FAILURE_EVIDENCE) await writeFile(process.env.PI_STARTUP_FAILURE_EVIDENCE, JSON.stringify(proof, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
    expect(elapsedMs).toBeLessThan(15000);
  }
  expect(transport?.exited).toBe(true);
  expect(transport?.exitInfo).toBeTruthy();
  expect(existsSync(`/proc/${transport!.pid}`)).toBe(false);
  expect(JSON.stringify(records)).toContain("WIRE_SESSION_START_INJECTED");
}, 20000);

it("keeps real Pi 1.5.2 usable after a third-party home session_start exception", async () => {
  const runtime = fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/", import.meta.url));
  expect(JSON.parse(await readFile(join(runtime, "package.json"), "utf8")).version).toBe("1.5.2");
  const root = await mkdtemp(join(tmpdir(), "pi-third-party-startup-"));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(join(home, "extensions"), { recursive: true }); await mkdir(workspace);
  await writeFile(join(home, "settings.json"), JSON.stringify({ packages: [], cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false }, defaultProjectTrust: "never" }));
  const thirdPartyPath = join(home, "extensions", "third-party.ts");
  // A genuine separately discovered home extension, not a wrapper of our factory.
  await writeFile(thirdPartyPath, `export default function(pi) { pi.on('session_start', () => { throw new Error('THIRD_PARTY_SESSION_START_' + 'x'.repeat(8192)); }); }\n`);
  let providerRequests = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      ++providerRequests;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [[{ content: "resident survived third-party startup" }, null], [{}, "stop"]]) {
        response.write(`data: ${JSON.stringify({ id: "startup-proof", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No loopback port");
  // Native custom-provider path: this transport regression needs no managed
  // subagent package/liveness provider or broker capability. The endpoint and
  // nonsecret placeholder key exist only inside this disposable local proof.
  await writeFile(join(home, "models.json"), JSON.stringify({ providers: { "startup-proof": { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "unused-local-proof", models: [{ id: "faux" }] } } }));
  let transport: PiRpcTransport | undefined;
  let session: Awaited<ReturnType<PiRpcDriver["openSession"]>> | undefined;
  const records: PiRpcRecord[] = [];
  const sessionDiagnostics: PiRpcRecord[] = [];
  let failure = "", reply = "", processAliveAfterPrompt = false;
  const started = Date.now();
  const driver = new PiRpcDriver({ command: process.execPath, model: "startup-proof/faux", piRpcThinkingLevel: "off", runtimeDirectory: join(root, "sessions"), startupTimeoutMs: 10000,
    environment: { HOME: root, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", OTEL_SDK_DISABLED: "true" },
    transportFactory(options) {
      transport = new PiRpcTransport({ ...options, args: [join(runtime, "dist/bundle/cli.js"), ...options.args!] });
      const events = transport.events.bind(transport);
      transport.events = async function* () { for await (const record of events()) { records.push(record); yield record; } };
      return transport;
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    session = await driver.openSession({ runId: "third-party-startup", normalizedSessionId: "third-party-startup", workingDirectory: workspace });
    await Promise.race([
      (async () => {
        const events = session!.events()[Symbol.asyncIterator]();
        await session!.startTurn({ message: { role: "user", text: "prove the resident still answers" } });
        while (true) {
          const next = await events.next();
          if (next.done) throw new Error("Resident event stream ended before its answer");
          if (next.value.eventType === "harness.diagnostic") sessionDiagnostics.push(next.value.payload);
          if (next.value.eventType === "item.completed" && next.value.payload.kind === "agentMessage") reply = String(next.value.payload.text);
          if (next.value.eventType === "turn.completed") break;
          if (["turn.failed", "turn.cancelled"].includes(next.value.eventType)) throw new Error(JSON.stringify(next.value));
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Prompt proof timed out")), 10000); }),
    ]);
    processAliveAfterPrompt = !transport!.exited && existsSync(`/proc/${transport!.pid}`);
    expect(reply).toBe("resident survived third-party startup");
    expect(processAliveAfterPrompt).toBe(true);
    expect(providerRequests).toBe(1);
    const diagnostics = records.filter(record => record.type === "extension_error" && record.event === "session_start");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].extensionPath).toBe(thirdPartyPath);
    expect(String(diagnostics[0].error)).toHaveLength(2048);
    expect(JSON.stringify(diagnostics[0]).length).toBeLessThan(3300);
    expect(sessionDiagnostics).toHaveLength(1);
    expect(sessionDiagnostics[0]).toMatchObject({ code: "pi_extension_startup_failed", event: "session_start", extensionPath: thirdPartyPath, message: diagnostics[0].error });
  } catch (error) { failure = String(error); throw error; }
  finally {
    if (timer) clearTimeout(timer);
    let cleanupFailure = "";
    try { await session?.close(); } catch (error) { cleanupFailure = String(error); }
    await transport?.close();
    if (!session && transport) { try { for await (const _record of transport.events()) { /* capture failed admission too */ } } catch { /* expected on the seeded regression */ } }
    await new Promise<void>(resolve => server.close(() => resolve()));
    const proof = { piVersion: "1.5.2", injection: "separate auto-discovered home extension session_start throws", elapsedMs: Date.now() - started, residentAdmitted: !!session, failure, reply, providerRequests, processAliveAfterPrompt, pid: transport?.pid, processAbsentAfterClose: !transport || !existsSync(`/proc/${transport.pid}`), cleanupFailure, diagnostics: records.filter(record => record.type === "extension_error"), sessionDiagnostics, records };
    if (process.env.PI_THIRD_PARTY_STARTUP_EVIDENCE) await writeFile(process.env.PI_THIRD_PARTY_STARTUP_EVIDENCE, JSON.stringify(proof, null, 2) + "\n");
    await rm(root, { recursive: true, force: true });
    expect(cleanupFailure).toBe("");
  }
}, 25000);
