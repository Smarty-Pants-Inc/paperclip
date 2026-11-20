// Keep: BRIEF r1-r5, the never-idle policy and money/OFF boundary. The real
// SDK worker RPC host runs the plugin; only Boat and host persistence are fake.
// No live Boat, server startup, first-fill-after-restart or model claim.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { Ajv } from "ajv";
import { startWorkerRpcHost } from "@paperclipai/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "./manifest.js";
import plugin, { spareActivityIsRecent } from "./plugin.js";
import { readySpareIdleMinutes } from "./ready-spares.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown) => new Promise(resolve => globalThis.setTimeout(() => resolve(value), ms)),
}));

const START = Date.UTC(2026, 10, 20, 9, 27);
const company = "company-never-idle", environment = "environment-never-idle";
const leaseConfig = { apiKey: "boat_never_idle_fixture", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
type Box = { id: string; state: string; name: string; labels: Record<string, string>; hydrated: boolean;
  hydratedAt: string; archiveAfter: string; createdAt: string; team: { id: string } };
type Entry = { at: number; method: string; path: string; id?: string; body?: any };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

class Boat {
  boxes = new Map<string, Box>();
  calls: Entry[] = [];
  maxReady = 0;
  stops() { return this.calls.filter(c => c.path.endsWith("/stop") && this.boxes.get(c.id!)?.labels.purpose === "spare"); }
  ready() { return [...this.boxes.values()].filter(b => b.labels.purpose === "spare" && b.state === "ready" && b.name.startsWith("paperclip-spare:ready:")); }
  readonly fetch = async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input)), path = url.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const id = /^\/sandboxes\/([^/]+)/.exec(path)?.[1];
    this.calls.push({ at: Date.now(), method, path, id, body });
    // Boat's finite TTL is real in this fixture: a missed renewal loses the box.
    for (const box of this.boxes.values()) if (Date.parse(box.archiveAfter) <= Date.now()) box.state = "archived";
    if (method === "POST" && path === "/sandboxes") {
      const box: Box = { id: `bx_neveridle_${this.boxes.size}`, state: "ready", name: "", labels: { ...body.labels },
        hydrated: true, hydratedAt: new Date().toISOString(), createdAt: new Date().toISOString(),
        archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString(), team: { id: "team-fixture" } };
      this.boxes.set(box.id, box);
      this.maxReady = Math.max(this.maxReady, [...this.boxes.values()].filter(b => b.labels.purpose === "spare" && b.state === "ready" && !b.name.startsWith("paperclip-claim:")).length);
      return response({ sandbox: box }, 202);
    }
    if (method === "GET" && path === "/sandboxes") {
      const matching = [...this.boxes.values()].filter(b => url.searchParams.getAll("label").every(label => {
        const [key, ...value] = label.split("="); return b.labels[key] === value.join("=");
      }));
      return response({ sandboxes: matching, pageInfo: { nextCursor: null } });
    }
    const box = id ? this.boxes.get(id) : undefined;
    if (method === "GET" && box && path === `/sandboxes/${id}`) return response({ sandbox: box });
    if (method === "PATCH" && box && path === `/sandboxes/${id}`) {
      if (body.name) box.name = body.name;
      if (body.ttlSeconds && box.state !== "archived") box.archiveAfter = new Date(Date.now() + body.ttlSeconds * 1000).toISOString();
      return response({ sandbox: box });
    }
    if (method === "POST" && box && path.endsWith("/stop")) {
      box.state = "archived";
      return response({ operation: { id: `stop-${id}`, status: "completed" } }, 202);
    }
    if (method === "PUT" && path.endsWith("/files")) return response({ success: true });
    if (method === "POST" && path.endsWith("/commands")) return response({ exitCode: 0, timedOut: false, stdout: "{}\n", stderr: "" });
    throw new Error(`Unexpected fake Boat request ${method} ${path}`);
  };
}

async function settle<T>(work: Promise<T>): Promise<T> {
  let done = false, failed = false, value: T | undefined, error: unknown;
  void work.then(v => { value = v; done = true; }, e => { error = e; failed = done = true; });
  for (let i = 0; !done && i < 3000; i++) await vi.advanceTimersByTimeAsync(10);
  if (!done) throw new Error("worker RPC did not settle within 30s fake time");
  if (failed) throw error;
  return value as T;
}

type Harness = Awaited<ReturnType<typeof start>>;
let current: Harness | undefined;
async function start(idleMinutes: number, boat = new Boat(), state = new Map<string, unknown>()) {
  vi.stubGlobal("fetch", boat.fetch);
  const config = { spares: 1, spareMax: 1, spareEnvironmentIds: [environment], spareIdleMinutes: idleMinutes };
  const input = new PassThrough(), output = new PassThrough(), lines = createInterface({ input: output });
  const pending = new Map<string, { resolve(value: any): void; reject(error: unknown): void }>();
  const hostCalls: Entry[] = [];
  const claims = new Set<string>();
  const host = startWorkerRpcHost({ plugin, stdin: input, stdout: output, rpcTimeoutMs: 10_000 });
  lines.on("line", line => {
    const message = JSON.parse(line), call = pending.get(message.id);
    if (call) {
      pending.delete(message.id);
      if (message.error) call.reject(message.error); else call.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      const p = message.params ?? {};
      const key = `${p.scopeId}:${p.namespace}:${p.stateKey}`;
      let result: unknown = null;
      hostCalls.push({ at: Date.now(), method: message.method, path: p.stateKey ?? "" });
      switch (message.method) {
        case "config.get": result = config; break;
        case "state.get": result = state.get(key) ?? null; break;
        case "state.set": state.set(key, p.value); break;
        case "state.delete": state.delete(key); break;
        case "db.execute": {
          const id = String(p.params?.[0]);
          result = { rowCount: claims.has(id) ? 0 : 1 }; claims.add(id); break;
        }
        case "db.query": result = claims.has(String(p.params?.[0])) ? [{ provider_lease_id: p.params[0] }] : []; break;
        case "events.subscribe": break;
        default: throw new Error(`Unexpected host RPC ${message.method}`);
      }
      input.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
    }
  });
  let sequence = 0;
  const rpc = (method: string, params: unknown = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = `neveridle-${++sequence}`;
    pending.set(id, { resolve, reject });
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const h = { boat, state, config, rpc, hostCalls,
    async close() {
      await settle(rpc("shutdown"));
      await vi.advanceTimersByTimeAsync(1);
      host.stop(); lines.close(); input.destroy(); output.destroy();
      expect(pending.size).toBe(0);
    },
    async seed(run = "seed") {
      const lease = await settle(rpc("environmentAcquireLease", { driverKey: "boat", companyId: company, environmentId: environment,
        runId: run, creationOperationId: `attempt-${run}`, config: leaseConfig }));
      await vi.advanceTimersByTimeAsync(5000);
      expect(boat.ready()).toHaveLength(1);
      // End the seed run so its independent RUN TTL timer is not mistaken for
      // spare renewal after idle/OFF. Warm-claim rows keep their run separate.
      if (run === "seed") await settle(rpc("environmentReleaseLease", { driverKey: "boat", companyId: company,
        environmentId: environment, providerLeaseId: lease.providerLeaseId, config: leaseConfig }));
      return lease;
    },
  };
  current = h;
  const initialized = await settle(rpc("initialize", { manifest, config, apiVersion: 1,
    databaseNamespace: "boat_sandbox_provider", instanceInfo: { instanceId: "never-idle-fixture", hostVersion: "test" } }));
  expect(initialized.supportedMethods).toContain("environmentAcquireLease");
  await settle(rpc("configChanged", { companyId: company, config }));
  return h;
}
function evidence(row: string, h: Harness, extra: Record<string, unknown> = {}) {
  const result = { row, version: manifest.version, now: Date.now(), readyIds: h.boat.ready().map(b => b.id),
    maxReady: h.boat.maxReady, calls: h.boat.calls, hostCalls: h.hostCalls, ...extra };
  console.log("NEVER_IDLE_ROW", JSON.stringify({ row, version: manifest.version, now: result.now, readyIds: result.readyIds, ...extra }));
  if (process.env.BOAT_NEVER_IDLE_EVIDENCE_DIR) {
    mkdirSync(process.env.BOAT_NEVER_IDLE_EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(process.env.BOAT_NEVER_IDLE_EVIDENCE_DIR, `${row}.json`), JSON.stringify(result, null, 2) + "\n");
  }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(async () => {
  try { if (current) await current.close(); }
  finally { current = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); }
});

describe("Boat never-idle spares through real worker RPC", () => {
  it("r1: 0 keeps and renews the same spare for 25h without activity, and still refills at the bound", async () => {
    const h = await start(0);
    await h.seed();
    const spare = h.boat.ready()[0], from = Date.now();
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000);
    const renewals = h.boat.calls.filter(c => c.method === "PATCH" && c.id === spare.id && c.body?.ttlSeconds);
    evidence("r1-25h", h, { renewals: renewals.length, elapsedMs: Date.now() - from, spareStopTimes: h.boat.stops().map(c => c.at) });
    expect(h.boat.ready().map(b => b.id), "the same ready box survives 25h").toEqual([spare.id]);
    expect(renewals.length).toBeGreaterThan(25);
    expect(renewals.at(-1)!.at).toBeGreaterThan(from + 24 * 60 * 60_000);
    expect(Date.parse(spare.archiveAfter)).toBeGreaterThan(Date.now());
    expect(h.boat.stops()).toEqual([]);
    const claim = await h.seed("after-25h");
    expect(claim.providerLeaseId).toBe(spare.id);
    expect(h.boat.ready()[0].id).not.toBe(spare.id);
    expect(h.boat.maxReady).toBe(1);
    evidence("r1-refill", h, { claimedId: claim.providerLeaseId });
  });

  it("r2: 60 still stops after 60m idle and does not renew or replace afterward", async () => {
    const h = await start(60);
    await h.seed();
    const spare = h.boat.ready()[0];
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(h.boat.ready().map(b => b.id)).toEqual([spare.id]);
    expect(h.boat.stops()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(spare.state).toBe("archived");
    const stops = h.boat.stops();
    expect(stops).toHaveLength(1);
    expect(stops[0].at).toBeGreaterThan(START + 60 * 60_000);
    expect(stops[0].body?.force).not.toBe(true);
    const atStop = h.boat.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.boat.calls.slice(atStop).some(c => c.method === "PATCH" || c.method === "POST")).toBe(false);
    evidence("r2-60m", h, { stopAt: stops[0].at });
  });

  it.each([true, false])("r3: 0 then spares=0 retires non-force and stops its timer (config event=%s)", async delivered => {
    const h = await start(0);
    await h.seed();
    h.config.spares = 0;
    if (delivered) await settle(h.rpc("configChanged", { companyId: company, config: h.config }));
    else await vi.advanceTimersByTimeAsync(15_000);
    expect(h.boat.ready()).toEqual([]);
    const stops = h.boat.stops();
    expect(stops).toHaveLength(1);
    expect(stops[0].body?.force).not.toBe(true);
    const before = h.boat.calls.length, reads = h.hostCalls.filter(c => c.method === "config.get").length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.boat.calls).toHaveLength(before);
    expect(h.hostCalls.filter(c => c.method === "config.get")).toHaveLength(reads);
    evidence(delivered ? "r3-off-event" : "r3-off-durable", h, { noFurtherBoatCalls: true, noFurtherConfigReads: true });
  });

  it("r4: actual JSON Schema accepts 0 and 15-1440 only; runtime parsing agrees", () => {
    const validate = new Ajv({ strict: false }).compile(manifest.instanceConfigSchema!);
    for (const minutes of [0, 15, 60, 1440]) {
      expect(validate({ spareIdleMinutes: minutes }), `accept ${minutes}`).toBe(true);
      expect(readySpareIdleMinutes({ spareIdleMinutes: minutes })).toBe(minutes);
    }
    for (const minutes of [-1, ...Array.from({ length: 14 }, (_, i) => i + 1), 1441, 0.5, "0", null]) {
      expect(validate({ spareIdleMinutes: minutes }), `reject ${minutes}`).toBe(false);
      expect(readySpareIdleMinutes({ spareIdleMinutes: minutes })).toBe(60);
    }
    expect(validate({})).toBe(true);
    expect(readySpareIdleMinutes({})).toBe(60);
    console.log("NEVER_IDLE_ROW", JSON.stringify({ row: "r4-schema", accepted: [0, 15, 60, 1440], rejected: "-1, 1-14, 1441, fraction, string, null", default: 60 }));
  });

  it("r5: after worker restart with unknown persisted activity, 0 admits the existing pool and keeps it warm", async () => {
    const first = await start(0);
    await first.seed();
    const spareId = first.boat.ready()[0].id;
    await first.close(); current = undefined;
    for (const key of first.state.keys()) if (key.endsWith(":company-activity")) first.state.delete(key);
    const h = await start(0, first.boat, first.state);
    expect([...h.state.keys()].some(key => key.endsWith(":company-activity"))).toBe(false);
    // Pin the real policy's unknown-state decision separately: pool discovery
    // requires reacquisition (first fill after restart is outside this task),
    // and reacquisition itself would record activity and mask this boundary.
    expect(spareActivityIsRecent({}, 0), "unknown activity is active in never-idle mode").toBe(true);
    expect(spareActivityIsRecent({}, 60), "unknown activity stays idle for a finite timeout").toBe(false);
    expect(h.hostCalls.some(c => c.method === "state.get" && c.path === "company-activity")).toBe(true);
    const lease = await h.seed("restart-reacquire");
    expect(lease.providerLeaseId).toBe(spareId);
    const replacementId = h.boat.ready()[0].id;
    await vi.advanceTimersByTimeAsync(25 * 60 * 60_000);
    expect(h.boat.ready().map(b => b.id)).toEqual([replacementId]);
    expect(h.boat.stops()).toEqual([]);
    evidence("r5-restart", h, { startupActivityUnknown: true, reclaimedId: spareId });
  });
});
