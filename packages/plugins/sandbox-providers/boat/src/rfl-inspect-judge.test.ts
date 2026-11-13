// Independent judge: keep for retirement trust boundary, data safety, and failure paths unsafe to seed live.
// All credentials and provider bodies below are invented fixtures, never real secrets.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import plugin from "./plugin.js";
const id = "bx_23456789";
const scope = { driverKey: "boat", companyId: "judge-company", environmentId: "judge-environment", config: { apiKey: "rfl-noncredential-canary" }, providerLeaseId: id };
const inspect = (changes: Record<string, unknown> = {}) => plugin.definition.onEnvironmentInspectLease!({ ...scope, ...changes } as any);
const reply = (body: unknown, status = 200, date?: string) => new Response(JSON.stringify(body), { status, headers: date === undefined ? {} : { Date: date } });
let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(e => e ? reject(e) : resolve())); server = undefined; }
});
describe("RFL independent mapping", () => {
  it.each([
    ["ready", "active"], ["idle", "active"], ["running", "active"], ["cancelled", "destroyed"],
    ["archived", "unknown"], ["stopping", "unknown"], ["resuming", "unknown"], ["starting", "unknown"],
    ["archiving", "unknown"], ["provisioning", "unknown"], ["provisioned", "unknown"], ["init", "unknown"],
    ["cloning", "unknown"], ["error", "unknown"], ["READY", "unknown"], ["Idle", "unknown"],
    ["RUNNING", "unknown"], ["CANCELLED", "unknown"], ["ARCHIVED", "unknown"], ["cancelled-extra", "unknown"],
    [" archived", "unknown"], ["running ", "unknown"], ["stopped", "unknown"], ["destroyed", "unknown"],
    ["unknown-state", "unknown"], [null, "unknown"],
  ])("exact state %j maps to %s", async (state, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id, state } })));
    expect((await inspect()).state).toBe(expected);
  });
  it("preserves stoppedAt and lastReboot.at verbatim", async () => {
    const stoppedAt = "2026-11-13T01:00:00+02:00", reboot = "2026-11-12T00:00:00.123+00:00";
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id, state: "archived", stoppedAt, lastReboot: { at: reboot } } })));
    expect(await inspect()).toMatchObject({ state: "stopped", stoppedAt, lastRebootAt: reboot });
  });
  it("refuses another allocation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id: "bx_other", state: "cancelled" } })));
    await expect(inspect()).rejects.toThrow("different allocation");
  });
});
describe("RFL 404 is not deletion proof", () => {
  it.each([
    ["empty", null], ["routing page", "<html>route not found</html>"], ["generic JSON", "{}"],
    ["wrong organization", JSON.stringify({ ok: false, error: { code: "not_found", message: "Resource not found for organization" } })],
    ["auth proxy", JSON.stringify({ error: { code: "unauthorized", message: "API key not recognized" } })],
    ["truncated JSON", "{"],
  ])("throws for ambiguous 404: %s", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 404 })));
    await expect(inspect()).rejects.toThrow();
  });
  it("does not manufacture deletion with an empty key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ error: { code: "not_found", message: "Not found" } }, 404)));
    await expect(inspect({ config: { apiKey: "" } })).rejects.toThrow();
  });
});
describe("RFL HTTP-date", () => {
  it.each([
    ["Fri, 13 Nov 2026 12:00:00 GMT", "2026-11-13T12:00:00.000Z"],
    ["Friday, 13-Nov-26 12:00:00 GMT", "2026-11-13T12:00:00.000Z"],
    ["Fri Nov 13 12:00:00 2026", "2026-11-13T12:00:00.000Z"],
    [undefined, null], ["", null], ["not-a-date", null],
    ["0", null], ["1", null], ["1970", null], ["2026", null], ["9999", null], ["2026-11-13T12:00:00Z", null],
    ["Fri, 31 Feb 2026 12:00:00 GMT", null], ["Fri, 13 Nov 2026 12:00:00 +0500", null],
  ])("Date %j gives %j", async (date, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id, state: "ready", observedAt: "2099-01-01T00:00:00Z" } }, 200, date as string | undefined)));
    expect((await inspect()).observedAt).toBe(expected);
  });
});
describe("RFL failures and redaction", () => {
  it.each([401, 403, 429, 500, 502, 503])("HTTP %i throws", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ message: "fixture unavailable" }, status)));
    await expect(inspect()).rejects.toThrow();
  });
  it.each(["{", "null", "", "false", "0", '""', "[]", "{}"])("invalid success %j throws", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(inspect()).rejects.toThrow();
  });
  it("network error throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fixture transport error"); }));
    await expect(inspect()).rejects.toThrow();
  });
  it("does not expose a short configured key in JSON parse diagnostics", async () => {
    const canary = "rfl_x"; // Invented noncredential, deliberately shorter than Node's error-body preview.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${canary} invalid JSON`)));
    let thrown: unknown;
    try { await inspect({ config: { apiKey: canary } }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown).includes(canary)).toBe(false);
  });
  it.each(["message", "nested", "statusText", "network", "parse"])("does not expose configured key from %s", async source => {
    const canary = scope.config.apiKey;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (source === "network") throw new TypeError(`fixture error ${canary}`);
      if (source === "parse") return new Response(`bad JSON ${canary}`);
      if (source === "statusText") return new Response(null, { status: 503, statusText: `fixture ${canary}` });
      return reply(source === "nested" ? { error: { message: `fixture ${canary}` } } : { message: `fixture ${canary}` }, 401);
    }));
    let thrown: unknown;
    try { await inspect(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    // Boolean assertion keeps even this deliberately nonsecret canary out of failure diagnostics.
    expect(String(thrown).includes(canary)).toBe(false);
  });
});
async function loopback(handler: Parameters<typeof createServer>[0]) {
  server = createServer(handler as any);
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => realFetch(`http://127.0.0.1:${address.port}/sandbox`, init)));
}
describe("RFL native HTTP, real clock, no Boat access", () => {
  it("two independent calls see changed data and send cache bypass headers", async () => {
    let count = 0; const cache: unknown[] = [];
    await loopback((req: any, res: any) => {
      cache.push(req.headers["cache-control"]); count++;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ sandbox: { id, state: count === 1 ? "idle" : "cancelled" } }));
    });
    expect((await inspect()).state).toBe("active");
    expect((await inspect()).state).toBe("destroyed");
    expect(count).toBe(2); expect(cache).toEqual(["no-cache", "no-cache"]);
  });
  it.each(["headers", "body"])("enforces 10s for stalled %s with native fetch", async part => {
    await loopback((_req: any, res: any) => {
      if (part === "body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"sandbox":'); }
    });
    const start = performance.now();
    await expect(inspect()).rejects.toThrow();
    const elapsed = performance.now() - start;
    console.log(JSON.stringify({ check: `real-${part}-timeout`, elapsedMs: Math.round(elapsed) }));
    expect(elapsed).toBeGreaterThanOrEqual(9800); expect(elapsed).toBeLessThan(11500);
  }, 15000);
});
