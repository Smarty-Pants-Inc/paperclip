import { describe, expect, it } from "vitest";
import { admittedSandboxLeaseConfig, sandboxLeaseIdentityConfig } from "./sandbox-lease-config-compatibility.js";

// Keep: security/credential trust boundary; never classify arbitrary provider
// settings as compatible merely because one provider considers them harmless.
describe("sandbox lease configuration compatibility", () => {
  // SUPERSEDED BY REPLACEMENT (RFL + review-fleet-5, #20878): c9c1f35d makes from/snapshot/image/rootfs allocation identity so an obsolete boot source cannot be deferred.
  it.each(["from", "snapshot", "image", "rootfs"])("never treats %s as a compatible setting", key => {
    expect(sandboxLeaseIdentityConfig({ provider: "provider", [key]: "before" }))
      .not.toEqual(sandboxLeaseIdentityConfig({ provider: "provider", [key]: "after" }));
    expect(admittedSandboxLeaseConfig({ provider: "provider", [key]: "after" }, { [key]: "before" }))
      .toEqual({ provider: "provider", [key]: "after" });
  });

  it.each([
    "cpu", "memory", "disk", "gpu", "size", "shape",
    "timeoutMs", "bridgeRequestTimeoutMs", "livenessTimeoutMs", "ttlMinutes", "autoStopInterval",
    "autoArchiveInterval", "autoDeleteInterval", "runnerIdleTimeoutMs",
  ])("defers the explicit scalar creation/timing field %s", key => {
    expect(sandboxLeaseIdentityConfig({ provider: "provider", [key]: "before" }))
      .toEqual(sandboxLeaseIdentityConfig({ provider: "provider", [key]: "after" }));
    expect(admittedSandboxLeaseConfig({ provider: "provider", [key]: "after" }, { [key]: "before" }))
      .toEqual({ provider: "provider", [key]: "before" });
  });

  it.each(["provider", "account", "accountId", "region", "target", "endpoint", "apiUrl", "mounts", "credentialsScope", "env", "unknownFutureSetting"])(
    "never defers identity/security field %s", key => {
      expect(sandboxLeaseIdentityConfig({ [key]: "before" })).not.toEqual(sandboxLeaseIdentityConfig({ [key]: "after" }));
    });

  it("does not treat nested source credentials or unknown resource policy as scalar sizing", () => {
    expect(sandboxLeaseIdentityConfig({ from: { image: "a", account: "sensitive" }, resources: { cpu: 2, mounts: ["private"], policy: "restricted" } }))
      .toEqual({ from: { image: "a", account: "sensitive" }, resources: { mounts: ["private"], policy: "restricted" } });
    expect(admittedSandboxLeaseConfig({ resources: { cpu: 4, mounts: ["private"] } }, { resources: { cpu: 2 } }))
      .toEqual({ resources: { cpu: 2, mounts: ["private"] } });
  });

  // SUPERSEDED BY REPLACEMENT (RFL + review-fleet-5, #20878): c9c1f35d separates boot identity from compatible sizing; absence of admitted sizing must still be preserved.
  it("preserves absent compatible sizing settings when boot identity matches", () => {
    expect(admittedSandboxLeaseConfig({ provider: "provider", from: "same", resources: { cpu: 4 } }, { provider: "provider", from: "same" }))
      .toEqual({ provider: "provider", from: "same" });
  });

  // SUPERSEDED BY REPLACEMENT (RFL + review-fleet-5, #20878): c9c1f35d makes a newly supplied boot source identity rather than a setting deferrable onto an old allocation.
  it("a boot-identity difference is not deferred onto an old allocation", () => {
    const current = { provider: "provider", from: "new", resources: { cpu: 4 } };
    const admitted = { provider: "provider" };
    expect(sandboxLeaseIdentityConfig(current)).not.toEqual(sandboxLeaseIdentityConfig(admitted));
    expect(admittedSandboxLeaseConfig(current, admitted)).toEqual({ provider: "provider", from: "new" });
  });
});
