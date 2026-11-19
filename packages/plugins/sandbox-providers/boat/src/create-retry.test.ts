import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// rf-4 U3 C2 (money): a host retry after a timed-out create. The host's retry
// is a new run with a new creation operation (server heartbeat/retries.ts:1088,
// sandbox-creation-operations.ts:68), so the plugin gets a new
// creationOperationId and so a new Idempotency-Key. This row proves the part
// the plugin owns today: the prior operation's box that appears later is found
// by core's durable creation-intent inspection and STOPPED, never left running,
// and the retry's own box is untouched. "One create, one box" across the retry
// chain needs the host to carry the creation operation (see the result).
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const base = { driverKey: "boat", companyId: "rco", environmentId: "renv", config: cfg };
const first = { ...base, runId: "run-a", creationOperationId: "op-a" };
const retry = { ...base, runId: "run-b", creationOperationId: "op-b" };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
beforeEach(async () => {
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Boat: the first create (op-a) is accepted but its reply never arrives and
 * its box only becomes visible at `lateAt`; later creates answer at once. */
export function retryWorld(lateAt: number) {
  const creates: { at: number; key: string | null; attempt: string }[] = [];
  const boxes = new Map<string, { labels: Record<string, string>; visibleAt: number; stopped: boolean }>();
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    if (method === "POST" && path === "/sandboxes") {
      const labels = JSON.parse(init.body).labels, key = new Headers(init.headers).get("Idempotency-Key");
      creates.push({ at: Date.now(), key, attempt: labels["paperclip-acquire"] });
      const existing = [...boxes].find(([, b]) => b.labels["paperclip-acquire"] === labels["paperclip-acquire"]);
      if (existing) return res({ sandbox: { id: existing[0], state: "provisioning" } }, 202); // Boat's idempotent replay
      const id = `bx_retry${boxes.size}`;
      const late = boxes.size === 0;
      boxes.set(id, { labels, visibleAt: late ? lateAt : 0, stopped: false });
      if (!late) return res({ sandbox: { id, state: "provisioning" } }, 202);
      const signal: AbortSignal = init.signal;
      return await new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    if (method === "GET" && path === "/sandboxes") {
      const attempt = u.searchParams.get("label")!.split("=")[1];
      return res({ sandboxes: [...boxes].filter(([, b]) => b.labels["paperclip-acquire"] === attempt && Date.now() >= b.visibleAt)
        .map(([id, b]) => ({ id, labels: b.labels, state: b.stopped ? "archived" : "ready" })), pageInfo: { nextCursor: null } });
    }
    const id = decodeURIComponent(path.split("/")[2] ?? ""), b = boxes.get(id);
    if (b && method === "POST" && path.endsWith("/stop")) { b.stopped = true; return res({ stop: { id: `stop_${id}`, status: "pending" } }, 202); }
    if (b && method === "GET") return res({ sandbox: { id, labels: b.labels, state: b.stopped ? "archived" : "ready",
      ...(b.stopped ? { stop: { id: `stop_${id}`, status: "completed" } } : {}) } });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return { creates, boxes };
}

it("C2: after a host retry, the prior timed-out create's box that appears later is stopped by core's creation-intent inspection; the retry's box is untouched", async () => {
  const w = retryWorld(150_000);
  const failed = plugin.definition.onEnvironmentAcquireLease!(first).catch(e => e);
  await vi.advanceTimersByTimeAsync(95_000);
  expect(await failed).toMatchObject({ code: "ETIMEDOUT", providerState: "absent" });
  const lease = plugin.definition.onEnvironmentAcquireLease!(retry);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(lease).resolves.toMatchObject({ providerLeaseId: "bx_retry1" });
  // Core's durable intent for op-a: absence keeps it retryable, never "destroyed".
  const inspect = () => plugin.definition.onEnvironmentInspectLease!({ ...first, providerLeaseId: "op-a", creationOperation: { id: "op-a", runId: "run-a" } } as any);
  await expect(inspect()).rejects.toThrow("not visible yet");
  await vi.advanceTimersByTimeAsync(60_000);
  const observed = await inspect();
  expect(observed).toMatchObject({ providerLeaseId: "bx_retry0", creationCleanup: { attemptId: "op-a", runId: "run-a" } });
  await expect(plugin.definition.onEnvironmentDestroyLease!({ ...first, providerLeaseId: observed.providerLeaseId,
    leaseMetadata: { failedCreateCleanup: observed.creationCleanup } } as any)).resolves.toMatchObject({ state: "stopped" });
  expect(w.boxes.get("bx_retry0")!.stopped).toBe(true);
  expect(w.boxes.get("bx_retry1")!.stopped).toBe(false);
});
