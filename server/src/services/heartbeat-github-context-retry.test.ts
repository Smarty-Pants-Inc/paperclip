import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { prepareHeartbeatGitHubEnvironment } from "./heartbeat-github-launchers.js";

// Keep: SMA-161's deferred production path must retain run-scoped warnings.
describe("heartbeat Git-context retry diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])("keeps retries and safe run-scoped warnings in eager/deferred discovery (defer=%s)", async defer => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("unsafe private-provider-sentinel"))
      .mockResolvedValue({ exitCode: 0, timedOut: false, signal: null, stderr: "", durationMs: 12,
        stdout: "\0PAPERCLIP_GIT_CONTEXT_V1\0PAPERCLIP_GIT_METADATA_ROOT\0/workspace/.git\0\0PAPERCLIP_GIT_CONTEXT_END\0" });
    const warnings = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const options = { runId: "heartbeat-context-run", target: { kind: "remote" as const, transport: "sandbox" as const,
      providerKey: "fixture", remoteCwd: "/workspace", runner: { execute, allowConcurrentSyncOperations: true } },
      cwd: "/controller-only", env: {}, hostCredentials: false, networkAccess: true, defer };
    const plan = await prepareHeartbeatGitHubEnvironment(options);
    if (defer) expect(execute).not.toHaveBeenCalled();
    const env = plan.prepare ? await plan.prepare() : plan.env;
    expect(env.PAPERCLIP_GIT_METADATA_ROOTS).toBe('["/workspace/.git"]');
    expect(execute).toHaveBeenCalledTimes(2);
    expect(warnings).toHaveBeenCalledOnce();
    expect(warnings).toHaveBeenCalledWith(expect.objectContaining({ runId: "heartbeat-context-run",
      reason: "EXECUTION_TARGET_GIT_CONTEXT_FAILED", stderrClass: "transport", durationMs: expect.any(Number), willRetry: true }),
      "Execution-target Git context read failed");
    expect(JSON.stringify(warnings.mock.calls)).not.toContain("private-provider-sentinel");
  });
});
