import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createAgentSchema, updateAgentSchema, LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { resolveExecutionRunAdapterConfig } from "./run-preparation.js";
import { prepareHeartbeatGitHubLaunchers } from "../heartbeat-github-launchers.js";

// Keep: credential trust boundary; only this agent's scoped resolver may supply tokens.
describe("explicit agent_env GitHub authentication", () => {
  async function resolve(mode: unknown, tokenKey?: string) {
    const ref = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };
    const agentAdapterConfig = { githubAuthenticationMode: mode, env: tokenKey ? { [tokenKey]: ref } : {} };
    const secretsSvc = {
      collectMissingRuntimeBindings: vi.fn(async () => []),
      collectMissingAdapterConfigRuntimeBindings: vi.fn(async () => []),
      resolveAdapterConfigForRuntime: vi.fn(async (companyId, config, scope) => {
        expect(companyId).toBe("company-one");
        expect(scope).toMatchObject({ consumerType: "agent", consumerId: "agent-one", actorId: "agent-one" });
        const env = { ...config.env };
        for (const key of ["GH_TOKEN", "GITHUB_TOKEN"]) {
          if (env[key]) { expect(env[key]).toEqual(ref); env[key] = "fixture-agent-token"; }
        }
        return { config: { ...config, env }, secretKeys: new Set(tokenKey ? [tokenKey] : []), manifest: [] };
      }),
      resolveEnvBindings: vi.fn(async (_company, env) => ({ env, secretKeys: new Set(), manifest: [] })),
    };
    return resolveExecutionRunAdapterConfig({ companyId: "company-one", agentId: "agent-one", adapterType: "paperclip_runner",
      managedGitHubCredentials: true, agentAdapterConfig,
      executionRunConfig: { env: { GH_TOKEN: "issue-override", GITHUB_TOKEN: "issue-override", CUSTOM: "kept" } },
      environmentEnv: { GH_TOKEN: "environment-token" }, projectEnv: { GITHUB_TOKEN: "project-token" }, routineEnv: { GH_TOKEN: "routine-token" },
      secretsSvc } as Parameters<typeof resolveExecutionRunAdapterConfig>[0]);
  }

  it.each([undefined, "managed", "unknown"])("keeps default stripping for mode %s", async mode => {
    const result = await resolve(mode, "GH_TOKEN");
    expect(result.resolvedConfig.env).toEqual({ CUSTOM: "kept" });
  });
  it.each(["GH_TOKEN", "GITHUB_TOKEN"])("resolves only the agent's own %s secret", async key => {
    const result = await resolve("agent_env", key);
    expect(result.resolvedConfig.env).toEqual({ CUSTOM: "kept", [key]: "fixture-agent-token" });
    expect(result.configuredTaskEnvironment[key]).toBe("fixture-agent-token");
    expect(result.secretKeys.has(key)).toBe(true);
  });
  it("does not borrow a project/environment/routine/issue token when the agent has none", async () => {
    const result = await resolve("agent_env");
    expect(result.resolvedConfig.env).toEqual({ CUSTOM: "kept" });
  });
  it("retains the low-trust inline-secret prohibition", async () => {
    const resolveAdapterConfigForRuntime = vi.fn();
    await expect(resolveExecutionRunAdapterConfig({ companyId: "company-one", agentId: "agent-one",
      managedGitHubCredentials: true, agentAdapterConfig: { githubAuthenticationMode: "agent_env", env: { GH_TOKEN: "inline-token" } },
      executionRunConfig: { env: {} }, projectEnv: null,
      trustPreset: { kind: "low_trust_review", preset: LOW_TRUST_REVIEW_PRESET,
        boundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: "company-one", issueIds: ["issue-one"] }, sourcePresets: {} },
      secretsSvc: { resolveAdapterConfigForRuntime } as never,
    })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("agent.env.GH_TOKEN") });
    expect(resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
  });
  it("preserves the low-trust secret-binding allowlist on the agent resolver", async () => {
    const ref = { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" };
    const denied = new Error("binding-not-allowed-for-agent");
    const resolveAdapterConfigForRuntime = vi.fn(async (_company, _config, scope) => {
      expect(scope).toMatchObject({ consumerType: "agent", consumerId: "agent-one", allowedBindingIds: ["allowed-binding"] });
      throw denied;
    });
    await expect(resolveExecutionRunAdapterConfig({ companyId: "company-one", agentId: "agent-one",
      managedGitHubCredentials: true, agentAdapterConfig: { githubAuthenticationMode: "agent_env", env: { GH_TOKEN: ref } },
      executionRunConfig: { env: {} }, projectEnv: null,
      trustPreset: { kind: "low_trust_review", preset: LOW_TRUST_REVIEW_PRESET,
        boundary: { mode: LOW_TRUST_REVIEW_PRESET, companyId: "company-one", issueIds: ["issue-one"], allowedSecretBindingIds: ["allowed-binding"] }, sourcePresets: {} },
      secretsSvc: { resolveAdapterConfigForRuntime } as never,
    })).rejects.toBe(denied);
  });
  it.each([createAgentSchema, updateAgentSchema])("validates the opt-in without requiring env", schema => {
    const base = { name: "test", adapterType: "paperclip_runner" };
    expect(schema.safeParse({ ...base, adapterConfig: { githubAuthenticationMode: "agent_env" } }).success).toBe(true);
    for (const mode of ["unknown", "managed", null, true]) {
      expect(schema.safeParse({ ...base, adapterConfig: { githubAuthenticationMode: mode } }).success).toBe(false);
    }
    expect(schema.safeParse({ ...base, adapterConfig: {} }).success).toBe(true);
  });
  it.each([true, false])("does not mint a managed capability or stage wrappers in agent_env (task: %s)", async task => {
    const mint = vi.fn(() => { throw new Error("managed resolver must not be consulted"); });
    const stage = vi.fn();
    const result = await prepareHeartbeatGitHubLaunchers({ native: true, githubConfigured: true, agentId: "agent-one", runId: "run-one",
      target: { kind: "remote", transport: "sandbox", providerKey: "boat", remoteCwd: "/workspace", ...(task ? { runnerTask: async () => ({}) } : {}) },
      cwd: "/workspace", env: { PAPERCLIP_GITHUB_AUTH_MODE: "agent_env", GH_TOKEN: "fixture-agent-token", SSH_AUTH_SOCK: "ambient" },
      brokerUrl: "https://unused.invalid", createBrokerToken: mint }, stage);
    expect(result.env).toMatchObject({ GH_TOKEN: "fixture-agent-token", GITHUB_TOKEN: "fixture-agent-token", PAPERCLIP_GIT_TOKEN: "fixture-agent-token",
      PAPERCLIP_GITHUB_BROKER_TOKEN: "", SSH_AUTH_SOCK: "", GIT_CONFIG_GLOBAL: "/dev/null" });
    expect(result.env.GIT_CONFIG_COUNT).toBe("7");
    expect(mint).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(result.env.GH_CONFIG_DIR).toContain("/github/run-one/gh-config");
    // Exercise the real Git helper and child environment, not just mock counts.
    const childEnv = { PATH: process.env.PATH, ...result.env };
    const request = promisify(execFile)("git", ["credential", "fill"], { env: childEnv });
    request.child.stdin!.end("protocol=https\nhost=github.com\n\n");
    expect((await request).stdout).toContain("password=fixture-agent-token");
    const foreign = promisify(execFile)("git", ["credential", "fill"], { env: childEnv });
    foreign.child.stdin!.end("protocol=https\nhost=not-github.example\n\n");
    await expect(foreign).rejects.toThrow();
  });
});
