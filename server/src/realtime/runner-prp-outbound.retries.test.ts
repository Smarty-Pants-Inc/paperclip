import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress } from "./runner-prp-outbound.js";

const transport = vi.hoisted(() => ({ create: undefined as undefined | ((options: { handshakeTimeout: number }) => unknown) }));
vi.mock("ws", async original => {
  const actual = await original<typeof import("ws")>();
  return { ...actual, default: Object.assign(vi.fn(function(_url: string, options: { handshakeTimeout: number }) { return transport.create!(options); }), {
    CONNECTING: actual.default.CONNECTING, OPEN: actual.default.OPEN,
    CLOSING: actual.default.CLOSING, CLOSED: actual.default.CLOSED,
  }) };
});
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
class Socket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  send = vi.fn(); ping = vi.fn();
  close() { this.readyState = WebSocket.CLOSED; this.emit("close", 1000, Buffer.alloc(0)); }
  terminate() { this.close(); }
}
function opened() {
  const socket = new Socket();
  queueMicrotask(() => { socket.readyState = WebSocket.OPEN; socket.emit("open"); });
  return socket;
}
function refused(stallMs = 0) {
  const socket = new Socket();
  queueMicrotask(() => {
    vi.setSystemTime(Date.now() + stallMs);
    socket.readyState = WebSocket.CLOSED;
    socket.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    socket.emit("close", 1006, Buffer.alloc(0));
  });
  return socket;
}
function endpoint(): RunnerIngressEndpoint {
  const result: RunnerIngressEndpoint = {
    kind: "authenticated_websocket", websocketUrl: "wss://fixture.invalid/connect/original",
    generation: "original", secretHeaders: [], refresh: vi.fn(async () => result), close: vi.fn(async () => {}),
  };
  return result;
}
function authority(extra = {}) {
  return { attachWireConnection: vi.fn(() => ({ isAuthenticated: () => true })), ...extra } as unknown as DurablePrpControlPlane;
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.useRealTimers(); });

describe("counted ingress attempt floor and lease-expiry fences", () => {
  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ] as const)("counts three real dials despite a stall on every attempt (warm=%s, refreshRejects=%s)", async (warm, refreshRejects) => {
    let first: Socket | undefined;
    const timeouts: number[] = [];
    transport.create = options => {
      if (warm && !first) { first = opened(); return first; }
      timeouts.push(options.handshakeTimeout);
      return refused(65_000);
    };
    const ep = endpoint();
    if (refreshRejects) ep.refresh = vi.fn(async () => { throw new Error("route remains stale"); });
    const auth = authority();
    const handle = connectRunnerPrpIngress({ endpoint: ep, authority: auth, recoveryGraceMs: 60_000 });
    const outcome = (warm ? handle.failure : handle.ready).catch(error => error);
    try {
      if (warm) { await vi.advanceTimersByTimeAsync(0); await handle.ready; first!.close(); }
      await vi.advanceTimersByTimeAsync(0);
      expect(await outcome).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(timeouts).toEqual([15_000, 15_000, 15_000]);
      expect(ep.refresh).toHaveBeenCalledTimes(2);
      expect(auth.attachWireConnection).toHaveBeenCalledTimes(warm ? 1 : 0);
      expect(Date.now()).toBe(195_000);
      console.info("M1_ATTEMPT_FLOOR " + JSON.stringify({ warm, refreshRejects, attempts: timeouts.length, refreshes: vi.mocked(ep.refresh).mock.calls.length, elapsed: Date.now() }));
    } finally { await handle.close(); }
  });

  it.each(["before first dial", "during backoff"] as const)("does not spend an unmade attempt when the event loop stalls %s", async mode => {
    let attempts = 0, stalled = false;
    transport.create = () => { attempts++; return refused(); };
    const ep = endpoint();
    const handle = connectRunnerPrpIngress({ endpoint: ep, authority: authority(), random: () => 0,
      onStateChange: () => {
        if (mode === "before first dial" && !stalled) { stalled = true; vi.setSystemTime(65_000); }
      },
    });
    const outcome = handle.ready.catch(error => error);
    try {
      if (mode === "during backoff") setTimeout(() => vi.setSystemTime(65_000), 500);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await outcome).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(attempts).toBe(3);
      expect(ep.refresh).toHaveBeenCalledTimes(2);
    } finally { await handle.close(); }
  });

  it("can authenticate on the third counted attempt after two event-loop stalls", async () => {
    let attempts = 0;
    transport.create = () => ++attempts === 3 ? opened() : refused(65_000);
    const ep = endpoint(), auth = authority();
    const handle = connectRunnerPrpIngress({ endpoint: ep, authority: auth });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await handle.ready;
      expect(attempts).toBe(3);
      expect(ep.refresh).toHaveBeenCalledTimes(2);
      expect(auth.attachWireConnection).toHaveBeenCalledOnce();
    } finally { await handle.close(); }
  });

  it("does not confuse endpoint validation failures with real dial attempts", async () => {
    const dial = vi.fn(() => refused()); transport.create = dial;
    const ep: RunnerIngressEndpoint = { ...endpoint(), websocketUrl: "ws://fixture.invalid/connect/original" };
    ep.refresh = vi.fn(async () => ep);
    const handle = connectRunnerPrpIngress({ endpoint: ep, authority: authority() });
    const outcome = handle.ready.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await outcome).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(dial).not.toHaveBeenCalled();
      expect(Date.now()).toBe(60_000);
    } finally { await handle.close(); }
  });

  it.each([401, 403])("does not rotate credentials for a known-expired lease after HTTP %s", async statusCode => {
    transport.create = () => {
      const socket = new Socket();
      setTimeout(() => {
        socket.emit("unexpected-response", {}, { statusCode, resume: vi.fn() });
        socket.close();
      }, 10);
      return socket;
    };
    const ep = endpoint();
    const auth = authority({ connectionLeaseFailure: { code: "connection_lease_expired" } });
    const handle = connectRunnerPrpIngress({ endpoint: ep, authority: auth, startupDeadlineMs: 5_000 });
    const outcome = handle.ready.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatchObject({ code: "runner_connection_lease_expired" });
      expect(ep.refresh).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });

  it.each(["already known", "during backoff"] as const)("does not refresh when expiry becomes known %s", async mode => {
    let first: Socket | undefined, expired = mode === "already known";
    transport.create = () => {
      if (!first && mode === "during backoff") { first = opened(); return first; }
      return refused();
    };
    const ep = endpoint();
    const auth = authority();
    Object.defineProperty(auth, "connectionLeaseFailure", { get: () => expired ? { code: "connection_lease_expired" } : null });
    const handle = connectRunnerPrpIngress({ endpoint: ep, authority: auth, startupDeadlineMs: 5_000, recoveryGraceMs: 5_000, random: () => 0.5 });
    const outcome = (mode === "during backoff" ? handle.failure : handle.ready).catch(error => error);
    try {
      if (mode === "during backoff") {
        await vi.advanceTimersByTimeAsync(0); await handle.ready; first!.close();
        await vi.advanceTimersByTimeAsync(500); expired = true;
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await outcome).toMatchObject({ code: "runner_connection_lease_expired" });
      expect(ep.refresh).not.toHaveBeenCalled();
    } finally { await handle.close(); }
  });
});
