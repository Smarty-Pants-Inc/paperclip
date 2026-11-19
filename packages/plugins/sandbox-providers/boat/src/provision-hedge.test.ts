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
function world(readyAfter: number[], options: { errorAt?: number; archivedAt?: number; refuseStops?: boolean; hangHedge?: boolean; omitLoser?: boolean; hedgeVisibleAt?: number; hedgePostDelayMs?: number; listGate?: () => Promise<void> } = {}) {
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
      const firstSend = !existing;
      if (!existing) { const id = `bx_hedge${boxes.size}`; boxes.set(id, { key, labels: body.labels, at: Date.now(), stopped: false }); existing = [id, boxes.get(id)!]; }
      if (options.hedgePostDelayMs && firstSend && existing[0] === "bx_hedge1") await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.hedgePostDelayMs);
        init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
      });
      if (options.hangHedge && existing[0] === "bx_hedge1") return await new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      return res({ sandbox: { id: existing[0], state: state(...existing) } }, 202);
    }
    if (method === "GET" && path === "/sandboxes") {
      await options.listGate?.();
      const filter = u.searchParams.get("label")!.split("=");
      return res({ sandboxes: [...boxes].filter(([id, b]) => b.labels[filter[0]] === filter[1] && !(options.omitLoser && id === "bx_hedge0") && !(id === "bx_hedge1" && Date.now() < (options.hedgeVisibleAt ?? 0))).map(([id, b]) => ({ id, state: state(id, b), labels: b.labels })), pageInfo: { nextCursor: null } });
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
// Keep: never-OK winner-stop and paid-loser guards from rf-4's spare.13 verdict.
it("same-worker same run + creation operation coalesces re-entry onto one winner, never stopping a returned box", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  // The original hedge POST answers slowly, but its replay answers immediately.
  // Hold cleanup inventory until both decisions so a stop cannot mask the race.
  const w = world([77_000, 0], { hedgePostDelayMs: 4_000, listGate: () => gate });
  const first = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(76_000);
  const second = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(4_000);
  const a: any = await first, b: any = await second;
  release(); await vi.advanceTimersByTimeAsync(10_000);
  expect(a.error).toBeUndefined(); expect(b.error).toBeUndefined();
  const returned = [a.lease.providerLeaseId, b.lease.providerLeaseId];
  console.info("same-worker Boat boundary", JSON.stringify({ returned, stops: w.stops, boxes: [...w.boxes].map(([id, b]) => ({ id, stopped: b.stopped })) }));
  expect(returned[1]).toBe(returned[0]);
  expect(w.stops.filter(stop => returned.includes(stop.id))).toEqual([]);
  expect(w.boxes.get(returned[0])!.stopped).toBe(false);
  expect([...w.boxes].filter(([id, box]) => !returned.includes(id) && !box.stopped)).toEqual([]);
  expect(w.creates).toHaveLength(2); money(w);
});
it("two simultaneous same-operation callers share the slow primary + hedge acquisition", async () => {
  const w = world([240_000, 40_000]);
  const first = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  const second = settle(plugin.definition.onEnvironmentAcquireLease!({ ...params }));
  await vi.advanceTimersByTimeAsync(179_000);
  const a: any = await first, b: any = await second;
  expect(a.error).toBeUndefined(); expect(b.error).toBeUndefined();
  expect(a.lease.providerLeaseId).toBe("bx_hedge1");
  expect(b.lease.providerLeaseId).toBe(a.lease.providerLeaseId);
  expect(w.stops).toEqual([{ id: "bx_hedge0", body: {} }]);
  expect(w.boxes.get("bx_hedge1")!.stopped).toBe(false);
  expect(w.creates).toHaveLength(2); money(w);
});
// Keep: never-OK. rf-4 spare.14 V2, same timing and API boundary.
it("V2 settled same-run same-op caller at 190000 ms gets same winner with no new create and never stops winner", async () => {
  const w = world([240_000, 40_000]);
  const first = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(115_000);
  const a: any = await first;
  expect(a.error).toBeUndefined(); expect(a.lease.providerLeaseId).toBe("bx_hedge1");
  await vi.advanceTimersByTimeAsync(75_000);
  const second = settle(plugin.definition.onEnvironmentAcquireLease!({ ...params }));
  await vi.advanceTimersByTimeAsync(1_000);
  const b: any = await second;
  console.info("V2 settled re-entry Boat boundary", JSON.stringify({ at: Date.now(), first: a, second: b, creates: w.creates, stops: w.stops, boxes: [...w.boxes] }));
  expect(b.error).toBeUndefined(); expect(b.lease).toEqual(a.lease);
  expect(w.creates).toHaveLength(2);
  expect(w.stops).toEqual([{ id: "bx_hedge0", body: {} }]);
  expect(w.boxes.get(a.lease.providerLeaseId)!.stopped).toBe(false); money(w);
});
it("error cleanup after losing local settlement history excludes the durably committed winner by id", async () => {
  const w = world([240_000, 40_000]);
  const r = await acquire(170_000);
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge1");
  // Lose the local promise at replacement. The saved original acquisition
  // deadline is expired: this error path must not stop a committed chat box.
  vi.clearAllTimers(); vi.resetModules();
  const restarted = (await import("./plugin.js")).default;
  vi.useFakeTimers(); vi.setSystemTime(190_000);
  await restarted.definition.setup(context);
  const retry = settle(restarted.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(1_000);
  const result: any = await retry;
  console.info("committed-winner exclusion Boat boundary", JSON.stringify({ result, stops: w.stops, boxes: [...w.boxes] }));
  expect(result.error).toBeDefined();
  expect(w.stops.filter(stop => stop.id === r.lease.providerLeaseId)).toEqual([]);
  expect(w.boxes.get(r.lease.providerLeaseId)!.stopped).toBe(false);
  expect(w.creates).toHaveLength(2); money(w);
});
it("settlement is retained until the original TTL, not renewed by repeated re-entry", async () => {
  const w = world([240_000, 40_000]);
  const r = await acquire(170_000);
  await vi.advanceTimersByTimeAsync(1_530_000);
  const cached: any = await settle(plugin.definition.onEnvironmentAcquireLease!(params));
  expect(cached.lease).toEqual(r.lease);
  await vi.advanceTimersByTimeAsync(100_000); // Original TTL at 1800000 ms.
  const expired = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await expired as any).error).toBeDefined();
  expect(w.creates).toHaveLength(2);
  expect(w.stops.filter(stop => stop.id === r.lease.providerLeaseId)).toEqual([]);
  expect(w.boxes.get(r.lease.providerLeaseId)!.stopped).toBe(false); money(w);
});
it("creation inspection cannot invert the durable winner reservation when the primary is listed first", async () => {
  const w = world([240_000, 40_000]);
  const r = await acquire(170_000);
  expect(r.lease.providerLeaseId).toBe("bx_hedge1");
  vi.clearAllTimers(); vi.resetModules();
  const restarted = (await import("./plugin.js")).default;
  vi.useFakeTimers(); vi.setSystemTime(190_000); await restarted.definition.setup(context);
  await restarted.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "hop", creationOperation: { id: "hop", runId: "hrun" } } as any);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(w.stops.filter(stop => stop.id === r.lease.providerLeaseId)).toEqual([]);
  expect(w.boxes.get(r.lease.providerLeaseId)!.stopped).toBe(false);
  expect(w.creates).toHaveLength(2); money(w);
});
it("failed-create cleanup retries exclude the returned winner from inventory and exact-id stops", async () => {
  const w = world([240_000, 40_000]);
  const r = await acquire(170_000);
  expect(r.lease.providerLeaseId).toBe("bx_hedge1");
  const observed = await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "hop", creationOperation: { id: "hop", runId: "hrun" } } as any);
  const cleanup = observed.creationCleanup!;
  expect(cleanup.providerLeaseId).toBe("bx_hedge0");
  await plugin.definition.onEnvironmentDestroyLease!({ ...params, providerLeaseId: cleanup.providerLeaseId, leaseMetadata: { failedCreateCleanup: cleanup } });
  expect(w.boxes.get(r.lease.providerLeaseId)!.stopped).toBe(false);
  const winnerCleanup = { ...cleanup, providerLeaseId: r.lease.providerLeaseId, observedProviderLeaseId: r.lease.providerLeaseId };
  const result: any = await settle(plugin.definition.onEnvironmentDestroyLease!({ ...params, providerLeaseId: r.lease.providerLeaseId, leaseMetadata: { failedCreateCleanup: winnerCleanup } }) as Promise<any>);
  console.info("failed-create cleanup returned-winner boundary", JSON.stringify({ result, stops: w.stops, boxes: [...w.boxes] }));
  expect(result.error).toBeDefined();
  expect(w.stops.filter(stop => stop.id === r.lease.providerLeaseId)).toEqual([]);
  expect(w.boxes.get(r.lease.providerLeaseId)!.stopped).toBe(false); money(w);
});
it("different creation operations remain independent", async () => {
  const w = world([0, 0]);
  const first = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  const second = settle(plugin.definition.onEnvironmentAcquireLease!({ ...params, creationOperationId: "other-op" }));
  await vi.advanceTimersByTimeAsync(1_000);
  const a: any = await first, b: any = await second;
  expect(a.error).toBeUndefined(); expect(b.error).toBeUndefined();
  expect(b.lease.providerLeaseId).not.toBe(a.lease.providerLeaseId);
  expect(w.boxes.size).toBe(2); expect(w.stops).toEqual([]);
});
it("a rejected acquisition is evicted so a corrected retry can proceed", async () => {
  const w = world([0]);
  const first = await settle(plugin.definition.onEnvironmentAcquireLease!({ ...params, requestedExpiresAt: "2030-01-01T00:00:00Z" }));
  expect(first).toHaveProperty("error"); expect(w.boxes.size).toBe(0);
  const next = settle(plugin.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(1_000);
  const result: any = await next;
  expect(result.error).toBeUndefined(); expect(result.lease.providerLeaseId).toBe("bx_hedge0");
  expect(w.stops).toEqual([]);
});
it.each([false, true])("replacement autonomously stops surviving late loser debt within one backoff, with no further acquisition (spare setting present: %s)", async hasSpareSetting => {
  const w = world([100_000, 40_000, 0], { hangHedge: true, hedgeVisibleAt: 200_000 });
  const r = await acquire(130_000);
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge0");
  expect(w.stops).toEqual([]);
  vi.clearAllTimers(); vi.resetModules();
  const restarted = (await import("./plugin.js")).default;
  vi.useFakeTimers(); vi.setSystemTime(130_000);
  await restarted.definition.setup({ ...context, ...(hasSpareSetting ? { config: { get: async () => ({ readySpareCount: 0 }) } } : {}) });
  // The replacement's sole acquire supplies credentials before the late box
  // is visible. No subsequent acquire, inspection or health call may drive retry.
  const next = settle(restarted.definition.onEnvironmentAcquireLease!({ ...params, runId: "next-run", creationOperationId: "next-op" }));
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await next as any).error).toBeUndefined();
  expect(w.stops).toEqual([]);
  await vi.advanceTimersByTimeAsync(900_000 + 15_000);
  expect(w.stops).toEqual([{ id: "bx_hedge1", body: {} }]);
  expect(w.boxes.get("bx_hedge1")!.stopped).toBe(true);
  expect(w.boxes.get("bx_hedge0")!.stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(900_000 + 15_000);
  const debt: any = [...storage.entries()].find(([key]) => key.includes("stop-owed"))?.[1];
  expect(debt.owed).toEqual([]);
  const requests = vi.mocked(fetch).mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(vi.mocked(fetch).mock.calls.length).toBe(requests);
});
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
it.each([false, true])("a newly selected winner that fails setup before handoff is still cleaned up with its loser (resumed contender: %s)", async resumed => {
  const w = world([240_000, 40_000]);
  const request = { ...params, config: { ...cfg, setupScript: "true" } };
  let work = settle(plugin.definition.onEnvironmentAcquireLease!(request));
  if (resumed) {
    await vi.advanceTimersByTimeAsync(76_000);
    vi.clearAllTimers(); vi.resetModules();
    const restarted = (await import("./plugin.js")).default;
    vi.useFakeTimers(); vi.setSystemTime(76_000); await restarted.definition.setup(context);
    work = settle(restarted.definition.onEnvironmentAcquireLease!(request));
  }
  await vi.advanceTimersByTimeAsync(resumed ? 109_000 : 185_000);
  expect((await work as any).error).toBeDefined();
  expect([...w.boxes.values()].every(box => box.stopped)).toBe(true);
  expect(w.creates).toHaveLength(resumed ? 4 : 2); // Replays spend the same two keys.
  money(w);
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
it("an unanswered hedge appearing after handoff is stopped by existing maintenance with spares OFF and no further acquire", async () => {
  const w = world([100_000, 40_000], { hangHedge: true, hedgeVisibleAt: 150_000 });
  const r = await acquire(130_000);
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge0"); expect(w.stops).toHaveLength(0);
  // The shared owed-stop path retains its existing 15-minute retry backoff.
  await vi.advanceTimersByTimeAsync(1_000_000);
  expect(w.stops.map(s => s.id)).toEqual(["bx_hedge1"]); money(w);
});
it("shutdown during the owed-stop inventory read cannot discharge an unstopped loser", async () => {
  vi.resetModules();
  const isolated = (await import("./plugin.js")).default;
  vi.useFakeTimers(); vi.setSystemTime(0); await isolated.definition.setup(context);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const w = world([240_000, 40_000], { listGate: () => gate });
  const pending = settle(isolated.definition.onEnvironmentAcquireLease!(params));
  await vi.advanceTimersByTimeAsync(116_000);
  const r: any = await pending; expect(r.error).toBeUndefined();
  expect(w.stops).toHaveLength(0);
  const shutdown = isolated.definition.onShutdown!();
  release(); await shutdown;
  const debt: any = [...storage.entries()].find(([key]) => key.includes("stop-owed"))?.[1];
  // Either drain the stop, or retain its durable obligation for replacement.
  // A skipped stop with cleared debt is never acceptable.
  expect(w.boxes.get("bx_hedge0")!.stopped || debt.owed.some((row: any) => row.acquisition?.attemptId === "hop")).toBe(true);
});
it("hedge POST times out but its late box remains owned and is stopped when first wins", async () => {
  const w = world([100_000, 40_000], { hangHedge: true }); const r = await acquire();
  expect(r.error).toBeUndefined(); expect(r.lease.providerLeaseId).toBe("bx_hedge0");
  expect(w.stops.map(s => s.id)).toEqual(["bx_hedge1"]); money(w);
});
