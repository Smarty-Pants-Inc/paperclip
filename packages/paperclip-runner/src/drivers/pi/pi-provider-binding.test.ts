import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiProviderBinding, directPiProviderConfiguration, startPiProviderLoopback, usesPiProviderLoopback } from "../acpx/pi-provider-loopback.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

type Provider = Awaited<ReturnType<typeof createPiProviderBinding>>["provider"];
const routes = [
  { protocol: "chat", api: "openai-completions", basePath: "/v1", suffix: "/chat/completions", upstreamPath: "/v1/chat/completions", auth: "bearer" },
  { protocol: "messages", api: "anthropic-messages", basePath: "", suffix: "/v1/messages", upstreamPath: "/v1/messages", auth: "api_key" },
  { protocol: "responses", api: "openai-responses", basePath: "/v1", suffix: "/responses", upstreamPath: "/v1/responses", auth: "bearer" },
] as const;
type Route = typeof routes[number];

async function fixture(route: Route) {
  const home = await mkdtemp(join(tmpdir(), "pi-provider-binding-"));
  const received: Array<{ path?: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    PAPERCLIP_AI_PROVIDER_URL: `http://127.0.0.1:${address.port}${route.basePath}`,
    PAPERCLIP_AI_PROVIDER_PROTOCOL: route.protocol,
    PAPERCLIP_AI_PROVIDER_AUTH: route.auth,
    PAPERCLIP_AI_PROVIDER_KEY: "upstream-binding-alpha-canary",
  };
  return { environment, received };
}

// Use a fresh physical connection so revocation must be ECONNREFUSED, not an HTTP denial.
function post(provider: Pick<Provider, "baseUrl" | "apiKey">, route: Route, body = '{"model":"vendor/model","messages":[]}', token = provider.apiKey): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(`${provider.baseUrl}${route.suffix}`, {
      method: "POST",
      agent: false,
      headers: { "content-type": "application/json", ...(route.protocol === "messages" ? { "x-api-key": token } : { authorization: `Bearer ${token}` }) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

describe("Pi in-memory provider binding", () => {
  // Trust boundary: each generation gets a revocable capability, never the reusable upstream key.
  it.each(routes)("isolates two paperclip generations and physically revokes only the old $protocol endpoint", async route => {
    const { environment, received } = await fixture(route);
    const upstreamKeys = [environment.PAPERCLIP_AI_PROVIDER_KEY!, "upstream-binding-beta-canary"];
    const sensitive: Array<readonly string[]> = [];
    const first = await createPiProviderBinding({ model: "paperclip/vendor/model", environment, onSensitiveValues: values => sensitive.push(values) });
    cleanups.push(first.close);
    const captured = first.provider;
    environment.PAPERCLIP_AI_PROVIDER_KEY = upstreamKeys[1];
    const second = await createPiProviderBinding({ model: "paperclip/vendor/model", environment, onSensitiveValues: values => sensitive.push(values) });
    cleanups.push(second.close);

    for (const binding of [first, second]) {
      expect(binding.provider).toEqual({
        name: "paperclip", api: route.api,
        baseUrl: expect.stringMatching(route.protocol === "messages" ? /^http:\/\/127\.0\.0\.1:\d+$/ : /^http:\/\/127\.0\.0\.1:\d+\/v1$/),
        apiKey: expect.any(String), models: [{ id: "vendor/model" }],
      });
      expect(binding.provider.apiKey.length).toBeGreaterThanOrEqual(32);
      for (const key of upstreamKeys) expect(JSON.stringify(binding.provider)).not.toContain(key);
      expect(JSON.stringify(binding.provider)).not.toContain(environment.PAPERCLIP_AI_PROVIDER_URL);
    }
    expect(second.provider).not.toBe(captured);
    expect(second.provider.baseUrl).not.toBe(captured.baseUrl);
    expect(second.provider.apiKey).not.toBe(captured.apiKey);
    expect(sensitive).toEqual([[captured.apiKey, upstreamKeys[0]], [second.provider.apiKey, upstreamKeys[1]]]);

    expect(await post(captured, route)).toEqual({ status: 200, body: '{"ok":true}' });
    expect(await post(second.provider, route)).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await post(second.provider, route, undefined, captured.apiKey)).status).toBe(401);
    expect((await post(captured, route, undefined, second.provider.apiKey)).status).toBe(401);

    await Promise.all([first.close(), first.close()]);
    await expect(post(captured, route)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(await post(second.provider, route)).toEqual({ status: 200, body: '{"ok":true}' });
    expect(received.map(item => ({ path: item.path, key: route.protocol === "messages" ? item.headers["x-api-key"] : item.headers.authorization, body: item.body }))).toEqual(
      [upstreamKeys[0], upstreamKeys[1], upstreamKeys[1]].map(key => ({ path: route.upstreamPath, key: route.protocol === "messages" ? key : `Bearer ${key}`, body: { model: "vendor/model", messages: [] } })),
    );
    expect(JSON.stringify(received)).not.toContain(captured.apiKey);
    expect(JSON.stringify(received)).not.toContain(second.provider.apiKey);
    expect(environment.PAPERCLIP_AI_PROVIDER_KEY).toBe(upstreamKeys[1]);
    await second.close();
    await expect(post(second.provider, route)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it.each(routes)("preserves capability-aware $protocol models.json configuration and physical close", async route => {
    const { environment } = await fixture(route);
    const loopback = await startPiProviderLoopback({ model: "paperclip/vendor/model", environment });
    cleanups.push(loopback.close);
    const provider = JSON.parse(loopback.json).providers.paperclip;
    expect(JSON.parse(loopback.json)).toEqual({ providers: { paperclip: {
      baseUrl: expect.stringMatching(route.protocol === "messages" ? /^http:\/\/127\.0\.0\.1:\d+$/ : /^http:\/\/127\.0\.0\.1:\d+\/v1$/),
      api: route.api, apiKey: expect.any(String),
      models: [{ id: "vendor/model", input: ["text"], reasoning: true, contextWindow: 128000, maxTokens: 8192,
        thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } }],
    } } });
    expect(provider.apiKey.length).toBeGreaterThanOrEqual(32);
    expect(loopback.json).not.toContain(environment.PAPERCLIP_AI_PROVIDER_KEY);
    expect(await post(provider, route)).toEqual({ status: 200, body: '{"ok":true}' });
    await Promise.all([loopback.close(), loopback.close()]);
    await expect(post(provider, route)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it.each(routes)("validates $protocol requests at the existing broker boundary", async route => {
    const { environment, received } = await fixture(route);
    const binding = await createPiProviderBinding({ model: "vendor/model", environment });
    cleanups.push(binding.close);
    expect(binding.provider.models).toEqual([{ id: "vendor/model" }]);
    expect((await post(binding.provider, route, undefined, "invalid-capability")).status).toBe(401);
    for (const body of ["{", "null", "[]", '"not an object"']) {
      expect((await post(binding.provider, route, body)).status).toBe(400);
    }
    expect(received).toEqual([]);
    expect((await post(binding.provider, route)).status).toBe(200);
    expect(received).toHaveLength(1);
  });

  it.each(routes)("allows explicit no-auth $protocol without sending any upstream credential", async route => {
    const { environment, received } = await fixture(route);
    environment.PAPERCLIP_AI_PROVIDER_AUTH = "none";
    delete environment.PAPERCLIP_AI_PROVIDER_KEY;
    const sensitive: Array<readonly string[]> = [];
    const binding = await createPiProviderBinding({ model: "paperclip/vendor/model", environment, onSensitiveValues: values => sensitive.push(values) });
    cleanups.push(binding.close);
    expect(sensitive).toEqual([[binding.provider.apiKey]]);
    expect((await post(binding.provider, route)).status).toBe(200);
    expect(received[0]!.headers.authorization).toBeUndefined();
    expect(received[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it.each([undefined, "", "unknown", "__proto__", "toString"])("fails closed for unsupported protocol %s", async protocol => {
    await expect(createPiProviderBinding({ model: "paperclip/model", environment: {
      PAPERCLIP_AI_PROVIDER_PROTOCOL: protocol, PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_AUTH: "none",
    } })).rejects.toThrow("Pi managed provider protocol is unsupported");
  });

  it.each([
    { model: "paperclip/" },
    { model: "" },
    { PAPERCLIP_AI_PROVIDER_URL: undefined },
    { PAPERCLIP_AI_PROVIDER_AUTH: undefined },
    { PAPERCLIP_AI_PROVIDER_AUTH: "unsupported" },
    { PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "" },
    { PAPERCLIP_AI_PROVIDER_AUTH: "api_key", PAPERCLIP_AI_PROVIDER_KEY: undefined },
  ])("rejects an incomplete managed connection: %j", async ({ model = "paperclip/model", ...overrides }) => {
    await expect(createPiProviderBinding({ model, environment: {
      PAPERCLIP_AI_PROVIDER_PROTOCOL: "chat", PAPERCLIP_AI_PROVIDER_URL: "http://127.0.0.1:1/v1", PAPERCLIP_AI_PROVIDER_AUTH: "bearer", PAPERCLIP_AI_PROVIDER_KEY: "upstream-canary", ...overrides,
    } })).rejects.toThrow("Pi managed provider connection is incomplete");
  });

  it.each(routes)("leaves direct-key configuration and managed-mode detection unchanged for $protocol", route => {
    const environment = Object.freeze({ PAPERCLIP_AI_PROVIDER_PROTOCOL: route.protocol, PAPERCLIP_AI_PROVIDER_URL: `https://upstream.example${route.basePath}`, PAPERCLIP_AI_PROVIDER_AUTH: route.auth, PAPERCLIP_AI_PROVIDER_KEY: "direct-only-canary" });
    expect(directPiProviderConfiguration({ model: "paperclip/vendor/model", environment })).toEqual({
      json: `${JSON.stringify({ providers: { paperclip: { baseUrl: environment.PAPERCLIP_AI_PROVIDER_URL, api: route.api, apiKey: "direct-only-canary", models: [{ id: "vendor/model" }] } } })}\n`,
      key: "direct-only-canary",
    });
    expect(usesPiProviderLoopback("paperclip/vendor/model", environment)).toBe(true);
    expect(usesPiProviderLoopback("native/model", environment)).toBe(false);
    expect(usesPiProviderLoopback("paperclip/vendor/model", {})).toBe(false);
    expect(usesPiProviderLoopback("paperclip/vendor/model")).toBe(false);
  });
});
