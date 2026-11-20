import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./worker.js";
import manifest from "./manifest.js";

// The real worker's hooks, request retries and lease preparation run unchanged;
// only Boat HTTP and elapsed time are controlled at this boundary.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const timer = globalThis.setTimeout(() => { options?.signal?.removeEventListener("abort", abort); resolve(value); }, ms);
    const abort = () => { globalThis.clearTimeout(timer); reject(options!.signal!.reason); };
    options?.signal?.addEventListener("abort", abort, { once: true });
  }),
}));
const START = Date.parse("2026-11-20T00:00:00Z");
const id = "bx_hydwait";
const config = { apiKey: "fixture-only", ttlSeconds: 1800 };
const scope = { driverKey: "boat", companyId: "hydration-company", environmentId: "hydration-env", config };
const acquire = { ...scope, runId: "hydration-run", creationOperationId: "hydration-create" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
function fixture(flipAfter: number, options: { resume?: boolean; omitHydrated?: boolean; getStatus?: number; createDelayMs?: number } = {}) {
  const calls: Array<{ method: string; path: string; at: number }> = [];
  const observation = () => ({ id, state: "running", team: { id: "hydration-team" },
    archiveAfter: new Date(START + 1800_000).toISOString(),
    ...(options.omitHydrated ? {} : { hydrated: Date.now() - START >= flipAfter }) });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push({ method, path, at: Date.now() - START });
    if (path === "/sandboxes" && method === "POST") {
      if (options.createDelayMs) await new Promise(resolve => setTimeout(resolve, options.createDelayMs));
      return response({ sandbox: observation() }, 202);
    }
    if (path === `/sandboxes/${id}/resume`) return response({ sandbox: observation() }, 202);
    if (path === `/sandboxes/${id}` && method === "GET") {
      if (options.getStatus && calls.filter(c => c.path === path && c.method === "GET").length > 1) return response({}, options.getStatus);
      return response({ sandbox: observation() });
    }
    if (path.endsWith("/commands") && method === "POST") return response({ exitCode: 0, stdout: "", stderr: "" });
    if (path.endsWith("/files") && method === "PUT") return response({ success: true });
    if (path.endsWith("/stop")) return response({ operation: { id: "stop-hydwait", status: "completed" } }, 202);
    throw new Error(`Unexpected fixture request ${method} ${path}`);
  }));
  return { calls, gets: () => calls.filter(c => c.method === "GET" && c.path === `/sandboxes/${id}`) };
}
async function complete<T>(promise: Promise<T>, ms: number): Promise<T> {
  // Attach immediately: a true failure must not become an unhandled rejection.
  const result = promise.then(value => ({ value }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(ms);
  const settled = await result;
  if ("error" in settled) throw settled.error;
  return settled.value;
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(START);
  for (const fn of Object.values(logger)) fn.mockClear();
  await plugin.definition.setup({ logger } as any);
});
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Boat hydration before workspace handoff", () => {
  it("r1 cold create waits for the +40s hydration flip, not merely running", async () => {
    const f = fixture(40_000);
    let returnedAt: number | undefined;
    const pending = plugin.definition.onEnvironmentAcquireLease!(acquire).then(lease => { returnedAt = Date.now() - START; return lease; });
    await vi.advanceTimersByTimeAsync(39_999);
    expect(returnedAt, "must not hand off the stale workspace").toBeUndefined();
    const lease = await complete(pending, 501);
    expect(lease.providerLeaseId).toBe(id);
    expect(returnedAt).toBeGreaterThanOrEqual(40_000);
    expect(returnedAt).toBeLessThanOrEqual(40_500);
    expect(f.gets().length).toBeGreaterThan(1);
    expect(logger.info).toHaveBeenCalledWith("Boat hydration wait", expect.objectContaining({ providerLeaseId: id, waitedMs: 40_000, outcome: "hydrated" }));
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("workspace sentinel preparation cannot run against the pre-hydration tree", async () => {
    const f = fixture(40_000);
    const lease = await complete(plugin.definition.onEnvironmentAcquireLease!({ ...acquire,
      agentId: "hydration-agent", executionWorkspaceId: "hydration-workspace", adapterType: "paperclip_runner" }), 40_500);
    expect(lease.providerLeaseId).toBe(id);
    const workspaceIo = f.calls.filter(call => call.path.endsWith("/commands") || call.path.endsWith("/files"));
    expect(workspaceIo.length).toBeGreaterThan(0);
    expect(workspaceIo.every(call => call.at >= 40_000)).toBe(true);
    expect(lease.metadata?.workspaceSentinel).toMatchObject({ result: "written" });
  });
  it("r2 already hydrated adds no GET and no delay", async () => {
    const f = fixture(0);
    expect((await plugin.definition.onEnvironmentAcquireLease!(acquire)).providerLeaseId).toBe(id);
    expect(Date.now() - START).toBe(0);
    expect(f.gets()).toHaveLength(1); // the pre-existing readiness GET
    expect(logger.info.mock.calls.filter(([message]) => message === "Boat hydration wait")).toHaveLength(0);
  });
  it("r3 never hydrates: valid lease at exactly 150s, one warning and one wait receipt", async () => {
    const f = fixture(Infinity);
    let returnedAt: number | undefined;
    const pending = plugin.definition.onEnvironmentAcquireLease!(acquire).then(lease => { returnedAt = Date.now() - START; return lease; });
    await vi.advanceTimersByTimeAsync(149_999);
    expect(returnedAt).toBeUndefined();
    const lease = await complete(pending, 1);
    expect(lease.providerLeaseId).toBe(id);
    expect(returnedAt).toBe(150_000);
    expect(f.gets().length).toBeGreaterThan(1);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Boat box not hydrated at handoff after 150s", expect.objectContaining({ providerLeaseId: id }));
    expect(logger.info).toHaveBeenCalledWith("Boat hydration wait", expect.objectContaining({ waitedMs: 150_000, outcome: "bound" }));
  });
  it("r4 resume waits for the +20s hydration flip", async () => {
    const f = fixture(20_000, { resume: true });
    let returnedAt: number | undefined;
    const pending = plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id }).then(lease => { returnedAt = Date.now() - START; return lease; });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(returnedAt, "resume must not hand off the stale workspace").toBeUndefined();
    expect((await complete(pending, 501)).providerLeaseId).toBe(id);
    expect(returnedAt).toBeGreaterThanOrEqual(20_000);
    expect(f.gets().length).toBeGreaterThan(1);
    expect(logger.info).toHaveBeenCalledWith("Boat hydration wait", expect.objectContaining({ waitedMs: 20_000, outcome: "hydrated" }));
  });
  it.each(["acquire", "resume"])("r5 %s with hydrationWaitSeconds=0 preserves the old calls and lease", async kind => {
    const f = fixture(Infinity);
    const disabled = { ...config, hydrationWaitSeconds: 0 };
    const lease = kind === "acquire"
      ? await plugin.definition.onEnvironmentAcquireLease!({ ...acquire, config: disabled })
      : await plugin.definition.onEnvironmentResumeLease!({ ...scope, config: disabled, providerLeaseId: id });
    expect(lease.providerLeaseId).toBe(id);
    expect(Date.now() - START).toBe(0);
    expect(f.calls.map(c => `${c.method} ${c.path}`)).toEqual(kind === "acquire"
      ? ["POST /sandboxes", `GET /sandboxes/${id}`]
      : [`POST /sandboxes/${id}/resume`, `GET /sandboxes/${id}`]);
    expect(logger.info.mock.calls.filter(([message]) => message === "Boat hydration wait")).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });
  it("missing hydrated is not hydration proof; configured shorter bound still returns", async () => {
    fixture(Infinity, { omitHydrated: true });
    const lease = await complete(plugin.definition.onEnvironmentAcquireLease!({ ...acquire, config: { ...config, hydrationWaitSeconds: 2 } }), 2_000);
    expect(lease.providerLeaseId).toBe(id);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Boat box not hydrated at handoff after 2s", expect.any(Object));
  });
  it("hydration GET failures remain fail-open at the same bound, not a new acquire failure", async () => {
    fixture(Infinity, { getStatus: 503 });
    const lease = await complete(plugin.definition.onEnvironmentAcquireLease!({ ...acquire, config: { ...config, hydrationWaitSeconds: 2 } }), 2_000);
    expect(lease.providerLeaseId).toBe(id);
    expect(logger.info).toHaveBeenCalledWith("Boat hydration wait", expect.objectContaining({ waitedMs: 2_000, outcome: "bound" }));
    expect(logger.warn.mock.calls.filter(([message]) => message === "Boat box not hydrated at handoff after 2s")).toHaveLength(1);
  });
  it("slow create plus hydration bound never spends the old work budget on the optional wait", async () => {
    fixture(Infinity, { createDelayMs: 35_000 });
    let returnedAt: number | undefined;
    const pending = plugin.definition.onEnvironmentAcquireLease!(acquire).then(lease => { returnedAt = Date.now() - START; return lease; });
    const lease = await complete(pending, 185_000);
    expect(lease.providerLeaseId).toBe(id);
    expect(returnedAt).toBe(185_000);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Boat box not hydrated at handoff after 150s", expect.any(Object));
  });
  it.each([-1, 1.5, "0", null, Infinity, NaN])("rejects invalid hydrationWaitSeconds %s", async value => {
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, hydrationWaitSeconds: value } })).toMatchObject({ ok: false });
  });
  it("schema exposes the default and off switch", () => {
    const properties = manifest.environmentDrivers![0].configSchema!.properties as Record<string, unknown>;
    expect(properties.hydrationWaitSeconds).toMatchObject({ type: "integer", minimum: 0, default: 150 });
  });
});
