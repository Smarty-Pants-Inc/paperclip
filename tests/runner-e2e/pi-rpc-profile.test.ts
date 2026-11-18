import { describe, expect, it, vi } from "vitest";
import { QUALIFIED_PI_RPC_PROFILE } from "../../packages/paperclip-runner/src/drivers/pi/qualified-profile.js";
import { supportsManagedNativeWarmSession } from "../../server/src/services/native-runtime/native-warm-capability.js";
import { managedWarmProfiles, runnerMatrix, runnerProfiles, runnerSuites, suiteDefinitionHash } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";

// Preserve the real admission policy; observe the catalog's backend selection.
vi.mock("../../server/src/services/native-runtime/native-warm-capability.js", { spy: true });

const secretRef = { type: "secret_ref" as const, secretId: "22222222-2222-4222-8222-222222222222", version: "latest" as const };
function profile() {
  const found = runnerProfiles.find(candidate => candidate.id === "runner-pi-rpc");
  expect(found, "native Pi RPC must be registered independently of ACPX Pi").toBeDefined();
  return found!;
}

describe("native Pi RPC discovery (no provider execution)", () => {
  it("uses the production declaration but a separately explicit acceptance model", () => {
    expect(profile()).toMatchObject({
      generation: "native", provider: "pi_rpc", adapterType: "paperclip_runner",
      expectedRuntimeMode: "native", expectedRuntimeMetadata: { adapterType: "paperclip_runner", provider: "pi_rpc" },
      model: "cliproxyapi-anthropic/claude-opus-5-5", credential: "ANTHROPIC_API_KEY",
      piRpcProfile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh",
    });
  });

  it.each(["local", "daytona"] as const)("builds %s with native fields and encrypted credential references only", environmentFixtureId => {
    const agent = profile().buildAgent({ environmentId: "env-1", environmentFixtureId,
      workspacePath: "/workspace", executionId: "discovery", secretRefs: { ANTHROPIC_API_KEY: secretRef } });
    expect(agent.adapterConfig).toMatchObject({ provider: "pi_rpc", model: "cliproxyapi-anthropic/claude-opus-5-5",
      piRpcProfile: QUALIFIED_PI_RPC_PROFILE, piRpcThinkingLevel: "xhigh", lifecycleMode: "per_turn",
      env: { ANTHROPIC_API_KEY: secretRef } });
    for (const key of ["acpxAgent", "acpxPermissionMode", "piThinkingLevel"]) expect(agent.adapterConfig).not.toHaveProperty(key);
  });

  it("requires a credential binding rather than falling back to ambient credentials", () => {
    expect(() => profile().buildAgent({ environmentId: "env-1", environmentFixtureId: "local",
      workspacePath: "/workspace", executionId: "discovery", secretRefs: {} })).toThrow("Missing fixture secret reference ANTHROPIC_API_KEY");
  });

  it("is selectable by profile across the existing core and local integrity journeys", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--profile", "runner-pi-rpc"]));
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every(cell => cell.profile.id === "runner-pi-rpc" && cell.profile.generation === "native")).toBe(true);
    expect(cells.some(cell => cell.suite.id === "core-compatibility" && cell.environment.id === "local")).toBe(true);
    expect(cells.some(cell => cell.suite.id === "core-compatibility" && cell.environment.id === "daytona")).toBe(true);
    expect(cells.some(cell => cell.suite.id === "local-session-integrity")).toBe(true);
  });

  it("asks the production managed-warm gate about pi_rpc, never the ACPX fallback", () => {
    managedWarmProfiles([profile()]);
    expect(supportsManagedNativeWarmSession).toHaveBeenCalledWith({ backend: "pi_rpc", acpxAgent: undefined }, undefined);
    const gate = vi.mocked(supportsManagedNativeWarmSession);
    const admitted = gate.mock.results.some((result, index) =>
      (gate.mock.calls[index]?.[0].backend as string) === "pi_rpc" && result.value === true);
    expect(runnerMatrix.some(cell => cell.suite.id === "rolling-web-deployment-warm" && cell.profile.id === "runner-pi-rpc")).toBe(admitted);
    expect(runnerMatrix.some(cell => cell.suite.id === "rolling-web-deployment" && cell.profile.id === "runner-pi-rpc")).toBe(true);
  });

  it("fingerprints the native production declaration and thinking selection", () => {
    const native = profile();
    const suite = runnerSuites.find(candidate => candidate.id === "core-compatibility")!;
    const base = { ...suite, profiles: [native] };
    expect(suiteDefinitionHash(base)).not.toBe(suiteDefinitionHash({ ...base, profiles: [{ ...native, piRpcThinkingLevel: "max" }] }));
    expect(suiteDefinitionHash(base)).not.toBe(suiteDefinitionHash({ ...base, profiles: [{ ...native, piRpcProfile: undefined }] }));
  });
});
