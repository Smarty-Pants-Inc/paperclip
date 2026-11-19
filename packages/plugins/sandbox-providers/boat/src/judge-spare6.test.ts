import { writeFileSync } from "node:fs";
// #21251 (review-fleet-4, condition for the spares-ON decision): a pool must not
// keep creating spares while its OWN owed spare stop keeps failing. After two or
// more failed owed-stop retries for a pool (the maintenance tick's included),
// that pool makes no new spare create until a stop succeeds. Another pool with
// no debt still refills; a person's run create is never blocked.
// The harness is spare-f4-rows.test.ts's (the plugin's REAL hooks, keeper,
// maintenance tick and request code against a stateful fake Boat on one fake
// clock), copied so that file stays unchanged.
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

// Independent never-OK money / custody guards derived from BRIEF-SPARE6.
describe("SPARE6 independent gate rows", () => {
  async function stuckOwedStop(name: string) {
    const h = await start(name);
    const { s1 } = await seed(h);
    const state = { stops: 0, refuse: true };
    vi.stubGlobal("fetch", async (input: unknown, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (init.method === "POST" && url.pathname.endsWith(`/sandboxes/${s1}/stop`)) {
        state.stops++;
        if (state.refuse) {
          h.boat.record({ kind: "boat", method: "POST", path: `/sandboxes/${s1}/stop`, id: s1, note: "#21251 injected stop refusal HTTP 400" });
          return response({ error: "#21251 injected stop refusal" }, 400);
        }
      }
      return h.boat.fetch(input, init);
    });
    await turnOff(h, "config");
    expect(state.stops, "the OFF stop was attempted and refused").toBeGreaterThan(0);
    h.boat.boxes.get(s1)!.state = "stopping";
    h.config.spares = 1;
    const onAt = h.boat.mark("#21251 spares back ON while S1's stop is owed");
    await settle(h.configChanged());
    await advance(5_000);
    return { h, s1, state, onAt };
  }
  /** Run the maintenance tick until it has retried S1's owed stop `retries` more times (each refused). */
  async function tickRetries(h: Harness, s1: string, state: { stops: number }, retries: number): Promise<void> {
    const reads = () => h.boat.log.filter(e => e.kind === "boat" && e.method === "GET" && e.path === `/sandboxes/${s1}`).length;
    for (let i = 0; i < retries; i++) {
      const before = state.stops, readsBefore = reads();
      await until(() => state.stops > before && reads() > readsBefore, `tick retry ${i + 1} of the owed stop`, 1_000, 2 * READY_SPARE_STOP_BACKOFF_MS + 10 * TICK_MS);
      await advance(TICK_MS);
    }
  }

  it("J6-CONCURRENT one existing ready id goes to exactly one of two simultaneous chats", async () => {
    const h = await start("j6-concurrent"); const { s1 } = await seed(h);
    const at = h.boat.mark("two simultaneous new-chat acquires");
    const leases = await settle(Promise.all([h.acquire("chat-a"), h.acquire("chat-b")]));
    expect(leases.filter(x => x.providerLeaseId === s1)).toHaveLength(1);
    expect(new Set(leases.map(x => x.providerLeaseId)).size).toBe(2);
    await advance(5_000);
    expect(h.boat.liveSpares()).toHaveLength(1);
    expect(h.boat.spareCreates(at)).toHaveLength(1);
  });
  it("J6-REFILL exact total creates equals initial fill plus four sequential claims", async () => {
    const h = await start("j6-exact-count"); await seed(h);
    for(let i=0;i<4;i++) {
      const [id] = h.boat.liveSpares();
      expect((await settle(h.acquire(`chat-${i}`))).providerLeaseId).toBe(id);
      await advance(5_000);
      expect(h.boat.spareCreates()).toHaveLength(1+i+1);
      expect(h.boat.liveSpares()).toHaveLength(1);
    }
  });
  it("J6-RESTART no spare create before existing inventory is claimed", async () => {
    const h = await start("j6-order"); const {s1}=await seed(h); await h.restart(true);
    const at=h.boat.mark("restart new chat");
    expect((await settle(h.acquire("chat-after-restart"))).providerLeaseId).toBe(s1);
    const claim=h.boat.log.find(e=>e.seq>at && e.method==="PATCH" && e.id===s1)!;
    expect(claim).toBeDefined();
    expect(h.boat.spareCreates(at).filter(e=>e.seq<claim.seq)).toEqual([]);
    await advance(5_000);
    expect(h.boat.spareCreates(at)).toHaveLength(1);
  });
  it("J6-OFF-RUNNING next tick stops every healthy unclaimed running spare", async () => {
    const h=await start("j6-off-running"); const {s1}=await seed(h);
    h.boat.boxes.get(s1)!.state="running";
    h.config.spares=0; const at=h.boat.mark("OFF without config event");
    await advance(TICK_MS);
    const nextTickStops=h.boat.log.filter(e=>e.seq>at && e.method==="POST" && e.path===`/sandboxes/${s1}/stop`);
    await advance(4*TICK_MS);
    h.boat.mark(`75s after OFF; unclaimed live spares=${h.boat.liveSpares().length}`);
    expect(nextTickStops).toHaveLength(1);
    expect(h.boat.liveSpares()).toEqual([]);
  });
  it("J6-SCOPE foreign-company ready inventory is never claimed", async () => {
    const h=await start("j6-scope"); const {s1}=await seed(h);
    h.boat.boxes.get(s1)!.labels.owner="paperclip:other-company";
    await h.restart(true); const at=h.boat.mark("foreign ownership before own chat");
    expect((await settle(h.acquire("own-chat"))).providerLeaseId).not.toBe(s1);
    expect(h.boat.log.filter(e=>e.seq>at && e.id===s1 && e.method==="PATCH" && !e.path?.endsWith("/files"))).toEqual([]);
  });
  it("J6-OFF-READY control stops a ready unclaimed spare on next tick", async () => {
    const h=await start("j6-off-ready"); const {s1}=await seed(h);
    h.config.spares=0; const at=h.boat.mark("OFF ready control");
    await advance(TICK_MS);
    expect(h.boat.boxes.get(s1)!.state).toBe("archived");
    expect(h.boat.log.filter(e=>e.seq>at && e.method==="POST" && e.path===`/sandboxes/${s1}/stop`)).toHaveLength(1);
    expect(h.boat.liveSpares()).toEqual([]);
  });

  it("J6-OWED-RESTART actual two failed retries remain capped after restart", async () => {
    const {h,s1,state}=await stuckOwedStop("j6-earned-debt");
    await tickRetries(h,s1,state,2);
    const owed=h.state.get(`${h.company}:stop-owed`) as any;
    expect(owed.holds.find((x:any)=>x.environmentId===h.env).retries).toBe(2);
    await h.restart(true); const at=h.boat.mark("actual cap then restart");
    await settle(h.acquire("chat-after-cap-restart"));
    await advance(READY_SPARE_STOP_BACKOFF_MS+TICK_MS);
    await settle(h.emit("issue.comment.created"));
    expect(h.boat.spareCreates(at)).toEqual([]);
  });
  it("J6-REDUCTION durable target falls to one during inventory before ANY spare send", async () => {
    const h=await start("j6-reduction"); h.config.spares=3; await settle(h.configChanged());
    h.configReadHook=async()=>{h.boat.mark(`config.get sees spares=${h.config.spares}`);return {...h.config};};
    let changed=false;
    vi.stubGlobal("fetch",async(input:unknown,init:RequestInit={})=>{
      const url=new URL(String(input));
      if(!changed && (init.method??"GET")==="GET" && url.pathname.endsWith("/sandboxes")
        && url.searchParams.getAll("label").includes("purpose=run")) {
        expect(h.boat.spareCreates()).toHaveLength(0);
        changed=true; h.config.spares=1;
        h.boat.mark("durable spares=1 during inventory, before ANY spare POST or final admission");
      }
      return h.boat.fetch(input,init);
    });
    await settle(h.acquire("teach-pool")); await advance(5_000);
    expect(changed).toBe(true);
    const first=h.boat.spareCreates()[0];
    expect(h.boat.log.some(e=>e.seq<first.seq && e.note==="config.get sees spares=1")).toBe(true);
    expect(h.boat.spareCreates()).toHaveLength(1);
    expect(h.boat.liveSpares()).toHaveLength(1);
  });
  it("J6-SCOPE-ENV another environment's spare cannot be claimed", async () => {
    const h=await start("j6-env-scope"); const {s1}=await seed(h);
    h.boat.boxes.get(s1)!.labels.environment="foreign-env";
    await h.restart(true); const at=h.boat.mark("foreign environment before own chat");
    expect((await settle(h.acquire("own-chat"))).providerLeaseId).not.toBe(s1);
    expect(h.boat.log.filter(e=>e.seq>at && e.id===s1 && e.method==="PATCH")).toEqual([]);
  });
});
