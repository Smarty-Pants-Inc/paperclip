export const PI_RPC_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type PiRpcThinkingLevel = typeof PI_RPC_THINKING_LEVELS[number];
export type PiRpcThinkingLevelMap = Partial<Record<PiRpcThinkingLevel, string | null>>;
export interface PiThinkingCatalogModel {
  id: string;
  provider?: string;
  reasoning: boolean;
  thinkingLevelMap?: PiRpcThinkingLevelMap;
}

export interface PiRpcThinkingSelection {
  level: PiRpcThinkingLevel;
  diagnostic?: "pi_rpc_unknown_model" | "pi_rpc_ambiguous_model";
}

/** Catalog rows the selection rule treats as authority for a model ID. The
 * runtime owns the catalog; a server can ship these rows to a browser so the
 * browser runs selectPiRpcThinkingLevel unchanged without loading Pi. */
export function piThinkingCatalogMatches<Row extends PiThinkingCatalogModel>(model: unknown, catalog: readonly Row[]): Row[] {
  const id = typeof model === "string" ? model.replace(/^paperclip\//u, "") : "";
  return catalog.filter(row => row.id === id || `${row.provider}/${row.id}` === id);
}

/** Pure selection with a runtime-injected catalog; generic/browser consumers do
 * not load Pi. Without catalog authority, use the conservative unknown fallback.
 * Config overrides capabilities, never provider-name policy. */
export function selectPiRpcThinkingLevel(
  configured: unknown,
  model: unknown,
  thinkingLevelMap?: unknown,
  catalog: readonly PiThinkingCatalogModel[] = [],
): PiRpcThinkingSelection {
  if (configured !== undefined) {
    if (typeof configured !== "string" || !PI_RPC_THINKING_LEVELS.includes(configured as PiRpcThinkingLevel)) {
      throw new Error(`Pi RPC thinking level must be one of ${PI_RPC_THINKING_LEVELS.join(", ")}`);
    }
    return { level: configured as PiRpcThinkingLevel };
  }
  if (thinkingLevelMap !== undefined && (thinkingLevelMap === null || typeof thinkingLevelMap !== "object" || Array.isArray(thinkingLevelMap)
    || Object.entries(thinkingLevelMap).some(([key, value]) => !PI_RPC_THINKING_LEVELS.includes(key as PiRpcThinkingLevel) || (value !== null && typeof value !== "string")))) {
    throw new Error("Invalid Pi RPC thinkingLevelMap configuration");
  }
  const configuredMap = thinkingLevelMap as PiRpcThinkingLevelMap | undefined;
  const id = typeof model === "string" ? model.replace(/^paperclip\//u, "") : "";
  const matches = piThinkingCatalogMatches(model, catalog);
  const highest = (row: PiThinkingCatalogModel, fallback = false): PiRpcThinkingLevel => {
    if (!row.reasoning) return "off";
    const map = { ...row.thinkingLevelMap, ...configuredMap };
    const levels = PI_RPC_THINKING_LEVELS.filter(level => (!fallback || (level !== "xhigh" && level !== "max")) && map[level] !== null
      && ((level !== "xhigh" && level !== "max") || map[level] !== undefined));
    const level = levels.at(-1);
    if (!level) throw new Error("Pi RPC model configuration admits no thinking levels");
    return level;
  };
  if (matches.length) {
    const levels = matches.map(row => highest(row));
    if (levels.every(level => level === levels[0])) return { level: levels[0]! };
  }
  // Unknown or conflicting catalogs are not authority to request extended levels.
  // Still honor explicit config exclusions instead of silently overriding a cap.
  return {
    level: highest({ id, reasoning: true }, true),
    diagnostic: matches.length ? "pi_rpc_ambiguous_model" : "pi_rpc_unknown_model",
  };
}

let reportedFallback = false;
/** One bounded, non-identifying diagnostic per process, not one per unknown ID. */
export function resolveDefaultPiRpcThinkingLevel(configured: unknown, model?: unknown, thinkingLevelMap?: unknown, catalog?: readonly PiThinkingCatalogModel[]): PiRpcThinkingLevel {
  const selection = selectPiRpcThinkingLevel(configured, model, thinkingLevelMap, catalog);
  if (selection.diagnostic && !reportedFallback) {
    reportedFallback = true;
    console.warn(`[${selection.diagnostic}] No agreed Pi catalog default; using ${selection.level} thinking (subject to configuration).`);
  }
  return selection.level;
}
