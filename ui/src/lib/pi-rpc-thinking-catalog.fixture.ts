import type { PiThinkingCatalogModel } from "@paperclipai/adapter-utils";

/** Real Pi 1.5.2 builtin catalog rows (PI_RPC_BUILTIN_THINKING_CATALOG) that the
 * shared rule matches for gpt-5.5, as the server ships them in `thinkingCatalog`.
 * Every row agrees on xhigh, so the runtime default is "xhigh". */
export const GPT_5_5_THINKING_CATALOG: PiThinkingCatalogModel[] = [
  { id: "gpt-5.5", provider: "azure", reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh" } },
  { id: "gpt-5.5", provider: "cloudflare-ai-gateway", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } },
  { id: "gpt-5.5", provider: "openai", reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } },
  { id: "gpt-5.5", provider: "opencode", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null } },
];

/** Real rows for claude-sonnet-4-5: reasoning without xhigh/max in the map, so the default is "high". */
export const CLAUDE_SONNET_4_5_THINKING_CATALOG: PiThinkingCatalogModel[] = [
  { id: "claude-sonnet-4-5", provider: "anthropic", reasoning: true },
  { id: "claude-sonnet-4-5", provider: "opencode", reasoning: true },
];
