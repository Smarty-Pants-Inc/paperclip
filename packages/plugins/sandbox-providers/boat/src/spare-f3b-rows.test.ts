// rf-4 U1 F1/F5/F7 rows (adopt-boat-spare-f3b). Harness copied from rf-4's
// judge-spare-pool-safety.test.ts, extended so a restarted worker can keep the
// host's durable plugin state (as a real worker restart does) and the config
// read can fail.
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
  hydrated: boolean; hydratedAt: string;
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
        hydrated: true, hydratedAt: new Date().toISOString(),
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
type Harness = { boat: FakeBoat; company: string; env: string; config: SpareConfig; warnings: string[]; state: Map<string, unknown>; configReadFails?: boolean;
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

async function harness(name: string, existingBoat?: FakeBoat, existingState?: Map<string, unknown>): Promise<Harness> {
  const boat = existingBoat ?? new FakeBoat();
  vi.stubGlobal("fetch", boat.fetch);
  const company = `company-${name}`, env = `environment-${name}`;
  const state = existingState ?? new Map<string, unknown>();
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
    config: { get: async () => { if (h.configReadFails) throw new Error("planted host config read failure"); return { ...config }; } },
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
    boat, company, env, config, warnings, state,
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
  if (observed && process.env.SPARE_F3B_TRACE_DIR) {
    const dir = process.env.SPARE_F3B_TRACE_DIR;
    mkdirSync(dir,{recursive:true});
    writeFileSync(`${dir}/${observed.company}.json`,JSON.stringify({log:observed.boat.log, boxes:[...observed.boat.boxes.values()], testEndLogEntries, testEndBoxes, hiddenInventoryIds:[...observed.boat.hiddenInventoryIds], warnings:observed.warnings},null,2));
  }
  eventHandlers.clear();
  current = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("rf-4 U1 F5: the failed-stop hold is durable", () => {
  it("F5-DURABLE a worker restart that keeps the host's durable state still owes the hold and the stop (planted LIST omission as rf-4's RESTART-LOSS)", async () => {
    const h = await harness("f5-durable"); const s1 = await seed(h); h.boat.stopMode = "failing-stopping"; await idleStopAttempt(h, s1);
    h.boat.hiddenInventoryIds.add(s1);
    const before = h.boat.creates().length, stopsBefore = h.boat.stopPosts(s1).length;
    await settle(Promise.resolve(plugin.definition.onShutdown?.())); eventHandlers.clear();
    const restarted = await harness("f5-durable", h.boat, h.state);
    await settle(restarted.acquire("run-after-restart")); await advance(5_000);
    await settle(restarted.emit("issue.comment.created")); await advance(5_000);
    expect(h.boat.creates().length, "the 15-minute hold survives the restart").toBe(before);
    expect(h.boat.stopPosts(s1).length, "the owed stop of the unlisted spare is retried").toBeGreaterThan(stopsBefore);
  });
});

describe("rf-4 U1 F1: an unreadable setting creates nothing", () => {
  it("F1-READ-ERROR config read fails at the create: zero spare POSTs, one warning", async () => {
    const h = await harness("f1-read-error"); const s1 = await seed(h); await idleStopAttempt(h, s1);
    expect(h.boat.boxes.get(s1)!.state).toBe("archived");
    h.configReadFails = true;
    const before = h.boat.creates("spare").length;
    await settle(h.emit("issue.comment.created")); await advance(5_000);
    await settle(h.emit("agent.run.started")); await advance(5_000);
    expect(h.boat.creates("spare").length).toBe(before);
    expect(h.warnings.filter(w => w.includes("setting re-read failed"))).toHaveLength(1);
  });
});

describe("rf-4 U1 F7: the back-off record passes the one redactor", () => {
  it("F7-KEEPER-REDACT a stop error carrying a key is stored and reported only through operations.redact", async () => {
    const secret = "boat_sk_f3b_secret_value";
    const key = { companyId: "company-f7", environmentId: "env-f7", configHash: "f7hash" };
    const labels = { owner: `paperclip:${key.companyId}`, environment: key.environmentId, purpose: "spare", configHash: key.configHash, expiry: new Date(Date.now() + 1_800_000).toISOString() };
    const box = { id: "bx_f7spare1", key, state: "running", warmed: true, expiresAt: labels.expiry, name: `paperclip-spare:ready:${key.configHash}`, labels };
    const spareKeeper = new keeper.ReadySpareKeeper();
    const reported: unknown[] = [];
    spareKeeper.setStopBackoffListener(backoff => { reported.push(backoff); });
    const ops = {
      list: async () => [box], get: async () => box, create: async () => { throw new Error("no create expected"); },
      claim: async () => false, refresh: async () => box,
      stop: async () => { throw new Error(`Boat stop stop_${secret} refused`); },
      redact: (text: string) => text.split(secret).join("[REDACTED]"),
    };
    await spareKeeper.reconcile(key, 0, ops as any).catch(() => undefined);
    await spareKeeper.reconcile(key, 1, { ...ops, list: async () => [] } as any).catch(() => undefined);
    expect(reported).toHaveLength(1);
    expect(JSON.stringify(reported)).not.toContain(secret);
    expect(JSON.stringify(reported)).toContain("[REDACTED]");
  });
});
