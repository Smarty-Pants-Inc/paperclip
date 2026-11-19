// rf-4 U1 F2/F3 (2026-11-19): the claim race and the off-vs-create races, on
// rf-4's harness (copied verbatim from judge-spare-pool-safety.test.ts, plus a
// PATCH-time stop hook). Ready-spare pool safety: the plugin's REAL hooks,
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
  /** A stop appears right after Boat answers the claim PATCH (before the verification GET). */
  sickenAfterPatchId?: string;
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
      const answer = response({ sandbox: { ...box } });
      if (this.sickenAfterPatchId === id) { this.sickenAfterPatchId = undefined; box.state = 'idle'; box.stop = { id: 'stop_race_patch', status: 'pending' }; }
      return answer;
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
    const dir = `${process.env.TASK_OUT}/traces-f2-${process.env.JUDGE_VARIANT ?? 'head'}`;
    mkdirSync(dir,{recursive:true});
    writeFileSync(`${dir}/${observed.company}.json`,JSON.stringify({log:observed.boat.log, boxes:[...observed.boat.boxes.values()], testEndLogEntries, testEndBoxes, hiddenInventoryIds:[...observed.boat.hiddenInventoryIds], warnings:observed.warnings},null,2));
  }
  eventHandlers.clear();
  current = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("rf-4 U1 F2: a claim re-checks the stop after claiming", () => {
  it("F2-a a stop that appears between the clean GET and the claim PATCH: the run gets a COLD box, the sick spare is not handed out", async () => {
    const h = await harness("f2-race-get-patch");
    const s1 = await seed(h);
    h.boat.sickenAfterReadId = s1; // Boat records a stop right after answering the pre-claim GET clean
    const runsBefore = h.boat.creates("run").length;
    const lease = await settle(h.acquire("run-f2-a"));
    expect(h.boat.patchesOf(s1).length, "the claim PATCH did reach Boat (the race is after the GET)").toBeGreaterThan(0);
    expect(lease.providerLeaseId).not.toBe(s1);
    expect(h.boat.creates("run").length, "one cold run box").toBe(runsBefore + 1);
    expect(lease.providerLeaseId).toBe(h.boat.creates("run").at(-1)!.id);
    expect(h.warnings.some(w => w.includes("claim abandoned"))).toBe(true);
    // No force, no delete: the abandoned spare is left to Boat's own stop and TTL.
    expect(h.boat.stopPosts(s1)).toHaveLength(0);
    expect(h.boat.log.some(e => e.kind === "boat" && e.method === "DELETE")).toBe(false);
  });
  it("F2-b a stop that appears after the claim PATCH, before the verification GET: the run gets a COLD box", async () => {
    const h = await harness("f2-race-patch-get");
    const s1 = await seed(h);
    h.boat.sickenAfterPatchId = s1;
    const runsBefore = h.boat.creates("run").length;
    const lease = await settle(h.acquire("run-f2-b"));
    expect(lease.providerLeaseId).not.toBe(s1);
    expect(h.boat.creates("run").length, "one cold run box").toBe(runsBefore + 1);
    expect(h.boat.stopPosts(s1)).toHaveLength(0);
  });
  it("F2-CONTROL a healthy spare with no stop is still claimed warm (no cold run box)", async () => {
    const h = await harness("f2-control");
    const s1 = await seed(h);
    const runsBefore = h.boat.creates("run").length;
    const lease = await settle(h.acquire("run-f2-control"));
    expect(lease.providerLeaseId).toBe(s1);
    expect(h.boat.creates("run").length).toBe(runsBefore);
  });
});

describe("rf-4 U1 F3: off is never undone by a late adoption or an unsent create", () => {
  it("F3-a a late adoption after an acquire read 'off' (no config event) queues no spare", async () => {
    const h = await harness("f3-late-adoption-acquire-off");
    h.boat.listDelayOnceMs = 2_400; // the first acquire's adoption LIST answers late
    const first = h.acquire("run-f3a-first");
    await advance(200);
    h.config.spares = 0;
    const offAt = Date.now();
    await settle(h.acquire("run-f3a-off")); // reads 'off' and applies it
    await settle(first);
    await advance(15_000);
    expect(h.boat.creates().filter(e => e.at >= offAt && e.purpose === "spare")).toHaveLength(0);
  });
  it("F3-b 'off' delivered while a wake's reconcile waits on Boat's environment LIST: the unsent spare POST is skipped", async () => {
    const h = await harness("f3-off-during-list");
    const s1 = await seed(h);
    await idleStopAttempt(h, s1);
    h.boat.listDelayOnceMs = 2_400;
    const wake = h.emit("issue.comment.created");
    await advance(100);
    h.config.spares = 0;
    const offAt = Date.now();
    const off = Promise.resolve(plugin.definition.onConfigChanged!({ ...h.config }, { companyId: h.company } as any));
    await settle(Promise.all([wake, off]));
    await advance(5_000);
    expect(h.boat.creates().filter(e => e.at >= offAt)).toHaveLength(0);
  });
  it("F3-CONTROL a config change that keeps spares on during a wake's LIST still refills the pool", async () => {
    const h = await harness("f3-on-during-list");
    const s1 = await seed(h);
    await idleStopAttempt(h, s1);
    h.boat.listDelayOnceMs = 2_400;
    const before = h.boat.creates("spare").length;
    const wake = h.emit("issue.comment.created");
    await advance(100);
    const same = Promise.resolve(plugin.definition.onConfigChanged!({ ...h.config }, { companyId: h.company } as any));
    await settle(Promise.all([wake, same]));
    await advance(5_000);
    expect(h.boat.creates("spare").length, "exactly one refill").toBe(before + 1);
  });
});
