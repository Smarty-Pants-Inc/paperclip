import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProviderLoopbackBroker } from "./broker.js";
import { chatLoopbackAdapter } from "./chat.js";
import { messagesLoopbackAdapter } from "./messages.js";
import { responsesLoopbackAdapter } from "./responses.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(auth: "bearer" | "api_key" | "none" = "api_key") {
  const received: Array<{ path?: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const baseUrl = await listen(createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { "content-type": "application/json", "request-id": "upstream-request", "anthropic-ratelimit-requests-remaining": "10", "set-cookie": "not-forwarded" });
    res.end('{"ok":true}');
  }));
  const broker = await startProviderLoopbackBroker({ adapter: messagesLoopbackAdapter, baseUrl, key: "reusable-upstream-key", auth, environment: {} });
  cleanups.push(broker.close);
  return { broker, received };
}

function post(base: string, token: string, headers: Record<string, string> = {}, body: unknown = { model: "vendor/model", messages: [] }) {
  return fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": token, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("provider loopback broker", () => {
  // Keep reason: real streaming HTTP boundary; simulate wall time rather than
  // spending ten minutes to reproduce a total-vs-idle provider cutoff.
  it("keeps a stream alive past ten minutes when bytes arrive within the default 120-second idle deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms).unref(); return controller.signal;
    });
    let write!: (text: string) => void, finish!: () => void;
    const baseUrl = await listen(createServer((req, res) => {
      req.resume(); res.writeHead(200, { "content-type": "text/event-stream" }); res.write("start\n");
      write = text => { res.write(text); }; finish = () => { res.end("done\n"); };
    }));
    const broker = await startProviderLoopbackBroker({ adapter: messagesLoopbackAdapter, baseUrl, key: "local-only", auth: "api_key", environment: {} }); cleanups.push(broker.close);
    const response = await post(broker.baseURL, broker.token); const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("start\n");
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(119_000);
      write(`chunk-${i}\n`);
      expect(Buffer.from((await reader.read()).value!).toString()).toBe(`chunk-${i}\n`);
    }
    finish(); let output = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += Buffer.from(chunk.value).toString(); }
    expect(output).toBe("done\n");
  });
  it("aborts a byte-idle streaming upstream at its configured deadline and leaves the broker reusable", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let count = 0;
    const baseUrl = await listen(createServer((req, res) => { req.resume(); if (++count === 1) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("start\n"); } else res.end("next succeeds"); }));
    const broker = await startProviderLoopbackBroker({ adapter: messagesLoopbackAdapter, baseUrl, key: "local-only", auth: "api_key", environment: { PAPERCLIP_PROVIDER_IDLE_TIMEOUT_MS: "2000" } }); cleanups.push(broker.close);
    const response = await post(broker.baseURL, broker.token); const reader = response.body!.getReader(); await reader.read();
    const next = reader.read(); const rejected = expect(next).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(2001);
    await rejected;
    expect(await (await post(broker.baseURL, broker.token)).text()).toBe("next succeeds");
  });
  // Incident: installed Pi's Anthropic SDK uses /v1/messages?beta=true.
  // Preserve query bytes without relaxing the fixed route or credential boundary.
  it.each([messagesLoopbackAdapter, chatLoopbackAdapter, responsesLoopbackAdapter])(
    "preserves $protocol paths and query strings without changing authentication", async adapter => {
      const received: Array<{ path?: string; headers: IncomingHttpHeaders }> = [];
      const baseUrl = await listen(createServer((req, res) => {
        req.resume(); received.push({ path: req.url, headers: req.headers }); res.end("ok");
      }));
      const broker = await startProviderLoopbackBroker({ adapter,
        baseUrl: `${baseUrl}${adapter.protocol === "messages" ? "" : "/v1"}`,
        key: "upstream-query-key", auth: "api_key", environment: {} });
      cleanups.push(broker.close);
      const origin = new URL(broker.baseURL).origin;
      const call = (path: string, token = broker.token) => fetch(`${origin}${path}`, {
        method: "POST", headers: { "x-api-key": token, authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "faux", messages: [] }),
      });
      expect((await call(`${adapter.localPath}?beta=true`)).status).toBe(200);
      expect((await call(`${adapter.localPath}?beta=true&encoded=%2f+%20&repeat=1&repeat=2`)).status).toBe(200);
      expect((await call(adapter.localPath)).status).toBe(200);
      expect((await call("/v1/other?beta=true")).status).toBe(404);
      expect((await call(`${adapter.localPath}?beta=true`, "wrong")).status).toBe(401);
      expect(received.map(row => row.path)).toEqual([
        `${adapter.localPath}?beta=true`, `${adapter.localPath}?beta=true&encoded=%2f+%20&repeat=1&repeat=2`, adapter.localPath,
      ]);
      expect(JSON.stringify(received)).not.toContain(broker.token);
      for (const row of received) {
        expect(row.headers[adapter.protocol === "messages" ? "x-api-key" : "authorization"])
          .toBe(adapter.protocol === "messages" ? "upstream-query-key" : "Bearer upstream-query-key");
      }
    },
  );
  it.each(["x-api-key", "authorization"])('accepts Messages %s without forwarding the session token', async header => {
    const { broker, received } = await fixture();
    const response = await post(broker.baseURL, header === "authorization" ? "invalid" : broker.token, {
      ...(header === "authorization" ? { authorization: `Bearer ${broker.token}` } : {}),
      "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta", "x-untrusted": "ignored",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(received).toEqual([{ path: "/v1/messages", body: { model: "vendor/model", messages: [] }, headers: expect.objectContaining({ "x-api-key": "reusable-upstream-key", "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta" }) }]);
    expect(received[0]!.headers.authorization).toBeUndefined();
    expect(received[0]!.headers["x-untrusted"]).toBeUndefined();
    expect(JSON.stringify(received)).not.toContain(broker.token);
    expect(response.headers.get("request-id")).toBe("upstream-request");
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("10");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it.each(["bearer", "none"] as const)("uses upstream %s authentication", async auth => {
    const { broker, received } = await fixture(auth);
    expect((await post(broker.baseURL, broker.token)).status).toBe(200);
    expect(received[0]!.headers.authorization).toBe(auth === "bearer" ? "Bearer reusable-upstream-key" : undefined);
    expect(received[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("rejects bad credentials, wrong routes and invalid payloads without contacting upstream", async () => {
    const { broker, received } = await fixture();
    expect((await post(broker.baseURL, "bad")).status).toBe(401);
    expect((await fetch(`${broker.baseURL}/v1/wrong`, { headers: { "x-api-key": broker.token } })).status).toBe(404);
    for (const body of [null, [], "text"]) expect((await post(broker.baseURL, broker.token, {}, body)).status).toBe(400);
    expect((await fetch(`${broker.baseURL}/v1/messages`, { method: "POST", headers: { "x-api-key": broker.token }, body: "{" })).status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("rejects requests above 16 MiB", async () => {
    const { broker, received } = await fixture();
    const response = await post(broker.baseURL, broker.token, {}, { model: "model", padding: "x".repeat(16 * 1024 * 1024) });
    expect(response.status).toBe(413);
    expect(received).toHaveLength(0);
  });

  it("rejects redirects rather than sending credentials to a second destination", async () => {
    let redirected = false;
    const target = await listen(createServer((_req, res) => { redirected = true; res.end(); }));
    const baseUrl = await listen(createServer((_req, res) => { res.writeHead(307, { location: target }); res.end(); }));
    const broker = await startProviderLoopbackBroker({ adapter: messagesLoopbackAdapter, baseUrl, key: "secret", auth: "api_key", environment: {} });
    cleanups.push(broker.close);
    const response = await post(broker.baseURL, broker.token);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Provider request failed");
    expect(redirected).toBe(false);
  });

  it("streams the first event before upstream completes", async () => {
    let finish!: () => void;
    const baseUrl = await listen(createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "stream-request" });
      res.write("event: message_start\ndata: {}\n\n");
      finish = () => res.end("event: message_stop\ndata: {}\n\n");
    }));
    const broker = await startProviderLoopbackBroker({ adapter: messagesLoopbackAdapter, baseUrl, key: "secret", auth: "api_key", environment: {} });
    cleanups.push(broker.close);
    const response = await post(broker.baseURL, broker.token, {}, { model: "model", stream: true });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toContain("message_start");
    expect(response.headers.get("x-request-id")).toBe("stream-request");
    finish();
    let rest = "";
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += Buffer.from(chunk.value).toString(); }
    expect(rest).toContain("message_stop");
  });

  it("aborts in-flight upstream work and revokes the listener on close", async () => {
    let started!: () => void;
    let aborted!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
    const upstreamAborted = new Promise<void>(resolve => { aborted = resolve; });
    const baseUrl = await listen(createServer((req, res) => {
      req.resume();
      res.once("close", aborted);
      started();
    }));
    const broker = await startProviderLoopbackBroker({ adapter: messagesLoopbackAdapter, baseUrl, key: "secret", auth: "api_key", environment: {} });
    cleanups.push(broker.close);
    const pending = post(broker.baseURL, broker.token).then(() => "response", () => "aborted");
    await upstreamStarted;
    await broker.close();
    await upstreamAborted;
    expect(await pending).toBe("aborted");
    await expect(post(broker.baseURL, broker.token)).rejects.toThrow();
  });

  it("aborts an upstream request when the downstream disconnects", async () => {
    let started!: () => void;
    let aborted!: () => void;
    const upstreamStarted = new Promise<void>(resolve => { started = resolve; });
    const upstreamAborted = new Promise<void>(resolve => { aborted = resolve; });
    const baseUrl = await listen(createServer((req, res) => { req.resume(); res.once("close", aborted); started(); }));
    const broker = await startProviderLoopbackBroker({ adapter: messagesLoopbackAdapter, baseUrl, key: "secret", auth: "api_key", environment: {} });
    cleanups.push(broker.close);
    const downstream = request(`${broker.baseURL}/v1/messages`, { method: "POST", headers: { "x-api-key": broker.token } });
    downstream.on("error", () => {});
    downstream.end('{"model":"model"}');
    await upstreamStarted;
    downstream.destroy();
    await upstreamAborted;
  });

  it("preserves Chat model pinning, rejected fields and payload transformation", async () => {
    let payload: unknown;
    let headers: IncomingHttpHeaders | undefined;
    const baseUrl = await listen(createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      payload = JSON.parse(Buffer.concat(chunks).toString()); headers = req.headers;
      expect(req.url).toBe("/v1/chat/completions"); res.end("ok");
    }));
    const broker = await startProviderLoopbackBroker({ adapter: chatLoopbackAdapter, baseUrl: `${baseUrl}/v1`, key: "chat-key", auth: "api_key", model: "pinned", rejectFields: ["route"], transformPayload: body => { body.transformed = true; return true; }, extraUpstreamHeaders: { "HTTP-Referer": "https://paperclip.ing" }, environment: {} });
    cleanups.push(broker.close);
    const call = (body: unknown) => fetch(`${broker.baseURL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${broker.token}` }, body: JSON.stringify(body) });
    expect((await call({ model: "wrong" })).status).toBe(400);
    expect((await call({ model: "pinned", route: {} })).status).toBe(400);
    expect((await call({ model: "pinned" })).status).toBe(200);
    expect(payload).toEqual({ model: "pinned", transformed: true });
    expect(headers?.authorization).toBe("Bearer chat-key");
    expect(headers?.["http-referer"]).toBe("https://paperclip.ing");
  });
});
