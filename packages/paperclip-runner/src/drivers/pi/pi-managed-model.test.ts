import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredPiManagedModel, resolvePiManagedModel, piManagedModelRegistration } from "./pi-managed-model.js";

// Keep: snapshot-to-broker trust boundary and the real H8C metadata-loss catch.
const identityThinkingMap = { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const catalog = {
  getBuiltinProviders: () => ["one", "two"],
  getBuiltinModels: (provider: string) => [
    { id: "known", contextWindow: 1000000, maxTokens: 128000, reasoning: true },
    { id: "known-no-reasoning", contextWindow: 128000, maxTokens: 8192, reasoning: false },
    { id: "ambiguous-context", contextWindow: provider === "one" ? 1000000 : 200000, maxTokens: 128000, reasoning: true },
    { id: "ambiguous-tokens", contextWindow: 1000000, maxTokens: provider === "one" ? 128000 : 8192, reasoning: true },
    { id: "ambiguous-reasoning", contextWindow: 1000000, maxTokens: 128000, reasoning: provider === "one" },
  ],
};
afterEach(() => vi.restoreAllMocks());

describe("managed Pi model capabilities", () => {
  it("copies the whole non-routing definition from the same id on another snapshot provider", () => {
    const metadata = { id: "known", thinkingLevelMap: { max: null }, contextWindow: 333333, maxTokens: 44444, reasoning: false };
    const source = { ...metadata, baseUrl: "https://not-the-broker", apiKey: "never-copy", api: "wrong-api", name: "display name" };
    expect(configuredPiManagedModel({ providers: { unrelated: { models: [{ id: "different", contextWindow: 1 }] }, "cliproxyapi-anthropic": { models: [source] } } }, "known")).toEqual({ ...metadata, name: "display name" });
  });
  it("prefers a matching paperclip entry, not field-wise blending of provider configs", () => {
    const snapshot = { providers: { native: { models: [{ id: "known", contextWindow: 1, thinkingLevelMap: { max: null } }] }, paperclip: { models: [{ id: "known", maxTokens: 12345 }] } } };
    expect(resolvePiManagedModel(configuredPiManagedModel(snapshot, "known"), catalog)).toEqual({ id: "known", input: ["text"], contextWindow: 1000000, maxTokens: 12345, reasoning: true });
  });
  it("falls through a nonmatching managed entry and does not strip nested ids", () => {
    expect(configuredPiManagedModel({ providers: { paperclip: { models: [{ id: "other" }] }, native: { models: [{ id: "vendor/id", contextWindow: 99999 }] } } }, "vendor/id")).toEqual({ id: "vendor/id", contextWindow: 99999 });
  });
  it("fills missing fields from the winning exact-id catalog without adding a thinking map", () => {
    expect(resolvePiManagedModel({ id: "known" }, catalog)).toEqual({ id: "known", input: ["text"], contextWindow: 1000000, maxTokens: 128000, reasoning: true });
  });
  it("inherits the winning source's whole thinking map and overlays config caps", () => {
    const withLevels = { ...catalog, getBuiltinModels: (provider: string) => catalog.getBuiltinModels(provider).map(model => ({ ...model,
      thinkingLevelMap: { xhigh: "xhigh", max: "max", off: provider === "one" ? null : "off" },
    })) };
    expect(resolvePiManagedModel({ id: "known" }, withLevels).thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max", off: null });
    expect(resolvePiManagedModel({ id: "known", thinkingLevelMap: { max: null } }, withLevels).thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null, off: null });
  });
  it("preserves config caps and each explicit field over the catalog", () => {
    expect(resolvePiManagedModel({ id: "known", contextWindow: 321000, maxTokens: 16000, reasoning: false, thinkingLevelMap: { max: null } }, catalog)).toEqual({ id: "known", input: ["text"], contextWindow: 321000, maxTokens: 16000, reasoning: false, thinkingLevelMap: { max: null } });
    expect(resolvePiManagedModel({ id: "known", contextWindow: 321000, thinkingLevelMap: { max: null } }, catalog)).toEqual({ id: "known", input: ["text"], contextWindow: 321000, maxTokens: 128000, reasoning: true, thinkingLevelMap: { max: null } });
  });
  it.each([catalog, undefined])("admits requested xhigh for an unknown managed id with or without a catalog", source => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = resolvePiManagedModel(configuredPiManagedModel({}, "unknown-managed-xhigh"), source);
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap?.xhigh).toBe("xhigh");
    const registered = piManagedModelRegistration(model);
    const rebound = piManagedModelRegistration(registered);
    expect(rebound).toEqual(registered);
    expect(rebound.thinkingLevelMap?.xhigh).toBe("xhigh");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0].length).toBeLessThanOrEqual(256);
    expect(warn.mock.calls[0]![0].split("\n")).toHaveLength(1);
  });
  it("preserves unknown config reasoning:false and per-key null caps over fallback mappings", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const configured = configuredPiManagedModel({ providers: { paperclip: { models: [{ id: "unknown", reasoning: false, thinkingLevelMap: { xhigh: null, max: null } }] } } }, "unknown");
    const resolved = resolvePiManagedModel(configured, catalog);
    expect(resolved.reasoning).toBe(false);
    expect(resolved.thinkingLevelMap).toEqual({ ...identityThinkingMap, xhigh: null, max: null });
    expect(piManagedModelRegistration(resolved).thinkingLevelMap).toEqual(resolved.thinkingLevelMap);
    const capped = resolvePiManagedModel({ id: "unknown", thinkingLevelMap: { xhigh: null } }, catalog);
    expect(capped.reasoning).toBe(true);
    expect(capped.thinkingLevelMap).toEqual({ ...identityThinkingMap, xhigh: null });
    expect(piManagedModelRegistration(capped).thinkingLevelMap?.xhigh).toBeNull();
  });
  it("does not add fallback thinking capabilities when registering a resolved known catalog model", () => {
    const known = piManagedModelRegistration(resolvePiManagedModel({ id: "known" }, catalog));
    expect(known.reasoning).toBe(true);
    expect(known.thinkingLevelMap).toBeUndefined();
    const nonreasoning = piManagedModelRegistration(resolvePiManagedModel({ id: "known-no-reasoning" }, catalog));
    expect(nonreasoning.reasoning).toBe(false);
    expect(nonreasoning.thinkingLevelMap).toBeUndefined();
  });
  it.each(["unknown", "paperclip/known", `unknown\n${"x".repeat(1000)}`])("defaults and diagnoses an unknown/nonexact id once: %s", id => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const model = resolvePiManagedModel({ id }, catalog);
    expect(model).toEqual({ id, input: ["text"], contextWindow: 128000, maxTokens: 8192, reasoning: true, thinkingLevelMap: identityThinkingMap });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0].length).toBeLessThanOrEqual(256);
    expect(warn.mock.calls[0]![0].split("\n")).toHaveLength(1);
    piManagedModelRegistration(model); // Already-resolved rebinds never warn again.
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it.each(["ambiguous-context", "ambiguous-tokens", "ambiguous-reasoning"])("retains the winning whole definition rather than synthesizing consensus: %s", id => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePiManagedModel({ id }, catalog)).toEqual({ id, input: ["text"], contextWindow: 1000000, maxTokens: 128000, reasoning: true });
  });
  it.each([{ contextWindow: -1 }, { maxTokens: 0 }, { reasoning: "true" }, { thinkingLevelMap: { max: 7 } }])("refuses invalid snapshot metadata: %j", invalid => {
    expect(() => configuredPiManagedModel({ providers: { native: { models: [{ id: "known", ...invalid }] } } }, "known")).toThrow("Pi configured model has invalid");
  });
});
