import { describe, expect, it } from "vitest";
import { PI_NATIVE_THINKING_LEVELS } from "../../pi-native-config.js";
import { acknowledgeChildSelection, validateChildSelection, type ChildModelCatalog } from "./selection.js";

export const selection = (model = "neutral/reasoner:max") => ({
  selectionId: "selection-1", roleId: "reviewer", roleDigest: "role-digest",
  paretoRevision: "pareto-2026-11-12", paretoChoice: "quality-frontier",
  complexity: "cross-component", rationale: "Independent review", budget: { tokens: 2000 }, model,
});
export const catalog: ChildModelCatalog = model => ({
  "neutral/reasoner": { provider: "neutral", id: "reasoner", family: "other" as const, thinkingLevels: PI_NATIVE_THINKING_LEVELS },
  "anthropic/claude-test": { provider: "anthropic", id: "claude-test", family: "claude" as const, thinkingLevels: PI_NATIVE_THINKING_LEVELS },
  "alias/reviewer": { provider: "gateway", id: "claude-test", family: "claude" as const, thinkingLevels: PI_NATIVE_THINKING_LEVELS },
}[model]);

describe("F085 per-leaf explicit selection (trust boundary)", () => {
  it("requires Pareto choice complexity budget and explicit pair for every leaf", () => {
    for (const leaf of ["direct", "review", "fan-out", "retry"]) {
      for (const field of ["selectionId", "roleId", "roleDigest", "paretoRevision", "paretoChoice", "complexity", "rationale", "budget", "model"]) {
        const missing: Record<string, unknown> = { ...selection(), leaf };
        delete missing[field];
        expect(() => validateChildSelection(missing, catalog), `${leaf}/${field}`).toThrow(field);
      }
    }
    expect(() => validateChildSelection(undefined, catalog)).toThrow(/selection/i);
    for (const model of [undefined, "neutral/reasoner", "reasoner:max", "neutral/reasoner:MAX", "neutral/reasoner:", "neutral/reasoner:max\n"]) {
      expect(() => validateChildSelection({ ...selection(), model }, catalog)).toThrow(/model|explicit/i);
    }
  });

  it("passes configured effort through for Claude, aliases and other physical models", () => {
    expect(validateChildSelection(selection("anthropic/claude-test:max"), catalog)).toMatchObject({ effort: "max", effectiveModel: "anthropic/claude-test" });
    expect(validateChildSelection(selection("alias/reviewer:max"), catalog)).toMatchObject({ effort: "max", effectiveModel: "gateway/claude-test" });
    expect(validateChildSelection(selection("neutral/reasoner:max"), catalog)).toMatchObject({ effort: "max", effectiveModel: "neutral/reasoner" });
    expect(validateChildSelection(selection("anthropic/claude-test:xhigh"), catalog)).toMatchObject({ effort: "xhigh" });
    expect(() => validateChildSelection(selection("unknown/model:high"), catalog)).toThrow(/physical|catalog/i);
    expect(() => validateChildSelection(selection(), () => ({ provider: "n", id: "m", family: "other", thinkingLevels: ["high"] }))).toThrow(/support/i);
  });

  it("does not accept ignored thinking or stale parent environment as an ACK", () => {
    expect(() => validateChildSelection({ ...selection(), model: "neutral/reasoner", thinking: "high" }, catalog)).toThrow(/explicit|model/);
    const admitted = validateChildSelection(selection(), catalog);
    const state = { sessionId: "child-session", model: { provider: "neutral", id: "reasoner" }, thinkingLevel: "max" };
    expect(acknowledgeChildSelection(admitted, state)).toMatchObject({ childSessionId: "child-session", effectiveModel: "neutral/reasoner", effort: "max" });
    for (const mismatch of [
      { ...state, thinkingLevel: "high" },
      { ...state, model: { provider: "parent", id: "reasoner" } },
      { ...state, sessionId: "" },
      { ...state, model: undefined },
    ]) expect(() => acknowledgeChildSelection(admitted, mismatch)).toThrow(/child|effective/i);
  });

  it("preserves exact nested and tagged model IDs using shared native config validation", () => {
    expect(validateChildSelection(selection("local/vendor/model:tag:high"), () => ({ provider: "local", id: "vendor/model:tag", family: "other", thinkingLevels: ["high"] }))).toMatchObject({ requestedModel: "local/vendor/model:tag", effort: "high" });
  });

  it("snapshots decision evidence instead of retaining mutable parent data", () => {
    const input = selection();
    const admitted = validateChildSelection(input, catalog);
    input.budget.tokens = 999;
    input.complexity = "changed";
    expect(admitted.budget).toEqual({ tokens: 2000 });
    expect(admitted.complexity).toBe("cross-component");
    expect(Object.isFrozen(admitted)).toBe(true);
    expect(Object.isFrozen(admitted.budget)).toBe(true);
    expect(() => validateChildSelection({ ...selection(), budget: { value: undefined } }, catalog)).toThrow(/budget/);
  });
});
