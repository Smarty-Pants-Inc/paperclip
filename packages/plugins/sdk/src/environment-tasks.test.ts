import { describe, expect, it } from "vitest";
import {
  environmentRunnerLaunchRequirementsSchema,
  environmentTaskOperationSchema,
  environmentTaskCredentialSchema,
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

// Keep: transient provider secrets cross an untrusted plugin/RPC boundary.
describe("native Pi task credentials", () => {
  const environment = { PAPERCLIP_AI_PROVIDER_KEY: "synthetic-key", PAPERCLIP_AI_PROVIDER_URL: "https://gateway.example/v1",
    PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "bearer" };
  it("preserves the exact selected managed provider route and key", () => {
    const credential = { type: "pi-env", environment };
    expect(environmentTaskCredentialSchema.parse(credential)).toEqual(credential);
  });
  it.each(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY"])("accepts one standard Pi credential %s", key => {
    const credential = { type: "pi-env", environment: { [key]: "synthetic-key" } };
    expect(environmentTaskCredentialSchema.parse(credential)).toEqual(credential);
  });
  it("accepts an explicit local no-auth route without a credential", () => {
    const { PAPERCLIP_AI_PROVIDER_KEY: _key, ...route } = environment;
    const credential = { type: "pi-env", environment: { ...route, PAPERCLIP_AI_PROVIDER_AUTH: "none" } };
    expect(environmentTaskCredentialSchema.parse(credential)).toEqual(credential);
  });
  it.each(["HOME", "PATH", "NODE_OPTIONS", "PI_CODING_AGENT_DIR", "PAPERCLIP_PI_RPC_CREDENTIAL_MODE"])("rejects executable/home overrides: %s", key => {
    expect(environmentTaskCredentialSchema.safeParse({ type: "pi-env", environment: { ...environment, [key]: "untrusted" } }).success).toBe(false);
  });
  it.each([
    {}, { PAPERCLIP_AI_PROVIDER_KEY: "missing-route" }, { OPENAI_API_KEY: "a", ANTHROPIC_API_KEY: "b" },
    { ...environment, PAPERCLIP_AI_PROVIDER_URL: "https://secret@gateway.example" },
    { ...environment, PAPERCLIP_AI_PROVIDER_URL: "https://gateway.example?key=secret" },
    { ...environment, PAPERCLIP_AI_PROVIDER_URL: "file:///tmp/provider" },
    { ...environment, PAPERCLIP_AI_PROVIDER_PROTOCOL: undefined },
    { ...environment, PAPERCLIP_AI_PROVIDER_AUTH: "none" },
    { ...environment, PAPERCLIP_AI_PROVIDER_KEY: undefined },
  ])("refuses incomplete, conflicting, or credential-bearing routes: %j", input => {
    expect(environmentTaskCredentialSchema.safeParse({ type: "pi-env", environment: input }).success).toBe(false);
  });
});
