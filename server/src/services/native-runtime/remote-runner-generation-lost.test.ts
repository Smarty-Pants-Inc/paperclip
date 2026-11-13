import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { remoteRunnerGenerationLost } from "./native-session-executor.js";

// RFL F1: a provider "restarted" label is only the trigger to look. The prior
// Runner is gone only when the box's launch marker names a process that is not
// running or has another start generation (boot id + start ticks).
const runner: CommandManagedRuntimeRunner = { execute: async input => {
  const result = spawnSync(input.command, input.args ?? [], { encoding: "utf8" });
  return { exitCode: result.status, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr };
} } as CommandManagedRuntimeRunner;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const fixture = (runnerInstanceId = randomUUID()) => {
  const remoteCwd = mkdtempSync(join(tmpdir(), "generation-lost-"));
  cleanups.push(() => rmSync(remoteCwd, { recursive: true, force: true }));
  const normalizedSessionId = randomUUID();
  const directory = join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "sessions",
    createHash("sha256").update(normalizedSessionId).digest("hex"), "runner");
  mkdirSync(directory, { recursive: true });
  const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)", "--", "--runner-id", runnerInstanceId], { stdio: "ignore" });
  cleanups.push(() => { try { owner.kill("SIGKILL"); } catch { /* already gone */ } });
  const stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
  const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
  const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const mark = (fingerprint = `linux:${boot}:${ticks}`, markerRunnerId = runnerInstanceId) =>
    writeFileSync(join(directory, "runner-process.identity"), `nonce${randomUUID().replaceAll("-", "")}\n${owner.pid}\n2026-11-13T10:00:00.000Z\n${markerRunnerId}\n${fingerprint}\n`);
  const lost = () => remoteRunnerGenerationLost({ runner, remoteCwd, identity: { runnerInstanceId, normalizedSessionId } });
  return { owner, mark, lost, boot, ticks };
};

it.skipIf(process.platform !== "linux")("never proves a live owner of the same generation gone", async () => {
  const { mark, lost } = fixture();
  expect(await lost()).toBe(false); // no marker
  mark();
  expect(await lost()).toBe(false); // the exact owner is alive on the same boot
  mark(undefined, randomUUID());
  expect(await lost()).toBe(false); // a marker for another runner instance proves nothing
});

it.skipIf(process.platform !== "linux")("proves the exact owner gone when its process exited or its generation changed", async () => {
  const changed = fixture();
  changed.mark(`linux:${randomUUID()}:${changed.ticks}`);
  expect(await changed.lost(), "another boot id: a new machine generation").toBe(true);
  const exited = fixture();
  exited.mark();
  exited.owner.kill("SIGKILL");
  await new Promise(resolve => exited.owner.once("exit", resolve));
  expect(await exited.lost(), "the exact owner process is gone").toBe(true);
});
