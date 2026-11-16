import { describe, expect, it, vi } from "vitest";
import { prepareGitHubExecutionEnvironment } from "./execution-target.js";
import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";

// Keep: SMA-161's remote-exec stall and the provider-text trust boundary.
// Exercise the actual Git-context probe, not a standalone retry helper.
describe("execution-target Git context retry", () => {
  const secret = "git-context-provider-secret-sentinel";
  const success: Awaited<ReturnType<CommandManagedRuntimeRunner["execute"]>> = {
    exitCode: 0, timedOut: false, signal: null, stderr: "", durationMs: 23, pid: null, startedAt: null,
    stdout: "\0PAPERCLIP_GIT_CONTEXT_V1\0PAPERCLIP_GIT_METADATA_ROOT\0/workspace/.git\0\0PAPERCLIP_GIT_CONTEXT_END\0" };
  const timeout = { ...success, stdout: "", timedOut: true, exitCode: 143, signal: "SIGTERM", durationMs: 15_080 };

  function fixture(results: Array<typeof success | Error>) {
    const execute = vi.fn(async (_request: Parameters<CommandManagedRuntimeRunner["execute"]>[0]) => {
      const result = results[Math.min(execute.mock.calls.length - 1, results.length - 1)]!;
      if (result instanceof Error) throw result;
      return result;
    });
    const onWarning = vi.fn();
    const input = { runId: "git-context-run", target: { kind: "remote" as const, transport: "sandbox" as const,
      providerKey: "fixture", remoteCwd: "/workspace", runner: { execute, allowConcurrentSyncOperations: true } },
      cwd: "/controller-only", env: {}, hostCredentials: false, networkAccess: true, onWarning };
    return { execute, onWarning, prepare: () => prepareGitHubExecutionEnvironment(input) };
  }

  it("retries one timeout after one second, preserving the 15-second limit and target cwd", async () => {
    const test = fixture([timeout, success]);
    const started = performance.now();
    await expect(test.prepare()).resolves.toMatchObject({ PAPERCLIP_GIT_METADATA_ROOTS: '["/workspace/.git"]' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(test.execute).toHaveBeenCalledTimes(2);
    for (const [request] of test.execute.mock.calls) {
      expect(request).toMatchObject({ command: "sh", cwd: "/workspace", timeoutMs: 15_000 });
    }
    expect(test.onWarning).toHaveBeenCalledOnce();
    expect(test.onWarning).toHaveBeenCalledWith(expect.objectContaining({ runId: "git-context-run",
      timedOut: true, exitCode: 143, signal: "SIGTERM", durationMs: 15_080, stderrClass: "other", willRetry: true }), expect.any(String));
  });

  it("fails exactly once after two timeouts with a named error retaining both durations", async () => {
    const test = fixture([timeout, { ...timeout, durationMs: 15_090, stderr: secret }]);
    let failures = 0;
    const error = await test.prepare().catch((error: unknown) => { failures++; return error; });
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "ExecutionTargetGitContextError", reason: "EXECUTION_TARGET_GIT_CONTEXT_FAILED",
      runId: "git-context-run", timedOut: true, exitCode: 143, signal: "SIGTERM", durationMs: 15_090, stderrClass: "other",
      attempts: [expect.objectContaining({ durationMs: 15_080 }), expect.objectContaining({ durationMs: 15_090 })] });
    expect(failures).toBe(1);
    expect(test.execute).toHaveBeenCalledTimes(2);
    expect(test.onWarning).toHaveBeenCalledTimes(2);
    expect(test.onWarning).toHaveBeenLastCalledWith(expect.objectContaining({ runId: "git-context-run", durationMs: 15_090, willRetry: false }), expect.any(String));
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(test.onWarning.mock.calls)).not.toContain(secret);
  });

  it.each([false, true])("normalizes a rejected RPC without retaining its secret or cause (rejectTwice=%s)", async rejectTwice => {
    const rejected = Object.assign(new Error(`unsafe ${secret}`, { cause: new Error(secret) }), { providerDetail: secret });
    const test = fixture([rejected, rejectTwice ? rejected : success]);
    const result = await test.prepare().catch((error: unknown) => error);
    expect(test.execute).toHaveBeenCalledTimes(2);
    expect(test.onWarning).toHaveBeenCalledTimes(rejectTwice ? 2 : 1);
    expect(test.onWarning).toHaveBeenNthCalledWith(1, expect.objectContaining({ runId: "git-context-run", stderrClass: "transport",
      timedOut: false, exitCode: null, signal: null, durationMs: expect.any(Number), willRetry: true }), expect.any(String));
    if (rejectTwice) {
      expect(result).toMatchObject({ name: "ExecutionTargetGitContextError", stderrClass: "transport",
        attempts: [expect.objectContaining({ stderrClass: "transport" }), expect.objectContaining({ stderrClass: "transport" })] });
      expect(result).not.toHaveProperty("cause");
      expect(result).not.toHaveProperty("providerDetail");
    } else expect(result).toMatchObject({ PAPERCLIP_GIT_METADATA_ROOTS: '["/workspace/.git"]' });
    expect(String(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(test.onWarning.mock.calls)).not.toContain(secret);
  });

  it.each(["EEXIST", "ENOENT", "other"])("retries a non-zero %s exit once without exposing stderr", async stderr => {
    const test = fixture([{ ...success, exitCode: 1, stderr: `${stderr} ${secret}` }, success]);
    await expect(test.prepare()).resolves.toMatchObject({ PAPERCLIP_GIT_METADATA_ROOTS: '["/workspace/.git"]' });
    expect(test.execute).toHaveBeenCalledTimes(2);
    expect(test.onWarning).toHaveBeenCalledWith(expect.objectContaining({ stderrClass: stderr.toLowerCase(), willRetry: true }), expect.any(String));
    expect(JSON.stringify(test.onWarning.mock.calls)).not.toContain(secret);
  });

  it("never retries an unsafe verdict, even on timeout", async () => {
    const test = fixture([{ ...timeout, stderr: `Unsafe ${secret}` }, success]);
    const error = await test.prepare().catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "ExecutionTargetGitContextError", stderrClass: "unsafe", attempts: [expect.objectContaining({ stderrClass: "unsafe" })] });
    expect(test.execute).toHaveBeenCalledOnce();
    expect(test.onWarning).toHaveBeenCalledWith(expect.objectContaining({ willRetry: false }), expect.any(String));
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(test.onWarning.mock.calls)).not.toContain(secret);
  });

  it("does not accept timed-out output even when the exit code is zero", async () => {
    const test = fixture([{ ...success, timedOut: true }, success]);
    await expect(test.prepare()).resolves.toMatchObject({ PAPERCLIP_GIT_METADATA_ROOTS: '["/workspace/.git"]' });
    expect(test.execute).toHaveBeenCalledTimes(2);
  });

  it("keeps malformed successful output a non-retried, named failure", async () => {
    const test = fixture([{ ...success, stdout: secret }]);
    const error = await test.prepare().catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "ExecutionTargetGitContextError" });
    expect(test.execute).toHaveBeenCalledOnce();
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});
