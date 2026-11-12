import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPiModelCompat, type PiBindModel, type PiBindProvider, type PiThinkingLevel } from "./pi-bind-protocol.js";

/** Only capability metadata crosses from an agent's provider into our broker. */
export type PiManagedModel = Pick<PiBindModel, "id" | "thinkingLevelMap" | "contextWindow" | "maxTokens" | "reasoning" | "compat">;
type Diagnose = (message: string) => void;
const diagnose: Diagnose = message => console.warn(`Pi managed model metadata: ${message}`);

/** Capture before projecting HOME/PI_CODING_AGENT_DIR into a managed sandbox. */
export function originalPiModelsFile(environment: NodeJS.ProcessEnv): string {
  return join(environment.PI_CODING_AGENT_DIR ?? join(environment.HOME ?? process.env.HOME ?? homedir(), ".pi", "agent"), "models.json");
}

/** One capability builder for native startup, snapshot helpers and ACPX children.
 * Diagnostics are operation-local; warm binds reuse the resulting descriptor.
 */
export async function buildPiManagedModel(input: {
  snapshot: unknown; id: string; api: PiBindProvider["api"];
  originalModelsFile?: string; catalog?: PiBuiltinModelCatalog; warn?: Diagnose;
}): Promise<PiManagedModel & RequiredPiModelLimits> {
  const messages = new Set<string>();
  try {
    const configured = await configuredPiManagedModelSources(input.snapshot, input.id, input.originalModelsFile, input.api, message => messages.add(message));
    return resolvePiManagedModel(configured, input.catalog, input.api, message => messages.add(message));
  } finally {
    if (messages.size) (input.warn ?? diagnose)([...messages].sort((a, b) => Number(b.startsWith("compat fallback")) - Number(a.startsWith("compat fallback"))).join("; ").slice(0, 220));
  }
}
export interface PiBuiltinModelCatalog {
  getBuiltinProviders(): string[];
  getBuiltinModels(provider: string): Array<{ id: string; api?: string; contextWindow: number; maxTokens: number; reasoning: boolean; thinkingLevelMap?: PiBindModel["thinkingLevelMap"]; compat?: unknown }>;
}
export const PI_MANAGED_MODEL_DEFAULTS = { contextWindow: 128000, maxTokens: 8192, reasoning: true } as const;
const fields = ["thinkingLevelMap", "contextWindow", "maxTokens", "reasoning"] as const;
const levels: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Prefer the exact managed entry, otherwise the same exact id on another
 * snapshot provider. Never copy routing, credentials, API, or arbitrary fields.
 */
export function configuredPiManagedModel(snapshot: unknown, id: string, api?: PiBindProvider["api"], warn: Diagnose = diagnose): PiManagedModel {
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
    const source = record(provider);
    for (const candidate of [source, entry]) {
      if (Object.hasOwn(candidate, "compat") && !isPiModelCompat(candidate.compat)) throw new Error("Pi configured model has invalid compat");
    }
    if (Object.hasOwn(source, "compat") || Object.hasOwn(entry, "compat")) {
      if (api === undefined || (entry.api ?? source.api) !== api) {
        warn("source API mismatch; skipping compat");
      } else {
        const base = source.compat as PiBindModel["compat"];
        const override = entry.compat as PiBindModel["compat"];
        // Match selected Pi's provider-composer: four nested values merge ONE
        // level (even arrays), all other fields use a plain shallow override.
        const merged = { ...base, ...override };
        if (override) for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"]) {
          const baseValue = base?.[key]; const overrideValue = override[key];
          if ((typeof baseValue === "object" && baseValue !== null) || (typeof overrideValue === "object" && overrideValue !== null)) {
            merged[key] = { ...Object(baseValue), ...Object(overrideValue) };
          }
        }
        metadata.compat = structuredClone(merged);
      }
    }
    return metadata;
  }
  return { id };
}

/** The agent snapshot wins per capability (and thinking-map key). The original
 * user's config is an optional, read-only fallback, never a routing/auth source.
 * Keep the strict agent-snapshot validation; a bad user file cannot refuse a run.
 */
export async function configuredPiManagedModelSources(snapshot: unknown, id: string, originalModelsFile?: string, api?: PiBindProvider["api"], warn: Diagnose = diagnose): Promise<PiManagedModel> {
  const messages = new Set<string>();
  const collect: Diagnose = message => { messages.add(message); };
  try {
    const primary = configuredPiManagedModel(snapshot, id, api, collect);
    if (!originalModelsFile) return primary;
    let fallback: PiManagedModel;
    try {
      const text = await readFile(originalModelsFile, "utf8");
      if (text.length > 60 * 1024) throw new Error("oversized user config");
      const user: unknown = JSON.parse(text);
      if (!user || typeof user !== "object" || Array.isArray(user)) throw new Error("invalid user config");
      fallback = configuredPiManagedModel(user, id, api, collect);
    } catch {
      collect("original user models.json invalid/unavailable; skipped");
      return primary;
    }
    return { ...fallback, ...primary,
      ...(fallback.thinkingLevelMap || primary.thinkingLevelMap ? { thinkingLevelMap: { ...fallback.thinkingLevelMap, ...primary.thinkingLevelMap } } : {}) };
  } finally {
    if (messages.size) warn([...messages].join("; "));
  }
}

/** Fill only missing fields using Pi's own exact-id catalog. A shared id is
 * usable only when all providers agree on the complete capability tuple.
 * No model-family policy or requested-effort-derived capability is invented.
 */
export function resolvePiManagedModel(model: PiManagedModel, catalog?: PiBuiltinModelCatalog, api?: PiBindProvider["api"], warn: Diagnose = diagnose): PiManagedModel & RequiredPiModelLimits {
  const diagnostics: string[] = [];
  const matches = catalog?.getBuiltinProviders().flatMap(provider => catalog.getBuiltinModels(provider).filter(candidate => candidate.id === model.id)) ?? [];
  const first = matches[0];
  const agreed = first && matches.every(candidate => candidate.contextWindow === first.contextWindow
    && candidate.maxTokens === first.maxTokens && candidate.reasoning === first.reasoning);
  const complete = model.contextWindow !== undefined && model.maxTokens !== undefined && model.reasoning !== undefined;
  if (!agreed && !complete) {
    // One bounded, escaped line at resolution, not on every warm broker rotation.
    diagnostics.push(`${matches.length ? "ambiguous catalog" : "unknown or catalog unavailable"}; using missing-field defaults`);
  }
  const fallback = agreed ? first : PI_MANAGED_MODEL_DEFAULTS;
  // Catalog providers may differ on some levels. Inherit a mapped level only
  // when every exact-id match agrees on it; explicit snapshot caps win per key.
  const thinkingLevelMap: PiBindModel["thinkingLevelMap"] = {};
  // Preserve pre-catalog thinking support only for unresolved fallback fields.
  if (!agreed && !complete) for (const level of levels) thinkingLevelMap[level] = level;
  if (agreed) for (const level of levels) {
    const mapped = first.thinkingLevelMap?.[level];
    if (mapped !== undefined && matches.every(candidate => candidate.thinkingLevelMap?.[level] === mapped)) thinkingLevelMap[level] = mapped;
  }
  Object.assign(thinkingLevelMap, model.thinkingLevelMap);
  let compat = model.compat;
  if (compat !== undefined && !isPiModelCompat(compat)) throw new Error("Pi configured model has invalid compat");
  if (compat === undefined && api !== undefined) {
    const owner = api === "anthropic-messages" ? "anthropic" : "openai";
    const candidate = catalog?.getBuiltinModels(owner).find(entry => entry.id === model.id && entry.api === api);
    if (candidate && isPiModelCompat(candidate.compat)) {
      compat = structuredClone(candidate.compat);
      diagnostics.unshift(`compat fallback copied from canonical provider ${owner}`);
    } else {
      diagnostics.push(`canonical provider ${owner}: no exact API/id compat; skipped`);
    }
  }
  if (diagnostics.length) warn(diagnostics.join("; "));
  return { ...model, ...(compat === undefined ? {} : { compat: structuredClone(compat) }), contextWindow: model.contextWindow ?? fallback.contextWindow,
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
