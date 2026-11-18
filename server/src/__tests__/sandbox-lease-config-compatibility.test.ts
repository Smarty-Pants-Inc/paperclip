import { describe, expect, it } from "vitest";
import { sandboxLeaseSourceMatches } from "../services/sandbox-lease-config-compatibility.js";
import { findReusableSandboxProviderLeaseId } from "../services/sandbox-provider-runtime.js";

describe("sandbox boot-source identity", () => {
  // Keep: rung-6 run 6c0d4025 resumed an obsolete snapshot; data safety.
  it.each(["from", "snapshot", "image", "rootfs"])("never treats %s as a compatible setting", async key => {
    const admitted = { provider: "source-plugin", [key]: "snap-A", reuseLease: true, cpu: 1 };
    const current = { ...admitted, [key]: "snap-B", cpu: 2 };
    expect(sandboxLeaseSourceMatches(current, admitted)).toBe(false);
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
});
