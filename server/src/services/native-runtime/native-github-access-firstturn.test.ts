// Keep reason: explicit first-turn regression brief; real file-queue setup must
// preserve the never-OK inactive-generation fence while reducing provider calls.
import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { startAdapterExecutionTargetPaperclipBridge } from "@paperclipai/adapter-utils/execution-target";
import { createCommandManagedSandboxCallbackBridgeQueueClient } from "@paperclipai/adapter-utils/sandbox-callback-bridge";
import { createNativeGitHubAccess } from "./native-github-access.js";

const scope = { companyId: "company", agentId: "agent", issueId: "issue" };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { fail?: (script: string) => boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "github-firstturn-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const calls: { script: string; phase: string; depth: number; settled: boolean }[] = [];
  let completedDepth = 0;
  let phase = "create";
  let queue = "";
  let hostUrl = "";
  let hostToken = "";
  let transportError: unknown;
  let beforeExec: ((script: string) => Promise<void>) | undefined;
  let broker: Awaited<ReturnType<typeof createNativeGitHubAccess>> | undefined;
  const resolveCredentials = vi.fn(async () => ({ status: "available", env: {} }));
  const execute: CommandManagedRuntimeRunner["execute"] = async input => {
    const script = [...(input.args ?? []), input.stdin ?? ""].join("\n");
    const call = { script, phase, depth: completedDepth + 1, settled: false };
    calls.push(call);
    try {
      await beforeExec?.(script);
      if (options.fail?.(script)) return { exitCode: 1, stdout: "", stderr: "injected provider failure", timedOut: false, signal: null, pid: null, startedAt: new Date().toISOString() };
      // A real shell executes every command; this fake provider does not fabricate
      // readiness, uploads or queue results. In particular the ready gate launches
      // the actual generated callback server.
      const child = promisify(execFile)(input.command, input.args ?? [], {
        cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      });
      child.child.stdin?.on("error", () => undefined);
      child.child.stdin?.end(input.stdin ?? "");
      const result = await child;
      return { ...result, exitCode: 0, timedOut: false, signal: null, pid: null, startedAt: new Date().toISOString() };
    } finally {
      call.settled = true;
      completedDepth = Math.max(completedDepth, call.depth);
    }
  };
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // The actual server launch must observe paused on disk, not merely a host flag.
  await writeFile(path.join(bin, "node"), `#!/bin/sh\nset -eu\nstate=$(cat "$PAPERCLIP_BRIDGE_QUEUE_DIR/run-state.json")\n[ "$state" = paused ]\nprintf '%s' "$state" > "$PAPERCLIP_BRIDGE_QUEUE_DIR/launch-observed-state"\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
  const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "counting-local", remoteCwd: root, runner: { execute }, streamRunLogs: false };
  const create = async () => {
    broker = await createNativeGitHubAccess({ scope, target, cwd: root,
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, resolveCredentials }, async input => {
      // Inject only the remote executable search path, never a replacement bridge.
      const original = target.runner.execute;
      target.runner.execute = args => original({ ...args, env: { ...args.env, PATH: `${bin}:${process.env.PATH}` } });
      hostUrl = input.hostApiUrl!;
      hostToken = input.hostApiToken!;
      try {
        const bridge = await startAdapterExecutionTargetPaperclipBridge(input);
        queue = bridge?.env.PAPERCLIP_BRIDGE_QUEUE_DIR ?? "";
        return bridge;
      } catch (error) {
        transportError = error;
        throw error;
      }
    });
    cleanups.push(broker.stop);
    return broker;
  };
  return { root, calls, create, resolveCredentials, runner: { execute },
    get queue() { return queue; }, get transportError() { return transportError; },
    get serialDepth() { return completedDepth; },
    setPhase(value: string) { phase = value; },
    beforeExec(hook: (script: string) => Promise<void>) { beforeExec = hook; },
    hostRequest: () => fetch(hostUrl + "/runtime-tools/github/credentials", {
      method: "POST", body: "{}", headers: { authorization: `Bearer ${hostToken}`, "content-type": "application/json" },
    }),
  };
}

it("cold real GitHub create + activate uses at most six remote execs and publishes authority last", async () => {
  const f = await fixture();
  const broker = await f.create();
  expect(broker.ready).toBe(true);
  expect(await readFile(path.join(f.queue, "launch-observed-state"), "utf8")).toBe("paused");
  const request = () => fetch(broker.env.PAPERCLIP_GITHUB_BROKER_URL + "/runtime-tools/github/credentials", {
    method: "POST", body: "{}", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, "content-type": "application/json" },
  });
  expect((await request()).status).toBe(403);
  const createCount = f.calls.length;
  const createDepth = f.serialDepth;
  f.setPhase("activate");
  const deactivate = await broker.activate({ ...scope, runId: "run" });
  const count = f.calls.length;
  const depth = f.serialDepth;
  // Setup's awaited calls form a linear dependency chain at both revisions.
  // The resumed poll is admitted before activate resolves, but is not awaited:
  // count it in total work, not in completed critical-path depth. A completion
  // frontier is exact for this chain (and conservative if unrelated work overlaps).
  const pending = f.calls.filter(call => !call.settled);
  expect(pending).toHaveLength(1);
  expect(pending[0]!.script).toContain("wait_checks");
  const state = await readFile(path.join(f.queue, "run-state.json"), "utf8");
  expect(state).toMatch(/^attached:.+/);
  expect(await readFile(path.join(f.queue, "run-state.json.ever-attached"), "utf8")).toBe("attached");
  expect((await request()).status).toBe(200);
  expect(f.resolveCredentials).toHaveBeenCalledOnce();
  const quarantineIndex = f.calls.findIndex(call => call.phase === "activate" && call.script.includes("basename"));
  const attachmentIndex = f.calls.findIndex(call => call.phase === "activate" && call.script.includes("ever-attached"));
  expect(quarantineIndex).toBeGreaterThanOrEqual(createCount);
  expect(attachmentIndex).toBeGreaterThan(quarantineIndex);
  console.log("FIRSTTURN_COUNTS", JSON.stringify({ create: createCount, activate: count - createCount, total: count,
    serialDepth: { create: createDepth, activate: depth - createDepth, total: depth } }));
  f.setPhase("cleanup");
  await deactivate();
  const pauseWrites = f.calls.filter(call => call.phase === "cleanup" &&
    call.script.includes("run-state.json") && !call.script.includes("ever-attached"));
  expect(pauseWrites).toHaveLength(3);
  expect(pauseWrites.filter(call => /(?:^|\n)printf '%s'/.test(call.script))).toHaveLength(1);
  expect(pauseWrites.filter(call => /(?:^|\n)base64 -d </.test(call.script))).toHaveLength(1);
  expect(depth).toBeLessThanOrEqual(6);
  expect(count).toBeLessThanOrEqual(6);
}, 30_000);

it("a failed combined setup rejects bridge creation and keeps native GitHub optional/unavailable", async () => {
  const f = await fixture({ fail: script => script.includes("printf '%s' paused") });
  const broker = await f.create();
  expect(f.transportError).toBeInstanceOf(Error);
  expect(String(f.transportError)).toContain("injected provider failure");
  expect(broker.ready).toBe(false);
  expect(f.resolveCredentials).not.toHaveBeenCalled();
  expect(f.calls.some(call => call.script.includes("nohup"))).toBe(true);
}, 30_000);

it("an actual entrypoint decode failure aborts the combined command before server launch", async () => {
  const f = await fixture();
  // Fail the entrypoint's first decode after emitting partial bytes; remove only
  // this fixture shim so the unchanged anonymous-launcher fallback can stage.
  await writeFile(path.join(f.root, "bin", "base64"), "#!/bin/sh\nrm -- \"$0\"\nprintf incomplete\nexit 1\n", { mode: 0o700 });
  const broker = await f.create();
  expect(broker.ready).toBe(false);
  expect(f.transportError).toBeInstanceOf(Error);
  const setup = f.calls.find(call => call.script.includes("nohup"))!.script;
  const queue = setup.match(/(\/[^'\"\n]+\/queue)\/requests/)?.[1];
  expect(queue).toBeTruthy();
  await expect(readFile(path.join(queue!, "server.pid"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(f.resolveCredentials).not.toHaveBeenCalled();
}, 30_000);

it.each(["ever-attached", "run-state"])("a failed %s activation write rejects without publishing authority", async marker => {
  let armed = false;
  const f = await fixture({ fail: script => armed && script.includes("base64 -d") &&
    (marker === "ever-attached" ? script.includes("ever-attached") : script.includes("run-state.json") && !script.includes("ever-attached")) });
  const broker = await f.create();
  armed = true;
  await expect(broker.activate({ ...scope, runId: "run" })).rejects.toThrow("injected provider failure");
  expect(await readFile(path.join(f.queue, "run-state.json"), "utf8")).toBe("paused");
  expect((await f.hostRequest()).status).toBe(403);
  expect(f.resolveCredentials).not.toHaveBeenCalled();
  armed = false;
}, 30_000);

it("quarantines old requests before attached and awaits the durable attachment before resolving activation", async () => {
  const f = await fixture();
  const broker = await f.create();
  const requestPath = path.join(f.queue, "requests", "old.json");
  const responsePath = path.join(f.queue, "responses", "old.json");
  await writeFile(requestPath, JSON.stringify({ id: "old" }));
  let reached!: () => void;
  const atAttachment = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.beforeExec(async script => {
    if (!script.includes("base64 -d") || !script.includes("run-state.json") || script.includes("ever-attached")) return;
    expect(JSON.parse(await readFile(responsePath, "utf8"))).toMatchObject({ id: "old", status: 503 });
    await expect(readFile(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.hostRequest()).status).toBe(403);
    reached();
    await gate;
  });
  let resolved = false;
  const activation = broker.activate({ ...scope, runId: "run" }).then(deactivate => { resolved = true; return deactivate; });
  try {
    await atAttachment;
    expect(resolved).toBe(false);
    expect(await readFile(path.join(f.queue, "run-state.json"), "utf8")).toBe("paused");
    expect(f.resolveCredentials).not.toHaveBeenCalled();
  } finally {
    release();
  }
  const deactivate = await activation;
  expect(await readFile(path.join(f.queue, "run-state.json"), "utf8")).toMatch(/^attached:/);
  expect((await f.hostRequest()).status).toBe(200);
  await deactivate();
}, 30_000);

it("keeps large writes chunked while small quoted Unicode state is one atomic exec", async () => {
  const f = await fixture();
  const client = createCommandManagedSandboxCallbackBridgeQueueClient({ runner: f.runner, remoteCwd: f.root, inlineSmallWrites: true });
  const destination = path.join(f.root, "quote's state.json");
  const body = "attached:你好\n'quoted'";
  await client.writeTextFile(destination, body);
  expect(f.calls).toHaveLength(1);
  expect(await readFile(destination, "utf8")).toBe(body);
  const large = "你好\n".repeat(20_000);
  const before = f.calls.length;
  await client.writeTextFile(destination, large);
  const chunks = Math.ceil(Buffer.byteLength(Buffer.from(large).toString("base64")) / (32 * 1024));
  expect(f.calls.length - before).toBe(chunks + 2);
  expect(await readFile(destination, "utf8")).toBe(large);
  expect((await readdir(f.root)).filter(name => name.includes("paperclip-upload"))).toEqual([]);
}, 30_000);

it("a partial inline decode failure preserves the prior published file and cleans its own temporary", async () => {
  const f = await fixture();
  const destination = path.join(f.root, "state.json");
  await writeFile(destination, "paused");
  await writeFile(path.join(f.root, "bin", "base64"), "#!/bin/sh\nprintf incomplete\nexit 1\n", { mode: 0o700 });
  const client = createCommandManagedSandboxCallbackBridgeQueueClient({
    runner: { execute: input => f.runner.execute({ ...input, env: { ...input.env, PATH: `${f.root}/bin:${process.env.PATH}` } }) },
    remoteCwd: f.root, inlineSmallWrites: true,
  });
  await expect(client.writeTextFile(destination, "attached:new")).rejects.toThrow();
  expect(await readFile(destination, "utf8")).toBe("paused");
  expect(f.calls).toHaveLength(1);
  expect((await readdir(f.root)).filter(name => name.includes("paperclip-upload"))).toEqual([]);
}, 30_000);

it("does not replay an uncertain timed-out inline state write or continue after a late provider response", async () => {
  vi.useFakeTimers();
  try {
    let finish!: (result: Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>) => void;
    const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(() => new Promise(resolve => { finish = resolve; }));
    const client = createCommandManagedSandboxCallbackBridgeQueueClient({ runner: { execute }, remoteCwd: "/workspace", inlineSmallWrites: true });
    const write = client.writeTextFile("/workspace/state.json", "attached:run");
    const rejection = expect(write).rejects.toThrow("timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    finish({ exitCode: 0, stdout: "", stderr: "", timedOut: false, signal: null, pid: null, startedAt: "" });
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
