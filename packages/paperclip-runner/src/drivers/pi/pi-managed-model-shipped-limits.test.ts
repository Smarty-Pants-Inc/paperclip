import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { buildPiManagedModel, PI_MANAGED_MODEL_DEFAULTS } from "./pi-managed-model.js";

// A1 (pack-n5): the provider's own ceiling is the only ceiling. Every model the
// fleet runs on native Pi must resolve its real catalog maxTokens/contextWindow,
// even on paths that get no selected-installation catalog (the ACPX loopback
// bootstrap, or a native start whose installation catalog cannot be loaded).
// It must never silently fall back to the 8,192-token unknown-model default.
const SHIPPED: ReadonlyArray<{ id: string; api: "anthropic-messages" | "openai-responses" | "openai-completions"; owner: string }> = [
  { id: "claude-opus-5-5", api: "anthropic-messages", owner: "anthropic" },
  { id: "claude-fable-5-2", api: "anthropic-messages", owner: "anthropic" },
  { id: "claude-sonnet-5-5", api: "anthropic-messages", owner: "anthropic" },
  { id: "gpt-6-astra", api: "openai-responses", owner: "openai" },
  { id: "gpt-6-astra", api: "openai-completions", owner: "openai" },
  { id: "gpt-5.5", api: "openai-responses", owner: "openai" },
];

let home: string;
beforeAll(async () => { home = await mkdtemp(join(tmpdir(), "pi-shipped-limits-")); });
afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe("A1 shipped Pi models resolve their real output ceiling", () => {
  for (const { id, api, owner } of SHIPPED) {
    it(`${id} (${api}) resolves the pinned Pi catalog maxTokens without a supplied catalog`, async () => {
      const real = getBuiltinModels(owner as never).find(model => model.id === id);
      expect(real, `${id} must exist in the pinned Pi 1.5.2 catalog`).toBeDefined();
      expect(getBuiltinProviders()).toContain(owner);
      const model = await buildPiManagedModel({ snapshot: {}, id, api, originalModelsFile: join(home, "absent-models.json"), warn: () => {} });
      expect(model.maxTokens).toBe(real!.maxTokens);
      expect(model.contextWindow).toBe(real!.contextWindow);
      expect(model.maxTokens).not.toBe(PI_MANAGED_MODEL_DEFAULTS.maxTokens);
    });
  }
  it("explicit configured limits still win over the pinned catalog", async () => {
    const snapshot = { providers: { paperclip: { models: [{ id: "claude-opus-5-5", maxTokens: 64000 }] } } };
    const model = await buildPiManagedModel({ snapshot, id: "claude-opus-5-5", api: "anthropic-messages", originalModelsFile: join(home, "absent-models.json"), warn: () => {} });
    expect(model.maxTokens).toBe(64000);
  });
});
