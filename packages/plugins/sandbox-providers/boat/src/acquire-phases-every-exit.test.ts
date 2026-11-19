import { writeFileSync } from "node:fs";
// review-fleet-4 C1 (rf4-u3c F2): exactly ONE `boat.acquire.phases` line per
// acquisition, whatever its exit: a warmed-spare handoff, an ordinary create
// (one line, not two) and an early validation exit. The harness is
// spare-f4-rows.test.ts's (the plugin's REAL hooks and keeper against a
// stateful fake Boat on one fake clock), copied with the logger exposed.
// unchanged so the judge file stays byte-for-byte as supplied.
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
  info: ReturnType<typeof vi.fn>;
  boat: FakeBoat; company: string; env: string; config: SpareConfig;
  /** A second company whose spares stay on (its pool keeps maintenance running). */
  otherCompany: string; otherEnv: string; acquireOther(runId: string): Promise<{ providerLeaseId: string | null }>;
  configChanged(): Promise<void>;
  failActivityRead?: boolean;
  activityReadFailures?: number;
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db,
    events: { on: (eventType: string, _filter: unknown, handler: (event: unknown) => Promise<void>) => {
      eventHandlers.set(eventType, handler);
      return () => eventHandlers.delete(eventType);
    } },
    state: {
      get: async (key: { scopeId?: string; stateKey: string }) => { if (h.failActivityRead && key.stateKey === "company-activity") { h.activityReadFailures = (h.activityReadFailures ?? 0) + 1; throw new Error("JUDGE injected activity read rejection"); } return state.get(`${key.scopeId}:${key.stateKey}`) ?? null; },
      set: async (key: { scopeId?: string; stateKey: string }, value: unknown) => { state.set(`${key.scopeId}:${key.stateKey}`, value); },
    },
  };
  await plugin.definition.setup(ctx as any);
  const h: Harness = {
    info: ctx.logger.info,
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
  if (current && process.env.JUDGE_TRACE_DIR) writeFileSync(`${process.env.JUDGE_TRACE_DIR}/${current.company}.json`, JSON.stringify({ log: current.boat.log, boxes: [...current.boat.boxes.values()] }, null, 2));
  for (const hold of current?.boat.holds ?? []) hold.release();
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  eventHandlers.clear();
  current = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
let current: Harness | undefined;
async function start(name: string): Promise<Harness> { current = await harness(name); return current; }

const TOO_MANY = (code: string, retryAfter: string) => new Response(JSON.stringify({ code }), { status: 429,
  headers: { "content-type": "application/json", "Retry-After": retryAfter } });

const phaseLines = (h: Harness) => h.info.mock.calls.filter(([message]) => message === "boat.acquire.phases").map(([, meta]) => meta as any);
function wellFormed(meta: any) {
  expect(Object.values(meta.phasesMs).reduce((a: number, b) => a + Number(b), 0), "the phases sum to the total").toBe(meta.totalMs);
  for (const name of ["create", "ready", "setup", "sync", "handoff"]) expect(meta.phasesMs[name], name).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(meta)).not.toContain(apiKey);
  expect(meta).toMatchObject({ companyId: expect.any(String), environmentId: expect.any(String), budgetMs: 180_000 });
}

describe("C1: one boat.acquire.phases line per acquisition, every exit", () => {
  it("an ordinary create emits exactly one line (not two), outcome ok, source created", async () => {
    const h = await start("c1-ordinary");
    h.info.mockClear();
    const lease = await settle(h.acquire("run-ordinary"));
    expect(h.boat.boxes.get(lease.providerLeaseId!)!.labels.purpose).toBe("run");
    const lines = phaseLines(h);
    expect(lines, "exactly one line for one ordinary create").toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "ok", source: "created" });
    wellFormed(lines[0]);
  });

  it("a warmed-spare handoff emits exactly one line, outcome ok, source spare, with its phases", async () => {
    const h = await start("c1-spare");
    const { s1 } = await seed(h);
    h.info.mockClear();
    await advance(1_000);
    const lease = await settle(h.acquire("run-claims-spare"));
    expect(lease.providerLeaseId, "the run got the warmed spare").toBe(s1);
    await advance(4 * TICK_MS); // the replacement spare's create is the keeper's, not an acquisition
    const lines = phaseLines(h);
    expect(lines, "exactly one line for one spare handoff").toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "ok", source: "spare" });
    expect(lines[0].phasesMs).toEqual(expect.objectContaining({ create: 0, ready: 0, setup: 0 }));
    wellFormed(lines[0]);
  });

  it("an early validation exit (empty pinnedSnapshotId, before any Boat call) emits exactly one line, outcome error", async () => {
    const h = await start("c1-early-exit");
    h.info.mockClear();
    const before = h.boat.log.length;
    await expect(settle(h.acquire("run-early", { ...baseConfig, pinnedSnapshotId: "" }))).rejects.toThrow("pinnedSnapshotId must be a non-empty string");
    expect(h.boat.log.slice(before).filter(e => e.kind === "boat" && e.method === "POST"), "no create was sent").toEqual([]);
    const lines = phaseLines(h);
    expect(lines, "exactly one line for one early exit").toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "error" });
    wellFormed(lines[0]);
  });
});
