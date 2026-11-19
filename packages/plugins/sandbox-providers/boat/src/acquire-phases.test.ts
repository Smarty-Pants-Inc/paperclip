import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// rf-4 U3 C3: every budgeted acquisition ends with exactly one
// `boat.acquire.phases` log line (create/ready/setup/sync/handoff ms, the
// total, the outcome, created vs adopted), success or failure, so the 180 s
// budget's gate window can be read from logs. Same fake-Boat harness as
// create-bound.test.ts, on the plugin's public acquire hook.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {}, setupScript: "true", setupTimeoutSeconds: 300 };
const p = { driverKey: "boat", companyId: "bco", environmentId: "benv", runId: "brun", creationOperationId: "battempt", config: cfg };
const owned = { owner: "paperclip:bco", environment: "benv", run: "brun", "paperclip-acquire": "battempt" };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
const BOX = "bx_phase001";
const PHASES = ["create", "ready", "setup", "sync", "handoff"] as const;
let lines: { level: string; message: string; meta: any }[] = [];
beforeEach(async () => {
  lines = [];
  const log = (level: string) => (message: string, meta?: unknown) => { lines.push({ level, message, meta }); };
  await plugin.definition.setup({ logger: { info: log("info"), warn: log("warn"), error: log("error"), debug: log("debug") } } as any);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** The box is ready at `readyAt`, its setup done at `setupUntil`; create answers or hangs to its own abort. */
function world(o: { create: "ok" | "hang"; readyAt?: number; setupUntil: number }) {
  let stopped = false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    const signal: AbortSignal | undefined = init.signal;
    if (method === "POST" && path === "/sandboxes") {
      if (o.create === "ok") return res({ sandbox: { id: BOX, state: "provisioning" } }, 202);
      await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    if (method === "GET" && path === "/sandboxes") return res({ sandboxes: [{ id: BOX, state: stopped ? "archived" : "ready", labels: owned }], pageInfo: { nextCursor: null } });
    if (method === "POST" && path === `/sandboxes/${BOX}/stop`) { stopped = true; return res({ stop: { id: "stop_p", status: "pending" } }, 202); }
    if (method === "GET" && path === `/sandboxes/${BOX}`) return res({ sandbox: { id: BOX, labels: owned,
      state: stopped ? "archived" : Date.now() >= (o.readyAt ?? 0) ? "ready" : "provisioning",
      setupStatus: Date.now() >= o.setupUntil ? "done" : "running", ...(stopped ? { stop: { id: "stop_p", status: "completed" } } : {}) } });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
}
const settle = (work: Promise<unknown>) => work.then(lease => ({ lease }), error => ({ error }));
const stamps = () => lines.filter(line => line.message === "boat.acquire.phases");
function expectWellFormed(meta: any) {
  for (const name of PHASES) expect(meta.phasesMs[name], name).toBeGreaterThanOrEqual(0);
  const sum = PHASES.reduce((total, name) => total + meta.phasesMs[name], 0);
  expect(Math.abs(meta.totalMs - sum)).toBeLessThanOrEqual(5);
  // Only numbers and fixed words: no provider text, no key.
  expect(JSON.stringify(meta)).not.toContain("boat_test");
}

it("C3: one successful acquisition emits exactly one boat.acquire.phases line; total = the five phases", async () => {
  world({ create: "ok", readyAt: 4_000, setupUntil: 20_000 });
  const result: any = await (async () => { const work = settle(plugin.definition.onEnvironmentAcquireLease!(p)); await vi.advanceTimersByTimeAsync(60_000); return work; })();
  expect(result.error).toBeUndefined();
  expect(result.lease).toMatchObject({ providerLeaseId: BOX });
  expect(stamps()).toHaveLength(1);
  const { meta } = stamps()[0];
  expect(meta).toMatchObject({ outcome: "ok", source: "created", budgetMs: 180_000, companyId: "bco", environmentId: "benv" });
  expectWellFormed(meta);
  expect(meta.phasesMs.ready).toBeGreaterThanOrEqual(4_000);
  expect(meta.phasesMs.setup).toBeGreaterThan(0);
  expect(meta.totalMs).toBeGreaterThanOrEqual(20_000);
});

it("C3: an acquisition stopped at the 180 s budget emits one line with outcome budget", async () => {
  world({ create: "ok", setupUntil: 220_000 });
  const result: any = await (async () => { const work = settle(plugin.definition.onEnvironmentAcquireLease!(p)); await vi.advanceTimersByTimeAsync(230_000); return work; })();
  expect(result).toHaveProperty("error.code", "ETIMEDOUT");
  expect(stamps()).toHaveLength(1);
  const { meta } = stamps()[0];
  expect(meta).toMatchObject({ outcome: "budget", source: "created", failedPhase: "setup" });
  expectWellFormed(meta);
  expect(meta.phasesMs.setup).toBeGreaterThanOrEqual(170_000);
  expect(meta.phasesMs.sync).toBe(0);
  expect(meta.phasesMs.handoff).toBe(0);
});

it("C3: a timed-out create adopted by label is stamped adopted, its wait counted in create", async () => {
  world({ create: "hang", setupUntil: 0 });
  const result: any = await (async () => { const work = settle(plugin.definition.onEnvironmentAcquireLease!(p)); await vi.advanceTimersByTimeAsync(120_000); return work; })();
  expect(result.error).toBeUndefined();
  expect(stamps()).toHaveLength(1);
  const { meta } = stamps()[0];
  expect(meta).toMatchObject({ outcome: "ok", source: "adopted" });
  expectWellFormed(meta);
  expect(meta.phasesMs.create).toBeGreaterThanOrEqual(30_000);
});
