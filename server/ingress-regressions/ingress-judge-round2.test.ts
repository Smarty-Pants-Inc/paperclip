// Independent round-2 checks derived from the task, not from the builder's tests.
// Copy into server/ingress-regressions/; no credentials or external services.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { connectRunnerPrpIngress } from "../src/realtime/runner-prp-outbound.js";
import type { DurablePrpControlPlane } from "../src/vendor/paperclip-runner/index.js";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
const f = vi.hoisted(() => ({ dial: undefined as undefined | (() => unknown) }));
vi.mock("../src/middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("ws", async original => {
  const actual = await original<typeof import("ws")>();
  return { ...actual, default: Object.assign(vi.fn(function() { return f.dial!(); }), {
    OPEN: actual.default.OPEN, CLOSED: actual.default.CLOSED, CONNECTING: actual.default.CONNECTING, CLOSING: actual.default.CLOSING,
  }) };
});
class Sock extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  send = vi.fn(); ping = vi.fn();
  close() { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
  terminate() { this.close(); }
}
function good() { const s = new Sock(); queueMicrotask(() => { s.readyState = WebSocket.OPEN; s.emit("open"); }); return s; }
function bad(stall = 0, during = () => {}) {
  const s = new Sock();
  queueMicrotask(() => { vi.setSystemTime(Date.now() + stall); during(); s.readyState = WebSocket.CLOSED; s.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })); s.emit("close", 1006, Buffer.alloc(0)); });
  return s;
}
function ep(): RunnerIngressEndpoint {
  const e: RunnerIngressEndpoint = { kind: "authenticated_websocket", websocketUrl: "wss://fixture.invalid/same-lease", generation: "same", secretHeaders: [], refresh: vi.fn(async () => e), close: vi.fn(async () => {}) };
  return e;
}
function auth() { return { attachWireConnection: vi.fn(() => ({ isAuthenticated: () => true })) } as unknown as DurablePrpControlPlane; }
const report = (name: string, values: object) => console.info("RFL_ROUND2 " + JSON.stringify({ name, ...values }));
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("RFL round 2 independent timing and safety", () => {
  it.each([false, true])("counts actual default-budget startup/recovery dials through a stall each time: warm=%s", async warm => {
    const starts: number[] = [], states: Array<{ at: number; state: string; code?: string }> = [];
    let initial: Sock | undefined;
    f.dial = () => { if (warm && !initial) { initial = good(); return initial; } starts.push(Date.now()); return bad(warm ? 425_000 : 65_000); };
    const endpoint = ep();
    const h = connectRunnerPrpIngress({ authority: auth(), endpoint, onStateChange: (state, code) => states.push({ at: Date.now(), state, code }) });
    const result = (warm ? h.failure : h.ready).catch(e => e);
    try {
      if (warm) { await vi.advanceTimersByTimeAsync(0); await h.ready; initial!.close(); }
      await vi.advanceTimersByTimeAsync(0);
      expect(await result).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(starts).toEqual(warm ? [0, 425_000, 850_000] : [0, 65_000, 130_000]);
      expect(endpoint.refresh).toHaveBeenCalledTimes(2);
      report("every-dial-stalls", { warm, elapsed: Date.now(), starts, states, refreshes: vi.mocked(endpoint.refresh).mock.calls.length });
    } finally { await h.close(); }
  });

  it.each([0, 0.5, 1])("paces immediate refusal for the ordinary 60s episode, random=%s", async random => {
    const starts: number[] = []; f.dial = () => { starts.push(Date.now()); return bad(); };
    const endpoint = ep(); const h = connectRunnerPrpIngress({ authority: auth(), endpoint, random: () => random });
    const result = h.ready.catch(e => e);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await result).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(starts.every((at, i) => i === 0 || at - starts[i - 1]! >= 750)).toBe(true);
      expect(starts.length).toBeLessThanOrEqual(19);
      report("ordinary-fast-refusal", { random, starts, refreshes: vi.mocked(endpoint.refresh).mock.calls.length });
    } finally { await h.close(); }
  });

  it("characterizes the finite catch-up burst after one long stall", async () => {
    const starts: number[] = []; f.dial = () => { starts.push(Date.now()); return bad(starts.length === 1 ? 65_000 : 0); };
    const endpoint = ep(); const h = connectRunnerPrpIngress({ authority: auth(), endpoint, random: () => 0.5 });
    const result = h.ready.catch(e => e);
    try {
      await vi.advanceTimersByTimeAsync(0); expect(await result).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(starts).toEqual([0, 65_000, 65_000]); expect(endpoint.refresh).toHaveBeenCalledTimes(2);
      report("finite-late-catch-up", { starts, minLateSpacingMs: starts[2]! - starts[1]!, attempts: starts.length });
    } finally { await h.close(); }
  });

  it.each([0.9, 1])("REQUIRED: avoids spending the remaining short cold budget on jittered spacing, random=%s", async random => {
    const starts: number[] = []; f.dial = () => { starts.push(Date.now()); return Date.now() >= 200 ? good() : bad(); };
    const endpoint = ep(); const h = connectRunnerPrpIngress({ authority: auth(), endpoint, startupDeadlineMs: 1_100, random: () => random });
    let outcome: unknown = "pending"; void h.ready.then(() => { outcome = "ready"; }, e => { outcome = e.code; });
    try {
      await vi.advanceTimersByTimeAsync(1_100);
      report("jitter-cold-budget", { budget: 1_100, routeAvailableAt: 200, random, starts, outcome });
      expect(outcome).toBe("ready");
      expect(starts.length).toBeGreaterThanOrEqual(2);
    } finally { await h.close(); }
  });

  it("never grants late floor repairs once expiry is known", async () => {
    let count = 0, expired = false; const authority = auth();
    Object.defineProperty(authority, "connectionLeaseFailure", { get: () => expired ? { code: "connection_lease_expired" } : null });
    f.dial = () => { count++; return bad(65_000, () => { expired = true; }); };
    const endpoint = ep(); const h = connectRunnerPrpIngress({ authority, endpoint }); const result = h.ready.catch(e => e);
    try {
      await vi.advanceTimersByTimeAsync(0); expect(await result).toMatchObject({ code: "runner_connection_lease_expired" });
      expect(count).toBe(1); expect(endpoint.refresh).not.toHaveBeenCalled();
      report("expired-late-floor", { attempts: count, refreshes: 0, elapsed: Date.now() });
    } finally { await h.close(); }
  });

  it("cancellation during a late refresh prevents the remaining dials and state effects", async () => {
    let count = 0; f.dial = () => { count++; return bad(65_000); };
    const endpoint = ep(); endpoint.refresh = vi.fn(() => new Promise<RunnerIngressEndpoint>(() => {}));
    const states: string[] = []; const h = connectRunnerPrpIngress({ authority: auth(), endpoint, onStateChange: s => states.push(s) });
    const result = h.ready.catch(e => e);
    await vi.advanceTimersByTimeAsync(0); expect(endpoint.refresh).toHaveBeenCalledOnce();
    await h.close(); expect(await result).toMatchObject({ code: "runner_ingress_unavailable" });
    await vi.advanceTimersByTimeAsync(60_000); expect(count).toBe(1); expect(endpoint.refresh).toHaveBeenCalledOnce();
    expect(states).toEqual(["connecting", "closed"]); report("late-cancel", { attempts: count, states });
  });
});
