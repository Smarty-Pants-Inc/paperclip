import { describe, expect, it, vi } from "vitest";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";

const builtinModels = getBuiltinProviders().flatMap(provider => getBuiltinModels(provider));
import { resolveDefaultPiRpcThinkingLevel, selectPiRpcThinkingLevel, type PiThinkingCatalogModel } from "./pi-rpc-default-thinking.js";

// Keep reason: configuration/capability mismatch at the native runtime boundary.
describe("Pi RPC default thinking", () => {
  it.each([
    ["paperclip/claude-opus-5-5", undefined, "max"],
    ["claude-opus-5-5", undefined, "max"],
    ["anthropic/claude-opus-5-5", undefined, "max"],
    ["paperclip/claude-opus-5-5", "low", "low"],
    ["paperclip/claude-opus-5-5", "off", "off"],
    ["paperclip/gpt-4o", undefined, "off"],
    ["paperclip/unknown-not-a-real-model", undefined, "high"],
    ["paperclip/CLAUDE-OPUS-5-5", undefined, "high"],
    ["paperclip/claude-opus-5-5-suffix", undefined, "high"],
  ] as const)("selects %s configured=%s -> %s from the real Pi 1.5.2 catalog", (model, configured, level) => {
    expect(selectPiRpcThinkingLevel(configured, model, undefined, builtinModels).level).toBe(level);
  });

  it.each([
    [{}, "max"],
    [{ max: null }, "xhigh"],
    [{ max: null, xhigh: null }, "high"],
    [{ max: "high" }, "max"],
  ] as const)("uses only config-map admission, not provider policy: %j -> %s", (map, level) => {
    expect(selectPiRpcThinkingLevel(undefined, "paperclip/claude-opus-5-5", map, builtinModels)).toEqual({ level });
    expect(selectPiRpcThinkingLevel("low", "paperclip/claude-opus-5-5", map, builtinModels)).toEqual({ level: "low" });
  });

  const row = (map = {}): PiThinkingCatalogModel => ({ id: "reasoner", reasoning: true, thinkingLevelMap: map });
  it.each([
    [[row()], "high", undefined],
    [[row({ xhigh: "xhigh" })], "xhigh", undefined],
    [[row({ max: "max" }), row({ max: "max" })], "max", undefined],
    [[row({ max: "max" }), row()], "high", "pi_rpc_ambiguous_model"],
    [[{ id: "reasoner", reasoning: false }], "off", undefined],
    [[], "high", "pi_rpc_unknown_model"],
  ] as const)("requires all exact matches to agree (%j)", (catalog, level, diagnostic) => {
    expect(selectPiRpcThinkingLevel(undefined, "paperclip/reasoner", undefined, catalog)).toEqual({ level, ...(diagnostic ? { diagnostic } : {}) });
  });

  it("does not mutate catalog or config, and refuses an empty configured capability set", () => {
    const map = Object.freeze({ max: null, xhigh: null } as const);
    const catalog = Object.freeze([Object.freeze(row({ max: "max" }))]);
    expect(selectPiRpcThinkingLevel(undefined, "reasoner", map, catalog)).toEqual({ level: "high" });
    expect(catalog[0].thinkingLevelMap).toEqual({ max: "max" });
    expect(() => selectPiRpcThinkingLevel(undefined, "reasoner", Object.fromEntries(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(level => [level, null])), catalog)).toThrow(/no thinking levels/);
    expect(() => selectPiRpcThinkingLevel("ultra", "reasoner", undefined, catalog)).toThrow(/thinking level/);
  });

  it("does not infer catalog capabilities when the runtime supplies no catalog", () => {
    expect(selectPiRpcThinkingLevel(undefined, "claude-opus-5-5")).toEqual({ level: "high", diagnostic: "pi_rpc_unknown_model" });
    expect(selectPiRpcThinkingLevel("low", "claude-opus-5-5")).toEqual({ level: "low" });
  });

  it("honors config exclusions on unknown models without guessing extended support", () => {
    expect(selectPiRpcThinkingLevel(undefined, "unknown", { high: null })).toEqual({ level: "medium", diagnostic: "pi_rpc_unknown_model" });
    expect(selectPiRpcThinkingLevel(undefined, "unknown", { max: "max" })).toEqual({ level: "high", diagnostic: "pi_rpc_unknown_model" });
    expect(selectPiRpcThinkingLevel("low", "unknown", { low: null })).toEqual({ level: "low" });
    for (const map of [null, [], "invalid", { max: 1 }, { ultra: null }]) {
      expect(() => selectPiRpcThinkingLevel(undefined, "reasoner", map)).toThrow(/thinkingLevelMap/);
    }
  });

  it("emits at most one bounded diagnostic, without reflecting arbitrary model IDs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let index = 0; index < 10; index++) expect(resolveDefaultPiRpcThinkingLevel(undefined, `secret-${index}-${"x".repeat(10000)}`)).toBe("high");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0]).length).toBeLessThan(200);
      expect(String(warn.mock.calls[0][0])).not.toContain("secret-");
    } finally { warn.mockRestore(); }
  });
});
