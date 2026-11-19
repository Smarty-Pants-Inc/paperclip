// Ready-spare pool safety (gates 2/4/5, 2026-11-18): the plugin's REAL hooks,
// event handlers, keeper (queueSpareReconciliation, wakeCompanySparePools,
// claimWithOutcome, stopSpare, reconcileOnce) and claim store against a
// STATEFUL fake Boat, on one fake clock (the wake-race harness, extended with
// Boat's stop records). Anything a test sets directly instead of letting the
// plugin produce it is named "planted".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as nativeSleep } from 'node:timers';

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));

import plugin from "./plugin.js";
import * as keeper from "./ready-spares.js";

/** The keeper's named stop back-off interval (absent before the back-off existed). */
const READY_SPARE_STOP_BACKOFF_MS = Number((keeper as Record<string, unknown>).READY_SPARE_STOP_BACKOFF_MS ?? 0);

const apiKey = "boat_spare_safety_test";
const baseConfig = { apiKey, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const IDLE_MINUTES = 15;
const CREATE_LATENCY_MS = 2_000;
const TICK_MS = 15_000;
const START = Date.UTC(2026, 10, 18, 18, 0, 0);
// Boat's words for the live failures (bx_h63drzhu 17:44Z, bx_7qu5sy5t 20:55Z).
const FINAL_SNAPSHOT_FAILED = "Final snapshot failed; stop aborted to protect unsaved data: final snapshot writer hold failed: Docker start lock not acquired (rc=1)";

type StopRecord = { id: string; status: "pending" | "failing" | "completed"; error?: string };
type Box = { id: string; labels: Record<string, string>; name: string; state: string;
  readyAt: number; archiveAfter: string; createdAt: string; team: { id: string }; stop?: StopRecord };
type LogEntry = { seq: number; at: number; kind: "boat" | "event" | "warn" | "info"; method?: string; path?: string; id?: string; purpose?: string; note?: string };
/**
 * How Boat answers POST /stop:
 * - complete: the box archives (the normal case);
 * - failing-idle: the final snapshot fails, the stop record says failing and the box keeps running 'idle' (bx_yntyy5tj, 18:25Z);
 * - failing-stopping: the same, but Boat shows the box 'stopping' (bx_7qu5sy5t, 21:1xZ).
 */
type StopMode = "complete" | "failing-idle" | "failing-stopping";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class FakeBoat {
  readonly boxes = new Map<string, Box>();
  readonly log: LogEntry[] = [];
  readonly hiddenInventoryIds = new Set<string>();
  stopMode: StopMode = "complete";
  failReadId?: string;
  hangReadId?: string;
  createDelayMs = 0;
  listDelayOnceMs = 0;
  inventoryDelayOnceMs = 0;
  stopIdText?: string;
  sickenAfterReadId?: string;
  private seq = 0;
  private counter = 0;

  record(entry: Omit<LogEntry, "seq" | "at">): LogEntry {
    const full = { seq: ++this.seq, at: Date.now(), ...entry };
    this.log.push(full);
    return full;
  }
  observe(box: Box): Box {
    if (box.state === "creating" && Date.now() >= box.readyAt) box.state = "ready";
    return box;
  }
  creates(purpose = "spare") { return this.log.filter(e => e.kind === "boat" && e.method === "POST" && e.path === "/sandboxes" && e.purpose === purpose); }
  stopPosts(id?: string) { return this.log.filter(e => e.kind === "boat" && e.method === "POST" && e.path?.endsWith("/stop") && (id === undefined || e.id === id)); }
  patchesOf(id: string) { return this.log.filter(e => e.kind === "boat" && e.method === "PATCH" && e.id === id); }
  spareIds() { return [...this.boxes.values()].filter(box => box.labels.purpose === "spare").map(box => box.id); }

  readonly fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const route = url.pathname.replace("/api/v1", "");
    const body = typeof init.body === "string" && init.body ? JSON.parse(init.body) : undefined;
    const id = /^\/sandboxes\/([^/]+)/.exec(route)?.[1];
    if (method === "POST" && route === "/sandboxes") {
      const purpose = body.labels.purpose === "spare" ? "spare" : "run";
      const box: Box = { id: `bx_${purpose}${String(++this.counter).padStart(4, "0")}`, labels: { ...body.labels }, name: "",
        state: "creating", readyAt: Date.now() + CREATE_LATENCY_MS,
        archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), createdAt: new Date().toISOString(), team: { id: "team-spare-safety" } };
      this.boxes.set(box.id, box);
      this.record({ kind: "boat", method, path: route, id: box.id, purpose });
      if (purpose === 'spare' && this.createDelayMs) await new Promise(resolve=>setTimeout(resolve,this.createDelayMs));
      return response({ sandbox: { ...box } }, 202);
    }
    this.record({ kind: "boat", method, path: route, ...(id ? { id } : {}) });
    if (method === "GET" && route === "/sandboxes") {
      if(this.listDelayOnceMs && url.searchParams.getAll('label').some(label=>label.startsWith('environment='))) {const wait=this.listDelayOnceMs;this.listDelayOnceMs=0;await new Promise(resolve=>setTimeout(resolve,wait));}
      if(this.inventoryDelayOnceMs && !url.searchParams.getAll('label').some(label=>label.startsWith('environment='))) {const wait=this.inventoryDelayOnceMs;this.inventoryDelayOnceMs=0;await new Promise(resolve=>setTimeout(resolve,wait));}
      const labels = url.searchParams.getAll("label").map(label => label.split("="));
      const matching = [...this.boxes.values()].map(box => this.observe(box))
        .filter(box => !this.hiddenInventoryIds.has(box.id) && labels.every(([key, ...rest]) => box.labels[key] === rest.join("=")));
      return response({ sandboxes: matching.map(box => ({ ...box })), pageInfo: { nextCursor: null } });
    }
    const box = id ? this.boxes.get(id) : undefined;
    if (id && !box) return response({ error: "not_found" }, 404);
    if (method === "POST" && box && route.endsWith("/stop")) {
      const stop: StopRecord = { id: this.stopIdText ?? box.stop?.id ?? `stop_${box.id}`, status: "pending" };
      if (this.stopMode === "complete") { box.state = "archived"; box.stop = { ...stop, status: "completed" }; }
      else {
        box.stop = { ...stop, status: "failing", error: FINAL_SNAPSHOT_FAILED };
        box.state = this.stopMode === "failing-stopping" ? "stopping" : "idle";
      }
      return response({ stop: { ...stop } }, 202);
    }
    if (method === "GET" && box && route === `/sandboxes/${id}`) {
      if (this.failReadId === id) return response({ error: 'internal_error' }, 500);
      if (this.hangReadId === id) return new Promise<Response>((_resolve,reject)=>{
        init.signal?.addEventListener('abort',()=>reject(init.signal!.reason),{once:true});
      });
      const snapshot = { ...this.observe(box) };
      if (this.sickenAfterReadId === id) { this.sickenAfterReadId = undefined; box.state = 'idle'; box.stop = { id: 'stop_race', status: 'pending' }; }
      return response({ sandbox: snapshot });
    }
    if (method === 'POST' && box && route.endsWith('/resume')) { box.state = 'ready'; return response({ sandbox: { ...box } }); }
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

type SpareConfig = { spares: number; spareMax: number; spareDemandWindowMinutes: number; spareEnvironmentIds: string[]; spareIdleMinutes: number };
type Harness = { boat: FakeBoat; company: string; env: string; config: SpareConfig; warnings: string[];
  emit(eventType: string): Promise<void>; acquire(runId: string): Promise<{ providerLeaseId: string | null }> };

let current: Harness | undefined;
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

async function harness(name: string, existingBoat?: FakeBoat): Promise<Harness> {
  const boat = existingBoat ?? new FakeBoat();
  vi.stubGlobal("fetch", boat.fetch);
  const company = `company-${name}`, env = `environment-${name}`;
  const state = new Map<string, unknown>();
  const warnings: string[] = [];
  const claims = new Set<string>();
  const db = { namespace: "boat_sandbox_provider", execute: async (_sql: string, params: unknown[] = []) => {
    if (claims.has(String(params[0]))) return { rowCount: 0 };
    claims.add(String(params[0]));
    return { rowCount: 1 };
  } };
  const config: SpareConfig = { spares: 1, spareMax: 3, spareDemandWindowMinutes: 10, spareEnvironmentIds: [env], spareIdleMinutes: IDLE_MINUTES };
  const warn = (message: string, details?: unknown) => { warnings.push(details === undefined ? message : `${message} ${JSON.stringify(details)}`); boat.record({ kind: "warn", note: message }); };
  await plugin.definition.setup({
    config: { get: async () => ({ ...config }) },
    logger: { info: vi.fn(), warn: vi.fn(warn), error: vi.fn(warn), debug: vi.fn() },
    db,
    events: { on: (eventType: string, _filter: unknown, handler: (event: unknown) => Promise<void>) => {
      eventHandlers.set(eventType, handler);
      return () => eventHandlers.delete(eventType);
    } },
    state: {
      get: async (key: { scopeId?: string; stateKey: string }) => state.get(`${key.scopeId}:${key.stateKey}`) ?? null,
      set: async (key: { scopeId?: string; stateKey: string }, value: unknown) => { state.set(`${key.scopeId}:${key.stateKey}`, value); },
    },
  } as any);
  await plugin.definition.onConfigChanged!({ ...config }, { companyId: company } as any);
  const h: Harness = {
    boat, company, env, config, warnings,
    emit(eventType) {
      const handler = eventHandlers.get(eventType);
      if (!handler) throw new Error(`no handler for ${eventType}`);
      boat.record({ kind: "event", note: eventType });
      return handler({ eventId: `${eventType}-${Date.now()}`, eventType, companyId: company, occurredAt: new Date().toISOString() });
    },
    acquire(runId) {
      return plugin.definition.onEnvironmentAcquireLease!({ driverKey: "boat", companyId: company, environmentId: env, runId,
        creationOperationId: `attempt-${runId}`, config: baseConfig } as any) as Promise<{ providerLeaseId: string | null }>;
    },
  };
  current = h;
  return h;
}

/** One cold run lease teaches the plugin the pool; spare S1 becomes ready and claimable. */
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

/** Idle past spareIdleMinutes: the real maintenance tick asks Boat to stop S1; wait until that stop attempt has finished. */
async function idleStopAttempt(h: Harness, s1: string): Promise<number> {
  for (let waited = 0; h.boat.stopPosts(s1).length === 0 && waited < (IDLE_MINUTES + 2) * 60_000; waited += 1_000) await advance(1_000);
  const [post] = h.boat.stopPosts(s1);
  expect(post, "maintenance asks Boat to stop the idle spare").toBeDefined();
  // The plugin polls a stop for 120 s, then reports it did not complete.
  await advance(125_000);
  return post.at;
}

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(async () => {
  const observed=current;
  const testEndLogEntries=observed?.boat.log.length ?? 0;
  const testEndBoxes=observed ? JSON.parse(JSON.stringify([...observed.boat.boxes.values()])) : [];
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
  if (observed && process.env.TASK_OUT) {
    const dir = `${process.env.TASK_OUT}/traces-${process.env.JUDGE_VARIANT ?? 'head'}`;
    mkdirSync(dir,{recursive:true});
    writeFileSync(`${dir}/${observed.company}.json`,JSON.stringify({log:observed.boat.log, boxes:[...observed.boat.boxes.values()], testEndLogEntries, testEndBoxes, hiddenInventoryIds:[...observed.boat.hiddenInventoryIds], warnings:observed.warnings},null,2));
  }
  eventHandlers.clear();
  current = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Boat ready spares: off stays off (gate 5 bx_dyr9gyf6, 20:33:18Z)", () => {
  it("RED-1 config spares 0 seen by an acquire, then issue.comment.created and agent.run.started wakes: no spare create", async () => {
    const h = await harness("off");
    const s1 = await seed(h);
    // planted: the company's spare setting now reads 0 (the 18:51Z 'off'),
    // with no onConfigChanged delivered to this worker. The acquire is the
    // real reader of that setting (spares_disabled -> queueSpareReconciliation(0)).
    h.config.spares = 0;
    const offLease = await settle(h.acquire("run-after-off"));
    expect(h.boat.boxes.get(offLease.providerLeaseId!)!.labels.purpose, "spares off: the run is a cold create").toBe("run");
    await advance(5_000);
    expect(h.boat.boxes.get(s1)!.state, "the off acquire retires S1").toBe("archived");
    const sparesBefore = h.boat.creates("spare").length;
    await settle(h.emit("issue.comment.created"));
    await settle(h.emit("agent.run.started"));
    await advance(4 * TICK_MS);
    expect(h.boat.creates("spare").map(entry => entry.id), "no spare create after 'off'").toHaveLength(sparesBefore);
    expect(h.boat.spareIds().filter(id => h.boat.boxes.get(id)!.state !== "archived"), "no live spare").toHaveLength(0);
  });

  it("CONTROL spares 1: the same wakes after an idle stop do refill", async () => {
    const h = await harness("on");
    const s1 = await seed(h);
    await idleStopAttempt(h, s1);
    expect(h.boat.boxes.get(s1)!.state).toBe("archived");
    await settle(h.emit("issue.comment.created"));
    await advance(4 * TICK_MS);
    expect(h.boat.creates("spare"), "the wake refills while spares are on").toHaveLength(2);
  });
});

describe("Boat ready spares: a claim never takes a sick spare (gate 5 bx_yntyy5tj, stop failed 18:25:08Z, claimed 18:36:47Z)", () => {
  it("RED-2a a spare whose idle stop failed (Boat: stop failing, box idle) is not claimed; the run gets a fresh box", async () => {
    const h = await harness("claim-failing");
    const s1 = await seed(h);
    h.boat.stopMode = "failing-idle"; // Boat's final snapshot fails from here on.
    await idleStopAttempt(h, s1);
    expect(h.boat.boxes.get(s1)!.stop?.status, "Boat GET shows S1's stop failing").toBe("failing");
    expect(h.boat.boxes.get(s1)!.state, "and S1 still running idle").toBe("idle");
    await settle(h.emit("issue.created"));
    await advance(5_000);
    const patchesBefore = h.boat.patchesOf(s1).length;
    const lease = await settle(h.acquire("run-after-failed-stop"));
    expect(lease.providerLeaseId, "the claim skips S1").not.toBe(s1);
    expect(h.boat.boxes.get(lease.providerLeaseId!), "the run gets a fresh box").toBeDefined();
    expect(h.boat.boxes.get(lease.providerLeaseId!)!.state).not.toBe("idle");
    expect(h.boat.patchesOf(s1).slice(patchesBefore), "S1 is never renamed to a claim").toHaveLength(0);
    expect(h.boat.boxes.get(s1)!.name).toMatch(/^paperclip-spare:ready:/);
  });

  it("RED-2b a spare whose Boat GET shows a pending stop (planted) is not claimed; the run gets a fresh box", async () => {
    const h = await harness("claim-pending");
    const s1 = await seed(h);
    // planted: a stop another actor requested, still pending at Boat; the box reads idle.
    const box = h.boat.boxes.get(s1)!;
    box.state = "idle";
    box.stop = { id: "stop_planted", status: "pending" };
    const lease = await settle(h.acquire("run-after-pending-stop"));
    expect(lease.providerLeaseId, "the claim skips S1").not.toBe(s1);
    expect(h.boat.boxes.get(lease.providerLeaseId!)).toBeDefined();
    expect(h.boat.boxes.get(s1)!.name).toMatch(/^paperclip-spare:ready:/);
  });

  it("CONTROL a healthy idle spare with no stop record is still claimed warm", async () => {
    const h = await harness("claim-healthy");
    const s1 = await seed(h);
    h.boat.boxes.get(s1)!.state = "idle";
    const runCreates = h.boat.creates("run").length;
    const lease = await settle(h.acquire("run-healthy"));
    expect(lease.providerLeaseId).toBe(s1);
    expect(h.boat.creates("run")).toHaveLength(runCreates);
  });
});

describe("Boat ready spares: the pool backs off while its stops fail (gate 5 stop_aa50aed8569db22a, 20:33:26Z)", () => {
  it("RED-3 after a failed spare stop no new spare is created within the back-off, a log line says so, and creation resumes after it", async () => {
    const h = await harness("backoff");
    const s1 = await seed(h);
    h.boat.stopMode = "failing-stopping"; // Boat shows the box 'stopping' with its stop failing (bx_7qu5sy5t).
    const stopAt = await idleStopAttempt(h, s1);
    expect(h.boat.boxes.get(s1)!.stop?.status).toBe("failing");
    expect(h.boat.boxes.get(s1)!.state).toBe("stopping");
    const sparesAfterFailure = h.boat.creates("spare").length;
    // Activity inside the back-off: each wake would refill the pool.
    await settle(h.emit("issue.comment.created"));
    await advance(TICK_MS);
    await settle(h.emit("agent.run.started"));
    await advance(4 * TICK_MS);
    expect(h.boat.creates("spare"), "no new spare while the pool's stop is failing").toHaveLength(sparesAfterFailure);
    expect(h.warnings.some(w => /Boat ready spare pool backing off after stop failures/.test(w)), JSON.stringify(h.warnings)).toBe(true);
    // After the named interval, creation resumes.
    await advance(stopAt + 120_000 + READY_SPARE_STOP_BACKOFF_MS + 1_000 - Date.now());
    await settle(h.emit("issue.comment.created"));
    await advance(5_000);
    expect(h.boat.creates("spare").length, "creation resumes after the back-off").toBe(sparesAfterFailure + 1);
  });
});

// Independent judge rows: state labelled planted; plugin hooks and keeper unmocked.
describe('JUDGE off-path completeness', () => {
  for (const action of ['comment', 'acquire', 'resume', 'release', 'health'] as const) {
    it(`JUDGE-OFF-${action}: config reads off, idle pool, no config event; zero new spare POSTs`, async () => {
      const h = await harness(`judge-off-${action}`);
      const s1 = await seed(h);
      if(action==='health') {h.boat.boxes.get(s1)!.state='archived';await advance(TICK_MS+1_000);} // scripted external archival; timer evicts it while company's real seed activity remains recent.
      else await idleStopAttempt(h, s1);
      expect(h.boat.boxes.get(s1)!.state).toBe('archived');
      // planted durable policy change with no notification, exactly the builder's missing-event premise.
      h.config.spares = 0;
      const before = h.boat.creates('spare').length;
      const runBox = [...h.boat.boxes.values()].find(b => b.labels.purpose === 'run')!;
      if (action === 'comment') await settle(h.emit('issue.comment.created'));
      if (action === 'acquire') await settle(h.acquire('run-off-idle'));
      if (action === 'resume') await settle(plugin.definition.onEnvironmentResumeLease!({ driverKey:'boat', companyId:h.company, environmentId:h.env, providerLeaseId:runBox.id, config:baseConfig, leaseMetadata:{} } as any));
      if (action === 'release') await settle(plugin.definition.onEnvironmentReleaseLease!({ driverKey:'boat', companyId:h.company, environmentId:h.env, providerLeaseId:runBox.id, config:baseConfig } as any));
      if (action === 'health') await settle(plugin.definition.onHealth!());
      await advance(5_000);
      console.log('JUDGE-COUNTS', action, JSON.stringify({before,after:h.boat.creates('spare').length,newCreates:h.boat.creates('spare').slice(before)}));
      expect(h.boat.creates('spare').length, `no spare POST after off via ${action}`).toBe(before);
    });
  }
  it('JUDGE-OFF-ADOPTION: delivered off event cannot be undone by a delayed discovery callback', async()=>{
    const h=await harness('judge-off-adoption');h.boat.listDelayOnceMs=2_400; // within the real 2.5-second inventory budget
    // F1 discovery now precedes the run create: deliver OFF while it is pending.
    const acquire=h.acquire('run-delayed-adopt');await advance(100);expect(h.boat.creates()).toHaveLength(0);
    h.config.spares=0;await settle(plugin.definition.onConfigChanged!({...h.config},{companyId:h.company} as any));
    const offAt=Date.now();await settle(acquire);await advance(15_000);
    console.log('JUDGE-ADOPTION-CREATES',JSON.stringify(h.boat.creates('spare').filter(e=>e.at>=offAt)));
    expect(h.boat.creates('spare').filter(e=>e.at>=offAt)).toHaveLength(0);
  });
  it('JUDGE-OFF-ADMISSION: delivered off during the pre-create inventory read must cancel an unsent spare POST',async()=>{
    const h=await harness('judge-off-admission');const s1=await seed(h);await idleStopAttempt(h,s1);
    h.boat.inventoryDelayOnceMs=2_400; // within the real 2.5-second inventory budget
    const wake=h.emit('issue.comment.created');await advance(100);
    h.config.spares=0;const offAt=Date.now();
    const off=Promise.resolve(plugin.definition.onConfigChanged!({...h.config},{companyId:h.company} as any));
    await settle(Promise.all([wake,off]));await advance(5_000);
    console.log('JUDGE-ADMISSION-CREATES',JSON.stringify(h.boat.creates().filter(e=>e.at>=offAt)));
    expect(h.boat.creates().filter(e=>e.at>=offAt)).toHaveLength(0);
  });
  it('JUDGE-OFF-inflight: prior spare POST completing after an explicit off is retired', async()=>{
    const h=await harness('judge-off-inflight');h.boat.createDelayMs=8_000;
    await settle(h.acquire('run-first'));
    expect(h.boat.creates()).toHaveLength(1);
    h.config.spares=0;
    await settle(plugin.definition.onConfigChanged!({...h.config},{companyId:h.company} as any));
    await advance(10_000);
    const before=h.boat.creates().length;await settle(h.emit('issue.comment.created'));await advance(60_000);
    expect(h.boat.creates().length).toBe(before);
    expect([...h.boat.boxes.values()].filter(b=>b.labels.purpose==='spare'&&b.state!=='archived')).toHaveLength(0);
  });
  it('JUDGE-OFF-restart: next worker re-reads off and creates no replacement spare',async()=>{
    const h=await harness('judge-off-restart');await seed(h);const before=h.boat.creates().length;
    await settle(Promise.resolve(plugin.definition.onShutdown?.()));eventHandlers.clear();
    const restarted=await harness('judge-off-restart',h.boat);restarted.config.spares=0;
    await settle(restarted.acquire('run-off-restart'));await advance(60_000);
    expect(h.boat.creates().length).toBe(before);
  });
  it('JUDGE-OFF-config-event: explicit zero takes effect before wakes', async () => {
    const h=await harness('judge-off-event'); await seed(h);
    h.config.spares=0;
    await settle(plugin.definition.onConfigChanged!({...h.config},{companyId:h.company} as any));
    const before=h.boat.creates().length;
    await settle(h.emit('issue.comment.created'));await settle(h.emit('agent.run.started'));await advance(60_000);
    expect(h.boat.creates().length).toBe(before);
  });
  it('JUDGE-OFF-CONFIG-REMOVAL: real host returns empty object for absent config; acquire and subsequent wakes remain off',async()=>{
    const h=await harness('judge-off-config-removal');await seed(h);
    // planted deletion of the stored config, whose host config.get contract is {} (plugin-host-services.ts).
    for(const key of Object.keys(h.config)) delete (h.config as Record<string,unknown>)[key];
    await settle(h.acquire('run-config-removed'));const before=h.boat.creates().length;
    await settle(h.emit('issue.comment.created'));await settle(h.emit('agent.run.started'));await advance(60_000);
    expect(h.boat.creates().length).toBe(before);
  });
  it('JUDGE-OFF-removal: deleting spares field is off after acquire and subsequent wake', async () => {
    const h=await harness('judge-off-removal'); await seed(h);
    delete (h.config as Partial<SpareConfig>).spares;
    await settle(h.acquire('run-removed'));
    const before=h.boat.creates().length;
    await settle(h.emit('issue.comment.created')); await advance(60_000);
    expect(h.boat.creates().length).toBe(before);
  });
  it('JUDGE-HASH: a config-hash retirement must not wake the old pool again', async () => {
    const h=await harness('judge-hash');const s1=await seed(h);
    const oldHash=h.boat.boxes.get(s1)!.labels.configHash;
    const newLease=await settle(plugin.definition.onEnvironmentAcquireLease!({driverKey:'boat',companyId:h.company,environmentId:h.env,runId:'run-hash-change',creationOperationId:'attempt-hash-change',config:{...baseConfig,type:'large'}} as any));
    expect(newLease.providerLeaseId).toBeDefined();await advance(5_000);
    const mark=h.boat.creates().length;
    await settle(h.emit('issue.comment.created'));await advance(5_000);
    const recreated=h.boat.creates().slice(mark).map(x=>h.boat.boxes.get(x.id!)!).filter(b=>b.labels.configHash===oldHash);
    console.log('JUDGE-OLD-HASH-CREATES',recreated.map(b=>b.id));
    expect(recreated).toHaveLength(0);
  });
});

describe('JUDGE claim safety and stop durability', () => {
  it('JUDGE-NEXT-CANDIDATE: first pending, second healthy; exactly two pre-reserve GETs and no cold run create',async()=>{
    const h=await harness('judge-next');h.config.spares=2;await settle(h.acquire('run-seed-two'));await advance(5_000);
    const [s1,s2]=h.boat.spareIds();expect(h.boat.spareIds()).toHaveLength(2);
    // planted external pending stop on the first otherwise-idle candidate.
    h.boat.boxes.get(s1)!.stop={id:'stop_external',status:'pending'};h.boat.boxes.get(s1)!.state='idle';
    const mark=h.boat.log.length,before=h.boat.creates('run').length;
    const lease=await settle(h.acquire('run-next'));expect(lease.providerLeaseId).toBe(s2);expect(h.boat.creates('run').length).toBe(before);
    const events=h.boat.log.slice(mark),patch=events.findIndex(e=>e.method==='PATCH'&&e.id===s2);
    expect(events.slice(0,patch).filter(e=>e.method==='GET'&&(e.id===s1||e.id===s2))).toHaveLength(2);
    expect(h.boat.boxes.get(s1)!.name).toMatch(/^paperclip-spare:ready:/);
  });
  it('JUDGE-NOT-READY: cached-ready, fresh error; never PATCH the unready box',async()=>{
    const h=await harness('judge-notready');const s1=await seed(h);h.boat.boxes.get(s1)!.state='error';
    const before=h.boat.patchesOf(s1).length;const lease=await settle(h.acquire('run-notready'));
    expect(lease.providerLeaseId).not.toBe(s1);expect(h.boat.patchesOf(s1).length).toBe(before);
  });
  it('JUDGE-GET500: unreadable candidate is never handed out and person gets a cold box',async()=>{
    const h=await harness('judge-get500');const s1=await seed(h);h.boat.failReadId=s1;
    const before=h.boat.creates('run').length;const lease=await settle(h.acquire('run-get500'));
    expect(lease.providerLeaseId).not.toBe(s1);expect(h.boat.creates('run').length).toBe(before+1);
    expect(h.boat.boxes.get(s1)!.name).toMatch(/^paperclip-spare:ready:/);
  });
  it('JUDGE-GET-TIMEOUT: a hanging HTTP GET aborts and person gets a cold box',async()=>{
    const h=await harness('judge-timeout');const s1=await seed(h);h.boat.hangReadId=s1;
    const before=h.boat.creates('run').length;
    let done=false;const began=performance.now();const work=h.acquire('run-timeout').then(result=>{done=true;return result;});
    // AbortSignal.timeout is a native real-clock timer, deliberately not mocked.
    while(!done && performance.now()-began<10_500) await new Promise(resolve=>nativeSleep(resolve,50));
    const lease=await settle(work);
    expect(lease.providerLeaseId).not.toBe(s1);expect(h.boat.creates('run').length).toBe(before+1);
    expect(h.boat.boxes.get(s1)!.name).toMatch(/^paperclip-spare:ready:/);
    console.log('JUDGE-TIMEOUT-WALL-MS',Math.round(performance.now()-began));
    expect(performance.now()-began).toBeLessThan(15_000);
  },20_000);
  it('JUDGE-STOP-RACE: stop appears just after clean GET, before reserve; never hand out sick box',async()=>{
    const h=await harness('judge-race');const s1=await seed(h);h.boat.sickenAfterReadId=s1;
    const lease=await settle(h.acquire('run-race'));
    console.log('JUDGE-RACE',JSON.stringify({spare:s1,returned:lease.providerLeaseId,stop:h.boat.boxes.get(s1)!.stop}));
    expect(lease.providerLeaseId).not.toBe(s1);
  });
  it('JUDGE-BACKOFF-RESTART-LOSS: isolate the old hold with a planted missing inventory record; restart loses it',async()=>{
    const h=await harness('judge-restart-loss');const s1=await seed(h);h.boat.stopMode='failing-stopping';await idleStopAttempt(h,s1);
    // planted provider LIST omission, not a hidden keeper mutation: keeps rediscovery from simply re-stopping S1 and starting a different hold.
    h.boat.hiddenInventoryIds.add(s1);
    const before=h.boat.creates().length,failedAt=Date.now();
    await settle(h.emit('issue.comment.created'));await advance(5_000);expect(h.boat.creates().length).toBe(before);
    await settle(Promise.resolve(plugin.definition.onShutdown?.()));eventHandlers.clear();
    const restarted=await harness('judge-restart-loss',h.boat);await settle(restarted.acquire('run-restart-loss'));await advance(5_000);
    console.log('JUDGE-RESTART-LOSS',JSON.stringify({elapsed:Date.now()-failedAt,before,after:h.boat.creates().length}));
    expect(h.boat.creates().length,'old 15 minute hold is still owed despite worker reset').toBe(before);
  });
  it('JUDGE-BACKOFF-RESTART-CONTROL: re-encountered failed stop re-establishes a hold after shutdown/setup',async()=>{
    const h=await harness('judge-restart');const s1=await seed(h);h.boat.stopMode='failing-stopping';await idleStopAttempt(h,s1);
    const before=h.boat.creates().length;const failAt=Date.now();
    await settle(Promise.resolve(plugin.definition.onShutdown?.()));eventHandlers.clear();
    const restarted=await harness('judge-restart',h.boat);
    await settle(restarted.acquire('run-restart'));await advance(5_000);
    await settle(restarted.emit('issue.comment.created'));await advance(5_000);
    console.log('JUDGE-RESTART',JSON.stringify({elapsed:Date.now()-failAt,before,after:h.boat.creates().length,newCreates:h.boat.creates().slice(before)}));
    expect(h.boat.creates().length,'rediscovery of the still-listed failing box establishes another hold; NOT proof the previous hold persisted').toBe(before);
  });
  it('JUDGE-NEVER-OK-LOG: a provider stop-id echo of a synthetic key is redacted from structured backoff logs',async()=>{
    const h=await harness('judge-secret-echo');const s1=await seed(h);h.boat.stopIdText=apiKey;h.boat.stopMode='failing-stopping';
    await idleStopAttempt(h,s1);await settle(h.emit('issue.comment.created'));await advance(5_000);
    expect(h.warnings.some(w=>w.includes('backing off'))).toBe(true);
    expect(h.warnings.join('\n')).not.toContain(apiKey);
  });
  it('JUDGE-BACKOFF-PERSON: failed stop hold does not delay an ordinary run create',async()=>{
    const h=await harness('judge-person');const s1=await seed(h);h.boat.stopMode='failing-stopping';await idleStopAttempt(h,s1);
    const before=h.boat.creates().length,runBefore=h.boat.creates('run').length;const at=Date.now();
    const lease=await settle(h.acquire('run-person'));await advance(5_000);
    expect(lease.providerLeaseId).not.toBe(s1);expect(h.boat.creates('run').length).toBe(runBefore+1);expect(h.boat.creates().length).toBe(before);
    expect(Date.now()-at).toBeLessThan(15_000);
  });
});
