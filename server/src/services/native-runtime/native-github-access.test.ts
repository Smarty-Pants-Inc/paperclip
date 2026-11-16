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
import { OpenCodeServerDriver } from "@paperclipai/paperclip-runner";
import { createCapabilityRunnerdProviderEnvironment } from "@paperclipai/paperclip-runner/live";
const scope = { companyId: "company-a", agentId: "agent-a", issueId: "task-a" };
const run = (runId: string) => ({ ...scope, runId });
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function localDuplexChannel(command: readonly string[], cwd: string): CommandManagedDuplexChannel {
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const buffered: Buffer[] = [];
  let dataListener: ((chunk: Uint8Array) => void) | undefined;
  let exitListener: ((exit: { exitCode: number | null }) => void) | undefined;
  let exit: { exitCode: number | null } | undefined;
  child.stdin.on("error", () => undefined);
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => dataListener ? dataListener(chunk) : buffered.push(chunk));
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
duplex?: { enabled?: boolean; capability: boolean; unavailable?: boolean; recorder?: DuplexObservabilityRecorder },
fallbackReason?: "capability_absent" | "ingress_unready" | "disconnect") {
  const root = await mkdtemp(path.join(tmpdir(), "native-github-reuse-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "real-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), `#!${process.execPath}\nprocess.stdout.write(process.env.GH_TOKEN || 'anonymous');`, { mode: 0o700 });
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async (input) => {
    const startedAt = new Date().toISOString();
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
    return localDuplexChannel(input.command, root);
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
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, PAPERCLIP_API_KEY: "old-run-api-key" }, resolveCredentials, onLog, fallbackReason },
    bridgeUnavailable ? async () => { throw new Error("fixture bridge unavailable"); } : async input => {
      const bridge = await startAdapterExecutionTargetPaperclipBridge(input);
      bridgeModes.push(bridge?.env.PAPERCLIP_API_BRIDGE_MODE);
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
it("keeps the callback bridge as the default unless ingress is explicitly selected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-github-default-bridge-"));
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => ({
    stdout: input.args?.[1]?.includes("printf")
      ? "\0/usr/bin:/bin\0"
      : `${Array.from({ length: 9 }, () => JSON.stringify({ uploaded: false })).join("\n")}\n`,
    stderr: "", exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(),
  }));
  const startBridge = vi.fn(async () => ({ env: { PAPERCLIP_API_URL: "http://bridge", PAPERCLIP_API_KEY: "bridge-capability" },
    stop: vi.fn(async () => {}) }));
  let access: NativeGitHubAccess | undefined;
  try {
    access = await createNativeGitHubAccess({ scope, cwd: root, env: { PATH: process.env.PATH },
      target: { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: root, runner: { execute }, streamRunLogs: false,
        effectiveCapabilities: { runnerWebSocketIngress: true } } as never,
      resolveCredentials: async () => ({ status: "available", env: {} }) }, startBridge as never);
    expect(access.transport).toBe("callback_bridge");
    expect(startBridge).toHaveBeenCalledOnce();
  } finally {
    await access?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("selects runner-ingress GitHub access without starting or polling the callback bridge", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-github-ingress-"));
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => ({
    stdout: input.args?.[1]?.includes("printf")
      ? "\0/usr/bin:/bin\0"
      : `${Array.from({ length: 9 }, () => JSON.stringify({ uploaded: false })).join("\n")}\n`,
    stderr: "", exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(),
  }));
  const startBridge = vi.fn(async () => null);
  const records: string[] = [];
  const resolveCredentials = vi.fn(async () => ({ status: "available", env: { GH_TOKEN: "server-sentinel" } }));
  let access: NativeGitHubAccess | undefined;
  try {
    access = await createNativeGitHubAccess({
      scope, cwd: root, env: { PATH: process.env.PATH },
      target: { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: root,
        runner: { execute }, streamRunLogs: false,
        effectiveCapabilities: { runnerWebSocketIngress: true } } as never,
      resolveCredentials,
      onLog: async (_stream, chunk) => { records.push(chunk); },
      transport: "runner_ingress",
    }, startBridge as never);
    expect(access.ready).toBe(true);
    expect(access.env).not.toHaveProperty("PAPERCLIP_GITHUB_BROKER_TOKEN");
    expect(startBridge).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([call]) => (call.args ?? []).join(" ").includes("paperclip-bridge/queue"))).toBe(false);
    expect(access.env.PAPERCLIP_GITHUB_ACCESS_TRANSPORT).toBe("runner_ingress");
    expect(access.env.PAPERCLIP_GITHUB_BROKER_URL).toBe("");
    expect(access.env).not.toHaveProperty("PAPERCLIP_GITHUB_BROKER_TOKEN");
    expect(access.env).not.toHaveProperty("PAPERCLIP_GITHUB_BRIDGE_TOKEN");
    expect(JSON.stringify(access.env)).not.toContain("server-sentinel");
    const requestSentinel = "body-sentinel-never-log";
    const initialCapability = access.getRunnerIngressCapability()!;
    const initialFrame = { kind: "github_access.http" as const, requestId: "ingress-idle", method: "POST",
      path: "/runtime-tools/github/credentials", headers: { "content-type": "application/json",
        "x-paperclip-github-capability": initialCapability }, bodyBase64: Buffer.from(requestSentinel).toString("base64") };
    const idle = await access.handleRunnerIngressHttpRequest(initialFrame, run("ingress-run"));
    expect(idle.status).toBe(403);
    const release = await access.activate(run("ingress-run"));
    const capability = access.getRunnerIngressCapability()!;
    expect(capability).not.toBe(initialCapability);
    expect((await access.handleRunnerIngressHttpRequest(initialFrame, run("ingress-run"))).status).toBe(403);
    const frame = { ...initialFrame, requestId: "ingress-request-1",
      headers: { "content-type": "application/json", "x-paperclip-github-capability": capability } };
    for (const invalid of [{ method: "GET", requestId: "ingress-invalid-method" },
      { path: "/runtime-tools/github/other", requestId: "ingress-invalid-path" }]) {
      const refused = await access.handleRunnerIngressHttpRequest({ ...frame, ...invalid }, run("ingress-run"));
      expect(refused.status).toBe(404);
    }
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect((await access.handleRunnerIngressHttpRequest({ ...frame, requestId: "ingress-forged-run", runId: "other-run" },
      run("ingress-run"))).status).toBe(403);
    expect((await access.handleRunnerIngressHttpRequest({ ...frame, requestId: "ingress-auth-header",
      headers: { authorization: "Bearer forged" } }, run("ingress-run"))).status).toBe(403);
    expect((await access.handleRunnerIngressHttpRequest({ ...frame, requestId: "ingress-wrong-capability",
      headers: { "x-paperclip-github-capability": "forged-capability" } }, run("ingress-run"))).status).toBe(403);
    const reply = await access.handleRunnerIngressHttpRequest(frame, run("ingress-run"));
    expect(reply).toMatchObject({ requestId: "ingress-request-1", status: 200 });
    expect(JSON.parse(Buffer.from(reply.bodyBase64, "base64").toString())).toEqual({
      status: "available", env: { GH_TOKEN: "server-sentinel" },
    });
    const requestRecords = records.filter(chunk => chunk.includes("github_access.request "));
    expect(requestRecords).toHaveLength(8);
    for (const requestId of ["ingress-idle", "ingress-invalid-method", "ingress-invalid-path", "ingress-forged-run",
      "ingress-auth-header", "ingress-wrong-capability", "ingress-request-1"]) {
      expect(requestRecords.some(chunk => chunk.includes(`"requestId":"${requestId}"`))).toBe(true);
    }
    const ingressRecord = requestRecords.find(chunk => chunk.includes('"requestId":"ingress-request-1"') && chunk.includes('"status":200'))!;
    expect(ingressRecord).toContain('"method":"POST"');
    expect(ingressRecord).toContain('"path":"/runtime-tools/github/credentials"');
    expect(ingressRecord).toContain('"transport":"prp"');
    expect(ingressRecord).toContain('"status":200');
    expect(ingressRecord).toContain('"responseSize":');
    expect(typeof JSON.parse(ingressRecord.slice(ingressRecord.indexOf("github_access.request ") + "github_access.request ".length)).durationMs).toBe("number");
    for (const secret of [requestSentinel, capability, "server-sentinel"]) {
      expect(ingressRecord).not.toContain(secret);
      expect(ingressRecord).not.toContain(Buffer.from(secret).toString("base64"));
    }
    expect(typeof access.handleRunnerIngressHttpRequest).toBe("function");
    await release();
    access.markRunnerIngressStale();
    expect(access.ready).toBe(false);
    expect((await access.handleRunnerIngressHttpRequest({ ...frame, requestId: "ingress-stale" }, run("ingress-run"))).status).toBe(503);
    const refreshedCapabilities: string[] = [];
    const ingressAccess = access;
    if (!ingressAccess) throw new Error("runner ingress access was not created");
    const unregisterRefresher = ingressAccess.setRunnerIngressCapabilityRefresher(async (capability: string) => {
      refreshedCapabilities.push(capability);
      ingressAccess.markRunnerIngressReady();
    });
    try {
      const releaseNext = await ingressAccess.activate(run("ingress-next-run"));
      expect(refreshedCapabilities).toEqual([ingressAccess.getRunnerIngressCapability()]);
      expect(refreshedCapabilities[0]).not.toBe(capability);
      expect(ingressAccess.ready).toBe(true);
      await releaseNext();
    } finally {
      unregisterRefresher();
    }
  } finally {
    await access?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("routes retained warm broker requests to the active run's persisted log", async () => {
  const runALog: string[] = [];
  const runBLog: string[] = [];
  const logA = vi.fn(async (_stream: "stdout" | "stderr", chunk: string) => { runALog.push(chunk); });
  const logB = vi.fn(async (_stream: "stdout" | "stderr", chunk: string) => { runBLog.push(chunk); });
  const b = await broker();
  const activate = b.activate as unknown as (binding: ReturnType<typeof run>, onLog: typeof logA) => Promise<() => Promise<void>>;
  const releaseA = await activate(run("warm-run-a"), logA);
  expect((await request(b)).status).toBe(200);
  await releaseA();
  const releaseB = await activate(run("warm-run-b"), logB);
  expect((await request(b)).status).toBe(200);
  await releaseB();
  const requestLines = (lines: string[]) => lines.filter(line => line.includes("github_access.request "));
  expect(requestLines(runALog)).toHaveLength(1);
  expect(requestLines(runBLog)).toHaveLength(1);
  expect(logA).toHaveBeenCalledWith("stderr", expect.stringContaining('"status":200'));
  expect(logB).toHaveBeenCalledWith("stderr", expect.stringContaining('"status":200'));
});

it("follows the active runner-ingress run and refuses a request on the old session", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-github-active-run-"));
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => ({
    stdout: input.args?.[1]?.includes("printf") ? "\0/usr/bin:/bin\0" : `${Array.from({ length: 9 }, () => JSON.stringify({ uploaded: false })).join("\n")}\n`,
    stderr: "", exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(),
  }));
  let access: NativeGitHubAccess | undefined;
  try {
    access = await createNativeGitHubAccess({ scope, cwd: root, env: { PATH: process.env.PATH },
      target: { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: root,
        runner: { execute }, streamRunLogs: false, effectiveCapabilities: { runnerWebSocketIngress: true } } as never,
      resolveCredentials: async binding => ({ status: "available", env: { GH_TOKEN: `fixture-${binding.runId}` } }),
      transport: "runner_ingress",
    });
    const refreshed: string[] = [];
    access.setRunnerIngressCapabilityRefresher(async capability => { refreshed.push(capability); });
    const releaseA = await access.activate(run("active-run-a"));
    const tokenA = access.getRunnerIngressCapability()!;
    expect((await access.handleRunnerIngressHttpRequest({ kind: "github_access.http", requestId: "run-a-request", method: "POST",
      path: "/runtime-tools/github/credentials", headers: { "x-paperclip-github-capability": tokenA }, bodyBase64: "e30=" },
    run("active-run-a"))).status).toBe(200);
    await releaseA();

    const releaseB = await access.activate(run("active-run-b"));
    const tokenB = access.getRunnerIngressCapability()!;
    expect(tokenB).not.toBe(tokenA);
    expect(refreshed).toEqual([tokenA, tokenB]);
    const activeFrame = { kind: "github_access.http", requestId: "run-b-request", method: "POST",
      path: "/runtime-tools/github/credentials", headers: { "x-paperclip-github-capability": tokenB }, bodyBase64: "e30=" };
    expect((await access.handleRunnerIngressHttpRequest(activeFrame, run("active-run-a"))).status).toBe(403);
    expect((await access.handleRunnerIngressHttpRequest(activeFrame, run("active-run-b"))).status).toBe(200);
    await releaseB();
  } finally {
    await access?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it("records callback-bridge request metadata without body, capability, or response secrets", async () => {
  const logs: string[] = [];
  const bodySecret = "bridge-body-sentinel";
  const responseSecret = "bridge-response-sentinel";
  const resolver = vi.fn(async () => ({ status: "available", env: { GH_TOKEN: responseSecret } }));
  const b = await broker(resolver, false, false, async (_stream, chunk) => { logs.push(chunk); }, undefined, "disconnect");
  await b.activate(run("bridge-run"));
  const capability = b.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN!;
  const response = await request(b, { body: `${bodySecret}:${capability}`, headers: {
    authorization: `Bearer ${capability}`, "content-type": "application/octet-stream",
  } });
  const responseBody = await response.text();
  const records = logs.filter(chunk => chunk.includes("github_access.request "));
  expect(records).toHaveLength(1);
  const line = records[0]!;
  const metadata = JSON.parse(line.slice(line.indexOf("github_access.request ") + "github_access.request ".length)) as Record<string, unknown>;
  expect(metadata).toMatchObject({ method: "POST", path: "/runtime-tools/github/credentials", status: 200,
    transport: "bridge", fallbackReason: "disconnect" });
  expect(typeof metadata.requestId).toBe("string");
  expect(typeof metadata.responseSize).toBe("number");
  expect(typeof metadata.durationMs).toBe("number");
  expect(metadata.durationMs).toBeGreaterThanOrEqual(0);
  expect(metadata.responseSize).toBe(Buffer.byteLength(responseBody));
  for (const secret of [bodySecret, capability, responseSecret]) {
    expect(line).not.toContain(secret);
    expect(line).not.toContain(Buffer.from(secret).toString("base64"));
  }
  expect(JSON.parse(responseBody)).toEqual({ status: "available", env: { GH_TOKEN: responseSecret } });
});

it("rejects the runner-ingress capability as callback-bridge HTTP authentication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-github-ingress-http-"));
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => ({
    stdout: input.args?.[1]?.includes("printf")
      ? "\0/usr/bin:/bin\0"
      : `${Array.from({ length: 9 }, () => JSON.stringify({ uploaded: false })).join("\n")}\n`,
    stderr: "", exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(),
  }));
  let ingress: NativeGitHubAccess | undefined;
  try {
    ingress = await createNativeGitHubAccess({
      scope, cwd: root, env: { PATH: process.env.PATH },
      target: { kind: "remote", transport: "sandbox", providerKey: "test", remoteCwd: root,
        runner: { execute }, streamRunLogs: false,
        effectiveCapabilities: { runnerWebSocketIngress: true } } as never,
      resolveCredentials: async () => ({ status: "available", env: {} }),
      transport: "runner_ingress",
    });
    const callback = await broker(undefined, true);
    const release = await callback.activate(run("callback-run"));
    try {
      const capability = ingress.getRunnerIngressCapability()!;
      expect(capability).toMatch(/^[a-f0-9]{64}$/);
      const response = await fetch(`${callback.env.PAPERCLIP_GITHUB_BROKER_URL}/runtime-tools/github/credentials`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${capability}`,
          "x-paperclip-github-capability": capability,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect([401, 403]).toContain(response.status);
      expect(callback.resolveCredentials).not.toHaveBeenCalled();
    } finally {
      await release();
    }
  } finally {
    await ingress?.stop();
    await rm(root, { recursive: true, force: true });
  }
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
