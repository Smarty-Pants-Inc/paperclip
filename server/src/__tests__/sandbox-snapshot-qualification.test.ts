import { describe, expect, it } from "vitest";
import type { Environment, PluginSandboxEnvironmentConfig } from "@paperclipai/shared";
import { fingerprintEnvironmentSandboxProviderConfig as fingerprint, SANDBOX_PLATFORM_PROBE_METADATA_KEY } from "../services/environment-custom-image-runtime.js";
import { hasSandboxSnapshotQualification, qualifiedSandboxSnapshotId, readSnapshotIdentity, type SandboxTemplateIdentity } from "../services/sandbox-snapshot-qualification.js";

function fixture() {
  const config: PluginSandboxEnvironmentConfig & { snapshot: string } = { provider: "daytona", reuseLease: false, snapshot: "managed-snapshot", apiKey: "fixture-account" };
  const template: SandboxTemplateIdentity = { id: "template", capturedAt: "2026-10-15T00:00:00Z", templateKind: "snapshot", bindingField: "snapshot" };
  const identity = { provider: "daytona", requestedRef: config.snapshot, id: "a6b9e7d0-f886-471a-b461-640dd03e8d0f", name: config.snapshot, organizationId: "provider-account", createdAt: "2026-10-07T23:19:57.133Z" };
  const proof = { v: 2, companyId: "company", snapshot: config.snapshot, template,
    baseConfigFingerprint: fingerprint(config), runtimeConfigFingerprint: fingerprint(config), snapshotIdentity: identity };
  const environment = { config, metadata: { [SANDBOX_PLATFORM_PROBE_METADATA_KEY]: { company: proof } } } as unknown as Environment;
  return { config, template, identity, proof, environment };
}

function boatFixture() {
  const f = fixture();
  f.config.provider = "boat";
  f.identity.provider = "boat";
  f.identity.id = "snap_01JBOAT-immutable:42";
  f.proof.baseConfigFingerprint = fingerprint(f.config);
  f.proof.runtimeConfigFingerprint = fingerprint(f.config);
  return f;
}

// Keep these trust-boundary checks: a saved proof must bind the selected
// provider, immutable resource, account, company, config and captured template.
describe("provider snapshot identity handshake", () => {
  it.each(["name", "id"])("pins a Boat snapshot selected by %s without a UUID or network lookup", reference => {
    const f = boatFixture();
    if (reference === "id") {
      f.config.snapshot = f.identity.id;
      f.identity.requestedRef = f.identity.id;
      f.proof.snapshot = f.identity.id;
      f.proof.baseConfigFingerprint = fingerprint(f.config);
      f.proof.runtimeConfigFingerprint = fingerprint(f.config);
    }
    expect(readSnapshotIdentity(f.identity, f.config.snapshot, "boat")).toEqual(f.identity);
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBe(f.identity.id);
  });

  it("accepts a 256-character immutable ID", () => {
    const f = boatFixture();
    f.identity.id = "a".repeat(256);
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBe(f.identity.id);
  });

  it("qualifies a Boat snapshot without a captured template", () => {
    const f = boatFixture();
    Object.assign(f.proof, { template: null });
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, null)).toBe(f.identity.id);
  });

  it.each(["image", "template", "templateRef"])("rejects a competing %s even with matching fingerprints", field => {
    const f = boatFixture();
    f.config = { ...f.config, [field]: "competing-boot-source" };
    f.environment.config = f.config;
    f.proof.baseConfigFingerprint = fingerprint(f.config);
    f.proof.runtimeConfigFingerprint = fingerprint(f.config);
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBeNull();
  });

  it.each([
    { templateKind: "image", bindingField: "image" },
    { templateKind: "provider_template", bindingField: "template" },
    { templateKind: "snapshot", bindingField: "templateRef" },
  ])("rejects a non-snapshot template binding (%j)", binding => {
    const f = boatFixture();
    f.template = { ...f.template!, ...binding };
    f.proof.template = f.template;
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBeNull();
  });

  it.each([
    { provider: "daytona" },
    { provider: "Boat" },
    { requestedRef: "another-snapshot" },
    { name: "another-snapshot" },
    { name: " " },
    { organizationId: "" },
    { organizationId: " " },
    { createdAt: "not-a-date" },
    { id: "" },
    { id: "snap with-space" },
    { id: " snap" },
    { id: "snap\t42" },
    { id: "snap\n42" },
    { id: "a".repeat(257) },
  ])("rejects invalid Boat identity fields (%j)", change => {
    const f = boatFixture();
    Object.assign(f.identity, change);
    expect(readSnapshotIdentity(f.identity, f.config.snapshot, "boat")).toBeNull();
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBeNull();
  });

  it("requires the identity provider to equal the selected provider even for a Daytona UUID", () => {
    const f = fixture();
    expect(readSnapshotIdentity(f.identity, f.config.snapshot, "boat")).toBeNull();
  });

  it.each(["company", "base-config", "account", "runtime-config", "template", "snapshot", "image", "provider", "invalidated"])("rejects Boat proof after changed %s", change => {
    const f = boatFixture();
    let company = "company";
    if (change === "company") company = "foreign-company";
    if (change === "base-config") f.environment.config = { ...f.config, target: "different" };
    if (change === "account") f.config = { ...f.config, apiKey: "different-account" };
    if (change === "runtime-config") f.proof.runtimeConfigFingerprint = "different";
    if (change === "template") f.template = { ...f.template!, capturedAt: "2026-10-16T00:00:00Z" };
    if (change === "snapshot") f.config = { ...f.config, snapshot: "new-snapshot" };
    if (change === "image") f.config = { ...f.config, image: "other-image" };
    if (change === "provider") f.config = { ...f.config, provider: "other-provider" };
    if (change === "invalidated") Object.assign(f.proof, { invalidated: true });
    expect(qualifiedSandboxSnapshotId(f.environment, company, f.config, f.template)).toBeNull();
  });
});

describe("qualified snapshot execution binding", () => {
  it("pins the measured provider ID without a network lookup", () => {
    const f = fixture();
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBe(f.identity.id);
  });
  it("keeps a revoked proof as a required qualification without accepting it", () => {
    const f = fixture();
    Object.assign(f.proof, { invalidated: true });
    expect(hasSandboxSnapshotQualification(f.environment, "company")).toBe(true);
    expect(hasSandboxSnapshotQualification(f.environment, "foreign-company")).toBe(false);
    expect(qualifiedSandboxSnapshotId(f.environment, "company", f.config, f.template)).toBeNull();
  });
  it.each(["company", "base-config", "account", "template", "snapshot", "image", "provider", "identity"])("rejects changed %s", change => {
    const f = fixture();
    let company = "company";
    if (change === "company") company = "foreign-company";
    if (change === "base-config") f.environment.config = { ...f.config, target: "different" };
    if (change === "account") f.config = { ...f.config, apiKey: "different-account" };
    if (change === "template") f.template = { ...f.template!, capturedAt: "2026-10-16T00:00:00Z" };
    if (change === "snapshot") f.config = { ...f.config, snapshot: "new-snapshot" };
    if (change === "image") f.config = { ...f.config, image: "other-image" };
    if (change === "provider") f.config = { ...f.config, provider: "other-provider" };
    if (change === "identity") f.identity.id = "mutable-name";
    expect(qualifiedSandboxSnapshotId(f.environment, company, f.config, f.template)).toBeNull();
  });
});
