import type { companySecretBindings, userSecretDeclarations } from "@paperclipai/db";
import { stableHash } from "./tool-catalog-hash.js";

type Binding = typeof companySecretBindings.$inferSelect | typeof userSecretDeclarations.$inferSelect;

/** Launch-relevant binding content. Saves may replace a row with a new ID;
 * labels and timestamps are not run inputs. Keep the semantic target so the
 * dispatch fence can lock its current row, including a same-content replacement. */
export function runtimeSecretBindingConfiguration(binding: Binding) {
  const company = "secretId" in binding;
  const target = { targetType: binding.targetType, targetId: binding.targetId, configPath: binding.configPath };
  return {
    kind: company ? "company" as const : "user" as const,
    ...target,
    fingerprint: stableHash({ ...target, versionSelector: binding.versionSelector, required: binding.required,
      ...(company ? { secretId: binding.secretId, projectionClass: binding.projectionClass, projectionAllowlistKey: binding.projectionAllowlistKey }
        : { userSecretDefinitionId: binding.userSecretDefinitionId, envKey: binding.envKey, allowMissingOverride: binding.allowMissingOverride }),
    }),
  };
}
