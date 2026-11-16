import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../../middleware/logger.js";
import { readRemoteRunnerRecoveryError } from "./remote-runner-recovery-diagnostics.js";
import {
  readRemoteRunnerProviderState,
  readRemoteRunnerState,
  readRemoteRunnerStateFile,
} from "./native-session-executor.js";

const stateBytes = JSON.stringify({ principalSession: "private-session-state", n: 7 });
function syncRunner(opts: { content?: string; failParse?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const files = new Map<string, string>();
  const modes: number[] = [];
  const runner = {
    execute: vi.fn(async ({ command, args }: { command: string; args: string[] }) => {
      calls.push({ command, args });
      const script = args[1] ?? "";
      if (script.includes("test -f")) return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      return { exitCode: 99, timedOut: false, stdout: "", stderr: "" };
    }),
    syncOut: vi.fn(async (ops: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>) => {
      for (const file of ops.flatMap(op => op.files)) {
        const content = opts.failParse ? "not-json" : opts.content ?? stateBytes;
        mkdirSync(dirname(file.targetPath), { recursive: true });
        writeFileSync(file.targetPath, content, { mode: 0o600 });
        modes.push(statSync(dirname(file.targetPath)).mode & 0o777, statSync(file.targetPath).mode & 0o777);
        files.set(file.targetPath, content);
      }
      return { operations: [] };
    }),
    __calls: calls,
    __files: files,
    __modes: modes,
  };
  return runner;
}

describe("native session state syncOut", () => {
  it("reads state bytes through syncOut, parses them, and never emits base64 output commands", async () => {
    const runner = syncRunner();
    const state = await readRemoteRunnerStateFile({ runner: runner as never, remotePath: "/private/runner-state.json" });
    expect(state).toEqual(JSON.parse(stateBytes));
    expect(runner.execute.mock.calls.filter(([request]) => request.args?.join(" ").includes("base64 <"))).toHaveLength(0);
    expect(runner.syncOut).toHaveBeenCalledTimes(1);
    expect(runner.__modes).toEqual([0o700, 0o600]);
    const destination = [...runner.__files.keys()][0];
    expect(destination).toBeTruthy();
    expect(existsSync(dirname(destination))).toBe(false);

    const runnerStateRunner = syncRunner();
    expect(await readRemoteRunnerState({ runner: runnerStateRunner as never, stateDirectory: "/private" })).toEqual(JSON.parse(stateBytes));
    const providerRunner = syncRunner();
    expect(await readRemoteRunnerProviderState({ runner: providerRunner as never, stateDirectory: "/private", execution: { provider: { kind: "muse" } } as never })).toEqual(JSON.parse(stateBytes));
    for (const called of [runner, runnerStateRunner, providerRunner]) {
      expect(called.execute.mock.calls.flatMap(([request]) => request.args ?? []).join(" ")).not.toContain("base64 <");
    }
  });

  it("preserves a recovery probe diagnostic on syncOut and fallback reads", async () => {
    const diagnostics: unknown[] = [];
    for (const syncOut of [true, false]) {
      const runner = {
        execute: vi.fn(async () => ({ exitCode: 0, timedOut: true, stdout: "", stderr: "" })),
        ...(syncOut ? { syncOut: vi.fn(async () => ({ operations: [] })) } : {}),
      };
      let thrown: unknown;
      try {
        await readRemoteRunnerState({ runner: runner as never, stateDirectory: "/private",
          recoveryDeadline: Date.now() + 1 });
      } catch (error) { thrown = error; }
      diagnostics.push(readRemoteRunnerRecoveryError(thrown));
    }
    expect(diagnostics).toEqual([
      { stage: "runner_state", reason: "probe_timeout" },
      { stage: "runner_state", reason: "probe_timeout" },
    ]);
  });

  it("removes its private staging directory after a parse failure", async () => {
    const runner = syncRunner({ failParse: true });
    await expect(readRemoteRunnerStateFile({ runner: runner as never, remotePath: "/private/runner-state.json" })).rejects.toThrow();
    expect(runner.__files.size).toBe(1);
    const dir = [...runner.__files.keys()][0].split("/").slice(0, -1).join("/");
    expect(existsSync(dir)).toBe(false);
  });

  it("preserves the configured missing-state exit when syncOut reports an absent source", async () => {
    const execute = vi.fn(async ({ args }: { args?: string[] }) => args?.[1]?.includes("> /dev/null")
      ? { exitCode: 66, timedOut: false, stdout: "", stderr: "" }
      : { exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    const runner = { execute, syncOut: vi.fn(async () => { throw Object.assign(new Error("ENOENT: remote state file"), { code: "ENOENT" }); }) };
    const failure = await readRemoteRunnerStateFile({ runner: runner as never, remotePath: "/private/runner-state.json" })
      .then(() => null, error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/^runner_remote_state_unavailable: exit=66 timedOut=false(?:\s|$)/);
    expect(failure).toMatchObject({ exitCode: 66, timedOut: false });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0].args?.[1]).toContain("base64 < '/private/runner-state.json' > /dev/null");
  });

  it("preserves the unreadable-state exit and diagnostic after syncOut fails", async () => {
    const execute = vi.fn(async ({ args }: { args?: string[] }) => args?.[1]?.includes("> /dev/null")
      ? { exitCode: 1, timedOut: false, stdout: "", stderr: "base64: /private/runner-state.json: Permission denied" }
      : { exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    const runner = { execute, syncOut: vi.fn(async () => { throw new Error("Kubernetes syncOut failed: source could not be read"); }) };
    const failure = await readRemoteRunnerStateFile({ runner: runner as never, remotePath: "/private/runner-state.json" })
      .then(() => null, error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/^runner_remote_state_unavailable: exit=1 timedOut=false base64: \/private\/runner-state\.json: Permission denied$/);
    expect(failure).toMatchObject({ exitCode: 1, timedOut: false });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("preserves provider-state transport failures from the active read transport", async () => {
    const failure = Object.assign(new Error("Daytona syncOut file download failed: socket hang up"), { code: "ECONNRESET" });
    const runner = {
      execute: vi.fn(async ({ args }: { args?: string[] }) => {
        if (args?.[1]?.includes("base64 <")) throw failure;
        return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      }),
      syncOut: vi.fn(async () => { throw failure; }),
    };
    await expect(readRemoteRunnerProviderState({ runner: runner as never, stateDirectory: "/private",
      execution: { provider: { kind: "opencode" } } as never })).rejects.toBe(failure);
  });

  it("preserves provider-state parse failures from syncOut", async () => {
    const runner = syncRunner({ failParse: true });
    await expect(readRemoteRunnerProviderState({ runner: runner as never, stateDirectory: "/private",
      execution: { provider: { kind: "opencode" } } as never })).rejects.toBeInstanceOf(SyntaxError);
  });

  it("preserves exit-66 missing-state meaning and command fallback logging", async () => {
    const missing = { execute: vi.fn(async () => ({ exitCode: 66, timedOut: false, stdout: "", stderr: "" })) };
    await expect(readRemoteRunnerStateFile({ runner: missing as never, remotePath: "/private/runner-state.json" })).rejects.toMatchObject({ exitCode: 66 });
    const encoded = Buffer.from(stateBytes).toString("base64");
    const fallback = { execute: vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: encoded, stderr: "" })) };
    const log = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      expect(await readRemoteRunnerStateFile({ runner: fallback as never, remotePath: "/private/runner-state.json" })).toEqual(JSON.parse(stateBytes));
      expect(fallback.execute).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.flat().join(" ")).toContain("session state read via command; output retained by provider");
      expect(log.mock.calls.flat().join(" ")).not.toContain(stateBytes);
      expect(log.mock.calls.flat().join(" ")).not.toContain("https://");
    } finally { log.mockRestore(); }
  });
});

describe("native session state syncOut under a recovery deadline", () => {
  afterEach(() => { vi.useRealTimers(); });
  const okProbe = () => vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }));
  const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  type Ops = Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>;
  const writeState = (ops: Ops, bytes: string) => {
    for (const file of ops.flatMap(op => op.files)) {
      mkdirSync(dirname(file.targetPath), { recursive: true });
      writeFileSync(file.targetPath, bytes, { mode: 0o600 });
    }
    return { operations: [] };
  };
  // Observes a read without awaiting it, so a read that never settles fails an
  // assertion instead of hanging the test.
  const observe = <T>(promise: Promise<T>) => {
    let outcome: { value?: T; error?: unknown; at: number } | undefined;
    promise.then(value => { outcome = { value, at: Date.now() }; }, error => { outcome = { error, at: Date.now() }; });
    return () => outcome;
  };

  it("recovers a state read when one syncOut transfer resets and the next succeeds", async () => {
    vi.useFakeTimers();
    const syncOut = vi.fn()
      .mockImplementationOnce(async () => { throw reset(); })
      .mockImplementation(async (ops: Ops) => writeState(ops, stateBytes));
    const read = observe(readRemoteRunnerState({ runner: { execute: okProbe(), syncOut } as never,
      stateDirectory: "/private", recoveryDeadline: Date.now() + 30_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read()?.error).toBeUndefined();
    expect(read()?.value).toEqual(JSON.parse(stateBytes));
    expect(syncOut).toHaveBeenCalledTimes(2);
  });

  it("classes a syncOut transport failure on every attempt as probe_transport_failed", async () => {
    vi.useFakeTimers();
    const syncOut = vi.fn(async () => { throw reset(); });
    const read = observe(readRemoteRunnerState({ runner: { execute: okProbe(), syncOut } as never,
      stateDirectory: "/private", recoveryDeadline: Date.now() + 2_000 }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read()).toBeDefined();
    expect(readRemoteRunnerRecoveryError(read()?.error)).toEqual({ stage: "runner_state", reason: "probe_transport_failed" });
    expect(read()?.error).toMatchObject({ code: "ECONNRESET" });
    expect(syncOut.mock.calls.length).toBeGreaterThan(1);
  });

  it("times a syncOut transfer that outlives the recovery deadline out at the deadline", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const syncOut = vi.fn(async (ops: Ops) => { await released; return writeState(ops, stateBytes); });
    const deadline = Date.now() + 5_000;
    const read = observe(readRemoteRunnerState({ runner: { execute: okProbe(), syncOut } as never,
      stateDirectory: "/private", recoveryDeadline: deadline }));
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(read()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(read()).toBeDefined();
      expect(read()?.at).toBe(deadline);
      expect(readRemoteRunnerRecoveryError(read()?.error)).toEqual({ stage: "runner_state", reason: "probe_timeout" });
    } finally {
      release();
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("parses only the bytes of the attempt that succeeded, never an earlier attempt's partial write", async () => {
    vi.useFakeTimers();
    const secondBytes = JSON.stringify({ principalSession: "attempt-2", n: 2 });
    const partialBytes = '{"principalSession":"attempt-1-partial-bytes-left-behind-by-a-reset-transfer","n":';
    const targets: string[] = [];
    const syncOut = vi.fn()
      .mockImplementationOnce(async (ops: Ops) => {
        for (const file of ops.flatMap(op => op.files)) targets.push(file.targetPath);
        writeState(ops, partialBytes);
        throw reset();
      })
      .mockImplementation(async (ops: Ops) => {
        // Writes from offset 0 without truncating, as a resumed stream would.
        for (const file of ops.flatMap(op => op.files)) {
          targets.push(file.targetPath);
          mkdirSync(dirname(file.targetPath), { recursive: true });
          const fd = openSync(file.targetPath, existsSync(file.targetPath) ? "r+" : "w", 0o600);
          try { writeSync(fd, secondBytes, 0); } finally { closeSync(fd); }
        }
        return { operations: [] };
      });
    const read = observe(readRemoteRunnerState({ runner: { execute: okProbe(), syncOut } as never,
      stateDirectory: "/private", recoveryDeadline: Date.now() + 30_000 }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read()?.error).toBeUndefined();
    expect(read()?.value).toEqual(JSON.parse(secondBytes));
    expect(targets).toHaveLength(2);
    for (const target of targets) expect(existsSync(dirname(target))).toBe(false);
  });

  it("leaves no staged state bytes behind when a transfer abandoned at the deadline settles later", async () => {
    vi.useFakeTimers();
    const lateBytes = JSON.stringify({ principalSession: `late-transfer-${randomUUID()}` });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const targets: string[] = [];
    let transfer: Promise<unknown> | undefined;
    const syncOut = vi.fn((ops: Ops) => {
      for (const file of ops.flatMap(op => op.files)) targets.push(file.targetPath);
      // File sync recreates the target's parent before it writes.
      transfer = released.then(() => writeState(ops, lateBytes));
      return transfer;
    });
    const deadline = Date.now() + 3_000;
    const read = observe(readRemoteRunnerState({ runner: { execute: okProbe(), syncOut } as never,
      stateDirectory: "/private", recoveryDeadline: deadline }));
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(readRemoteRunnerRecoveryError(read()?.error)).toEqual({ stage: "runner_state", reason: "probe_timeout" });
    } finally {
      release();
      await transfer;
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(existsSync(dirname(target))).toBe(false);
    const leftovers = readdirSync(tmpdir()).filter(name => name.startsWith("paperclip-native-state-"))
      .flatMap(name => { try { return readdirSync(join(tmpdir(), name)).map(file => join(tmpdir(), name, file)); } catch { return []; } })
      .filter(path => { try { return readFileSync(path, "utf8").includes(lateBytes); } catch { return false; } });
    expect(leftovers).toEqual([]);
  });
});
