// Keep reason: the real Pi startup/driver boundary must fail visibly, not hang.
// Local Pi 1.5.2 only; no provider request, account, credential, or org data.
import { existsSync } from "node:fs";
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
      transport = new PiRpcTransport({ ...options, args: [join(runtime, "dist/bundle/cli.js"), ...args] });
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
