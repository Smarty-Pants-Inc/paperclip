import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentAcquireErrorData, PluginEnvironmentCreationCleanupError, readEnvironmentAcquisitionDiagnostic,
  readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

// The plugin polls with node:timers/promises, which fake timers do not move.
// Route it onto the faked global timer (the spare-cap.test.ts pattern).
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));

// Port of Daytona's createWithinCap / lookupCreation (#20828) and its
// provider-start failure (#22194) to Boat. Strict HTTP fixtures, not live Boat.
// A create whose reply never arrived is found by its own `paperclip-acquire`
// label (Boat list-sandboxes, boat-llms-full.txt:1791-1794; the Idempotency-Key
// makes the lost create safe, :2236-2242). A box Boat could not start is
// `error` (api/v1 lifecycle, :2255).
const BOX = "bx_adopt123";
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const params = { driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", creationOperationId: "attempt", config: cfg };
const owned = { owner: "paperclip:co", environment: "env", run: "run", "paperclip-acquire": "attempt" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { method: string; path: string; query: URLSearchParams };

function fixture(options: {
  /** The create POST: answered, timed out (our 30 s deadline), or refused. */
  create: "ok" | "timeout" | 503 | 422;
  /** Label lookups (GET /sandboxes?label=) before the box becomes visible. */
  visibleAfterLookups?: number;
  /** The box's states on each GET /sandboxes/{id}; the last repeats. */
  states?: string[];
}) {
  const calls: Call[] = [];
  let stateIndex = 0, lookups = 0, stopped = false;
  const states = options.states ?? ["ready"];
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const path = url.pathname.replace("/api/v1", "");
    calls.push({ method, path, query: url.searchParams });
    if (method === "POST" && path === "/sandboxes") {
      expect(new Headers(init.headers).get("Idempotency-Key")).toBe("attempt");
      if (options.create === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      if (typeof options.create === "number") return response({ error: { code: "refused" } }, options.create);
      return response({ sandbox: { id: BOX, state: "provisioning" } }, 202);
    }
    if (method === "GET" && path === "/sandboxes") {
      expect(url.searchParams.get("label")).toBe("paperclip-acquire=attempt");
      lookups++;
      const visible = options.visibleAfterLookups !== undefined && lookups > options.visibleAfterLookups;
      return response({ sandboxes: visible ? [{ id: BOX, labels: owned, state: states[0] }] : [], pageInfo: { nextCursor: null } });
    }
    if (method === "GET" && path === `/sandboxes/${BOX}`) {
      if (stopped) return response({ sandbox: { id: BOX, state: "archived", stop: { id: "stop_1", status: "completed" } } });
      const state = states[Math.min(stateIndex++, states.length - 1)];
      return response({ sandbox: { id: BOX, state, labels: owned, expiresAt: "2030-01-01T00:00:00Z" } });
    }
    if (method === "POST" && path === `/sandboxes/${BOX}/stop`) {
      stopped = true;
      return response({ stop: { id: "stop_1", status: "pending" } }, 202);
    }
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const creates = () => calls.filter(c => c.method === "POST" && c.path === "/sandboxes").length;
  const lookupCount = () => calls.filter(c => c.method === "GET" && c.path === "/sandboxes").length;
  const stops = () => calls.filter(c => c.method === "POST" && c.path.endsWith("/stop")).length;
  return { calls, creates, lookupCount, stops };
}

beforeEach(async () => { await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Boat create that timed out (Daytona #20828 createWithinCap port)", () => {
  it("adopts the box our timed-out create made, found by its paperclip-acquire label, with no second create", async () => {
    const f = fixture({ create: "timeout", visibleAfterLookups: 0, states: ["provisioning", "ready"] });
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    expect(lease).toMatchObject({ providerLeaseId: BOX });
    expect(f.creates()).toBe(1);
    expect(f.lookupCount()).toBeGreaterThanOrEqual(1);
    expect(f.stops()).toBe(0);
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
  });

  it("keeps looking inside the create cap when the box appears late, then adopts it", async () => {
    vi.useFakeTimers();
    const f = fixture({ create: "timeout", visibleAfterLookups: 2, states: ["ready"] });
    const acquire = plugin.definition.onEnvironmentAcquireLease!(params);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(acquire).resolves.toMatchObject({ providerLeaseId: BOX });
    expect(f.creates()).toBe(1);
    expect(f.lookupCount()).toBe(3);
    expect(f.stops()).toBe(0);
  });

  it("a box that never appears within the cap fails typed (ETIMEDOUT, providerState absent) so the host retries; no second create, no stop", async () => {
    vi.useFakeTimers();
    const f = fixture({ create: "timeout" });
    const acquire = plugin.definition.onEnvironmentAcquireLease!(params).catch(error => error);
    await vi.advanceTimersByTimeAsync(200_000);
    const error = await acquire;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "ETIMEDOUT", providerState: "absent", phase: "create", budgetMs: 90_000 });
    expect(error.elapsedMs).toBeGreaterThanOrEqual(90_000);
    // The host's transient classification reads only this closed errno across the RPC.
    expect(environmentAcquireErrorData(error)).toMatchObject({ providerDiagnostic: { errorCode: "ETIMEDOUT" } });
    expect(f.creates()).toBe(1);
    expect(f.lookupCount()).toBeGreaterThanOrEqual(3);
    expect(f.stops()).toBe(0);
  });

  it("a create that failed (HTTP 503) is not adopted: like Daytona's rejected create, its box is cleaned up and the 503 kept", async () => {
    const f = fixture({ create: 503, visibleAfterLookups: 0, states: ["ready"] });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
    expect(f.creates()).toBe(1);
    expect(f.lookupCount()).toBe(1);
    expect(f.stops()).toBe(1);
  });

  it("a failed label lookup after the timeout is not waited out (Daytona: an unavailable lookup fails at once)", async () => {
    const f = fixture({ create: "timeout" });
    const fetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const inner = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      if ((init.method ?? "GET") === "GET" && url.pathname === "/api/v1/sandboxes") return response({ error: "outage" }, 503);
      return inner(input, init);
    });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(error => error);
    expect(error).toMatchObject({ status: 503 });
    expect(f.creates()).toBe(1);
    expect(f.stops()).toBe(0);
  });

  it("a definite refusal (HTTP 422) is not waited out or adopted: one ownership lookup, then the refusal", async () => {
    const f = fixture({ create: 422 });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 422 });
    expect(f.creates()).toBe(1);
    expect(f.lookupCount()).toBe(1);
  });

  it("a normal create is unchanged: POST then GET until ready, no label lookup", async () => {
    const f = fixture({ create: "ok", states: ["provisioning", "ready"] });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).resolves.toMatchObject({ providerLeaseId: BOX });
    expect(f.calls.map(c => `${c.method} ${c.path}`)).toEqual([
      "POST /sandboxes", `GET /sandboxes/${BOX}`, `GET /sandboxes/${BOX}`,
    ]);
  });
});

describe("Boat box that entered error (Daytona #22194 provider-start failure port)", () => {
  const expectProviderStartFailure = (error: unknown) => {
    expect(error).toBeInstanceOf(PluginEnvironmentCreationCleanupError);
    // Keep the base wording so existing callers still see what Boat reported.
    expect((error as Error).message).toContain(`Boat sandbox ${BOX} entered error`);
    const data = environmentAcquireErrorData(error);
    const diagnostic = readEnvironmentAcquisitionDiagnostic({ data });
    expect(diagnostic).toMatchObject({ phase: "create", providerState: "error", budgetMs: 180_000 });
    // Not a deadline: the host must read it as a provider start failure, not a timeout.
    expect(diagnostic!.elapsedMs).toBeLessThan(diagnostic!.budgetMs);
    expect(readEnvironmentCreationCleanupError({ data })).toMatchObject({ providerLeaseId: BOX, attemptId: "attempt", runId: "run" });
    expect(JSON.stringify(data)).not.toContain(cfg.apiKey);
    expect((data as { providerDiagnostic?: unknown }).providerDiagnostic).toBeUndefined();
  };

  it("a created box that enters error throws the typed provider-start failure and is stopped, never deleted", async () => {
    const f = fixture({ create: "ok", states: ["provisioning", "error"] });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(error => error);
    expectProviderStartFailure(error);
    expect(f.stops()).toBe(1);
    expect(f.calls.some(c => c.method === "DELETE")).toBe(false);
  });

  it("an adopted box (timed-out create) that enters error throws the same typed failure", async () => {
    const f = fixture({ create: "timeout", visibleAfterLookups: 0, states: ["error"] });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(error => error);
    expectProviderStartFailure(error);
    expect(f.creates()).toBe(1);
    expect(f.stops()).toBe(1);
  });
});
