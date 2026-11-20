import { writeFileSync } from "node:fs";
// Gate-6 supporting regressions. Harness copied from judge-spare6.test.ts:
// real plugin/keeper hooks against stateful fake Boat and retained plugin state.
// New cases model Boat's documented hydrated/hydratedAt fields independently
// of its lifecycle. These rows do not prove a real model's first-word latency.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));

import plugin from "./plugin.js";
import { READY_SPARE_STOP_BACKOFF_MS } from "./ready-spares.js";

const apiKey = "boat_spare_off_test";
const baseConfig = { hydrationWaitSeconds: 0, apiKey, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const IDLE_MINUTES = 15;
const CREATE_LATENCY_MS = 2_000;
const TICK_MS = 15_000;
const START = Date.UTC(2026, 10, 18, 23, 30, 0);

type Box = { id: string; labels: Record<string, string>; name: string; state: string;
  hydrated: boolean; hydratedAt: string | null; hydrateAt: number;
  readyAt: number; archiveAfter: string; createdAt: string; team: { id: string }; stop?: { id: string; status: string } };
type LogEntry = { seq: number; at: number; kind: "boat" | "event" | "mark"; method?: string; path?: string; id?: string; purpose?: string; configHash?: string; note?: string; idleSpares?: number; force?: boolean };
type Hold = { method: string; path: RegExp; hit: boolean; released: boolean; release(): void; wait: Promise<void> };

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeBoat {
  readonly boxes = new Map<string, Box>();
  readonly log: LogEntry[] = [];
  readonly holds: Hold[] = [];
  private seq = 0;
  private counter = 0;

  record(entry: Omit<LogEntry, "seq" | "at">): LogEntry {
    const full = { seq: ++this.seq, at: Date.now(), ...entry };
    this.log.push(full);
    return full;
  }
  mark(note: string): number { return this.record({ kind: "mark", note }).seq; }
  observe(box: Box): Box {
    if (box.state === "creating" && Date.now() >= box.readyAt) box.state = "ready";
    if (!box.hydrated && Date.now() >= box.hydrateAt) { box.hydrated = true; box.hydratedAt = new Date(box.hydrateAt).toISOString(); }
    return box;
  }
  /** Hold the next matching request until released (a Boat call in flight). */
  hold(method: string, path: RegExp): Hold {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const hold: Hold = { method, path, hit: false, released: false, wait, release: () => { hold.released = true; release(); } };
    this.holds.push(hold);
    return hold;
  }
  spareCreates(afterSeq = 0) { return this.log.filter(e => e.kind === "boat" && e.method === "POST" && e.path === "/sandboxes" && e.purpose === "spare" && e.seq > afterSeq); }
  spareIds() { return [...this.boxes.values()].filter(box => box.labels.purpose === "spare").map(box => box.id); }
  /** Unclaimed spare boxes still running at Boat (a claimed spare is renamed paperclip-claim:... and is a run's box). */
  liveSpares() { return this.spareIds().filter(id => this.boxes.get(id)!.state !== "archived" && !this.boxes.get(id)!.name.startsWith("paperclip-claim:")); }

  readonly fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const route = url.pathname.replace("/api/v1", "");
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const id = /^\/sandboxes\/([^/]+)/.exec(route)?.[1];
    const hold = this.holds.find(h => !h.hit && h.method === method && h.path.test(route));
    if (hold) { hold.hit = true; await hold.wait; }
    if (method === "POST" && route === "/sandboxes") {
      const purpose = body.labels.purpose === "spare" ? "spare" : "run";
      const box: Box = { id: `bx_${purpose}${String(++this.counter).padStart(4, "0")}`, labels: { ...body.labels }, name: "",
        hydrated: false, hydratedAt: null, hydrateAt: Date.now() + CREATE_LATENCY_MS,
        state: "creating", readyAt: Date.now() + CREATE_LATENCY_MS,
        archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), createdAt: new Date().toISOString(), team: { id: "team-spare-off" } };
      this.boxes.set(box.id, box);
      this.record({ kind: "boat", method, path: route, id: box.id, purpose, configHash: body.labels.configHash, idleSpares: this.liveSpares().length });
      return response({ sandbox: { ...box } }, 202);
    }
    this.record({ kind: "boat", method, path: route, ...(id ? { id } : {}), ...(route.endsWith("/stop") ? { force: body?.force === true } : {}) });
    if (method === "GET" && route === "/sandboxes") {
      const labels = url.searchParams.getAll("label").map(label => label.split("="));
      const matching = [...this.boxes.values()].map(box => this.observe(box))
        .filter(box => labels.every(([key, ...rest]) => box.labels[key] === rest.join("=")));
      return response({ sandboxes: matching.map(box => ({ ...box })), pageInfo: { nextCursor: null } });
    }
    const box = id ? this.boxes.get(id) : undefined;
    if (id && !box) return response({ error: "not_found" }, 404);
    if (method === "POST" && box && route.endsWith("/stop")) {
      box.state = "archived"; box.stop = { id: `stop_${box.id}`, status: "completed" };
      return response({ stop: { id: `stop_${box.id}`, status: "pending" } }, 202);
    }
    if (method === "POST" && box && route.endsWith("/resume")) { box.state = "ready"; return response({ sandbox: { ...box } }, 202); }
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
    return response({ error: "unsupported_in_fake" }, 400);
  };
}

type SpareConfig = { spares?: number; spareMax?: number; spareDemandWindowMinutes?: number; spareEnvironmentIds?: string[]; spareIdleMinutes?: number };
type Harness = {
  boat: FakeBoat; company: string; env: string; config: SpareConfig; state: Map<string, unknown>;
  /** A second company whose spares stay on (its pool keeps maintenance running). */
  otherCompany: string; otherEnv: string; acquireOther(runId: string): Promise<{ providerLeaseId: string | null }>;
  configChanged(): Promise<void>;
  failStopStateWrite?: boolean;
  failActivityRead?: boolean;
  activityReadFailures?: number;
  activityReadHook?: () => Promise<void>;
  configReadHook?: (companyId?: string) => Promise<Record<string, unknown>>;
  restart(deliverConfig: boolean): Promise<void>;
  emit(eventType: string): Promise<void>;
  acquire(runId: string, config?: Record<string, unknown>): Promise<{ providerLeaseId: string | null }>;
};

const eventHandlers = new Map<string, (event: unknown) => Promise<void>>();
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function settle<T>(promise: Promise<T>, stepMs = 100, limitMs = 300_000): Promise<T> {
  let done = false, value: T | undefined, error: unknown, failed = false;
  void promise.then(v => { done = true; value = v; }, e => { done = true; failed = true; error = e; });
  for (let waited = 0; !done && waited < limitMs; waited += stepMs) await advance(stepMs);
  if (!done) throw new Error("operation did not settle on the fake clock");
  if (failed) throw error;
  return value as T;
}
async function until(check: () => boolean, label: string, stepMs = 10, limitMs = 60_000): Promise<void> {
  for (let waited = 0; !check(); waited += stepMs) {
    if (waited >= limitMs) throw new Error(`never reached: ${label}`);
    await advance(stepMs);
  }
}

async function harness(name: string): Promise<Harness> {
  const boat = new FakeBoat();
  vi.stubGlobal("fetch", boat.fetch);
  const company = `company-${name}`, env = `environment-${name}`;
  const state = new Map<string, unknown>();
  const claims = new Set<string>();
  const db = { namespace: "boat_sandbox_provider", execute: async (_sql: string, params: unknown[] = []) => {
    if (claims.has(String(params[0]))) return { rowCount: 0 };
    claims.add(String(params[0]));
    return { rowCount: 1 };
  } };
  const config: SpareConfig = { spares: 1, spareMax: 3, spareDemandWindowMinutes: 10, spareEnvironmentIds: [env], spareIdleMinutes: IDLE_MINUTES };
  const otherCompany = `other-${name}`, otherEnv = `other-environment-${name}`;
  const otherConfig: SpareConfig = { ...config, spareEnvironmentIds: [otherEnv] };
  const ctx = {
    config: { get: async (companyId?: string) => h.configReadHook ? h.configReadHook(companyId) : companyId === otherCompany ? { ...otherConfig } : { ...config } },
    logger: { info: vi.fn((message, details) => { if (message === "boat.acquire.phases") boat.mark(`phase ${JSON.stringify(details)}`); }), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db,
    events: { on: (eventType: string, _filter: unknown, handler: (event: unknown) => Promise<void>) => {
      eventHandlers.set(eventType, handler);
      return () => eventHandlers.delete(eventType);
    } },
    state: {
      get: async (key: { scopeId?: string; stateKey: string }) => { if (key.stateKey === "company-activity") await h.activityReadHook?.(); if (h.failActivityRead && key.stateKey === "company-activity") { h.activityReadFailures = (h.activityReadFailures ?? 0) + 1; throw new Error("JUDGE injected activity read rejection"); } return state.get(`${key.scopeId}:${key.stateKey}`) ?? null; },
      set: async (key: { scopeId?: string; stateKey: string }, value: unknown) => { if (h.failStopStateWrite && key.stateKey === "stop-owed") throw new Error("injected state.set outage"); state.set(`${key.scopeId}:${key.stateKey}`, structuredClone(value)); },
    },
  };
  await plugin.definition.setup(ctx as any);
  const h: Harness = {
    boat, company, env, config, state, otherCompany, otherEnv,
    acquireOther(runId) {
      return plugin.definition.onEnvironmentAcquireLease!({ driverKey: "boat", companyId: otherCompany, environmentId: otherEnv, runId,
        creationOperationId: `attempt-${runId}`, config: baseConfig } as any) as Promise<{ providerLeaseId: string | null }>;
    },
    configChanged: () => plugin.definition.onConfigChanged!({ ...config }, { companyId: company } as any) as Promise<void>,
    async restart(deliverConfig) {
      boat.mark("worker restart");
      await settle(Promise.resolve(plugin.definition.onShutdown?.()));
      eventHandlers.clear();
      await plugin.definition.setup(ctx as any);
      if (deliverConfig) await settle(h.configChanged());
    },
    emit(eventType) {
      const handler = eventHandlers.get(eventType);
      if (!handler) throw new Error(`no handler for ${eventType}`);
      boat.record({ kind: "event", note: eventType });
      return handler({ eventId: `${eventType}-${Date.now()}`, eventType, companyId: company, occurredAt: new Date().toISOString() });
    },
    acquire(runId, leaseConfig = baseConfig) {
      return plugin.definition.onEnvironmentAcquireLease!({ driverKey: "boat", companyId: company, environmentId: env, runId,
        creationOperationId: `attempt-${runId}`, config: leaseConfig } as any) as Promise<{ providerLeaseId: string | null }>;
    },
  };
  await settle(h.configChanged());
  return h;
}

/** One cold run lease teaches the plugin the pool; spare S1 becomes ready. Returns S1 and the run box. */
async function seed(h: Harness): Promise<{ s1: string; run: string }> {
  const lease = await settle(h.acquire("run-seed"));
  await advance(5_000);
  const spares = h.boat.liveSpares();
  expect(spares).toHaveLength(1);
  expect(h.boat.boxes.get(spares[0])!.name).toMatch(/^paperclip-spare:ready:/);
  return { s1: spares[0], run: lease.providerLeaseId! };
}

type OffPath = "config" | "acquire-planted" | "removal-config" | "removal-acquire-planted";
/**
 * Turn spares off. "config": the real path, the host delivers onConfigChanged
 * with spares 0. "acquire-planted": planted, the company setting reads 0 with
 * no onConfigChanged delivered; a run acquire is the real reader. "removal-*":
 * the spares key is deleted (not set to 0), delivered the same two ways.
 */
async function turnOff(h: Harness, path: OffPath): Promise<number> {
  if (path.startsWith("removal")) delete h.config.spares;
  else h.config.spares = 0;
  const offAt = h.boat.mark(`spares off by ${path}`);
  if (path === "config" || path === "removal-config") await settle(h.configChanged());
  else {
    const lease = await settle(h.acquire(`run-off-${path}`));
    expect(h.boat.boxes.get(lease.providerLeaseId!)!.labels.purpose, "spares off: the run is a cold create").toBe("run");
  }
  await advance(5_000);
  return offAt;
}

type Wake = "acquire" | "resume" | "release" | "health" | "timer" | "issue.comment.created" | "agent.run.started" | "issue.created";
const WAKES: Wake[] = ["acquire", "resume", "release", "health", "timer", "issue.comment.created", "agent.run.started", "issue.created"];
const leaseParams = (h: Harness, providerLeaseId: string | null) => ({ driverKey: "boat", companyId: h.company, environmentId: h.env, config: baseConfig, providerLeaseId });

/** Drive one real wake path (acquire ~:1838, resume ~:2025, release ~:2115, maintainReadySpares via onHealth and the 15 s timer, the activity events). */
async function wake(h: Harness, path: Wake, runBox: string): Promise<void> {
  h.boat.mark(`wake ${path}`);
  if (path === "acquire") await settle(h.acquire(`run-wake-${Date.now()}`));
  else if (path === "resume") {
    await settle(Promise.resolve(plugin.definition.onEnvironmentResumeLease!({ ...leaseParams(h, runBox), runId: "run-resume", leaseMetadata: {} } as any)).catch(() => undefined));
  } else if (path === "release") {
    await settle(Promise.resolve(plugin.definition.onEnvironmentReleaseLease!(leaseParams(h, null) as any)).catch(() => undefined));
  } else if (path === "health") await settle(Promise.resolve(plugin.definition.onHealth!()));
  else if (path === "timer") { /* the refresh timer only */ }
  else if (eventHandlers.has(path)) await settle(h.emit(path));
  // else: this worker has no subscription for the event (no onConfigChanged
  // since its start), so that wake path does not exist in it.
  else h.boat.mark(`wake ${path}: no subscription in this worker`);
  await advance(4 * TICK_MS);
}

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(async () => {
  if (current && process.env.JUDGE_TRACE_DIR) writeFileSync(`${process.env.JUDGE_TRACE_DIR}/${current.company}.json`, JSON.stringify({ log: current.boat.log, boxes: [...current.boat.boxes.values()], state: Object.fromEntries(current.state) }, null, 2));
  for (const hold of current?.boat.holds ?? []) hold.release();
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  eventHandlers.clear();
  current = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
let current: Harness | undefined;
async function start(name: string): Promise<Harness> { current = await harness(name); return current; }

// Gate-6 live findings: supporting stateful fake-Boat regressions, NOT live chat qualification.
describe("spare.9 live-findings boundary", () => {
  const params = (h: Harness, runId: string, issueId: string | null) => ({ driverKey: "boat", companyId: h.company,
    environmentId: h.env, config: baseConfig, runId, creationOperationId: `op-${runId}`, issueId });
  const taskAcquire = (h: Harness, runId: string) => plugin.definition.onEnvironmentAcquireLease!(params(h, runId, `task-${runId}`) as any);
  const probeAcquire = (h: Harness, runId: string) => plugin.definition.onEnvironmentAcquireLease!(params(h, runId, null) as any);

  it("FU-A hydrating spare is not claimed; zero hydration wait takes the measured cold path", async () => {
    const h = await start("fu-a"); const { s1 } = await seed(h);
    const box = h.boat.boxes.get(s1)!;
    box.hydrated = false; box.hydratedAt = null; box.hydrateAt = Date.now() + 120_000;
    const at = Date.now(); const mark = h.boat.mark("new chat while only spare is hydrating");
    const lease = await settle(taskAcquire(h, "chat-hydrating"));
    const hydratingColdMs = Date.now() - at;
    expect(lease.providerLeaseId).not.toBe(s1);
    expect(h.boat.log.filter(e => e.seq > mark && e.method === "PATCH" && e.id === s1)).toEqual([]);
    expect(h.boat.boxes.get(s1)!.state).not.toBe("archived");
    // Same real plugin create/readiness/handoff path with spares disabled: comparator, not a made-up first-word timer.
    h.config.spares = 0; await settle(h.configChanged());
    const coldAt = Date.now(); await settle(taskAcquire(h, "cold-control"));
    const coldMs = Date.now() - coldAt;
    expect(hydratingColdMs).toBeLessThanOrEqual(coldMs);
    h.boat.mark(`FU-A phases ${JSON.stringify({ hydratingColdMs, coldMs, hydrationWaitMs: 0 })}`);
  });

  it("FU-A hydrated spare is claimable only after fresh Boat hydration, including after a previous miss", async () => {
    const h = await start("fu-a-later"); const { s1 } = await seed(h);
    const box = h.boat.boxes.get(s1)!;
    box.hydrated = false; box.hydratedAt = null; box.hydrateAt = Date.now() + 30_000;
    expect((await settle(taskAcquire(h, "before-hydration"))).providerLeaseId).not.toBe(s1);
    await advance(30_000);
    expect((await settle(taskAcquire(h, "after-hydration"))).providerLeaseId).toBe(s1);
    expect(h.boat.boxes.get(s1)!.hydrated).toBe(true);
    expect(h.boat.boxes.get(s1)!.hydratedAt).not.toBeNull();
  });

  it("FU-B three no-run probes interleaved with three chats discard zero spares", async () => {
    const h = await start("fu-b"); await seed(h);
    for (let i = 0; i < 3; i++) {
      const [id] = h.boat.liveSpares();
      const probe = await settle(probeAcquire(h, `synthetic-probe-${i}`));
      expect(probe.providerLeaseId).not.toBe(id);
      expect(h.boat.boxes.get(id)!.name).toMatch(/^paperclip-spare:ready:/);
      await settle(plugin.definition.onEnvironmentReleaseLease!({ driverKey: "boat", companyId: h.company,
        environmentId: h.env, config: baseConfig, providerLeaseId: probe.providerLeaseId } as any));
      expect((await settle(taskAcquire(h, `chat-${i}`))).providerLeaseId).toBe(id);
      await advance(5_000);
    }
    const discarded = [...h.boat.boxes.values()].filter(b => b.labels.purpose === "spare" && b.state === "archived");
    expect(discarded).toEqual([]);
    expect(h.boat.spareCreates()).toHaveLength(4);
    h.boat.mark(`FU-B evidence ${JSON.stringify({ probes: 3, chatClaims: 3, spareCreates: 4, sparesDiscarded: discarded.length })}`);
  });

  it("FU-C OFF acquisition teaches effective config; ON dispatches first fill within one 15-second tick, no next chat or health needed", async () => {
    const h = await start("fu-c"); h.config.spares = 0; await settle(h.configChanged());
    await settle(probeAcquire(h, "hire-before-enable"));
    expect(h.boat.spareCreates()).toEqual([]);
    h.config.spares = 1; const onAt = Date.now();
    await settle(h.configChanged()); await advance(TICK_MS);
    const first = h.boat.spareCreates()[0];
    expect(first).toBeDefined();
    expect(first.at - onAt).toBeLessThanOrEqual(TICK_MS);
    expect(h.boat.liveSpares()).toHaveLength(1);
    h.boat.mark(`FU-C evidence ${JSON.stringify({ firstDispatchMs: first.at - onAt, boundMs: TICK_MS })}`);
  });

  it.each([false, true])("F1 saved refill whose warm and cleanup fail is stopped within one tick after OFF, restart=%s", async restart => {
    const h = await start(`f1-${restart}`); let fail = true;
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const box = [...h.boat.boxes.values()].find(b => b.labels.purpose === "spare");
      if (fail && box && path.endsWith(`/sandboxes/${box.id}`) && (init.method ?? "GET") === "GET") return response({ sandbox: { ...box, state: "error" } });
      if (fail && box && path.endsWith(`/sandboxes/${box.id}/stop`)) return response({ error: "injected stop failure" }, 400);
      return h.boat.fetch(input, init);
    });
    await settle(taskAcquire(h, "teach-f1")); await advance(5_000);
    const [id] = h.boat.liveSpares(); expect(id).toBeDefined();
    const stored = h.state.get(`${h.company}:pending-refills`) as Record<string, any[]>;
    expect(Object.values(stored).flat().some(r => r.sandboxId === id)).toBe(true);
    if (restart) await h.restart(false);
    h.config.spares = 0; const at = h.boat.mark("OFF with saved unready refill"); fail = false;
    // As documented by the existing owed-stop path, a fresh worker needs an
    // environment acquire to supply the key; config events have no credentials.
    if (restart) await settle(taskAcquire(h, "off-after-restart"));
    await advance(TICK_MS);
    expect(h.boat.log.filter(e => e.seq > at && e.method === "POST" && e.path === `/sandboxes/${id}/stop`)).toHaveLength(1);
    expect(h.boat.boxes.get(id)!.state).toBe("archived");
    expect((h.state.get(`${h.company}:stop-owed`) as any)?.owed ?? []).toEqual([]);
  });

  // Never-OK money guard: BRIEF ADDED F1b, target CUT while a paid refill is unfinished.
  it("F1b target 3 to 1 stops the saved unwarmed surplus refill within one tick through durable debt", async () => {
    const h = await start("f1b-cut-pending");
    h.config.spares = 3; await settle(h.configChanged());
    await settle(taskAcquire(h, "teach-f1b")); await advance(5_000);
    const initial = h.boat.liveSpares(); expect(initial).toHaveLength(3);
    let refillId: string | undefined;
    let failWarm = true;
    const hasDebt = () => (h.state.get(`${h.company}:stop-owed`) as any)?.owed.some((entry: any) => entry.spareId === refillId);
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname;
      const method = init.method ?? "GET";
      if (!refillId && method === "POST" && path.endsWith("/sandboxes")
          && JSON.parse(String(init.body)).labels.purpose === "spare") {
        const accepted = await h.boat.fetch(input, init);
        const body = await accepted.json(); refillId = body.sandbox.id;
        return response(body, 202);
      }
      if (refillId && path.endsWith(`/sandboxes/${refillId}`) && method === "GET" && failWarm) {
        return response({ sandbox: { ...h.boat.boxes.get(refillId)!, state: "error" } });
      }
      if (refillId && path.endsWith(`/sandboxes/${refillId}/stop`) && method === "POST") {
        if (failWarm) return response({ error: "injected immediate cleanup failure" }, 400);
        expect(hasDebt(), "keeper persists owed-stop before the paid-box stop").toBe(true);
        expect(JSON.parse(String(init.body)).force).not.toBe(true);
      }
      return h.boat.fetch(input, init);
    });
    expect((await settle(taskAcquire(h, "claim-for-f1b"))).providerLeaseId).toBe(initial[0]);
    await until(() => !!refillId, "accepted refill with sandboxId"); await advance(3_000);
    const pending = Object.values(h.state.get(`${h.company}:pending-refills`) as Record<string, any[]>).flat();
    expect(pending.some(entry => entry.sandboxId === refillId)).toBe(true);
    expect(h.boat.boxes.get(refillId!)!.name).toBe("");
    expect(h.boat.liveSpares()).toHaveLength(3);
    h.config.spares = 1; const at = h.boat.mark("target CUT 3 to 1 with saved unwarmed refill");
    const cutAt = Date.now(); failWarm = false;
    await advance(TICK_MS);
    const stops = h.boat.log.filter(e => e.seq > at && e.method === "POST" && e.path === `/sandboxes/${refillId}/stop`);
    expect(stops, "nonzero target must expose a no-longer-admissible paid refill").toHaveLength(1);
    expect(stops[0].at - cutAt).toBeLessThanOrEqual(TICK_MS);
    expect(h.boat.boxes.get(refillId!)!.state).toBe("archived");
    expect(h.boat.liveSpares()).toHaveLength(1);
    expect(h.boat.spareCreates(at)).toHaveLength(0);
    expect(hasDebt()).toBe(false);
  });

  // Never-OK guards from RFL's spare.10 verdict (shipped with the spare.12 BRIEF).
  // The standalone HTTP harness was not shipped; reproduce its held-snapshot and
  // held-activity interleavings here using the real plugin's 15-second timer.
  it.each(["get", "activity"])("RFL claim wins retirement's stale %s; no claimed box stops 4 ms after acquire returns", async boundary => {
    const h = await start(`rfl-race-${boundary}`);
    h.config.spares = 3; await settle(h.configChanged());
    await settle(taskAcquire(h, "rfl-seed")); await advance(5_000);
    const initial = h.boat.liveSpares(); expect(initial).toHaveLength(3);
    const victim = initial[1];
    let hit = false, victimRead = false, released = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = () => { released = true; resolve(); }; });
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      const answer = await h.boat.fetch(input, init);
      if (!victimRead && (init.method ?? "GET") === "GET" && new URL(String(input)).pathname.endsWith(`/sandboxes/${victim}`)) {
        victimRead = true; // Capture the unclaimed response BEFORE letting the claim run.
        if (boundary === "get") { hit = true; await held; }
      }
      if (init.method === "POST" && new URL(String(input)).pathname.endsWith("/stop")) {
        // The provider is unconditional: the plugin, not this fake, must exclude claims.
        expect(h.boat.boxes.get(new URL(String(input)).pathname.split("/").at(-2)!)!.name).not.toMatch(/^paperclip-claim:/);
      }
      return answer;
    });
    h.activityReadHook = async () => { if (victimRead && !released) { if (boundary === "activity") hit = true; await held; } };
    h.config.spares = 1;
    try {
      await until(() => hit, "timer paused with stale unclaimed victim");
      const [first, lease] = await settle(Promise.all([taskAcquire(h, "race-a"), taskAcquire(h, "race-b")]));
      expect(first.providerLeaseId).toBe(initial[0]);
      expect(lease.providerLeaseId).toBe(victim);
      const returned = h.boat.mark("RFL both acquires returned");
      await advance(4); release(); await advance(1_000);
      expect(h.boat.boxes.get(victim)!.name).toMatch(/^paperclip-claim:/);
      expect(h.boat.boxes.get(victim)!.state).not.toBe("archived");
      expect(h.boat.log.filter(e => e.seq > returned && e.method === "POST" && e.path === `/sandboxes/${victim}/stop`)).toEqual([]);
    } finally { if (!released) release(); h.activityReadHook = undefined; }
  });

  it("RFL retirement wins the ownership lock; claim PATCH cannot cross its held provider GET", async () => {
    const h = await start("rfl-stop-lock");
    const { s1: victim } = await seed(h);
    const hash = h.boat.boxes.get(victim)!.labels.configHash;
    await h.restart(false);
    // Retained owed-stop state is a second retirement entry point, without the
    // keeper's transient stoppingSpares set. It MUST share the claim mutex.
    h.state.set(`${h.company}:stop-owed`, { holds: [], owed: [{ environmentId: h.env, configHash: hash, spareId: victim }] });
    let reads = 0, hit = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      const answer = await h.boat.fetch(input, init);
      if ((init.method ?? "GET") === "GET" && new URL(String(input)).pathname.endsWith(`/sandboxes/${victim}`) && ++reads === 2) {
        hit = true; await held; // The ownership read INSIDE retirement's critical section.
      }
      return answer;
    });
    const mark = h.boat.mark("acquire supplies key; owed retirement and claim compete");
    const claim = taskAcquire(h, "lock-b");
    try {
      await until(() => hit && reads >= 3, "retirement holds provider GET; claim has validated victim");
      await advance(4);
      expect(h.boat.log.filter(e => e.seq > mark && e.id === victim && e.method === "PATCH")).toEqual([]);
      release();
      const lease = await settle(claim);
      expect(lease.providerLeaseId).not.toBe(victim);
      expect(h.boat.boxes.get(victim)!.state).toBe("archived");
    } finally { release(); await settle(Promise.resolve(claim).catch(() => undefined)); }
  });

  it.each([1, 3, 0])("RFL all three refills unfinished, target 3 to %s stops exactly surplus in one tick", async target => {
    const h = await start(`rfl-all-pending-${target}`);
    h.config.spares = 3; await settle(h.configChanged());
    let fail = true;
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname, method = init.method ?? "GET";
      const id = /\/sandboxes\/([^/]+)/.exec(path)?.[1];
      const box = id ? h.boat.boxes.get(id) : undefined;
      if (box?.labels.purpose === "spare") {
        if (fail && method === "GET" && path.endsWith(`/sandboxes/${id}`)) return response({ sandbox: { ...box, state: "error" } });
        if (method === "POST" && path.endsWith("/stop")) {
          if (fail) return response({ error: "RFL failed warm and immediate cleanup" }, 400);
          expect((h.state.get(`${h.company}:stop-owed`) as any)?.owed.some((e: any) => e.spareId === id)).toBe(true);
          expect(JSON.parse(String(init.body)).force).not.toBe(true);
        }
      }
      return h.boat.fetch(input, init);
    });
    await settle(taskAcquire(h, "rfl-pending-seed")); await advance(5_000);
    const ids = h.boat.liveSpares(); expect(ids).toHaveLength(3);
    const pending = Object.values(h.state.get(`${h.company}:pending-refills`) as Record<string, any[]>).flat();
    expect(new Set(pending.map(e => e.sandboxId))).toEqual(new Set(ids));
    for (const id of ids) expect(h.boat.boxes.get(id)!.name).toBe("");
    h.config.spares = target; fail = false;
    const mark = h.boat.mark(`RFL all-pending CUT 3 to ${target}`), cutAt = Date.now();
    await advance(TICK_MS);
    const stops = h.boat.log.filter(e => e.seq > mark && e.method === "POST" && e.path?.endsWith("/stop"));
    expect(stops).toHaveLength(3 - target);
    expect(new Set(stops.map(e => e.id)).size).toBe(3 - target);
    for (const stop of stops) expect(stop.at - cutAt).toBeLessThanOrEqual(TICK_MS);
    expect(h.boat.liveSpares()).toHaveLength(target);
    expect(h.boat.spareCreates(mark)).toHaveLength(0);
  });

  it.each(["refused", "expired"])("F2 %s identity cannot starve refill; absent expired identity is forgotten", async kind => {
    const h = await start(`f2-${kind}`); const { s1 } = await seed(h);
    const hash = h.boat.boxes.get(s1)!.labels.configHash;
    const pool = JSON.stringify([h.company, h.env, hash]);
    const id = `old-${kind}`;
    h.state.set(`${h.company}:pending-refills`, { [pool]: [{ id, body: "{}", at: Date.now() - (kind === "expired" ? 86_400_001 : 0), ...(kind === "refused" ? { refused: true } : {}) }] });
    expect((await settle(taskAcquire(h, "consume-for-f2"))).providerLeaseId).toBe(s1);
    await advance(5_000);
    expect(h.boat.liveSpares()).toHaveLength(1);
    const remaining = Object.values(h.state.get(`${h.company}:pending-refills`) as Record<string, any[]>).flat();
    expect(remaining.some(r => r.id === id)).toBe(kind === "refused");
  });

  it("F3 state.set outage never blocks safe OFF stop; failed stop debt survives in memory and retries", async () => {
    const h = await start("f3"); const { s1 } = await seed(h);
    h.failStopStateWrite = true; let refuse = true; let posts = 0;
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      if (init.method === "POST" && new URL(String(input)).pathname.endsWith(`/sandboxes/${s1}/stop`)) {
        posts++; if (refuse) return response({ error: "injected stop refusal" }, 400);
      }
      return h.boat.fetch(input, init);
    });
    h.config.spares = 0; await settle(h.configChanged());
    expect(posts).toBe(1);
    refuse = false;
    // Keep the outage through the retry: neither the owed-before-stop nor the retry may depend on persistence.
    await advance(READY_SPARE_STOP_BACKOFF_MS + 2 * TICK_MS);
    expect(posts).toBe(2);
    expect(h.boat.boxes.get(s1)!.state).toBe("archived");
    h.failStopStateWrite = false;
  });
});

// Hydration is independent of lifecycle/name. Unknown provider evidence fails closed;
// Boat documents true/null for a fresh box that restored no files.
describe("spare.9 hydration evidence safety", () => {
  it.each(["missing", "false-with-old-timestamp", "true-with-no-restore"])("FU-A provider evidence %s", async evidence => {
    const h = await start(`hydration-${evidence}`); const { s1 } = await seed(h);
    const box = h.boat.boxes.get(s1)!;
    if (evidence === "missing") { delete (box as any).hydrated; delete (box as any).hydratedAt; box.hydrateAt = Infinity; }
    if (evidence === "false-with-old-timestamp") { box.hydrated = false; box.hydratedAt = new Date(START).toISOString(); box.hydrateAt = Infinity; }
    if (evidence === "true-with-no-restore") { box.hydrated = true; box.hydratedAt = null; }
    const lease = await settle(h.acquire(`chat-${evidence}`));
    if (evidence === "true-with-no-restore") expect(lease.providerLeaseId).toBe(s1);
    else expect(lease.providerLeaseId).not.toBe(s1);
  });

  it("F2 expired identity with labelled unfinished box finishes that exact box without resending the expired key", async () => {
    const h = await start("f2-expired-box"); const { s1 } = await seed(h);
    const box = h.boat.boxes.get(s1)!; const hash = box.labels.configHash;
    const pendingBox = structuredClone(box); pendingBox.id = "bx_expired_unfinished"; pendingBox.name = "";
    pendingBox.labels["paperclip-refill"] = "expired-with-box";
    h.boat.boxes.set(pendingBox.id, pendingBox);
    h.state.set(`${h.company}:pending-refills`, { [JSON.stringify([h.company, h.env, hash])]: [{ id: "expired-with-box", body: JSON.stringify({ type: "small", ttlSeconds: 1800, noEnv: true, labels: pendingBox.labels }), at: Date.now() - 86_400_001, sandboxId: pendingBox.id }] });
    expect((await settle(h.acquire("consume-before-expired-reconcile"))).providerLeaseId).toBe(s1);
    await advance(5_000);
    expect(h.boat.boxes.get(pendingBox.id)!.name).toMatch(/^paperclip-spare:ready:/);
    expect(h.boat.liveSpares()).toEqual([pendingBox.id]);
    expect(h.boat.spareCreates()).toHaveLength(1); // Initial fill only: continuation sent NO create.
  });
});
