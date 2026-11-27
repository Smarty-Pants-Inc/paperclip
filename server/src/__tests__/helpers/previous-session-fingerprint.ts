// Previous release's category composition. Keep independent of the current builder.
import { isPaperclipRunnerProvider, PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES } from "@paperclipai/adapter-utils";
import { sessionAgentRuntimeConfig, sessionEnvironment } from "../../services/heartbeat/session-fingerprint-inputs.js";
import { createEffectiveRunConfigFingerprints, createEffectiveRunConfigSubcategoryFingerprints, type EffectiveRunConfigSecretManifestEntry } from "../../services/effective-run-config-fingerprints.js";
import type { EffectiveRunSessionConfigMetadata, buildEffectiveRunSessionConfigMetadata } from "../../services/heartbeat/workspaces.js";

const RUNNER_EXCLUDED_KEYS = new Set(["sessionContinuity", "timeoutSec", "graceSec"]);
const CODEX_ONLY_KEYS = ["search"] as const;
const parseObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const readNonEmptyString = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 ? value : null;
function omitKeys(value: Record<string, unknown>, keys: Iterable<string>): Record<string, unknown> {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
}

export function paperclipRunnerSessionAdapterConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result = omitKeys(config, RUNNER_EXCLUDED_KEYS);
  const provider = config.provider ?? "codex";
  if (!isPaperclipRunnerProvider(provider)) return result;
  const active = PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES[provider];
  const activeKey = active.configurable ? active.configKey : null;
  const inactivePermissionKeys = Object.values(PAPERCLIP_RUNNER_PERMISSION_CAPABILITIES)
    .flatMap(capability => capability.configurable ? [capability.configKey] : [])
    .filter(key => key !== activeKey);
  return omitKeys(result, [...inactivePermissionKeys, ...(provider === "codex" ? [] : CODEX_ONLY_KEYS)]);
}


function sanitizeSecretManifestForConfigFingerprint(
  manifest: readonly EffectiveRunConfigSecretManifestEntry[],
) {
  return manifest.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      configPath: readNonEmptyString(record.configPath) ?? "",
      envKey: readNonEmptyString(record.envKey),
      secretId: readNonEmptyString(record.secretId) ?? "",
      bindingId: readNonEmptyString(record.bindingId),
      version:
        typeof record.version === "number" && Number.isFinite(record.version)
          ? record.version
          : readNonEmptyString(record.version),
      provider: readNonEmptyString(record.provider),
      providerVersionRef: readNonEmptyString(record.providerVersionRef),
      outcome:
        record.outcome === "success" || record.outcome === "failure"
          ? record.outcome
          : null,
    };
  });
}


export function buildSessionConfigCategoryValues(input: {
  adapterType: string;
  effectiveAdapterConfig: Record<string, unknown>;
  agentRuntimeConfig: unknown;
  instructions: unknown;
  issueOverrides: unknown;
  workspaceConfig: unknown;
  environment: unknown;
  environmentEnv: unknown;
  projectEnv: unknown;
  routineEnv: unknown;
  secretManifest: readonly EffectiveRunConfigSecretManifestEntry[];
  runtimeSkills: unknown;
  agentConfigRevision: unknown;
  agentIdentityKeyId?: string;
  legacyComposition?: boolean;
}) {
  const sanitizedSecretManifest = sanitizeSecretManifestForConfigFingerprint(
    input.secretManifest,
  );
  const workspaceConfig = { ...parseObject(input.workspaceConfig) };
  // issues.updatedAt also advances for comments and status changes. Those are
  // wake deltas, not execution-workspace configuration changes, so including
  // the timestamp here makes every comment invalidate an otherwise reusable
  // task session.
  delete workspaceConfig.issueConfigRevisionAt;
  delete workspaceConfig.projectConfigRevisionAt;
  // This row is runtime state, not requested configuration. It is absent
  // before the first reusable run is realized and present on the next turn;
  // fingerprinting that transition would rotate the native session exactly
  // when the warm runner first becomes reusable. The requested/effective mode,
  // project policy, and issue settings remain the configuration compatibility
  // boundary; the reusable row and its evolving generation are state.
  delete workspaceConfig.existingExecutionWorkspace;
  delete workspaceConfig.reusableExecutionWorkspaceConfig;
  const issueSettings = { ...parseObject(workspaceConfig.issueSettings) };
  if (issueSettings.mode === workspaceConfig.requestedMode) delete issueSettings.mode;
  workspaceConfig.issueSettings = Object.keys(issueSettings).length ? issueSettings : null;
  const legacy = input.legacyComposition === true;
  return {
    adapter: {
      adapterType: input.adapterType,
      ...(input.agentIdentityKeyId ? { agentIdentityKeyId: input.agentIdentityKeyId } : {}),
      ...(legacy ? { agentConfigRevision: input.agentConfigRevision } : {}),
    },
    adapterConfig: legacy || input.adapterType !== "paperclip_runner"
      ? input.effectiveAdapterConfig
      : paperclipRunnerSessionAdapterConfig(input.effectiveAdapterConfig),
    agentRuntimeConfig: legacy ? input.agentRuntimeConfig : sessionAgentRuntimeConfig(input.agentRuntimeConfig),
    instructions: input.instructions,
    issueOverrides: input.issueOverrides,
    workspaceConfig,
    environment: legacy ? input.environment : sessionEnvironment(input.environment),
    envBindings: {
      environment: { env: input.environmentEnv },
      project: { env: input.projectEnv },
      routine: { env: input.routineEnv },
    },
    secrets: sanitizedSecretManifest,
    runtimeSkills: input.runtimeSkills,
  } satisfies Record<string, unknown>;
}


/** The old metadata composition, with an independently supplied instruction snapshot. */
export function previousSessionMetadata(input: Parameters<typeof buildEffectiveRunSessionConfigMetadata>[0], instructions: unknown = null): EffectiveRunSessionConfigMetadata {
  if ((!instructions && (input.effectiveAdapterConfig.instructionsFilePath || input.effectiveAdapterConfig.instructionsRootPath)) || input.managedAiHome || input.managedInstructions) throw new Error("Fixture requires unmanaged instructions and a snapshot for configured paths");
  const effectiveAdapterConfig = { ...input.effectiveAdapterConfig };
  if (input.adapterType === "paperclip_runner" && effectiveAdapterConfig.lifecycleMode === undefined) effectiveAdapterConfig.lifecycleMode = "per_turn";
  const versionedSkills = (value: unknown) => Array.isArray(value) ? value.map(entry => {
    const skill = parseObject(entry);
    return readNonEmptyString(skill.versionId) ? { key: skill.key, runtimeName: skill.runtimeName, versionId: skill.versionId } : entry;
  }) : value;
  if (effectiveAdapterConfig.paperclipRuntimeSkills !== undefined) effectiveAdapterConfig.paperclipRuntimeSkills = versionedSkills(effectiveAdapterConfig.paperclipRuntimeSkills);
  const secretManifest = input.secretManifest ?? [];
  const categoryValues = buildSessionConfigCategoryValues({ ...input, effectiveAdapterConfig, secretManifest, instructions, runtimeSkills: versionedSkills(input.runtimeSkills), agentConfigRevision: input.agentConfigRevision ?? null });
  const categories = Object.keys(categoryValues) as EffectiveRunSessionConfigMetadata["categories"];
  const fingerprints = createEffectiveRunConfigFingerprints({ session: categoryValues, secretManifest });
  return { version: 1, fingerprint: fingerprints.sessionFingerprint.fingerprint, categories, categoryFingerprints: createEffectiveRunConfigSubcategoryFingerprints({ category: "session", value: categoryValues, subcategories: categories, secretManifest }), fingerprints };
}
