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
function setup(options: { timeoutMs?: number; sessionId?: string; abortParent?: () => void | Promise<void> } = {}) {
  const bus = new Bus();
  const registered: Record<string, Function> = {};
  let aborted = false;
  const lifecycle = createSubagentLifecycle({ sessionId: options.sessionId ?? "parent", events: bus, abortParent: async () => { aborted = true; await options.abortParent?.(); }, timeoutMs: options.timeoutMs ?? 100, rpcTimeoutMs: 30,
    seam: { registerParkReadyContributor: fn => { registered.park = fn; return () => { delete registered.park; }; }, registerStopChildren: fn => { registered.stop = fn; return () => { delete registered.stop; }; } },
  });
  cleanups.push(() => lifecycle.dispose());
  return { bus, lifecycle, registered, aborted: () => aborted, registry: globals[SESSION_LIVENESS_KEY] as LivenessRegistry };
}
describe("S-1 pi-web liveness and public RPC Stop (trust boundary)", () => {
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
  it("closes active listeners on cancellation/disposal and never reports canceled Stop as success", async () => {
    const f = setup({ timeoutMs: 1000 });
    f.registry.register({ name: "pi-subagents", sessionId: "parent", isActive: () => true });
    f.bus.handle = () => undefined;
    const pending = f.lifecycle.stopAll("shutdown"); f.lifecycle.dispose();
    expect((await pending).uncertain.length).toBeGreaterThan(0);
    expect([...f.bus.listeners.values()].every(set => set.size === 0)).toBe(true);
  });
});
