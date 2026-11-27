import { describe, expect, it } from "vitest";
import { normalizePiIssueModelSelection, validatePiRunSelection } from "../adapters/pi-model-selection.js";
import { buildExecutionWorkspaceAdapterConfig } from "../services/execution-workspace-policy.js";
import { piRpcThinking, projectPaperclipRunnerTaskConfig } from "../services/native-runtime/provider-profile.js";

const agent = { adapterType: "paperclip_runner", adapterConfig: { provider: "pi_rpc", model: "paperclip/gpt-6.1-sol" } };

describe("Pi issue model selection at run build", () => {
  it.each(["gpt-6.2-sol", "paperclip/gpt-6.2-sol"])("builds the selected effective model from %s", model => {
    const overrides = normalizePiIssueModelSelection(agent, { adapterConfig: { model, effort: "high" } });
    const config = buildExecutionWorkspaceAdapterConfig({ agentConfig: agent.adapterConfig,
      adapterConfigOverrides: overrides.adapterConfig, projectPolicy: null, issueSettings: null,
      mode: "agent_default", legacyUseProjectWorkspace: null });
    expect(config).toMatchObject({ provider: "pi_rpc", model: "paperclip/gpt-6.2-sol", effort: "high" });
    expect(agent.adapterConfig.model).toBe("paperclip/gpt-6.1-sol");
  });
  it("keeps an explicit different provider and nested model namespace unchanged", () => {
    const overrides = { adapterConfig: { model: "openrouter/qwen/qwen3" } };
    expect(normalizePiIssueModelSelection(agent, overrides)).toBe(overrides);
  });
  it.each([undefined, "gpt-6.1-sol", "paperclip/"])("rejects a bare pick without a saved prefix: %s", model => {
    expect(() => normalizePiIssueModelSelection({ ...agent, adapterConfig: { provider: "pi_rpc", model } },
      { adapterConfig: { model: "gpt-6.2-sol" } })).toThrow("pick a provider/model, or clear the chat's model");
  });
  it.each([
    { readOnly: true }, { permissions: "paperclip-runner-workspace-read-only" },
    { approvalPolicy: "on-request" }, { codexPermissionMode: "untrusted" }, { executionMode: "plan" },
  ])("leaves launch policy to the runtime's existing validation: %j", policy => {
    expect(() => validatePiRunSelection({ ...agent, adapterConfig: { ...agent.adapterConfig, ...policy } }, null))
      .not.toThrow();
  });
  it("accepts a normalized selection with the supported default policy", () => {
    expect(() => validatePiRunSelection(agent, normalizePiIssueModelSelection(agent,
      { adapterConfig: { model: "gpt-6.2-sol" } }))).not.toThrow();
  });
  it.each([null, "", " \t "])("treats an unset task reasoning level %j as inheriting the agent", level => {
    const saved = { ...agent, adapterConfig: { ...agent.adapterConfig, piRpcThinkingLevel: "high" } };
    const overrides = { adapterConfig: { piRpcThinkingLevel: level } };
    expect(normalizePiIssueModelSelection(saved, overrides)).toBe(overrides);
    const config = projectPaperclipRunnerTaskConfig("pi_rpc", saved.adapterConfig, overrides.adapterConfig);
    expect(piRpcThinking(config)).toBe("high");
    expect(config.piRpcThinkingLevel).toBe("high");
  });
  it.each([undefined, null, "", " \t "])("runs an agent with unset saved reasoning %j at medium", level => {
    const saved = { ...agent, adapterConfig: { ...agent.adapterConfig, piRpcThinkingLevel: level } };
    expect(normalizePiIssueModelSelection(saved, null)).toBeNull();
    expect(piRpcThinking(saved.adapterConfig)).toBe("medium");
  });
  it("validates the normalized runtime projection before accepting a bare chat model", () => {
    const saved = { ...agent, adapterConfig: { provider: "pi_rpc", model: "paperclip/model", effort: "ultra" } };
    const overrides = { adapterConfig: { model: "model" } };
    expect(() => normalizePiIssueModelSelection(saved, overrides)).toThrowError(expect.objectContaining({
      status: 422,
      message: expect.stringContaining('pi_thinking_level_invalid: "ultra"'),
    }));
    expect(overrides).toEqual({ adapterConfig: { model: "model" } });
  });
  it("rejects an old stored invalid reasoning override at run normalization with a plain error", () => {
    const stored = { adapterConfig: { piRpcThinkingLevel: "ultra" } };
    expect(() => normalizePiIssueModelSelection(agent, stored)).toThrow(
      'pi_thinking_level_invalid: "ultra"',
    );
  });
  it.each(["modelReasoningEffort", "reasoningEffort", "effort"])("rejects a masked invalid task %s before projection", key => {
    const overrides = { adapterConfig: { model: "other", piRpcThinkingLevel: "medium", modelReasoningEffort: "medium", [key]: "ultra" } };
    expect(() => normalizePiIssueModelSelection(agent, overrides)).toThrowError(expect.objectContaining({
      status: 422, message: expect.stringContaining('pi_thinking_level_invalid: "ultra"'),
    }));
  });
  it("maps Pi's none selection to off", () => {
    const overrides = { adapterConfig: { piRpcThinkingLevel: "none" } };
    expect(normalizePiIssueModelSelection(agent, overrides)).toBe(overrides);
    expect(piRpcThinking(projectPaperclipRunnerTaskConfig("pi_rpc", agent.adapterConfig, overrides.adapterConfig))).toBe("off");
  });
  it("allows clearing the override and leaves other adapters untouched", () => {
    expect(normalizePiIssueModelSelection(agent, null)).toBeNull();
    const noModel = { adapterConfig: { effort: "low" } };
    expect(normalizePiIssueModelSelection(agent, noModel)).toBe(noModel);
    const bare = { adapterConfig: { model: "gpt-6.2-sol" } };
    expect(normalizePiIssueModelSelection({ ...agent, adapterConfig: { provider: "codex" } }, bare)).toBe(bare);
  });
});
