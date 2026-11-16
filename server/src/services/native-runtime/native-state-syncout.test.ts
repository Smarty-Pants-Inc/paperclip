import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
