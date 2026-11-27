// These deploy fixtures have no secret refs or workspace migration. The resolved
// input below and scope minter are copied from environment-runtime.ts at 8237cf02;
// unlike a head-minted hash this always retains that release's identity policy.
import { createHash } from "node:crypto";
import { createEffectiveRunConfigFingerprints, type EffectiveRunConfigFingerprint }
  from "./effective-run-config-fingerprints-8237cf02.js";
const readString = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
export function buildReusableSandboxLeaseFingerprint8237(input: {
  companyId: string; environment: { id: string; driver: string };
  executionWorkspaceId: string | null; issueId: string | null; agentId: string | null;
  adapterType: string | null; provider: string; providerConfig: Record<string, unknown>;
  providerPlugin?: { id: string; pluginKey: string; packageName: string; version: string } | null;
}): EffectiveRunConfigFingerprint {
  const secretMetadata: [] = [];
  const workspaceMigration = null as { operationId: string } | null;
  return createEffectiveRunConfigFingerprints({
    lease: {
      companyId: input.companyId,
      environment: {
        id: input.environment.id,
        driver: input.environment.driver,
      },
      executionWorkspaceId: input.executionWorkspaceId,
      ...(workspaceMigration ? { workspaceMigrationGeneration: workspaceMigration.operationId } : {}),
      ...(input.executionWorkspaceId ? {} : { projectlessIssueId: input.issueId }),
      agentId: input.agentId,
      adapterType: input.adapterType,
      provider: input.provider,
      providerPlugin: input.providerPlugin ?? null,
      providerConfig: input.providerConfig,
      secrets: secretMetadata,
    },
    secretManifest: secretMetadata,
  }).leaseFingerprint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function reusableRuntimeFingerprint(input: {
  provider: string;
  adapterType: string | null;
  config: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(stableStringify(input))
    .digest("hex");
}

function serializeLeaseFingerprint(
  fingerprint: EffectiveRunConfigFingerprint | null | undefined,
): Record<string, unknown> | null {
  if (!fingerprint) return null;
  return {
    version: fingerprint.version,
    category: fingerprint.category,
    algorithm: fingerprint.algorithm,
    fingerprint: fingerprint.fingerprint,
  };
}

export function buildReusableSandboxLeaseScope8237(input: {
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  agentId: string | null;
  adapterType: string | null;
  provider: string;
  config: Record<string, unknown>;
  leaseFingerprint?: EffectiveRunConfigFingerprint | null;
  providerMetadata?: Record<string, unknown> | null;
}): Record<string, unknown> | null {
  // Chat tasks need not have a project workspace. Their task + agent identity
  // is a stable, narrower reuse boundary; unscoped/ad-hoc probes cannot match it.
  if ((!input.executionWorkspaceId && !input.issueId) || !input.agentId) return null;
  const providerMetadata = input.providerMetadata ?? {};
  const adapterType = input.adapterType ?? null;
  const remoteCwd = readString(providerMetadata.remoteCwd);
  const workspaceSentinel = isRecord(providerMetadata.workspaceSentinel)
    ? { ...providerMetadata.workspaceSentinel }
    : null;
  return {
    version: 1,
    companyId: input.companyId,
    environmentId: input.environmentId,
    executionWorkspaceId: input.executionWorkspaceId,
    ...(input.executionWorkspaceId ? {} : { projectlessIssueId: input.issueId }),
    agentId: input.agentId,
    adapterType,
    provider: input.provider,
    runtimeFingerprint: reusableRuntimeFingerprint({
      provider: input.provider,
      adapterType,
      config: input.config,
    }),
    ...(input.leaseFingerprint
      ? { leaseFingerprint: serializeLeaseFingerprint(input.leaseFingerprint) }
      : {}),
    ...(remoteCwd ? { remoteCwd } : {}),
    ...(workspaceSentinel ? { workspaceSentinel } : {}),
  };
}
