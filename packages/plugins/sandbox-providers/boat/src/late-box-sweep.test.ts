import { afterEach, beforeEach, expect, it, vi } from "vitest";

// RFL late-box (A) (adopt-boat-late-sweep): a Boat box that first appears after
// core has settled its creation `destroyed` is found by the plugin's own label
// sweep and STOPPED. The plugin records the attempt (label, owner, time) in its
// durable state when it reports the creation destroyed or abandons the create
// at its cap; the maintenance tick lists Boat boxes by that `paperclip-acquire`
// label, checks each one by id as ours, and stops it. Never adopted.
// The plugin's REAL hooks and maintenance timer run against a fake Boat on one
// fake clock; the host's plugin state is a Map that survives a worker restart.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
import plugin from "./plugin.js";

const MIN = 60_000;
const TICK_MS = 15_000;
const cfg = { apiKey: "boat_sweep_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const company = "co-sweep", env = "env-sweep";
const base = { driverKey: "boat", companyId: company, environmentId: env, config: cfg };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });

type Box = { id: string; labels: Record<string, string>; name: string; visibleAt: number; stopped: boolean; stopPosts: number };
/** Boat: creates for `hung` attempts are accepted but never answered (the box shows up at `lateAt`); others are ready at once. */
class LateBoat {
  boxes = new Map<string, Box>();
  lists: Array<{ at: number; label: string }> = [];
  hung = new Map<string, number>();
  private n = 0;
  visible(box: Box) { return Date.now() >= box.visibleAt; }
  add(id: string, labels: Record<string, string>, visibleAt: number, name = "") { this.boxes.set(id, { id, labels, name, visibleAt, stopped: false, stopPosts: 0 }); }
  view(b: Box) { return { id: b.id, name: b.name, labels: b.labels, state: b.stopped ? "archived" : "ready", createdAt: new Date(b.visibleAt).toISOString(),
    ...(b.stopped ? { stop: { id: `stop_${b.id}`, status: "completed" } } : {}) }; }
  fetch = async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && path === "/sandboxes") {
      const labels = JSON.parse(init.body).labels as Record<string, string>;
      const lateAt = this.hung.get(labels["paperclip-acquire"]);
      if (lateAt !== undefined) {
        this.add(`bx_late${++this.n}`, labels, lateAt);
        const signal: AbortSignal = init.signal;
        return await new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      const id = `bx_run${++this.n}`;
      this.add(id, labels, Date.now());
      return res({ sandbox: this.view(this.boxes.get(id)!) }, 202);
    }
    if (method === "GET" && path === "/sandboxes") {
      const labels = u.searchParams.getAll("label").map(label => label.split("="));
      this.lists.push({ at: Date.now(), label: u.searchParams.getAll("label").join("&") });
      return res({ sandboxes: [...this.boxes.values()].filter(b => this.visible(b) && labels.every(([k, ...v]) => b.labels[k] === v.join("=")))
        .map(b => this.view(b)), pageInfo: { nextCursor: null } });
    }
    const id = decodeURIComponent(path.split("/")[2] ?? ""), b = this.boxes.get(id);
    if (!b || !this.visible(b)) return res({ error: "not_found" }, 404);
    if (method === "POST" && path.endsWith("/stop")) { b.stopPosts++; b.stopped = true; return res({ stop: { id: `stop_${id}`, status: "pending" } }, 202); }
    if (method === "GET" && path === `/sandboxes/${id}`) return res({ sandbox: this.view(b) });
    if (method === "PATCH" && path === `/sandboxes/${id}`) { const body = JSON.parse(init.body ?? "{}"); if (body.name) b.name = body.name; return res({ sandbox: this.view(b) }); }
    if (method === "PUT" && path.endsWith("/files")) return res({ success: true });
    if (method === "POST" && path.endsWith("/commands")) return res({ exitCode: 0, timedOut: false, stdout: "{}\n", stderr: "" });
    return res({ error: "unsupported_in_fake" }, 400);
  };
}

let boat: LateBoat;
let state: Map<string, unknown>;
const ctx = () => ({
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  state: {
    get: async (key: { scopeId?: string; namespace?: string; stateKey: string }) => state.get(`${key.scopeId}:${key.namespace}:${key.stateKey}`) ?? null,
    set: async (key: { scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => { state.set(`${key.scopeId}:${key.namespace}:${key.stateKey}`, structuredClone(value)); },
  },
});
beforeEach(async () => {
  boat = new LateBoat(); state = new Map();
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
  });
  vi.stubGlobal("fetch", vi.fn(boat.fetch));
  await plugin.definition.setup(ctx() as any);
});
afterEach(async () => {
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function settle<T>(promise: Promise<T>, stepMs = 100, limitMs = 300_000): Promise<T> {
  let done = false, value: T | undefined, error: unknown, failed = false;
  void promise.then(v => { done = true; value = v; }, e => { done = true; failed = true; error = e; });
  for (let waited = 0; !done && waited < limitMs; waited += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error("operation did not settle on the fake clock");
  if (failed) throw error;
  return value as T;
}
/** Advance the fake clock to `ms` (absolute), firing every maintenance tick on the way. */
const advanceTo = (ms: number) => vi.advanceTimersByTimeAsync(Math.max(0, ms - Date.now()));

/** A run create that times out at its cap; core settles it `destroyed` 30 min after the create (its settle floor). The box shows up `lateMin` after the create. */
async function destroyedCreation(runId: string, lateMin: number) {
  const op = { ...base, runId, creationOperationId: `op-${runId}` };
  const start = Date.now();
  boat.hung.set(op.creationOperationId, start + lateMin * MIN);
  const failed = plugin.definition.onEnvironmentAcquireLease!(op).catch(e => e);
  await vi.advanceTimersByTimeAsync(95_000);
  expect(await failed).toMatchObject({ code: "ETIMEDOUT", providerState: "absent" });
  await advanceTo(start + 30 * MIN);
  const observed = await plugin.definition.onEnvironmentInspectLease!({ ...op, providerLeaseId: op.creationOperationId,
    creationOperation: { id: op.creationOperationId, runId } } as any);
  expect(observed, "core settles the creation as absent at its deadline").toMatchObject({ providerLeaseId: op.creationOperationId, state: "destroyed" });
  return op;
}

it("R1 a box that appears at 40 min, after core settled its creation destroyed at 30, is found by the label sweep and stopped within one tick", async () => {
  const op = await destroyedCreation("run-r1", 40);
  await advanceTo(40 * MIN - 1);
  expect(boat.boxes.get("bx_late1")!.stopped, "nothing to stop before the box appears").toBe(false);
  await vi.advanceTimersByTimeAsync(TICK_MS + 1);
  const box = boat.boxes.get("bx_late1")!;
  expect(box.labels["paperclip-acquire"]).toBe(op.creationOperationId);
  expect(box.stopped, "the late box is stopped by the next maintenance tick").toBe(true);
  expect(box.stopPosts, "one stop, never adopted or resent").toBe(1);
});

it("R2 a worker restart between 'destroyed' and the box appearing: the record is durable, the box is still found and stopped", async () => {
  await destroyedCreation("run-r2", 40);
  await advanceTo(32 * MIN);
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  await plugin.definition.setup(ctx() as any);
  // The new worker holds a Boat key again once an acquire for the environment brings one.
  const lease = await settle(plugin.definition.onEnvironmentAcquireLease!({ ...base, runId: "run-r2b", creationOperationId: "op-run-r2b" }));
  expect(lease.providerLeaseId).toMatch(/^bx_run/);
  await advanceTo(40 * MIN + TICK_MS + 1);
  expect(boat.boxes.get("bx_late1")!.stopped, "the box the old worker reported destroyed is stopped by the new worker's sweep").toBe(true);
  expect(boat.boxes.get(lease.providerLeaseId!)!.stopped, "the new run's live lease is never touched").toBe(false);
});

it("R3 a box with our label but a different owner, or one claimed as a live lease, is never stopped; our own box still is", async () => {
  const op = await destroyedCreation("run-r3", 40);
  const ours = { owner: `paperclip:${company}`, environment: env, run: "run-r3", purpose: "run", "paperclip-acquire": op.creationOperationId };
  boat.add("bx_foreign", { ...ours, owner: "paperclip:someone-else" }, 40 * MIN);
  boat.add("bx_claimed", ours, 40 * MIN, `paperclip-claim:run-other:op-other`);
  await advanceTo(40 * MIN + 4 * TICK_MS);
  expect(boat.boxes.get("bx_late1")!.stopped, "our late box is stopped").toBe(true);
  expect(boat.boxes.get("bx_foreign")!.stopPosts, "a different owner's box is never stopped").toBe(0);
  expect(boat.boxes.get("bx_claimed")!.stopPosts, "a box claimed as a live lease is never stopped").toBe(0);
});

it("R4 no Boat list calls when there are no records (no cost when idle), and none once a record is swept or expired", async () => {
  const lease = await settle(plugin.definition.onEnvironmentAcquireLease!({ ...base, runId: "run-r4", creationOperationId: "op-run-r4" }));
  expect(lease.providerLeaseId).toMatch(/^bx_run/);
  const idleFrom = boat.lists.length;
  await advanceTo(2 * 60 * MIN);
  expect(boat.lists.slice(idleFrom), "a held key with no records lists nothing").toEqual([]);
  // A swept record is gone: after its box is stopped, the tick lists nothing more for it.
  const op = await destroyedCreation("run-r4b", 31);
  await vi.advanceTimersByTimeAsync(MIN + TICK_MS + 1);
  expect(boat.boxes.get("bx_late2")!.stopped).toBe(true);
  const sweptFrom = boat.lists.length;
  await vi.advanceTimersByTimeAsync(10 * MIN);
  expect(boat.lists.slice(sweptFrom), "no list calls after the record is swept").toEqual([]);
  // A record whose box never appears is listed until it expires (Boat keeps an Idempotency-Key 24 h), then never again.
  await destroyedCreation("run-r4c", Number.POSITIVE_INFINITY);
  await vi.advanceTimersByTimeAsync(TICK_MS + 1);
  expect(boat.lists.some(entry => entry.label.includes("op-run-r4c")), "the open record is listed").toBe(true);
  await vi.advanceTimersByTimeAsync(24 * 60 * MIN);
  const expiredFrom = boat.lists.length;
  await vi.advanceTimersByTimeAsync(10 * MIN);
  expect(boat.lists.slice(expiredFrom), "no list calls after the record expired").toEqual([]);
  void op;
});
