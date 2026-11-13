import { describe, expect, it } from "vitest";
import { piRpcAutoThinkingLabel, piRpcResolvedThinkingLevel, piRpcThinkingLevelsForModel } from "./pi-rpc-thinking";
import { CLAUDE_SONNET_4_5_THINKING_CATALOG, GPT_5_5_THINKING_CATALOG } from "./pi-rpc-thinking-catalog.fixture";

describe("Pi RPC model thinking levels", () => {
  it("passes through every catalog-admitted level, including Claude max", () => {
    expect(piRpcThinkingLevelsForModel("paperclip/claude-opus-5-5", {
      id: "paperclip/claude-opus-5-5", family: "Claude", thinkingLevels: ["off", "high", "xhigh", "max"],
    })).toEqual(["off", "high", "xhigh", "max"]);
  });
  it("uses Pi's catalog levels without adding a provider-specific clamp", () => {
    expect(piRpcThinkingLevelsForModel("paperclip/claude-opus-5-5")).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(piRpcThinkingLevelsForModel("paperclip/gpt-6", { id: "paperclip/gpt-6", thinkingLevels: ["max"] })).toEqual(["max"]);
  });
});

// Regression: model names/families must not override the catalog/config policy.
describe("native Pi catalog thinking capabilities", () => {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  it.each(["gateway/claude-opus-5-5", "gateway/claude-fable-5-2", "gateway/alias", "gateway/gpt-6-astra"])("offers catalog-supported max unchanged for %s", id => {
    expect(piRpcThinkingLevelsForModel(id, { id, family: "Claude", thinkingLevels: ["max", "off", "xhigh"] })).toEqual(["off", "xhigh", "max"]);
  });
  it("hides max only when catalog/config excludes it", () => {
    const id = "gateway/claude-opus-5-5";
    expect(piRpcThinkingLevelsForModel(id, { id, thinkingLevels: ["off", "xhigh"] })).toEqual(["off", "xhigh"]);
    expect(piRpcThinkingLevelsForModel(id, { id, thinkingLevels: [] })).toEqual([]);
  });
  it("does not infer a cap from a model name or family without catalog levels", () => {
    expect(piRpcThinkingLevelsForModel("gateway/claude-opus-5-5")).toEqual(levels);
    expect(piRpcThinkingLevelsForModel("gateway/alias", { id: "gateway/alias", family: "Claude" })).toEqual(levels);
  });
});

// Auto label: the shared runtime rule (selectPiRpcThinkingLevel) over server-shipped catalog rows.
describe("native Pi Auto thinking label", () => {
  it("names the runtime default for a catalog-known model", () => {
    expect(piRpcAutoThinkingLabel(piRpcResolvedThinkingLevel("paperclip/gpt-5.5", { thinkingCatalog: GPT_5_5_THINKING_CATALOG }))).toBe("Auto (Extra High)");
    expect(piRpcAutoThinkingLabel(piRpcResolvedThinkingLevel("claude-sonnet-4-5", { thinkingCatalog: CLAUDE_SONNET_4_5_THINKING_CATALOG }))).toBe("Auto (High)");
  });
  it("keeps plain Auto when the catalog does not know the model or the server sent no rows", () => {
    expect(piRpcAutoThinkingLabel(piRpcResolvedThinkingLevel("paperclip/not-a-model", { thinkingCatalog: [] }))).toBe("Auto");
    expect(piRpcAutoThinkingLabel(piRpcResolvedThinkingLevel("paperclip/gpt-5.5", undefined))).toBe("Auto");
    expect(piRpcAutoThinkingLabel(piRpcResolvedThinkingLevel("paperclip/gpt-5.5", { id: "paperclip/gpt-5.5", label: "GPT" } as never))).toBe("Auto");
  });
  it("keeps plain Auto when catalog rows disagree (runtime uses its conservative fallback)", () => {
    expect(piRpcResolvedThinkingLevel("gpt-5.5", { thinkingCatalog: [...GPT_5_5_THINKING_CATALOG, { id: "gpt-5.5", provider: "other", reasoning: false }] })).toBeUndefined();
  });
  it("applies an agent thinkingLevelMap cap and an agent's configured level exactly as the runtime does", () => {
    expect(piRpcResolvedThinkingLevel("gpt-5.5", { thinkingCatalog: GPT_5_5_THINKING_CATALOG }, undefined, { xhigh: null })).toBe("high");
    expect(piRpcResolvedThinkingLevel("gpt-5.5", { thinkingCatalog: GPT_5_5_THINKING_CATALOG }, "low")).toBe("low");
    expect(piRpcResolvedThinkingLevel("gpt-5.5", { thinkingCatalog: GPT_5_5_THINKING_CATALOG }, "bogus")).toBeUndefined();
  });
});
