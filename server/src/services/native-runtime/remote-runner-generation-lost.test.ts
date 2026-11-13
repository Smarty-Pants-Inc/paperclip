import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { PREDECESSOR_LONG_STOP_MS, PREDECESSOR_LONG_STOP_PROVES_LOSS_ALONE, PREDECESSOR_SANDBOX_READ_TIMEOUT_MS,
  remoteRunnerGenerationLost, type PredecessorSandboxRecord } from "./native-session-executor.js";

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
  // The provider's own record of the PREDECESSOR's sandbox, read by the caller.
  const lostWith = (record: PredecessorSandboxRecord | Error | "hang", options: { longStopProvesLossAlone?: boolean } = {}) => {
    const reads: number[] = [];
    return { reads, result: remoteRunnerGenerationLost({ runner, remoteCwd, identity: { runnerInstanceId, normalizedSessionId },
      predecessor: { start: { at: "2026-11-13T10:00:00.000Z", source: "process" }, readSandbox: async () => {
        reads.push(Date.now());
        if (record === "hang") return new Promise<PredecessorSandboxRecord>(() => {});
        if (record instanceof Error) throw record;
        return record;
      } },
      now: () => Date.parse("2026-11-13T11:00:00.000Z"), ...options }) };
  };
  return { owner, mark, lost, lostWith, boot, ticks };
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

const present = (state: string, stoppedAt: string | null = null, lastRebootAt: string | null = null): PredecessorSandboxRecord =>
  ({ kind: "present", state, stoppedAt, lastRebootAt });
// "now" is 11:00; the predecessor's process started at 10:00.
const minutesAgo = (minutes: number) => new Date(Date.parse("2026-11-13T11:00:00.000Z") - minutes * 60_000).toISOString();

it.skipIf(process.platform !== "linux")("provider record (1): the predecessor's sandbox is gone: lost; a raw provider state name is not gone", async () => {
  const { mark, lostWith } = fixture();
  mark(); // even with the marker's process alive here: the predecessor's own box is gone
  expect(await lostWith({ kind: "gone" }).result).toBe(true);
  // The plugin maps 404/cancelled to destroyed (gone); Core reads no raw names.
  expect(await lostWith(present("cancelled")).result).toBe(false);
});

it.skipIf(process.platform !== "linux")("provider record (2): a reboot after the predecessor's recorded start: lost; before it: the probe decides", async () => {
  const { mark, lostWith } = fixture();
  mark();
  expect(await lostWith(present("running", null, "2026-11-13T10:30:00.000Z")).result).toBe(true);
  expect(await lostWith(present("running", null, "2026-11-13T09:30:00.000Z")).result, "an older reboot proves nothing").toBe(false);
});

it.skipIf(process.platform !== "linux")("provider record (3): exactly stopped for at least 15 minutes: lost (RFL ruling), by the provider's clock", async () => {
  expect(PREDECESSOR_LONG_STOP_PROVES_LOSS_ALONE).toBe(true);
  const { mark, lostWith } = fixture();
  mark(); // the marker's process is alive here: the long stop alone decides
  expect(await lostWith(present("stopped", minutesAgo(PREDECESSOR_LONG_STOP_MS / 60_000))).result).toBe(true);
  expect(await lostWith(present("archived", minutesAgo(60))).result, "a raw provider state name: not proven").toBe(false);
  expect(await lostWith(present("stopped", minutesAgo(20))).result).toBe(true);
  // Skewed clocks: the provider's Date header wins over this server's clock.
  expect(await lostWith({ ...present("stopped", minutesAgo(20)), observedAt: minutesAgo(10) } as PredecessorSandboxRecord).result,
    "server says 20 min, Boat says 10: not proven").toBe(false);
  expect(await lostWith({ ...present("stopped", minutesAgo(10)), observedAt: "2026-11-13T11:10:00.000Z" } as PredecessorSandboxRecord).result,
    "server says 10 min, Boat says 20: lost").toBe(true);
  // The switch back to "needs the failed probe too" keeps a live owner.
  expect(await lostWith(present("stopped", minutesAgo(20)), { longStopProvesLossAlone: false }).result).toBe(false);
});

it.skipIf(process.platform !== "linux")("provider record (4): stopped 14 minutes, still stopping, or no stoppedAt: not proven", async () => {
  const { mark, lostWith } = fixture();
  mark();
  expect(await lostWith(present("stopped", minutesAgo(14))).result).toBe(false);
  expect(await lostWith(present("stopped", minutesAgo(5))).result).toBe(false);
  for (const state of ["archiving", "stopping", "starting", "resuming", "error", "unknown"]) {
    expect(await lostWith(present(state, minutesAgo(30))).result, state).toBe(false);
  }
  expect(await lostWith(present("stopped", null)).result, "missing stoppedAt").toBe(false);
});

it.skipIf(process.platform !== "linux")("provider record (5): a running predecessor sandbox: the marker probe decides", async () => {
  const live = fixture();
  live.mark();
  expect(await live.lostWith(present("running")).result).toBe(false);
  const changed = fixture();
  changed.mark(`linux:${randomUUID()}:${changed.ticks}`);
  expect(await changed.lostWith(present("idle")).result).toBe(true);
});

it.skipIf(process.platform !== "linux")("provider record (6): a failed or timed-out provider read proves nothing", async () => {
  const { mark, lostWith } = fixture();
  mark();
  expect(await lostWith(new Error("Boat GET /sandboxes/bx_1 failed (502)")).result).toBe(false);
  const started = Date.now();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const hung = lostWith("hang");
    await vi.advanceTimersByTimeAsync(PREDECESSOR_SANDBOX_READ_TIMEOUT_MS + 1);
    vi.useRealTimers();
    expect(await hung.result).toBe(false);
    expect(hung.reads).toHaveLength(1);
  } finally { vi.useRealTimers(); }
  expect(Date.now() - started).toBeLessThan(PREDECESSOR_SANDBOX_READ_TIMEOUT_MS);
});

it.skipIf(process.platform !== "linux")("provider record (7): impossible, zone-less or garbage timestamps prove nothing", async () => {
  const { mark, lostWith } = fixture();
  mark();
  for (const bad of ["2026-02-30T10:30:00.000Z", "2026-11-13T10:30:00", "garbage", "2026-11-13T24:00:00Z", "2026-11-13T10:60:00Z"]) {
    expect(await lostWith(present("running", null, bad)).result, `lastRebootAt ${bad}`).toBe(false);
    expect(await lostWith(present("stopped", bad)).result, `stoppedAt ${bad}`).toBe(false);
    expect(await lostWith({ ...present("stopped", minutesAgo(10)), observedAt: bad } as PredecessorSandboxRecord).result,
      `observedAt ${bad} falls back to this server's clock: 10 min, not proven`).toBe(false);
  }
  // An offset zone is a real instant: 10:30+00:30 is 10:00Z, not after the 10:00Z start.
  expect(await lostWith(present("running", null, "2026-11-13T10:30:00+00:30")).result).toBe(false);
  expect(await lostWith(present("running", null, "2026-11-13T10:30:00-00:30")).result).toBe(true);
});
