import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Agent as HttpAgent, createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as requestHttps } from "node:https";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { getCACertificates } from "node:tls";

export type LoopbackProtocol = "chat" | "messages" | "responses";
export type LoopbackUpstreamAuth = "bearer" | "api_key" | "none";

/** Protocol-owned paths and headers; the broker owns capability lifetime and transport. */
export interface LoopbackRouteAdapter {
  protocol: LoopbackProtocol;
  localPath: string;
  upstreamUrl(baseUrl: string): URL;
  authorize(headers: IncomingHttpHeaders, token: string): boolean;
  upstreamHeaders(input: { key: string; auth: LoopbackUpstreamAuth; incoming: IncomingHttpHeaders }): Record<string, string>;
  harnessBaseUrl(port: number): string;
}

/** Compare a single credential header without a data-dependent token comparison. */
export function loopbackTokenMatches(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const token = Buffer.from(expected);
  return actual.length === token.length && timingSafeEqual(actual, token);
}

/** Keep the reusable provider key in the runner; give the harness a revocable session capability. */
export async function startProviderLoopbackBroker(input: {
  adapter: LoopbackRouteAdapter;
  baseUrl: string;
  key: string;
  auth: LoopbackUpstreamAuth;
  model?: string;
  rejectFields?: string[];
  transformPayload?(payload: Record<string, unknown>): boolean;
  extraUpstreamHeaders?: Record<string, string>;
  environment: NodeJS.ProcessEnv;
}): Promise<{ baseURL: string; token: string; close(): Promise<void> }> {
  const upstreamUrl = input.adapter.upstreamUrl(input.baseUrl);
  const token = randomBytes(32).toString("base64url");
  const environment = input.environment;
  const proxyEnv = {
    HTTP_PROXY: environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    HTTPS_PROXY: environment.https_proxy ?? environment.HTTPS_PROXY ?? environment.http_proxy ?? environment.HTTP_PROXY ?? environment.all_proxy ?? environment.ALL_PROXY,
    NO_PROXY: environment.no_proxy ?? environment.NO_PROXY,
  };
  const ca = [...getCACertificates("default")];
  if (environment.SSL_CERT_FILE) ca.push(await readFile(environment.SSL_CERT_FILE, "utf8"));
  if (environment.SSL_CERT_DIR) {
    for (const entry of await readdir(environment.SSL_CERT_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        const certificate = await readFile(join(environment.SSL_CERT_DIR, entry.name), "utf8");
        if (certificate.includes("-----BEGIN CERTIFICATE-----")) ca.push(certificate);
      }
    }
  }
  const agent = upstreamUrl.protocol === "https:" ? new HttpsAgent({ proxyEnv, ca }) : new HttpAgent({ proxyEnv });
  const controllers = new Set<AbortController>();
  let active = true;
  const server = createServer((request, response) => {
    if (!active) { response.writeHead(401).end(); return; }
    const controller = new AbortController();
    controllers.add(controller);
    response.once("close", () => controller.abort());
    void (async () => {
      if (!input.adapter.authorize(request.headers, token)) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== "POST" || request.url !== input.adapter.localPath) {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let body = Buffer.concat(chunks);
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(body.toString("utf8")); }
      catch { response.writeHead(400).end(); return; }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || (input.model !== undefined && payload.model !== input.model)
        || input.rejectFields?.some(field => Object.hasOwn(payload, field))) {
        response.writeHead(400).end();
        return;
      }
      if (input.transformPayload?.(payload)) body = Buffer.from(JSON.stringify(payload), "utf8");
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = (upstreamUrl.protocol === "https:" ? requestHttps : requestHttp)(upstreamUrl, {
          method: "POST",
          agent,
          headers: {
            ...input.extraUpstreamHeaders,
            "Content-Type": "application/json",
            "Content-Length": body.length,
            ...input.adapter.upstreamHeaders({ key: input.key, auth: input.auth, incoming: request.headers }),
          },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
        }, resolve);
        outgoing.once("error", reject);
        outgoing.end(body);
      });
      const status = upstream.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstream.destroy();
        throw new Error("Provider redirects are not supported");
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(upstream.headers)) {
        const allowed = ["content-type", "content-encoding", "cache-control", "retry-after"].includes(name)
          || (input.adapter.protocol !== "chat" && (name === "request-id" || name === "x-request-id" || name.startsWith("anthropic-")));
        if (allowed && typeof value === "string") headers[name] = value;
      }
      response.writeHead(status, headers);
      await pipeline(upstream, response);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502).end("Provider request failed");
      else response.destroy();
    }).finally(() => controllers.delete(controller));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { agent.destroy(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    agent.destroy();
    throw new Error("Could not bind provider loopback broker");
  }
  let closing: Promise<void> | undefined;
  return {
    baseURL: input.adapter.harnessBaseUrl(address.port),
    token,
    close: () => closing ??= (async () => {
      active = false;
      for (const controller of controllers) controller.abort();
      agent.destroy();
      server.closeAllConnections();
      // Keep a short loopback-only revocation tombstone so an escaped session
      // capability receives an explicit 401 instead of being silently reused.
      const timer = setTimeout(() => { server.close(); server.closeAllConnections(); }, 1_000);
      timer.unref();
    })(),
  };
}
