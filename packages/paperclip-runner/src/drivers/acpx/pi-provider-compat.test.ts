// Keep: #20185, real ACPX child bootstrap/config trust boundary and source data safety.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startPiProviderLoopback } from "./pi-provider-loopback.js";

// The managed overlay always adds both session-affinity flags to the child model.
const managedAffinity = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };

it("supersedes(pre-overlay affinity expectation; RFL record P1C5-OVERLAY-EXPECTATIONS) bootstraps whole compat from original HOME with only model and environment, without changing the source", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-child-compat-"));
  let binding: Awaited<ReturnType<typeof startPiProviderLoopback>> | undefined;
  try {
    const agent = join(home, ".pi", "agent");
    await mkdir(agent, { recursive: true });
    const file = join(agent, "models.json");
    const compat = { forceAdaptiveThinking: true, supportsTemperature: false,
      supportsLongCacheRetention: false, futureMetadata: { optional: null, choices: [false, "value", 3] } };
    const source = `${JSON.stringify({ providers: { private: { api: "anthropic-messages", baseUrl: "https://unused.invalid",
      apiKey: "source-key-canary", compat: { supportsStrictTools: false },
      models: [{ id: "child-proof", reasoning: true, contextWindow: 222222, maxTokens: 33333,
        thinkingLevelMap: { max: null }, compat }] } } })}\n`;
    await writeFile(file, source);
    binding = await startPiProviderLoopback({ model: "paperclip/child-proof", environment: { HOME: home,
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1",
      PAPERCLIP_AI_PROVIDER_AUTH: "none" } });
    const provider = JSON.parse(binding.json).providers.paperclip;
    expect(provider.models).toEqual([{ id: "child-proof", input: ["text"], reasoning: true, contextWindow: 222222, maxTokens: 33333,
      thinkingLevelMap: { max: null }, compat: { supportsStrictTools: false, ...compat, ...managedAffinity } }]);
    expect(provider.api).toBe("anthropic-messages");
    expect(provider.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(binding.json).not.toContain("source-key-canary");
    expect(binding.json).not.toContain("unused.invalid");
    expect(await readFile(file, "utf8")).toBe(source);
  } finally {
    await binding?.close();
    await rm(home, { recursive: true, force: true });
  }
}, 15000);

it.each(["anthropic-messages", "openai-completions"])("supersedes(pre-overlay affinity expectation; RFL record P1C5-OVERLAY-EXPECTATIONS) uses the explicit original Pi directory and guards compat against actual protocol: %s", async sourceApi => {
  const root = await mkdtemp(join(tmpdir(), "pi-child-explicit-"));
  let binding: Awaited<ReturnType<typeof startPiProviderLoopback>> | undefined;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const agent = join(root, "selected-agent");
    await mkdir(agent);
    const file = join(agent, "models.json");
    const source = JSON.stringify({ providers: { native: { api: sourceApi, compat: { forceAdaptiveThinking: false },
      models: [{ id: "explicit-proof", contextWindow: 123456, maxTokens: 12345, reasoning: false, thinkingLevelMap: { max: null } }] } } });
    await writeFile(file, source);
    binding = await startPiProviderLoopback({ model: "paperclip/explicit-proof", environment: {
      HOME: join(root, "unused-home"), PI_CODING_AGENT_DIR: agent,
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1", PAPERCLIP_AI_PROVIDER_AUTH: "none" } });
    expect(JSON.parse(binding.json).providers.paperclip.models).toEqual([{ id: "explicit-proof", contextWindow: 123456,
      input: ["text"], maxTokens: 12345, reasoning: false, thinkingLevelMap: { max: null },
      compat: { ...(sourceApi === "anthropic-messages" ? { forceAdaptiveThinking: false } : {}), ...managedAffinity } }]);
    // The overlay's text-only input default always reports one bounded line;
    // only the mismatched protocol adds the compat-guard diagnostic to it.
    expect(warn).toHaveBeenCalledTimes(1);
    if (warn.mock.calls.length) {
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain("image capability unknown; using text-only input");
      if (sourceApi === "anthropic-messages") expect(line).not.toContain("skipping compat");
      else expect(line).toContain("source API mismatch; skipping compat");
      expect(line.length).toBeLessThanOrEqual(256);
      expect(line).not.toContain(root);
      expect(line.split("\n")).toHaveLength(1);
    }
    expect(await readFile(file, "utf8")).toBe(source);
  } finally {
    warn.mockRestore();
    await binding?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
