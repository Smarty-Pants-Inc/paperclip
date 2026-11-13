import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { digest, isPiModelCompat, piModelSamplingOverrides, PI_MODEL_ROUTING_FIELDS, type PiBindModel, type PiBindProvider, type PiThinkingLevel } from "./pi-bind-protocol.js";

/** The whole model definition, with upstream routing/auth removed. */
export type PiManagedModel = PiBindModel;
type Diagnose = (message: string) => void;
const diagnose: Diagnose = message => console.warn(`Pi managed model metadata: ${message}`);
const strippedSamplingDiagnostic = "stripped protected sampling key ";
function reportDiagnostics(messages: Set<string>, warn: Diagnose): void {
  // Retain the existing bounded summary for capability fallbacks, but never
  // truncate away a stripped-key diagnostic or combine away its identity.
  const summary = [...messages].filter(message => !message.startsWith(strippedSamplingDiagnostic));
  if (summary.length) warn(summary.sort((a, b) => Number(b.startsWith("compat fallback")) - Number(a.startsWith("compat fallback"))).join("; ").slice(0, 220));
  for (const message of messages) if (message.startsWith(strippedSamplingDiagnostic)) warn(message.slice(0, 220));
}

/** Capture before projecting HOME/PI_CODING_AGENT_DIR into a managed sandbox. */
export function originalPiModelsFile(environment: NodeJS.ProcessEnv): string {
  return join(environment.PI_CODING_AGENT_DIR ?? join(environment.HOME ?? process.env.HOME ?? homedir(), ".pi", "agent"), "models.json");
}

/** One definition builder for native startup, snapshot helpers and ACPX children.
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
    reportDiagnostics(messages, input.warn ?? diagnose);
  }
}
export interface PiBuiltinModelCatalog {
  getBuiltinProviders(): string[];
  getBuiltinModels(provider: string): Array<PiBindModel & { api?: string; contextWindow: number; maxTokens: number; reasoning: boolean }>;
}
export const PI_MANAGED_MODEL_DEFAULTS = { contextWindow: 128000, maxTokens: 8192, reasoning: true } as const;
const fields = ["thinkingLevelMap", "contextWindow", "maxTokens", "reasoning"] as const;
const levels: PiThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// Negative routing list, deliberately NOT a capability allowlist. New Pi model
// metadata survives without another Paperclip patch. Provider routing is built
// independently by createPiProviderBinding; none is inherited from the source.
const apiShapedField = (key: string) => key === "compat" || key.startsWith("samplingParams");
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function piManagedModelDefinition(model: PiBindModel, warn: Diagnose = diagnose): PiManagedModel {
  const result = structuredClone(Object.fromEntries(Object.entries(model).filter(([key]) => !PI_MODEL_ROUTING_FIELDS.has(key)))) as PiManagedModel;
  for (const { parameters, key, path } of piModelSamplingOverrides(result)) {
    delete parameters[key];
    // Keys/paths only, never request values (which can contain credentials).
    const message = `${strippedSamplingDiagnostic}${JSON.stringify(key)} at ${JSON.stringify(path)}`;
    // Keep long paths distinct before operation-local deduplication.
    warn(message.length <= 220 ? message : `${message.slice(0, 196)}...#${digest(path).slice(0, 20)}`);
  }
  return result;
}
function forApi(model: PiBindModel, sourceApi: unknown, api?: PiBindProvider["api"], warn: Diagnose = diagnose): PiManagedModel {
  const result = piManagedModelDefinition(model, warn);
  if (api === undefined || sourceApi !== api) {
    if (Object.keys(result).some(apiShapedField)) warn("source API mismatch; skipping compat and API-shaped fields");
    for (const field of Object.keys(result).filter(apiShapedField)) delete result[field];
  }
  return result;
}

/** Prefer the exact managed entry, otherwise the same exact id on another
 * provider. Preserve its entire definition except routing and foreign dialects.
 */
export function configuredPiManagedModel(snapshot: unknown, id: string, api?: PiBindProvider["api"], warn: Diagnose = diagnose): PiManagedModel {
  const providers = record(record(snapshot).providers);
  const ordered = [providers.paperclip, ...Object.entries(providers).filter(([name]) => name !== "paperclip").map(([, provider]) => provider)];
  for (const provider of ordered) {
    const models = record(provider).models;
    const found = Array.isArray(models) ? models.find(model => record(model).id === id) : undefined;
    if (!found) continue;
    const entry = record(found), source = record(provider);
    for (const field of fields) {
      if (!Object.hasOwn(entry, field)) continue;
      const value = entry[field];
      if ((field === "contextWindow" || field === "maxTokens") && (!Number.isSafeInteger(value) || (value as number) < 1)
        || field === "reasoning" && typeof value !== "boolean"
        || field === "thinkingLevelMap" && (value === null || typeof value !== "object" || Array.isArray(value)
          || Object.entries(value).some(([level, mapped]) => !levels.includes(level as PiThinkingLevel) || mapped !== null && (typeof mapped !== "string" || !mapped.length)))) {
        throw new Error(`Pi configured model has invalid ${field}`);
      }
    }
    for (const candidate of [source, entry]) {
      if (Object.hasOwn(candidate, "compat") && !isPiModelCompat(candidate.compat)) throw new Error("Pi configured model has invalid compat");
    }
    const metadata = forApi(entry as PiBindModel, entry.api ?? source.api, api, warn);
    const input = entry.input ?? source.input;
    if (input !== undefined) {
      if (!Array.isArray(input) || !input.length || input.some(value => value !== "text" && value !== "image")) throw new Error("Pi configured model has invalid input");
      metadata.input = structuredClone(input);
    }
    if ((entry.api ?? source.api) === api && api !== undefined && (Object.hasOwn(source, "compat") || Object.hasOwn(entry, "compat"))) {
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
    } else if (source.compat !== undefined && !Object.hasOwn(entry, "compat")) warn("source API mismatch; skipping compat");
    if (!isPiModelCompat(metadata)) throw new Error("Pi configured model has invalid JSON metadata");
    return metadata;
  }
  return { id };
}

/** The agent snapshot wins per field (and thinking-map key). The original
 * user's config is an optional read-only fallback, never a routing/auth source.
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
    reportDiagnostics(messages, warn);
  }
}

/** Inherit the whole exact-id catalog definition, preferring the canonical API
 * owner. A foreign-API entry can supply capabilities, never dialect metadata.
 * Explicit config fields (including false, [] and {}) continue to win.
 */
export function resolvePiManagedModel(model: PiManagedModel, catalog?: PiBuiltinModelCatalog, api?: PiBindProvider["api"], warn: Diagnose = diagnose): PiManagedModel & RequiredPiModelLimits {
  const diagnostics: string[] = [];
  const matches = catalog?.getBuiltinProviders().flatMap(provider => catalog.getBuiltinModels(provider).filter(candidate => candidate.id === model.id)) ?? [];
  const owner = api === "anthropic-messages" ? "anthropic" : "openai";
  const canonical = api === undefined ? undefined : catalog?.getBuiltinModels(owner).find(entry => entry.id === model.id && entry.api === api);
  const selected = canonical ?? matches[0];
  const fallback: Partial<PiManagedModel> = selected ? forApi(selected, selected.api, api, message => {
    if (message.startsWith(strippedSamplingDiagnostic)) warn(message);
  }) : {};
  // Only the canonical API owner may supply catalog dialects (aa685317).
  if (!canonical) for (const field of Object.keys(fallback).filter(apiShapedField)) delete fallback[field];
  if (model.compat !== undefined && !isPiModelCompat(model.compat)) throw new Error("Pi configured model has invalid compat");
  if (model.compat === undefined && api !== undefined) {
    if (canonical?.compat !== undefined && isPiModelCompat(canonical.compat)) diagnostics.push(`compat fallback copied from canonical provider ${owner}`);
    else diagnostics.push(`canonical provider ${owner}: no exact API/id compat; skipped`);
  }
  const definition = { ...fallback, ...piManagedModelDefinition(model, warn) };
  const complete = model.contextWindow !== undefined && model.maxTokens !== undefined && model.reasoning !== undefined;
  const thinkingLevelMap: PiBindModel["thinkingLevelMap"] = {};
  if (!selected && !complete) {
    diagnostics.push("unknown or catalog unavailable; using missing-field defaults");
    for (const level of levels) thinkingLevelMap[level] = level;
  }
  Object.assign(thinkingLevelMap, fallback.thinkingLevelMap, model.thinkingLevelMap);
  if (definition.input === undefined) {
    definition.input = ["text"];
    diagnostics.unshift("image capability unknown; using text-only input");
  }
  if (diagnostics.length) warn(diagnostics.join("; "));
  return { ...definition, contextWindow: definition.contextWindow ?? PI_MANAGED_MODEL_DEFAULTS.contextWindow,
    maxTokens: definition.maxTokens ?? PI_MANAGED_MODEL_DEFAULTS.maxTokens, reasoning: definition.reasoning ?? PI_MANAGED_MODEL_DEFAULTS.reasoning,
    ...(Object.keys(thinkingLevelMap).length || model.thinkingLevelMap ? { thinkingLevelMap } : {}) };
}
type RequiredPiModelLimits = { contextWindow: number; maxTokens: number; reasoning: boolean };

/** Extension registration requires fields that models.json itself defaults. */
export function piManagedModelRegistration(model: PiBindModel) {
  const metadata = resolvePiManagedModel(model);
  return { ...metadata, name: metadata.name ?? metadata.id, input: metadata.input ?? ["text" as const],
    cost: metadata.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}
