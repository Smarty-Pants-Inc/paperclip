// Ready-spare wake race (gate 2, 2026-11-15 23:29Z): the plugin's REAL hooks,
// event handlers, keeper and claim store against a STATEFUL fake Boat. One
// fake clock drives Boat create latency, the plugin's own polls and the 15 s
// maintenance interval; the fake Boat itself schedules nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The plugin polls with node:timers/promises. Route it onto the faked global
// timer so every plugin delay runs on the same fake clock as the interval.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));

import plugin from "./plugin.js";

const apiKey = "boat_wake_race_test";
const baseConfig = { apiKey, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const IDLE_MINUTES = 15;
const CREATE_LATENCY_MS = 2_000;
const TICK_MS = 15_000;
const LIVE_RUN_OFFSET_MS = 600; // gate 2: the stop landed 0.6 s after the wake's create
const START = Date.UTC(2026, 10, 15, 23, 0, 0);

type Box = { id: string; labels: Record<string, string>; name: string; state: "creating" | "ready" | "archived";
  readyAt: number; archiveAfter: string; createdAt: string; team: { id: string } };
type LogEntry = { seq: number; at: number; kind: "boat" | "activity-read" | "event" | "db" | "warn";
  method?: string; path?: string; id?: string; purpose?: string; value?: unknown; note?: string };
type StopRecord = { id: string; at: number; seq: number; stateBefore: string;
  /** The last company-activity read the plugin made before this POST /stop. */
  activitySeen?: { seq: number; at: number; value: unknown };
  /** True only when that read follows this flow's last look at the box/inventory and no event intervened. */
  readImmediatelyBefore: boolean };

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeBoat {
  readonly boxes = new Map<string, Box>();
  readonly log: LogEntry[] = [];
  readonly stops: StopRecord[] = [];
  /** Fires before the fake answers any request (used to land an event between a decision and its POST /stop). */
  beforeRequest?: (method: string, route: string, id?: string) => Promise<void>;
  private seq = 0;
  private counter = 0;

  constructor(private readonly createLatencyMs: number) {}

  record(entry: Omit<LogEntry, "seq" | "at">): LogEntry {
    const full = { seq: ++this.seq, at: Date.now(), ...entry };
    this.log.push(full);
    return full;
  }
  /** Lazy state transition on the fake clock: no timer is ever scheduled here. */
  observe(box: Box): Box {
    if (box.state === "creating" && Date.now() >= box.readyAt) box.state = "ready";
    return box;
  }
  creates(purpose = "spare") { return this.log.filter(e => e.kind === "boat" && e.method === "POST" && e.path === "/sandboxes" && e.purpose === purpose); }
  stopsFor(id: string) { return this.stops.filter(stop => stop.id === id); }
  spareIds() { return [...this.boxes.values()].filter(box => box.labels.purpose === "spare").map(box => box.id); }

  readonly fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const route = url.pathname.replace("/api/v1", "");
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const id = /^\/sandboxes\/([^/]+)/.exec(route)?.[1];
    const stopRoute = method === "POST" && id !== undefined && route.endsWith("/stop");
    // POST /stop is recorded as received first; a hook on it lands after the POST is out.
    if (this.beforeRequest && !stopRoute) await this.beforeRequest(method, route, id);
    if (method === "POST" && route === "/sandboxes") {
      const purpose = body.labels.purpose === "spare" ? "spare" : "run";
      const box: Box = { id: `bx_${purpose}${String(++this.counter).padStart(4, "0")}`, labels: { ...body.labels }, name: "",
        state: "creating", readyAt: Date.now() + this.createLatencyMs,
        archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), createdAt: new Date().toISOString(), team: { id: "team-wake-race" } };
      this.boxes.set(box.id, box);
      this.record({ kind: "boat", method, path: route, id: box.id, purpose });
      return response({ sandbox: { ...box } }, 202);
    }
    if (stopRoute) {
      const box = this.boxes.get(id);
      const entry = this.record({ kind: "boat", method, path: route, id });
      const last = this.log.filter(e => e.kind === "activity-read" && e.seq < entry.seq).at(-1);
      // "Immediately before": after the re-read, this stop's flow made no further
      // look at the box or the inventory, and no event landed, before the POST.
      const between = last ? this.log.filter(e => e.seq > last.seq && e.seq < entry.seq) : [];
      const readImmediatelyBefore = last !== undefined && between.every(e => e.kind !== "event"
        && !(e.kind === "boat" && (e.id === id || (e.method === "GET" && e.path === "/sandboxes"))));
      this.stops.push({ id, at: entry.at, seq: entry.seq, stateBefore: box ? this.observe(box).state : "missing",
        activitySeen: last ? { seq: last.seq, at: last.at, value: last.value } : undefined, readImmediatelyBefore });
      if (this.beforeRequest) await this.beforeRequest(method, route, id);
      if (box) box.state = "archived";
      return response({ operation: { id: `stop-${id}`, status: "completed" } }, 202);
    }
    this.record({ kind: "boat", method, path: route, ...(id ? { id } : {}) });
    if (method === "GET" && route === "/sandboxes") {
      const labels = url.searchParams.getAll("label").map(label => label.split("="));
      const matching = [...this.boxes.values()].map(box => this.observe(box))
        .filter(box => labels.every(([key, ...rest]) => box.labels[key] === rest.join("=")));
      return response({ sandboxes: matching.map(box => ({ ...box })), pageInfo: { nextCursor: null } });
    }
    const box = id ? this.boxes.get(id) : undefined;
    if (id && !box) return response({ error: "not_found" }, 404);
    if (method === "GET" && box && route === `/sandboxes/${id}`) return response({ sandbox: { ...this.observe(box) } });
    if (method === "PATCH" && box && route === `/sandboxes/${id}`) {
      this.observe(box);
      if (box.state !== "archived") {
        if (body?.name) box.name = body.name;
        if (body?.ttlSeconds) box.archiveAfter = new Date(Date.now() + body.ttlSeconds * 1000).toISOString();
      }
      return response({ sandbox: { ...box } });
    }
    if (method === "PUT" && route.endsWith("/files")) return response({ success: true });
    if (method === "POST" && route.endsWith("/commands")) return response({ exitCode: 0, timedOut: false, stdout: "{}\n", stderr: "" });
    throw new Error(`Unexpected fake Boat request ${method} ${route}`);
  };
}

type Harness = { name: string; boat: FakeBoat; company: string; env: string; emit(eventType: string): Promise<void>;
  acquire(runId: string): Promise<{ providerLeaseId: string | null }>; dbCalls: Array<{ inAcquire: boolean; sql: string }>;
  warnings: string[] };

let acquireDepth = 0;
let current: Harness | undefined;
const eventHandlers = new Map<string, (event: unknown) => Promise<void>>();
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function settle<T>(promise: Promise<T>, stepMs = 100, limitMs = 180_000): Promise<T> {
  let done = false, value: T | undefined, error: unknown, failed = false;
  void promise.then(v => { done = true; value = v; }, e => { done = true; failed = true; error = e; });
  for (let waited = 0; !done && waited < limitMs; waited += stepMs) await advance(stepMs);
  if (!done) throw new Error("operation did not settle on the fake clock");
  if (failed) throw error;
  return value as T;
}

async function harness(name: string): Promise<Harness> {
  const boat = new FakeBoat(CREATE_LATENCY_MS);
  vi.stubGlobal("fetch", boat.fetch);
  const company = `company-${name}`, env = `environment-${name}`;
  const state = new Map<string, unknown>();
  const dbCalls: Array<{ inAcquire: boolean; sql: string }> = [];
  const warnings: string[] = [];
  const claims = new Set<string>();
  const db = { namespace: "boat_sandbox_provider", execute: async (sql: string, params: unknown[] = []) => {
    dbCalls.push({ inAcquire: acquireDepth > 0, sql });
    boat.record({ kind: "db", note: sql.split(" ")[0], id: String(params[0]) });
    if (claims.has(String(params[0]))) return { rowCount: 0 };
    claims.add(String(params[0]));
    return { rowCount: 1 };
  } };
  const instanceConfig = { spares: 1, spareMax: 3, spareDemandWindowMinutes: 10, spareEnvironmentIds: [env], spareIdleMinutes: IDLE_MINUTES };
  const warn = (message: string) => { warnings.push(message); boat.record({ kind: "warn", note: message }); };
  await plugin.definition.setup({
    config: { get: async () => instanceConfig },
    logger: { info: vi.fn(), warn: vi.fn(warn), error: vi.fn(warn), debug: vi.fn() },
    db,
    events: { on: (eventType: string, _filter: unknown, handler: (event: unknown) => Promise<void>) => {
      eventHandlers.set(eventType, handler);
      return () => eventHandlers.delete(eventType);
    } },
    state: {
      get: async (key: { scopeId?: string; stateKey: string }) => {
        const value = state.get(`${key.scopeId}:${key.stateKey}`) ?? null;
        if (key.stateKey === "company-activity") boat.record({ kind: "activity-read", value: value ? { ...(value as object) } : null });
        return value;
      },
      set: async (key: { scopeId?: string; stateKey: string }, value: unknown) => { state.set(`${key.scopeId}:${key.stateKey}`, value); },
    },
  } as any);
  await plugin.definition.onConfigChanged!(instanceConfig, { companyId: company } as any);
  const h: Harness = {
    name, boat, company, env, dbCalls, warnings,
    emit(eventType) {
      const handler = eventHandlers.get(eventType);
      if (!handler) throw new Error(`no handler for ${eventType}`);
      boat.record({ kind: "event", note: eventType });
      return handler({ eventId: `${eventType}-${Date.now()}`, eventType, companyId: company, occurredAt: new Date().toISOString() });
    },
    async acquire(runId) {
      acquireDepth++;
      try {
        return await plugin.definition.onEnvironmentAcquireLease!({ driverKey: "boat", companyId: company, environmentId: env, runId,
          creationOperationId: `attempt-${runId}`, config: baseConfig } as any);
      } finally { acquireDepth--; }
    },
  };
  current = h;
  return h;
}

/** Seed: one cold run lease teaches the plugin the pool; spare S1 becomes ready. */
async function seed(h: Harness): Promise<string> {
  await settle(h.acquire("run-seed"));
  await advance(5_000);
  const spares = h.boat.spareIds();
  expect(spares).toHaveLength(1);
  const s1 = h.boat.boxes.get(spares[0])!;
  expect(s1.state).toBe("ready");
  expect(s1.name).toMatch(/^paperclip-spare:ready:/);
  return s1.id;
}

/** Idle past spareIdleMinutes; the 15 s maintenance tick idle-stops S1 (expected). */
async function idleStop(h: Harness, s1: string): Promise<number> {
  for (let waited = 0; h.boat.stopsFor(s1).length === 0 && waited < (IDLE_MINUTES + 2) * 60_000; waited += 1_000) await advance(1_000);
  const [stop] = h.boat.stopsFor(s1);
  expect(stop, "maintenance idle-stops S1 once the company is idle").toBeDefined();
  expect(h.boat.boxes.get(s1)!.state).toBe("archived");
  return stop.at;
}

function onlyRefill(h: Harness, s1: string): string {
  const refills = h.boat.creates().filter(entry => entry.id !== s1);
  expect(refills.map(entry => entry.id), "exactly ONE refill create").toHaveLength(1);
  return refills[0].id!;
}

async function claimGetsWarm(h: Harness, warm: string): Promise<void> {
  const runCreatesBefore = h.boat.creates("run").length;
  const lease = await settle(h.acquire("run-after-ready"));
  expect(lease.providerLeaseId, "a claim after ready gets the spare warm (claim index kept it)").toBe(warm);
  expect(h.boat.creates("run"), "no cold create for the claim").toHaveLength(runCreatesBefore);
}

function everyStopReReadActivity(h: Harness): void {
  for (const stop of h.boat.stops) {
    expect(stop.readImmediatelyBefore, `POST /stop ${stop.id} at +${stop.at - START} ms: company activity must be re-read immediately before it`).toBe(true);
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(async (context) => {
  const dir = process.env.WAKE_RACE_EVIDENCE;
  if (dir && current) {
    mkdirSync(dir, { recursive: true });
    const slug = context.task.name.split(":")[0].replace(/[^A-Za-z0-9-]+/g, "_");
    writeFileSync(`${dir}/${slug}.json`, JSON.stringify({ test: context.task.name, state: context.task.result?.state,
      stops: current.boat.stops.map(stop => ({ ...stop, atMs: stop.at - START })),
      log: current.boat.log.map(entry => ({ ...entry, atMs: entry.at - START })) }, null, 1));
  }
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  eventHandlers.clear();
  acquireDepth = 0;
  current = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Boat ready spare wake race (cl-spare-wakerace4)", () => {
  it("RED-1 tick during creating: the wake refill R is never stopped, stays in the claim index, and every stop re-reads activity", async () => {
    const h = await harness("red1");
    const s1 = await seed(h);
    const stoppedAt = await idleStop(h, s1);
    // issue.created 1 s before the next maintenance tick; the 2 s create spans that tick.
    await advance(stoppedAt + TICK_MS - 1_000 - Date.now());
    const t0 = Date.now();
    const wake = h.emit("issue.created");
    await advance(1_500);
    const r = onlyRefill(h, s1);
    expect(h.boat.log.some(e => e.method === "GET" && e.path === "/sandboxes" && e.at === t0 + 1_000), "a maintenance tick listed Boat while R was creating").toBe(true);
    await settle(wake);
    await advance(4 * TICK_MS);
    expect(h.boat.stopsFor(r), "0 POST /stop for R").toHaveLength(0);
    expect(h.boat.boxes.get(r)!.state).toBe("ready");
    everyStopReReadActivity(h);
    await claimGetsWarm(h, r);
  });

  it("RED-1b tick during creating, live timing: the issue's run acquires 0.6 s after the wake while R is creating", async () => {
    const h = await harness("red1b");
    const s1 = await seed(h);
    const stoppedAt = await idleStop(h, s1);
    await advance(stoppedAt + TICK_MS - 1_000 - Date.now());
    const wake = h.emit("issue.created").then(() => "ok", (error: Error) => error.message);
    await advance(LIVE_RUN_OFFSET_MS);
    const run = h.acquire("run-woken-by-issue");
    await settle(run);
    expect(await settle(wake), "the wake reconcile completes (gate 2: 'entered archived')").toBe("ok");
    await advance(4 * TICK_MS);
    const r = h.boat.creates().filter(entry => entry.id !== s1)[0].id!;
    expect(h.boat.stopsFor(r), "0 POST /stop for R").toHaveLength(0);
    expect(h.warnings.filter(w => /wake reconciliation failed/.test(w))).toHaveLength(0);
    expect(onlyRefill(h, s1)).toBe(r);
    expect(h.boat.boxes.get(r)!.state).toBe("ready");
    everyStopReReadActivity(h);
    await claimGetsWarm(h, r);
  });

  it("RED-2 TOCTOU (a): the event lands after maintenance decided 'idle' but before POST /stop, so the stop is skipped", async () => {
    const h = await harness("red2a");
    const s1 = await seed(h);
    const idleFrom = Date.now() + IDLE_MINUTES * 60_000;
    let firedAt: number | undefined;
    // Maintenance read 'idle', chose S1 and is on its last Boat call before
    // POST /stop (the pre-stop GET): the event lands exactly there.
    h.boat.beforeRequest = async (method, route, id) => {
      if (firedAt !== undefined || Date.now() < idleFrom || method !== "GET" || id !== s1 || route !== `/sandboxes/${s1}`) return;
      firedAt = Date.now();
      await h.emit("issue.created");
    };
    for (let waited = 0; firedAt === undefined && waited < (IDLE_MINUTES + 2) * 60_000; waited += 1_000) await advance(1_000);
    expect(firedAt, "maintenance decided to stop S1 while idle").toBeDefined();
    await advance(4 * TICK_MS);
    expect(h.boat.stopsFor(s1), "the stop decided before the event is skipped: 0 POST /stop for S1").toHaveLength(0);
    expect(h.boat.creates(), "S1 stays the spare; no refill needed").toHaveLength(1);
    everyStopReReadActivity(h);
    await claimGetsWarm(h, s1);
  });

  it("RED-2 TOCTOU (b): the event lands as Boat receives POST /stop, so the wake makes a refill that is never stopped", async () => {
    const h = await harness("red2b");
    const s1 = await seed(h);
    let fired = false;
    h.boat.beforeRequest = async (method, route) => {
      if (fired || method !== "POST" || route !== `/sandboxes/${s1}/stop`) return;
      fired = true;
      await h.emit("issue.created");
    };
    for (let waited = 0; !fired && waited < (IDLE_MINUTES + 2) * 60_000; waited += 1_000) await advance(1_000);
    expect(fired, "maintenance reached POST /stop for S1 after deciding idle").toBe(true);
    await advance(4 * TICK_MS);
    expect(h.boat.boxes.get(s1)!.state).toBe("archived");
    const live = [...h.boat.boxes.values()].filter(box => box.labels.purpose === "spare" && box.state === "ready").map(box => box.id);
    expect(live, "the wake made a refill R that is ready").toHaveLength(1);
    const r = onlyRefill(h, s1);
    expect(live[0]).toBe(r);
    expect(h.boat.stopsFor(r), "0 POST /stop for R").toHaveLength(0);
    everyStopReReadActivity(h);
    await claimGetsWarm(h, r);
  });

  it("RED-3 no double refill: two events 50 ms apart while R is creating make ONE create and ONE claim-index entry", async () => {
    const h = await harness("red3");
    const s1 = await seed(h);
    const stoppedAt = await idleStop(h, s1);
    await advance(stoppedAt + TICK_MS - 1_000 - Date.now());
    const first = h.emit("issue.created");
    await advance(50);
    const second = h.emit("agent.run.started");
    await settle(Promise.all([first, second]));
    await advance(4 * TICK_MS);
    const r = onlyRefill(h, s1);
    expect(h.boat.stopsFor(r), "0 POST /stop for R").toHaveLength(0);
    everyStopReReadActivity(h);
    await claimGetsWarm(h, r);
    // ONE claim-index entry: once R is claimed nothing else is warm.
    const next = await settle(h.acquire("run-after-claim"));
    expect(next.providerLeaseId).not.toBe(r);
    expect(h.boat.boxes.get(next.providerLeaseId!)!.labels.purpose, "the next acquire is a cold run create").toBe("run");
  });

  it("CONTROL idle company with no event still idle-stops at spareIdleMinutes", async () => {
    const h = await harness("ctl-idle");
    const s1 = await seed(h);
    const seededAt = Date.now() - 5_000;
    const stoppedAt = await idleStop(h, s1);
    expect(stoppedAt - seededAt).toBeGreaterThan(IDLE_MINUTES * 60_000);
    expect(stoppedAt - seededAt).toBeLessThanOrEqual(IDLE_MINUTES * 60_000 + TICK_MS + 5_000);
    await advance(4 * TICK_MS);
    expect(h.boat.creates(), "no refill without activity").toHaveLength(1);
    expect(h.boat.stopsFor(s1)).toHaveLength(1);
  });

  it("CONTROL an event 1 s after a completed stop makes ONE fresh refill that is not stopped", async () => {
    const h = await harness("ctl-after");
    const s1 = await seed(h);
    const stoppedAt = await idleStop(h, s1);
    await advance(stoppedAt + 1_000 - Date.now());
    await settle(h.emit("issue.created"));
    await advance(4 * TICK_MS);
    const r = onlyRefill(h, s1);
    expect(h.boat.stopsFor(r)).toHaveLength(0);
    expect(h.boat.boxes.get(r)!.state).toBe("ready");
    await claimGetsWarm(h, r);
  });

  it("CONTROL claim storage is touched only by acquire/claim (static call sites and runtime)", async () => {
    const h = await harness("ctl-db");
    const s1 = await seed(h);
    const stoppedAt = await idleStop(h, s1);
    await advance(stoppedAt + TICK_MS - 1_000 - Date.now());
    await settle(Promise.all([h.emit("issue.created"), h.emit("issue.comment.created")]));
    await advance(4 * TICK_MS);
    await settle(h.acquire("run-db"));
    expect(h.dbCalls.length).toBeGreaterThan(0);
    expect(h.dbCalls.every(call => call.inAcquire), JSON.stringify(h.dbCalls)).toBe(true);
    const pluginSource = readFileSync(new URL("./plugin.ts", import.meta.url), "utf8");
    const keeperSource = readFileSync(new URL("./ready-spares.ts", import.meta.url), "utf8");
    const setupStart = pluginSource.indexOf("async setup(ctx)"), setupEnd = pluginSource.indexOf("multiCompanyConfig: true", setupStart);
    const dbSites = [...pluginSource.matchAll(/ctx\.db\b/g)].map(match => match.index!);
    expect(dbSites.length).toBeGreaterThan(0);
    expect(dbSites.every(at => at > setupStart && at < setupEnd), "ctx.db is only handed to the claim store in setup").toBe(true);
    expect(pluginSource.match(/\.reserve\(|\.execute\(/g), "plugin.ts never queries claim storage directly").toBeNull();
    const reserveSites = [...keeperSource.matchAll(/claimStore\.reserve\(/g)].map(match => match.index!);
    expect(reserveSites).toHaveLength(1);
    const claimStart = keeperSource.indexOf("async claimWithOutcome(");
    const claimEnd = keeperSource.indexOf("\n  async ", claimStart + 1);
    expect(reserveSites[0] > claimStart && reserveSites[0] < claimEnd, "the only claim-store query is inside claimWithOutcome").toBe(true);
    expect(keeperSource.match(/db\.execute\(/g), "one SQL statement: the claim reserve").toHaveLength(1);
  });
});
