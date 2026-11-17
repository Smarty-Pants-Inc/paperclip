import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNativeHandoffDeadline } from "./native-handoff-deadline.js";
import { inspectSandboxSessionRunner, retireSandboxRunnerPortHolders, SANDBOX_SESSION_RUNNER_INSPECT_SCRIPT } from "./sandbox-runner-port-holders.js";

const localRunner = (script: string) => ({ execute: async (request: { command: string; args?: string[] }) => {
  const args = [...request.args ?? []];
  args[3] = script;
  const result = spawnSync(request.command, args, { encoding: "utf8", timeout: 10_000 });
  return { exitCode: result.status, timedOut: result.error !== undefined, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
} });

async function fakeProcess(proc: string, pid: number, argv: string[], state = "S") {
  await mkdir(join(proc, String(pid)), { recursive: true });
  await writeFile(join(proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
  await writeFile(join(proc, String(pid), "stat"), `${pid} (${argv[0]?.split("/").pop()}) ${state} 1 ${pid} ${pid}\n`);
}

describe("sandbox session Runner inspection", () => {
  it("reports the durable state, the marker pid and each process carrying the runner id, never the nonce or command lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-inspect-"));
    const proc = join(root, "proc");
    const state = join(root, "runner");
    try {
      await mkdir(join(proc, "self"), { recursive: true });
      await writeFile(join(proc, "self", "cmdline"), "node\0");
      await mkdir(state, { recursive: true });
      await writeFile(join(state, "runner-process.identity"), "private-nonce\n522\n2026-11-16T00:47:54.000Z\nrunner-1\nlinux:abcd:100\n");
      await writeFile(join(state, "runner-state.json"), JSON.stringify({ runnerInstanceId: "runner-1", runId: "run-1",
        normalizedSessionId: "session-1", lifecycle: "suspended", outbox: [], pendingTerminalDelivery: null, secret: "private-token" }));
      await fakeProcess(proc, 522, ["/opt/bin/paperclip-runnerd", "--runner-id", "runner-1", "--token", "private-token"]);
      await fakeProcess(proc, 600, ["/opt/bin/paperclip-runnerd", "--runner-id", "runner-2"], "Z");
      await fakeProcess(proc, 700, ["sleep", "100"]);
      const script = SANDBOX_SESSION_RUNNER_INSPECT_SCRIPT.replaceAll("'/proc", `'${proc}`);
      const inspect = () => inspectSandboxSessionRunner({ runner: localRunner(script) as never, stateDirectory: state });
      const inspection = await inspect();
      expect(inspection).toEqual({
        state: { lifecycle: "suspended", runId: "run-1", normalizedSessionId: "session-1", runnerInstanceId: "runner-1", settled: true },
        markerPid: 522, markerRunnerIdMatchesState: true, procfs: true, unreadableProcesses: 0,
        processes: [{ pid: 522, state: "S", carriesRunnerId: true }, { pid: 600, state: "Z", carriesRunnerId: false }],
      });
      expect(JSON.stringify(inspection)).not.toMatch(/private/);
      await rm(join(proc, "522"), { recursive: true });
      await writeFile(join(state, "runner-state.json"), JSON.stringify({ runnerInstanceId: "runner-1", runId: "run-1",
        normalizedSessionId: "session-1", lifecycle: "suspended", outbox: [{ seq: 1 }], pendingTerminalDelivery: null }));
      expect(await inspect()).toMatchObject({ state: { settled: false }, unreadableProcesses: 0,
        processes: [{ pid: 600, carriesRunnerId: false }] });
      await mkdir(join(proc, "800", "cmdline"), { recursive: true });
      expect(await inspect()).toMatchObject({ procfs: true, unreadableProcesses: 1, processes: [{ pid: 600 }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("fails closed without a process table and never reads state through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-inspect-noproc-"));
    const state = join(root, "runner");
    try {
      await mkdir(state, { recursive: true });
      await writeFile(join(root, "elsewhere.json"), JSON.stringify({ lifecycle: "suspended", runnerInstanceId: "runner-1" }));
      await symlink(join(root, "elsewhere.json"), join(state, "runner-state.json"));
      const script = SANDBOX_SESSION_RUNNER_INSPECT_SCRIPT.replaceAll("'/proc", `'${join(root, "missing-proc")}`);
      expect(await inspectSandboxSessionRunner({ runner: localRunner(script) as never, stateDirectory: state })).toEqual({
        state: null, markerPid: null, markerRunnerIdMatchesState: false, procfs: false, unreadableProcesses: 0, processes: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// pl/s3-fence-deadline: the successor's ONE Stop-origin handoff deadline is
// passed to every remote command. A command still in flight at expiry is
// aborted (its signal fires), no later command starts, the database is never
// read and nothing is recorded: one typed outcome naming the deadline.
describe("sandbox Runner port holders under the handoff deadline", () => {
  it("aborts an in-flight remote command at the deadline and starts no other", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const timeouts: number[] = [];
      const runner = { execute: vi.fn((request: { timeoutMs?: number; signal?: AbortSignal }) => {
        timeouts.push(request.timeoutMs ?? -1);
        if (request.signal) signals.push(request.signal);
        // A provider that ignores its timeout: only the abort ends it.
        return new Promise<never>(() => undefined);
      }) };
      const db = new Proxy({}, { get: () => { throw new Error("the database must not be read after expiry"); } });
      const handoff = createNativeHandoffDeadline({ stopRequestedAtMs: Date.now() - 55_000, admissionStartedAtMs: Date.now() });
      expect(handoff.origin).toBe("stop");
      const outcome = retireSandboxRunnerPortHolders({ db: db as never, companyId: "c", agentId: "a", runId: "r",
        runner: runner as never, runtimeRoot: "/w/.paperclip-runtime/paperclip-runner", ownSessionRoot: "", providerLeaseId: "box",
        retireInProcess: async () => false, handoff }).then(() => "retired", (error: Error & { code?: string }) =>
        `${error.code}: ${String(error.cause)}`);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatch(/^native_predecessor_retirement_unproven: .*native_handoff_deadline_expired/);
      expect(runner.execute).toHaveBeenCalledTimes(1);
      expect(timeouts).toEqual([5_000]);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
      // A budget already spent (Stop exactly 60 s ago) starts no command at all.
      const spent = createNativeHandoffDeadline({ stopRequestedAtMs: Date.now() - 60_000, admissionStartedAtMs: Date.now() });
      await expect(retireSandboxRunnerPortHolders({ db: db as never, companyId: "c", agentId: "a", runId: "r",
        runner: runner as never, runtimeRoot: "/w", ownSessionRoot: "", providerLeaseId: "box",
        retireInProcess: async () => false, handoff: spent })).rejects.toMatchObject({ code: "native_predecessor_retirement_unproven" });
      expect(spent.remainingMs()).toBe(0);
      expect(runner.execute).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
