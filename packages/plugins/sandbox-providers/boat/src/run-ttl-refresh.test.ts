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
  let sentinel: unknown, failures = 0;
  let pending: Promise<void> | undefined;
  const patches: Array<{ at: number; body: unknown; org: string | null }> = [];
  const starts: string[] = [];
  const snapshot = () => ({ id, state: stopped || expired ? "archived" : "running", archiveAfter: new Date(deadline).toISOString(), team: { id: "team_run_ttl" } });
  const expiry = setInterval(() => { if (!stopped && Date.now() >= deadline) expired = true; }, 1000);
  const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace("https://boat.dev/api/v1", ""), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/sandboxes" && method === "POST") { starts.push(path); return reply({ sandbox: snapshot() }); }
    if (path === `/sandboxes/${id}`) {
      if (method === "PATCH") {
        patches.push({ at: Date.now(), body, org: new Headers(init?.headers).get("X-Boat-Org") });
        if (pending) await pending;
        if (gone) return reply({ code: "not_found" }, 404);
        if (failures-- > 0) return reply({ message: apiKey, cause: { message: apiKey } }, 500);
        deadline = Date.now() + body.ttlSeconds * 1000;
      }
      return gone ? reply({ code: "not_found" }, 404) : reply({ sandbox: snapshot() });
    }
    if (path.endsWith("/resume")) { starts.push(path); stopped = false; deadline = Date.now() + body.ttlSeconds * 1000; return reply({ sandbox: snapshot() }); }
    if (path.endsWith("/stop")) { stopped = true; return reply({ sandbox: snapshot() }); }
    if (path.endsWith("/files") && method === "PUT") { sentinel = JSON.parse(body.content); return reply({ success: true }); }
    if (path.includes("/files?")) return reply({ content: JSON.stringify(sentinel), encoding: "utf8" });
    if (path.endsWith("/commands")) return reply({ exitCode: 0, timedOut: false, stdout: body.command?.includes("cat ") ? JSON.stringify(sentinel) : "", stderr: "" });
    throw new Error(`Unexpected fake Boat request: ${method} ${path}`);
  });
  vi.stubGlobal("fetch", network);
  return { network, patches, starts, get expired() { return expired; }, get deadline() { return deadline; },
    fail: (count = 1) => { failures = count; }, remove: () => { gone = true; },
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
    await acquire(); await vi.advanceTimersByTimeAsync(100_000); expect(fake.patches).toHaveLength(1);
    if (end === "release") await release();
    if (end === "stop") await plugin.definition.onEnvironmentStopLease!({ ...scope, config, providerLeaseId: id });
    if (end === "destroy") await plugin.definition.onEnvironmentDestroyLease!({ ...scope, config, providerLeaseId: id });
    if (end === "shutdown") await plugin.definition.onShutdown?.();
    if (end === "gone") { fake.remove(); await vi.advanceTimersByTimeAsync(100_000); }
    const count = fake.patches.length; await vi.advanceTimersByTimeAsync(900_000); expect(fake.patches).toHaveLength(count);
    expect(fake.starts).toEqual(["/sandboxes"]);
  });
  it("R3: failed PATCH logs only closed fields and retries on the next tick, not immediately", async () => {
    await acquire(); fake.fail(); await vi.advanceTimersByTimeAsync(100_000);
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
    fake.patches.length = 0;
    await vi.advanceTimersByTimeAsync(900_000); expect(fake.expired).toBe(false); expect(fake.patches).toHaveLength(9);
  });
  it("uses effective warm TTL (not the raw config TTL) at ttl/3", async () => {
    await acquire({ ...config, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 600_000 } as any);
    await vi.advanceTimersByTimeAsync(299_999); expect(fake.patches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); expect(fake.patches[0].body).toEqual({ ttlSeconds: 900 });
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
