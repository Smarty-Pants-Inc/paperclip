import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { environmentAcquireErrorData, readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";
import { readTransientEnvironmentProviderFailure } from "../../../../../server/src/services/environment-provider-unavailable-error.js";
vi.mock("node:timers/promises", () => ({ setTimeout: (ms = 0) => new Promise(r => globalThis.setTimeout(r, ms)) }));
const key = "boat_REVIEW_SECRET_CANARY_4819";
const cfg = { apiKey: key, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const p = { driverKey: "boat", companyId: "u3co", environmentId: "u3env", runId: "u3run", creationOperationId: "u3attempt", config: cfg };
const owned = (attempt = "u3attempt") => ({ owner: "paperclip:u3co", environment: "u3env", run: "u3run", "paperclip-acquire": attempt });
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
let logs: unknown[];
beforeEach(async () => {
  logs = [];
  await plugin.definition.setup({ logger: Object.fromEntries(["info", "warn", "error", "debug"].map(k => [k, (...args: unknown[]) => logs.push(args)])) } as any);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("private " + key, "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type Opt = { visibleAt?: number; ids?: string[]; listDelay?: number; setupUntil?: number; readyAt?: number; state?: string; stopFail?: string };
function world(o: Opt = {}) {
  const calls: any[] = [], boxes = new Map<string, { attempt: string; stopped: boolean }>();
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push({ at: Date.now(), method, path, key: new Headers(init.headers).get("Idempotency-Key") });
    if (method === "POST" && path === "/sandboxes") {
      const attempt = JSON.parse(init.body).labels["paperclip-acquire"];
      const ids = o.ids ?? ["bx_review" + boxes.size]; for (const id of ids) boxes.set(id, { attempt, stopped: false });
      return await new Promise<Response>((_, reject) => { const s = init.signal!; s.addEventListener("abort", () => reject(s.reason), { once: true }); });
    }
    if (method === "GET" && path === "/sandboxes") {
      if (o.listDelay) await new Promise(r => setTimeout(r, o.listDelay));
      const attempt = u.searchParams.get("label")!.split("=")[1];
      return res({ sandboxes: Date.now() >= (o.visibleAt ?? 0) ? [...boxes].filter(([, b]) => b.attempt === attempt).map(([id, b]) => ({ id, state: b.stopped ? "archived" : o.state ?? "ready", labels: owned(b.attempt) })) : [], pageInfo: { nextCursor: null } });
    }
    const id = path.split("/")[2], b = boxes.get(id);
    if (b && method === "POST" && path.endsWith("/stop")) {
      if (id === o.stopFail) return res({}, 503);
      b.stopped = true; return res({ stop: { id: "stop_" + id, status: "pending" } }, 202);
    }
    if (b && method === "GET") return res({ sandbox: { id, labels: owned(b.attempt), state: b.stopped ? "archived" : Date.now() < (o.readyAt ?? 0) ? "provisioning" : o.state ?? "ready", setupStatus: Date.now() >= (o.setupUntil ?? 0) ? "done" : "running", ...(b.stopped ? { stop: { id: "stop_" + id, status: "completed" } } : {}) } });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return { calls, boxes };
}
function emit(name: string, w: ReturnType<typeof world>, extra = {}) {
  console.info("U3_EVIDENCE", JSON.stringify({ name, now: Date.now(), calls: w.calls, boxes: [...w.boxes], ...extra }));
}
it("late-after-cap: durable inspection stays retryable, later discovers and stops the exact paid box", async () => {
  const w = world({ visibleAt: 95_000 });
  const work = plugin.definition.onEnvironmentAcquireLease!(p).catch(e => e);
  await vi.advanceTimersByTimeAsync(90_000); const e = await work;
  expect(e).toMatchObject({ code: "ETIMEDOUT", providerState: "absent", elapsedMs: 90_000 });
  const inspect = () => plugin.definition.onEnvironmentInspectLease!({ ...p, providerLeaseId: "u3attempt", creationOperation: { id: "u3attempt", runId: "u3run" } });
  await expect(inspect()).rejects.toThrow("not visible yet");
  await vi.advanceTimersByTimeAsync(5_000); const observed = await inspect();
  expect(observed.state).toBe("unknown"); expect(observed.creationCleanup).toMatchObject({ attemptId: "u3attempt", providerLeaseId: "bx_review0" });
  await expect(plugin.definition.onEnvironmentDestroyLease!({ ...p, providerLeaseId: observed.providerLeaseId, leaseMetadata: { failedCreateCleanup: observed.creationCleanup } })).resolves.toMatchObject({ state: "stopped" });
  expect([...w.boxes.values()].every(b => b.stopped)).toBe(true); expect(w.calls.some(c => c.method === "DELETE")).toBe(false);
  emit("late-after-cap", w, { diagnostic: environmentAcquireErrorData(e) });
});
it("several matches: adopts none, completion-confirmed stops every exact box", async () => {
  const w = world({ ids: ["bx_reviewA", "bx_reviewB"] });
  const work = plugin.definition.onEnvironmentAcquireLease!(p).catch(e => e);
  await vi.advanceTimersByTimeAsync(31_000); const e = await work;
  expect(e).toMatchObject({ code: "ETIMEDOUT", providerState: "other" });
  expect([...w.boxes.values()].every(b => b.stopped)).toBe(true);
  expect(w.calls.filter(c => c.method === "POST" && c.path === "/sandboxes")).toHaveLength(1);
  emit("multiple-owned-matches", w);
});
it("several matches with one unconfirmed stop: durable cleanup rediscovers every match", async () => {
  const w = world({ ids: ["bx_reviewC", "bx_reviewD"], stopFail: "bx_reviewC" });
  const work = plugin.definition.onEnvironmentAcquireLease!(p).catch(e => e);
  await vi.advanceTimersByTimeAsync(35_000); const e = await work;
  expect(readEnvironmentCreationCleanupError(e)).toMatchObject({ providerLeaseId: "bx_reviewC", attemptId: "u3attempt" });
  expect(w.boxes.get("bx_reviewD")!.stopped).toBe(true); expect(w.boxes.get("bx_reviewC")!.stopped).toBe(false);
  emit("multiple-stop-failure", w);
});
it("direct SDK retry mints another idempotency key: old invisible paid box remains caller-owned", async () => {
  const w = world({ visibleAt: 1_000_000 });
  const direct = { ...p, creationOperationId: undefined };
  for (let n = 0; n < 2; n++) {
    const work = plugin.definition.onEnvironmentAcquireLease!(direct).catch(e => e);
    await vi.advanceTimersByTimeAsync(90_000); expect(await work).toMatchObject({ code: "ETIMEDOUT" });
  }
  const creates = w.calls.filter(c => c.method === "POST" && c.path === "/sandboxes");
  expect(creates).toHaveLength(2); expect(creates[0].key).not.toBe(creates[1].key);
  expect(w.boxes.size).toBe(2); expect([...w.boxes.values()].every(b => !b.stopped)).toBe(true);
  emit("direct-retry-distinct-keys", w);
});
it("HARD-CAP guard: a slow lookup must not admit a box that first appears after 90 seconds", async () => {
  const w = world({ visibleAt: 95_000, listDelay: 9_000 });
  const work = plugin.definition.onEnvironmentAcquireLease!(p).then(lease => ({ lease }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(110_000); const result = await work;
  emit("lookup-overruns-cap", w, result);
  expect(result).toHaveProperty("error.code", "ETIMEDOUT");
});
it("adopted readiness alone is stopped at the 180-second deadline", async () => {
  const w = world({ visibleAt: 85_000, readyAt: 190_000 });
  const work = plugin.definition.onEnvironmentAcquireLease!(p).then(lease => ({ lease }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(195_000); const result = await work;
  expect(result).toHaveProperty("error");
  expect(w.calls.find(c => c.method === "POST" && c.path.endsWith("/stop"))?.at).toBe(180_000);
  emit("readiness-budget", w, result);
});
it("WHOLE-BUDGET guard: adopted readiness plus setup must not hand off after 180 seconds", async () => {
  const w = world({ visibleAt: 85_000, setupUntil: 220_000 });
  const work = plugin.definition.onEnvironmentAcquireLease!({ ...p, config: { ...cfg, setupScript: "true", setupTimeoutSeconds: 300 } }).then(lease => ({ lease }), error => ({ error }));
  await vi.advanceTimersByTimeAsync(225_000); const result = await work;
  emit("setup-overruns-budget", w, result);
  expect(result).toHaveProperty("error");
  expect(w.calls.some(c => c.method === "POST" && c.path.endsWith("/stop"))).toBe(true);
});
it.each(["absent", "error"])("new %s diagnostics expose no API key in logs, error tree, stack or RPC data", async state => {
  const w = world(state === "absent" ? { visibleAt: 1_000_000 } : { state: "error" });
  const work = plugin.definition.onEnvironmentAcquireLease!(p).catch(e => e);
  await vi.advanceTimersByTimeAsync(95_000); const e = await work;
  const raw = JSON.stringify({ message: e.message, stack: e.stack, data: environmentAcquireErrorData(e), own: Object.getOwnPropertyDescriptors(e), logs });
  expect(raw).not.toContain(key);
  const rpc = { data: environmentAcquireErrorData(e) };
  const hostEvidence = readTransientEnvironmentProviderFailure(rpc);
  if (state === "absent") expect(hostEvidence).toEqual({ errorCode: "ETIMEDOUT" });
  else expect(hostEvidence).toBeNull();
  emit("safe-diagnostics-" + state, w, { data: rpc.data, hostEvidence });
});
