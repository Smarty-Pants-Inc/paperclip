import { describe, expect, it } from "vitest";
import {
  environmentRunnerLaunchRequirementsSchema,
  environmentTaskOperationSchema,
} from "./environment-tasks.js";

// Trust boundary: plugin launch preparation must retain each native value exactly,
// while refusing values that belong only to the other Pi protocol.
const nativeThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const acpxThinkingLevels = ["off", "low", "high", "max"] as const;
function requirements(provider = "pi_rpc", settings: Record<string, unknown> = {}) {
  return {
    schema: "paperclip.runner.launch-requirements.v1",
    identity: {
      runnerInstanceId: "runner-1", environmentLeaseId: "lease-1", runId: "run-1",
      normalizedSessionId: "session-1", turnId: "turn-1", itemId: "item-1",
    },
    provider, model: "cliproxyapi-anthropic/claude-opus-5-5", instructions: "",
    runtimeContext: null, settings, approvalPolicy: "never", readOnly: false,
    preparedConversation: false, includeCollaborationModeInstructions: false,
  };
}

describe("native Pi RPC environment launch requirements", () => {
  it.each(nativeThinkingLevels)("preserves native %s through plugin preparation", level => {
    const launch = requirements("pi_rpc", { piRpcThinkingLevel: level });
    const parsed = environmentTaskOperationSchema.parse({ kind: "prepare", requirements: launch, projectIds: [] });
    expect(parsed).toEqual({ kind: "prepare", requirements: launch, projectIds: [] });
  });

  it("keeps the native thinking setting optional", () => {
    expect(environmentRunnerLaunchRequirementsSchema.parse(requirements()).settings).toEqual({});
  });

  it.each(["x-high", "maximum", "disabled", "", null, 1])("rejects native alias or invalid value %s", level => {
    expect(environmentRunnerLaunchRequirementsSchema.safeParse(requirements("pi_rpc", { piRpcThinkingLevel: level })).success).toBe(false);
  });

  it.each(acpxThinkingLevels)("preserves ACPX Pi %s without a native field", level => {
    const launch = requirements("acpx", { acpxAgent: "pi", piThinkingLevel: level });
    expect(environmentRunnerLaunchRequirementsSchema.parse(launch)).toEqual(launch);
  });

  it.each(["minimal", "medium", "xhigh"])("does not widen ACPX Pi to %s", level => {
    expect(environmentRunnerLaunchRequirementsSchema.safeParse(requirements("acpx", { acpxAgent: "pi", piThinkingLevel: level })).success).toBe(false);
  });

  it("does not alias the independently owned Pi thinking fields", () => {
    const launch = requirements("pi_rpc", { piRpcThinkingLevel: "xhigh", piThinkingLevel: "low" });
    expect(environmentRunnerLaunchRequirementsSchema.parse(launch).settings).toEqual(launch.settings);
  });

  it("keeps the provider enum closed", () => {
    expect(environmentRunnerLaunchRequirementsSchema.safeParse(requirements("pi")).success).toBe(false);
  });
});
