import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// Keep: real incident BOAT-TTL-ARCHIVE-UNDER-RUN (four runs lost at ~32 min).
// Exercise the public lease hooks against Boat's documented from-now expiry,
// including failure/teardown races that are not safe to seed in live daily work.
const id = "bx_23456789", apiKey = "private_run_ttl_key";
const scope = { driverKey: "boat", companyId: "run-ttl-company", environmentId: "run-ttl-env" };
const config = { apiKey, ttlSeconds: 300, reuseLease: true, runnerLifecycleMode: "per_turn" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function boat() {
  let deadline = Date.now() + config.ttlSeconds * 1000, expired = false, stopped = false, gone = false;
  let sentinel: unknown, failures = 0, failureStatus = 500, stateOverride: string | undefined;
  let pending: Promise<void> | undefined;
  const patches: Array<{ at: number; body: unknown; org: string | null }> = [];
  const starts: string[] = [];
  const snapshot = () => ({ id, state: stateOverride ?? (stopped || expired ? "archived" : "running"), archiveAfter: new Date(deadline).toISOString(), team: { id: "team_run_ttl" } });
  const expiry = setInterval(() => { if (!stopped && Date.now() >= deadline) expired = true; }, 1000);
  const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://boat.dev/api/v1", ""), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/sandboxes" && method === "POST") { starts.push(path); deadline = Date.now() + body.ttlSeconds * 1000; return reply({ sandbox: snapshot() }); }
    if (path === `/sandboxes/${id}`) {
      if (method === "PATCH") {
        patches.push({ at: Date.now(), body, org: new Headers(init?.headers).get("X-Boat-Org") });
        if (pending) await pending;
        if (gone) return reply({ code: "not_found" }, 404);
        if (failures-- > 0) return new Response(JSON.stringify({ message: apiKey, code: apiKey, cause: { message: apiKey } }), { status: failureStatus, headers: { RateLimit: apiKey } });
        deadline = Date.now() + body.ttlSeconds * 1000;
      }
      return gone ? reply({ code: "not_found" }, 404) : reply({ sandbox: snapshot() });
    }
    if (path.endsWith("/resume")) { starts.push(path); stopped = false; deadline = Date.now() + body.ttlSeconds * 1000; return reply({ sandbox: snapshot() }); }
    if (path.endsWith("/stop")) { stopped = true; return reply({ sandbox: snapshot() }); }
    if (path.endsWith("/host")) return reply({ url: "https://run-ttl-43127.on.boat.dev/?_token=fixture", port: 43127, isProtected: true, access: "private" });
    if (path.endsWith("/files") && method === "PUT") { sentinel = JSON.parse(body.content); return reply({ success: true }); }
    if (path.includes("/files?")) return reply({ content: JSON.stringify(sentinel), encoding: "utf8" });
    if (path.endsWith("/commands")) return reply({ exitCode: 0, timedOut: false, stdout: body.command?.includes("cat ") ? JSON.stringify(sentinel) : "", stderr: "" });
    throw new Error(`Unexpected fake Boat request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", network);
  return { network, patches, starts, get expired() { return expired; }, get deadline() { return deadline; },
    fail: (count = 1, status = 500) => { failures = count; failureStatus = status; }, remove: () => { gone = true; }, state: (value: string) => { stateOverride = value; },
    block: (work?: Promise<void>) => { pending = work; }, cleanup: () => clearInterval(expiry) };
}
let fake: ReturnType<typeof boat>;
async function acquire(c = config) {
  return plugin.definition.onEnvironmentAcquireLease!({ ...scope, config: c, runId: "run-ttl-1", agentId: "agent-ttl", executionWorkspaceId: "ws-ttl", adapterType: "paperclip_runner" });
}
const release = () => plugin.definition.onEnvironmentReleaseLease!({ ...scope, config, providerLeaseId: id });
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T00:00:00Z"));
  for (const log of Object.values(logger)) log.mockClear();
  await plugin.definition.setup({ logger } as any); fake = boat();
});
afterEach(async () => {
  fake.cleanup(); await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("Boat held RUN lease TTL", () => {
  it("R1: a RUN holds for 3×TTL without expiry, PATCHing effective TTL before every deadline; release is quiet", async () => {
    await acquire();
    await vi.advanceTimersByTimeAsync(900_000);
    expect(fake.expired).toBe(false);
    expect(fake.patches.map(p => p.at)).toEqual(Array.from({ length: 9 }, (_, i) => Date.parse("2026-11-17T00:00:00Z") + (i + 1) * 100_000));
    expect(fake.patches.every(p => JSON.stringify(p.body) === JSON.stringify({ ttlSeconds: 300 }))).toBe(true);
    expect(fake.patches.every(p => p.org === "team_run_ttl")).toBe(true);
    expect(fake.starts).toEqual(["/sandboxes"]);
    expect(logger.info).toHaveBeenCalledWith("Boat run lease TTL refresh", { providerLeaseId: id, status: "ok", category: null });
    await release(); const count = fake.patches.length;
    await vi.advanceTimersByTimeAsync(900_000); expect(fake.patches).toHaveLength(count);
  });
  it.each(["release", "stop", "destroy", "shutdown", "gone"])("R2: %s ends refresh with zero further PATCHes", async end => {
    const idleTimers = vi.getTimerCount();
    await acquire(); await vi.advanceTimersByTimeAsync(100_000); expect(fake.patches).toHaveLength(1);
    if (end === "release") await release();
    if (end === "stop") await plugin.definition.onEnvironmentStopLease!({ ...scope, config, providerLeaseId: id });
    if (end === "destroy") await plugin.definition.onEnvironmentDestroyLease!({ ...scope, config, providerLeaseId: id });
    if (end === "shutdown") await plugin.definition.onShutdown?.();
    if (end === "gone") { fake.remove(); await vi.advanceTimersByTimeAsync(100_000); }
    const count = fake.patches.length; await vi.advanceTimersByTimeAsync(900_000); expect(fake.patches).toHaveLength(count);
    // Admission fencing is defense in depth, not an excuse to leak a RUN timer.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(idleTimers);
    expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it.each([500, 429])("R3: failed PATCH %s logs only closed fields and retries on the next tick, not immediately", async status => {
    await acquire(); fake.fail(1, status); await vi.advanceTimersByTimeAsync(100_000);
    expect(fake.patches).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith("Boat run lease TTL refresh", { providerLeaseId: id, status: "failed", category: "http_error" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
    await vi.advanceTimersByTimeAsync(99_999); expect(fake.patches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(fake.patches).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(700_000); expect(fake.expired).toBe(false);
  });
  it("R4: legacy idle warm handoff retains its one PATCH, without a RUN timer", async () => {
    const lease = await acquire(); await release(); fake.patches.length = 0;
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    // The release stopped the box: legacy resume starts it; the next warm handoff PATCHes once.
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    expect(fake.patches).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith("Boat warm lease TTL refresh", { providerLeaseId: id, status: "ok", category: null });
    await vi.advanceTimersByTimeAsync(900_000); expect(fake.patches).toHaveLength(1);
  });
  it("resumed RUN restarts the cadence and duplicate resume/ingress never multiplies it", async () => {
    const lease = await acquire(); await release(); fake.patches.length = 0;
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, runId: "run-ttl-2", leaseMetadata: lease.metadata });
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, runId: "run-ttl-2", leaseMetadata: lease.metadata });
    await plugin.definition.onEnvironmentRunnerIngressEndpoint!({ ...scope, config, lease, port: 43127, path: "/api/runner/v1/connect/run_ttl" });
    fake.patches.length = 0;
    await vi.advanceTimersByTimeAsync(900_000); expect(fake.expired).toBe(false); expect(fake.patches).toHaveLength(9);
  });
  it("uses effective warm TTL (not the raw config TTL) at ttl/3", async () => {
    await acquire({ ...config, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 600_000 } as any);
    await vi.advanceTimersByTimeAsync(299_999); expect(fake.patches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(fake.patches[0].body).toEqual({ ttlSeconds: 900 });
  });
  it.each(["archived", "stopped", "cancelled"])("R2: terminal box state %s ends refresh without a start", async state => {
    await acquire(); fake.state(state); await vi.advanceTimersByTimeAsync(100_000);
    expect(fake.patches).toHaveLength(1); await vi.advanceTimersByTimeAsync(900_000);
    expect(fake.patches).toHaveLength(1); expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it("R2: inspect's terminal observation cancels renewal without waiting for its next tick", async () => {
    await acquire(); fake.state("archived");
    await plugin.definition.onEnvironmentInspectLease!({ ...scope, config, providerLeaseId: id });
    await vi.advanceTimersByTimeAsync(900_000); expect(fake.patches).toHaveLength(0);
  });
  it("uses a 60-second minimum cadence for a short RUN TTL", async () => {
    await acquire({ ...config, ttlSeconds: 120 });
    await vi.advanceTimersByTimeAsync(59_999); expect(fake.patches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(fake.patches[0].body).toEqual({ ttlSeconds: 120 });
    await vi.advanceTimersByTimeAsync(300_000); expect(fake.expired).toBe(false);
  });
  it("never overlaps slow PATCHes, and release drains in-flight work before becoming quiet", async () => {
    await acquire(); let unblock!: () => void;
    fake.block(new Promise<void>(resolve => { unblock = resolve; }));
    await vi.advanceTimersByTimeAsync(100_000); expect(fake.patches).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200_000); expect(fake.patches).toHaveLength(1);
    const ending = release(); unblock(); await ending;
    const count = fake.patches.length; await vi.advanceTimersByTimeAsync(900_000); expect(fake.patches).toHaveLength(count);
  });
});
