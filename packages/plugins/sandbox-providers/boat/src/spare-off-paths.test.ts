// Ready spares 'off' stays off on every path (Boat unit #1 follow-up, org
// 2026-11-18 23:27Z): a create or acquire in flight when 'off' lands, the
// spares key removed, a worker restart, every wake path, and every pool the
// plugin turns off. The plugin's REAL hooks, event handlers, keeper and claim
// store run against a STATEFUL fake Boat on one fake clock (the
// spare-pool-safety harness). Anything a test sets directly instead of letting
// the plugin produce it is named "planted"; each planted 'off' has a real-path
// twin (onConfigChanged delivered) beside it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));

import plugin from "./plugin.js";

const apiKey = "boat_spare_off_test";
const baseConfig = { apiKey, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const IDLE_MINUTES = 15;
const CREATE_LATENCY_MS = 2_000;
const TICK_MS = 15_000;
const START = Date.UTC(2026, 10, 18, 23, 30, 0);

type Box = { id: string; labels: Record<string, string>; name: string; state: string;
  hydrated: boolean; hydratedAt: string;
  readyAt: number; archiveAfter: string; createdAt: string; team: { id: string }; stop?: { id: string; status: string } };
type LogEntry = { seq: number; at: number; kind: "boat" | "event" | "mark"; method?: string; path?: string; id?: string; purpose?: string; configHash?: string; note?: string };
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
        hydrated: true, hydratedAt: new Date().toISOString(),
        state: "creating", readyAt: Date.now() + CREATE_LATENCY_MS,
        archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), createdAt: new Date().toISOString(), team: { id: "team-spare-off" } };
      this.boxes.set(box.id, box);
      this.record({ kind: "boat", method, path: route, id: box.id, purpose, configHash: body.labels.configHash });
      return response({ sandbox: { ...box } }, 202);
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
  boat: FakeBoat; company: string; env: string; config: SpareConfig;
  /** A second company whose spares stay on (its pool keeps maintenance running). */
  otherCompany: string; otherEnv: string; acquireOther(runId: string): Promise<{ providerLeaseId: string | null }>;
  configChanged(): Promise<void>;
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
    config: { get: async (companyId?: string) => companyId === otherCompany ? { ...otherConfig } : { ...config } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db,
    events: { on: (eventType: string, _filter: unknown, handler: (event: unknown) => Promise<void>) => {
      eventHandlers.set(eventType, handler);
      return () => eventHandlers.delete(eventType);
    } },
    state: {
      get: async (key: { scopeId?: string; stateKey: string }) => state.get(`${key.scopeId}:${key.stateKey}`) ?? null,
      set: async (key: { scopeId?: string; stateKey: string }, value: unknown) => { state.set(`${key.scopeId}:${key.stateKey}`, value); },
    },
  };
  await plugin.definition.setup(ctx as any);
  const h: Harness = {
    boat, company, env, config, otherCompany, otherEnv,
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
  for (const hold of current?.boat.holds ?? []) hold.release();
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  eventHandlers.clear();
  current = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
let current: Harness | undefined;
async function start(name: string): Promise<Harness> { current = await harness(name); return current; }

describe("row 1: a create in flight when 'off' lands", () => {
  it.each(["config", "acquire-planted"] as const)("1a off by %s while the replacement spare create is in flight: it is discarded, no further create, and it is never claimed", async path => {
    const h = await start(`inflight-${path}`);
    const { s1 } = await seed(h);
    h.boat.boxes.get(s1)!.state = "idle";
    // The claim of S1 starts the replacement create(s) through the real path.
    const before = h.boat.spareCreates().length;
    const claimed = h.acquire("run-claim");
    await until(() => h.boat.spareCreates().length > before, "a replacement spare POST");
    const inFlight = h.boat.spareCreates().slice(before).map(entry => entry.id!);
    expect(inFlight.every(id => h.boat.boxes.get(id)!.state === "creating"), "the replacement is still creating at Boat").toBe(true);
    const offAt = await turnOff(h, path);
    expect((await settle(claimed)).providerLeaseId, "the claim itself completes on S1").toBe(s1);
    await advance(10_000);
    for (const id of inFlight) expect(h.boat.boxes.get(id)!.state, `in-flight ${id} is discarded`).toBe("archived");
    for (const path of WAKES) await wake(h, path, s1);
    expect(h.boat.spareCreates(offAt).map(entry => entry.id), "no spare create after 'off'").toEqual([]);
    const lease = await settle(h.acquire("run-after-off"));
    expect(inFlight, "the in-flight box is not claimed").not.toContain(lease.providerLeaseId);
    expect(h.boat.liveSpares(), "no live spare").toEqual([]);
  });

  it.each(["config", "acquire-planted"] as const)("1b off by %s while an acquire that read spares 1 is in flight (its claim PATCH held at Boat): no create after 'off'", async path => {
    const h = await start(`acq-inflight-${path}`);
    const { s1 } = await seed(h);
    h.boat.boxes.get(s1)!.state = "idle";
    const held = h.boat.hold("PATCH", new RegExp(`^/sandboxes/${s1}$`));
    const racing = h.acquire("run-racing");
    await until(() => held.hit, "the racing acquire's claim PATCH reaches Boat");
    // 'off' lands while that acquire, which read spares 1, waits on Boat.
    h.config.spares = 0;
    const offAt = h.boat.mark(`spares off by ${path}`);
    if (path === "config") await settle(h.configChanged());
    else await settle(h.acquire("run-off-reader"));
    held.release();
    await settle(racing);
    await advance(10_000);
    for (const path of ["issue.comment.created", "health"] as const) await wake(h, path, s1);
    expect(h.boat.spareCreates(offAt).map(entry => entry.id), "no spare create after 'off'").toEqual([]);
    expect(h.boat.liveSpares(), "no live spare").toEqual([]);
  });
});

describe("row 2: the spares key removed (not set to 0) is off", () => {
  it.each(["removal-config", "removal-acquire-planted"] as const)("2 %s then every wake: zero creates", async path => {
    const h = await start(`removal-${path}`);
    const { run } = await seed(h);
    const offAt = await turnOff(h, path);
    expect("spares" in h.config, "the key is gone").toBe(false);
    for (const path of WAKES) await wake(h, path, run);
    expect(h.boat.spareCreates(offAt).map(entry => entry.id), "no spare create after the key's removal").toEqual([]);
    expect(h.boat.liveSpares(), "no live spare").toEqual([]);
  });
});

describe("row 3: a worker restart after 'off' rebuilds the pool from config", () => {
  it.each([["config", true], ["acquire-planted", false]] as const)("3 off by %s, restart (onConfigChanged delivered: %s), every wake: zero creates", async (path, deliver) => {
    const h = await start(`restart-${path}`);
    const { run } = await seed(h);
    const offAt = await turnOff(h, path);
    await h.restart(deliver);
    for (const path of WAKES) await wake(h, path, run);
    expect(h.boat.spareCreates(offAt).map(entry => entry.id), "no spare create after 'off' and the restart").toEqual([]);
  });

  it("3c off lands while the worker is down (planted: setting flips between shutdown and setup), every wake: zero creates", async () => {
    const h = await start("restart-down");
    const { run } = await seed(h);
    h.config.spares = 0; // planted: changed while no worker runs.
    const offAt = h.boat.mark("off while down");
    await h.restart(false);
    for (const path of WAKES) await wake(h, path, run);
    expect(h.boat.spareCreates(offAt).map(entry => entry.id)).toEqual([]);
  });
});

describe("row 4: every wake path after 'off' creates nothing", () => {
  for (const path of ["config", "acquire-planted"] as const) {
    it.each(WAKES)(`4 off by ${path}, wake %s: zero creates`, async wakePath => {
      const h = await start(`wake-${path}-${wakePath.replace(/\./g, "-")}`);
      const { run } = await seed(h);
      const offAt = await turnOff(h, path);
      await wake(h, wakePath, run);
      expect(h.boat.spareCreates(offAt).map(entry => entry.id), `no spare create after 'off' on the ${wakePath} wake`).toEqual([]);
    });
  }

  it.each(["health", "timer"] as const)("4 off by acquire-planted while another company's pool is on, wake %s: zero creates for the off pool", async wakePath => {
    const h = await start(`wake-other-${wakePath}`);
    await seed(h);
    await settle(h.acquireOther("run-other-seed"));
    await advance(5_000);
    const offAt = await turnOff(h, "acquire-planted");
    await settle(h.acquireOther("run-other-keepalive")); // the other company stays active
    await wake(h, wakePath, "");
    expect(h.boat.spareCreates(offAt).filter(entry => h.boat.boxes.get(entry.id!)!.labels.owner === `paperclip:${h.company}`).map(entry => entry.id),
      `no spare create for the off company on the ${wakePath} wake`).toEqual([]);
    expect(h.boat.spareCreates(offAt).some(entry => h.boat.boxes.get(entry.id!)!.labels.owner === `paperclip:${h.otherCompany}`), "the other company's pool still refills").toBe(true);
  });

  it("CONTROL spares 1: an activity wake after an idle retire refills", async () => {
    const h = await start("wake-on");
    await seed(h);
    await advance((IDLE_MINUTES + 3) * 60_000);
    expect(h.boat.liveSpares(), "idle retired S1").toEqual([]);
    const before = h.boat.spareCreates().length;
    await wake(h, "issue.comment.created", "");
    expect(h.boat.spareCreates().length).toBe(before + 1);
  });
});

describe("row 5: every pool the plugin turns off has baseDesired 0", () => {
  it("5 a retired old-config pool (the environment config changed) is not refilled by a wake or maintenance", async () => {
    const h = await start("old-config");
    const { s1 } = await seed(h);
    const oldHash = h.boat.boxes.get(s1)!.labels.configHash;
    // The real path: the environment's lease config changes (type small -> default); a new pool starts and the old one is retired.
    const changedAt = h.boat.mark("environment config changed");
    await settle(h.acquire("run-new-config", { ...baseConfig, type: "default" }));
    await advance(10_000);
    expect(h.boat.boxes.get(s1)!.state, "the old pool's spare is retired").toBe("archived");
    for (const path of ["issue.comment.created", "agent.run.started", "health"] as const) await wake(h, path, s1);
    expect(h.boat.spareCreates(changedAt).filter(entry => entry.configHash === oldHash).map(entry => entry.id),
      "no spare created for the retired config").toEqual([]);
  });
});
