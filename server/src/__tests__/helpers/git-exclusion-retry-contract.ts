import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as execution from "@paperclipai/adapter-utils/execution-target";
import * as ssh from "@paperclipai/adapter-utils/ssh";
import { logger } from "../../middleware/logger.js";

// Keep: the recorded sandbox-exec timeout incident and the unsafe-path trust
// boundary. Exercise each real prepare entry point, not only a retry helper.
export function gitExclusionRetryContract(
  prepare: (runId: string, target: execution.AdapterExecutionTarget) => Promise<unknown>,
  cleanup: () => Promise<void>,
  nextTry: (runId: string, error: Error) => Promise<string>,
) {
  describe("remote Git exclusion retry contract", () => {
    const secret = "secret-that-must-not-reach-the-error-or-log";
    const success: Awaited<ReturnType<typeof execution.runAdapterExecutionTargetShellCommand>> = { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null, durationMs: 23 };
    const timeout = { ...success, exitCode: 143, signal: "SIGTERM", timedOut: true, durationMs: 15_080 };
    const remote = (): Extract<execution.AdapterExecutionTarget, { kind: "remote" }> => ({ kind: "remote", transport: "ssh", environmentId: randomUUID(), remoteCwd: "/fixture/git-exclusion-task",
      spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd: "/fixture/git-exclusion-task", remoteWorkspacePath: "/fixture/git-exclusion-task", privateKey: null, knownHosts: null, strictHostKeyChecking: true } });
    beforeEach(() => {
      vi.spyOn(ssh, "syncDirectoryToSsh").mockResolvedValue(undefined);
      vi.spyOn(execution, "prepareAdapterExecutionTargetRuntime").mockImplementation(async input => ({
        target: input.target!, workspaceRemoteDir: input.workspaceRemoteDir ?? "/fixture/git-exclusion-task", runtimeRootDir: input.runtimeRootDir ?? null,
        assetDirs: { instructions: path.posix.join("/fixture/git-exclusion-task", ".paperclip-runtime", `instruction-edits-${input.runId}`, "instructions") },
        additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null, restoreWorkspace: async () => {},
      }));
    });
    afterEach(async () => { vi.restoreAllMocks(); await cleanup(); });

    function stub(results: Array<typeof success>) {
      let calls = 0;
      const shell = vi.spyOn(execution, "runAdapterExecutionTargetShellCommand").mockImplementation(async (_runId, _target, command) => {
        // Directory observation is a separate command after successful staging;
        // it is not a third exclusion attempt.
        if (!command.includes("Unsafe runtime exclusion directory")) return success;
        return results[Math.min(calls++, results.length - 1)]!;
      });
      return { shell, count: () => calls, exclusionCalls: () => shell.mock.calls.filter(([, , command]) => command.includes("Unsafe runtime exclusion directory")) };
    }

    it("retries one timeout after one second and prepares successfully", async () => {
      const runId = randomUUID(), target = remote(), exec = stub([timeout, success]);
      const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const started = performance.now();
      await expect(prepare(runId, target)).resolves.toMatchObject({ state: "prepared" });
      expect(performance.now() - started).toBeGreaterThanOrEqual(900);
      expect(exec.count()).toBe(2);
      for (const [id, actualTarget, , options] of exec.exclusionCalls()) {
        expect(id).toBe(runId); expect(actualTarget).toBe(target);
        expect(options).toMatchObject({ timeoutSec: 15, cwd: target.remoteCwd, env: {} });
      }
      expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ runId, timedOut: true, exitCode: 143, signal: "SIGTERM", durationMs: 15_080, stderrClass: "other", willRetry: true }), expect.any(String));
    });

    it.each(["eexist", "enoent", "other"])("retries a non-zero %s exit once", async stderrClass => {
      const stderr = { eexist: `Error: EEXIST ${secret}`, enoent: `Error: ENOENT ${secret}`, other: `provider failure ${secret}` }[stderrClass]!;
      const exec = stub([{ ...success, exitCode: 1, stderr }, success]);
      const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
      await expect(prepare(randomUUID(), remote())).resolves.toMatchObject({ state: "prepared" });
      expect(exec.count()).toBe(2);
      expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ stderrClass, willRetry: true }), expect.any(String));
      expect(JSON.stringify(warnings.mock.calls)).not.toContain(secret);
    });

    it.each([false, true])("never retries an unsafe exclusion (timedOut=%s)", async timedOut => {
      const runId = randomUUID(), exec = stub([{ ...timeout, timedOut, exitCode: 1, stderr: `Unsafe runtime exclusion directory ${secret}` }]);
      const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const error = await prepare(runId, remote()).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "AgentInstructionGitExclusionError", reason: "AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED", runId, timedOut, exitCode: 1, signal: "SIGTERM", durationMs: 15_080, stderrClass: "unsafe", attempts: [expect.objectContaining({ stderrClass: "unsafe" })] });
      expect(exec.count()).toBe(1);
      expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ runId, stderrClass: "unsafe", willRetry: false }), expect.any(String));
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(warnings.mock.calls)).not.toContain(secret);
    });

    it("fails once after two timeouts, retains both durations in error and log, and allows the run's next try", async () => {
      const runId = randomUUID(), target = remote();
      const exec = stub([timeout, { ...timeout, durationMs: 15_090, stderr: `provider stalled ${secret}` }, success]);
      const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
      let failures = 0;
      const error = await prepare(runId, target).catch(error => { failures++; return error; });
      const attempts = [
        { timedOut: true, exitCode: 143, signal: "SIGTERM", durationMs: 15_080, stderrClass: "other" },
        { timedOut: true, exitCode: 143, signal: "SIGTERM", durationMs: 15_090, stderrClass: "other" },
      ];
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "AgentInstructionGitExclusionError", reason: "AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED", runId, ...attempts[1], attempts });
      expect(failures).toBe(1); expect(exec.count()).toBe(2);
      expect(warnings).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveBeenLastCalledWith(expect.objectContaining({ runId, reason: "AGENT_INSTRUCTION_GIT_EXCLUSION_FAILED", ...attempts[1], attempts, willRetry: false }), expect.any(String));
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(warnings.mock.calls)).not.toContain(secret);
      // The existing durable failure/release path queues exactly one next try.
      // Its preparation is a separate call, never a third attempt in this one.
      if (!(error instanceof Error)) throw new Error("Expected a failed exclusion before scheduling its next try");
      const successorRunId = await nextTry(runId, error);
      expect(exec.count()).toBe(2);
      await expect(prepare(successorRunId, target)).resolves.toMatchObject({ state: "prepared" });
      expect(exec.count()).toBe(3);
    });
  });
}
