import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredPiManagedModel, resolvePiManagedModel, piManagedModelRegistration } from "./pi-managed-model.js";

// Keep: snapshot-to-broker trust boundary and the real H8C metadata-loss catch.
const catalog = {
  getBuiltinProviders: () => ["one", "two"],
  getBuiltinModels: (provider: string) => [
    { id: "known", contextWindow: 1000000, maxTokens: 128000, reasoning: true },
    { id: "ambiguous-context", contextWindow: provider === "one" ? 1000000 : 200000, maxTokens: 128000, reasoning: true },
    { id: "ambiguous-tokens", contextWindow: 1000000, maxTokens: provider === "one" ? 128000 : 8192, reasoning: true },
    { id: "ambiguous-reasoning", contextWindow: 1000000, maxTokens: 128000, reasoning: provider === "one" },
  ],
};
afterEach(() => vi.restoreAllMocks());

describe("managed Pi model capabilities", () => {
  it("copies only capability fields from the same id on another snapshot provider", () => {
    const metadata = { id: "known", thinkingLevelMap: { max: null }, contextWindow: 333333, maxTokens: 44444, reasoning: false };
    const source = { ...metadata, baseUrl: "https://not-the-broker", apiKey: "never-copy", api: "wrong-api", name: "not-copied" };
    expect(configuredPiManagedModel({ providers: { unrelated: { models: [{ id: "different", contextWindow: 1 }] }, "cliproxyapi-anthropic": { models: [source] } } }, "known")).toEqual(metadata);
  });
  it("prefers a matching paperclip entry, not field-wise blending of provider configs", () => {
    const snapshot = { providers: { native: { models: [{ id: "known", contextWindow: 1, thinkingLevelMap: { max: null } }] }, paperclip: { models: [{ id: "known", maxTokens: 12345 }] } } };
    expect(resolvePiManagedModel(configuredPiManagedModel(snapshot, "known"), catalog)).toEqual({ id: "known", contextWindow: 1000000, maxTokens: 12345, reasoning: true });
  });
  it("falls through a nonmatching managed entry and does not strip nested ids", () => {
    expect(configuredPiManagedModel({ providers: { paperclip: { models: [{ id: "other" }] }, native: { models: [{ id: "vendor/id", contextWindow: 99999 }] } } }, "vendor/id")).toEqual({ id: "vendor/id", contextWindow: 99999 });
  });
  it("fills missing capabilities from a unanimous exact-id catalog without adding a thinking map", () => {
    expect(resolvePiManagedModel({ id: "known" }, catalog)).toEqual({ id: "known", contextWindow: 1000000, maxTokens: 128000, reasoning: true });
  });
  it("inherits only unanimous per-level catalog mappings and overlays config caps", () => {
    const withLevels = { ...catalog, getBuiltinModels: (provider: string) => catalog.getBuiltinModels(provider).map(model => ({ ...model,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", off: provider === "one" ? null : "off" },
    })) };
    expect(resolvePiManagedModel({ id: "known" }, withLevels).thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" });
    expect(resolvePiManagedModel({ id: "known", thinkingLevelMap: { max: null } }, withLevels).thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null });
  });
  it("preserves config caps and each explicit field over the catalog", () => {
    expect(resolvePiManagedModel({ id: "known", contextWindow: 321000, maxTokens: 16000, reasoning: false, thinkingLevelMap: { max: null } }, catalog)).toEqual({ id: "known", contextWindow: 321000, maxTokens: 16000, reasoning: false, thinkingLevelMap: { max: null } });
    expect(resolvePiManagedModel({ id: "known", contextWindow: 321000, thinkingLevelMap: { max: null } }, catalog)).toEqual({ id: "known", contextWindow: 321000, maxTokens: 128000, reasoning: true, thinkingLevelMap: { max: null } });
  });
  it.each(["unknown", "ambiguous-context", "ambiguous-tokens", "ambiguous-reasoning", "paperclip/known", `unknown\n${"x".repeat(1000)}`])("defaults and diagnoses a non-unanimous/nonexact id once: %s", id => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = resolvePiManagedModel({ id }, catalog);
    expect(model).toEqual({ id, contextWindow: 128000, maxTokens: 8192, reasoning: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0].length).toBeLessThanOrEqual(256);
    expect(warn.mock.calls[0]![0].split("\n")).toHaveLength(1);
    piManagedModelRegistration(model); // Already-resolved rebinds never warn again.
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it.each([{ contextWindow: -1 }, { maxTokens: 0 }, { reasoning: "true" }, { thinkingLevelMap: { max: 7 } }])("refuses invalid snapshot metadata: %j", invalid => {
    expect(() => configuredPiManagedModel({ providers: { native: { models: [{ id: "known", ...invalid }] } } }, "known")).toThrow("Pi configured model has invalid");
  });
});
