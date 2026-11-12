import type { PiBindModel, PiThinkingLevel } from "./pi-bind-protocol.js";

/** Only capability metadata crosses from an agent's provider into our broker. */
export type PiManagedModel = Pick<PiBindModel, "id" | "thinkingLevelMap" | "contextWindow" | "maxTokens" | "reasoning">;
export interface PiBuiltinModelCatalog {
  getBuiltinProviders(): string[];
  getBuiltinModels(provider: string): Array<{ id: string; contextWindow: number; maxTokens: number; reasoning: boolean; thinkingLevelMap?: PiBindModel["thinkingLevelMap"] }>;
}
export const PI_MANAGED_MODEL_DEFAULTS = { contextWindow: 128000, maxTokens: 8192, reasoning: false } as const;
const fields = ["thinkingLevelMap", "contextWindow", "maxTokens", "reasoning"] as const;
const levels: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Prefer the exact managed entry, otherwise the same exact id on another
 * snapshot provider. Never copy routing, credentials, API, or arbitrary fields.
 */
export function configuredPiManagedModel(snapshot: unknown, id: string): PiManagedModel {
  const providers = record(record(snapshot).providers);
  const ordered = [providers.paperclip, ...Object.entries(providers).filter(([name]) => name !== "paperclip").map(([, provider]) => provider)];
  for (const provider of ordered) {
    const models = record(provider).models;
    const found = Array.isArray(models) ? models.find(model => record(model).id === id) : undefined;
    if (!found) continue;
    const entry = record(found);
    const metadata: PiManagedModel = { id };
    for (const field of fields) {
      if (!Object.hasOwn(entry, field)) continue;
      const value = entry[field];
      if ((field === "contextWindow" || field === "maxTokens") && (!Number.isSafeInteger(value) || (value as number) < 1)
        || field === "reasoning" && typeof value !== "boolean"
        || field === "thinkingLevelMap" && (value === null || typeof value !== "object" || Array.isArray(value)
          || Object.entries(value).some(([level, mapped]) => !levels.includes(level as PiThinkingLevel) || mapped !== null && (typeof mapped !== "string" || !mapped.length)))) {
        throw new Error(`Pi configured model has invalid ${field}`);
      }
      Object.assign(metadata, { [field]: structuredClone(value) });
    }
    return metadata;
  }
  return { id };
}

/** Fill only missing fields using Pi's own exact-id catalog. A shared id is
 * usable only when all providers agree on the complete capability tuple.
 * No model-family policy or requested-effort-derived capability is invented.
 */
export function resolvePiManagedModel(model: PiManagedModel, catalog?: PiBuiltinModelCatalog): PiManagedModel & RequiredPiModelLimits {
  const matches = catalog?.getBuiltinProviders().flatMap(provider => catalog.getBuiltinModels(provider).filter(candidate => candidate.id === model.id)) ?? [];
  const first = matches[0];
  const agreed = first && matches.every(candidate => candidate.contextWindow === first.contextWindow
    && candidate.maxTokens === first.maxTokens && candidate.reasoning === first.reasoning);
  const complete = model.contextWindow !== undefined && model.maxTokens !== undefined && model.reasoning !== undefined;
  if (!agreed && !complete) {
    // One bounded, escaped line at resolution, not on every warm broker rotation.
    console.warn(`Pi managed model metadata: ${JSON.stringify(model.id).slice(0, 120)} ${matches.length ? "ambiguous" : "unknown or catalog unavailable"}; using documented defaults for missing fields`);
  }
  const fallback = agreed ? first : PI_MANAGED_MODEL_DEFAULTS;
  // Catalog providers may differ on some levels. Inherit a mapped level only
  // when every exact-id match agrees on it; explicit snapshot caps win per key.
  const thinkingLevelMap: PiBindModel["thinkingLevelMap"] = {};
  if (agreed) for (const level of levels) {
    const mapped = first.thinkingLevelMap?.[level];
    if (mapped !== undefined && matches.every(candidate => candidate.thinkingLevelMap?.[level] === mapped)) thinkingLevelMap[level] = mapped;
  }
  Object.assign(thinkingLevelMap, model.thinkingLevelMap);
  return { ...model, contextWindow: model.contextWindow ?? fallback.contextWindow,
    maxTokens: model.maxTokens ?? fallback.maxTokens, reasoning: model.reasoning ?? fallback.reasoning,
    ...(Object.keys(thinkingLevelMap).length || model.thinkingLevelMap ? { thinkingLevelMap } : {}) };
}
type RequiredPiModelLimits = { contextWindow: number; maxTokens: number; reasoning: boolean };

/** Extension registration requires fields that models.json itself defaults. */
export function piManagedModelRegistration(model: PiBindModel) {
  const metadata = resolvePiManagedModel(model);
  return { ...model, ...metadata, name: model.name ?? model.id, input: model.input ?? ["text" as const],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
