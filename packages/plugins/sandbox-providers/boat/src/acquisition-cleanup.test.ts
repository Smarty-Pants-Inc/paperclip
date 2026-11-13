import { afterEach, describe, expect, it, vi } from "vitest";
import { environmentCreationCleanupErrorData, readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

// Keep: F1 money/data-safety failure and the provider/core ownership boundary.
// Strict HTTP fixtures, not live Boat or a billing/persistence claim.
const id = "bx_23456789";
const config = { apiKey: "test-only", retainOnDestroy: true, setupScript: "false" };
const params = { driverKey: "boat", companyId: "company", environmentId: "environment", runId: "run", creationOperationId: "attempt", config };
const labels = { owner: "paperclip:company", environment: "environment", run: "run", "paperclip-acquire": "attempt" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fixture(options: { lost?: boolean; stopFailures?: number; pages?: boolean } = {}) {
  let running = true, failures = options.stopFailures ?? 0;
  const calls: { method: string; url: URL; body?: any }[] = [];
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const body = init.body && JSON.parse(init.body); calls.push({ method, url, body });
    const route = url.pathname.replace("/api/v1", "");
    if (method === "POST" && route === "/sandboxes") {
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe("attempt");
      if (options.lost) throw new TypeError("lost create reply");
      return response({ sandbox: { id } });
    }
    if (method === "GET" && route === "/sandboxes") {
      expect(url.searchParams.get("label")).toBe("paperclip-acquire=attempt");
      if (options.pages && !url.searchParams.has("cursor")) return response({ sandboxes: [{ id, labels }], pageInfo: { nextCursor: "next" } });
      return response({ sandboxes: [{ id: options.pages ? "bx_abcdefgh" : id, labels }], pageInfo: { nextCursor: null } });
    }
    if (method === "GET" && route === `/sandboxes/${id}`) return response({ sandbox: { id, state: "ready", setupStatus: "failed" } });
    if (method === "POST" && route.endsWith("/stop")) {
      expect(body).toEqual({});
      if (failures-- > 0) return response({ message: "outage" }, 503);
      return response({ operation: { id: "stop" } });
    }
    if (method === "GET" && route.endsWith("/stops/stop")) { running = false; return response({ stop: { status: "completed" } }); }
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch, running: () => running };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("acquisition recovery ownership", () => {
  it("declares and implements core's existing creation inspection contract", () => {
    expect(manifest.environmentDrivers?.[0].creationOperationVersion).toBe(1);
    expect(plugin.definition.onEnvironmentInspectLease).toBeTypeOf("function");
  });
  it("retries transient setup cleanup with non-force stop", async () => {
    const f = fixture({ stopFailures: 1 });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow("setup failed");
    expect(f.calls.filter(c => c.method === "POST" && c.url.pathname.endsWith("/stop"))).toHaveLength(2);
    expect(f.running()).toBe(false);
    expect(f.calls[0].body.labels["paperclip-acquire"]).toBe("attempt");
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
  });
  it.each([false, true])("exhausted cleanup exposes SDK serializable exact ownership after lost reply=%s", async lost => {
    const f = fixture({ lost, stopFailures: 100 });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(error => error);
    const data = environmentCreationCleanupErrorData(error);
    expect(readEnvironmentCreationCleanupError({ data })).toMatchObject({ providerLeaseId: id, observedProviderLeaseId: id, companyId: "company", environmentId: "environment", runId: "run", attemptId: "attempt", labels: { "paperclip-acquire": "attempt" } });
    expect(JSON.stringify(data)).not.toContain(config.apiKey);
    expect(f.calls.filter(c => c.method === "POST" && c.url.pathname.endsWith("/stop"))).toHaveLength(3);
    expect(f.running()).toBe(true);
  });
  it.each([undefined, false, true])("lost reply stops every paginated match with retain=%s", async retain => {
    const f = fixture({ lost: true, pages: true });
    const { retainOnDestroy: _ignored, ...legacyConfig } = config;
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...legacyConfig, ...(retain === undefined ? {} : { retainOnDestroy: retain }) } })).rejects.toThrow("lost create reply");
    const cleanups = f.calls.filter(c => c.method === "POST" && c.url.pathname !== "/api/v1/sandboxes");
    expect(cleanups.map(c => c.url.pathname)).toEqual([`/api/v1/sandboxes/${id}/stop`, "/api/v1/sandboxes/bx_abcdefgh/stop"]);
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
    expect(f.running()).toBe(false);
  });
  it("inspection returns the exact SDK cleanup envelope, not an unowned observation", async () => {
    fixture();
    const result = await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "attempt", creationOperation: { id: "attempt", runId: "run" } });
    expect(result.providerLeaseId).toBe(id);
    expect(readEnvironmentCreationCleanupError({ data: { schema: "paperclip/environment-creation-cleanup/v1", cleanup: result.creationCleanup } })).toMatchObject({ providerLeaseId: id, attemptId: "attempt", runId: "run" });
  });
  it.each(["empty", "unavailable", "foreign", "cursor-loop"])("inspection keeps %s lookup retryable rather than pretending cleanup settled", async mode => {
    vi.stubGlobal("fetch", vi.fn(async () => mode === "empty" ? response({ sandboxes: [] }) : mode === "unavailable" ? response({}, 503) : mode === "foreign" ? response({ sandboxes: [{ id, labels: { ...labels, owner: "foreign" } }] }) : response({ sandboxes: [{ id, labels }], pageInfo: { nextCursor: "loop" } })));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "attempt", creationOperation: { id: "attempt", runId: "run" } })).rejects.toThrow();
  });
  it.each([undefined, false, true])("durable orphan cleanup stops all matches and the bound ID with retain=%s", async retain => {
    fixture({ stopFailures: 100 });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(error => error);
    const cleanup = readEnvironmentCreationCleanupError(error)!;
    const f = fixture({ pages: true });
    const { retainOnDestroy: _ignored, ...legacyConfig } = config;
    expect(await plugin.definition.onEnvironmentDestroyLease!({ ...params, config: { ...legacyConfig, ...(retain === undefined ? {} : { retainOnDestroy: retain }) }, providerLeaseId: id, leaseMetadata: { failedCreateCleanup: cleanup } })).toEqual({ providerLeaseId: id, state: "stopped" });
    expect(f.calls.filter(c => c.method === "POST").map(c => c.url.pathname)).toEqual(["/api/v1/sandboxes/bx_abcdefgh/stop", `/api/v1/sandboxes/${id}/stop`]);
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
    expect(f.running()).toBe(false);
  });
  it("a timed-out create still looks up and stops the allocation", async () => {
    const f = fixture({ lost: true });
    const delegate = globalThis.fetch;
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => realTimeout(ms === 30_000 ? 5 : ms));
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      if (init.method === "POST" && new URL(String(input)).pathname === "/api/v1/sandboxes") {
        await new Promise<void>((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      }
      return delegate(input, init);
    });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toThrow();
    expect(f.calls[0].url.searchParams.get("label")).toBe("paperclip-acquire=attempt");
    expect(f.running()).toBe(false);
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
  });
  it("direct acquires mint unique labels and do not accept a configured replacement", async () => {
    const attempts: string[] = [];
    vi.stubGlobal("fetch", async (_input: any, init: any = {}) => {
      if (init.method === "POST") {
        const attempt = JSON.parse(init.body).labels["paperclip-acquire"];
        expect(attempt).toMatch(/^[0-9a-f-]{36}$/);
        expect(new Headers(init.headers).get("Idempotency-Key")).toBe(attempt);
        attempts.push(attempt);
      }
      return response({ sandbox: { id, state: "ready" } });
    });
    for (let n = 0; n < 2; n++) await plugin.definition.onEnvironmentAcquireLease!({ ...params, creationOperationId: undefined, config: { ...config, setupScript: undefined, labels: { "paperclip-acquire": "attacker-supplied" } } });
    expect(new Set(attempts).size).toBe(2);
  });
  it("rejects changed cleanup credentials before any provider call", async () => {
    fixture({ stopFailures: 100 });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(error => error);
    const cleanup = readEnvironmentCreationCleanupError(error)!;
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentDestroyLease!({ ...params, config: { ...config, apiKey: "different" }, providerLeaseId: id, leaseMetadata: { failedCreateCleanup: cleanup } })).rejects.toThrow("ownership does not match");
    expect(fetch).not.toHaveBeenCalled();
  });
});
