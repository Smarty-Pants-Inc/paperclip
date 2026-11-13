import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { uploadVerifiedProviderPack } from "./provider-pack-upload.js";
import type { NativeRunTrace } from "./native-run-trace.js";

vi.mock("./provider-pack-archive.js", () => ({
  readProviderPackArchive: async () => null,
  stageProviderPackArchive: vi.fn(),
}));

const exec = promisify(execFile);
const digest = `sha256:${"a".repeat(64)}`;
const result = (extra: Partial<Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>>> = {}) => ({
  exitCode: 0, timedOut: false, signal: null, pid: null, startedAt: null, stdout: "", stderr: "", ...extra,
});

// Keep reason: recorded production catch (Clone L run 7af92697). A 1.9 GiB
// snapshot-carried pack cannot be synchronously deleted within the old 10s bound.
function fixture(options: { renameFails?: boolean; deleteFails?: boolean; deleteTimesOut?: boolean } = {}) {
  let target: "stale" | "absent" | "uploaded" = "stale";
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async input => {
    const script = input.args?.[1] ?? "";
    if (script.includes("mv -T")) {
      if (options.renameFails) return result({ exitCode: 1, stderr: "mv: Permission denied" });
      target = "absent";
      return result();
    }
    // Model a 20s deletion without sleeping: the old 10s command times out,
    // but the 60s compatibility fallback has enough time to finish.
    if ((input.timeoutMs ?? 0) < 20_000 || options.deleteTimesOut) {
      return result({ exitCode: null, timedOut: true, stderr: "rm: deletion exceeded deadline" });
    }
    if (options.deleteFails) return result({ exitCode: 1, stderr: "rm: Permission denied; token=fixture-secret-value" });
    target = "absent";
    return result();
  });
  const stageDirectory = vi.fn(async () => {
    expect(target).toBe("absent");
    target = "uploaded";
  });
  const verifyUploaded = vi.fn(async () => { expect(target).toBe("uploaded"); });
  const input = {
    root: "/controller/pack", sourceDigest: digest, expectedDigest: digest,
    runner: { execute }, cwd: "/workspace", targetPath: "/workspace/runtime/provider-pack", reuseRoots: [],
    verifyDirectory: vi.fn(), stageDirectory, verifyUploaded,
  };
  return { input, execute, stageDirectory, verifyUploaded };
}

it("renames a stale pack and completes upload even when deleting it would exceed 10s", async () => {
  const { input, execute, stageDirectory, verifyUploaded } = fixture();
  await uploadVerifiedProviderPack(input);
  expect(stageDirectory).toHaveBeenCalledOnce();
  expect(verifyUploaded).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  const command = execute.mock.calls[0]![0];
  expect(command).toMatchObject({ timeoutMs: 10_000, bypassSession: true, cwd: input.cwd });
  expect(command.args?.[1]).toContain("mv -T");
  expect(command.args?.[1]).toContain("/workspace/runtime/.provider-pack.stale-");
  expect(command.args?.[1]).toMatch(/nohup.*setsid.*rm -rf/);
});

it("falls back to a 60s synchronous delete when rename is denied", async () => {
  const { input, execute, verifyUploaded } = fixture({ renameFails: true });
  await uploadVerifiedProviderPack(input);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]![0]).toMatchObject({
    timeoutMs: 60_000, bypassSession: true, cwd: input.cwd,
  });
  expect(execute.mock.calls[1]![0].args?.[1]).toMatch(/^rm -rf /);
  expect(verifyUploaded).toHaveBeenCalledOnce();
});

it("keeps clear_stale around only the rename attempt, not the slower fallback", async () => {
  const { input, execute } = fixture({ renameFails: true });
  let activeSpan: string | null = null;
  const commandSpans: Array<string | null> = [];
  const originalExecute = execute.getMockImplementation()!;
  execute.mockImplementation(async command => {
    commandSpans.push(activeSpan);
    return originalExecute(command);
  });
  const trace = {
    measure: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      activeSpan = name;
      try { return await fn(); } finally { activeSpan = null; }
    },
  } as NativeRunTrace;
  await uploadVerifiedProviderPack({ ...input, trace });
  expect(commandSpans).toEqual(["provider_pack.clear_stale", null]);
});

it("reports the deletion's stderr reason without exposing a secret or uploading", async () => {
  const { input, stageDirectory, verifyUploaded } = fixture({ renameFails: true, deleteFails: true });
  const error = await uploadVerifiedProviderPack(input).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("runner_remote_provider_artifact_incompatible: stale provider pack could not be replaced");
  expect((error as Error).message).toContain("Permission denied");
  expect((error as Error).message).not.toContain("fixture-secret-value");
  expect(stageDirectory).not.toHaveBeenCalled();
  expect(verifyUploaded).not.toHaveBeenCalled();
});

it("still refuses upload if the longer fallback times out", async () => {
  const { input, execute, stageDirectory } = fixture({ renameFails: true, deleteTimesOut: true });
  await expect(uploadVerifiedProviderPack(input)).rejects.toThrow("deletion exceeded deadline");
  expect(execute.mock.calls[1]![0].timeoutMs).toBe(60_000);
  expect(stageDirectory).not.toHaveBeenCalled();
});

it("detaches real shell cleanup, sweeps old stale trees, and preserves the replacement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-clear-"));
  // Quotes, glob metacharacters and shell syntax must remain literal paths.
  const targetPath = path.join(root, "pack ' [x]; #");
  const stalePrefix = path.join(root, `.${path.basename(targetPath)}.stale-`);
  const tools = path.join(root, "tools");
  const gate = path.join(root, "gate");
  const started = path.join(root, "started");
  const finished = path.join(root, "finished");
  await fs.mkdir(tools);
  await fs.mkdir(targetPath);
  await fs.writeFile(path.join(targetPath, "old"), "old pack");
  await fs.mkdir(`${stalePrefix}previous-crash`);
  await fs.writeFile(`${stalePrefix}previous-crash/old`, "orphan");
  await fs.writeFile(path.join(root, "unrelated"), "keep");
  await exec("mkfifo", [gate]);
  await fs.writeFile(path.join(tools, "rm"), `#!/bin/sh\nprintf '%s' "$$" > "$CLEAR_STARTED"\ntimeout 5 sh -c 'read -r line < "$CLEAR_GATE"'\n/bin/rm "$@"\nprintf done > "$CLEAR_FINISHED"\n`, { mode: 0o755 });
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async command => {
    try {
      const output = await exec(command.command, command.args ?? [], {
        cwd: command.cwd, timeout: command.timeoutMs,
        env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, CLEAR_STARTED: started, CLEAR_FINISHED: finished, CLEAR_GATE: gate },
      });
      return result(output);
    } catch (error) {
      const failure = error as { code?: number; killed?: boolean; stderr?: string };
      return result({ exitCode: failure.code ?? 1, timedOut: Boolean(failure.killed), stderr: failure.stderr ?? String(error) });
    }
  });
  let cleanupStarted = false;
  try {
    await uploadVerifiedProviderPack({
      root: path.join(root, "source"), sourceDigest: digest, expectedDigest: digest,
      runner: { execute }, cwd: root, targetPath, reuseRoots: [], verifyDirectory: () => {},
      stageDirectory: async () => {
        await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        await fs.mkdir(targetPath);
        await fs.writeFile(path.join(targetPath, "new"), "verified replacement");
      },
      verifyUploaded: async () => { expect(await fs.readFile(path.join(targetPath, "new"), "utf8")).toBe("verified replacement"); },
    });
    await vi.waitFor(async () => { expect(await fs.readFile(started, "utf8")).toMatch(/^\d+$/); });
    cleanupStarted = true;
    // The detached delete is blocked, yet upload and verification already returned.
    expect(await fs.readFile(`${stalePrefix}previous-crash/old`, "utf8")).toBe("orphan");
    expect((await fs.readdir(root)).filter(name => name.startsWith(`.${path.basename(targetPath)}.stale-`))).toHaveLength(2);
  } finally {
    // Even a failing assertion releases and awaits the owned cleanup process.
    if (!cleanupStarted) cleanupStarted = await fs.stat(started).then(() => true, () => false);
    if (cleanupStarted) {
      // Never block opening a FIFO if a failing implementation already let the
      // reader time out. The wrapper has its own bound and is always awaited.
      const handle = await fs.open(gate, constants.O_WRONLY | constants.O_NONBLOCK).catch(error => {
        if (error.code === "ENXIO") return null;
        throw error;
      });
      if (handle) {
        try { await handle.writeFile("continue\n"); } finally { await handle.close(); }
      }
      await vi.waitFor(async () => { expect(await fs.readFile(finished, "utf8")).toBe("done"); }, { timeout: 10_000 });
      const pid = Number(await fs.readFile(started, "utf8"));
      await vi.waitFor(async () => {
        const state = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
        expect(state === "" || /^\d+ \(.*\) Z /.test(state)).toBe(true);
      });
    }
    try {
      if (cleanupStarted) {
        expect((await fs.readdir(root)).some(name => name.startsWith(`.${path.basename(targetPath)}.stale-`))).toBe(false);
        expect(await fs.readFile(path.join(targetPath, "new"), "utf8")).toBe("verified replacement");
        expect(await fs.readFile(path.join(root, "unrelated"), "utf8")).toBe("keep");
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }
});

it.each(["missing", "dangling-symlink", "symlink"])("installs when the previous target is %s", async kind => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-clear-target-"));
  const targetPath = path.join(root, "pack");
  const other = path.join(root, "other");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "keep"), "untouched");
  if (kind === "dangling-symlink") await fs.symlink(path.join(root, "absent"), targetPath);
  if (kind === "symlink") await fs.symlink(other, targetPath);
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async command => {
    const output = await exec(command.command, command.args ?? [], { cwd: root, timeout: command.timeoutMs });
    return result(output);
  });
  try {
    await uploadVerifiedProviderPack({
      root, sourceDigest: digest, expectedDigest: digest, runner: { execute }, cwd: root, targetPath, reuseRoots: [],
      verifyDirectory: () => {}, stageDirectory: async () => { await fs.mkdir(targetPath); },
      verifyUploaded: async () => { expect((await fs.lstat(targetPath)).isDirectory()).toBe(true); },
    });
    expect(execute).toHaveBeenCalledOnce();
    await vi.waitFor(async () => { expect((await fs.readdir(root)).filter(name => name.includes(".stale-"))).toEqual([]); });
    expect(await fs.readFile(path.join(other, "keep"), "utf8")).toBe("untouched");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
