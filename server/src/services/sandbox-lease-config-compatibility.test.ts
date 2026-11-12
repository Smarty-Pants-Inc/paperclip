import { describe, expect, it } from "vitest";
import { admittedSandboxLeaseConfig, sandboxLeaseIdentityConfig } from "./sandbox-lease-config-compatibility.js";

// Keep: security/credential trust boundary; never classify arbitrary provider
// settings as compatible merely because one provider considers them harmless.
describe("sandbox lease configuration compatibility", () => {
  it.each([
    "from", "snapshot", "image", "rootfs", "cpu", "memory", "disk", "gpu", "size", "shape",
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

  it("preserves absent settings instead of pretending the old allocation booted a new default", () => {
    expect(admittedSandboxLeaseConfig({ provider: "provider", from: "new", resources: { cpu: 4 } }, { provider: "provider" }))
      .toEqual({ provider: "provider" });
  });
});
