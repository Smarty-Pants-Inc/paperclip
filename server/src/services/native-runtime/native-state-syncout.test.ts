import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteRunnerStateFile } from "./native-session-executor.js";

const stateBytes = JSON.stringify({ principalSession: "private-session-state", n: 7 });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function syncRunner(opts: { content?: string; failParse?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const files = new Map<string, string>();
  const runner = {
    execute: vi.fn(async ({ command, args }: { command: string; args: string[] }) => {
      calls.push({ command, args });
      const script = args[1] ?? "";
      if (script.includes("test -f")) return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
      return { exitCode: 99, timedOut: false, stdout: "", stderr: "" };
    }),
    syncOut: vi.fn(async (ops: Array<{ files: Array<{ sourcePath: string; targetPath: string }> }>) => {
      for (const file of ops.flatMap(op => op.files)) {
        files.set(file.targetPath, opts.failParse ? "not-json" : opts.content ?? stateBytes);
      }
      return { operations: [] };
    }),
    __calls: calls,
    __files: files,
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
    const destination = [...runner.__files.keys()][0];
    expect(destination).toBeTruthy();
    expect(existsSync(join(destination, ".."))).toBe(false);
  });

  it("removes its private staging directory after a parse failure", async () => {
    const runner = syncRunner({ failParse: true });
    await expect(readRemoteRunnerStateFile({ runner: runner as never, remotePath: "/private/runner-state.json" })).rejects.toThrow();
    expect(runner.__files.size).toBe(1);
    const dir = [...runner.__files.keys()][0].split("/").slice(0, -1).join("/");
    expect(existsSync(dir)).toBe(false);
  });

  it("preserves exit-66 missing-state meaning and command fallback logging", async () => {
    const missing = { execute: vi.fn(async () => ({ exitCode: 66, timedOut: false, stdout: "", stderr: "" })) };
    await expect(readRemoteRunnerStateFile({ runner: missing as never, remotePath: "/private/runner-state.json" })).rejects.toMatchObject({ exitCode: 66 });
    const root = mkdtempSync(join(tmpdir(), "native-state-fallback-")); dirs.push(root);
    const encoded = Buffer.from(stateBytes).toString("base64");
    const fallback = { execute: vi.fn(async () => ({ exitCode: 0, timedOut: false, stdout: encoded, stderr: "" })) };
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await readRemoteRunnerStateFile({ runner: fallback as never, remotePath: "/private/runner-state.json" })).toEqual(JSON.parse(stateBytes));
      expect(fallback.execute).toHaveBeenCalledTimes(1);
      expect(log.mock.calls.flat().join(" ")).toContain("session state read via command; output retained by provider");
      expect(log.mock.calls.flat().join(" ")).not.toContain(stateBytes);
      expect(log.mock.calls.flat().join(" ")).not.toContain("https://");
    } finally { log.mockRestore(); }
  });
});
