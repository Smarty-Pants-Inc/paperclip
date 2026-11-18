import { describe, expect, it, vi } from "vitest";
import { prepareHeartbeatGitHubEnvironment } from "./heartbeat-github-launchers.js";

function input(hostCredentials = false) {
  const execute = vi.fn(async () => ({ exitCode: 0, timedOut: false, signal: null, stderr: "",
    stdout: "\0PAPERCLIP_GIT_CONTEXT_V1\0PAPERCLIP_GIT_METADATA_ROOT\0/workspace/.git\0PAPERCLIP_RUNNER_NETWORK_ROOT\0/etc/hosts\0\0PAPERCLIP_GIT_CONTEXT_END\0" }));
  return { execute, options: { target: { kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: "/workspace",
      runner: { execute, allowConcurrentSyncOperations: true } } as never,
    cwd: "/controller/workspace", env: { PATH: "/configured/bin", PAPERCLIP_GIT_METADATA_ROOTS: '["/untrusted"]' },
    hostCredentials, networkAccess: false, defer: true } };
}

describe("native Pi Git environment startup placement", () => {
  it("defers the real remote read, returns only fresh controller-owned roots, and does not overwrite later launcher PATH", async () => {
    const { execute, options } = input();
    const plan = await prepareHeartbeatGitHubEnvironment(options);
    expect(execute).not.toHaveBeenCalled();
    expect(plan.env).toMatchObject({ PATH: "/configured/bin", PAPERCLIP_GIT_METADATA_ROOTS: "[]",
      PAPERCLIP_RUNNER_NETWORK_ROOTS: "[]", PAPERCLIP_GITHUB_AUTH_MODE: "managed", PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled" });
    const discovered = await plan.prepare!();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    expect(discovered).toMatchObject({ PAPERCLIP_GIT_METADATA_ROOTS: '["/workspace/.git"]', PAPERCLIP_RUNNER_NETWORK_ROOTS: '["/etc/hosts"]' });
    expect(discovered).not.toHaveProperty("PATH");
    expect({ PATH: "/later/run/wrappers", ...discovered }.PATH).toBe("/later/run/wrappers");
  });

  it("keeps host credential import eager and never creates a deferred credential callback", async () => {
    const { execute, options } = input(true);
    const plan = await prepareHeartbeatGitHubEnvironment(options);
    expect(execute).toHaveBeenCalledOnce();
    expect(plan.prepare).toBeUndefined();
    expect(plan.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
  });

  it("surfaces a deferred discovery error instead of launching with empty sandbox boundaries", async () => {
    const { execute, options } = input();
    const plan = await prepareHeartbeatGitHubEnvironment(options);
    execute.mockResolvedValueOnce({ exitCode: 0, timedOut: false, signal: null, stderr: "", stdout: "unframed" });
    await expect(plan.prepare!()).rejects.toThrow("Could not read execution-target Git context");
  });
});
