import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// Money (adopt-boat-late-box2): #21091 reports an empty creation lookup as
// destroyed so core's bounded absence resolver can settle the operation. For a
// create THIS worker sent and that timed out, Boat may still materialize the
// box; until core's settle floor (30 min from the create) has passed, an empty
// lookup stays inconclusive, so core keeps inspecting every retry interval and
// the late box is found and stopped, never left running unowned. After that
// window the lookup reports destroyed, as #21091 requires.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const base = { driverKey: "boat", companyId: "lco", environmentId: "lenv", config: cfg };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
beforeEach(async () => {
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Boat accepts the create but never replies; the box is visible from `visibleAt` (never if Infinity). */
function lateWorld(visibleAt: number) {
  const boxes = new Map<string, { labels: Record<string, string>; stopped: boolean }>();
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    if (method === "POST" && path === "/sandboxes") {
      boxes.set("bx_late", { labels: JSON.parse(init.body).labels, stopped: false });
      const signal: AbortSignal = init.signal;
      return await new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    if (method === "GET" && path === "/sandboxes") {
      const attempt = u.searchParams.get("label")!.split("=")[1];
      return res({ sandboxes: [...boxes].filter(([, b]) => b.labels["paperclip-acquire"] === attempt && Date.now() >= visibleAt)
        .map(([id, b]) => ({ id, labels: b.labels, state: b.stopped ? "archived" : "ready" })), pageInfo: { nextCursor: null } });
    }
    const id = decodeURIComponent(path.split("/")[2] ?? ""), b = boxes.get(id);
    if (b && method === "POST" && path.endsWith("/stop")) { b.stopped = true; return res({ stop: { id: `stop_${id}`, status: "pending" } }, 202); }
    if (b && method === "GET") return res({ sandbox: { id, labels: b.labels, state: b.stopped ? "archived" : "ready",
      ...(b.stopped ? { stop: { id: `stop_${id}`, status: "completed" } } : {}) } });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return boxes;
}

it("LATEBOX-1: an empty lookup for this worker's timed-out create stays inconclusive inside the settle window; a box appearing at 20 min is found and stopped", async () => {
  const boxes = lateWorld(20 * 60_000);
  const op = { ...base, runId: "run-l1", creationOperationId: "op-l1" };
  const failed = plugin.definition.onEnvironmentAcquireLease!(op).catch(e => e);
  await vi.advanceTimersByTimeAsync(95_000);
  expect(await failed).toMatchObject({ code: "ETIMEDOUT", providerState: "absent" });
  const inspect = () => plugin.definition.onEnvironmentInspectLease!({ ...op, providerLeaseId: "op-l1", creationOperation: { id: "op-l1", runId: "run-l1" } } as any);
  // Core retries a thrown inspection every 5 min (ENVIRONMENT_CLEANUP_RETRY_MS).
  for (let minute = 5; minute < 20; minute += 5) {
    vi.setSystemTime(minute * 60_000);
    await expect(inspect()).rejects.toThrow("not visible yet");
  }
  vi.setSystemTime(20 * 60_000);
  const observed = await inspect();
  expect(observed).toMatchObject({ providerLeaseId: "bx_late", creationCleanup: { attemptId: "op-l1", runId: "run-l1" } });
  await expect(plugin.definition.onEnvironmentDestroyLease!({ ...op, providerLeaseId: observed.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: observed.creationCleanup } } as any)).resolves.toMatchObject({ state: "stopped" });
  expect(boxes.get("bx_late")!.stopped).toBe(true);
});

it("LATEBOX-2: once the settle window of this worker's timed-out create has passed, an empty lookup reports destroyed (#21091)", async () => {
  lateWorld(Number.POSITIVE_INFINITY);
  const op = { ...base, runId: "run-l2", creationOperationId: "op-l2" };
  const failed = plugin.definition.onEnvironmentAcquireLease!(op).catch(e => e);
  await vi.advanceTimersByTimeAsync(95_000);
  expect(await failed).toMatchObject({ code: "ETIMEDOUT" });
  const inspect = () => plugin.definition.onEnvironmentInspectLease!({ ...op, providerLeaseId: "op-l2", creationOperation: { id: "op-l2", runId: "run-l2" } } as any);
  vi.setSystemTime(30 * 60_000 - 1);
  await expect(inspect()).rejects.toThrow("not visible yet");
  vi.setSystemTime(30 * 60_000);
  await expect(inspect()).resolves.toMatchObject({ providerLeaseId: "op-l2", state: "destroyed" });
});
