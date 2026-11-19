import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import { writeWorkspaceSentinel } from "./runner-support.js";

// Boat 11-18/19 storage incident: a box that looks ready but whose files are
// missing, and commands that hang. Two fixes, on strict HTTP fixtures (never live Boat):
// A. Boat ANSWERS the sentinel mkdir with "timed out": the error is ETIMEDOUT,
//    the code the host reads as transient (server environment-provider-unavailable-error.ts:19-22).
// C. Boat documents `hydrated` on GET /sandboxes/{id}: "True once every file of the
//    sandbox's snapshot is on its disk" (docs.boat.dev/api/reference/sandboxes/get-sandbox.md:200-210);
//    "Use `hydrated` as the end signal, not `percent`" (docs.boat.dev/readiness.md:102).
//    A box is ready only once it is hydrated, inside the existing cap/budget.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const p = { driverKey: "boat", companyId: "hco", environmentId: "henv", runId: "hrun", creationOperationId: "hattempt", config: cfg };
const owned = { owner: "paperclip:hco", environment: "henv", run: "hrun", "paperclip-acquire": "hattempt" };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const BOX = "bx_hydrate01";
beforeEach(async () => {
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** `hydration(now)` is the box's documented hydration fields at that moment;
 * `undefined` means Boat sent no hydration fields at all. */
function world(hydration: (now: number) => Record<string, unknown> | undefined, start: "create" | "archived" = "create") {
  const calls: { at: number; method: string; path: string }[] = [];
  let stopped = start === "archived", resumed = false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push({ at: Date.now(), method, path });
    if (method === "POST" && path === "/sandboxes") return res({ sandbox: { id: BOX, state: "provisioning" } }, 202);
    if (method === "GET" && path === "/sandboxes") return res({ sandboxes: [{ id: BOX, state: stopped ? "archived" : "ready", labels: owned }], pageInfo: { nextCursor: null } });
    if (method === "POST" && path === `/sandboxes/${BOX}/stop`) { stopped = true; return res({ stop: { id: "stop_h", status: "pending" } }, 202); }
    if (method === "POST" && path === `/sandboxes/${BOX}/resume`) { stopped = false; resumed = true; return res({ sandbox: { id: BOX, state: "resuming" } }, 202); }
    if (method === "GET" && path === `/sandboxes/${BOX}`) return res({ sandbox: { id: BOX, labels: owned, state: stopped ? "archived" : "ready",
      ...(stopped ? { stop: { id: "stop_h", status: "completed" } } : hydration(Date.now()) ?? {}) } });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return { calls, stopped: () => stopped, resumed: () => resumed };
}
const settle = (work: Promise<unknown>) => work.then(lease => ({ lease, at: Date.now() }), error => ({ error, at: Date.now() }));
const restoring = (percent: number) => ({ hydrated: false, hydratedAt: null, hydration: { phase: "hydrating", entriesDone: percent, entriesTotal: 100, percent } });
const done = { hydrated: true, hydratedAt: "1970-01-01T00:00:20.000Z", hydration: null };

it("A: Boat answers the sentinel mkdir 'timed out' => the thrown error carries code ETIMEDOUT", async () => {
  const io = { request: vi.fn(), run: vi.fn(async () => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" })) };
  const scoped = { ...p, agentId: "agent", executionWorkspaceId: "ews" };
  const error: any = await writeWorkspaceSentinel(scoped as any, cfg as any, BOX, "/home/user/paperclip-workspace", io as any).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("ETIMEDOUT");
  expect(io.request).not.toHaveBeenCalled();
});

it("A: a sentinel mkdir that answers a failing exit (not timed out) stays an untyped failure", async () => {
  const io = { request: vi.fn(), run: vi.fn(async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "" })) };
  const scoped = { ...p, agentId: "agent", executionWorkspaceId: "ews" };
  const error: any = await writeWorkspaceSentinel(scoped as any, cfg as any, BOX, "/home/user/paperclip-workspace", io as any).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBeUndefined();
});

it("C: hydration 40% then hydrated => the lease is handed off only after Boat reports hydrated", async () => {
  const w = world(now => now < 20_000 ? restoring(40) : done);
  const work = settle(plugin.definition.onEnvironmentAcquireLease!(p));
  await vi.advanceTimersByTimeAsync(60_000);
  const result: any = await work;
  expect(result.error).toBeUndefined();
  expect(result.lease).toMatchObject({ providerLeaseId: BOX });
  expect(result.at).toBeGreaterThanOrEqual(20_000);
  expect(w.stopped()).toBe(false);
  // It kept polling the box while it was ready but not hydrated.
  expect(w.calls.filter(c => c.method === "GET" && c.path === `/sandboxes/${BOX}` && c.at < 20_000).length).toBeGreaterThan(1);
});

it("C: hydration stuck below complete => ETIMEDOUT inside the budget, the box is stopped, never handed off", async () => {
  const w = world(() => restoring(99));
  const work = settle(plugin.definition.onEnvironmentAcquireLease!(p));
  await vi.advanceTimersByTimeAsync(240_000);
  const result: any = await work;
  expect(result.lease).toBeUndefined();
  expect(result).toHaveProperty("error.code", "ETIMEDOUT");
  expect(result.at).toBeLessThanOrEqual(180_000);
  expect(w.stopped()).toBe(true);
});

it("C: a box with no hydration fields is ready at its state, as before", async () => {
  const w = world(() => undefined);
  const work = settle(plugin.definition.onEnvironmentAcquireLease!(p));
  await vi.advanceTimersByTimeAsync(60_000);
  const result: any = await work;
  expect(result.error).toBeUndefined();
  expect(result.lease).toMatchObject({ providerLeaseId: BOX });
  expect(result.at).toBeLessThan(5_000);
  expect(w.stopped()).toBe(false);
});

it("C: a resume returns the lease only after Boat reports the box hydrated", async () => {
  const w = world(now => now < 15_000 ? restoring(40) : done, "archived");
  const work = settle(plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "hco", environmentId: "henv", config: cfg, providerLeaseId: BOX } as any));
  await vi.advanceTimersByTimeAsync(60_000);
  const result: any = await work;
  expect(result.error).toBeUndefined();
  expect(w.resumed()).toBe(true);
  expect(result.lease).toMatchObject({ providerLeaseId: BOX });
  expect(result.at).toBeGreaterThanOrEqual(15_000);
});

it("C: a resume whose box never hydrates fails ETIMEDOUT with retryable 'timed out' text at the 120 s cap", async () => {
  world(() => restoring(40), "archived");
  const work = settle(plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "hco", environmentId: "henv", config: cfg, providerLeaseId: BOX } as any));
  await vi.advanceTimersByTimeAsync(200_000);
  const result: any = await work;
  expect(result.lease).toBeUndefined();
  expect(result).toHaveProperty("error.code", "ETIMEDOUT");
  // server environment-runtime.ts transientSandboxResumeFailure reads resume text only.
  expect(result.error.message).toMatch(/\btimed out\b/);
  expect(result.at).toBeLessThanOrEqual(125_000);
});
