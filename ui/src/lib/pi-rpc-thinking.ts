import { PAPERCLIP_RUNNER_PI_RPC_THINKING_LEVELS, selectPiRpcThinkingLevel, type AdapterModel } from "@paperclipai/adapter-utils";

export type PiRpcModelCapabilities = Pick<AdapterModel, "id" | "thinkingLevels" | "family" | "thinkingCatalog">;

/** Catalog capabilities narrow native Pi choices; admission remains server-owned. */
export function piRpcThinkingLevelsForModel(_model: string, row?: PiRpcModelCapabilities): readonly string[] {
  return PAPERCLIP_RUNNER_PI_RPC_THINKING_LEVELS.filter(level =>
    !row?.thinkingLevels || row.thinkingLevels.includes(level));
}

export const PI_RPC_THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max",
};

export function piRpcThinkingLabel(level: string): string {
  return PI_RPC_THINKING_LABELS[level] ?? level;
}

/**
 * The level the runtime will run at when no thinking level is chosen here.
 * Runs the shared runtime rule (adapter-utils selectPiRpcThinkingLevel) over the
 * catalog rows the server ships with the model; never re-derives the rule.
 * Undefined when the catalog does not know the model (the runtime's conservative
 * fallback is not catalog authority) or the configuration is invalid.
 */
export function piRpcResolvedThinkingLevel(model: string, row?: Pick<AdapterModel, "thinkingCatalog">,
  configured?: unknown, thinkingLevelMap?: unknown): string | undefined {
  try {
    const selection = selectPiRpcThinkingLevel(configured ?? undefined, model, thinkingLevelMap ?? undefined, row?.thinkingCatalog ?? []);
    return selection.diagnostic ? undefined : selection.level;
  } catch {
    return undefined;
  }
}

/** "Auto (Extra High)" when the resolved level is known, else the plain fallback. */
export function piRpcAutoThinkingLabel(resolved: string | undefined, fallback = "Auto"): string {
  return resolved ? `Auto (${piRpcThinkingLabel(resolved)})` : fallback;
}
