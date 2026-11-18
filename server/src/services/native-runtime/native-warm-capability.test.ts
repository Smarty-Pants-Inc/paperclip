import { describe, expect, it } from "vitest";
import { defaultsRemoteSandboxRunToWarm, defaultsToWarmFollowUp, supportsManagedNativeWarmSession, supportsNativeWarmFiles } from "./native-warm-capability.js";
import type { PaperclipRunnerProviderProfile } from "./provider-profile.js";

describe("native warm credential and file admission", () => {
  const copilot: PaperclipRunnerProviderProfile = {
    provider: "acpx", backend: "acpx_runtime", acpxAgent: "copilot", model: "gpt-5.6-luna",
  };
  it("admits the saved Copilot token with its session-owned home and file handoff", () => {
    expect(supportsNativeWarmFiles(copilot)).toBe(true);
    expect(supportsManagedNativeWarmSession(copilot, { provider: "github", method: "api_key" })).toBe(true);
  });
  it.each([undefined, { provider: "github", method: "subscription" }, { provider: "openai", method: "api_key" }])(
    "refuses a missing or mismatched Copilot credential: %j", (attribution) => {
      expect(supportsManagedNativeWarmSession(copilot, attribution)).toBe(false);
    },
  );
  it.each(["cursor", "pi", "claude", "grok"] as const)("preserves %s managed per-turn admission", (acpxAgent) => {
    const profile = { ...copilot, acpxAgent };
    expect(supportsNativeWarmFiles(profile)).toBe(false);
    expect(supportsManagedNativeWarmSession(profile, { provider: "github", method: "api_key" })).toBe(false);
  });
  it("preserves Codex warm support", () => {
    const profile: PaperclipRunnerProviderProfile = { provider: "codex", backend: "codex_app_server", model: "gpt-5.6-sol" };
    expect(supportsNativeWarmFiles(profile)).toBe(true);
    expect(supportsManagedNativeWarmSession(profile, undefined)).toBe(true);
  });
});

// Trust boundary: only the runner-owned managed loopback may retain a native Pi session.
describe("native Pi managed warm admission", () => {
  const profile = { backend: "pi_rpc" as const };
  const attribution = { provider: "anthropic", method: "api_key" };
  const route = { kind: "gateway", protocol: "messages", auth: "bearer" };
  it("supports session-owned files and local follow-up defaults", () => {
    expect(supportsNativeWarmFiles(profile)).toBe(true);
    expect(defaultsToWarmFollowUp(profile, "local")).toBe(true);
  });
  it.each(["gateway", "local"])("admits broker-served %s messages and responses", kind => {
    for (const protocol of ["messages", "responses"]) {
      const selected = { ...route, kind, protocol };
      expect(supportsManagedNativeWarmSession(profile, { ...attribution, provider: protocol === "messages" ? "anthropic" : "openai" }, selected)).toBe(true);
      expect(defaultsRemoteSandboxRunToWarm({ profile, reusableLeaseSupported: true, managedAi: { attribution: { ...attribution, provider: protocol === "messages" ? "anthropic" : "openai" }, routing: selected } })).toBe(true);
    }
  });
  it.each([
    [undefined, route], [attribution, undefined], [{ ...attribution, method: "subscription" }, route],
    [{ ...attribution, provider: "github" }, route], [{ ...attribution, provider: "openai" }, route],
    [attribution, { ...route, kind: "openrouter" }], [attribution, { ...route, protocol: "chat" }],
    [attribution, { ...route, auth: "unknown" }],
  ])("refuses an unserved attribution/routing pair %j / %j", (credential, routing) => {
    expect(supportsManagedNativeWarmSession(profile, credential, routing)).toBe(false);
    expect(defaultsRemoteSandboxRunToWarm({ profile, reusableLeaseSupported: true, managedAi: { attribution: credential, routing } })).toBe(false);
  });
  it("does not default an ephemeral sandbox or change ACPX Pi", () => {
    expect(defaultsRemoteSandboxRunToWarm({ profile, reusableLeaseSupported: false, managedAi: { attribution, routing: route } })).toBe(false);
    const acpx = { backend: "acpx_runtime" as const, acpxAgent: "pi" };
    expect(supportsManagedNativeWarmSession(acpx, attribution, route)).toBe(false);
    expect(defaultsToWarmFollowUp(acpx, "remote_sandbox")).toBe(false);
  });
});
