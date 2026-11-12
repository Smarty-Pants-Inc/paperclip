import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { cleanupGitHubOperationLaunchers } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { describe, expect, it, vi } from "vitest";
import type { EnvironmentLease } from "@paperclipai/shared";
import { prepareHeartbeatGitHubLaunchers } from "./heartbeat-github-launchers.js";

const target = { kind: "remote" as const, transport: "sandbox" as const, providerKey: "daytona", remoteCwd: "/workspace" };

describe("heartbeat GitHub launcher lifetime", () => {
  it.each([true, false])("delegates task staging with configured GitHub: %s", async (githubConfigured) => {
    const prepare = vi.fn(), mint = vi.fn(() => "run-capability");
    const env = { OPENAI_API_KEY: "selected-credential" };
    const result = await prepareHeartbeatGitHubLaunchers({ native: true, githubConfigured, agentId: "agent",
      runId: "run", target: { ...target, runnerTask: async () => ({}) }, cwd: "/core/workspace",
      env, brokerUrl: "https://paperclip.test", createBrokerToken: mint }, prepare);
    expect(result.cleanupLocation).toBeNull();
    expect(result.env).toMatchObject({ ...env, GH_TOKEN: "", PAPERCLIP_GITHUB_BROKER_URL: githubConfigured ? "https://paperclip.test" : "",
      PAPERCLIP_GITHUB_BROKER_TOKEN: githubConfigured ? "run-capability" : "" });
    expect(prepare).not.toHaveBeenCalled();
    expect(mint).toHaveBeenCalledTimes(githubConfigured ? 1 : 0);
  });
  it.each([target, null])("defers native managed authorization/staging to the session owner (%j)", async (target) => {
    const prepare = vi.fn();
    const mint = vi.fn();
    const result = await prepareHeartbeatGitHubLaunchers({
      native: true, githubConfigured: true, agentId: "agent-a", runId: "run-a", target,
      cwd: "/workspace", env: { GH_TOKEN: "ambient" }, brokerUrl: "https://paperclip.test", createBrokerToken: mint,
    }, prepare);
    expect(prepare).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(result.cleanupLocation).toBeNull();
    expect(result.env).toMatchObject({ GH_TOKEN: "", PAPERCLIP_GITHUB_BROKER_TOKEN: "" });
  });
  it("keeps anonymous native sandbox launchers stable without issuing a run capability", async () => {
    const createBrokerToken = vi.fn(() => "run-secret");
    const prepareLaunchers = vi.fn(async (input) => input.env);
    const inputs = { native: true, githubConfigured: false, agentId: "agent-a", target,
      cwd: "/workspace", env: { GH_TOKEN: "ambient-secret" }, brokerUrl: "https://paperclip.test", createBrokerToken };
    const first = await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "run-one" }, prepareLaunchers);
    const second = await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "run-two" }, prepareLaunchers);
    expect(createBrokerToken).not.toHaveBeenCalled();
    expect(prepareLaunchers.mock.calls.map(([input]) => input.runId)).toEqual([expect.stringMatching(/^anonymous-agent-a-/), prepareLaunchers.mock.calls[0]?.[0].runId]);
    expect(first.cleanupLocation).toBeNull();
    expect(second.cleanupLocation).toBeNull();
    expect(first.env).toMatchObject({ GH_TOKEN: "", PAPERCLIP_GITHUB_BROKER_TOKEN: "", PAPERCLIP_GITHUB_BROKER_URL: "" });
  });
  it.each([false, true])("cleans partial run-scoped staging and preserves its error (cleanup fails: %s)", async (cleanupFails) => {
    const stagingError = new Error("remote launcher staging failed");
    const prepareLaunchers = vi.fn(async () => { throw stagingError; });
    const cleanupLaunchers = vi.fn(async () => {
      if (cleanupFails) throw new Error("cleanup unavailable");
    });
    await expect(prepareHeartbeatGitHubLaunchers({
      native: false, githubConfigured: true, agentId: "agent-a", target,
      runId: "failed-run", cwd: "/workspace", env: {}, brokerUrl: "https://paperclip.test",
      createBrokerToken: () => "current-run-secret",
    }, prepareLaunchers, cleanupLaunchers)).rejects.toBe(stagingError);
    expect(cleanupLaunchers).toHaveBeenCalledExactlyOnceWith({ runId: "failed-run", target });
  });

  it("does not remove shared anonymous wrappers when staging a later run fails", async () => {
    const stagingError = new Error("remote launcher staging failed");
    const cleanupLaunchers = vi.fn(async () => undefined);
    await expect(prepareHeartbeatGitHubLaunchers({
      native: true, githubConfigured: false, agentId: "agent-a", target,
      runId: "failed-run", cwd: "/workspace", env: {}, brokerUrl: "https://paperclip.test",
      createBrokerToken: () => { throw new Error("must not mint a capability"); },
    }, async () => { throw stagingError; }, cleanupLaunchers)).rejects.toBe(stagingError);
    expect(cleanupLaunchers).not.toHaveBeenCalled();
  });

  it.each([
    { native: false, githubConfigured: true, target },
    { native: false, githubConfigured: false, target },
    { native: true, githubConfigured: false, target: null },
  ])("preserves run-scoped managed capabilities outside anonymous native sandboxes: %j", async (mode) => {
    const createBrokerToken = vi.fn(() => "current-run-secret");
    const prepareLaunchers = vi.fn(async (input) => input.env);
    const result = await prepareHeartbeatGitHubLaunchers({ ...mode, agentId: "agent-a", runId: "run-one",
      cwd: "/workspace", env: {}, brokerUrl: "https://paperclip.test", createBrokerToken }, prepareLaunchers);
    expect(createBrokerToken).toHaveBeenCalledOnce();
    expect(prepareLaunchers.mock.calls[0]?.[0].runId).toBe("run-one");
    expect(result.cleanupLocation).toEqual({ runId: "run-one", target: mode.target });
    expect(result.env.PAPERCLIP_GITHUB_BROKER_TOKEN).toBe("current-run-secret");
  });
});


it("keeps anonymous wrappers usable after run cleanup and excludes sandbox image credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-anonymous-github-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await mkdir(path.join(root, ".config", "gh"), { recursive: true });
    await writeFile(path.join(root, ".config", "gh", "hosts.yml"), "ambient-image-secret");
    await writeFile(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
process.stdout.write(JSON.stringify({token:process.env.GH_TOKEN || '', githubToken:process.env.GITHUB_TOKEN || '', ssh:process.env.SSH_AUTH_SOCK, global:process.env.GIT_CONFIG_GLOBAL, globalConfig:fs.readFileSync(process.env.GIT_CONFIG_GLOBAL, 'utf8'), imageConfig:fs.existsSync(process.env.GH_CONFIG_DIR + '/hosts.yml')}));`, { mode: 0o700 });
    const imageEnv = { HOME: root, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`, GH_TOKEN: "ambient-token", GITHUB_TOKEN: "ambient-other-token", SSH_AUTH_SOCK: "/ambient/socket" };
    const execute: CommandManagedRuntimeRunner["execute"] = async (input) => {
      const startedAt = new Date().toISOString();
      const child = promisify(execFile)(input.command, input.args ?? [], { cwd: input.cwd ?? root, env: { ...imageEnv, ...input.env }, timeout: 15_000 });
      child.child.stdin?.on("error", () => undefined);
      child.child.stdin?.end(input.stdin ?? "");
      const result = await child;
      return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
    };
    const executeCounted = vi.fn(execute);
    const lease = { id: "real-lease", companyId: "company", environmentId: "env", providerLeaseId: "real-box",
      status: "active", metadata: {} } as EnvironmentLease;
    const sandboxTarget = { ...target, leaseId: lease.id, remoteCwd: root, runner: { execute: executeCounted } };
    const base = { native: true, githubConfigured: false, agentId: "agent-a", target: sandboxTarget,
      cwd: root, env: imageEnv, preparation: { lease, configuration: {},
        save: async (receipt: unknown) => { lease.metadata = { anonymousGitHubLaunchers: receipt }; } },
      brokerUrl: "https://unused.invalid", createBrokerToken: () => { throw new Error("must not mint a capability"); } };
    const first = await prepareHeartbeatGitHubLaunchers({ ...base, runId: "run-one" });
    await cleanupGitHubOperationLaunchers({ runId: "run-one", target: sandboxTarget });
    const callsAfterFirst = executeCounted.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await prepareHeartbeatGitHubLaunchers({ ...base, runId: "run-two" });
    expect(executeCounted).toHaveBeenCalledTimes(callsAfterFirst);
    expect(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).toBe(second.env.PAPERCLIP_GITHUB_LAUNCHER_DIR);
    expect(await readFile(path.join(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), "utf8")).not.toContain("ambient-token");
    // A still-live provider uses its first-turn environment, not the new one.
    const command = await execute({ command: path.join(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), env: first.env });
    const result = JSON.parse(command.stdout);
    expect(result).toEqual({ token: "", githubToken: "", ssh: "", imageConfig: false,
      global: expect.stringMatching(/\/paperclip-github-operation-[^/]+\/gitconfig$/),
      globalConfig: "[user]\n\tname = Paperclip\n\temail = noreply@paperclip.ing\n" });
    await expect(readFile(result.global)).rejects.toMatchObject({ code: "ENOENT" });
    const commit = await execute({ command: "bash", args: ["--noprofile", "--norc", "-c",
      "git init -q && git commit --allow-empty -qm 'Local work' && git log -1 --format='%an <%ae>|%cn <%ce>'"], env: first.env });
    expect(commit.stdout.trim()).toBe("Paperclip <noreply@paperclip.ing>|Paperclip <noreply@paperclip.ing>");
    const changedPath = await prepareHeartbeatGitHubLaunchers({ ...base, runId: "run-three", env: { ...imageEnv, PATH: `${imageEnv.PATH}:/extra` } });
    expect(changedPath.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).not.toBe(first.env.PAPERCLIP_GITHUB_LAUNCHER_DIR);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

// Keep reason: image credentials must stay isolated when staging is skipped.
it("reuses anonymous layout only on the same live lease and launcher configuration", async () => {
  const lease = { id: "lease-a", companyId: "company-a", environmentId: "environment-a", providerLeaseId: "box-a",
    status: "active", metadata: {} } as EnvironmentLease;
  const mint = vi.fn(() => "must-not-cache-this");
  const prepare = vi.fn(async ({ env }) => ({ ...env, PATH: "/wrappers:" + env.PATH,
    ZDOTDIR: "/wrappers", BASH_ENV: "/wrappers/.bashrc", GH_CONFIG_DIR: "/wrappers/gh-config", PAPERCLIP_GITHUB_LAUNCHER_DIR: "/wrappers" }));
  const inputs = { native: true, githubConfigured: false, agentId: "agent-a", target: { ...target, leaseId: lease.id },
    cwd: "/workspace", env: { PATH: "/usr/bin", GH_TOKEN: "image-secret" }, brokerUrl: "", createBrokerToken: mint,
    preparation: { lease, configuration: { plugin: "config-one" }, save: async (receipt: unknown) => { lease.metadata = { anonymousGitHubLaunchers: receipt }; } } };
  const first = await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "one" }, prepare);
  const second = await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "two" }, prepare);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(second).toEqual(first);
  expect(second.env.GH_TOKEN).toBe("");
  expect(JSON.stringify(lease.metadata)).not.toContain("image-secret");
  expect(mint).not.toHaveBeenCalled();
  inputs.preparation.configuration.plugin = "config-two";
  await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "three" }, prepare);
  expect(prepare).toHaveBeenCalledTimes(2);
  lease.id = inputs.target.leaseId = "lease-b";
  await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "four" }, prepare);
  expect(prepare).toHaveBeenCalledTimes(3);
  lease.providerLeaseId = "box-b";
  await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "five" }, prepare);
  expect(prepare).toHaveBeenCalledTimes(4);
  lease.expiresAt = new Date(0);
  await prepareHeartbeatGitHubLaunchers({ ...inputs, runId: "six" }, prepare);
  expect(prepare).toHaveBeenCalledTimes(5);
});

it("does not publish a launcher reuse receipt after failed staging", async () => {
  const save = vi.fn();
  const lease = { id: "lease", companyId: "company", environmentId: "env", providerLeaseId: "box", status: "active", metadata: {} } as EnvironmentLease;
  const prepare = vi.fn().mockRejectedValueOnce(new Error("stage failed")).mockResolvedValue({ PATH: "/bin" });
  const input = { native: true, githubConfigured: false, agentId: "agent", runId: "run", cwd: "/workspace",
    target: { ...target, leaseId: lease.id }, env: {}, brokerUrl: "", createBrokerToken: () => "",
    preparation: { lease, configuration: {}, save } };
  await expect(prepareHeartbeatGitHubLaunchers(input, prepare)).rejects.toThrow("stage failed");
  expect(save).not.toHaveBeenCalled();
  await prepareHeartbeatGitHubLaunchers(input, prepare);
  expect(prepare).toHaveBeenCalledTimes(2);
});

it("invalidates prior staging proof before a failing miss, including a later config rollback", async () => {
  const lease = { id: "lease", companyId: "company", environmentId: "env", providerLeaseId: "box",
    status: "active", metadata: {} } as EnvironmentLease;
  const prepare = vi.fn(async ({ env }) => ({ ...env, PATH: "/wrappers:/bin", ZDOTDIR: "/wrappers",
    BASH_ENV: "/wrappers/.bashrc", GH_CONFIG_DIR: "/wrappers/config", PAPERCLIP_GITHUB_LAUNCHER_DIR: "/wrappers" }));
  const save = vi.fn(async (receipt: unknown) => { lease.metadata = { anonymousGitHubLaunchers: receipt }; });
  const input = { native: true, githubConfigured: false, agentId: "agent", cwd: "/workspace", env: { PATH: "/bin" },
    target: { ...target, leaseId: lease.id }, brokerUrl: "", createBrokerToken: () => "",
    preparation: { lease, configuration: { version: 1 }, save } };
  await prepareHeartbeatGitHubLaunchers({ ...input, runId: "one" }, prepare);
  input.preparation.configuration.version = 2;
  prepare.mockRejectedValueOnce(new Error("partial staging failure"));
  await expect(prepareHeartbeatGitHubLaunchers({ ...input, runId: "two" }, prepare)).rejects.toThrow("partial staging failure");
  expect(save.mock.calls[1]).toEqual([null]);
  expect(lease.metadata?.anonymousGitHubLaunchers).toBeNull();
  input.preparation.configuration.version = 1;
  await prepareHeartbeatGitHubLaunchers({ ...input, runId: "three" }, prepare);
  expect(prepare).toHaveBeenCalledTimes(3);
});

it("does not alter a previously cached layout when durable invalidation fails", async () => {
  const lease = { id: "lease", companyId: "company", environmentId: "env", providerLeaseId: "box",
    status: "active", metadata: { anonymousGitHubLaunchers: { key: "old", layout: {} } } } as unknown as EnvironmentLease;
  const prepare = vi.fn();
  const input = { native: true, githubConfigured: false, agentId: "agent", runId: "run", cwd: "/workspace",
    env: {}, target: { ...target, leaseId: lease.id }, brokerUrl: "", createBrokerToken: () => "",
    preparation: { lease, configuration: {}, save: vi.fn().mockRejectedValue(new Error("lease lost")) } };
  await expect(prepareHeartbeatGitHubLaunchers(input, prepare)).rejects.toThrow("lease lost");
  expect(prepare).not.toHaveBeenCalled();
});
