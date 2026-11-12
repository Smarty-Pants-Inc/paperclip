// Keep: #20185, snapshot/original-HOME/catalog -> managed-provider trust boundary.
// Expectations are literal Pi 1.5.2 configuration semantics, not derived from Pi internals.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { directPiProviderConfiguration } from "../acpx/pi-provider-loopback.js";
import { validateBindRequest, validatePiBindCommand, type BindRequest, type PiBindModel } from "./pi-bind-protocol.js";
import {
  configuredPiManagedModel, configuredPiManagedModelSources, piManagedModelRegistration,
  resolvePiManagedModel, type PiBuiltinModelCatalog,
} from "./pi-managed-model.js";
import { mergedPiModelsJson } from "./pi-models-merge.js";

const id = "compat-proof";
const api = "anthropic-messages";
const limits = { contextWindow: 1000000, maxTokens: 128000, reasoning: true };
const anthropicCompat = { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: false };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function modelsFile(snapshot: unknown) {
  const root = await mkdtemp(join(tmpdir(), "pi-managed-compat-")); roots.push(root);
  const file = join(root, "models.json");
  await writeFile(file, JSON.stringify(snapshot));
  return file;
}
function snapshot(model: Record<string, unknown>, provider: Record<string, unknown> = {}) {
  return { providers: { native: { api, ...provider, models: [{ id, ...model }] } } };
}
type CatalogModel = {
  id: string; api: string; contextWindow: number; maxTokens: number; reasoning: boolean;
  compat?: Record<string, unknown>;
};
function catalog(entries: Record<string, CatalogModel[]>): PiBuiltinModelCatalog {
  return { getBuiltinProviders: () => Object.keys(entries), getBuiltinModels: provider => entries[provider] ?? [] };
}
function expectOneBoundedDiagnostic(calls: unknown[][]) {
  expect(calls).toHaveLength(1);
  const line = String(calls[0]![0]);
  expect(line.length).toBeLessThanOrEqual(256);
  expect(line.split("\n")).toHaveLength(1);
  expect(line).not.toContain("secret-key");
  expect(line).not.toContain("private-config-path");
  expect(line).not.toContain("upstream.invalid");
}

// The optional final API arguments deliberately exercise the proposed positional
// contract. Baseline JS ignores them: RED must be metadata/validation, not imports.
describe("configured Pi compatibility metadata", () => {
  it("retains a same-API whole compat object, including false and nested arrays, without routing/auth", () => {
    const compat = {
      forceAdaptiveThinking: false, supportsTemperature: false,
      allowedFallbackModels: [{ provider: "anthropic", model: "fallback", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    };
    const source = snapshot({ ...limits, compat, apiKey: "secret-key", baseUrl: "https://upstream.invalid", headers: { authorization: "secret-key" }, name: "not-capability" },
      { apiKey: "secret-key", baseUrl: "https://upstream.invalid", authHeader: true });
    const configured = configuredPiManagedModel(source, id, api);
    expect(configured).toEqual({ id, ...limits, compat: {
      forceAdaptiveThinking: false, supportsTemperature: false,
      allowedFallbackModels: [{ provider: "anthropic", model: "fallback", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    } });
    compat.allowedFallbackModels[0]!.cost.input = 999;
    expect((configured as any).compat.allowedFallbackModels[0].cost.input).toBe(1);
  });

  it("uses provider compat when the selected model has no compat", () => {
    expect(configuredPiManagedModel(snapshot({ ...limits }, { compat: { forceAdaptiveThinking: true, supportsTemperature: false } }), id, api))
      .toEqual({ id, ...limits, compat: { forceAdaptiveThinking: true, supportsTemperature: false } });
  });

  it("merges model compat over provider compat per field, preserving explicit false", () => {
    expect(configuredPiManagedModel(snapshot({ compat: { forceAdaptiveThinking: false, supportsStrictTools: false } },
      { compat: { forceAdaptiveThinking: true, supportsTemperature: false } }), id, api))
      .toEqual({ id, compat: { forceAdaptiveThinking: false, supportsTemperature: false, supportsStrictTools: false } });
  });

  it.each(["chatTemplateKwargs", "chatTemplateArgs", "openRouterRouting", "vercelGatewayRouting"])(
    "merges the Pi-defined nested %s field one level rather than replacing or recursively blending it", key => {
      const template = key === "chatTemplateKwargs" || key === "chatTemplateArgs";
      const providerValue = template
        ? { inherited: 0, enabled: true, optional: null, effort: { $var: "thinking.effort", omitWhenOff: true } }
        : { order: ["one", "two"], only: ["one"] };
      const modelValue = template
        ? { enabled: false, effort: { $var: "thinking.budget" } }
        : { only: ["two"] };
      const expected = template
        ? { inherited: 0, enabled: false, optional: null, effort: { $var: "thinking.budget" } }
        : { order: ["one", "two"], only: ["two"] };
      expect(configuredPiManagedModel(snapshot({ compat: { [key]: modelValue } },
        { api: "openai-completions", compat: { supportsStore: false, [key]: providerValue } }), id, "openai-completions"))
        .toEqual({ id, compat: { supportsStore: false, [key]: expected } });
    },
  );

  it("uses model.api over provider.api to determine the effective API", () => {
    expect(configuredPiManagedModel(snapshot({ api, compat: { forceAdaptiveThinking: true } },
      { api: "openai-completions", compat: { supportsTemperature: false } }), id, api))
      .toEqual({ id, compat: { supportsTemperature: false, forceAdaptiveThinking: true } });
  });

  it("skips compat on an effective model API mismatch, keeps other capabilities, and diagnoses once safely", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unusualId = `compat\n${"x".repeat(1000)}`;
    const source = { providers: { native: { api, apiKey: "secret-key", baseUrl: "https://upstream.invalid",
      compat: { supportsTemperature: false }, models: [{ id: unusualId, ...limits, api: "openai-completions",
        compat: { supportsStore: false }, thinkingLevelMap: { max: null } }] } } };
    expect(configuredPiManagedModel(source, unusualId, api)).toEqual({ id: unusualId, ...limits, thinkingLevelMap: { max: null } });
    expectOneBoundedDiagnostic(warn.mock.calls);
  });

  it("does not take compat from a different provider when paperclip owns the exact-id selection", () => {
    expect(configuredPiManagedModel({ providers: {
      paperclip: { api, models: [{ id, ...limits, compat: { forceAdaptiveThinking: false } }] },
      native: { api, compat: { supportsTemperature: false }, models: [{ id, compat: { forceAdaptiveThinking: true } }] },
    } }, id, api)).toEqual({ id, ...limits, compat: { forceAdaptiveThinking: false } });
  });
});

const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
const invalidCompat: Array<[string, unknown]> = [
  ["null", null], ["array", []], ["boolean", false], ["number", 7], ["string", "compat"],
  ["undefined member", { nested: { value: undefined } }], ["function member", { value: () => false }],
  ["symbol member", { value: Symbol("not-json") }], ["bigint member", { value: 1n }],
  ["NaN member", { value: NaN }], ["infinite member", { value: Infinity }],
  ["Date member", { value: new Date(0) }], ["Map member", { value: new Map() }], ["cycle", cyclic],
  ["nonplain root", new Date(0)], ["undefined root", undefined],
  ["sparse array", { value: new Array(2) }],
  ["symbol key", { [Symbol("not-json")]: false }],
  ["accessor", Object.defineProperty({}, "value", { enumerable: true, get: () => false })],
];
describe("compat validation and optional original-HOME precedence", () => {
  it.each(invalidCompat)("rejects invalid configured model compat: %s", (_label, compat) => {
    expect(() => configuredPiManagedModel(snapshot({ compat }), id, api)).toThrow(/invalid compat/i);
  });
  it.each(invalidCompat)("rejects invalid configured provider compat: %s", (_label, compat) => {
    expect(() => configuredPiManagedModel(snapshot({}, { compat }), id, api)).toThrow(/invalid compat/i);
  });

  it("inherits whole compat from the original HOME while retaining agent capability and thinking-map precedence", async () => {
    const file = await modelsFile(snapshot({ contextWindow: 222222, maxTokens: 33333, reasoning: false,
      thinkingLevelMap: { max: "max", xhigh: null }, compat: { forceAdaptiveThinking: true } }, { compat: { supportsTemperature: false } }));
    const configured = await configuredPiManagedModelSources(snapshot({ contextWindow: 111111, thinkingLevelMap: { max: null } }), id, file, api);
    expect(configured).toEqual({ id, contextWindow: 111111, maxTokens: 33333, reasoning: false,
      thinkingLevelMap: { max: null, xhigh: null }, compat: { supportsTemperature: false, forceAdaptiveThinking: true } });
  });

  it("gives an explicit primary compat object whole-field precedence over the original HOME", async () => {
    const file = await modelsFile(snapshot({ maxTokens: 33333, reasoning: false, compat: { forceAdaptiveThinking: true, supportsTemperature: false } }));
    expect(await configuredPiManagedModelSources(snapshot({ contextWindow: 111111, compat: { forceAdaptiveThinking: false } }), id, file, api))
      .toEqual({ id, contextWindow: 111111, maxTokens: 33333, reasoning: false, compat: { forceAdaptiveThinking: false } });
  });

  it.each([null, [], false, 7, "compat"])("skips invalid optional original-HOME compat (%j) with one bounded diagnostic", async compat => {
    const file = await modelsFile(snapshot({ ...limits, compat }));
    const bytes = await readFile(file, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await configuredPiManagedModelSources(snapshot({ contextWindow: 111111, maxTokens: 44444, reasoning: false,
      thinkingLevelMap: { max: null }, compat: { forceAdaptiveThinking: false } }), id, file, api))
      .toEqual({ id, contextWindow: 111111, maxTokens: 44444, reasoning: false, thinkingLevelMap: { max: null }, compat: { forceAdaptiveThinking: false } });
    expectOneBoundedDiagnostic(warn.mock.calls);
    expect(await readFile(file, "utf8")).toBe(bytes);
  });

  it("skips non-JSON original-HOME data without exposing its path or contents", async () => {
    const file = await modelsFile({});
    await writeFile(file, '{"private-config-path":"secret-key","providers":{"native":{"models":[{"id":"compat-proof","compat":{"value":NaN}}]}}}');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await configuredPiManagedModelSources(snapshot({ ...limits, compat: {} }), id, file, api)).toEqual({ id, ...limits, compat: {} });
    expectOneBoundedDiagnostic(warn.mock.calls);
  });
});

describe("canonical API-owner catalog fallback", () => {
  it("copies the whole canonical anthropic compat despite conflicting other providers, and diagnoses the owner once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = catalog({ other: [{ id, api, ...limits, compat: { forceAdaptiveThinking: false, sendSessionAffinityHeaders: true } }],
      anthropic: [{ id, api, ...limits, compat: { supportsTemperature: false, forceAdaptiveThinking: true } }] });
    expect(resolvePiManagedModel({ id }, source, api)).toEqual({ id, ...limits, compat: { supportsTemperature: false, forceAdaptiveThinking: true } });
    expectOneBoundedDiagnostic(warn.mock.calls);
    expect(String(warn.mock.calls[0]![0])).toContain("canonical provider anthropic");
  });

  it("does not let a different API's same-id candidate suppress or contaminate compat", () => {
    const source = catalog({ anthropic: [{ id, api, ...limits, compat: { forceAdaptiveThinking: true, supportsTemperature: false } }],
      radius: [{ id, api: "pi-messages", ...limits }],
      chat: [{ id, api: "openai-completions", ...limits, compat: { supportsStore: false } }] });
    expect(resolvePiManagedModel({ id }, source, api)).toEqual({ id, ...limits, compat: { forceAdaptiveThinking: true, supportsTemperature: false } });
  });

  it.each([
    { other: [{ id, api, ...limits, compat: anthropicCompat }] },
    { anthropic: [{ id: "different-id", api, ...limits, compat: anthropicCompat }], other: [{ id, api, ...limits, compat: anthropicCompat }] },
    { anthropic: [{ id, api: "openai-completions", ...limits, compat: { supportsStore: false } }] },
    { anthropic: [{ id, api, ...limits }] },
  ])("skips compat rather than choosing another provider when the canonical API/id/compat is absent: %j", entries => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolvePiManagedModel({ id, ...limits }, catalog(entries as Record<string, CatalogModel[]>), api)).toEqual({ id, ...limits });
    expectOneBoundedDiagnostic(warn.mock.calls);
  });

  it.each(["openai-completions", "openai-responses"] as const)("uses canonical openai for %s, not an agreeing or first alternative", targetApi => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = catalog({ first: [{ id, api: targetApi, ...limits, compat: { supportsDeveloperRole: true } }],
      openai: [{ id, api: targetApi, ...limits, compat: { supportsDeveloperRole: false, futureFlag: false } }] });
    expect(resolvePiManagedModel({ id }, source, targetApi)).toEqual({ id, ...limits, compat: { supportsDeveloperRole: false, futureFlag: false } });
    expectOneBoundedDiagnostic(warn.mock.calls);
    expect(String(warn.mock.calls[0]![0])).toContain("canonical provider openai");
  });

  it.each([{ forceAdaptiveThinking: false }, {}])("keeps explicit config compat as a whole field over catalog compat: %j", compat => {
    const source = catalog({ anthropic: [{ id, api, ...limits, compat: { forceAdaptiveThinking: true, supportsTemperature: false } }] });
    const configured = configuredPiManagedModel(snapshot({ ...limits, compat }), id, api);
    expect(resolvePiManagedModel(configured, source, api)).toEqual({ id, ...limits, compat });
  });
});

function binding(model: PiBindModel): BindRequest {
  return { schema: 1, type: "bind", nonce: "compat-bind", sessionId: "compat-session", expectedPriorEpoch: 0,
    epoch: 1, runId: "compat-run", model: `paperclip/${id}`, thinkingLevel: "high", instructions: "instructions", tools: [],
    provider: { name: "paperclip", api, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "broker-capability", models: [model] } };
}
describe("private bind and downstream preservation", () => {
  it("has a valid baseline bind fixture without compat", () => {
    expect(validateBindRequest(binding({ id, ...limits }))).toBe(true);
  });
  it.each([{}, anthropicCompat, { supportsStore: false, chatTemplateKwargs: { enabled: false, optional: null, effort: { $var: "thinking.effort" } } }])(
    "admits plain-JSON compat across the private bind boundary: %j", compat => {
      const request = binding({ id, ...limits, compat } as any);
      if ("supportsStore" in compat) request.provider.api = "openai-completions";
      expect(validateBindRequest(request)).toBe(true);
      expect(validatePiBindCommand(request)).toBe(true);
    },
  );
  it.each(invalidCompat)("refuses invalid bind compat: %s", (_label, compat) => {
    const request = binding({ id, ...limits, compat } as any);
    expect(validateBindRequest(request)).toBe(false);
    expect(validatePiBindCommand(request)).toBe(false);
  });

  it("still rejects model routing/auth injection when compat is allowed", () => {
    expect(validateBindRequest(binding({ id, ...limits, compat: anthropicCompat, apiKey: "secret-key" } as any))).toBe(false);
    expect(validateBindRequest(binding({ id, ...limits, compat: anthropicCompat, baseUrl: "https://upstream.invalid" } as any))).toBe(false);
  });

  it("preserves whole compat and explicit capabilities across repeated registration", () => {
    const model = { id, ...limits, reasoning: false, thinkingLevelMap: { max: null }, compat: anthropicCompat };
    const registered = piManagedModelRegistration(model as any);
    expect(registered).toEqual({ ...model, name: id, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(piManagedModelRegistration(registered)).toEqual(registered);
  });

  it("preserves compat through the direct configuration metadata allowlist without copying routing/auth", () => {
    const result = directPiProviderConfiguration({ model: `paperclip/${id}`, environment: {
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1234",
      PAPERCLIP_AI_PROVIDER_AUTH: "none",
    }, modelConfiguration: { id, ...limits, compat: anthropicCompat, apiKey: "secret-key", baseUrl: "https://upstream.invalid" } as any });
    expect(JSON.parse(result.json).providers.paperclip.models).toEqual([{ id, ...limits, compat: anthropicCompat }]);
  });

  it("merges provider/model compat into models.json without replacing managed routing/auth", async () => {
    const file = await modelsFile({ extra: 1, providers: { paperclip: { api, baseUrl: "https://upstream.invalid", apiKey: "secret-key",
      compat: { forceAdaptiveThinking: true, supportsTemperature: false },
      models: [{ id, ...limits, thinkingLevelMap: { max: null }, compat: { forceAdaptiveThinking: false } }] } } });
    const incoming = { providers: { paperclip: { api, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "broker-capability",
      models: [{ id, ...limits, thinkingLevelMap: { xhigh: "xhigh" }, compat: { supportsStrictTools: true } }] } } };
    const merged = JSON.parse(await mergedPiModelsJson(file, JSON.stringify(incoming)));
    expect(merged).toEqual({ extra: 1, providers: { paperclip: { api, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "broker-capability",
      models: [{ id, ...limits, thinkingLevelMap: { xhigh: "xhigh", max: null }, compat: { forceAdaptiveThinking: false, supportsTemperature: false } }] } } });
  });

  it("does not reintroduce mismatched snapshot compat when merging a managed provider", async () => {
    const file = await modelsFile(snapshot({ ...limits, compat: { supportsStore: false } }, { api: "openai-completions" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const incoming = { providers: { paperclip: { api, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "broker-capability",
      models: [{ id, ...limits, compat: anthropicCompat }] } } };
    const merged = JSON.parse(await mergedPiModelsJson(file, JSON.stringify(incoming)));
    expect(merged.providers.paperclip).toEqual(incoming.providers.paperclip);
    expectOneBoundedDiagnostic(warn.mock.calls);
  });
});
