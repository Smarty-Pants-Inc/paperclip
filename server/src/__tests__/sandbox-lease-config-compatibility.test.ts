import { describe, expect, it } from "vitest";
import { admittedSandboxLeaseConfig, sandboxLeaseIdentityConfig, sandboxLeaseSourceMatches } from "../services/sandbox-lease-config-compatibility.js";
import { findReusableSandboxProviderLeaseId } from "../services/sandbox-provider-runtime.js";
import { reusableSandboxConfigurationChangeIsSafe } from "../services/reusable-sandbox-resume-replacement.js";

describe("sandbox timing configuration compatibility", () => {
  // Keep: J3-24 option-A timing edits must not strand retained chat state.
  it.each([
    { name: "ttlSeconds only", before: { ttlSeconds: 3600 }, after: { ttlSeconds: 1800 } },
    { name: "runnerReconnectGraceMs only", before: { runnerReconnectGraceMs: 60_000 }, after: { runnerReconnectGraceMs: 420_000 } },
    { name: "both timing knobs", before: { ttlSeconds: 3600, runnerReconnectGraceMs: 60_000 }, after: { ttlSeconds: 1800, runnerReconnectGraceMs: 420_000 } },
  ])("keeps lease identity when changing $name", ({ before, after }) => {
    const identity = { provider: "boat", from: "snapshot-a", region: "eu", env: { LANG: "en_US.UTF-8" } };
    expect(sandboxLeaseIdentityConfig({ ...identity, ...after }))
      .toEqual(sandboxLeaseIdentityConfig({ ...identity, ...before }));
    expect(sandboxLeaseIdentityConfig({ ...identity, ...after })).toEqual(identity);
  });

  it.each([
    { key: "from", before: "snapshot-a", after: "snapshot-b" },
    { key: "snapshot", before: "snapshot-a", after: "snapshot-b" },
    { key: "image", before: "image-a", after: "image-b" },
    { key: "env", before: { LANG: "en_US.UTF-8" }, after: { LANG: "C" } },
    { key: "unknownProviderKey", before: "before", after: "after" },
  ])("keeps $key changes in identity alongside timing changes", ({ key, before, after }) => {
    const admitted = { provider: "boat", ttlSeconds: 3600, runnerReconnectGraceMs: 60_000, [key]: before };
    const current = { ...admitted, ttlSeconds: 1800, runnerReconnectGraceMs: 420_000, [key]: after };
    expect(sandboxLeaseIdentityConfig(current)).not.toEqual(sandboxLeaseIdentityConfig(admitted));
    expect(sandboxLeaseIdentityConfig(current)[key]).toEqual(after);
  });

  it.each(["ttlSeconds", "runnerReconnectGraceMs"].flatMap(key => [
    { key, shape: "object", before: { value: 3600 }, after: { value: 1800 } },
    { key, shape: "array", before: [3600], after: [1800] },
    { key, shape: "boolean", before: false, after: true },
  ]))("fails closed for a $shape value of $key", ({ key, before, after }) => {
    expect(sandboxLeaseIdentityConfig({ [key]: after })).toEqual({ [key]: after });
    expect(sandboxLeaseIdentityConfig({ [key]: after })).not.toEqual(sandboxLeaseIdentityConfig({ [key]: before }));
  });
});

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
