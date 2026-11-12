import { afterEach, describe, expect, it } from "vitest";
import { createSubagentLifecycle, SESSION_LIVENESS_KEY, type LivenessRegistry } from "./lifecycle.js";

const globals = globalThis as unknown as Record<symbol, unknown>;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); delete globals[SESSION_LIVENESS_KEY]; });
class Bus {
  listeners = new Map<string, Set<(data: any) => void>>();
  requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  handle: (method: string, params: Record<string, unknown>) => unknown = () => ({});
  on(name: string, fn: (data: any) => void) { const set = this.listeners.get(name) ?? new Set(); set.add(fn); this.listeners.set(name, set); return () => { set.delete(fn); }; }
  emit(name: string, data: any) {
    for (const fn of this.listeners.get(name) ?? []) fn(data);
    if (name === "subagents:rpc:v1:request") {
      expect(data.version).toBe(1); this.requests.push(data);
      const result = this.handle(data.method, data.params);
      if (result !== undefined) this.emit(`subagents:rpc:v1:reply:${data.requestId}`, { version: 1, requestId: data.requestId, success: true, data: result });
    }
  }
}
const snapshot = (runs: Array<{ id: string; state: string }> = [], omitted = { runs: 0, children: 0, byteLimitExceeded: false }) => ({ asyncSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot", runs, omitted } });
const proof = (id: string, instance = "runner-1", state = "observed") => ({ version: 1, runId: id, runnerProcessInstanceId: instance, state });
function setup(options: { timeoutMs?: number; sessionId?: string; abortParent?: () => void | Promise<void>; hasSubagentTool?: () => boolean } = {}) {
  const bus = new Bus();
  const registered: Record<string, Function> = {};
  let aborted = false;
  const lifecycle = createSubagentLifecycle({ sessionId: options.sessionId ?? "parent", events: bus, abortParent: async () => { aborted = true; await options.abortParent?.(); }, hasSubagentTool: options.hasSubagentTool, timeoutMs: options.timeoutMs ?? 100, rpcTimeoutMs: 30,
    seam: { registerParkReadyContributor: fn => { registered.park = fn; return () => { delete registered.park; }; }, registerStopChildren: fn => { registered.stop = fn; return () => { delete registered.stop; }; } },
  });
  cleanups.push(() => lifecycle.dispose());
  return { bus, lifecycle, registered, aborted: () => aborted, registry: globals[SESSION_LIVENESS_KEY] as LivenessRegistry };
}
describe("S-1 pi-web liveness and public RPC Stop (trust boundary)", () => {
  // Recorded real catch: image-2 HOL completes 131 callbacks, then an empty home
  // fails retirement because an absent package cannot answer child status RPC.
  it("returns a certain empty Stop after parent abort when no child runtime is configured", async () => {
    const f = setup({ hasSubagentTool: () => false });
    expect(await f.lifecycle.stopAll("empty home retirement")).toEqual({ settled: [], uncertain: [] });
    expect(f.lifecycle.parkReady()).toEqual({ ready: true, reasons: [] });
    expect(f.aborted()).toBe(true);
    expect(f.bus.requests).toEqual([]);
  });
  it("still stops and accounts for a registered child runtime even without a configured subagent tool", async () => {
    const f = setup({ hasSubagentTool: () => false }); let stopped = false;
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => !stopped });
    f.bus.handle = (method, params) => {
      if (method === "stop") { stopped = true; return {}; }
      return params.id ? { details: { lifecycleStatus: { processTerminal: proof("a", "runner-1", stopped ? "observed" : "pending") } } } : snapshot([{ id: "a", state: "running" }]);
    };
    expect(await f.lifecycle.stopAll("registered runtime")).toEqual({ settled: ["a"], uncertain: [] });
    expect(stopped).toBe(true);
  });
  it("never treats configured, unobservable or previously observed child runtimes as absent", async () => {
    for (const kind of ["configured", "opaque", "unregistered", "tool-removed", "tool-query-failed"]) {
      let configured = kind === "configured" || kind === "tool-removed";
      if (kind === "opaque") globals[SESSION_LIVENESS_KEY] = { version: 1, register: () => () => {} };
      const f = setup({ hasSubagentTool: () => { if (kind === "tool-query-failed") throw new Error("unavailable"); return configured; } });
      if (kind === "unregistered") {
        const release = f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => false });
        expect(f.lifecycle.parkReady().ready).toBe(true); release();
      }
      if (kind === "tool-removed") { f.lifecycle.parkReady(); configured = false; }
      expect(f.lifecycle.parkReady().ready).toBe(false);
      expect((await f.lifecycle.stopAll(kind)).uncertain.length).toBeGreaterThan(0);
      f.lifecycle.dispose(); delete globals[SESSION_LIVENESS_KEY];
    }
  });
  it("does not turn other active providers or canceled parent abort into certain empty cleanup", async () => {
    const f = setup({ hasSubagentTool: () => false });
    f.registry.register({ name: "completion-wakes", sessionId: "parent", isActive: () => true });
    expect(f.lifecycle.parkReady().ready).toBe(false);
    expect((await f.lifecycle.stopAll("active provider")).uncertain).toContain("session-liveness");
    const controller = new AbortController(); controller.abort();
    const empty = setup({ hasSubagentTool: () => false, sessionId: "empty" });
    expect((await empty.lifecycle.stopAll("canceled", controller.signal)).uncertain.length).toBeGreaterThan(0);
  });
  it("registers exact host contributors, requires a session-qualified package registration and all providers idle", async () => {
    const f = setup();
    expect(f.lifecycle.parkReady().ready).toBe(false);
    f.registry.register({ name: "pi-subagents", sessionId: "other", isActive: () => false });
    expect(f.lifecycle.parkReady().ready).toBe(false);
    let active = false;
    const release = f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => active });
    expect(await f.registered.park!(new AbortController().signal)).toEqual({ ready: true, reasons: [] });
    const other = f.registry.register({ name: "completion-wakes", sessionId: "parent", isActive: () => true });
    expect(f.lifecycle.parkReady().ready).toBe(false); other();
    active = true; expect(f.lifecycle.parkReady().ready).toBe(false);
    active = false; expect(f.lifecycle.parkReady().ready).toBe(true);
    release(); expect(f.lifecycle.parkReady().ready).toBe(false);
    f.lifecycle.dispose(); expect(Object.keys(f.registered)).toEqual([]);
  });
  it("never overwrites an existing host registry and cannot infer idle from an opaque registry", () => {
    const existing = { version: 1, register: () => () => {} };
    globals[SESSION_LIVENESS_KEY] = existing;
    const f = setup(); expect(globals[SESSION_LIVENESS_KEY]).toBe(existing);
    expect(f.lifecycle.parkReady().ready).toBe(false);
  });
  it("fails closed on thrown/nonboolean providers and registry replacement", () => {
    const f = setup();
    const release = f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => { throw Error("unavailable"); } });
    expect(f.lifecycle.parkReady().ready).toBe(false); release();
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => undefined as unknown as boolean });
    expect(f.lifecycle.parkReady().ready).toBe(false);
    delete globals[SESSION_LIVENESS_KEY]; expect(f.lifecycle.parkReady().ready).toBe(false);
  });
  it("aborts parent before async stop, subscribes before request, accepts only exact observed runner proof", async () => {
    const f = setup(); let active = true; let stopSent = false;
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => active });
    f.bus.handle = (method, params) => {
      expect(f.aborted()).toBe(true);
      if (method === "status") return params.id ? { details: { lifecycleStatus: { processTerminal: proof("a", "runner-1", "pending") } } } : snapshot([{ id: "a", state: "running" }]);
      if (method === "stop") {
        stopSent = true; expect(params).toEqual({ id: "a" });
        f.bus.emit("subagent:process-terminal", proof("a", "old-runner"));
        queueMicrotask(() => { active = false; f.bus.emit("subagent:process-terminal", proof("a")); });
        return { state: "stopping" };
      }
    };
    expect(await f.lifecycle.stopAll("host stop")).toEqual({ settled: ["a"], uncertain: [] });
    expect(stopSent).toBe(true); expect(f.lifecycle.parkReady().ready).toBe(true);
    expect([...f.bus.listeners.entries()].filter(([name, set]) => name.includes("reply:") && set.size)).toEqual([]);
  });
  it("uses targeted observed status proof, never DTO complete/result/stop ack", async () => {
    for (const observed of [false, true]) {
      const f = setup({ timeoutMs: 35 }); let stopped = false;
      f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => false });
      f.bus.handle = (method, params) => {
        if (method === "stop") { stopped = true; return { state: "stopped", success: true }; }
        if (params.id) return { details: { lifecycleStatus: { processTerminal: proof("a", "runner-1", observed && stopped ? "observed" : "pending") } }, result: "done", endedAt: 1 };
        return snapshot([{ id: "a", state: "complete" }]);
      };
      expect(await f.lifecycle.stopAll("test")).toEqual(observed ? { settled: ["a"], uncertain: [] } : { settled: [], uncertain: ["a"] });
      if (!observed) expect(f.lifecycle.parkReady().ready).toBe(false);
    }
  });
  it("retains uncertainty for bounded/omitted snapshots and missing RPC, even if liveness reports idle", async () => {
    for (const kind of ["omitted-roots", "omitted-children", "bytes", "rpc-missing", "snapshot-missing"]) {
      const f = setup({ timeoutMs: 40 });
      f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => false });
      f.bus.handle = () => kind === "rpc-missing" ? undefined : kind === "snapshot-missing" ? {} : snapshot([], { runs: kind === "omitted-roots" ? 1 : 0, children: kind === "omitted-children" ? 1 : 0, byteLimitExceeded: kind === "bytes" });
      const result = await f.lifecycle.stopAll(kind); expect(result.uncertain.length).toBeGreaterThan(0);
      expect(f.lifecycle.parkReady().ready).toBe(false);
    }
  });
  it("requires liveness idle after observed settlement, never treats foreground display rows as control IDs", async () => {
    const f = setup({ timeoutMs: 35 });
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => true });
    f.bus.handle = (_method, params) => params.id ? { details: { lifecycleStatus: { processTerminal: proof("a") } } } : { ...snapshot([{ id: "a", state: "complete" }]), fleet: { entries: [{ key: "display-not-control" }], omitted: 0 } };
    const result = await f.lifecycle.stopAll("test"); expect(result.uncertain).toContain("session-liveness");
    expect(f.bus.requests.filter(r => r.method === "stop").map(r => r.params.id)).toEqual(["a"]);
  });
  it("does not settle a different run or runner instance in targeted status", async () => {
    const f = setup({ timeoutMs: 35 }); let targeted = 0;
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => false });
    f.bus.handle = (method, params) => method === "stop" ? {} : params.id ? { details: { lifecycleStatus: { processTerminal: ++targeted === 1 ? proof("a", "runner-1", "pending") : proof("a", "runner-2") } } } : snapshot([{ id: "a", state: "running" }]);
    expect(await f.lifecycle.stopAll("test")).toEqual({ settled: [], uncertain: ["a"] });
  });
  it("still sends stop to other async roots while one targeted status does not answer", async () => {
    const f = setup({ timeoutMs: 200 });
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => false });
    f.bus.handle = (method, params) => {
      if (method === "stop") { f.bus.emit("subagent:process-terminal", proof(String(params.id))); return {}; }
      if (params.id === "a") return undefined;
      if (params.id === "b") return { details: { lifecycleStatus: { processTerminal: proof("b", "runner-1", "pending") } } };
      return snapshot([{ id: "a", state: "running" }, { id: "b", state: "running" }]);
    };
    const result = await f.lifecycle.stopAll("test");
    expect(f.bus.requests.filter(request => request.method === "stop").map(request => request.params.id)).toEqual(["b", "a"]);
    expect(result).toEqual({ settled: ["b"], uncertain: ["a"] });
  });
  it("does not let an old observed event settle a run whose targeted runner instance changed", async () => {
    const f = setup({ timeoutMs: 35 }); let targeted = 0;
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => false });
    f.bus.handle = (method, params) => {
      if (method === "stop") { f.bus.emit("subagent:process-terminal", proof("a", "runner-1")); return {}; }
      if (params.id) return { details: { lifecycleStatus: { processTerminal: ++targeted === 1 ? proof("a", "runner-1", "pending") : proof("a", "runner-2", "pending") } } };
      return snapshot([{ id: "a", state: "running" }]);
    };
    expect(await f.lifecycle.stopAll("test")).toEqual({ settled: [], uncertain: ["a"] });
  });
  it("closes active listeners on cancellation/disposal and never reports canceled Stop as success", async () => {
    const f = setup({ timeoutMs: 1000 });
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => true });
    f.bus.handle = () => undefined;
    const pending = f.lifecycle.stopAll("shutdown"); f.lifecycle.dispose();
    expect((await pending).uncertain.length).toBeGreaterThan(0);
    expect([...f.bus.listeners.values()].every(set => set.size === 0)).toBe(true);
  });
});
