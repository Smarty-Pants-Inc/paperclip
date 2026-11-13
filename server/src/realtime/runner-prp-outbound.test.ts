import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { logger } from "../middleware/logger.js";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import {
  __runnerPrpOutboundTesting,
  connectRunnerPrpIngress,
  WsJsonWireConnection,
} from "./runner-prp-outbound.js";

const sockets = vi.hoisted(() => ({ create: null as ((options: { handshakeTimeout: number }) => unknown) | null }));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  return {
    ...actual,
    default: Object.assign(vi.fn(function (_url: string, options: { handshakeTimeout: number }) { return sockets.create!(options); }), {
      CONNECTING: actual.default.CONNECTING,
      OPEN: actual.default.OPEN,
      CLOSING: actual.default.CLOSING,
      CLOSED: actual.default.CLOSED,
    }),
  };
});

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006, Buffer.alloc(0));
  });
  close = vi.fn((code?: number) => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code ?? 1000, Buffer.alloc(0));
  });
}

function openingSocket(socket = new FakeSocket()): FakeSocket {
  socket.readyState = WebSocket.CONNECTING;
  queueMicrotask(() => {
    if (socket.readyState !== WebSocket.CONNECTING) return;
    socket.readyState = WebSocket.OPEN;
    socket.emit("open");
  });
  return socket;
}

sockets.create = () => openingSocket();

describe("runner provider-ingress WebSocket wire", () => {
  it("serializes only allowlisted ingress diagnostics through Pino", async () => {
    vi.useFakeTimers();
    const create = sockets.create;
    const destination = new PassThrough();
    let serialized = "";
    destination.on("data", chunk => { serialized += chunk.toString(); });
    const captured = pino(destination);
    const warn = vi.spyOn(logger, "warn").mockImplementation((...args: Parameters<typeof logger.warn>) => { captured.warn(...args); return logger; });
    const secretValues = ["sk-live-SECRET123456789", "pa55w0rd-SECRET", "lowercase-secret-token", "sk-secret-code", "secret-syscall"];
    const failures = [
      Object.assign(new Error(`Authorization: Bearer ${secretValues[0]}`), { code: "ECONNRESET", syscall: "connect", errno: 7 }),
      Object.assign(new Error(`could not reach https://user:${secretValues[1]}@ingress.example/x`), { code: "ECONNREFUSED", syscall: "write", errno: 8 }),
      Object.assign(new Error(secretValues[2]), { code: "ECONNRESET", syscall: "read", errno: 9 }),
      Object.assign(new Error("runner_ingress_upgrade_rejected"), { code: secretValues[3], syscall: secretValues[4], errno: 10 }),
      Object.assign(new Error("runner_ingress_unavailable"), { code: "ETIMEDOUT", syscall: "connect", errno: 1.5 }),
    ];
    let index = 0;
    sockets.create = () => {
      const socket = new FakeSocket(); socket.readyState = WebSocket.CONNECTING;
      const error = failures[index++];
      queueMicrotask(() => { socket.readyState = WebSocket.CLOSED; socket.emit("error", error); });
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-log", secretHeaders: [], generation: "log",
      refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: vi.fn() } as unknown as DurablePrpControlPlane,
      endpoint, startupDeadlineMs: 5_000, random: () => 0.5 });
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      const lines = serialized.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
      expect(lines.length).toBeGreaterThan(0);
      for (const secret of secretValues) expect(serialized).not.toContain(secret);
      expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ code: "other", syscall: "other" })]));
      expect(lines).toEqual(expect.arrayContaining([expect.objectContaining({ errno: null })]));
    } finally { await handle.close(); sockets.create = create; warn.mockRestore(); captured.flush(); destination.destroy(); vi.useRealTimers(); }
  });
  it("logs each failed ingress connect attempt with timing and errno", async () => {
    vi.useFakeTimers();
    const create = sockets.create;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    sockets.create = () => {
      const socket = new FakeSocket();
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        socket.readyState = WebSocket.CLOSED;
        socket.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" }));
      });
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-log",
      secretHeaders: [{ name: "Authorization", value: "must-not-log" }], generation: "log", refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: vi.fn() } as unknown as DurablePrpControlPlane,
      endpoint, startupDeadlineMs: 600, random: () => 0.5 });
    try {
      const observed = handle.ready.catch(error => error);
      await vi.advanceTimersByTimeAsync(600);
      const terminal = await observed;
      const records = warn.mock.calls.filter(call => (call[0] as Record<string, unknown>)?.event === "runner_ingress_connect_attempt_failed");
      expect(records.length).toBe(2);
      expect(records.map(call => (call[0] as Record<string, unknown>)?.attempt)).toEqual([1, 2]);
      expect(records[0]?.[0]).toMatchObject({ code: "ECONNREFUSED" });
      expect(JSON.stringify(records)).not.toContain("must-not-log");
      expect(terminal).toMatchObject({ causeSummary: { code: "ECONNREFUSED", errno: -111, syscall: "connect" } });
    } finally { await handle.close(); sockets.create = create; warn.mockRestore(); vi.useRealTimers(); }
  });
  it.each([
    ["an Authorization header in prose", "upgrade failed: Authorization: Bearer sk-live-SECRET123456789 rejected"],
    ["a credentialed URL inside a sentence", "could not reach https://user:pa55w0rd-SECRET@ingress.example/x after retry"],
  ])("never logs raw transport prose carrying %s", async (_label, prose) => {
    vi.useFakeTimers();
    const create = sockets.create;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    sockets.create = () => {
      const socket = new FakeSocket();
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        socket.readyState = WebSocket.CLOSED;
        socket.emit("error", Object.assign(new Error(prose), { code: "ECONNRESET" }));
      });
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-log",
      secretHeaders: [], generation: "log", refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: vi.fn() } as unknown as DurablePrpControlPlane,
      endpoint, startupDeadlineMs: 600, random: () => 0.5 });
    try {
      const terminal = await (async () => { const o = handle.ready.catch(error => error); await vi.advanceTimersByTimeAsync(600); return o; })();
      const records = warn.mock.calls.filter(call => (call[0] as Record<string, unknown>)?.event === "runner_ingress_connect_attempt_failed");
      expect(records.length).toBeGreaterThan(0);
      expect(records[0]?.[0]).toMatchObject({ code: "ECONNRESET", reason: null });
      const logged = JSON.stringify(records) + JSON.stringify((terminal as { causeSummary?: unknown }).causeSummary ?? null);
      expect(logged).not.toContain("SECRET");
      expect(logged).not.toContain("Bearer");
    } finally { await handle.close(); sockets.create = create; warn.mockRestore(); vi.useRealTimers(); }
  });
  it("keeps a bare machine reason code", async () => {
    vi.useFakeTimers();
    const create = sockets.create;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    sockets.create = () => {
      const socket = new FakeSocket();
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => { socket.readyState = WebSocket.CLOSED; socket.emit("error", new Error("runner_ingress_upgrade_rejected")); });
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-log",
      secretHeaders: [], generation: "log", refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: vi.fn() } as unknown as DurablePrpControlPlane,
      endpoint, startupDeadlineMs: 600, random: () => 0.5 });
    try {
      const o = handle.ready.catch(error => error); await vi.advanceTimersByTimeAsync(600); await o;
      const records = warn.mock.calls.filter(call => (call[0] as Record<string, unknown>)?.event === "runner_ingress_connect_attempt_failed");
      expect(records[0]?.[0]).toMatchObject({ reason: "runner_ingress_upgrade_rejected" });
    } finally { await handle.close(); sockets.create = create; warn.mockRestore(); vi.useRealTimers(); }
  });
  it.each(["fresh", "permanently unreachable"] as const)("retries a %s listener only within the startup budget", async mode => {
    vi.useFakeTimers();
    const create = sockets.create;
    const startedAt = Date.now();
    const attempts: number[] = [];
    const wires: FakeSocket[] = [];
    sockets.create = () => {
      attempts.push(Date.now() - startedAt);
      const socket = new FakeSocket();
      wires.push(socket);
      if (mode === "fresh" && Date.now() - startedAt >= 900) return openingSocket(socket);
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        socket.readyState = WebSocket.CLOSED;
        socket.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        socket.emit("close", 1006, Buffer.alloc(0));
      });
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-cold",
      secretHeaders: [], generation: "cold", refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const attach = vi.fn((wire: WsJsonWireConnection) => {
      wire.onJson(value => { if (value === "run.prepare") wire.sendJson("run.prepared"); });
      return { isAuthenticated: () => true };
    });
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: attach } as unknown as DurablePrpControlPlane,
      endpoint, startupDeadlineMs: 2_000, random: () => 0.5 });
    let result: unknown;
    void handle.ready.then(() => { result = "ready"; }, error => { result = error; });
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(attempts.every(at => at < 2_000)).toBe(true);
      if (mode === "fresh") {
        await handle.ready;
        expect(result).toBe("ready");
        const live = wires.at(-1)!;
        live.emit("message", Buffer.from(JSON.stringify("run.prepare")), false);
        expect(live.send).toHaveBeenCalledWith(JSON.stringify("run.prepared"));
        expect(attach).toHaveBeenCalledOnce();
      } else {
        expect(result).toMatchObject({ code: "runner_ingress_unavailable", cause: { code: "ECONNREFUSED" } });
        await expect(handle.failure).rejects.toMatchObject({ code: "runner_ingress_unavailable" });
        expect(attach).not.toHaveBeenCalled();
      }
    } finally { await handle.close(); sockets.create = create; vi.useRealTimers(); }
  });

  it.each(["third attempt opens", "all attempts fail"] as const)("makes at least three initial connect attempts when the event loop consumes the 60 s budget: %s", async mode => {
    vi.useFakeTimers();
    const create = sockets.create;
    let attempts = 0;
    sockets.create = () => {
      attempts++;
      if (attempts === 3 && mode === "third attempt opens") return openingSocket();
      const socket = new FakeSocket();
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        // Model a blocked event loop delivering a refusal only after the whole
        // startup wall budget elapsed. Advancing Date avoids running timers
        // that would not have been serviced during the stall.
        vi.setSystemTime(Date.now() + 61_000);
        socket.readyState = WebSocket.CLOSED;
        socket.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
        socket.emit("close", 1006, Buffer.alloc(0));
      });
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-delayed",
      secretHeaders: [], generation: "delayed", refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: () => ({ isAuthenticated: () => true }) } as unknown as DurablePrpControlPlane,
      endpoint, random: () => 0.5 });
    let result: unknown;
    void handle.ready.then(() => { result = "ready"; }, error => { result = error; });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(3);
      if (mode === "third attempt opens") expect(result).toBe("ready");
      else expect(result).toMatchObject({ code: "runner_ingress_unavailable" });
    } finally { await handle.close(); sockets.create = create; vi.useRealTimers(); }
  });

  it.each([401, 403])("does not extend the default startup budget for an HTTP %s authorization rejection", async statusCode => {
    vi.useFakeTimers();
    const create = sockets.create;
    let attempts = 0;
    sockets.create = () => {
      attempts++;
      const socket = new FakeSocket();
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        vi.setSystemTime(Date.now() + 61_000);
        socket.readyState = WebSocket.CLOSED;
        socket.emit("unexpected-response", {}, { statusCode, resume: vi.fn() });
        socket.emit("close", 1006, Buffer.alloc(0));
      });
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-auth-delayed",
      secretHeaders: [], generation: "auth-delayed", refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: vi.fn() } as unknown as DurablePrpControlPlane, endpoint });
    const observed = handle.ready.catch(error => error);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(await observed).toMatchObject({ code: "runner_ingress_auth_failed" });
      expect(attempts).toBe(1);
      expect(endpoint.refresh).not.toHaveBeenCalled();
    } finally { await handle.close(); sockets.create = create; vi.useRealTimers(); }
  });

  it("bounds an in-flight TLS/upgrade handshake by the remaining startup budget", async () => {
    vi.useFakeTimers();
    const create = sockets.create;
    const handshakeTimeouts: number[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const socket = new FakeSocket();
    sockets.create = options => {
      handshakeTimeouts.push(options.handshakeTimeout);
      socket.readyState = WebSocket.CONNECTING;
      timeout = setTimeout(() => {
        socket.readyState = WebSocket.CLOSED;
        socket.emit("error", new Error("Opening handshake has timed out"));
        socket.emit("close", 1006, Buffer.alloc(0));
      }, options.handshakeTimeout);
      return socket;
    };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-stalled",
      secretHeaders: [], generation: "stalled", refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const attach = vi.fn();
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: attach } as unknown as DurablePrpControlPlane,
      endpoint, startupDeadlineMs: 1_000 });
    let result: unknown;
    void handle.ready.catch(error => { result = error; });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(result).toMatchObject({ code: "runner_ingress_unavailable" });
      expect(handshakeTimeouts).toEqual([1_000]);
      expect(socket.readyState).toBe(WebSocket.CLOSED);
      expect(attach).not.toHaveBeenCalled();
    } finally { if (timeout) clearTimeout(timeout); await handle.close(); sockets.create = create; vi.useRealTimers(); }
  });

  it("bounds credential refresh by the fixed deadline and cancellation", async () => {
    const signal = new AbortController().signal;
    await expect(
      __runnerPrpOutboundTesting.awaitWithinDeadline({
        operation: async () => await new Promise<never>(() => undefined),
        deadline: Date.now() - 1,
        signal,
      }),
    ).rejects.toThrow("deadline elapsed");

    const abort = new AbortController();
    const pending = __runnerPrpOutboundTesting.awaitWithinDeadline({
      operation: async () => await new Promise<never>(() => undefined),
      deadline: Date.now() + 60_000,
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("delivers one terminal close to both PRP authority and reconnect ownership", () => {
    const socket = new FakeSocket();
    const wire = new WsJsonWireConnection(
      socket as unknown as WebSocket,
    );
    const authorityClose = vi.fn();
    const reconnectClose = vi.fn();
    wire.onClose(authorityClose);
    wire.onClose(reconnectClose);

    const error = new Error("preview disconnected");
    socket.emit("error", error);
    socket.emit("close", 1006, Buffer.from("duplicate close"));

    expect(authorityClose).toHaveBeenCalledOnce();
    expect(reconnectClose).toHaveBeenCalledOnce();
    expect(authorityClose).toHaveBeenCalledWith({
      message: "websocket_error",
      error,
    });
  });

  it("replays a close to a listener registered after the socket ended", () => {
    const socket = new FakeSocket();
    const wire = new WsJsonWireConnection(
      socket as unknown as WebSocket,
    );
    socket.emit("close", 1001, Buffer.from("sandbox restart"));
    const listener = vi.fn();
    wire.onClose(listener);
    expect(listener).toHaveBeenCalledWith({
      code: 1001,
      message: "sandbox restart",
    });
  });

  it("reports a terminal ingress failure to startup and active-run ownership", async () => {
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "ws://preview.invalid/api/runner/v1/connect/run-1",
      secretHeaders: [],
      generation: "generation-1",
      refresh: async () => endpoint,
      close: async () => undefined,
    };
    const handle = connectRunnerPrpIngress({
      authority: {
        attachWireConnection: vi.fn(),
        activeRunnerConnectionCount: () => 0,
      } as unknown as DurablePrpControlPlane,
      endpoint,
      startupDeadlineMs: 0,
      recoveryGraceMs: 0,
    });

    const [ready, failure] = await Promise.allSettled([
      handle.ready,
      handle.failure,
    ]);
    expect(ready).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "runner_ingress_unavailable" }),
    });
    expect(failure).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "runner_ingress_unavailable" }),
    });
    await handle.close();
  });

  it("keeps an unobserved active-run failure from becoming process-global", async () => {
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "ws://preview.invalid/api/runner/v1/connect/run-unobserved",
      secretHeaders: [],
      generation: "generation-1",
      refresh: async () => endpoint,
      close: async () => undefined,
    };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const handle = connectRunnerPrpIngress({
        authority: {
          attachWireConnection: vi.fn(),
          activeRunnerConnectionCount: () => 0,
        } as unknown as DurablePrpControlPlane,
        endpoint,
        startupDeadlineMs: 0,
        recoveryGraceMs: 0,
      });
      await expect(handle.ready).rejects.toMatchObject({
        code: "runner_ingress_unavailable",
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await handle.close();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each(["delayed_ack", "no_ack", "unconfirmed_termination", "error_before_close"] as const)("retires authenticated %s ingress within the native setup close budget", async (mode) => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    let activeConnections = 0;
    const closeFrameOwners: number[] = [];
    socket.close = vi.fn(() => {
      closeFrameOwners.push(activeConnections);
      socket.readyState = WebSocket.CLOSING;
      if (mode === "delayed_ack") {
        setTimeout(() => {
          socket.readyState = WebSocket.CLOSED;
          socket.emit("close", 1001, Buffer.alloc(0));
        }, 250);
      }
    });
    const finishClose = () => {
      socket.readyState = WebSocket.CLOSED;
      socket.emit("close", 1006, Buffer.alloc(0));
    };
    const terminate = vi.fn(() => {
      if (mode === "error_before_close") socket.emit("error", new Error("fixture termination pending"));
      else if (mode !== "unconfirmed_termination") finishClose();
    });
    Object.assign(socket, { terminate });
    const create = sockets.create;
    sockets.create = () => openingSocket(socket);
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-authenticated",
      secretHeaders: [{ name: "Authorization", value: "fixture-only" }],
      generation: "generation-authenticated",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => { expect(activeConnections).toBe(0); }),
    };
    const attachWireConnection = vi.fn((wire: WsJsonWireConnection) => {
      expect(activeConnections).toBe(0);
      activeConnections += 1;
      wire.onClose(() => { activeConnections -= 1; });
      return { isAuthenticated: () => true };
    });
    const handle = connectRunnerPrpIngress({
      authority: { attachWireConnection, activeRunnerConnectionCount: () => activeConnections } as unknown as DurablePrpControlPlane,
      endpoint,
      startupDeadlineMs: 60_000,
      recoveryGraceMs: 60_000,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    let closing: Promise<void> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      await handle.ready;
      expect(activeConnections).toBe(1);
      closing = handle.close();
      expect(closeFrameOwners).toEqual([1]);
      if (socket.readyState !== WebSocket.CLOSED) {
        expect(activeConnections).toBe(mode === "error_before_close" ? 0 : 1);
        expect(endpoint.close).not.toHaveBeenCalled();
      }
      const outcome = Promise.race([
        closing.then(() => "closed"),
        new Promise<string>((resolve) => { deadline = setTimeout(() => resolve("setup_cleanup_deadline"), 10_000); }),
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(terminate).toHaveBeenCalledOnce();
      expect({ outcome: await outcome, activeConnections, endpointReleased: endpoint.close.mock.calls.length }).toEqual(["unconfirmed_termination", "error_before_close"].includes(mode)
        ? { outcome: "setup_cleanup_deadline", activeConnections: mode === "error_before_close" ? 0 : 1, endpointReleased: 0 }
        : { outcome: "closed", activeConnections: 0, endpointReleased: 1 });
      expect(attachWireConnection).toHaveBeenCalledOnce();
      expect(endpoint.refresh).not.toHaveBeenCalled();
      expect(failureObserver).not.toHaveBeenCalled();
      if (["unconfirmed_termination", "error_before_close"].includes(mode)) return;
      sockets.create = () => openingSocket();
      const successor = connectRunnerPrpIngress({
        authority: { attachWireConnection, activeRunnerConnectionCount: () => activeConnections } as unknown as DurablePrpControlPlane,
        endpoint,
      });
      await vi.advanceTimersByTimeAsync(0);
      await successor.ready;
      expect(activeConnections).toBe(1);
      await successor.close();
      expect(activeConnections).toBe(0);
      expect(attachWireConnection).toHaveBeenCalledTimes(2);
    } finally {
      if (deadline) clearTimeout(deadline);
      finishClose();
      await (closing ?? handle.close());
      sockets.create = create;
      vi.useRealTimers();
    }
  });

  it("retains an errored prior socket until physical close during reconnect shutdown", async () => {
    const prior = new FakeSocket();
    prior.close = vi.fn(() => { prior.readyState = WebSocket.CLOSING; });
    const pending = new FakeSocket();
    const create = sockets.create;
    let activeConnections = 0;
    let opens = 0;
    sockets.create = () => {
      opens += 1;
      if (opens === 1) return openingSocket(prior);
      pending.readyState = WebSocket.CONNECTING;
      return pending;
    };
    const endpointCloseStates: number[][] = [];
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-reconnecting",
      secretHeaders: [],
      generation: "generation-reconnecting",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => { endpointCloseStates.push([prior.readyState, pending.readyState]); }),
    };
    const attachWireConnection = vi.fn((wire: WsJsonWireConnection) => {
      activeConnections += 1;
      wire.onClose(() => { activeConnections -= 1; });
      return { isAuthenticated: () => true };
    });
    const handle = connectRunnerPrpIngress({
      authority: { attachWireConnection, activeRunnerConnectionCount: () => activeConnections } as unknown as DurablePrpControlPlane,
      endpoint,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    let closing: Promise<void> | undefined;
    try {
      await handle.ready;
      prior.readyState = WebSocket.CLOSING;
      prior.emit("error", new Error("fixture prior socket error"));
      await new Promise(resolve => setImmediate(resolve));
      expect(opens).toBe(2);
      expect(activeConnections).toBe(0);
      expect(prior.readyState).toBe(WebSocket.CLOSING);
      closing = handle.close();
      await closing;
      expect({ priorTerminations: prior.terminate.mock.calls.length, endpointCloseStates: endpointCloseStates.map(states => [...states]) }).toEqual({
        priorTerminations: 1, endpointCloseStates: [[WebSocket.CLOSED, WebSocket.CLOSED]],
      });
      expect(attachWireConnection).toHaveBeenCalledOnce();
      expect(failureObserver).not.toHaveBeenCalled();
      expect(endpoint.refresh).not.toHaveBeenCalled();
    } finally {
      prior.terminate();
      pending.terminate();
      await (closing ?? handle.close());
      sockets.create = create;
    }
  });

  it("joins a just-opened socket without attaching authority after intentional close", async () => {
    const socket = new FakeSocket();
    const create = sockets.create;
    let closing: Promise<void> | undefined;
    sockets.create = () => {
      socket.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        socket.readyState = WebSocket.OPEN;
        socket.emit("open");
        closing = handle.close();
      });
      return socket;
    };
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-opening",
      secretHeaders: [],
      generation: "generation-opening",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => { expect(socket.readyState).toBe(WebSocket.CLOSED); }),
    };
    const attachWireConnection = vi.fn(() => ({ isAuthenticated: () => true }));
    const handle = connectRunnerPrpIngress({
      authority: { attachWireConnection, activeRunnerConnectionCount: () => 0 } as unknown as DurablePrpControlPlane,
      endpoint,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    try {
      await expect(handle.ready).rejects.toThrow("closed before it became ready");
      await closing;
      expect(socket.close).toHaveBeenCalledExactlyOnceWith(1001);
      expect(socket.terminate).toHaveBeenCalledOnce();
      expect(attachWireConnection).not.toHaveBeenCalled();
      expect(endpoint.close).toHaveBeenCalledOnce();
      expect(endpoint.refresh).not.toHaveBeenCalled();
      expect(failureObserver).not.toHaveBeenCalled();
    } finally {
      await (closing ?? handle.close());
      sockets.create = create;
    }
  });

  it.each(["readiness", "authenticated observer"])("does not start liveness when quiesce wins %s", async mode => {
    vi.useFakeTimers();
    const create = sockets.create, socket = new FakeSocket();
    sockets.create = () => openingSocket(socket);
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://fixture.example.test/connect", secretHeaders: [], generation: "fixture",
      refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const handle = connectRunnerPrpIngress({ authority: {
      attachWireConnection: () => ({ isAuthenticated: () => {
        if (mode === "readiness") handle.quiesce();
        return true;
      } }),
    } as unknown as DurablePrpControlPlane, endpoint,
    onStateChange: state => { if (state === "authenticated" && mode === "authenticated observer") handle.quiesce(); } });
    try {
      await vi.advanceTimersByTimeAsync(100_000);
      expect(socket.ping).not.toHaveBeenCalled();
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(socket.close).not.toHaveBeenCalled();
      expect(endpoint.refresh).not.toHaveBeenCalled();
    } finally { await handle.close(); sockets.create = create; vi.useRealTimers(); }
  });

  it("quiets liveness and reconnect while preserving the final receive/ACK path", async () => {
    vi.useFakeTimers();
    const create = sockets.create;
    const socket = new FakeSocket();
    let opens = 0;
    sockets.create = () => { opens += 1; return openingSocket(socket); };
    const endpoint = { kind: "authenticated_websocket" as const,
      websocketUrl: "wss://fixture.example.test/connect", secretHeaders: [], generation: "fixture",
      refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
    const received = vi.fn();
    const attach = vi.fn((wire: WsJsonWireConnection) => {
      wire.onJson(value => { received(value); wire.sendJson({ kind: "ack" }); });
      return { isAuthenticated: () => true };
    });
    const handle = connectRunnerPrpIngress({ authority: { attachWireConnection: attach } as unknown as DurablePrpControlPlane,
      endpoint, livenessIntervalMs: 10, livenessTimeoutMs: 30 });
    const failure = vi.fn();
    void handle.failure.catch(failure);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await handle.ready;
      handle.quiesce();
      socket.ping.mockClear();
      socket.emit("message", Buffer.from(JSON.stringify({ kind: "last_event" })), false);
      expect(received).toHaveBeenCalledWith({ kind: "last_event" });
      expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ kind: "ack" }));
      await vi.advanceTimersByTimeAsync(100_000);
      expect(socket.ping).not.toHaveBeenCalled();
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(socket.close).not.toHaveBeenCalled();
      socket.close();
      await vi.advanceTimersByTimeAsync(100_000);
      expect(opens).toBe(1);
      expect(endpoint.refresh).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
    } finally { await handle.close(); sockets.create = create; vi.useRealTimers(); }
  });

  it("does not report intentional close as an active-run ingress failure", async () => {
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://127.0.0.1:9/api/runner/v1/connect/run-1",
      secretHeaders: [],
      generation: "generation-1",
      refresh: async () => endpoint,
      close: vi.fn(async () => undefined),
    };
    const handle = connectRunnerPrpIngress({
      authority: {
        attachWireConnection: vi.fn(),
        activeRunnerConnectionCount: () => 0,
      } as unknown as DurablePrpControlPlane,
      endpoint,
      startupDeadlineMs: 60_000,
      recoveryGraceMs: 60_000,
    });
    const failureObserver = vi.fn();
    void handle.failure.catch(failureObserver);
    void handle.ready.catch(() => undefined);

    await handle.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(failureObserver).not.toHaveBeenCalled();
    expect(endpoint.close).toHaveBeenCalledOnce();
  });
  it("detects a half-open authenticated ingress and fails the run within a bounded window", async () => {
    vi.useFakeTimers();
    const halfOpen = new FakeSocket();
    const create = sockets.create;
    let opens = 0;
    // The first socket authenticates and then goes silent without a FIN, as a
    // preview proxy that drops the connection does. Reconnects cannot reach a
    // runner whose process already exited.
    sockets.create = () => {
      opens += 1;
      if (opens === 1) return openingSocket(halfOpen);
      const refused = new FakeSocket();
      refused.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        refused.readyState = WebSocket.CLOSED;
        refused.emit("error", new Error("fixture runner gone"));
      });
      return refused;
    };
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-half-open",
      secretHeaders: [],
      generation: "generation-half-open",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => undefined),
    };
    const states: string[] = [];
    const handle = connectRunnerPrpIngress({
      authority: {
        attachWireConnection: vi.fn(() => ({ isAuthenticated: () => true })),
        activeRunnerConnectionCount: () => 0,
      } as unknown as DurablePrpControlPlane,
      endpoint,
      recoveryGraceMs: 60_000,
      livenessIntervalMs: 10_000,
      livenessTimeoutMs: 30_000,
      onStateChange: (state) => states.push(state),
    });
    const failure = vi.fn();
    void handle.failure.catch(failure);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await handle.ready;
      await vi.advanceTimersByTimeAsync(29_000);
      expect(halfOpen.terminate).not.toHaveBeenCalled();
      expect(halfOpen.ping).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(halfOpen.terminate).toHaveBeenCalledOnce();
      expect(states).toContain("reconnecting");
      await vi.advanceTimersByTimeAsync(61_000);
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ code: "runner_ingress_unavailable" }),
      );
    } finally {
      await handle.close();
      sockets.create = create;
      vi.useRealTimers();
    }
  });

  it.each(["refused", "unauthenticated"] as const)("names an expired runner connection lease in the run log and terminal error when reconnect is %s", async reconnect => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const create = sockets.create;
    let opens = 0;
    sockets.create = () => {
      opens += 1;
      if (opens === 1) return openingSocket(first);
      // An open socket whose PRP authentication never completes, as when the
      // controller refuses the runner's lapsed credential.
      if (reconnect === "unauthenticated") return openingSocket();
      const refused = new FakeSocket();
      refused.readyState = WebSocket.CONNECTING;
      queueMicrotask(() => {
        refused.readyState = WebSocket.CLOSED;
        refused.emit("error", new Error("fixture runner exited"));
      });
      return refused;
    };
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-lease-expired",
      secretHeaders: [],
      generation: "generation-lease-expired",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => undefined),
    };
    let leaseFailure: { code: string } | null = null;
    const states: Array<[string, string | undefined]> = [];
    const handle = connectRunnerPrpIngress({
      authority: {
        attachWireConnection: vi.fn(() => {
          const authenticated = opens === 1;
          return { isAuthenticated: () => authenticated };
        }),
        activeRunnerConnectionCount: () => 0,
        get connectionLeaseFailure() { return leaseFailure; },
      } as unknown as DurablePrpControlPlane,
      endpoint,
      recoveryGraceMs: 10_000,
      onStateChange: (state, code) => states.push([state, code]),
    });
    const failure = vi.fn();
    void handle.failure.catch(failure);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await handle.ready;
      // The runner's lease lapsed; it exits and the socket closes.
      leaseFailure = { code: "connection_lease_expired" };
      first.close(1006);
      await vi.advanceTimersByTimeAsync(0);
      expect(states).toContainEqual(["reconnecting", "runner_connection_lease_expired"]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ code: "runner_connection_lease_expired" }),
      );
    } finally {
      await handle.close();
      sockets.create = create;
      vi.useRealTimers();
    }
  });

  it("keeps a quiet but live runner attached through a long silent tool call", async () => {
    vi.useFakeTimers();
    const live = new FakeSocket();
    // A live runnerd answers protocol pings even while its provider is
    // blocked on a minutes-long foreground command that prints nothing.
    live.ping = vi.fn(() => {
      queueMicrotask(() => live.emit("pong", Buffer.alloc(0)));
    });
    const create = sockets.create;
    sockets.create = () => openingSocket(live);
    const endpoint = {
      kind: "authenticated_websocket" as const,
      websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-quiet",
      secretHeaders: [],
      generation: "generation-quiet",
      refresh: vi.fn(async () => endpoint),
      close: vi.fn(async () => undefined),
    };
    const attachWireConnection = vi.fn(() => ({ isAuthenticated: () => true }));
    const handle = connectRunnerPrpIngress({
      authority: { attachWireConnection, activeRunnerConnectionCount: () => 1 } as unknown as DurablePrpControlPlane,
      endpoint,
      livenessIntervalMs: 10_000,
      livenessTimeoutMs: 30_000,
    });
    const failure = vi.fn();
    void handle.failure.catch(failure);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await handle.ready;
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(live.terminate).not.toHaveBeenCalled();
      expect(attachWireConnection).toHaveBeenCalledOnce();
      expect(failure).not.toHaveBeenCalled();
    } finally {
      await handle.close();
      sockets.create = create;
      vi.useRealTimers();
    }
  });
  it("reports only received pongs as fresh evidence, not liveness timer resets", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const wire = new WsJsonWireConnection(socket as unknown as WebSocket);
      const receivedPong = vi.fn();
      wire.onPong(receivedPong);
      const stop = wire.monitorLiveness({ intervalMs: 10_000, timeoutMs: 30_000 });
      expect(receivedPong).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 5 * 60_000);
      vi.advanceTimersByTime(10_000);
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(receivedPong).not.toHaveBeenCalled();
      socket.emit("pong", Buffer.alloc(0));
      expect(receivedPong).toHaveBeenCalledOnce();
      socket.emit("close", 1000, Buffer.alloc(0));
      socket.emit("pong", Buffer.alloc(0));
      expect(receivedPong).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not blame the runner for a server event-loop stall", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const wire = new WsJsonWireConnection(socket as unknown as WebSocket);
      const stop = wire.monitorLiveness({ intervalMs: 10_000, timeoutMs: 30_000 });
      expect(socket.ping).toHaveBeenCalledOnce();
      // The server's own loop is blocked for 5 minutes: no timers fire and
      // the runner's pongs sit unread. The next tick must restart the window.
      vi.setSystemTime(Date.now() + 5 * 60_000);
      vi.advanceTimersByTime(10_000);
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(socket.ping).toHaveBeenCalledTimes(2);
      // Genuine silence after the stall is still detected.
      vi.advanceTimersByTime(30_000);
      expect(socket.terminate).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pings a healthy peer before any deadline, even with an interval longer than the timeout", () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      socket.ping = vi.fn(() => { queueMicrotask(() => socket.emit("pong", Buffer.alloc(0))); });
      const wire = new WsJsonWireConnection(socket as unknown as WebSocket);
      const stop = wire.monitorLiveness({ intervalMs: 60_000, timeoutMs: 30_000 });
      expect(socket.ping).toHaveBeenCalledOnce();
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(15_000);
        // Deliver the queued pong before the next tick, as a live peer would.
        socket.emit("pong", Buffer.alloc(0));
      }
      expect(socket.terminate).not.toHaveBeenCalled();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
