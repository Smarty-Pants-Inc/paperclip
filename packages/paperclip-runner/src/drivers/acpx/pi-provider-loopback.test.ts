import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { configuredEnvironmentProjection } from "../../configured-environment.js";
import { createSanitizedAcpxSpawnInput } from "./environment.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { createAcpxRecoveryBinding } from "./recovery-identity.js";
import { prepareAcpxRuntimeSandbox } from "./runtime-sandbox.js";
import { createPiProviderBinding, directPiProviderConfiguration, startPiProviderLoopback } from "./pi-provider-loopback.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

const key = "reusable-provider-key-canary";
const childFallback = { id: "vendor/model", input: ["text"], contextWindow: 128000, maxTokens: 8192, reasoning: true,
  thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
function environment(url: string) {
  const routing = { PAPERCLIP_AI_PROVIDER_URL: url, PAPERCLIP_AI_PROVIDER_PROTOCOL: "messages", PAPERCLIP_AI_PROVIDER_AUTH: "api_key", PAPERCLIP_AI_PROVIDER_KEY: key };
  return { ...routing, ...configuredEnvironmentProjection(routing), PATH: process.env.PATH };
}

async function binding(model = "paperclip/vendor/model") {
  const root = await mkdtemp(join(tmpdir(), "paperclip-pi-loopback-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workingDirectory = join(root, "workspace");
  const runtimeDirectory = join(root, "runtime");
  await mkdir(workingDirectory); await mkdir(runtimeDirectory);
  return createAcpxRecoveryBinding({ runtimeDirectory, workingDirectory, normalizedSessionId: "pi-loopback", profile: resolveQualifiedAcpxProfile("pi", model), requestedModel: model, piThinkingLevel: "low", permissionMode: "approve-reads" });
}

describe("Pi managed provider loopback", () => {
  it.each(["low", "xhigh", "max"] as const)("passes native config capabilities unchanged, independently of requested effort %s", async thinkingLevel => {
    const metadata = { id: "vendor/model", reasoning: true, contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: { max: null },
      compat: { forceAdaptiveThinking: true, supportsTemperature: false, futureMetadata: { optional: null, values: [false, "kept"] } } };
    const binding = await createPiProviderBinding({ model: "paperclip/vendor/model", environment: environment("http://127.0.0.1:1"), thinkingLevel, modelConfiguration: metadata });
    cleanups.push(binding.close);
    expect(binding.provider.models).toEqual([metadata]);
    const direct = directPiProviderConfiguration({ model: "paperclip/vendor/model", environment: environment("http://127.0.0.1:1"), thinkingLevel, modelConfiguration: metadata });
    expect(JSON.parse(direct.json).providers.paperclip.models).toEqual([metadata]);
  });

  it("never invents a requested-level-only capability map", async () => {
    const binding = await createPiProviderBinding({ model: "paperclip/vendor/model", environment: environment("http://127.0.0.1:1"), thinkingLevel: "max" });
    cleanups.push(binding.close);
    expect(binding.provider.models).toEqual([{ id: "vendor/model" }]);
  });

  it("materializes documented child fallback capabilities without a selected catalog or config", async () => {
    const binding = await startPiProviderLoopback({ model: "paperclip/vendor/model", environment: environment("http://127.0.0.1:1") });
    cleanups.push(binding.close);
    const provider = JSON.parse(binding.json).providers.paperclip;
    expect(provider).toEqual({ baseUrl: provider.baseUrl, api: "anthropic-messages", apiKey: provider.apiKey, models: [childFallback] });
    expect(binding.json.endsWith("\n")).toBe(true);
  });

  it.each([undefined, "off"] as const)("keeps absent/off thinking metadata non-reasoning: %s", async thinkingLevel => {
    const binding = await createPiProviderBinding({ model: "paperclip/vendor/model", environment: environment("http://127.0.0.1:1"), thinkingLevel });
    cleanups.push(binding.close);
    expect(binding.provider.models).toEqual([{ id: "vendor/model" }]);
    const direct = directPiProviderConfiguration({ model: "paperclip/vendor/model", environment: environment("http://127.0.0.1:1"), thinkingLevel });
    expect(direct.json).toBe(`${JSON.stringify({ providers: { paperclip: { baseUrl: "http://127.0.0.1:1", api: "anthropic-messages", apiKey: key, models: [{ id: "vendor/model" }] } } })}\n`);
  });

  it("refuses an invalid native thinking level before allocating a broker", async () => {
    await expect(createPiProviderBinding({ model: "paperclip/vendor/model", environment: environment("http://127.0.0.1:1"), thinkingLevel: "unsupported" as never }))
      .rejects.toThrow("Pi managed model thinking level");
  });

  it("writes only the session capability to models.json and routes a real Messages request", async () => {
    let received: { path?: string; key?: string; body: unknown } | undefined;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      received = { path: req.url, key: req.headers["x-api-key"] as string, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.end('{"type":"message"}');
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    cleanups.push(() => new Promise<void>(resolve => { upstream.close(() => resolve()); upstream.closeAllConnections(); }));
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing test listener");
    const inputEnvironment = environment(`http://127.0.0.1:${address.port}`);
    const sensitive: string[] = [];
    const sandbox = await prepareAcpxRuntimeSandbox({ binding: await binding(), agent: "pi", providerPolicy: { readOnly: false }, environment: inputEnvironment, onSensitiveValues: values => sensitive.push(...values) });
    cleanups.push(() => sandbox.closeOwnedConfiguration?.() ?? Promise.resolve());
    await sandbox.initializeOwnedConfiguration?.();
    const path = join(sandbox.agentHomeDirectory, "models.json");
    const text = await readFile(path, "utf8");
    expect(text).not.toContain(key);
    const config = JSON.parse(text);
    const provider = config.providers.paperclip;
    expect(provider).toEqual({ baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), api: "anthropic-messages", apiKey: expect.any(String), models: [childFallback] });
    expect(provider.apiKey).not.toBe(key);
    expect(provider.apiKey.length).toBeGreaterThanOrEqual(32);
    expect(sensitive).toContain(provider.apiKey);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(Object.keys(sandbox.launchEnvironment).filter(name => name.startsWith("PAPERCLIP_AI_PROVIDER_"))).toEqual([]);
    expect(Object.keys(sandbox.persistedEnvironment).filter(name => name.startsWith("PAPERCLIP_AI_PROVIDER_"))).toEqual([]);
    expect(JSON.stringify(sandbox.persistedEnvironment)).not.toContain(key);
    const response = await fetch(`${provider.baseUrl}/v1/messages`, { method: "POST", headers: { "x-api-key": provider.apiKey, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "vendor/model", messages: [] }) });
    expect(response.status).toBe(200);
    expect(received).toEqual({ path: "/v1/messages", key, body: { model: "vendor/model", messages: [] } });
    await sandbox.closeOwnedConfiguration?.();
    await expect(fetch(`${provider.baseUrl}/v1/messages`)).rejects.toThrow();
    expect(inputEnvironment.PAPERCLIP_AI_PROVIDER_KEY).toBe(key);
  });

  it("scrubs managed provider values at the Pi child launch boundary, including task projections", () => {
    const spawn = createSanitizedAcpxSpawnInput(environment("https://gateway.example"), "pi");
    expect(Object.keys(spawn.env).filter(name => name.startsWith("PAPERCLIP_AI_PROVIDER_"))).toEqual([]);
    expect(JSON.stringify(spawn.env)).not.toContain(key);
    expect(spawn.env.PAPERCLIP_CONFIGURED_ENV_KEYS).not.toContain("PAPERCLIP_AI_PROVIDER_");
  });

  it.each(["unknown"])("fails closed for unsupported managed protocol %s", async protocol => {
    const sandbox = await prepareAcpxRuntimeSandbox({ binding: await binding(), agent: "pi", providerPolicy: { readOnly: false }, environment: { ...environment("http://127.0.0.1:1"), PAPERCLIP_AI_PROVIDER_PROTOCOL: protocol } });
    cleanups.push(() => sandbox.closeOwnedConfiguration?.() ?? Promise.resolve());
    await expect(sandbox.initializeOwnedConfiguration?.()).rejects.toThrow("Pi managed provider protocol is unsupported");
  });

  it("keeps unmanaged provider configuration unchanged", async () => {
    const sandbox = await prepareAcpxRuntimeSandbox({ binding: await binding("custom/model"), agent: "pi", providerPolicy: { readOnly: false }, environment: { PAPERCLIP_PI_PROVIDERS: JSON.stringify({ custom: { baseUrl: "https://custom.example/v1", api: "openai-completions", apiKey: "custom-token", models: [{ id: "model" }] } }) } });
    const config = JSON.parse(await readFile(join(sandbox.agentHomeDirectory, "models.json"), "utf8"));
    expect(config.providers.custom.apiKey).toBe("custom-token");
    expect(sandbox.initializeOwnedConfiguration).toBeUndefined();
  });
});
