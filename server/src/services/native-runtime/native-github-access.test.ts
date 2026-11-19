import { afterEach, expect, it, vi } from "vitest";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { promisify } from "node:util";
import type { CommandManagedDuplexChannel, CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { DuplexObservabilityRecorder } from "@paperclipai/adapter-utils/duplex-observability";
import { startAdapterExecutionTargetPaperclipBridge } from "@paperclipai/adapter-utils/execution-target";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createNativeGitHubAccess, type NativeGitHubAccess } from "./native-github-access.js";
import { createNativeRunTrace, type NativeRunTrace } from "./native-run-trace.js";
import { OpenCodeServerDriver } from "@paperclipai/paperclip-runner";
import { createCapabilityRunnerdProviderEnvironment } from "@paperclipai/paperclip-runner/live";
const scope = { companyId: "company-a", agentId: "agent-a", issueId: "task-a" };
const run = (runId: string) => ({ ...scope, runId });
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function localDuplexChannel(command: readonly string[], cwd: string,
  drop?: "readiness" | "preface"): CommandManagedDuplexChannel {
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const buffered: Buffer[] = [];
  let dataListener: ((chunk: Uint8Array) => void) | undefined;
  let exitListener: ((exit: { exitCode: number | null }) => void) | undefined;
  let exit: { exitCode: number | null } | undefined;
  child.stdin.on("error", () => undefined);
  child.stderr.resume();
  let readyLine = Buffer.alloc(0);
  let sentReadyLine = false;
  child.stdout.on("data", (raw: Buffer) => {
    if (drop === "readiness") return;
    let chunk = raw;
    if (drop === "preface") {
      if (sentReadyLine) return;
      readyLine = Buffer.concat([readyLine, raw]);
      const newline = readyLine.indexOf(10);
      if (newline < 0) return;
      sentReadyLine = true;
      chunk = readyLine.subarray(0, newline + 1);
    }
    if (dataListener) dataListener(chunk);
    else buffered.push(chunk);
  });
  const closed = new Promise<void>(resolve => child.once("close", code => {
    exit = { exitCode: code };
    exitListener?.(exit);
    resolve();
  }));
  return {
    write: data => { child.stdin.write(data); },
    onData: listener => { dataListener = listener; for (const chunk of buffered.splice(0)) listener(chunk); },
    onExit: listener => { exitListener = listener; if (exit) listener(exit); },
    stop: () => { child.kill(); },
    close: async () => { child.kill(); await closed; },
  };
}
async function broker(resolveCredentials = vi.fn(async (binding: ReturnType<typeof run>) => ({
  status: "available", env: { GH_TOKEN: `fixture-${binding.runId}` },
})), remote = false, bridgeUnavailable = false, onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
duplex?: { enabled?: boolean; capability: boolean; unavailable?: boolean; recorder?: DuplexObservabilityRecorder;
  drop?: "readiness" | "preface" }, rpcLatencyMs = 0,
onCommand?: (input: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => Promise<void>,
onBridgeStarted?: (bridge: Awaited<ReturnType<typeof startAdapterExecutionTargetPaperclipBridge>>) => Promise<void>,
diagnostics?: { getTrace: () => NativeRunTrace | undefined; resolvePath?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "native-github-reuse-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "real-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), `#!${process.execPath}\nprocess.stdout.write(process.env.GH_TOKEN || 'anonymous');`, { mode: 0o700 });
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async (input) => {
    const startedAt = new Date().toISOString();
    if (rpcLatencyMs) await new Promise(resolve => setTimeout(resolve, rpcLatencyMs));
    await onCommand?.(input);
    const child = promisify(execFile)(input.command, input.args ?? [], {
      cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    child.child.stdin?.on("error", () => undefined);
    child.child.stdin?.end(input.stdin ?? "");
    const result = await child;
    return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
  });
  const openDuplexChannel = vi.fn<NonNullable<CommandManagedRuntimeRunner["openDuplexChannel"]>>(async input => {
    if (duplex?.unavailable) throw new Error("fixture channel unavailable");
    return localDuplexChannel(input.command, root, duplex?.drop);
  });
  const target = remote ? { kind: "remote" as const, transport: "sandbox" as const, providerKey: "test",
    remoteCwd: root, runner: { execute, ...(duplex ? { openDuplexChannel } : {}) }, streamRunLogs: false,
    ...(duplex ? { enableSandboxDuplexBridge: duplex.enabled, duplexObservabilityRecorder: duplex.recorder, effectiveCapabilities: {
      reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false,
      independentControlCommands: true, incrementalSessionOutput: false, concurrentSyncOperations: false,
      duplexCommandStream: duplex.capability, runnerWebSocketIngress: false,
    } } : {}) } : null;
  const bridgeModes: (string | undefined)[] = [];
  const result = await createNativeGitHubAccess({ scope, target, cwd: root,
    env: { ...(diagnostics?.resolvePath ? {} : { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }),
      PAPERCLIP_API_KEY: "old-run-api-key" }, resolveCredentials, onLog, trace: diagnostics?.getTrace() },
    bridgeUnavailable ? async () => { throw new Error("fixture bridge unavailable"); } : async input => {
      const bridge = await startAdapterExecutionTargetPaperclipBridge({ ...input,
        ...(duplex?.drop ? { duplexReadinessTimeoutMs: 500 } : {}),
      });
      bridgeModes.push(bridge?.env.PAPERCLIP_API_BRIDGE_MODE);
      await onBridgeStarted?.(bridge);
      return bridge;
    });
  cleanups.push(result.stop);
  return Object.assign(result, { root, resolveCredentials, execute, openDuplexChannel, bridgeModes });
}
function request(broker: NativeGitHubAccess, extra: RequestInit = {}, endpoint = "/runtime-tools/github/credentials") {
  return fetch(broker.env.PAPERCLIP_GITHUB_BROKER_URL + endpoint, {
    method: "POST", body: "{}", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, "content-type": "application/json" }, ...extra,
  });
}
it.each([false, true])("resolves managed GitHub credentials from OpenCode shell operations (runner projection: %s)", async throughRunner => {
  const b = await broker();
  const command = path.join(b.root, "fake-opencode-server.mjs");
  const fixture = new URL("../../../../packages/paperclip-runner/test/fixtures/fake-opencode-server.mjs", import.meta.url);
  await writeFile(command, await readFile(fixture), { mode: 0o700 });
  const source = { ...b.env, OPENROUTER_API_KEY: "fixture-provider-key", PAPERCLIP_API_KEY: "controller-must-not-cross" };
  const environment = throughRunner ? createCapabilityRunnerdProviderEnvironment({
    provider: "opencode",
    options: { environment: source, stateDirectory: b.root },
    identity: { runnerInstanceId: "runner-a", environmentLeaseId: "lease-a", runId: "a", normalizedSessionId: "github", turnId: "turn-a", itemId: "item-a" },
    codexHome: path.join(b.root, "codex-home"),
    runtimeContextPath: path.join(b.root, "context.json"),
    hasRuntimeContext: false,
  }) : source;
  const driver = new OpenCodeServerDriver({
    model: "openrouter/z-ai/glm-5.3", runtimeDirectory: b.root, command, environment,
  });
  const session = await driver.openSession({ runId: "a", normalizedSessionId: "github", workingDirectory: b.root });
  cleanups.push(() => session.close({ reason: "test complete" }));
  const operate = async () => {
    await session.startTurn({ message: { role: "user", text: "managed-github-operation" } });
    for await (const event of session.events()) {
      if (event.eventType === "turn.completed") break;
      if (event.eventType === "turn.failed") throw new Error("OpenCode fixture turn failed");
    }
    return JSON.parse(await readFile(path.join(b.root, "github", "data", "fake-github-operation.json"), "utf8"));
  };
  const releaseA = await b.activate(run("a"));
  expect(await operate()).toMatchObject({ stdout: "fixture-a", error: null });
  await releaseA();
  const releaseB = await b.activate(run("b"));
  expect(await operate()).toMatchObject({ stdout: "fixture-b", error: null });
  await releaseB();
  expect(await operate()).toMatchObject({ stdout: "anonymous", error: null });
  expect(b.resolveCredentials.mock.calls.map(([binding]) => binding.runId)).toEqual(["a", "b"]);
  const childEnvironment = JSON.parse(await readFile(path.join(b.root, "github", "data", "fake-environment.json"), "utf8"));
  expect(childEnvironment.keys).not.toContain("PAPERCLIP_API_KEY");
  expect(childEnvironment.githubTokenPresent).toBe(false);
}, 30000);
it("uses the selected duplex transport across credential rotation without file polling", async () => {
  const recorder = { recordSpan: vi.fn(), incrementCounter: vi.fn(), emitEvent: vi.fn() };
  const b = await broker(undefined, true, false, undefined, { enabled: true, capability: true, recorder });
  expect(b.bridgeModes).toEqual(["http2_v1"]);
  expect(b.openDuplexChannel).toHaveBeenCalledOnce();
  expect(recorder.recordSpan).toHaveBeenCalledWith(expect.objectContaining({ name: "sandbox.duplex.channel_open", dimensions: {
    provider: "other", transport: "http2", outcome: "ok",
  } }));
  const commandsAfterStartup = b.execute.mock.calls.length;
  expect((await request(b)).status).toBe(403);
  const releaseA = await b.activate(run("a"));
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-a" } });
  await releaseA();
  expect((await request(b)).status).toBe(403);
  const releaseB = await b.activate(run("b"));
  await releaseA();
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-b" } });
  expect(b.resolveCredentials.mock.calls.map(([binding]) => binding.runId)).toEqual(["a", "b"]);
  expect(recorder.recordSpan).toHaveBeenCalledWith(expect.objectContaining({ name: "sandbox.duplex.request" }));
  expect(recorder.emitEvent).not.toHaveBeenCalledWith(expect.objectContaining({ dimensions: expect.objectContaining({ transport: "file" }) }));
  // HTTP/2 attaches and detaches are fenced by the gateway's run-state marker;
  // each transition performs one bounded control write, with no queue polling.
  expect(b.execute.mock.calls).toHaveLength(commandsAfterStartup + 3);
  await releaseB();
  await b.stop();
  await expect(b.activate(run("c"))).rejects.toThrow("closed");
});
it("marks a lost HTTP/2 bridge unavailable before the next warm admission", async () => {
  const b = await broker(undefined, true, false, undefined, { enabled: true, capability: true });
  const release = await b.activate(run("a"));
  expect((await request(b)).status).toBe(200);
  await release();
  expect(b.ready).toBe(true);
  const channel = await b.openDuplexChannel.mock.results[0]!.value;
  channel.stop();
  await vi.waitFor(() => expect(b.ready).toBe(false), { timeout: 2000 });
});
it("closes a healthy HTTP/2 bridge without reporting a lost active run", async () => {
  const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => undefined);
  const b = await broker(undefined, true, false, onLog, { enabled: true, capability: true });
  const release = await b.activate(run("a"));
  expect((await request(b)).status).toBe(200);
  await release();
  await b.stop();
  expect(b.ready).toBe(false);
  expect(onLog.mock.calls.filter(([, chunk]) => chunk.includes("channel lost"))).toEqual([]);
});
it.each([
  { enabled: false, capability: true, unavailable: false, opens: 0 },
  { enabled: undefined, capability: true, unavailable: false, opens: 0 },
  { enabled: true, capability: false, unavailable: false, opens: 0 },
  { enabled: true, capability: true, unavailable: true, opens: 1 },
])("retains authorized file fallback with duplex settings %j", async options => {
  const b = await broker(undefined, true, false, undefined, options);
  expect(b.bridgeModes).toEqual(["queue_v1"]);
  expect(b.openDuplexChannel).toHaveBeenCalledTimes(options.opens);
  const release = await b.activate(run("fallback"));
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-fallback" } });
  await release();
  expect((await request(b)).status).toBe(503);
});
it.each([false, true])("keeps one live parent and its original launcher environment across two authorized runs (callback bridge: %s)", async (remote) => {
  const b = await broker(undefined, remote);
  const parent = spawn(process.execPath, ["-e", `
    const {execFile}=require('node:child_process');
    require('node:readline').createInterface({input:process.stdin}).on('line', () => {
      execFile('gh', [], (error, stdout, stderr) => console.log(JSON.stringify({pid:process.pid, value:stdout, error:error?.message, stderr})));
    });
  `], { env: { ...process.env, ...b.env, PAPERCLIP_API_KEY: "stale-api-key" }, stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(async () => { const exited = new Promise<void>(resolve => parent.once("exit", () => resolve())); parent.kill(); await exited; });
  const lines = createInterface({ input: parent.stdout });
  const operation = () => new Promise<{ pid: number; value: string; stderr: string }>(resolve => {
    lines.once("line", line => resolve(JSON.parse(line))); parent.stdin.write("run\n");
  });
  // Startup with no run satisfies upstream's startup probe: 403, not the
  // detached-queue 503 reserved for a run transition after detach.
  expect((await request(b)).status).toBe(403);
  const releaseA = await b.activate(run("run-a"));
  const a = await operation();
  expect(a.value).toBe("fixture-run-a");
  await releaseA();
  expect((await request(b)).status).toBe(remote ? 503 : 403);
  expect((await operation()).value).toBe("anonymous");
  const releaseB = await b.activate(run("run-b"));
  await releaseA(); // A's delayed cleanup cannot revoke B.
  const second = await operation();
  expect(second.value).toBe("fixture-run-b");
  expect(second.pid).toBe(a.pid);
  expect(b.resolveCredentials.mock.calls.map(([binding]) => binding.runId)).toEqual(["run-a", "run-b"]);
  expect(await readFile(path.join(b.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), "utf8")).not.toContain(b.env.PAPERCLIP_GITHUB_BROKER_TOKEN);
  await releaseB(); await b.stop();
  await expect(access(b.env.PAPERCLIP_GITHUB_LAUNCHER_DIR)).rejects.toThrow();
}, 45_000);
// Keep reason: independent control preparation must overlap and never leak a late bridge.
it("stages token-free launchers while the real bridge entrypoint RPC is pending", async () => {
  let releaseBridge!: () => void;
  const pendingBridge = new Promise<void>(resolve => { releaseBridge = resolve; });
  let bridgeStarted = false, launchersStarted = false;
  const creating = broker(undefined, true, false, undefined, undefined, 0, async input => {
    if (input.args?.some(arg => arg.includes(".paperclip-bridge-upload.lock"))) {
      bridgeStarted = true;
      await pendingBridge;
    }
    if (input.stdin?.includes("GitHub operation launcher")) launchersStarted = true;
  });
  try {
    await vi.waitFor(() => {
      expect(bridgeStarted).toBe(true);
      expect(launchersStarted).toBe(true);
    }, { timeout: 1000 });
  } finally { releaseBridge(); await creating; }
  const b = await creating;
  expect((await request(b)).status).toBe(403);
  const release = await b.activate(run("parallel"));
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-parallel" } });
  await release();
});

it("joins and closes a late real bridge when parallel launcher staging fails", async () => {
  let releaseBridge!: () => void;
  const pendingBridge = new Promise<void>(resolve => { releaseBridge = resolve; });
  let bridgeStarted = false, launcherFailed = false, settled = false;
  let bridgeFinished!: () => void;
  const observedBridge = new Promise<void>(resolve => { bridgeFinished = resolve; });
  let bridgeUrl: string | undefined, directory: string | undefined;
  const creating = broker(undefined, true, false, undefined, undefined, 0, async input => {
    if (input.args?.some(arg => arg.includes(".paperclip-bridge-upload.lock"))) {
      bridgeStarted = true;
      await pendingBridge;
    }
    if (input.stdin?.includes("GitHub operation launcher")) {
      launcherFailed = true;
      throw new Error("injected launcher staging failure");
    }
  }, async bridge => {
    bridgeUrl = bridge!.env.PAPERCLIP_API_URL;
    directory = path.dirname(path.dirname(bridge!.env.PAPERCLIP_BRIDGE_QUEUE_DIR!));
    cleanups.push(async () => { bridge?.markOrderlyCompletion?.(); await bridge?.stop(); });
    bridgeFinished();
  }).then(value => { settled = true; return value; }, error => { settled = true; return error as Error; });
  try {
    await vi.waitFor(() => {
      expect(bridgeStarted).toBe(true);
      expect(launcherFailed).toBe(true);
    }, { timeout: 1000 });
    expect(settled).toBe(false);
  } finally { releaseBridge(); await creating; await observedBridge; }
  expect(await creating).toMatchObject({ message: "injected launcher staging failure" });
  expect(bridgeUrl).toBeDefined();
  await expect(fetch(bridgeUrl!)).rejects.toThrow();
  await expect(access(directory!)).rejects.toThrow();
});

// Keep reason: real-shell restore bridge RPC budget, with per-RPC transport latency.
it("bounds non-warm GitHub preparation and activation over a real shell at 150ms per RPC", async () => {
  const startedAt = performance.now();
  const b = await broker(undefined, true, false, undefined, undefined, 150);
  const accessMs = performance.now() - startedAt;
  const accessRpcs = b.execute.mock.calls.length;
  expect(b.ready).toBe(true);
  expect((await request(b)).status).toBe(403);
  const activatingAt = performance.now();
  const release = await b.activate(run("restored"));
  const activationMs = performance.now() - activatingAt;
  // Includes the first runtime long-list dispatch. resume waits for dispatch,
  // NOT for that list's five-second idle window to finish.
  const activationRpcs = b.execute.mock.calls.length - accessRpcs;
  console.log(JSON.stringify({ row: "non-warm-github-150ms", accessRpcs, accessMs: Math.round(accessMs),
    activationRpcs, activationMs: Math.round(activationMs), firstPollIncluded: true }));
  expect.soft(accessRpcs).toBeLessThanOrEqual(4);
  expect.soft(activationRpcs).toBeLessThanOrEqual(3);
  // The actual gateway, worker and authenticated broker must still serve work.
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-restored" } });
  await release();
  expect((await request(b)).status).toBe(503);
}, 30000);

it("rejects other scopes, concurrent bindings, browser requests and forged authority", async () => {
  const b = await broker();
  for (const field of ["companyId", "agentId", "issueId"] as const) {
    await expect(b.activate({ ...run("a"), [field]: "other" })).rejects.toThrow("scope mismatch");
  }
  const release = await b.activate(run("a"));
  await expect(b.activate(run("b"))).rejects.toThrow("busy");
  const rejectedHeaders: Record<string, string>[] = [{ authorization: "Bearer wrong" }, { authorization: "é".repeat(71) },
    { authorization: `Bearer ${b.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, origin: "https://browser.test" }];
  for (const headers of rejectedHeaders) {
    expect((await request(b, { headers })).status).toBe(403);
  }
  expect((await request(b, {}, "/api/companies")).status).toBe(404);
  expect((await request(b, { method: "GET", body: undefined })).status).toBe(404);
  const response = await request(b, { body: JSON.stringify({ runId: "b", responsibleUserId: "other" }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(b.resolveCredentials).toHaveBeenCalledExactlyOnceWith(run("a"));
  await release(); await b.stop();
  await expect(b.activate(run("b"))).rejects.toThrow("closed");
});
it("does not release an in-flight credential after its run has been replaced", async () => {
  let complete!: (value: { status: string; env: { GH_TOKEN: string } }) => void;
  const resolver = vi.fn(() => new Promise<{ status: string; env: { GH_TOKEN: string } }>(resolve => { complete = resolve; }));
  const b = await broker(resolver);
  const release = await b.activate(run("a"));
  const pending = request(b);
  await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
  await release(); await b.activate(run("b"));
  complete({ status: "available", env: { GH_TOKEN: "must-not-escape" } });
  const response = await pending;
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("must-not-escape");
});
it.each([403, 409, 500])("preserves denial/steering without leaking errors (%s)", async (status) => {
  const b = await broker(vi.fn(async () => { throw Object.assign(new Error("secret-value"), { status }); }));
  await b.activate(run("a"));
  const response = await request(b);
  expect(response.status).toBe(status === 500 ? 503 : status);
  expect(await response.text()).not.toContain("secret-value");
});

it.each([false, true])("keeps anonymous launchers usable when the remote broker cannot start (logging fails: %s)", async (loggingFails) => {
  const onLog = vi.fn(async () => { if (loggingFails) throw new Error("fixture log sink unavailable"); });
  const b = await broker(undefined, true, true, onLog);
  expect(onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("continuing without managed GitHub access"));
  await b.activate(run("a"));
  expect(b.ready).toBe(false);
  expect(b.env.PAPERCLIP_GITHUB_BROKER_TOKEN).toBe("");
  const result = await promisify(execFile)(path.join(b.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), [], {
    env: { ...process.env, ...b.env, GH_TOKEN: "ambient-must-not-leak" },
  });
  expect(result.stdout).toBe("anonymous");
  expect(b.resolveCredentials).not.toHaveBeenCalled();
});

// Keep reason: distinguish every duplex decision in the native run stream, not only OTLP.
it.each([
  { label: "gate_off", duplex: { enabled: false, capability: true }, expected: ["gate_off"], failed: undefined },
  { label: "capability_absent", duplex: { enabled: true, capability: false }, expected: ["capability_absent"], failed: undefined },
  { label: "open_failure", duplex: { enabled: true, capability: true, unavailable: true }, expected: ["channel_open", "fallback"], failed: "channel_open" },
  { label: "http2_ready", duplex: { enabled: true, capability: true }, expected: ["channel_open", "ready_wait", "preface_wait"], failed: undefined },
  { label: "ready_timeout", duplex: { enabled: true, capability: true, drop: "readiness" as const }, expected: ["channel_open", "ready_wait", "fallback"], failed: "ready_wait" },
  { label: "preface_timeout", duplex: { enabled: true, capability: true, drop: "preface" as const }, expected: ["channel_open", "ready_wait", "preface_wait", "fallback"], failed: "preface_wait" },
])("names real-shell GitHub duplex branch $label", async ({ label, duplex, expected, failed }) => {
  const events: Record<string, unknown>[] = [];
  const trace = createNativeRunTrace({ runId: label, onEvent: async event => {
    if (event.eventType === "run.performance.span") events.push(event.payload!);
  } });
  try {
    const b = await trace.measure("native.controller.github_access", () =>
      broker(undefined, true, false, undefined, duplex, 0, undefined, undefined, { getTrace: () => trace }));
    const release = await trace.measure("native.controller.github_activate", () => b.activate(run(label), trace));
    await release();
    await trace.finish("ok");
    const children = events.filter(event => event.parentSpan === "native.controller.github_access");
    expect(children.map(event => event.kind)).toEqual(expect.arrayContaining(["queue_setup", "entrypoint_install", "launcher_staging", ...expected]));
    expect(children.filter(event => event.outcome === "failed").map(event => event.kind)).toEqual(failed ? [failed] : []);
    expect(children.some(event => event.kind === "fallback")).toBe(Boolean(failed));
    expect(b.bridgeModes).toEqual([label === "http2_ready" ? "http2_v1" : "queue_v1"]);
    expect(events.filter(event => event.parentSpan === "native.controller.github_activate").map(event => event.kind))
      .toEqual(label === "http2_ready" ? ["generation_markers"] : ["quarantine_list", "generation_markers", "poll_start_wait"]);
    console.log(JSON.stringify({ row: "github-duplex-children", label, events }));
  } finally { await trace.finish("ok"); }
});

// Keep reason: the run's own span stream must attribute real restore bridge waits.
it.each([
  { resolvePath: false, rpcLatencyMs: 0 },
  { resolvePath: true, rpcLatencyMs: 0 },
  { resolvePath: false, rpcLatencyMs: 150 },
])("names real-shell GitHub restore children (resolve PATH: $resolvePath, RPC latency: $rpcLatencyMs)", async ({ resolvePath, rpcLatencyMs }) => {
  type Row = Record<string, unknown>;
  const rows: Row[] = [];
  let trace = createNativeRunTrace({ runId: "restore-a", onEvent: async event => {
    if (event.eventType === "run.performance.span") rows.push(event.payload!);
  } });
  const firstTrace = trace;
  const b = await trace.measure("native.controller.github_access", () =>
    broker(undefined, true, false, undefined, undefined, rpcLatencyMs, undefined, undefined, { getTrace: () => trace, resolvePath }));
  const queue = path.join(b.env.PAPERCLIP_GITHUB_LAUNCHER_DIR!, "paperclip-bridge", "queue");
  for (const id of ["stale", "private-token-path"]) {
    await writeFile(path.join(queue, "requests", `${id}.json`), JSON.stringify({ id }));
  }
  const release = await trace.measure("native.controller.github_activate", () => b.activate(run("restore-a"), trace));
  for (const id of ["stale", "private-token-path"]) {
    expect(JSON.parse(await readFile(path.join(queue, "responses", `${id}.json`), "utf8"))).toMatchObject({ status: 503 });
  }
  expect(b.resolveCredentials).not.toHaveBeenCalled();
  await release();
  await firstTrace.finish("ok");
  const assertChildren = (stream: Row[], phase: string, kinds: string[]) => {
    const parent = stream.find(row => row.span === `native.controller.${phase}`)!;
    const children = stream.filter(row => row.parentSpan === parent?.span);
    expect(children.map(row => row.kind)).toEqual(expect.arrayContaining(kinds));
    for (const child of children) {
      expect(child.span).toBe(`${parent.span}.${child.kind}`);
      expect(child.outcome).toBe("ok");
      expect(child.durationMs).toEqual(expect.any(Number));
      expect(Number(child.durationMs)).toBeGreaterThanOrEqual(0);
      expect(Number(child.startOffsetMs)).toBeGreaterThanOrEqual(Number(parent.startOffsetMs));
      expect(Number(child.startOffsetMs) + Number(child.durationMs))
        .toBeLessThanOrEqual(Number(parent.startOffsetMs) + Number(parent.durationMs));
      expect(Object.keys(child).sort()).toEqual([
        "schema", "traceSchemaVersion", "span", "parentSpan", "startOffsetMs", "durationMs", "outcome", "kind",
        "duration_ms", "wallStartedAtMs",
      ].sort());
    }
    const sumMs = children.reduce((sum, row) => sum + Number(row.durationMs), 0);
    let unionMs = 0;
    let coveredUntil = Number.NEGATIVE_INFINITY;
    for (const child of [...children].sort((a, b) => Number(a.startOffsetMs) - Number(b.startOffsetMs))) {
      const start = Number(child.startOffsetMs);
      const end = start + Number(child.durationMs);
      unionMs += Math.max(0, end - Math.max(start, coveredUntil));
      coveredUntil = Math.max(coveredUntil, end);
    }
    expect(unionMs).toBeLessThanOrEqual(Number(parent.durationMs));
    expect(JSON.stringify(children)).not.toContain("private-token-path");
    console.log(JSON.stringify({ row: "github-child-accounting", resolvePath, rpcLatencyMs, phase, parentMs: parent.durationMs, sumMs, unionMs, children }));
    // Like the executor's other controller steps, these are exclusive wall-time
    // slices: parallel launchers must not double-count the bridge's wait time.
    expect(sumMs).toBeLessThanOrEqual(Number(parent.durationMs));
  };
  assertChildren(rows, "github_access", ["queue_setup", "entrypoint_install", "gateway_ready", "launcher_staging", "gate_off",
    ...(resolvePath ? ["path_resolution"] : [])]);
  expect(rows.some(row => row.kind === "path_resolution")).toBe(resolvePath);
  assertChildren(rows, "github_activate", ["quarantine_list", "stale_entry_settle", "generation_markers", "poll_start_wait"]);
  expect(rows.filter(row => row.kind === "stale_entry_settle")).toHaveLength(2);

  // A retained broker must use B's trace, not hold the completed A trace.
  const nextRows: Row[] = [];
  trace = createNativeRunTrace({ runId: "restore-b", onEvent: async event => {
    if (event.eventType === "run.performance.span") nextRows.push(event.payload!);
  } });
  const firstCount = rows.length;
  const nextRelease = await trace.measure("native.controller.github_activate", () => b.activate(run("restore-b"), trace));
  await nextRelease();
  await trace.finish("ok");
  expect(rows).toHaveLength(firstCount);
  assertChildren(nextRows, "github_activate", ["quarantine_list", "generation_markers", "poll_start_wait"]);
  expect(nextRows.some(row => row.kind === "queue_setup" || row.kind === "stale_entry_settle")).toBe(false);
});

it.each(["github_access", "github_activate"] as const)("does not await a held %s child diagnostic sink in the real shell harness", async phase => {
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let sinkEntered = false;
  const trace = createNativeRunTrace({ runId: "held-github", onEvent: async event => {
    if (String(event.payload?.span).startsWith(`native.controller.${phase}.`)) {
      sinkEntered = true;
      await blocked;
    }
  } });
  let release: (() => Promise<void>) | undefined;
  const scopes: ReturnType<typeof trace.start>[] = [];
  // Use the executor's deferred parent policy. Race the WHOLE step so even a
  // regression inside activation releases the sink and joins its real processes.
  const working = (async () => {
    const scope = trace.start("native.controller.github_access");
    scopes.push(scope);
    const b = await trace.run(scope, () => broker(undefined, true, false, undefined, undefined, 0,
      undefined, undefined, { getTrace: () => trace }));
    await trace.end(scope, { deferRunLog: true });
    const activation = trace.start("native.controller.github_activate");
    scopes.push(activation);
    release = await trace.run(activation, () => b.activate(run("held-github"), trace));
    await trace.end(activation, { deferRunLog: true });
    return b;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const b = await Promise.race([working, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("GitHub preparation awaited diagnostics")), 2000);
    })]);
    expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-held-github" } });
    expect(sinkEntered).toBe(true);
  } finally {
    if (timer) clearTimeout(timer);
    unblock();
    await working;
    await release?.();
    for (const scope of scopes) await trace.end(scope, { deferRunLog: true });
    await trace.finish("ok");
  }
});
