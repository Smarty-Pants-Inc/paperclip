// Spare create cap (smarty-dev#20869): the independent judge's probes RED-COST,
// RED-FAILED, RED-STATUS, RED-REFUSAL and its restart CONTROL, kept as
// permanent tests, plus the hire-probe and ceiling REDs. They drive the
// plugin's REAL hooks, event handlers, keeper and claim store against the
// wake-race STATEFUL fake Boat on one fake clock (Boat create latency, the
// plugin's own polls and the 15 s maintenance interval).
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
import { ReadySpareKeeper } from "./ready-spares.js";

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
  warnings: string[]; state: Map<string, unknown>; config: Record<string, unknown> };

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

async function harness(name: string, spareMax = 3, extraConfig: Record<string, unknown> = {}): Promise<Harness> {
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
  const instanceConfig: Record<string, unknown> = { spares: 1, spareMax, spareDemandWindowMinutes: 10, spareEnvironmentIds: [env], spareIdleMinutes: IDLE_MINUTES, ...extraConfig };
  const warn = (message: string) => { warnings.push(message); boat.record({ kind: "warn", note: message }); };
  await plugin.definition.setup({
    config: { get: async () => instanceConfig },
    logger: { info: vi.fn((message, meta) => boat.record({ kind: "event", note: `info: ${message}`, value: meta })), warn: vi.fn(warn), error: vi.fn(warn), debug: vi.fn((message) => boat.record({ kind: "event", note: `debug: ${message}` })) },
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
    name, boat, company, env, dbCalls, warnings, state, config: instanceConfig,
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


// Independent judge probes; borrowed only the existing stateful Boat/hook harness.
// No repository source or existing assertion is modified.
function liveUnclaimed(h: Harness): Box[] {
  return [...h.boat.boxes.values()].map(box => h.boat.observe(box)).filter(box =>
    box.labels.purpose === "spare" && box.state !== "archived" && !box.name.startsWith("paperclip-claim:"));
}
async function release(h: Harness, id: string) {
  return await settle(plugin.definition.onEnvironmentReleaseLease!({driverKey: "boat", companyId: h.company,
    environmentId: h.env, providerLeaseId: id, config: baseConfig} as any));
}
describe("Independent spare-cap cost and visibility judge", () => {
  it("RED-COST immediate claim/archive loop must retain an hourly cost bound", async () => {
    const h = await harness("judge-release-loop", 1);
    await seed(h);
    const startedAt = Date.now();
    for (let n = 0; n < 30; n++) {
      const lease = await settle(h.acquire(`release-loop-${n}`));
      expect(lease.providerLeaseId).toBeTruthy();
      await release(h, lease.providerLeaseId!);
      await advance(5_000);
    }
    const observed = { spareCreates: h.boat.creates().length, runCreates: h.boat.creates("run").length,
      archivedClaimed: [...h.boat.boxes.values()].filter(b => b.state === "archived" && b.name.startsWith("paperclip-claim:")).length,
      liveUnclaimed: liveUnclaimed(h).length, elapsedMs: Date.now()-startedAt };
    h.boat.record({kind: "event", note: "JUDGE-COST", value: observed});
    // Safety oracle requested by the brief; this is intentionally RED if successful
    // short-lived claims exempt every archived box, allowing continued churn.
    expect(observed.spareCreates, JSON.stringify(observed)).toBeLessThanOrEqual(12);
  });
  it("RED-FAILED durable rename with failed verification must not launder all churn quota", async () => {
    const h = await harness("judge-failed-claims", 1);
    await seed(h);
    const startedAt = Date.now();
    let failedVerifications = 0;
    for (let n = 0; n < 20; n++) {
      const candidate = liveUnclaimed(h)[0];
      if (!candidate) break;
      let injected = false;
      h.boat.beforeRequest = async (method, route, id) => {
        if (!injected && method === "GET" && id === candidate.id && route === `/sandboxes/${id}`
            && candidate.name.startsWith("paperclip-claim:")) {
          injected = true;
          failedVerifications++;
          throw new Error("judge: lost verification after provider renamed the box");
        }
      };
      const fallback = await settle(h.acquire(`failed-verification-${n}`));
      h.boat.beforeRequest = undefined;
      expect(fallback.providerLeaseId).not.toBe(candidate.id);
      await release(h, candidate.id);
      await release(h, fallback.providerLeaseId!);
      await advance(5_000);
    }
    const observed = { spareCreates: h.boat.creates().length, runCreates: h.boat.creates("run").length,
      failedVerifications, elapsedMs: Date.now()-startedAt };
    h.boat.record({kind: "event", note: "JUDGE-FAILED", value: observed});
    expect(observed.spareCreates, JSON.stringify(observed)).toBeLessThanOrEqual(12);
  });
  it("RED-STATUS capped reason must be visible in the standard health response", async () => {
    const h = await harness("judge-capped-health", 1);
    await seed(h);
    for (let n=0; n<12; n++) {
      const [spare] = liveUnclaimed(h);
      expect(spare).toBeDefined();
      spare.state = "archived";
      await settle(h.emit("issue.created"));
      await advance(4_000);
    }
    await settle(h.acquire("after-churn"));
    await advance(5_000);
    const health = await settle(plugin.definition.onHealth!());
    const outcomes = h.state.get(`${h.company}:acquire-outcomes`);
    h.boat.record({kind:"event",note:"JUDGE-STATUS",value:{health,outcomes}});
    expect(JSON.stringify(health)).toContain("create_capped");
  });
  it("RED-REFUSAL background admission refusal must emit a named operator diagnostic", async () => {
    const h = await harness("judge-background-refusal", 1);
    await seed(h);
    for (let n=0; n<12; n++) {
      const [spare] = liveUnclaimed(h);
      expect(spare).toBeDefined();
      spare.state = "archived";
      await settle(h.emit("issue.created"));
      await advance(4_000);
    }
    const outcomes = h.state.get(`${h.company}:acquire-outcomes`);
    const namedLogs = h.boat.log.filter(e => (e.note ?? "").includes("create_capped"));
    const observed = {spareCreates:h.boat.creates().length,namedLogs:namedLogs.length,outcomes};
    h.boat.record({kind:"event",note:"JUDGE-REFUSAL",value:observed});
    expect(namedLogs.length, JSON.stringify(observed)).toBeGreaterThan(0);
  });
  it("CONTROL crash/restart before claim retains the durable unclaimed-create quota", async () => {
    const h = await harness("judge-restart", 1);
    await seed(h);
    for (let n=0; n<11; n++) {
      const [spare] = liveUnclaimed(h);
      expect(spare).toBeDefined();
      spare.state = "archived";
      await settle(h.emit("issue.created"));
      await advance(4_000);
    }
    expect(h.boat.creates()).toHaveLength(12);
    liveUnclaimed(h)[0].state = "archived";
    // All worker-local state is discarded. Retain only the durable provider
    // rows and the company configuration; none of these boxes was claimed.
    await settle(Promise.resolve(plugin.definition.onShutdown?.()));
    const instanceConfig = {spares:1,spareMax:1,spareEnvironmentIds:[h.env],spareIdleMinutes:IDLE_MINUTES};
    await plugin.definition.setup({config:{get:async()=>instanceConfig},
      logger:{info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()},
      db:{namespace:"boat_sandbox_provider",execute:async()=>({rowCount:1})},
      events:{on:(type:string,_filter:unknown,handler:(e:unknown)=>Promise<void>)=>{
        eventHandlers.set(type,handler);return ()=>eventHandlers.delete(type);
      }},
      state:{get:async(k:any)=>h.state.get(`${k.scopeId}:${k.stateKey}`)??null,
        set:async(k:any,v:unknown)=>{h.state.set(`${k.scopeId}:${k.stateKey}`,v);}},
    } as any);
    await plugin.definition.onConfigChanged!(instanceConfig,{companyId:h.company} as any);
    await settle(h.acquire("after-restart"));
    await advance(5_000);
    expect(h.boat.creates()).toHaveLength(12);
    h.boat.record({kind:"event",note:"JUDGE-RESTART",value:{spareCreates:h.boat.creates().length,runCreates:h.boat.creates("run").length}});
  });
});

// smarty-dev#20869 REDs beyond the judge's probes. A claimed spare whose run
// reached a step on it is USED: its replacement is not churn. The hourly
// ceiling counts every create but refuses only spares (RFL ruling A).
// Keep: recorded #20869 failure path -- refusing a person's run at the ceiling
// becomes Core's non-transient lease_acquire_failed, leaving it unanswered.
async function execute(h: Harness, id: string, command = "true") {
  return await settle(plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: h.company, environmentId: h.env,
    lease: { providerLeaseId: id, metadata: {} }, command, args: [], config: baseConfig } as any));
}
function cappedEvents(h: Harness, reason?: "churn_cap" | "ceiling"): LogEntry[] {
  return h.boat.log.filter(e => (e.note ?? "").startsWith("info: ") && (e.note ?? "").includes("create_capped")
    && (reason === undefined || (e.value as { reason?: string } | undefined)?.reason === reason));
}
/** Reach 6 creates using real acquire/execute/release hooks, then consume the
 * last warm spare. Its refill is refused: the next acquire must create a run. */
async function reachCeiling(h: Harness): Promise<void> {
  await seed(h);
  for (let n = 0; n < 5; n++) {
    const lease = await settle(h.acquire(`ceiling-used-${n}`));
    expect(h.boat.boxes.get(lease.providerLeaseId!)?.labels.purpose).toBe("spare");
    await execute(h, lease.providerLeaseId!);
    await advance(20_000);
    await release(h, lease.providerLeaseId!);
    await advance(2_000);
  }
  expect(h.boat.creates().length + h.boat.creates("run").length).toBe(6);
  expect(liveUnclaimed(h)).toHaveLength(0);
}
describe("Spare create cap: proof of use, refusal event and hourly ceiling", () => {
  it("RED-HIRE a real short hire probe (claimed, used, released in ~20 s) is not counted as churn", async () => {
    const h = await harness("hire-probe", 1);
    await seed(h);
    const runCreatesAfterSeed = h.boat.creates("run").length;
    for (let n = 0; n < 20; n++) {
      const lease = await settle(h.acquire(`hire-probe-${n}`));
      const box = h.boat.boxes.get(lease.providerLeaseId!);
      expect(box?.labels.purpose, `hire probe ${n} claims a warm spare`).toBe("spare");
      // The probe step: Core runs a command on the box the run's acquire bound.
      expect((await execute(h, box!.id, "pi --version")).exitCode).toBe(0);
      await advance(20_000);
      await release(h, box!.id);
      await advance(2_000);
    }
    const observed = { spareCreates: h.boat.creates().length, runCreates: h.boat.creates("run").length - runCreatesAfterSeed,
      cappedEvents: cappedEvents(h).length };
    h.boat.record({ kind: "event", note: "HIRE-PROBE", value: observed });
    // Seed plus one replacement per used claim; no cold fallback, no refusal.
    expect(observed, JSON.stringify(observed)).toEqual({ spareCreates: 21, runCreates: 0, cappedEvents: 0 });
  });

  it("EVENT the churn-cap refusal is an info-level named event with company, environment, reason and counts", async () => {
    const h = await harness("refusal-event", 1);
    await seed(h);
    for (let n = 0; n < 12; n++) {
      const [spare] = liveUnclaimed(h);
      expect(spare).toBeDefined();
      spare.state = "archived";
      await settle(h.emit("issue.created"));
      await advance(4_000);
    }
    expect(h.boat.creates()).toHaveLength(12);
    const [event] = cappedEvents(h, "churn_cap");
    expect(event, "an info-level create_capped event at the refusal").toBeDefined();
    expect(event.value).toMatchObject({ companyId: h.company, environmentId: h.env, reason: "churn_cap",
      churnCreates: 12, churnCap: 12, ceiling: 90 });
    expect(event.value).toHaveProperty("allCreates");
    expect(event.value).toHaveProperty("refusals");
  });

  it("CEILING-RUN a RUN create at the hourly ceiling returns a lease, reports kind=run and degrades health", async () => {
    const h = await harness("ceiling-run", 1, { createCeilingPerHour: 6 });
    await reachCeiling(h);
    const before = h.boat.creates("run").length;
    const lease = await settle(h.acquire("over-ceiling"));
    expect(lease.providerLeaseId).toBeTruthy();
    expect(h.boat.boxes.get(lease.providerLeaseId!)?.labels.purpose).toBe("run");
    expect(h.boat.creates("run")).toHaveLength(before + 1);
    const [event] = cappedEvents(h, "ceiling").filter(e => (e.value as { kind?: string }).kind === "run");
    expect(event, "info-level create_capped event for the admitted run").toBeDefined();
    expect(event.value).toMatchObject({ companyId: h.company, environmentId: h.env, kind: "run", reason: "ceiling",
      allCreates: 6, spareCreates: 5, runCreates: 1, ceiling: 6 });
    const health = await settle(plugin.definition.onHealth!());
    expect(health.status).toBe("degraded");
    expect(health.message).toMatch(/create_capped.*ceiling/);
    expect(health.details).toMatchObject({ createCapped: expect.arrayContaining([
      expect.objectContaining({ kind: "run", reason: "ceiling", companyId: h.company, environmentId: h.env })
    ]) });
    const firstRefusals = (health.details as any).createRefusals.ceiling;
    expect(firstRefusals).toBeGreaterThan(0);
    // Counts include admitted over-ceiling runs too. Wait out log suppression
    // so the next run event exposes the updated ledger and counter.
    await advance(61_000);
    const next = await settle(h.acquire("further-over-ceiling"));
    expect(next.providerLeaseId).toBeTruthy();
    expect(h.boat.creates("run")).toHaveLength(before + 2);
    const last = cappedEvents(h, "ceiling").filter(e => (e.value as { kind?: string }).kind === "run").at(-1)!;
    expect(last.value).toMatchObject({ allCreates: 7, spareCreates: 5, runCreates: 2, ceiling: 6,
      refusals: { ceiling: expect.any(Number) } });
    expect((last.value as any).refusals.ceiling).toBeGreaterThan(firstRefusals);
    h.boat.record({ kind: "event", note: "RULING-A-RUN", value: { lease, next, event: event.value, last: last.value, health } });
  });

  it("CEILING-SPARE the same hourly ceiling refuses a SPARE with reason=ceiling and kind=spare", async () => {
    const h = await harness("ceiling-spare", 1, { createCeilingPerHour: 6 });
    await reachCeiling(h);
    const spareCreates = h.boat.creates().length;
    await settle(h.emit("issue.created"));
    await advance(5_000);
    expect(h.boat.creates()).toHaveLength(spareCreates);
    const events = cappedEvents(h, "ceiling").filter(e => (e.value as { kind?: string }).kind === "spare");
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)!.value).toMatchObject({ companyId: h.company, environmentId: h.env,
      kind: "spare", reason: "ceiling", ceiling: 6, allCreates: 6 });
    h.boat.record({ kind: "event", note: "RULING-A-SPARE", value: { spareCreates, event: events.at(-1)!.value } });
  });
});

// Review-fleet-2 judge of 7cb44662 (smarty-dev#20869), kept as permanent tests.
// F1 (loop v): the hour's RUN creates must survive a worker restart. F2: a
// cold/unbound execute earns no credit, and runs alone can fill the ceiling.
const boatCreatesBefore = (h: Harness, seq = Number.POSITIVE_INFINITY) =>
  h.boat.log.filter(e => e.kind === "boat" && e.method === "POST" && e.path === "/sandboxes" && e.seq < seq).length;
const kindOf = (e: LogEntry) => (e.value as { kind?: string } | undefined)?.kind;
/** The judge's rapid loop: claim, one trivial execute, release; until Boat holds `until` creates. */
async function rapidUseUntil(h: Harness, prefix: string, until: number, maxLoops = 40): Promise<{ loops: number; warm: number }> {
  let loops = 0, warm = 0;
  while (boatCreatesBefore(h) < until && loops < maxLoops) {
    const lease = await settle(h.acquire(`${prefix}-${loops}`));
    expect(lease.providerLeaseId, "every run gets a lease (ruling A)").toBeTruthy();
    if (h.boat.boxes.get(lease.providerLeaseId!)?.labels.purpose === "spare") warm++;
    expect((await execute(h, lease.providerLeaseId!)).exitCode).toBe(0);
    await release(h, lease.providerLeaseId!);
    loops++;
  }
  return { loops, warm };
}
/** All worker-local state is discarded; only Boat's rows and the company config remain. */
async function restartWorker(h: Harness): Promise<void> {
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  eventHandlers.clear();
  await plugin.definition.setup({ config: { get: async () => h.config },
    logger: { info: vi.fn((message, meta) => h.boat.record({ kind: "event", note: `info: ${message}`, value: meta })),
      warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db: { namespace: "boat_sandbox_provider", execute: async () => ({ rowCount: 1 }) },
    events: { on: (type: string, _filter: unknown, handler: (event: unknown) => Promise<void>) => {
      eventHandlers.set(type, handler); return () => eventHandlers.delete(type);
    } },
    state: { get: async (k: any) => h.state.get(`${k.scopeId}:${k.stateKey}`) ?? null,
      set: async (k: any, value: unknown) => { h.state.set(`${k.scopeId}:${k.stateKey}`, value); } },
  } as any);
  await plugin.definition.onConfigChanged!(h.config, { companyId: h.company } as any);
}
describe("Judge F1/F2: the all-create count survives a restart; unbound use and run-heavy hours", () => {
  it("RESTART-CEILING after a worker restart the counted total equals Boat's creates, the run alarm fires and a spare is refused", async () => {
    const CEILING = 8;
    const h = await harness("restart-ceiling", 1, { createCeilingPerHour: CEILING });
    await seed(h);
    const beforeRestart = await rapidUseUntil(h, "before-restart", CEILING + 3);
    const atRestart = { spare: h.boat.creates().length, run: h.boat.creates("run").length, total: boatCreatesBefore(h) };
    expect(atRestart.total).toBeGreaterThanOrEqual(CEILING + 3);
    expect(atRestart.run, "past the ceiling the loop runs cold").toBeGreaterThan(1);
    await restartWorker(h);
    const restartSeq = h.boat.record({ kind: "event", note: "WORKER-RESTARTED" }).seq;
    const afterRestart = await rapidUseUntil(h, "after-restart", atRestart.total + 3);
    await advance(5_000);
    const after = (e: LogEntry) => e.seq > restartSeq;
    const runEvents = cappedEvents(h, "ceiling").filter(e => after(e) && kindOf(e) === "run");
    const spareEvents = cappedEvents(h, "ceiling").filter(e => after(e) && kindOf(e) === "spare");
    const observed = { beforeRestart, atRestart, afterRestart, boatTotal: boatCreatesBefore(h),
      runEvents: runEvents.map(e => ({ allCreates: (e.value as any).allCreates, boatCreatesBefore: boatCreatesBefore(h, e.seq) })),
      spareEvents: spareEvents.map(e => ({ allCreates: (e.value as any).allCreates, boatCreatesBefore: boatCreatesBefore(h, e.seq), source: (e.value as any).source })),
      sparePostsAfterRestart: h.boat.creates().filter(after).length };
    h.boat.record({ kind: "event", note: "RESTART-CEILING", value: observed });
    // Runs are still admitted (ruling A), and each is counted on top of Boat's hour.
    expect(h.boat.creates("run").length, JSON.stringify(observed)).toBeGreaterThan(atRestart.run);
    expect(runEvents.length, `the over-ceiling run alarm fires after the restart: ${JSON.stringify(observed)}`).toBeGreaterThan(0);
    expect(runEvents[0].value).toMatchObject({ companyId: h.company, environmentId: h.env, kind: "run", reason: "ceiling", ceiling: CEILING });
    // Each alarm's count is Boat's actual creates at that moment, the hour's
    // creates from before the restart included.
    for (const event of observed.runEvents) expect(event.allCreates, JSON.stringify(observed)).toBe(event.boatCreatesBefore);
    expect(observed.runEvents[0].allCreates).toBeGreaterThan(atRestart.total - 1);
    expect(spareEvents.length, `a spare create is refused at the ceiling after the restart: ${JSON.stringify(observed)}`).toBeGreaterThan(0);
    for (const event of observed.spareEvents) expect(event.allCreates, JSON.stringify(observed)).toBe(event.boatCreatesBefore);
    expect(observed.sparePostsAfterRestart, JSON.stringify(observed)).toBe(0);
    const health = await settle(plugin.definition.onHealth!());
    expect(health.status).toBe("degraded");
    expect(health.details).toMatchObject({ createCapped: expect.arrayContaining([
      expect.objectContaining({ kind: "run", reason: "ceiling", companyId: h.company, ceiling: CEILING }),
    ]) });
  });

  it("CREDIT-UNBOUND a cold run box's execute earns no proof-of-use credit; a bound hire earns exactly one despite repeats", async () => {
    const original = ReadySpareKeeper.prototype.markUsed;
    const calls: Array<{ company: string; id: string; credited: boolean }> = [];
    const spy = vi.spyOn(ReadySpareKeeper.prototype, "markUsed").mockImplementation(function (this: ReadySpareKeeper, company, id) {
      const credited = original.call(this, company, id); calls.push({ company, id, credited }); return credited;
    });
    try {
      const h = await harness("unbound-credit", 1);
      await seed(h);
      // The seed's cold run box was never a claimed spare: a step on it is not use.
      const cold = [...h.boat.boxes.values()].find(box => box.labels.purpose === "run")!;
      expect((await execute(h, cold.id)).exitCode).toBe(0);
      expect(calls, "an unbound/cold execute never reaches the credit ledger").toHaveLength(0);
      const lease = await settle(h.acquire("bound-hire"));
      expect(h.boat.boxes.get(lease.providerLeaseId!)!.labels.purpose).toBe("spare");
      await execute(h, lease.providerLeaseId!); await execute(h, lease.providerLeaseId!);
      await advance(20_000); await release(h, lease.providerLeaseId!); await advance(5_000);
      expect(calls).toEqual([{ company: h.company, id: lease.providerLeaseId, credited: true }]);
      expect(h.boat.creates()).toHaveLength(2);
      h.boat.record({ kind: "event", note: "CREDIT-UNBOUND", value: { calls, spareCreates: h.boat.creates().length, runCreates: h.boat.creates("run").length } });
    } finally { spy.mockRestore(); }
  });

  it("CEILING-RUN-HEAVY run creates alone fill the ceiling: the next run alarms kind=run, then a spare is refused", async () => {
    const CEILING = 6;
    const h = await harness("ceiling-run-heavy", 1, { createCeilingPerHour: CEILING, spares: 0 });
    for (let n = 0; n < CEILING; n++) {
      const lease = await settle(h.acquire(`run-heavy-${n}`));
      expect(h.boat.boxes.get(lease.providerLeaseId!)?.labels.purpose).toBe("run");
      expect((await execute(h, lease.providerLeaseId!)).exitCode).toBe(0);
      await release(h, lease.providerLeaseId!);
    }
    expect(h.boat.creates()).toHaveLength(0);
    expect(h.boat.creates("run")).toHaveLength(CEILING);
    expect(cappedEvents(h), "under the ceiling nothing alarms").toHaveLength(0);
    const over = await settle(h.acquire("run-heavy-over"));
    expect(over.providerLeaseId, "the over-ceiling run is admitted (ruling A)").toBeTruthy();
    expect(h.boat.creates("run")).toHaveLength(CEILING + 1);
    const runEvents = cappedEvents(h, "ceiling").filter(e => kindOf(e) === "run");
    expect(runEvents, "the run-only hour reaches the ceiling alarm").toHaveLength(1);
    expect(runEvents[0].value).toMatchObject({ companyId: h.company, environmentId: h.env, kind: "run", reason: "ceiling",
      allCreates: CEILING, runCreates: CEILING, spareCreates: 0, ceiling: CEILING });
    const health = await settle(plugin.definition.onHealth!());
    expect(health.status).toBe("degraded");
    // Turn spares on: the next acquire runs cold and the hour the runs filled
    // refuses its spare refill.
    h.config.spares = 1;
    await settle(Promise.resolve(plugin.definition.onConfigChanged!(h.config, { companyId: h.company } as any)));
    const spared = await settle(h.acquire("run-heavy-spares-on"));
    expect(h.boat.boxes.get(spared.providerLeaseId!)?.labels.purpose).toBe("run");
    await advance(5_000);
    expect(h.boat.creates(), "no spare is created above a run-filled ceiling").toHaveLength(0);
    const spareEvents = cappedEvents(h, "ceiling").filter(e => kindOf(e) === "spare");
    expect(spareEvents.length).toBeGreaterThan(0);
    expect(spareEvents[0].value).toMatchObject({ companyId: h.company, environmentId: h.env, kind: "spare", reason: "ceiling",
      allCreates: CEILING + 2, spareCreates: 0, ceiling: CEILING });
    h.boat.record({ kind: "event", note: "CEILING-RUN-HEAVY", value: { run: runEvents[0].value, spare: spareEvents[0].value, health } });
  });
});
