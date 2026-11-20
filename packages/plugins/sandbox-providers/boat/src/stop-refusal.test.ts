import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentStopErrorData, PluginEnvironmentCreationCleanupError, PluginEnvironmentStopError, readEnvironmentStopFailure } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

// Keep: PARITY-TABLE rows 1+2 (adopt-boat-stopfail, 18 Nov). A stop Boat refused
// must fail FAST with Boat's own words and must not be resent inside a back-off.
// Tonight's harm: every pass re-POSTed /stop and waited 120 s on a box Boat had
// already refused (agents stuck "pausing", blocked hires, Boat's "could not stop" mail).
// Synthetic key and a fake Boat only; never live Boat. No force, no delete.
//
// FIXTURES of Boat's DOCUMENTED response shapes (staged boat-llms-full.txt):
// - POST /sandboxes/{id}/stop -> 202 with the operation as `stop` {id, status} and
//   `statusUrl`, the path that reads the stop (:1850-1856, :1863-1865).
// - GET /sandboxes/{id}/stops/{stopId} -> that stop by id (get-stop, :1785-1789).
//   Statuses `pending`, `failing`, `completed`, `superseded` (:3773). A failed
//   save "shows `failing` with its `error`" and the sandbox keeps running (:1846-1854).
// - GET /sandboxes/{id} also carries `stop`; `snapshotCompletedAt` is the time of the
//   last good snapshot (:16255, :16304).
// - The refusal words are Boat's real stop.error text quoted in PARITY-TABLE row 18.
const BOAT_REFUSAL = "Refusing archive/stop: no successful snapshot in the last 30 minutes";
const LAST_GOOD = "2026-11-18T17:12:04Z";
let boxes = 0, id = "bx_s0000000";
const config = { hydrationWaitSeconds: 0, apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const scope = { driverKey: "boat", companyId: "c", environmentId: "e", config };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { method: string; route: string; body?: any; at: number };
type StopStatus = "failing" | "pending" | "completed";
/** A fake Boat box whose stop record reads `record()`; the box stays running unless the stop completes. */
function fakeBoat(record: () => StopStatus) {
  let n = 0;
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const method = init.method ?? "GET", route = new URL(String(input)).pathname.replace("/api/v1", "");
    calls.push({ method, route, body: init.body ? JSON.parse(init.body) : undefined, at: Date.now() });
    const stopId = `stop_${String(n).padStart(16, "0")}`;
    const stop = () => ({ id: stopId, status: record(), ...(record() === "failing" ? { error: BOAT_REFUSAL } : {}) });
    if (method === "POST" && route === `/sandboxes/${id}/stop`) {
      // "Calling stop again while one is pending returns the same id" (:1855-1856); a new id per send keeps sends countable here.
      n++; const sent = `stop_${String(n).padStart(16, "0")}`;
      return json({ stop: { id: sent, status: "pending" }, statusUrl: `/sandboxes/${id}/stops/${sent}` }, 202);
    }
    if (method === "GET" && route === `/sandboxes/${id}`) {
      const done = record() === "completed";
      return json({ sandbox: { id, state: done ? "archived" : "archiving", snapshotCompletedAt: LAST_GOOD, stop: stop() } });
    }
    if (method === "GET" && route === `/sandboxes/${id}/stops/${stopId}`) return json({ stop: stop() });
    throw new Error(`unexpected ${method} ${route}`);
  }));
  const count = (method: string, suffix: string, after = 0) =>
    calls.slice(after).filter(c => c.method === method && (suffix.endsWith("/") ? c.route.startsWith(`/sandboxes/${id}${suffix}`) : c.route === `/sandboxes/${id}${suffix}`)).length;
  return { calls, count };
}
const stopLease = () => plugin.definition.onEnvironmentStopLease!({ ...scope, providerLeaseId: id } as any);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { id = `bx_s${String(++boxes).padStart(7, "0")}`; await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function refused(error: any, stopId: string) {
  // The SDK's existing typed stop error, non-terminal, serialisable over the worker RPC.
  expect(error).toBeInstanceOf(PluginEnvironmentStopError);
  expect(environmentStopErrorData(error)).toEqual({ schema: "paperclip/environment-stop-error/v1", failure: { reason: "recovery_incomplete" } });
  expect(readEnvironmentStopFailure({ data: environmentStopErrorData(error) })).toEqual({ reason: "recovery_incomplete", terminal: false });
  expect(error).toMatchObject({ code: "boat_stop_refused", providerLeaseId: id, stopId, boatStatus: "failing", boatError: BOAT_REFUSAL, lastGoodSnapshotAt: LAST_GOOD });
  // Boat's words travel in the message (the RPC carries the message text).
  expect(error.message).toContain(BOAT_REFUSAL);
  expect(error.message).toContain(stopId);
  expect(error.message).toContain(LAST_GOOD);
  expect(String(error) + error.stack).not.toContain(config.apiKey);
}

describe("a stop Boat refused fails fast, carries Boat's words and is not resent", () => {
  it("ROW-1 a 202 stop, then a failing stop record, returns within ONE record read, not 120 s", async () => {
    const boat = fakeBoat(() => "failing");
    const started = Date.now();
    const error = await stopLease().catch(e => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    refused(error, "stop_0000000000000001");
    expect(boat.count("GET", "/stops/")).toBe(1);
    expect(boat.calls.filter(c => c.route === `/sandboxes/${id}/stops/stop_0000000000000001`)).toHaveLength(1);
    expect(boat.count("POST", "/stop")).toBe(1);
    // Never force, never delete.
    expect(boat.calls.find(c => c.route.endsWith("/stop"))?.body).toEqual({});
    expect(boat.calls.some(c => c.method === "DELETE" || c.body?.force !== undefined)).toBe(false);
  }, 10_000);

  it("ROW-2 a second stop inside the back-off sends ZERO POSTs and returns the same typed error at once", async () => {
    const boat = fakeBoat(() => "failing");
    await stopLease().catch(e => e);
    const first = boat.calls.length;
    const started = Date.now();
    const again = await stopLease().catch(e => e);
    expect(Date.now() - started).toBeLessThan(1_000);
    refused(again, "stop_0000000000000001");
    expect(boat.count("POST", "/stop", first)).toBe(0);
    expect(boat.calls.length).toBe(first); // not even a read: nothing blocks
  }, 10_000);

  it("ROW-3 after the back-off, ONE new POST; a second refusal doubles the back-off (1 min, then 2 min)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-18T23:00:00Z"); vi.setSystemTime(t0);
    const boat = fakeBoat(() => "failing");
    const first = await stopLease().catch(e => e);
    expect(first.notResentBefore).toBe(new Date(t0 + 60_000).toISOString());
    vi.setSystemTime(t0 + 59_000);
    let mark = boat.calls.length;
    await stopLease().catch(e => e);
    expect(boat.count("POST", "/stop", mark)).toBe(0);
    vi.setSystemTime(t0 + 60_001);
    mark = boat.calls.length;
    const second = await stopLease().catch(e => e);
    expect(boat.count("POST", "/stop", mark)).toBe(1);
    refused(second, "stop_0000000000000002");
    expect(second).toMatchObject({ refusals: 2, notResentBefore: new Date(t0 + 60_001 + 120_000).toISOString() });
    vi.setSystemTime(t0 + 60_001 + 119_000);
    mark = boat.calls.length;
    await stopLease().catch(e => e);
    expect(boat.count("POST", "/stop", mark)).toBe(0);
  }, 10_000);

  it("ROW-4 a successful stop record keeps today's success path and receipt", async () => {
    let status: StopStatus = "pending";
    const boat = fakeBoat(() => status);
    const work = stopLease();
    // Same moment on base and head: Boat completes the stop after our first poll.
    await vi.waitUntil(() => boat.count("GET", "") >= 1, { timeout: 5_000 });
    status = "completed";
    await expect(work).resolves.toEqual({ providerLeaseId: id, state: "stopped" });
    expect(boat.count("POST", "/stop")).toBe(1);
  }, 10_000);

  it("ROW-4b a stop that completes clears an earlier refusal: the next stop is sent at once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-11-18T23:10:00Z"); vi.setSystemTime(t0);
    let status: StopStatus = "failing";
    const boat = fakeBoat(() => status);
    await stopLease().catch(e => e);
    vi.setSystemTime(t0 + 60_001); status = "completed";
    await expect(stopLease()).resolves.toEqual({ providerLeaseId: id, state: "stopped" });
    vi.setSystemTime(t0 + 61_000); status = "failing";
    const mark = boat.calls.length;
    await stopLease().catch(e => e);
    expect(boat.count("POST", "/stop", mark)).toBe(1);
  }, 10_000);

  it("ROW-5 a stop record that stays pending keeps the bounded 120 s wait and names the stop id and status", async () => {
    vi.useFakeTimers();
    let status: StopStatus = "pending";
    const boat = fakeBoat(() => status);
    const work = stopLease().catch(e => e);
    await vi.advanceTimersByTimeAsync(121_000);
    const error = await work;
    expect(error).not.toBeInstanceOf(PluginEnvironmentStopError);
    expect(error.message).toBe("Boat stop stop_0000000000000001 did not complete (Boat status pending)");
    expect(boat.count("POST", "/stop")).toBe(1);
    expect(boat.count("GET", "/stops/")).toBeGreaterThanOrEqual(1);
    // Pending is not a refusal: no back-off, the next stop is sent.
    vi.useRealTimers(); status = "completed";
    const mark = boat.calls.length;
    await expect(stopLease()).resolves.toEqual({ providerLeaseId: id, state: "stopped" });
    expect(boat.count("POST", "/stop", mark)).toBe(1);
  }, 10_000);

  it("ROW-6 failed-acquisition cleanup's 3 retries respect the refusal: one POST /stop, Boat's words in the cleanup error", async () => {
    let created = false;
    const boat = fakeBoat(() => "failing");
    const inner = (globalThis.fetch as any);
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const method = init.method ?? "GET", route = new URL(String(input)).pathname.replace("/api/v1", "");
      if (method === "POST" && route === "/sandboxes") { created = true; return json({ sandbox: { id } }); }
      // Boat's setup failure (get-sandbox setupStatus), then the stop above refuses.
      if (method === "GET" && route === `/sandboxes/${id}` && created && !boat.calls.some(c => c.route.endsWith("/stop"))) {
        return json({ sandbox: { id, state: "ready", setupStatus: "failed", setupError: "dependency install failed" } });
      }
      return inner(input, init);
    }));
    const started = Date.now();
    const error = await plugin.definition.onEnvironmentAcquireLease!({ ...scope, runId: "run", creationOperationId: "attempt", config: { ...config, setupScript: "false" } } as any).catch(e => e);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error).toBeInstanceOf(PluginEnvironmentCreationCleanupError);
    expect(boat.count("POST", "/stop")).toBe(1);
    expect(boat.count("GET", "/stops/")).toBe(1);
    // The SDK cleanup envelope keeps the acquire cause first, then Boat's refusal.
    expect(error.errors).toHaveLength(2);
    refused(error.errors[1], "stop_0000000000000001");
    expect(error.cleanup).toMatchObject({ providerLeaseId: id, attemptId: "attempt" });
  }, 10_000);

  it("ROW-7 a resume (which cancels the stop at Boat) forgets the refusal: the next stop is sent", async () => {
    const boat = fakeBoat(() => "failing");
    await stopLease().catch(e => e);
    expect(boat.count("POST", "/stop")).toBe(1);
    let resumed = false;
    const inner = (globalThis.fetch as any);
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const method = init.method ?? "GET", route = new URL(String(input)).pathname.replace("/api/v1", "");
      // Boat: "a resume cancels the stop" (:15301, :15380); the box is ready again.
      if (method === "POST" && route === `/sandboxes/${id}/resume`) { resumed = true; return json({ sandbox: { id, state: "ready" } }); }
      if (method === "POST" && route.endsWith("/stop")) resumed = false;
      if (method === "GET" && route === `/sandboxes/${id}` && resumed) return json({ sandbox: { id, state: "ready", setupStatus: "done", expiresAt: "2030-01-01T00:00:00Z", stop: { id: "stop_0000000000000001", status: "superseded" } } });
      if (method === "GET" && route === `/sandboxes/${id}` && !resumed && !boat.calls.some(c => c.method === "POST" && c.route.endsWith("/resume"))) return json({ sandbox: { id, state: "archived" } });
      return inner(input, init);
    }));
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id } as any).catch(e => e);
    const mark = boat.calls.length;
    await stopLease().catch(e => e);
    expect(boat.count("POST", "/stop", mark)).toBe(1);
  }, 10_000);
});
