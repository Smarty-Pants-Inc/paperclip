// Independent RFL checks. Copy to server/src/realtime/judge-ingress.test.ts.
// No real service credentials, provider, Boat API, database or external sockets.
import { EventEmitter } from "node:events";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { DurablePrpControlPlane } from "../src/vendor/paperclip-runner/index.js";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { connectRunnerPrpIngress } from "../src/realtime/runner-prp-outbound.js";

const factory = vi.hoisted(() => ({ create: undefined as undefined | ((url: string, options: { handshakeTimeout: number }) => unknown) }));
vi.mock("../src/middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("ws", async (original) => {
  const actual = await original<typeof import("ws")>();
  return { ...actual, default: Object.assign(vi.fn(function(url: string, options: { handshakeTimeout: number }) { return factory.create!(url, options); }), {
    OPEN: actual.default.OPEN, CLOSED: actual.default.CLOSED, CONNECTING: actual.default.CONNECTING, CLOSING: actual.default.CLOSING,
  }) };
});
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  send = vi.fn(); ping = vi.fn();
  close() { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
  terminate() { this.close(); }
}
function open() { const socket = new Socket(); queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit("open"); }); return socket; }
function refuse() { const socket = new Socket(); queueMicrotask(() => { socket.readyState = WebSocket.CLOSED; socket.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })); socket.emit("close", 1006, Buffer.alloc(0)); }); return socket; }
function rejectHttp(status: number, wait = 0) { const socket = new Socket(); const emit = () => socket.emit("unexpected-response", {}, { statusCode: status, resume() {} }); if (wait) setTimeout(emit, wait); else queueMicrotask(emit); return socket; }
function endpoint(): RunnerIngressEndpoint { const ep: RunnerIngressEndpoint = { kind: "authenticated_websocket", websocketUrl: "wss://fixture.invalid/old", secretHeaders: [], generation: "same-lease", refresh: vi.fn(async () => ep), close: vi.fn(async () => {}) }; return ep; }
function authority(extra = {}) { return { attachWireConnection: vi.fn(() => ({ isAuthenticated: () => true })), ...extra } as unknown as DurablePrpControlPlane; }
function report(name: string, values: object) { console.info("RFL_MEASURE " + JSON.stringify({ name, ...values })); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("RFL independent ingress characterization and contract checks", () => {
  it.each([ [false, false], [false, true], [true, false], [true, true] ] as const)("paces stale route: warm=%s refreshRejects=%s", async (warm, refreshRejects) => {
    const times: number[] = [], refreshTimes: number[] = [];
    let first: Socket | undefined;
    factory.create = () => { if (warm && !first) { first = open(); return first; } times.push(Date.now()); return refuse(); };
    const ep = endpoint(); ep.refresh = vi.fn(async () => { refreshTimes.push(Date.now()); if (refreshRejects) throw new Error("fixture refresh failure"); return ep; });
    const handle = connectRunnerPrpIngress({ authority: authority(), endpoint: ep, random: () => 0 });
    const outcome = (warm ? handle.failure : handle.ready).catch(error => error);
    try {
      if (warm) { await vi.advanceTimersByTimeAsync(0); await handle.ready; first!.close(); }
      const deadline = warm ? 420_000 : 60_000;
      await vi.advanceTimersByTimeAsync(deadline);
      expect(await outcome).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(times.length).toBe(warm ? 115 : 19);
      expect(refreshTimes.length).toBe(times.length - 1);
      expect(times.slice(0, 6)).toEqual([0, 750, 1500, 2250, 3750, 7500]);
      expect(times.every((time, i) => i === 0 || time - times[i - 1]! >= 750)).toBe(true);
      expect(times.at(-1)).toBeLessThan(deadline);
      report("same-or-failed-refresh", { warm, refreshRejects, deadline, attemptCount: times.length, refreshCount: refreshTimes.length, times });
    } finally { await handle.close(); }
  });

  it("REQUIRED: does not spend the complete startup budget in one stalled-event-loop attempt", async () => {
    let attempts = 0;
    factory.create = () => { attempts++; const socket = new Socket(); queueMicrotask(() => { vi.setSystemTime(65_000); socket.readyState = WebSocket.CLOSED; socket.emit("error", new Error("Opening handshake has timed out")); socket.emit("close", 1006, Buffer.alloc(0)); }); return socket; };
    const ep = endpoint(), handle = connectRunnerPrpIngress({ authority: authority(), endpoint: ep });
    const outcome = handle.ready.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(0); await outcome;
      report("three-attempt-floor", { elapsed: Date.now(), attempts, refreshes: vi.mocked(ep.refresh).mock.calls.length });
      expect(attempts).toBeGreaterThanOrEqual(3);
    } finally { await handle.close(); }
  });

  it("bounds an asynchronous slow refresh waiter, but does not cancel the underlying operation", async () => {
    let attempts = 0, completed = 0, rejectedAt: number | undefined;
    factory.create = () => { attempts++; return refuse(); };
    const ep = endpoint(); ep.refresh = vi.fn(() => new Promise(resolve => { setTimeout(() => { completed++; resolve(ep); }, 120_000); }));
    const handle = connectRunnerPrpIngress({ authority: authority(), endpoint: ep, random: () => 0 });
    const outcome = handle.ready.catch(error => { rejectedAt = Date.now(); return error; });
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(rejectedAt).toBe(60_000); expect(attempts).toBe(1); expect(completed).toBe(0);
      await handle.close();
      await vi.advanceTimersByTimeAsync(60_750);
      expect(completed).toBe(1);
      report("slow-refresh", { rejectedAt, attempts, refreshes: vi.mocked(ep.refresh).mock.calls.length, operationCompletedAt: Date.now(), completedAfterClose: completed });
    } finally { await handle.close(); }
  });

  it("shows there is no wall-clock upper bound during a refresh event-loop stall", async () => {
    factory.create = () => refuse();
    const ep = endpoint(); ep.refresh = vi.fn(async () => { vi.setSystemTime(120_000); return ep; });
    let rejectedAt: number | undefined;
    const handle = connectRunnerPrpIngress({ authority: authority(), endpoint: ep, random: () => 0 });
    const outcome = handle.ready.catch(error => { rejectedAt = Date.now(); return error; });
    try {
      await vi.advanceTimersByTimeAsync(750);
      expect(await outcome).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(rejectedAt).toBe(120_000);
      report("refresh-event-loop-stall", { rejectedAt, configuredDeadline: 60_000, overshoot: rejectedAt! - 60_000 });
    } finally { await handle.close(); }
  });

  it.each([401, 403])("keeps permanent HTTP %s refusal terminal and does not authenticate it", async status => {
    let attempts = 0;
    factory.create = () => { attempts++; return rejectHttp(status, 1); };
    const ep = endpoint(), auth = authority();
    const handle = connectRunnerPrpIngress({ authority: auth, endpoint: ep, startupDeadlineMs: 100, random: () => 0 });
    const outcome = handle.ready.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(await outcome).toMatchObject({ code: "runner_ingress_auth_failed" });
      expect(auth.attachWireConnection).not.toHaveBeenCalled();
      expect(attempts).toBe(100); expect(ep.refresh).toHaveBeenCalledTimes(99);
      report("HTTP-auth-negative-and-existing-burst", { status, attempts, refreshes: vi.mocked(ep.refresh).mock.calls.length, elapsed: Date.now() });
    } finally { await handle.close(); }
  });

  it.each([401, 403])("bounds a stalled HTTP %s credential refresh", async status => {
    factory.create = () => rejectHttp(status);
    const ep = endpoint(); ep.refresh = vi.fn(async () => await new Promise<never>(() => {}));
    const handle = connectRunnerPrpIngress({ authority: authority(), endpoint: ep, startupDeadlineMs: 1_000 });
    const outcome = handle.ready.catch(error => error);
    try { await vi.advanceTimersByTimeAsync(1_000); expect(await outcome).toMatchObject({ code: "runner_ingress_auth_failed" }); expect(ep.refresh).toHaveBeenCalledOnce(); }
    finally { await handle.close(); }
  });

  it("uses the returned endpoint, not merely a successful refresh callback", async () => {
    const urls: string[] = [];
    factory.create = url => { urls.push(url); return url.endsWith("/new") ? open() : refuse(); };
    const ep = endpoint(), next = { ...ep, websocketUrl: "wss://fixture.invalid/new" }; ep.refresh = vi.fn(async () => next);
    const handle = connectRunnerPrpIngress({ authority: authority(), endpoint: ep, random: () => 0 });
    try { await vi.advanceTimersByTimeAsync(750); await handle.ready; expect(urls).toEqual([ep.websocketUrl, next.websocketUrl]); expect(ep.refresh).toHaveBeenCalledOnce(); }
    finally { await handle.close(); }
  });

  it("REQUIRED: excludes a known expired connection lease from new transport route refresh", async () => {
    let first: Socket | undefined;
    factory.create = () => { if (!first) { first = open(); return first; } return refuse(); };
    let expired = false;
    const ep = endpoint();
    const auth = authority(); Object.defineProperty(auth, "connectionLeaseFailure", { get: () => expired ? { code: "connection_lease_expired" } : null });
    const handle = connectRunnerPrpIngress({ authority: auth, endpoint: ep, recoveryGraceMs: 5_000, random: () => 0.5 });
    const outcome = handle.failure.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(0); await handle.ready; expired = true; first!.close(); await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatchObject({ code: "runner_connection_lease_expired" });
      report("known-expired-lease", { refreshes: vi.mocked(ep.refresh).mock.calls.length });
      expect(ep.refresh).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });
});
