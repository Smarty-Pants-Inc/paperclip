import { PAPERCLIP_RUNNER_PI_RPC_THINKING_LEVELS } from "@paperclipai/adapter-utils";
import { describe, expect, it } from "vitest";
import { PI_THINKING_LEVELS, QUALIFIED_PI_RPC_PROFILE } from "../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerNativeProviderInput, resolvePaperclipRunnerProviderProfile } from "../services/native-runtime/provider-profile.js";
import { agentHarnessType, paperclipRunnerProfileForHarness } from "@paperclipai/shared";

const model = "cliproxyapi-anthropic/claude-opus-5-5";
describe("native Pi server admission", () => {
  it("binds browser-safe admission to the qualified runtime thinking catalog", () => {
    expect(PAPERCLIP_RUNNER_PI_RPC_THINKING_LEVELS).toEqual(PI_THINKING_LEVELS);
  });
  it("selects the new harness without changing historical Pi", () => {
    expect(agentHarnessType("paperclip_runner", { provider: "pi_rpc" })).toBe("pi_rpc");
    expect(paperclipRunnerProfileForHarness("pi_rpc")).toEqual({ provider: "pi_rpc" });
    expect(paperclipRunnerProfileForHarness("pi_local")).toEqual({ provider: "pi_rpc" });
    expect(agentHarnessType("paperclip_runner", { provider: "acpx", acpxAgent: "pi" })).toBe("pi_local");
  });
  it("resolves native Pi with the actual immutable profile and exact xhigh", () => {
    expect(resolvePaperclipRunnerProviderProfile({ provider: "pi_rpc", model, piRpcThinkingLevel: "xhigh" }))
      .toMatchObject({ provider: "pi_rpc", backend: "pi_rpc", model });
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "pi_rpc", adapterConfig: { provider: "pi_rpc", model, piRpcThinkingLevel: "xhigh" } }))
      .toMatchObject({ provider: "pi_rpc", model, profile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh" });
  });
  it("refuses a caller-replaced profile or ACPX selectors", () => {
    expect(() => resolvePaperclipRunnerProviderProfile({ provider: "pi_rpc", model, profile: { ...QUALIFIED_PI_RPC_PROFILE, runtimeVersion: "1.0.0" } })).toThrow();
    expect(() => resolvePaperclipRunnerProviderProfile({ provider: "pi_rpc", model, acpxAgent: "pi" })).toThrow();
  });
});


// Trust boundary: the native provider never silently clamps model-unsupported thinking.
describe("Pi RPC Claude effort cap", () => {
  it.each(["anthropic/claude-opus-5-5", "paperclip/gateway/claude-sonnet-5-5", "anthropic/claude-opus-4-6", "gateway/Claude-Haiku"])("rejects max for %s", model => {
    expect(() => resolvePaperclipRunnerProviderProfile({ provider: "pi_rpc", model, piRpcThinkingLevel: "max" })).toThrow(/Claude.*xhigh/i);
    expect(() => resolvePaperclipRunnerNativeProviderInput({ backend: "pi_rpc", adapterConfig: { provider: "pi_rpc", model, piRpcThinkingLevel: "max" } })).toThrow(/Claude.*xhigh/i);
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "pi_rpc", adapterConfig: { provider: "pi_rpc", model, piRpcThinkingLevel: "xhigh" } })).toMatchObject({ model, piRpcThinkingLevel: "xhigh" });
  });
  it("leaves max exact for a non-Claude model and ACPX Pi", () => {
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "pi_rpc", adapterConfig: { provider: "pi_rpc", model: "openai/gpt-6", piRpcThinkingLevel: "max" } })).toMatchObject({ piRpcThinkingLevel: "max" });
    expect(resolvePaperclipRunnerNativeProviderInput({ backend: "acpx_runtime", adapterConfig: { provider: "acpx", acpxAgent: "pi", model, piThinkingLevel: "max" } })).toMatchObject({ piThinkingLevel: "max" });
  });
});


describe("native Pi field ownership", () => {
  it.each(["piThinkingLevel", "thinking", "modelReasoningEffort", "reasoningEffort", "effort"])("does not accept the alias %s", key => {
    expect(() => resolvePaperclipRunnerProviderProfile({ provider: "pi_rpc", model, [key]: "high" })).toThrow();
  });
  it.each(["codex", "opencode", "acpx"])("refuses the native key on %s", provider => {
    expect(() => resolvePaperclipRunnerProviderProfile({ provider, model, piRpcThinkingLevel: "high" })).toThrow(/native Pi RPC/);
  });
});
