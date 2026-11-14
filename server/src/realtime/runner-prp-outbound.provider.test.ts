import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { connectRunnerPrpIngress } from "./runner-prp-outbound.js";

// Only configuration/discovery and the external worker/transport are fixtures.
// In particular, neither getRunnerIngressEndpoint nor endpoint.refresh is mocked:
// this exercises the real runtime's capability gate and captured acquire closure.
vi.mock("../services/environment-config.js", async original => ({
  ...await original<typeof import("../services/environment-config.js")>(),
  resolveEnvironmentDriverConfigForRuntime: vi.fn(async () => ({
    driver: "sandbox", config: { provider: "route-counter" },
  })),
}));
vi.mock("../services/plugin-environment-driver.js", async original => ({
  ...await original<typeof import("../services/plugin-environment-driver.js")>(),
  resolvePluginSandboxProviderDriverById: vi.fn(async () => ({
    plugin: { id: "plugin-original", status: "ready" },
    driver: { kind: "sandbox_provider", key: "route-counter", sandboxCapabilities: { runnerWebSocketIngress: true } },
  })),
}));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
const transport = vi.hoisted(() => ({ create: undefined as undefined | ((url: string) => unknown) }));
vi.mock("ws", async original => {
  const actual = await original<typeof import("ws")>();
  return { ...actual, default: Object.assign(vi.fn(function(url: string) { return transport.create!(url); }), {
    CONNECTING: actual.default.CONNECTING, OPEN: actual.default.OPEN,
    CLOSING: actual.default.CLOSING, CLOSED: actual.default.CLOSED,
  }) };
});
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
function refused() {
  const socket = new Socket();
  queueMicrotask(() => {
    socket.readyState = WebSocket.CLOSED;
    socket.emit("error", Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    socket.emit("close", 1006, Buffer.alloc(0));
  });
  return socket;
}

describe("outbound recovery through the real plugin ingress acquire closure", () => {
  it.each([false, true])("reacquires only the same lease's route, with no provider create/start (warm=%s)", async warm => {
    vi.useFakeTimers();
    const counters = { create: 0, start: 0, route: 0 };
    const routeInputs: Array<{ pluginId: string; input: Record<string, unknown> }> = [];
    const path = "/api/runner/v1/connect/run-original";
    const providerLeaseId = "box-original";
    const call = vi.fn(async (pluginId: string, method: string, input: Record<string, unknown>) => {
      // Count lifecycle calls as well as route acquisition. A regression that
      // replaces refresh with allocation/resume is observable, not hidden by an
      // endpoint-wide stub. The provider dispatcher has no implicit fallback.
      if (method === "environmentAcquireLease") {
        counters.create++; counters.start++;
        return { providerLeaseId: "box-NEW", metadata: {} };
      }
      if (method === "environmentResumeLease") { counters.start++; return { providerLeaseId }; }
      if (method !== "environmentRunnerIngressEndpoint") throw new Error(`unexpected provider call: ${method}`);
      counters.route++;
      routeInputs.push({ pluginId, input });
      return {
        kind: "authenticated_websocket", generation: "generation-original",
        websocketUrl: `wss://${counters.route === 1 ? "stale" : "repaired"}.fixture.invalid${path}`,
        secretHeaders: [],
      };
    });
    const manager = { call, getWorker: () => ({ supportedMethods: [
      "environmentRunnerIngressEndpoint", "environmentAcquireLease", "environmentResumeLease",
    ] }) } as unknown as PluginWorkerManager;
    // No database work is needed to refresh a captured lease. Any accidental
    // allocation/config rediscovery that tries to use it fails this check too.
    const db = new Proxy({}, { get: (_target, key) => { throw new Error(`unexpected database work: ${String(key)}`); } }) as Db;
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: manager });
    const now = new Date();
    const environment: Environment = { id: "environment-original", name: "Existing environment", description: null,
      driver: "sandbox", status: "active", config: { provider: "route-counter" }, envVars: {}, metadata: null,
      createdAt: now, updatedAt: now };
    const lease: EnvironmentLease = {
      id: "lease-original", companyId: "company-original", environmentId: environment.id,
      issueId: "issue-original", provider: "sandbox", providerLeaseId, status: "active",
      leasePolicy: "reuse_by_environment", expiresAt: null, executionWorkspaceId: null, heartbeatRunId: null,
      acquiredAt: now, lastUsedAt: now, releasedAt: null, failureReason: null, cleanupStatus: null,
      createdAt: now, updatedAt: now,
      metadata: { sandboxProviderPlugin: true, pluginId: "plugin-original", provider: "route-counter" },
    };
    const endpoint = await runtime.getRunnerIngressEndpoint({ environment, lease, port: 3101, path });
    let first: Socket | undefined;
    const urls: string[] = [];
    transport.create = url => {
      urls.push(url);
      if (warm && !first) { first = opened(); return first; }
      return url.includes("repaired.fixture.invalid") ? opened() : refused();
    };
    const attach = vi.fn(() => ({ isAuthenticated: () => true }));
    const handle = connectRunnerPrpIngress({ endpoint,
      authority: { attachWireConnection: attach } as unknown as DurablePrpControlPlane,
      startupDeadlineMs: 5_000, recoveryGraceMs: 5_000, random: () => 0.5,
    });
    try {
      if (warm) { await vi.advanceTimersByTimeAsync(0); await handle.ready; first!.close(); }
      await vi.advanceTimersByTimeAsync(1_500);
      await handle.ready;
      expect(counters).toEqual({ create: 0, start: 0, route: 2 });
      expect(routeInputs).toHaveLength(2);
      expect(routeInputs[1]).toEqual(routeInputs[0]);
      expect(routeInputs[1]).toMatchObject({ pluginId: "plugin-original", input: {
        driverKey: "route-counter", companyId: "company-original", environmentId: "environment-original",
        issueId: "issue-original", lease: { providerLeaseId: "box-original" }, port: 3101, path,
      } });
      expect(urls).toEqual(warm
        ? [endpoint.websocketUrl, endpoint.websocketUrl, `wss://repaired.fixture.invalid${path}`]
        : [endpoint.websocketUrl, `wss://repaired.fixture.invalid${path}`]);
      expect(attach).toHaveBeenCalledTimes(warm ? 2 : 1);
      console.info("M1_PROVIDER_COUNTERS " + JSON.stringify({ warm, ...counters, providerLeaseIds: routeInputs.map(({ input }) => (input.lease as { providerLeaseId: string }).providerLeaseId) }));
    } finally { await handle.close(); vi.useRealTimers(); }
    expect(counters).toEqual({ create: 0, start: 0, route: 2 });
  });
});
