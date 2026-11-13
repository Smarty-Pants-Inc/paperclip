// Keep: J1 and earlier thinking/limits/compat loss at the model routing boundary.
import { expect, it } from "vitest";
import { buildPiManagedModel, configuredPiManagedModel, type PiBuiltinModelCatalog } from "./pi-managed-model.js";
import { createPiProviderBinding } from "../acpx/pi-provider-loopback.js";
import { piManagedModelRegistration } from "./pi-managed-model.js";
import { validateBindRequest } from "./pi-bind-protocol.js";

const api = "openai-completions";
const definition = {
  id: "whole-definition", name: "A complete model", input: ["text", "image"] as Array<"text" | "image">,
  reasoning: false, contextWindow: 123456, maxTokens: 7890,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, tiers: [{ inputTokensAbove: 100, input: 5, output: 6, cacheRead: 7, cacheWrite: 8 }] },
  thinkingLevelMap: { max: null, xhigh: "custom" },
  compat: { supportsStore: false, chatTemplateKwargs: { enabled: false } },
  inputLimits: { images: { maxPerMessage: 4 }, maxRequestBytes: 1234567 },
  promptCache: { short: { ttlSeconds: 300 } },
  type: "chat",
  samplingParams: { temperature: 0.25 }, samplingParamsByThinkingLevel: { high: { top_p: 0.8 } },
  futureCapability: { nested: [false, null, "preserve-me"] },
};
const environment = { PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_AUTH: "none" };
const catalog: PiBuiltinModelCatalog = { getBuiltinProviders: () => ["openai"], getBuiltinModels: () => [{ ...definition, provider: "openai", api, baseUrl: "https://never-copy.invalid", headers: { authorization: "never-copy" } }] };

it.each(["config", "catalog"])("diffs every non-routing field from the whole %s source across broker, bind, and registration", async kind => {
  const source = { ...definition, provider: "untrusted", api, baseUrl: "https://never-copy.invalid", headers: { authorization: "never-copy" }, apiKey: "never-copy", oauth: { token: "never-copy" }, authHeader: true };
  const model = await buildPiManagedModel({ snapshot: kind === "config" ? { providers: { native: { api, models: [source] } } } : {}, id: definition.id, api, catalog, warn: () => {} });
  // Full-object diff, not an enumerated allowlist: future metadata must survive.
  expect(model).toEqual(definition);
  const binding = await createPiProviderBinding({ model: `paperclip/${definition.id}`, environment, modelConfiguration: model });
  try {
    expect(binding.provider.models[0]).toEqual(definition);
    expect(piManagedModelRegistration(binding.provider.models[0])).toEqual(definition);
    expect(validateBindRequest({ schema: 1, type: "bind", nonce: "definition", sessionId: "definition", expectedPriorEpoch: 0, epoch: 1, runId: "definition", model: `paperclip/${definition.id}`, thinkingLevel: "high", instructions: "", tools: [], provider: binding.provider })).toBe(true);
    expect(binding.provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(binding.provider.apiKey).not.toBe("never-copy");
  } finally { await binding.close(); }
});

it("keeps explicit config fields, including text-only input and false, ahead of the catalog", async () => {
  const overrides = { id: definition.id, name: "Explicit override", input: ["text"], reasoning: false, thinkingLevelMap: { max: null }, compat: {} };
  const actual = await buildPiManagedModel({ snapshot: { providers: { native: { api, models: [overrides] } } }, id: definition.id, api, catalog, warn: () => {} });
  expect(actual).toEqual({ ...definition, ...overrides, thinkingLevelMap: { ...definition.thinkingLevelMap, ...overrides.thinkingLevelMap } });
});

it("drops API-shaped metadata from mismatched config without losing neutral metadata", () => {
  const actual = configuredPiManagedModel({ providers: { native: { api: "anthropic-messages", models: [definition] } } }, definition.id, api, () => {});
  const { compat, samplingParams, samplingParamsByThinkingLevel, ...neutral } = definition;
  expect(actual).toEqual(neutral);
});

it("uses canonical API-owner definition despite earlier conflicting catalog entries", async () => {
  const actual = await buildPiManagedModel({ snapshot: {}, id: definition.id, api, catalog: {
    getBuiltinProviders: () => ["anthropic", "openai"], getBuiltinModels: owner => [{ ...definition, api: owner === "openai" ? api : "anthropic-messages", name: owner, compat: owner === "openai" ? { supportsStore: false } : { forceAdaptiveThinking: true } }],
  }, warn: () => {} });
  expect(actual).toEqual({ ...definition, name: "openai", compat: { supportsStore: false } });
});

it("takes an unknown model's explicit source-provider input, otherwise diagnoses text-only defaults once", async () => {
  const explicit = await buildPiManagedModel({ snapshot: { providers: { native: { api, input: ["text", "image"], models: [{ id: "unknown" }] } } }, id: "unknown", api, warn: () => {} });
  expect(explicit.input).toEqual(["text", "image"]);
  const diagnostics: string[] = [];
  const unknown = await buildPiManagedModel({ snapshot: {}, id: "unknown", api, warn: message => diagnostics.push(message) });
  expect(unknown.input).toEqual(["text"]); expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toContain("image capability unknown");
});

it.each(["provider", "baseUrl", "api", "apiKey", "headers", "authHeader", "auth", "oauth"])("refuses %s routing injection while allowing future model capabilities", field => {
  const request = { schema: 1, type: "bind", nonce: "definition", sessionId: "definition", expectedPriorEpoch: 0, epoch: 1, runId: "definition", model: `paperclip/${definition.id}`, thinkingLevel: "high", instructions: "", tools: [],
    provider: { name: "paperclip", api, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "local-capability", models: [{ ...definition, [field]: "never-copy" }] } };
  expect(validateBindRequest(request)).toBe(false);
});

it("does not copy any foreign API-shaped catalog metadata when no canonical match exists", async () => {
  const actual = await buildPiManagedModel({ snapshot: {}, id: definition.id, api: "anthropic-messages", catalog, warn: () => {} });
  const { compat, samplingParams, samplingParamsByThinkingLevel, ...neutral } = definition;
  expect(actual).toEqual(neutral);
});

it("does not share mutable nested metadata with either source", async () => {
  const source = structuredClone(definition);
  const actual = await buildPiManagedModel({ snapshot: { providers: { native: { api, models: [source] } } }, id: definition.id, api, warn: () => {} });
  source.input.push("text"); source.futureCapability.nested.push("changed"); source.cost.tiers[0]!.input = 999;
  expect(actual).toEqual(definition);
});
