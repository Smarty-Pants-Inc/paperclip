import { describe, expect, it } from "vitest";
import { piRpcThinkingLevelsForModel } from "./pi-rpc-thinking";

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
