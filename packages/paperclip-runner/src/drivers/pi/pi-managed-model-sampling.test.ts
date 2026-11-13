// Keep: F1 trust boundary. Pi merges sampling parameters after its admitted
// model/thinking controls; a same-id config must never change either decision.
import { expect, it } from "vitest";
import { buildPiManagedModel, piManagedModelDefinition, type PiBuiltinModelCatalog } from "./pi-managed-model.js";
import { PI_MODEL_ROUTING_FIELDS, validateBindRequest } from "./pi-bind-protocol.js";

const api = "openai-completions";
const base = { id: "sampling-proof", name: "Sampling proof", input: ["text" as const], contextWindow: 128000, maxTokens: 8192, reasoning: true, compat: {} };
const protectedKeys = ["model", ...PI_MODEL_ROUTING_FIELDS, "reasoning_effort", "reasoningEffort", "reasoning", "thinking", "effort", "budget_tokens", "thinking_budget", "thinking_token_budget", "thinking_budget_tokens", "enable_thinking", "preserve_thinking", "thinkingBudget", "thinkingBudgets", "thinkingEnabled", "thinkingBudgetTokens", "thinkingLevel", "thinkingConfig", "thinking_config", "thinking_level", "chat_template_kwargs", "chat_template_args"];

it("strips the reported same-id model/effort bypass but preserves temperature", async () => {
  const source = { ...base, samplingParams: { model: "x", temperature: 0.3, reasoning_effort: "max" } };
  const diagnostics: string[] = [];
  const actual = await buildPiManagedModel({ snapshot: { providers: { paperclip: { api, models: [source] } } }, id: base.id, api, warn: message => diagnostics.push(message) });
  expect(actual).toEqual({ ...base, samplingParams: { temperature: 0.3 } });
  expect(diagnostics).toEqual([
    'stripped protected sampling key "model" at "samplingParams.model"',
    'stripped protected sampling key "reasoning_effort" at "samplingParams.reasoning_effort"',
  ]);
  expect(source.samplingParams.model).toBe("x");
});

it.each(["samplingParams", "samplingParamsByThinkingLevel", "samplingParamsFuture"])("strips every routing/thinking key inside %s, including nested containers", field => {
  const unsafe = Object.fromEntries(protectedKeys.map(key => [key, "unsafe-must-not-echo"]));
  const source = { ...base, [field]: { high: { ...unsafe, temperature: 0.3, top_p: 0.8, output_config: { effort: "max", format: "json" }, future: [{ model: "x", top_k: 10 }] } } };
  const diagnostics: string[] = [];
  expect(piManagedModelDefinition(source, message => diagnostics.push(message))).toEqual({ ...base, [field]: { high: { temperature: 0.3, top_p: 0.8, output_config: { format: "json" }, future: [{ top_k: 10 }] } } });
  expect(diagnostics).toHaveLength(protectedKeys.length + 2);
  expect(new Set(diagnostics).size).toBe(diagnostics.length);
  expect(diagnostics.every(message => !message.includes("unsafe-must-not-echo"))).toBe(true);
  expect(source[field].high.model).toBe("unsafe-must-not-echo");
});

it("does not truncate away per-key diagnostics when config and catalog repeat unsafe definitions", async () => {
  const source = { ...base, samplingParams: Object.fromEntries(protectedKeys.map(key => [key, "unsafe"])) };
  const catalog: PiBuiltinModelCatalog = { getBuiltinProviders: () => ["openai"], getBuiltinModels: () => [{ ...source, api }] };
  const diagnostics: string[] = [];
  const actual = await buildPiManagedModel({ snapshot: { providers: { paperclip: { api, models: [source] } } }, id: base.id, api, catalog, warn: message => diagnostics.push(message) });
  expect(actual).toEqual({ ...base, samplingParams: {} });
  expect(diagnostics).toHaveLength(protectedKeys.length);
  for (const key of protectedKeys) expect(diagnostics.filter(message => message.includes(`stripped protected sampling key "${key}"`))).toHaveLength(1);
});

it("keeps one bounded diagnostic per stripped key even when long paths share a prefix", async () => {
  const source = { ...base, samplingParams: { ["long".repeat(100)]: { one: { model: "x" }, two: { model: "y" } } } };
  const diagnostics: string[] = [];
  const actual = await buildPiManagedModel({ snapshot: { providers: { paperclip: { api, models: [source] } } }, id: base.id, api, warn: message => diagnostics.push(message) });
  expect(actual.samplingParams).toEqual({ ["long".repeat(100)]: { one: {}, two: {} } });
  expect(diagnostics).toHaveLength(2);
  expect(new Set(diagnostics).size).toBe(2);
  expect(diagnostics.every(message => message.length <= 220 && message.startsWith('stripped protected sampling key "model"'))).toBe(true);
});

it.each(["samplingParams", "samplingParamsByThinkingLevel", "samplingParamsFuture"])("rejects raw %s bypasses on the private bind boundary", field => {
  const request = (sampling: unknown) => ({ schema: 1, type: "bind", nonce: "sampling", sessionId: "sampling", expectedPriorEpoch: 0, epoch: 1, runId: "sampling", model: `paperclip/${base.id}`, thinkingLevel: "high", instructions: "", tools: [],
    provider: { name: "paperclip", api, baseUrl: "http://127.0.0.1:1234/v1", apiKey: "local-capability", models: [{ ...base, [field]: sampling }] } });
  expect(validateBindRequest(request({ high: { temperature: 0.3, top_p: 0.8 } }))).toBe(true);
  for (const key of protectedKeys) expect(validateBindRequest(request({ high: { [key]: "unsafe" } })), key).toBe(false);
  expect(validateBindRequest(request({ output_config: { effort: "max" } }))).toBe(false);
});
