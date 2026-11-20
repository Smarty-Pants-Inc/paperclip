import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginEnvironmentCreationCleanupError, PluginEnvironmentStopError } from "@paperclipai/plugin-sdk";
import plugin, { BoatStopRefusedError } from "./plugin.js";

// Keep: rf-4's review of Boat unit #2 (RF4-VERDICT F1-F4, J-rows J5, J7-J9, J14-J16, J18).
// Boat's refused stop of 18 Nov: its words must reach the person, but never another
// credential; a person's Resume must really cancel the refused stop; and no hook may
// send HTTP inside the back-off. Synthetic keys and sentinels and a fake Boat only.
//
// Boat's DOCUMENTED shapes (staged boat-llms-full.txt):
// - POST /sandboxes/{id}/stop -> 202 `stop` {id, status}; again while pending -> same id (:1850-1856).
// - GET /sandboxes/{id}/stops/{stopId} -> that stop; 404 when the id is unknown (:1785-1789).
// - A failed save "shows `failing` with its `error`"; the box keeps running; "Only a resume
//   ends it early (`superseded`)" (:1846-1856); "a resume cancels the stop" (:15380).
// - GET /sandboxes/{id} carries `stop` and `snapshotCompletedAt` (:16255).
const KEY = "synthetic-boat-key-rf4";
const BOAT_REFUSAL = "Refusing archive/stop: no successful snapshot in the last 30 minutes";
const LAST_GOOD = "2026-11-18T17:12:04Z";
// J7: another bearer credential and signed-URL tokens inside Boat's legitimate `stop.error` string.
const HOSTILE_ERROR = `${BOAT_REFUSAL}; upload failed: Authorization: Bearer JUDGE_OTHER_BEARER_TOKEN `
  + `PUT https://snap.example/obj?X-Amz-Signature=JUDGE_AMZ_SIGNATURE&X-Amz-Credential=JUDGE_AMZ_CREDENTIAL&sig=JUDGE_SIG_TOKEN&_token=JUDGE_SIGNED_URL_TOKEN&token=JUDGE_PLAIN_TOKEN`;
const SENTINELS = [KEY, "JUDGE_OTHER_BEARER_TOKEN", "JUDGE_AMZ_SIGNATURE", "JUDGE_AMZ_CREDENTIAL", "JUDGE_SIG_TOKEN", "JUDGE_SIGNED_URL_TOKEN", "JUDGE_PLAIN_TOKEN"];
let boxes = 0, id = "bx_r0000000";
const config = { hydrationWaitSeconds: 0, apiKey: KEY, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const scope = { driverKey: "boat", companyId: "c", environmentId: "e", config };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
type Call = { method: string; route: string; body?: any; at: number };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
/** Everything that could leave the worker: the error's message, stack, fields and JSON, and every log line. */
function outbound(error: unknown): string {
  const e = error as any;
  return [String(e), e?.message, e?.stack, JSON.stringify(e), e?.boatError, e?.boatStatus, e?.lastGoodSnapshotAt, e?.stopId,
    JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls, logger.debug.mock.calls])].join("\n");
}
function noSecrets(text: string) { for (const secret of SENTINELS) expect(text).not.toContain(secret); }
type Planted = { record?: (stopId: string) => Response; box?: (calls: Call[]) => Record<string, unknown>; extra?: (method: string, route: string, body: any) => Response | undefined };
/** A fake Boat box: each POST /stop returns a new pending stop; `record` answers the stop record read. */
function fakeBoat(planted: Planted) {
  let n = 0;
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const method = init.method ?? "GET", url = new URL(String(input)), route = url.pathname.replace("/api/v1", "");
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, route, body, at: Date.now() });
    const extra = planted.extra?.(method, route, body);
    if (extra) return extra;
    if (method === "POST" && route === `/sandboxes/${id}/stop`) {
      n++; const sent = `stop_${String(n).padStart(16, "0")}`;
      return json({ stop: { id: sent, status: "pending" }, statusUrl: `/sandboxes/${id}/stops/${sent}` }, 202);
    }
    if (method === "GET" && route === `/sandboxes/${id}`) return json({ sandbox: { id, state: "running", snapshotCompletedAt: LAST_GOOD, ...planted.box?.(calls) } });
    if (method === "GET" && route.startsWith(`/sandboxes/${id}/stops/`)) return planted.record!(decodeURIComponent(route.split("/").pop()!));
    throw new Error(`unexpected ${method} ${route}`);
  }));
  const count = (method: string, suffix: string, after = 0) =>
    calls.slice(after).filter(c => c.method === method && (suffix.endsWith("/") ? c.route.startsWith(`/sandboxes/${id}${suffix}`) : c.route === `/sandboxes/${id}${suffix}`)).length;
  return { calls, count };
}
const stopLease = (extra: Record<string, unknown> = {}) =>
  plugin.definition.onEnvironmentStopLease!({ ...scope, providerLeaseId: id, ...extra } as any);
const failingRecord = (error: unknown = BOAT_REFUSAL, more: Record<string, unknown> = {}) =>
  (stopId: string) => json({ stop: { id: stopId, status: "failing", error, ...more } });
beforeEach(async () => { id = `bx_r${String(++boxes).padStart(7, "0")}`; await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("rf-4 F1: every outbound Boat diagnostic is sanitised at one source", () => {
  it("J7 another bearer token and signed-URL tokens in Boat's stop.error never reach the error, its fields or the RPC message; Boat's words do", async () => {
    fakeBoat({ record: failingRecord(HOSTILE_ERROR) });
    const error = await stopLease().catch(e => e);
    expect(error).toBeInstanceOf(BoatStopRefusedError);
    expect(error.message).toContain(BOAT_REFUSAL);
    expect(error.boatError).toContain(BOAT_REFUSAL);
    expect(error.boatError).toContain("[REDACTED]");
    noSecrets(outbound(error));
    // The cached repeat inside the back-off carries the same sanitised words.
    const again = await stopLease().catch(e => e);
    expect(again.boatError).toBe(error.boatError);
    noSecrets(outbound(again));
  }, 10_000);

  it("J7b Boat's error as an object {code, message} with a bearer token is sanitised too", async () => {
    fakeBoat({ record: failingRecord({ code: "snapshot_failed", message: `PUT failed: Bearer JUDGE_OTHER_BEARER_TOKEN ${KEY}` }) });
    const error = await stopLease().catch(e => e);
    expect(error.boatError).toContain("snapshot_failed");
    noSecrets(outbound(error));
  }, 10_000);

  it("J8 a snapshotCompletedAt that is not a timestamp (carrying the key) is not reported as the last good snapshot", async () => {
    fakeBoat({ record: failingRecord(BOAT_REFUSAL, { snapshotCompletedAt: `x ${KEY} Bearer JUDGE_OTHER_BEARER_TOKEN` }) });
    const error = await stopLease().catch(e => e);
    expect(error).toBeInstanceOf(BoatStopRefusedError);
    expect(error.lastGoodSnapshotAt).toBeNull();
    noSecrets(outbound(error));
  }, 10_000);

  it("J9 an unknown stop status carrying the key or a token is not echoed raw (record and sandbox paths)", async () => {
    fakeBoat({ record: (stopId) => json({ stop: { id: stopId, status: `weird_${KEY}_Bearer JUDGE_OTHER_BEARER_TOKEN` } }) });
    const error = await stopLease().catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PluginEnvironmentStopError);
    noSecrets(outbound(error));
    // The sandbox's own unknown status (record unknown: 404) takes the same source.
    id = `bx_r${String(++boxes).padStart(7, "0")}`;
    fakeBoat({ record: () => json({ error: "not_found" }, 404),
      box: () => ({ stop: { id: "stop_0000000000000001", status: `odd?token=JUDGE_PLAIN_TOKEN&sig=JUDGE_SIG_TOKEN ${KEY}` } }) });
    const fallback = await stopLease().catch(e => e);
    expect(fallback).toBeInstanceOf(Error);
    noSecrets(outbound(fallback));
  }, 10_000);

  it("J16 a 429 body.code carrying the key or a bearer token is logged sanitised (pre-existing path, plugin.ts 429 log)", async () => {
    let limited = 0;
    fakeBoat({ record: failingRecord(),
      extra: (method, route) => method === "GET" && route === `/sandboxes/${id}` && limited++ === 0
        ? json({ code: `RATE_${KEY}_Bearer JUDGE_OTHER_BEARER_TOKEN` }, 429, { "Retry-After": "0" }) : undefined });
    // A non-rate_limited 429 code is not resent: the poll's request fails (as today); its log line is the point.
    const error = await stopLease().catch(e => e);
    expect(error).toBeInstanceOf(Error);
    const warned = logger.warn.mock.calls.filter(([message]) => message === "Boat API 429");
    expect(warned).toHaveLength(1);
    expect(warned[0][1]).toHaveProperty("code");
    noSecrets(outbound(error));
  }, 10_000);
});

describe("rf-4 F2: a person's Resume of a RUNNING box whose stop Boat refused cancels that stop", () => {
  const runnerConfig = { hydrationWaitSeconds: 0, apiKey: KEY, reuseLease: true, ttlSeconds: 1800, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 600_000 };
  const runnerScope = { driverKey: "boat", companyId: "c", environmentId: "e", config: runnerConfig };
  /** A Runner box, acquired through the real acquire hook with its workspace sentinel. */
  function runnerBoat() {
    let sentinel: unknown, n = 0;
    const box: { state: string; stop: null | { id: string; status: string; error?: string } } = { state: "ready", stop: null };
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
      const method = init.method ?? "GET", url = new URL(String(input)), route = url.pathname.replace("/api/v1", "");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, route, body, at: Date.now() });
      const sandbox = () => ({ id, state: box.state, archiveAfter: new Date(Date.now() + 1_800_000).toISOString(), snapshotCompletedAt: LAST_GOOD, ...(box.stop ? { stop: box.stop } : {}) });
      if (method === "POST" && route === "/sandboxes") { id = `bx_rn${String(boxes).padStart(8, "0")}`; return json({ sandbox: { id, state: "ready" } }, 202); }
      if (route === `/sandboxes/${id}` && method === "GET") return json({ sandbox: sandbox() });
      if (route === `/sandboxes/${id}` && method === "PATCH") return json({ sandbox: sandbox() });
      if (method === "POST" && route === `/sandboxes/${id}/stop`) {
        // Boat refuses: the save fails, the box keeps running (:1846-1854).
        if (!box.stop || box.stop.status !== "failing") { n++; box.stop = { id: `stop_${String(n).padStart(16, "0")}`, status: "failing", error: BOAT_REFUSAL }; }
        return json({ stop: { id: box.stop.id, status: "pending" } }, 202);
      }
      if (method === "GET" && route.startsWith(`/sandboxes/${id}/stops/`)) return json({ stop: box.stop });
      if (method === "POST" && route === `/sandboxes/${id}/resume`) {
        // "Only a resume ends it early (`superseded`)" (:1855); "a resume cancels the stop" (:15380).
        if (box.stop && ["pending", "failing"].includes(box.stop.status)) box.stop = { ...box.stop, status: "superseded" };
        box.state = "ready";
        return json({ sandbox: sandbox() }, 202);
      }
      if (route === `/sandboxes/${id}/files` && method === "PUT") { sentinel = JSON.parse(body.content); return json({ success: true }); }
      if (route === `/sandboxes/${id}/files`) return json({ content: JSON.stringify(sentinel), encoding: "utf8" });
      if (route === `/sandboxes/${id}/commands`) return json({ exitCode: 0, timedOut: false, stdout: body?.command?.includes("cat ") ? JSON.stringify(sentinel) : "", stderr: "" });
      throw new Error(`unexpected ${method} ${route}`);
    }));
    const count = (method: string, suffix: string, after = 0) => calls.slice(after).filter(c => c.method === method && c.route === `/sandboxes/${id}${suffix}`).length;
    return { box, calls, count };
  }
  afterEach(async () => { await plugin.definition.onShutdown?.(); });

  it("J14 Stop is refused, Resume POSTs /resume (not just a TTL PATCH), and the next Stop sends a real POST /stop", async () => {
    const boat = runnerBoat();
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...runnerScope, runId: "run-j14", agentId: "agent", executionWorkspaceId: "ws", adapterType: "paperclip_runner" } as any);
    expect(lease.providerLeaseId).toBe(id);
    boat.box.state = "running";
    const stopIt = () => plugin.definition.onEnvironmentStopLease!({ ...runnerScope, providerLeaseId: id, leaseMetadata: lease.metadata } as any);
    const refused = await stopIt().catch(e => e);
    expect(refused).toBeInstanceOf(BoatStopRefusedError);
    expect(boat.count("POST", "/stop")).toBe(1);
    // The box is RUNNING with Boat's failing stop: the warm branch used to only PATCH the TTL.
    let mark = boat.calls.length;
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...runnerScope, providerLeaseId: id, leaseMetadata: lease.metadata } as any);
    expect(resumed.providerLeaseId).toBe(id);
    expect(boat.count("POST", "/resume", mark)).toBe(1);
    expect(boat.box.stop?.status).toBe("superseded");
    // The refusal is forgotten: the next Stop sends a real POST /stop, not the cached refusal.
    mark = boat.calls.length;
    const next = await stopIt().catch(e => e);
    expect(boat.count("POST", "/stop", mark)).toBe(1);
    expect(next).toBeInstanceOf(BoatStopRefusedError);
    expect(next.stopId).toBe("stop_0000000000000002");
  }, 20_000);

  it("J14b a warm Resume of a running box with no refused stop still only renews its TTL (no resume POST)", async () => {
    const boat = runnerBoat();
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...runnerScope, runId: "run-j14b", agentId: "agent", executionWorkspaceId: "ws", adapterType: "paperclip_runner" } as any);
    boat.box.state = "running";
    const mark = boat.calls.length;
    await plugin.definition.onEnvironmentResumeLease!({ ...runnerScope, providerLeaseId: id, leaseMetadata: lease.metadata } as any);
    expect(boat.count("POST", "/resume", mark)).toBe(0);
    expect(boat.count("PATCH", "", mark)).toBe(1);
  }, 20_000);
});

describe("rf-4 F3: fast refusal and zero HTTP hold at the real hooks", () => {
  it("J5 a 404 stop record with the box's own stop `failing` (same id) fails fast with the typed refusal, not at the 120 s deadline", async () => {
    const boat = fakeBoat({ record: () => json({ error: "not_found" }, 404),
      box: () => ({ stop: { id: "stop_0000000000000001", status: "failing", error: BOAT_REFUSAL } }) });
    const work = stopLease().catch(e => e);
    const first = await Promise.race([work, new Promise(resolve => setTimeout(() => resolve("still waiting after 3 s"), 3_000))]);
    expect(first).toBeInstanceOf(BoatStopRefusedError);
    expect(first).toMatchObject({ stopId: "stop_0000000000000001", boatStatus: "failing", boatError: BOAT_REFUSAL, lastGoodSnapshotAt: LAST_GOOD });
    expect(boat.count("POST", "/stop")).toBe(1);
    // Not a receipt, and inside the back-off nothing is sent.
    const mark = boat.calls.length;
    expect(await stopLease().catch(e => e)).toBeInstanceOf(BoatStopRefusedError);
    expect(boat.calls.length).toBe(mark);
  }, 10_000);

  it("J5b a 404 stop record with a DIFFERENT failing stop id on the box is not taken as our refusal", async () => {
    vi.useFakeTimers();
    fakeBoat({ record: () => json({ error: "not_found" }, 404),
      box: () => ({ stop: { id: "stop_someone_else", status: "failing", error: BOAT_REFUSAL } }) });
    const work = stopLease().catch(e => e);
    await vi.advanceTimersByTimeAsync(121_000);
    const error = await work;
    expect(error).not.toBeInstanceOf(BoatStopRefusedError);
    expect(error.message).toContain("did not complete");
  }, 10_000);

  it("J18 with duplexCarrier ssh and no SSH state to retire, a Stop inside the back-off sends ZERO HTTP", async () => {
    const boat = fakeBoat({ record: failingRecord() });
    const ssh = { config: { ...config, duplexCarrier: "ssh" } };
    expect(await stopLease(ssh).catch(e => e)).toBeInstanceOf(BoatStopRefusedError);
    const mark = boat.calls.length;
    const again = await stopLease(ssh).catch(e => e);
    expect(again).toBeInstanceOf(BoatStopRefusedError);
    expect(boat.calls.slice(mark)).toEqual([]);
  }, 10_000);
});

describe("rf-4 F4: cleanup stops retrying at Boat's refusal", () => {
  it("J15 failed-acquisition cleanup returns right after the refusal: no 250/500 ms retry waits (the no-early-break mutant dies)", async () => {
    let created = false;
    const boat = fakeBoat({ record: failingRecord(),
      extra: (method, route) => {
        if (method === "POST" && route === "/sandboxes") { created = true; return json({ sandbox: { id } }); }
        // Boat's setup failure (get-sandbox setupStatus), then the stop refuses.
        if (method === "GET" && route === `/sandboxes/${id}` && created && !boatCalls().some(c => c.route.endsWith("/stop"))) {
          return json({ sandbox: { id, state: "ready", setupStatus: "failed", setupError: "dependency install failed" } });
        }
        return undefined;
      } });
    const boatCalls = () => boat.calls;
    const error = await plugin.definition.onEnvironmentAcquireLease!({ ...scope, runId: "run", creationOperationId: "attempt", config: { ...config, setupScript: "false" } } as any).catch(e => e);
    const refusedAt = boat.calls.filter(c => c.route.includes("/stops/")).at(-1)!.at;
    expect(error).toBeInstanceOf(PluginEnvironmentCreationCleanupError);
    expect(boat.count("POST", "/stop")).toBe(1);
    // Head: the cleanup ends at the refusal. Without the early break, 250 + 500 ms of retry waits follow.
    expect(Date.now() - refusedAt).toBeLessThan(200);
  }, 10_000);
});

// Keep: rf-4's delta review of Boat unit #2 (RF4-U2B S1/C1, S2/C2, S3/J2). A setup failure's
// provider text and a cached refusal leave the worker verbatim through the SDK's RPC
// message, so both go through the one redactor. Synthetic keys and sentinels only.
describe("rf-4 U2b: setup errors and the cached refusal go through the one redactor", () => {
  const SETUP_LEAK = `download failed Authorization: Bearer SETUP_OTHER_BEARER_SECRET; api key ${KEY}`;
  for (const [form, setup] of [
    ["setupError", { setupError: SETUP_LEAK }],
    ["setupErrorText", { setupErrorText: SETUP_LEAK }],
    ["error string", { error: SETUP_LEAK }],
    ["error.message", { error: { message: SETUP_LEAK } }],
  ] as const) {
    it(`C1 a planted bearer and the configured key in Boat's setup failure (${form}) never reach the thrown message or stack; Boat's words do`, async () => {
      let created = false;
      fakeBoat({ record: (stopId) => json({ stop: { id: stopId, status: "completed" } }),
        extra: (method, route) => {
          if (method === "POST" && route === "/sandboxes") { created = true; return json({ sandbox: { id } }); }
          if (method === "GET" && route === `/sandboxes/${id}` && created) return json({ sandbox: { id, state: "ready", setupStatus: "failed", ...setup } });
          return undefined;
        } });
      const error = await plugin.definition.onEnvironmentAcquireLease!({ ...scope, runId: "run", creationOperationId: "attempt", config: { ...config, setupScript: "false" } } as any).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(`Boat sandbox ${id} setup failed: download failed`);
      const text = outbound(error);
      expect(text).not.toContain("SETUP_OTHER_BEARER_SECRET");
      expect(text).not.toContain(KEY);
    }, 10_000);
  }

  it("C2 the cached refusal inside the back-off never rebuilds the raw provider id (same normaliser as the first refusal)", async () => {
    id = `bx_${KEY}`;
    fakeBoat({ record: failingRecord() });
    const first = await stopLease().catch(e => e);
    expect(first).toBeInstanceOf(BoatStopRefusedError);
    noSecrets(outbound(first));
    const again = await stopLease().catch(e => e);
    expect(again).toBeInstanceOf(BoatStopRefusedError);
    noSecrets(outbound(again));
    expect(again.message).toBe(first.message);
  }, 10_000);

  it("J2 (superseded wording, SUPERSEDE-BOAT-U2-F2-STOPFAIL-1118) an unknown future stop status reads 'entered unrecognised (...)' and is never a stopped receipt", async () => {
    fakeBoat({ record: (stopId) => json({ stop: { id: stopId, status: "unexpected-future-status" } }) });
    const result = await stopLease().then(lease => ({ lease }), error => ({ error }));
    expect(result).not.toHaveProperty("lease");
    const error = (result as { error: any }).error;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PluginEnvironmentStopError);
    expect(error.message).toMatch(/^Boat stop stop_0+1 entered unrecognised \(unexpected-future-status\)$/);
  }, 10_000);
});
