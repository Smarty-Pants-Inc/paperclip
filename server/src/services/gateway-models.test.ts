import { randomUUID } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../middleware/logger.js";
import { listGatewayModels } from "./gateway-models.js";

const servers: Server[] = [];
async function gateway(listener: RequestListener) {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  // A distinct path keeps tests independent even if the OS reuses a port.
  return `http://127.0.0.1:${port}/${randomUUID()}`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

describe("gateway model catalog", () => {
  it("coalesces concurrent requests and caches IDs, not saved model hints, per base URL", async () => {
    let calls = 0;
    const base = await gateway((req, res) => {
      calls++;
      expect(req.url).toMatch(/\/v1\/models$/);
      res.end(JSON.stringify({ data: [{ id: "known" }, { id: "qwen/qwen3" }] }));
    });
    const headers = vi.fn(async () => ({}));
    const [first, second] = await Promise.all([listGatewayModels(base, headers), listGatewayModels(`${base}/v1/`, headers)]);
    expect(first).toEqual(new Set(["known", "qwen/qwen3"]));
    expect(second).toBe(first);
    expect(await listGatewayModels(base, headers)).toBe(first);
    expect(calls).toBe(1);
    expect(headers).toHaveBeenCalledTimes(1);
  });

  it("refreshes the catalog after five minutes", async () => {
    let model = "old", calls = 0;
    const base = await gateway((_req, res) => { calls++; res.end(JSON.stringify({ data: [{ id: model }] })); });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    expect(await listGatewayModels(base, async () => ({}))).toEqual(new Set(["old"]));
    model = "new";
    clock.mockReturnValue(now + 5 * 60_000 - 1);
    expect(await listGatewayModels(base, async () => ({}))).toEqual(new Set(["old"]));
    clock.mockReturnValue(now + 5 * 60_000 + 1);
    expect(await listGatewayModels(base, async () => ({}))).toEqual(new Set(["new"]));
    expect(calls).toBe(2);
  });

  it.each(["http-error", "malformed-json", "malformed-data", "malformed-id", "redirect"])("fails open and logs once per cache window on %s", async mode => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const base = await gateway((_req, res) => {
      calls++;
      if (mode === "http-error") { res.writeHead(503); res.end("private provider error"); }
      else if (mode === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/stolen" }); res.end(); }
      else res.end(mode === "malformed-json" ? "invalid JSON" : JSON.stringify(mode === "malformed-data" ? {} : { data: [{ id: 3 }] }));
    });
    const headers = vi.fn(async () => ({ Authorization: "Bearer fixture-private-key" }));
    expect(await listGatewayModels(base, headers)).toBeNull();
    expect(await listGatewayModels(base, headers)).toBeNull();
    expect(calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/fixture-private-key|private provider error|127\.0\.0\.1/);
  });

  it("bounds a stalled response body to roughly three seconds and caches the outage", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const base = await gateway((_req, res) => {
      calls++; res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"data":[');
    });
    const started = performance.now();
    expect(await listGatewayModels(base, async () => ({}))).toBeNull();
    expect(performance.now() - started).toBeGreaterThan(2_800);
    expect(performance.now() - started).toBeLessThan(5_500);
    expect(await listGatewayModels(base, async () => ({}))).toBeNull();
    expect(calls).toBe(1);
  });

  it("fails open for a connection refusal", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const base = await gateway((_req, res) => res.end());
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(await listGatewayModels(base, async () => ({}))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty authoritative list and keeps different gateways isolated", async () => {
    const empty = await gateway((_req, res) => res.end('{"data":[]}'));
    const other = await gateway((_req, res) => res.end('{"data":[{"id":"other"}]}'));
    expect(await listGatewayModels(empty, async () => ({}))).toEqual(new Set());
    expect(await listGatewayModels(other, async () => ({}))).toEqual(new Set(["other"]));
  });
});
