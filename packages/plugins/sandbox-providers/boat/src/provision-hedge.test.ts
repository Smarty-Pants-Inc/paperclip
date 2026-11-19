import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// Keep: money/lifecycle guard. One provisioning tail must not cost an unbounded
// number of boxes, and a losing allocation must never become orphaned.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener("abort", () => { clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const params = { driverKey: "boat", companyId: "hco", environmentId: "henv", runId: "hrun", creationOperationId: "hop", config: cfg };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
let storage: Map<string, unknown>, lines: any[], context: any;
beforeEach(async () => {
  storage = new Map(); lines = [];
  const key = (s: any) => JSON.stringify([s.scopeId, s.namespace, s.stateKey]);
  context = { state: { get: async (s: any) => structuredClone(storage.get(key(s))), set: async (s: any, v: unknown) => { storage.set(key(s), structuredClone(v)); } },
    logger: { info: (message: string, meta: any) => lines.push({ message, meta }), warn() {}, error() {}, debug() {} } };
  await plugin.definition.setup(context);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function world(readyAfter: number[], options: { errorAt?: number; archivedAt?: number; refuseStops?: boolean; hangHedge?: boolean; omitLoser?: boolean } = {}) {
  const creates: { at: number; key: string; body: string }[] = [], stops: { id: string; body: any }[] = [];
  const boxes = new Map<string, { key: string; labels: any; at: number; stopped: boolean }>();
  const state = (id: string, b: any) => b.stopped || (id === "bx_hedge0" && Date.now() >= (options.archivedAt ?? Infinity)) ? "archived" : id === "bx_hedge0" && Date.now() >= (options.errorAt ?? Infinity) ? "error"
    : Date.now() - b.at >= readyAfter[Number(id.slice(-1))] ? "running" : "provisioning";
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    if (method === "POST" && path === "/sandboxes") {
      const key = new Headers(init.headers).get("Idempotency-Key")!, body = JSON.parse(init.body);
      creates.push({ at: Date.now(), key, body: init.body });
      let existing = [...boxes].find(([, b]) => b.key === key);
      if (!existing) { const id = `bx_hedge${boxes.size}`; boxes.set(id, { key, labels: body.labels, at: Date.now(), stopped: false }); existing = [id, boxes.get(id)!]; }
      if (options.hangHedge && existing[0] === "bx_hedge1") return await new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      return res({ sandbox: { id: existing[0], state: state(...existing) } }, 202);
    }
    if (method === "GET" && path === "/sandboxes") {
      const filter = u.searchParams.get("label")!.split("=");
      return res({ sandboxes: [...boxes].filter(([id, b]) => b.labels[filter[0]] === filter[1] && !(options.omitLoser && id === "bx_hedge0")).map(([id, b]) => ({ id, state: state(id, b), labels: b.labels })), pageInfo: { nextCursor: null } });
    }
    const id = path.split("/")[2], b = boxes.get(id);
    if (b && method === "POST" && path.endsWith("/stop")) {
      stops.push({ id, body: JSON.parse(init.body) });
      if (options.refuseStops) return res({ error: "stop refused" }, 403);
      b.stopped = true; return res({ stop: { id: `stop_${id}`, status: "pending" } }, 202);
    }
    if (b && method === "GET") return res({ sandbox: { id, labels: b.labels, state: state(id, b), ...(b.stopped ? { stop: { id: `stop_${id}`, status: "completed" } } : {}) } });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return { creates, stops, boxes };
}
const settle = (work: Promise<unknown>) => work.then(lease => ({ lease }), error => ({ error }));
async function acquire(ms = 179_000) { const work = settle(plugin.definition.onEnvironmentAcquireLease!(params)); await vi.advanceTimersByTimeAsync(ms); return work as Promise<any>; }
function money(w: ReturnType<typeof world>) { expect(w.boxes.size).toBeLessThanOrEqual(2); expect(new Set(w.creates.map(c => c.key)).size).toBeLessThanOrEqual(2); }
it("slow first + 40s hedge: returns hedge; one non-force owed stop for the first", async () => {
  const w = world([240_000, 40_000]);
  const work = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(76_000);
  expect(w.boxes.size).toBe(2); money(w); // Guard paid inventory before selection.
  await vi.advanceTimersByTimeAsync(103_000);
  const result: any = await work;
  expect(result.error).toBeUndefined(); expect(result.lease.providerLeaseId).toBe("bx_hedge1");
  expect(w.creates.map(c => c.at)).toEqual([0, 75_000]);
  expect(w.stops).toEqual([{ id: "bx_hedge0", body: {} }]);
  const a = JSON.parse(w.creates[0].body).labels, b = JSON.parse(w.creates[1].body).labels;
  expect(b["paperclip-hedge-of"]).toBe(a["paperclip-acquire"]); expect(b.creation).toBe(w.creates[1].key); expect(b.creation).not.toBe(w.creates[0].key);
  const stamp = lines.filter(l => l.message === "boat.acquire.phases");
  expect(stamp).toHaveLength(1); expect(stamp[0].meta.source).toBe("hedge"); expect(stamp[0].meta.phasesMs.hedge).toBeGreaterThanOrEqual(40_000);
  expect(Object.values(stamp[0].meta.phasesMs).reduce((a: number, b: any) => a + b, 0)).toBe(stamp[0].meta.totalMs);
  money(w);
});
it.each([[130_000, 80_000, "bx_hedge0"], [160_000, 60_000, "bx_hedge1"]])("both slow (%i/%i): earlier ready wins, no per-box 120s failure", async (first, second, winner) => {
  const w = world([first, second]); const r = await acquire();
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe(winner);
  expect(w.stops.map(s => s.id)).toEqual([winner === "bx_hedge0" ? "bx_hedge1" : "bx_hedge0"]); money(w);
});
it("first ready before H: zero hedge creates and zero stops", async () => {
  const w = world([74_500, 40_000]); const r = await acquire();
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge0"); expect(w.creates).toHaveLength(1); expect(w.stops).toEqual([]); money(w);
});
it("known loser omitted by inventory: its exact ID remains owed and is stopped", async () => {
  const w = world([240_000, 40_000], { omitLoser: true }); const r = await acquire();
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge1");
  expect(w.stops.map(s => s.id)).toEqual(["bx_hedge0"]); money(w);
});
it("first ready exactly at H: ready takes precedence and zero hedge creates", async () => {
  const w = world([75_000, 40_000]); const r = await acquire();
  expect(r.error).toBeUndefined(); expect(w.creates).toHaveLength(1); expect(w.stops).toEqual([]); money(w);
});
it("first enters archived before H: existing failure, no hedge", async () => {
  const w = world([240_000, 40_000], { archivedAt: 74_000 }); const r = await acquire();
  expect(r.error).toBeDefined(); expect(w.creates).toHaveLength(1); money(w);
});
it("first enters error before H: existing failure, no hedge", async () => {
  const w = world([240_000, 40_000], { errorAt: 74_000 }); const r = await acquire();
  expect(r.error).toBeDefined(); expect(w.creates).toHaveLength(1); money(w);
});
it("both remain provisioning: acquisition budget stays 180s and both are stopped", async () => {
  const w = world([400_000, 400_000]); const r = await acquire(185_000);
  expect(r.error).toMatchObject({ code: "ETIMEDOUT", budgetMs: 180_000 });
  expect([...new Set(w.stops.map(s => s.id))].sort()).toEqual(["bx_hedge0", "bx_hedge1"]); money(w);
});
it("restart while hedge is provisioning: same durable hedge key, no third box, loser stopped", async () => {
  const w = world([240_000, 40_000]);
  // Interrupt in flight, not between completed acquisitions: discard the old
  // worker's timers/module, retaining only durable state and Boat inventory.
  void settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(76_000); expect(w.boxes.size).toBe(2);
  const hedgeKey = w.creates[1].key;
  vi.clearAllTimers(); vi.resetModules();
  const restarted = (await import("./plugin.js")).default;
  vi.useFakeTimers(); vi.setSystemTime(76_000);
  await restarted.definition.setup(context);
  const work = settle(restarted.definition.onEnvironmentAcquireLease!(params)); await vi.advanceTimersByTimeAsync(100_000);
  const r: any = await work; expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge1");
  expect(w.creates.filter(c => c.key === hedgeKey).map(c => c.body)).toEqual([w.creates[1].body, w.creates[1].body]);
  expect(w.stops.map(s => s.id)).toEqual(["bx_hedge0"]); money(w);
});
it("core inspection after a crash during an unanswered hedge owns its late box without any new create", async () => {
  const w = world([240_000, 40_000], { hangHedge: true });
  void settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(76_000); expect(w.boxes.size).toBe(2);
  vi.clearAllTimers(); vi.resetModules();
  const restarted = (await import("./plugin.js")).default;
  vi.useFakeTimers(); vi.setSystemTime(76_000); await restarted.definition.setup(context);
  const observed = await restarted.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "hop", creationOperation: { id: "hop", runId: "hrun" } } as any);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(observed.creationCleanup).toMatchObject({ attemptId: "hop" });
  expect(w.stops.map(s => s.id)).toEqual(["bx_hedge1"]);
  expect(w.creates).toHaveLength(2);
  const debt: any = [...storage.entries()].find(([key]) => key.includes("stop-owed"))?.[1];
  expect(debt.owed).toHaveLength(1); expect(debt.owed[0].acquisition.settleUntil).toBe(1_800_000); money(w);
});
it("refused loser stop stays durably owed after a successful hedge", async () => {
  const w = world([240_000, 40_000], { refuseStops: true }); const r = await acquire();
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge1");
  const debt: any = [...storage.entries()].find(([key]) => key.includes("stop-owed"))?.[1];
  expect(debt.owed).toHaveLength(1); expect(debt.owed[0].acquisition.attemptId).toBe("hop"); money(w);
});
it("hedge POST times out but its late box remains owned and is stopped when first wins", async () => {
  const w = world([100_000, 40_000], { hangHedge: true }); const r = await acquire();
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge0");
  expect(w.stops.map(s => s.id)).toEqual(["bx_hedge1"]); money(w);
});
