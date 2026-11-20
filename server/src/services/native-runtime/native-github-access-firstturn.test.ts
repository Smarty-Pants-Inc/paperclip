// Keep reason: explicit first-turn regression brief; real file-queue setup must
// preserve the never-OK inactive-generation fence while reducing provider calls.
import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { startAdapterExecutionTargetPaperclipBridge } from "@paperclipai/adapter-utils/execution-target";
import { createNativeGitHubAccess } from "./native-github-access.js";

const scope = { companyId: "company", agentId: "agent", issueId: "issue" };
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { fail?: (script: string) => boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "github-firstturn-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const calls: { script: string; phase: string }[] = [];
  let phase = "create";
  let queue = "";
  let broker: Awaited<ReturnType<typeof createNativeGitHubAccess>> | undefined;
  const resolveCredentials = vi.fn(async () => ({ status: "available", env: {} }));
  const execute: CommandManagedRuntimeRunner["execute"] = async input => {
    const script = [...(input.args ?? []), input.stdin ?? ""].join("\n");
    calls.push({ script, phase });
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
      const bridge = await startAdapterExecutionTargetPaperclipBridge(input);
      queue = bridge?.env.PAPERCLIP_BRIDGE_QUEUE_DIR ?? "";
      return bridge;
    });
    cleanups.push(broker.stop);
    return broker;
  };
  return { root, calls, create, resolveCredentials, get queue() { return queue; }, setPhase(value: string) { phase = value; } };
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
  f.setPhase("activate");
  const deactivate = await broker.activate({ ...scope, runId: "run" });
  const count = f.calls.length;
  const state = await readFile(path.join(f.queue, "run-state.json"), "utf8");
  expect(state).toMatch(/^attached:.+/);
  expect(await readFile(path.join(f.queue, "run-state.json.ever-attached"), "utf8")).toBe("attached");
  expect((await request()).status).toBe(200);
  expect(f.resolveCredentials).toHaveBeenCalledOnce();
  const quarantineIndex = f.calls.findIndex(call => call.phase === "activate" && call.script.includes("basename"));
  const attachmentIndex = f.calls.findIndex(call => call.phase === "activate" && call.script.includes("ever-attached"));
  expect(quarantineIndex).toBeGreaterThanOrEqual(createCount);
  expect(attachmentIndex).toBeGreaterThan(quarantineIndex);
  console.log("FIRSTTURN_COUNTS", JSON.stringify({ create: createCount, activate: count - createCount, total: count }));
  f.setPhase("cleanup");
  await deactivate();
  expect(count).toBeLessThanOrEqual(6);
}, 30_000);
