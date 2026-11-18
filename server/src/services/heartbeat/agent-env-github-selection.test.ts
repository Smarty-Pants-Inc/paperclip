import type { Db } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareManagedAiRuntime } from "../ai-connection-runtime.js";
import { resolveManagedGitHubIdentitySelection } from "../git-credentials.js";
import { prepareHeartbeatExecutionConfiguration, type HeartbeatExecutionConfigurationInput } from "./execution-configuration.js";

vi.mock("../agent-observability.js", () => ({
  agentObservabilityService: () => ({ resolve: async () => ({ state: "unavailable", reason: "unsupported_harness" }) }),
  unavailableAgentObservability: () => ({ state: "unavailable", reason: "unsupported_harness" }),
}));
vi.mock("../git-credentials.js", async importOriginal => ({
  ...await importOriginal<typeof import("../git-credentials.js")>(),
  resolveManagedGitHubIdentitySelection: vi.fn(async () => { throw new Error("managed-selection-failed"); }),
}));

vi.mock("../ai-connection-runtime.js", async importOriginal => ({
  ...await importOriginal<typeof import("../ai-connection-runtime.js")>(),
  prepareManagedAiRuntime: vi.fn(async () => ({ config: { env: { GH_TOKEN: "", GITHUB_TOKEN: "", COPILOT_GITHUB_TOKEN: "fixture-ai-token" } },
    attribution: { provider: "github", method: "subscription" }, identity: "fixture-ai", sessionIdentity: "fixture-session" })),
}));

// Keep: a configured but broken managed identity must not block explicit agent credentials.
describe("agent_env managed selection boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  function input(mode: unknown, options: { noToken?: boolean; stopAfterSecrets?: boolean } = {}) {
    const stop = new Error("reached-agent-secret-resolution");
    const warning = new Error("recorded-warning");
    const appendRunEvent = vi.fn(async () => { throw warning; });
    const resolveAdapterConfigForRuntime = vi.fn(async () => {
      if (options.stopAfterSecrets) throw stop;
      return { config: { env: options.noToken ? {} : { GH_TOKEN: "fixture-agent-token" } }, secretKeys: new Set(), manifest: [] };
    });
    const value = {
      run: { id: "run-one" }, agent: { id: "agent-one", companyId: "company-one", adapterType: "process", adapterConfig: { githubAuthenticationMode: mode } },
      task: { issueId: null, context: {}, responsibleUserId: null, acceptedPlanContinuationWake: false,
        acceptedPlanWakeRoutingDecision: null, taskProjectContext: null, routineEnvContext: { routineId: null, env: null } },
      config: { sourceWorkspaceConfig: { env: {} }, aiBinding: undefined },
      policy: { trustPreset: { kind: "standard" } },
      environment: { selectedEnvironmentForConfig: { driver: "boat" } },
      services: { secretsSvc: { resolveAdapterConfigForRuntime }, companySkills: {}, appendRunEvent, finalizeAiConnectionBusyDeferral: vi.fn() },
      onFailureSecretsResolved: vi.fn(), onManagedAiRuntimeAcquired: vi.fn(), onIdentityRedactorPrepared: vi.fn(),
    } as unknown as HeartbeatExecutionConfigurationInput;
    return { value, stop, warning, appendRunEvent, resolveAdapterConfigForRuntime };
  }
  it("does not consult a failing managed resolver when agent_env is selected", async () => {
    const test = input("agent_env", { stopAfterSecrets: true });
    await expect(prepareHeartbeatExecutionConfiguration({} as Db, test.value)).rejects.toBe(test.stop);
    expect(resolveManagedGitHubIdentitySelection).not.toHaveBeenCalled();
    expect(test.resolveAdapterConfigForRuntime).toHaveBeenCalled();
  });
  it("does not let managed Copilot AI setup clear the explicitly selected shell token", async () => {
    const test = input("agent_env");
    test.value.config.aiBinding = { provider: "github", method: "subscription" } as never;
    const stop = new Error("account-snapshot-write");
    const db = { update: () => ({ set: () => { throw stop; } }) } as unknown as Db;
    await expect(prepareHeartbeatExecutionConfiguration(db, test.value)).rejects.toBe(stop);
    const config = vi.mocked(prepareManagedAiRuntime).mock.calls[0]![1].config;
    expect(config.env).toMatchObject({ GH_TOKEN: "fixture-agent-token", COPILOT_GITHUB_TOKEN: "fixture-ai-token" });
    expect(resolveManagedGitHubIdentitySelection).not.toHaveBeenCalled();
  });
  it("keeps the default failing-managed-identity behavior", async () => {
    const test = input(undefined, { stopAfterSecrets: true });
    await expect(prepareHeartbeatExecutionConfiguration({} as Db, test.value)).rejects.toThrow("managed-selection-failed");
    expect(resolveManagedGitHubIdentitySelection).toHaveBeenCalledOnce();
    expect(test.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
  });
  it("records a clear warning, with no token or managed fallback, when no agent token exists", async () => {
    const test = input("agent_env", { noToken: true });
    await expect(prepareHeartbeatExecutionConfiguration({} as Db, test.value)).rejects.toBe(test.warning);
    expect(resolveManagedGitHubIdentitySelection).not.toHaveBeenCalled();
    expect(test.appendRunEvent).toHaveBeenCalledWith(test.value.run, expect.objectContaining({
      eventType: "github.agent_env_token_missing", level: "warn", message: expect.stringContaining("Bind an agent env secret"),
    }));
  });
});
