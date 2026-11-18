// Ready-spare pool safety (gates 2/4/5, 2026-11-18): the plugin's REAL hooks,
// event handlers, keeper (queueSpareReconciliation, wakeCompanySparePools,
// claimWithOutcome, stopSpare, reconcileOnce) and claim store against a
// STATEFUL fake Boat, on one fake clock (the wake-race harness, extended with
// Boat's stop records). Anything a test sets directly instead of letting the
// plugin produce it is named "planted".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  stopMode: StopMode = "complete";
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
      const stop: StopRecord = { id: box.stop?.id ?? `stop_${box.id}`, status: "pending" };
      if (this.stopMode === "complete") { box.state = "archived"; box.stop = { ...stop, status: "completed" }; }
      else {
        box.stop = { ...stop, status: "failing", error: FINAL_SNAPSHOT_FAILED };
        box.state = this.stopMode === "failing-stopping" ? "stopping" : "idle";
      }
      return response({ stop: { ...stop } }, 202);
    }
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

async function harness(name: string): Promise<Harness> {
  const boat = new FakeBoat();
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
  const warn = (message: string) => { warnings.push(message); boat.record({ kind: "warn", note: message }); };
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
  await settle(Promise.resolve(plugin.definition.onShutdown?.()));
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
