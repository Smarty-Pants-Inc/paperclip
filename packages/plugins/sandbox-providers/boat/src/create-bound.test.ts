import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// rf-4 U3 C1: the 90 s create cap is strict and one 180 s budget bounds the
// whole acquisition (create, adoption, readiness, setup, handoff), as in
// Daytona's acquire (one deadline, asserted between phases). Strict HTTP
// fixtures on the plugin's public acquire hook, not live Boat.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const p = { driverKey: "boat", companyId: "bco", environmentId: "benv", runId: "brun", creationOperationId: "battempt", config: cfg };
const owned = { owner: "paperclip:bco", environment: "benv", run: "brun", "paperclip-acquire": "battempt" };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const BOX = "bx_bound001";
beforeEach(async () => {
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** POST either answers at once or hangs to its own 30 s abort; the box becomes
 * visible to label lookups at `visibleAt`; each list page takes `listMs` and
 * honours its abort signal; setup finishes at `setupUntil`. */
function world(o: { create: "ok" | "hang"; visibleAt?: number; listMs?: number; setupUntil?: number }) {
  const calls: { at: number; method: string; path: string }[] = [];
  let stopped = false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push({ at: Date.now(), method, path });
    const signal: AbortSignal | undefined = init.signal;
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      const h = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(h); reject(signal.reason); }, { once: true });
    });
    if (method === "POST" && path === "/sandboxes") {
      if (o.create === "ok") return res({ sandbox: { id: BOX, state: "provisioning" } }, 202);
      await wait(1e9);
    }
    if (method === "GET" && path === "/sandboxes") {
      if (o.listMs) await wait(o.listMs);
      return res({ sandboxes: Date.now() >= (o.visibleAt ?? 0) ? [{ id: BOX, state: stopped ? "archived" : "ready", labels: owned }] : [], pageInfo: { nextCursor: null } });
    }
    if (method === "POST" && path === `/sandboxes/${BOX}/stop`) { stopped = true; return res({ stop: { id: "stop_b", status: "pending" } }, 202); }
    if (method === "GET" && path === `/sandboxes/${BOX}`) return res({ sandbox: { id: BOX, labels: owned, state: stopped ? "archived" : "ready",
      setupStatus: Date.now() >= (o.setupUntil ?? 0) ? "done" : "running", ...(stopped ? { stop: { id: "stop_b", status: "completed" } } : {}) } });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return { calls, stopped: () => stopped };
}
const settle = (work: Promise<unknown>) => work.then(lease => ({ lease, at: Date.now() }), error => ({ error, at: Date.now() }));

it("C1: a label lookup in flight at the 90 s cap is ended at the cap, admitting nothing", async () => {
  const w = world({ create: "hang", visibleAt: 95_000, listMs: 9_000 });
  const work = settle(plugin.definition.onEnvironmentAcquireLease!(p));
  await vi.advanceTimersByTimeAsync(120_000);
  const result: any = await work;
  expect(result).toHaveProperty("error.code", "ETIMEDOUT");
  expect(result.error).toMatchObject({ providerState: "absent" });
  // The last lookup started before the cap and was not allowed to run past it.
  const lookups = w.calls.filter(c => c.method === "GET" && c.path === "/sandboxes" && c.at < 90_000);
  expect(lookups.length).toBeGreaterThan(0);
  expect(result.error.elapsedMs).toBeLessThanOrEqual(90_000);
  expect(w.calls.filter(c => c.method === "POST" && c.path === "/sandboxes")).toHaveLength(1);
});

it("C1: an ordinary (answered) create whose setup runs past the 180 s budget is stopped, never handed off", async () => {
  const w = world({ create: "ok", setupUntil: 220_000 });
  const work = settle(plugin.definition.onEnvironmentAcquireLease!({ ...p, config: { ...cfg, setupScript: "true", setupTimeoutSeconds: 300 } }));
  await vi.advanceTimersByTimeAsync(230_000);
  const result: any = await work;
  expect(result).toHaveProperty("error.code", "ETIMEDOUT");
  expect(result.at).toBeLessThan(200_000);
  expect(w.stopped()).toBe(true);
  expect(w.calls.find(c => c.method === "POST" && c.path.endsWith("/stop"))!.at).toBeGreaterThanOrEqual(180_000);
});

it("C1: setup that fits the budget still hands off the lease (normal create unchanged)", async () => {
  const w = world({ create: "ok", setupUntil: 20_000 });
  const work = settle(plugin.definition.onEnvironmentAcquireLease!({ ...p, config: { ...cfg, setupScript: "true", setupTimeoutSeconds: 300 } }));
  await vi.advanceTimersByTimeAsync(60_000);
  const result: any = await work;
  expect(result.error).toBeUndefined();
  expect(result.lease).toMatchObject({ providerLeaseId: BOX });
  expect(w.stopped()).toBe(false);
});
