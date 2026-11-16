import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { logger } from "../middleware/logger.js";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress, type WsJsonWireConnection } from "./runner-prp-outbound.js";
import { createNativeRunnerExecutionDriver } from "../services/native-runtime/native-runner-execution-driver.js";

// #20825 fix-up (judge FAIL, RFL 07:19Z): who decides that a dropped warm
// route may outlive its 7-min recovery budget, and what a handshake that did
// not authenticate means. Fake wires and timers; the driver and the outbound
// handle are the real modules.
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
  ping = vi.fn(() => { queueMicrotask(() => this.emit("pong", Buffer.alloc(0))); });
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

const MIN = 60_000;
type Handshake = "authenticate" | "peer_drop_1006" | "never_authenticates" | "control_plane_refuses";

/** The control plane's observable contract for one session. Each attached
 * wire follows the next scripted handshake (the last one repeats). */
function controlPlane(input: {
  leaseExpiresAt: number;
  handshakes: Handshake[];
  commands?: Array<{ type: string; status: string }>;
}) {
  const state = {
    lastLeaseExpiresAt: new Date(input.leaseExpiresAt).toISOString() as string | null,
    commands: input.commands ?? [],
  };
  let attaches = 0;
  let authenticated = 0;
  let live = 0;
  const attachWireConnection = vi.fn((wire: WsJsonWireConnection) => {
    const handshake = input.handshakes[Math.min(attaches, input.handshakes.length - 1)]!;
    attaches += 1;
    if (handshake === "peer_drop_1006") {
      // The box's TCP leg dies after the upgrade, before PRP authentication.
      queueMicrotask(() => (wire.socket as unknown as FakeSocket).terminate());
      return { isAuthenticated: () => false };
    }
    if (handshake === "never_authenticates") return { isAuthenticated: () => false };
    if (handshake === "control_plane_refuses") {
      // The real authority closes with its default code (connection.close()).
      queueMicrotask(() => wire.close());
      return { isAuthenticated: () => false };
    }
    authenticated += 1;
    live += 1;
    wire.socket.once("close", () => { live -= 1; });
    return { isAuthenticated: () => true };
  });
  const authority = {
    attachWireConnection, store: { state }, activeRunnerConnectionCount: () => live,
    get connectionLeaseFailure() { return null; },
  } as unknown as DurablePrpControlPlane;
  return { authority, state, attaches: () => attaches, authenticated: () => authenticated };
}

const endpointFixture = () => {
  const endpoint = { kind: "authenticated_websocket" as const,
    websocketUrl: "wss://preview.invalid/api/runner/v1/connect/run-owner", secretHeaders: [], generation: "owner",
    refresh: vi.fn(async () => endpoint), close: vi.fn(async () => {}) };
  return endpoint;
};

/** Every dial reaches the box; a refused box fails at once. */
function box(input: { down: () => boolean }) {
  const dials: number[] = [];
  const opened: FakeSocket[] = [];
  const create = () => {
    dials.push(Date.now());
    if (!input.down()) { const socket = openingSocket(); opened.push(socket); return socket; }
    const socket = new FakeSocket();
    socket.readyState = WebSocket.CONNECTING;
    queueMicrotask(() => {
      socket.readyState = WebSocket.CLOSED;
      socket.emit("error", Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED", errno: -111, syscall: "connect" }));
      socket.emit("close", 1006, Buffer.alloc(0));
    });
    return socket;
  };
  return { dials, opened, create };
}

describe("the warm route's owner decides idleness; a handshake is refused only by the control plane (#20825 fix-up)", () => {
  it("F1: a BUSY owner whose accepted turn left no pending CP command rejects at the 7-min budget with a named code, and dials no more", async () => {
    vi.useFakeTimers();
    const create = sockets.create;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const t0 = Date.now();
    // runnerd completed turn.start when it ACCEPTED the turn: nothing is pending
    // in the control plane, yet the person's turn is running.
    const cp = controlPlane({ leaseExpiresAt: t0 + 60 * MIN, handshakes: ["authenticate"],
      commands: [{ type: "run.prepare", status: "completed" }, { type: "turn.start", status: "completed" }] });
    let down = false;
    const theBox = box({ down: () => down });
    sockets.create = () => theBox.create();
    const logs: string[] = [];
    const ingress = endpointFixture();
    const driver = createNativeRunnerExecutionDriver({
      binding: { companyId: "company", issueId: "issue", agentId: "agent", runId: "run-busy" },
      runnerIngressAuthorized: true, prepareRemote: async () => {}, processStarted: Promise.resolve(),
      target: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", leaseId: "lease",
        effectiveCapabilities: { runnerWebSocketIngress: true }, getRunnerIngressEndpoint: async () => ingress } as unknown as AdapterExecutionTarget,
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    } as Parameters<typeof createNativeRunnerExecutionDriver>[0]);
    const registration = await driver.controlPlaneRegistration!(cp.authority);
    // The owner (the transport's own predicate): an accepted turn is in flight.
    (registration as { bindOwnerIdle?: (isIdle: () => boolean) => void }).bindOwnerIdle?.(() => false);
    const failed = vi.fn();
    try {
      registration.activate!();
      void registration.failure!.catch(failed);
      const ready = registration.ready!();
      await vi.advanceTimersByTimeAsync(100);
      await ready;
      expect(cp.authenticated()).toBe(1);
      const droppedAt = Date.now();
      down = true;
      // The link dies mid-turn.
      theBox.opened[0]!.terminate();
      await vi.advanceTimersByTimeAsync(6 * MIN + 30_000);
      expect(failed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(MIN + 30_000);
      // The fixed recovery budget (~7 min), not lease expiry minus margin (~58 min).
      expect(failed).toHaveBeenCalledOnce();
      expect(Date.now() - droppedAt).toBeLessThan(9 * MIN);
      const error = failed.mock.calls[0]![0] as { code?: unknown; ingressCode?: unknown; message?: unknown };
      expect(error).toMatchObject({ code: "native_runner_ingress_recovery_exhausted", ingressCode: "runner_ingress_unavailable" });
      expect(String(error.message)).toMatch(/^native_runner_ingress_recovery_exhausted: /);
      expect(logs.some(line => line.includes("state=failed failure=runner_ingress_unavailable"))).toBe(true);
      const dialsAtFailure = theBox.dials.length;
      await vi.advanceTimersByTimeAsync(30 * MIN);
      expect(theBox.dials.length).toBe(dialsAtFailure);
    } finally { await registration.release(); sockets.create = create; warn.mockRestore(); vi.useRealTimers(); }
  });

  it.each([
    ["a peer drop (1006) before authentication", "peer_drop_1006"],
    ["a slow authentication (no answer before the window ends)", "never_authenticates"],
  ] as const)("F3: an IDLE owner keeps redialing after %s; a healthy box then reconnects (no retire)", async (_label, failedHandshake) => {
    vi.useFakeTimers();
    const create = sockets.create;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const t0 = Date.now();
    const cp = controlPlane({ leaseExpiresAt: t0 + 60 * MIN, handshakes: ["authenticate", failedHandshake, "authenticate"] });
    const theBox = box({ down: () => false });
    const first = openingSocket();
    let opens = 0;
    sockets.create = () => (++opens === 1 ? first : theBox.create());
    const handle = connectRunnerPrpIngress({ authority: cp.authority, endpoint: endpointFixture(), random: () => 0.5,
      idleWarm: { isIdle: () => true } });
    const failed = vi.fn();
    void handle.failure.catch(failed);
    try {
      await vi.advanceTimersByTimeAsync(100);
      await handle.ready;
      first.terminate();
      await vi.advanceTimersByTimeAsync(9 * MIN);
      expect(failed).not.toHaveBeenCalled();
      expect(cp.attaches()).toBeGreaterThanOrEqual(3);
      expect(cp.authenticated()).toBe(2);
      expect(warn.mock.calls.map(call => (call[0] as Record<string, unknown>)?.event)).not.toContain("runner_ingress_retired");
    } finally { await handle.close(); sockets.create = create; warn.mockRestore(); vi.useRealTimers(); }
  });

  it("F3 guard: a real control-plane refusal of an IDLE reconnect (it closes the wire) still retires at the first failed handshake", async () => {
    vi.useFakeTimers();
    const create = sockets.create;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
    const t0 = Date.now();
    const cp = controlPlane({ leaseExpiresAt: t0 + 60 * MIN, handshakes: ["authenticate", "control_plane_refuses"] });
    const theBox = box({ down: () => false });
    const first = openingSocket();
    let opens = 0;
    sockets.create = () => (++opens === 1 ? first : theBox.create());
    const handle = connectRunnerPrpIngress({ authority: cp.authority, endpoint: endpointFixture(), random: () => 0.5,
      idleWarm: { isIdle: () => true } });
    const failed = vi.fn();
    void handle.failure.catch(failed);
    try {
      await vi.advanceTimersByTimeAsync(100);
      await handle.ready;
      first.terminate();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(theBox.dials).toHaveLength(1);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: "native_runner_ingress_unreachable",
        causeSummary: expect.objectContaining({ failure: "runner_ingress_auth_failed" }) }));
    } finally { await handle.close(); sockets.create = create; warn.mockRestore(); vi.useRealTimers(); }
  });
});
