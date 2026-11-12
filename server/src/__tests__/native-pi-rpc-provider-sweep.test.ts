import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AiConnectionPoolMember } from "@paperclipai/shared";
import { PI_THINKING_LEVELS, QUALIFIED_PI_RPC_PROFILE, type NativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { applyMcpReasoningEffort, mcpAgentModelConfig } from "../services/public-mcp/agent-config.js";
import { poolMemberRuntimeConfig, applyAiConnectionRouterTaskSettings } from "../services/ai-connection-router.js";
import { resolveNativeBilling, resolveNativeHarnessPersistenceProfile, resolveNativeProviderEnvironment } from "../services/native-runtime/native-session-executor.js";
import { usesNativeUsageDelivery } from "../services/native-runtime/native-usage-accounting.js";
import { isKnownNativeSessionRootEntry } from "../services/native-runtime/native-session-root-entries.js";

const provider = { kind: "pi_rpc" as const, model: "anthropic/claude-opus-5-5", profile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh" as const };
const member: AiConnectionPoolMember = {
  id: randomUUID(),
  binding: { mode: "delegated", provider: "anthropic", method: "api_key", connectionId: randomUUID(), grantId: randomUUID() },
  profile: { provider: "pi_rpc", model: provider.model, effort: "xhigh" },
};

describe("native Pi sweep contracts", () => {
  // Keep reason: MCP is a public configuration boundary; native Pi must not use Codex's effort field.
  it.each(PI_THINKING_LEVELS)("maps MCP reasoning effort to native Pi thinking: %s", level => {
    const config = { provider: "pi_rpc", model: provider.model, piRpcThinkingLevel: level };
    expect(mcpAgentModelConfig("paperclip_runner", config)).toEqual({
      model: provider.model, reasoningEffort: level, supportedReasoningEfforts: PI_THINKING_LEVELS,
    });
    expect(applyMcpReasoningEffort("paperclip_runner", { ...config, piRpcThinkingLevel: "low", reasoningEffort: level }, { reasoningEffort: level }))
      .toEqual(config);
    expect(() => applyMcpReasoningEffort("paperclip_runner", config, { model: provider.model })).not.toThrow();
  });

  it("rejects unsupported Pi effort at the MCP boundary without changing Codex or OpenCode policy", () => {
    const config = { provider: "pi_rpc", model: provider.model, piRpcThinkingLevel: "ultra" };
    expect(() => applyMcpReasoningEffort("paperclip_runner", config, { reasoningEffort: "ultra" }))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ code: "MCP_REASONING_EFFORT_UNSUPPORTED" }) }));
    expect(() => applyMcpReasoningEffort("paperclip_runner", config, { model: provider.model })).toThrow();
    expect(mcpAgentModelConfig("paperclip_runner", { provider: "opencode", model: "openrouter/model" }).supportedReasoningEfforts).toEqual([]);
    expect(applyMcpReasoningEffort("paperclip_runner", { provider: "codex", model: "gpt-5.6-sol" }, { reasoningEffort: "high" }))
      .toMatchObject({ modelReasoningEffort: "high" });
  });
  it("does not promote ambient native Pi credentials when explicit bindings are absent", () => {
    const host = { PATH: "/host/bin", HOME: "/host/home", ANTHROPIC_API_KEY: "ambient-anthropic",
      OPENROUTER_API_KEY: "ambient-openrouter", PAPERCLIP_AI_PROVIDER_KEY: "ambient-gateway" };
    expect(resolveNativeProviderEnvironment(provider, undefined, host)).toEqual({ PATH: "/host/bin", HOME: "/host/home" });
    const explicit = { PAPERCLIP_AI_PROVIDER_KEY: "explicit-company-binding" };
    expect(resolveNativeProviderEnvironment(provider, explicit, host)).toBe(explicit);
  });
  it("routes a Pi pool member and its own thinking key without implicit Codex or ACPX", () => {
    expect(poolMemberRuntimeConfig(member, "paperclip_runner")).toEqual({ config: {
      provider: "pi_rpc", model: provider.model, piRpcThinkingLevel: "xhigh",
    }, notes: [] });
    const changed = poolMemberRuntimeConfig(member, "paperclip_runner", { piRpcThinkingLevel: "medium", model: "anthropic/claude-sonnet-4-6" });
    expect(changed).toEqual({ config: { provider: "pi_rpc", model: "anthropic/claude-sonnet-4-6", piRpcThinkingLevel: "medium" }, notes: [] });
  });

  it("keeps incompatible model overrides and invalid thinking away from a pinned Pi account", () => {
    expect(poolMemberRuntimeConfig(member, "paperclip_runner", { model: "openai/gpt-5.6-sol", piRpcThinkingLevel: "ultra" }))
      .toEqual({ config: { provider: "pi_rpc", model: provider.model, piRpcThinkingLevel: "xhigh" }, notes: [
        "Model override is unavailable for this member; using its default.",
        "Effort override is unavailable for this member; using its default.",
      ] });
    expect(() => poolMemberRuntimeConfig({ ...member, binding: { ...member.binding, method: "subscription" } }, "paperclip_runner"))
      .toThrow("incompatible");
  });

  it("replaces a stale Pi thinking key when another pinned runtime is selected", () => {
    const result = applyAiConnectionRouterTaskSettings({ provider: "pi_rpc", piRpcThinkingLevel: "xhigh", cwd: "/workspace" }, {
      poolId: randomUUID(), memberId: randomUUID(), binding: member.binding,
      runtimeConfig: { provider: "codex", model: "gpt-5.6-sol" }, notes: [],
    });
    expect(result).toEqual({ provider: "codex", model: "gpt-5.6-sol", cwd: "/workspace" });
  });

  it("selects producer-owned usage only for a remote runnerd Pi attempt", () => {
    expect(usesNativeUsageDelivery({ provider, runnerd: true, remote: true })).toBe(true);
    expect(usesNativeUsageDelivery({ provider, runnerd: false, remote: true })).toBe(false);
    expect(usesNativeUsageDelivery({ provider, runnerd: true, remote: false })).toBe(false);
  });

  it("persists Pi session history but never launch credentials or model configuration", () => {
    const execution = { provider, session: { driverKind: "pi_rpc" } } as NativeExecutionInput;
    expect(resolveNativeHarnessPersistenceProfile(execution)).toEqual({
      providerKind: "pi_rpc", driverKind: "pi_rpc", directories: [
        { name: "runner", location: "runner", excludeEntries: [] },
        { name: "pi-agent", location: "filesystem", excludeEntries: ["auth.json", "auth.json.lock", "models.json", "settings.json"] },
      ],
    });
    expect(isKnownNativeSessionRootEntry("pi-agent")).toBe(true);
  });

  it("uses Pi provider/model billing without a Codex token interpretation", () => {
    expect(resolveNativeBilling(provider, { ANTHROPIC_API_KEY: "fixture-only" }))
      .toEqual({ provider: "anthropic", biller: "anthropic", billingType: "metered_api" });
  });
});
