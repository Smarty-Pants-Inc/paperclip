import { describe, expect, it } from "vitest";
import { admittedSandboxLeaseConfig, sandboxLeaseIdentityConfig, sandboxLeaseSourceMatches } from "../services/sandbox-lease-config-compatibility.js";
import { findReusableSandboxProviderLeaseId } from "../services/sandbox-provider-runtime.js";
import { reusableSandboxConfigurationChangeIsSafe } from "../services/reusable-sandbox-resume-replacement.js";

describe("sandbox boot-source identity", () => {
  // Keep: rung-6 run 6c0d4025 resumed an obsolete snapshot; data safety.
  it.each(["from", "snapshot", "image", "rootfs"])("never treats %s as a compatible setting", async key => {
    const admitted = { provider: "source-plugin", [key]: "snap-A", reuseLease: true, cpu: 1 };
    const current = { ...admitted, [key]: "snap-B", cpu: 2 };
    expect(sandboxLeaseIdentityConfig(admitted)[key]).toBe("snap-A");
    expect(sandboxLeaseIdentityConfig(current)[key]).toBe("snap-B");
    expect(admittedSandboxLeaseConfig(current, admitted)).toMatchObject({ [key]: "snap-B", cpu: 1 });
    expect(sandboxLeaseSourceMatches(current, admitted)).toBe(false);
    // Even a fully checkpointed lease cannot make an old source compatible.
    // No DB access is needed to reject a boot-source mismatch.
    await expect(reusableSandboxConfigurationChangeIsSafe({ config: current, lease: { metadata: admitted } } as never)).resolves.toBe(false);
    for (const value of ["snap-B", null, undefined]) {
      expect(findReusableSandboxProviderLeaseId({
        config: { ...current, [key]: value },
        leases: [{ providerLeaseId: "old-source", metadata: admitted }],
      })).toBeNull();
    }
    expect(findReusableSandboxProviderLeaseId({
      config: admitted, leases: [{ providerLeaseId: "same-source", metadata: admitted }],
    })).toBe("same-source");
  });

  it("keeps unknown provider source aliases in allocation identity", () => {
    const config = { template: "base-template", snapshotId: "base-snapshot", imageId: "base-image", cpu: 2 };
    expect(sandboxLeaseIdentityConfig(config)).toEqual({ template: "base-template", snapshotId: "base-snapshot", imageId: "base-image" });
  });
});
