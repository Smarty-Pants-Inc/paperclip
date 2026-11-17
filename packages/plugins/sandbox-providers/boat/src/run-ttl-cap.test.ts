import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

// Keep: money/data safety, BOAT-TTL-ARCHIVE-UNDER-RUN. Orphaned leases and
// teardown races cannot be seeded safely on a real paid daily-work box.
const id = "bx_3456789a";
const scope = { driverKey: "boat", companyId: "cap-company", environmentId: "cap-env" };
const config = { apiKey: "fixture-cap-key", ttlSeconds: 300, runnerLifecycleMode: "per_turn" };
const start = Date.parse("2026-11-17T00:00:00Z");
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
function boat() {
  let state = "running", deadline = Date.now() + 300_000, sentinel: unknown;
  let patchWait: Promise<void> | undefined, readWait: Promise<void> | undefined;
  let patchState: string | undefined, conflictState: string | undefined;
  const patches: Array<{ at: number; ttlSeconds: number }> = [];
  const starts: string[] = [], stops: string[] = [];
  const snapshot = () => ({ id, state: state === "running" && Date.now() >= deadline ? "archived" : state,
    archiveAfter: new Date(deadline).toISOString(), team: { id: "team_cap" } });
  const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://boat.dev/api/v1", ""), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/sandboxes" && method === "POST") {
      starts.push(path); deadline = Date.now() + body.ttlSeconds * 1000; return reply({ sandbox: snapshot() });
    }
    if (path === `/sandboxes/${id}`) {
      if (method === "PATCH") {
        patches.push({ at: Date.now(), ttlSeconds: body.ttlSeconds });
        // Deliberately ignore AbortSignal: a late provider answer grants nothing.
        if (patchWait) await patchWait;
        if (conflictState) return reply({ code: "sandbox_not_ready", state: conflictState }, 409);
        deadline = Date.now() + body.ttlSeconds * 1000;
        return reply({ sandbox: { ...snapshot(), ...(patchState ? { state: patchState } : {}) } });
      }
      if (readWait) await readWait;
      return reply({ sandbox: snapshot() });
    }
    if (path.endsWith("/resume")) { starts.push(path); state = "running"; deadline = Date.now() + body.ttlSeconds * 1000; return reply({ sandbox: snapshot() }); }
    if (path.endsWith("/stop")) { stops.push(path); state = "archived"; return reply({ sandbox: snapshot() }); }
    if (path.endsWith("/files") && method === "PUT") { sentinel = JSON.parse(body.content); return reply({ success: true }); }
    if (path.includes("/files?")) return reply({ content: JSON.stringify(sentinel), encoding: "utf8" });
    if (path.endsWith("/commands")) return reply({ exitCode: 0, timedOut: false, stdout: body.command?.includes("cat ") ? JSON.stringify(sentinel) : "", stderr: "" });
    throw new Error(`Unexpected fake Boat: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", network);
  return { patches, starts, stops, network, get expired() { return Date.now() >= deadline; }, get deadline() { return deadline; },
    state: (value: string) => { state = value; }, patchState: (value: string) => { patchState = value; },
    conflict: (value: string) => { conflictState = value; },
    blockPatch: (wait?: Promise<void>) => { patchWait = wait; }, blockRead: (wait?: Promise<void>) => { readWait = wait; } };
}
let fake: ReturnType<typeof boat>;
const acquire = (extra: Record<string, unknown> = {}, runId = "run-cap-1") => plugin.definition.onEnvironmentAcquireLease!({
  ...scope, config: { ...config, ...extra }, runId, agentId: "agent-cap", executionWorkspaceId: "ws-cap", adapterType: "paperclip_runner",
});
const terminal = (name: "release" | "stop" | "destroy", extra = {}) => {
  const hooks = { release: plugin.definition.onEnvironmentReleaseLease!, stop: plugin.definition.onEnvironmentStopLease!, destroy: plugin.definition.onEnvironmentDestroyLease! };
  return hooks[name]({ ...scope, config: { ...config, ...extra }, providerLeaseId: id });
};
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(start);
  await plugin.definition.setup({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } as any);
  fake = boat();
});
afterEach(async () => {
  await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("F-05B bounded per-box RUN renewal", () => {
  it("R1: default 7800s cap stops an orphaned RUN and its last finite TTL expires", async () => {
    const timers = vi.getTimerCount();
    await acquire();
    await vi.advanceTimersByTimeAsync(7_799_999);
    expect(fake.expired).toBe(false);
    expect(fake.patches).toHaveLength(77);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.patches).toHaveLength(77);
    expect(fake.expired).toBe(true);
    expect(fake.deadline).toBe(start + 8_000_000);
    expect(fake.patches.every(p => p.ttlSeconds === 300)).toBe(true);
    expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it("R1: configured cap is absolute, including a cap between cadence ticks", async () => {
    const timers = vi.getTimerCount();
    await acquire({ runLeaseRenewCapSeconds: 250 });
    await vi.advanceTimersByTimeAsync(249_999);
    expect(fake.patches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(500_000);
    expect(fake.patches.map(p => p.at - start)).toEqual([100_000, 200_000]);
    expect(fake.expired).toBe(true);
  });
  it("R1: a pre-cap read delayed past the cap cannot authorize a PATCH", async () => {
    await acquire({ runLeaseRenewCapSeconds: 150 });
    const wait = deferred(); fake.blockRead(wait.promise);
    await vi.advanceTimersByTimeAsync(100_000);
    await vi.advanceTimersByTimeAsync(60_000);
    wait.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(fake.patches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500_000); expect(fake.expired).toBe(true);
  });
  it.each(["archiving", "archived", "stopping", "stopped"])("R2: read %s stops renewal before any PATCH", async state => {
    const timers = vi.getTimerCount(); await acquire(); fake.state(state);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fake.patches).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(timers);
    fake.state("running"); await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.patches).toHaveLength(0); expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it.each(["archiving", "archived", "stopped"])("R2: PATCH answer %s stops all later renewal", async state => {
    const timers = vi.getTimerCount(); await acquire(); fake.patchState(state);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fake.patches).toHaveLength(1); expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.patches).toHaveLength(1); expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it.each(["archiving", "archived", "stopped"])("R2: PATCH 409 state %s stops renewal, without recovery resume", async state => {
    const timers = vi.getTimerCount(); await acquire(); fake.conflict(state);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fake.patches).toHaveLength(1); expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fake.patches).toHaveLength(1); expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it("R2: inspect archiving cancels the timer immediately", async () => {
    const timers = vi.getTimerCount(); await acquire(); fake.state("archiving");
    await plugin.definition.onEnvironmentInspectLease!({ ...scope, config, providerLeaseId: id });
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(600_000); expect(fake.patches).toHaveLength(0);
  });
  it.each(["release", "stop", "destroy"] as const)("R3: %s during in-flight PATCH stays quiet after its late answer", async name => {
    const timers = vi.getTimerCount(); await acquire();
    const wait = deferred(); fake.blockPatch(wait.promise);
    await vi.advanceTimersByTimeAsync(100_000); expect(fake.patches).toHaveLength(1);
    const ending = terminal(name);
    wait.resolve(); await ending;
    expect(fake.stops).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(fake.patches).toHaveLength(1); expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it("R3: stop during a read fences its late answer before PATCH", async () => {
    await acquire(); const wait = deferred(); fake.blockRead(wait.promise);
    await vi.advanceTimersByTimeAsync(100_000);
    const ending = terminal("stop"); fake.blockRead(); wait.resolve(); await ending;
    await vi.advanceTimersByTimeAsync(900_000);
    expect(fake.patches).toHaveLength(0); expect(fake.stops).toHaveLength(1);
  });
  it("R4: two acquisitions of one account/box have one refresher, not one per lease", async () => {
    const timers = vi.getTimerCount(); await acquire();
    const heldTimers = vi.getTimerCount(); expect(heldTimers).toBeGreaterThan(timers);
    await acquire({}, "run-cap-2");
    expect(vi.getTimerCount()).toBe(heldTimers);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(fake.patches).toHaveLength(9);
    await terminal("release"); expect(vi.getTimerCount()).toBe(timers);
  });
  it("R1/R4: duplicate same-RUN warm resume cannot move its original cap", async () => {
    const c = { ...config, runLeaseRenewCapSeconds: 250 };
    const lease = await acquire(c);
    await vi.advanceTimersByTimeAsync(200_000);
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config: c, providerLeaseId: id, runId: "run-cap-1", leaseMetadata: lease.metadata });
    const count = fake.patches.length;
    await vi.advanceTimersByTimeAsync(100_000);
    expect(fake.patches).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(500_000); expect(fake.expired).toBe(true);
  });
  it("exposes and validates a finite positive cap, with default 7800", async () => {
    expect(manifest.environmentDrivers![0].configSchema?.properties?.runLeaseRenewCapSeconds).toMatchObject({ type: "integer", default: 7800 });
    for (const value of [null, 0, -1, 1.5, Infinity, "7800"]) {
      const result = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, runLeaseRenewCapSeconds: value } });
      expect(result.ok, `invalid cap ${value}`).toBe(false);
    }
    const valid = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, runLeaseRenewCapSeconds: 250 } });
    expect(valid.ok).toBe(true);
  });
});
