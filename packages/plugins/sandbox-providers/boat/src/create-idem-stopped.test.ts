import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentAcquireErrorData, JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, readEnvironmentCreationIdempotencyCode } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

/** What the host reads after the worker RPC host wraps the acquire error (worker-rpc-host: data = environmentAcquireErrorData(err)). */
const hostIdempotencyCode = (error: unknown) => readEnvironmentCreationIdempotencyCode(new JsonRpcCallError({
  code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: String((error as Error)?.message), data: environmentAcquireErrorData(error) }));

// The plugin polls with node:timers/promises; keep it on the global timer
// (the create-idem.test.ts pattern). Only Date is faked below, so waits are real.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));

// review-fleet-4 GAP 1 on the create-retry money unit (plugin half), on the
// line-2 stack with the strict 90 s create cap. A key still in progress at the
// cap fails the acquire; our cleanup then lists the label and stops the box
// Boat was building. The host retry re-sends the SAME creation id (= the same
// Idempotency-Key) with the same body, and Boat's dedupe answers with that
// same box (https://docs.boat.dev/llms-full.txt :2229), now stopped or
// stopping. Rule: that box is NEVER handed over as a ready lease; the attempt
// fails typed (`boat_idempotency_box_stopped`), sends no second create under
// a new key and no resume, and cleanup still owns the box.
// Each row gets its own account key: the plugin's per-box stop memory is keyed by account and box id.
let row = 0;
let params: any;
const freshParams = () => ({ driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", creationOperationId: "op-1",
  config: { hydrationWaitSeconds: 0, apiKey: `boat_test_${++row}`, type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Box = { id: string; state: string; labels: Record<string, string>; stop?: { id: string; status: string; error?: string } };
function fakeBoat(options: {
  /** What Boat does with our cleanup's stop: finishes it, or refuses it and keeps the box running ("failing"). */
  stopOutcome: "completed" | "failing";
  /** State Boat reports for a completed stop (Boat names a stopped box `archived`; its 409 texts also name `stopped`). */
  stoppedState?: "archived" | "stopped" | "stopping";
}) {
  const keys = new Map<string, { body: string; id: string }>();
  const boxes = new Map<string, Box>();
  const creates: { key: string | null; body: string; at: number }[] = [];
  const stops: string[] = [], resumes: string[] = [];
  let building = true; // the box is being built: the key answers in-progress and is not listed yet
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const path = url.pathname.replace("/api/v1", "");
    if (method === "POST" && path === "/sandboxes") {
      const key = new Headers(init.headers).get("Idempotency-Key"), body = String(init.body);
      creates.push({ key, body, at: Date.now() });
      const prior = key ? keys.get(key) : undefined;
      if (prior) {
        if (prior.body !== body) return response({ error: { code: "idempotency_key_reused", message: "Idempotency-Key reused with a different request body" } }, 409);
        if (building) {
          // Each in-progress answer moves Boat's clock 30 s, so the strict cap ends the resends.
          vi.setSystemTime(new Date(Date.now() + 30_000));
          return response({ error: { code: "idempotency_in_progress", message: "A request with this Idempotency-Key is in progress" } }, 409);
        }
        const box = boxes.get(prior.id)!;
        return response({ sandbox: { id: box.id, state: box.state, ...(box.stop ? { stop: box.stop } : {}) } }, 200);
      }
      const id = `bx_${boxes.size + 1}`;
      boxes.set(id, { id, state: "provisioning", labels: JSON.parse(body).labels });
      if (key) keys.set(key, { body, id });
      // The first send's answer is lost (a 503 after Boat accepted it, :2224).
      return response({ error: { code: "internal_error" } }, 503);
    }
    if (method === "GET" && path === "/sandboxes") {
      const want = url.searchParams.get("label")?.split("=")[1];
      // Once the attempt has hit the cap, the box Boat was building is listed.
      const listed = building && creates.length > 1 && Date.now() - creates[0].at >= 90_000 ? (building = false, [...boxes.values()]) : building ? [] : [...boxes.values()];
      return response({ sandboxes: listed.filter(b => b.labels["paperclip-acquire"] === want).map(b => ({ id: b.id, state: b.state, labels: b.labels })), pageInfo: { nextCursor: null } });
    }
    const stopRecord = /^\/sandboxes\/([^/]+)\/stops\/([^/]+)$/.exec(path);
    if (method === "GET" && stopRecord) {
      const box = boxes.get(stopRecord[1])!;
      return response({ stop: box.stop });
    }
    const boxId = /^\/sandboxes\/([^/]+)$/.exec(path)?.[1];
    if (method === "GET" && boxId && boxes.has(boxId)) {
      const box = boxes.get(boxId)!;
      // Polls move the clock so a waiting loop ends (and shows how long it waited).
      vi.setSystemTime(new Date(Date.now() + 10_000));
      return response({ sandbox: { id: box.id, state: box.state, expiresAt: "2030-01-01T00:00:00Z", ...(box.stop ? { stop: box.stop } : {}) } });
    }
    const stop = /^\/sandboxes\/([^/]+)\/stop$/.exec(path)?.[1];
    if (method === "POST" && stop && boxes.has(stop)) {
      stops.push(stop);
      const box = boxes.get(stop)!;
      if (options.stopOutcome === "completed") { box.state = options.stoppedState ?? "archived"; box.stop = { id: "stop_1", status: "completed" }; }
      else { box.state = "ready"; box.stop = { id: "stop_1", status: "failing", error: "snapshot save failed" }; }
      return response({ stop: { id: "stop_1", status: "pending" } }, 202);
    }
    const resume = /^\/sandboxes\/([^/]+)\/resume$/.exec(path)?.[1];
    if (method === "POST" && resume) { resumes.push(resume); throw new Error("the plugin must not resume a box its cleanup stopped"); }
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { boxes, creates, stops, resumes };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T01:00:00.000Z"));
  params = freshParams();
  await plugin.definition.setup({ logger } as any);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Host attempts 1 and 2: the first answer is lost; the retry stays in progress to the cap; our cleanup stops the box. */
async function timeOutAtCapAndStop(boat: ReturnType<typeof fakeBoat>) {
  await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
  vi.setSystemTime(new Date(Date.now() + 40_000));
  await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toBeTruthy();
  expect(boat.stops, "the cap's cleanup stopped the box Boat was building").toEqual(["bx_1"]);
  vi.setSystemTime(new Date(Date.now() + 60_000));
}
const codeOf = (error: any): unknown[] => [error?.code, ...(Array.isArray(error?.errors) ? error.errors.map((e: any) => e?.code) : [])];

describe("GAP 1: a re-send whose deduped box our cleanup stopped is never a ready lease", () => {
  for (const stoppedState of ["archived", "stopped", "stopping"] as const) {
    it(`G1-${stoppedState}: cap timeout, cleanup stops the box, the host retry re-sends the key, Boat returns the ${stoppedState} box: typed failure, no lease`, async () => {
      const boat = fakeBoat({ stopOutcome: "completed", stoppedState });
      await timeOutAtCapAndStop(boat);
      const sendsBefore = boat.creates.length, startedAt = Date.now();
      const outcome = await plugin.definition.onEnvironmentAcquireLease!(params).then(lease => ({ lease }), error => ({ error }));
      expect("lease" in outcome ? outcome.lease : undefined, "a stopped deduped box is never handed over").toBeUndefined();
      const error = (outcome as { error: any }).error;
      expect(codeOf(error)).toContain("boat_idempotency_box_stopped");
      expect(String(error.message)).toMatch(/boat_idempotency_box_stopped/);
      // One more send, same key and body; no resume; still one box.
      expect(boat.creates.slice(sendsBefore).map(c => c.key)).toEqual(["op-1"]);
      expect(new Set(boat.creates.map(c => c.body)).size).toBe(1);
      expect([...boat.boxes.keys()]).toEqual(["bx_1"]);
      expect(boat.resumes).toEqual([]);
      // Cleanup still owns the box: this attempt's cleanup stopped it again (a no-op on a stopped box).
      expect(boat.stops).toEqual(["bx_1", "bx_1"]);
      // It fails promptly, never waiting out a start deadline on a stopped box.
      expect(Date.now() - startedAt).toBeLessThan(90_000);
    }, 20_000);
  }

  it("G1-refused: our cleanup's stop was refused (Boat keeps the box running and retries the stop); the re-send's ready answer is still not a lease, and cleanup keeps the box", async () => {
    const boat = fakeBoat({ stopOutcome: "failing" });
    await timeOutAtCapAndStop(boat);
    const sendsBefore = boat.creates.length;
    const outcome = await plugin.definition.onEnvironmentAcquireLease!(params).then(lease => ({ lease }), error => ({ error }));
    expect("lease" in outcome ? outcome.lease : undefined, "a box with our stop owed is never handed over").toBeUndefined();
    const error = (outcome as { error: any }).error;
    expect(codeOf(error)).toContain("boat_idempotency_box_stopped");
    // Cleanup still owns the box: its stop is still refused, so the ownership envelope names it.
    expect(error?.cleanup).toMatchObject({ providerLeaseId: "bx_1", attemptId: "op-1" });
    expect(boat.creates.slice(sendsBefore).map(c => c.key)).toEqual(["op-1"]);
    expect([...boat.boxes.keys()]).toEqual(["bx_1"]);
    expect(boat.resumes).toEqual([]);
  }, 20_000);

  it("G1-restart: the same refused stop seen by a new worker (no memory of the stop) is still not a lease", async () => {
    // Plugin state keeps the creation's body across the restart (create-idem R1b), so Boat dedupes it.
    const store = new Map<string, unknown>();
    const scope = (k: any) => `${k.scopeKind}:${k.scopeId}:${k.namespace}:${k.stateKey}`;
    const state = { get: async (k: any) => store.get(scope(k)) ?? null, set: async (k: any, v: unknown) => { store.set(scope(k), JSON.parse(JSON.stringify(v))); }, delete: async (k: any) => { store.delete(scope(k)); } };
    await plugin.definition.setup({ logger, state } as any);
    const boat = fakeBoat({ stopOutcome: "failing" });
    await timeOutAtCapAndStop(boat);
    // A new worker process: a fresh module, with no memory of our stop or its refusal.
    vi.resetModules();
    const worker = (await import("./plugin.js")).default;
    await worker.definition.setup({ logger, state } as any);
    const outcome = await worker.definition.onEnvironmentAcquireLease!(params).then(lease => ({ lease }), error => ({ error }));
    expect("lease" in outcome ? outcome.lease : undefined).toBeUndefined();
    expect(codeOf((outcome as { error: any }).error)).toContain("boat_idempotency_box_stopped");
    expect(new Set(boat.creates.map(c => c.body)).size, "the restart re-sent the same body").toBe(1);
    expect(boat.resumes).toEqual([]);
  }, 20_000);
});

// The server spends a box_stopped creation and mints a fresh key only if it can
// SEE the typed failure across the worker connection: the SDK's closed creationIdempotencyCode.
describe("box_stopped reaches the host as creationIdempotencyCode", () => {
  it("G2-stopped: the deduped stopped box's typed failure carries creationIdempotencyCode boat_idempotency_box_stopped (SDK reader)", async () => {
    const boat = fakeBoat({ stopOutcome: "completed" });
    await timeOutAtCapAndStop(boat);
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).then(() => undefined, e => e);
    expect(codeOf(error)).toContain("boat_idempotency_box_stopped");
    expect(hostIdempotencyCode(error)).toBe("boat_idempotency_box_stopped");
  }, 20_000);

  it("G2-refused: with our stop refused (the cleanup envelope case) it still carries boat_idempotency_box_stopped (SDK reader)", async () => {
    const boat = fakeBoat({ stopOutcome: "failing" });
    await timeOutAtCapAndStop(boat);
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).then(() => undefined, e => e);
    expect(error?.cleanup).toMatchObject({ providerLeaseId: "bx_1", attemptId: "op-1" });
    expect(hostIdempotencyCode(error)).toBe("boat_idempotency_box_stopped");
  }, 20_000);
});

describe("strict cap on the in-progress resends", () => {
  it("CAP-RESEND: a resend that answers with the box after the 90 s cap is not adopted; cleanup stops it", async () => {
    const boat = fakeBoat({ stopOutcome: "completed" });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
    vi.setSystemTime(new Date(Date.now() + 40_000));
    const fetch = globalThis.fetch as any;
    const original = fetch.getMockImplementation();
    let sends = 0;
    // Send 1 of this attempt: in progress (+30 s). Send 2: Boat finishes the box, but answers at 95 s, past the cap.
    fetch.mockImplementation(async (input: any, init: any = {}) => {
      if ((init.method ?? "GET") === "POST" && new URL(String(input)).pathname.endsWith("/sandboxes") && ++sends === 2) {
        vi.setSystemTime(new Date(Date.now() + 63_000));
        const box = boat.boxes.get("bx_1")!; box.state = "ready";
        return response({ sandbox: { id: "bx_1", state: "ready" } }, 200);
      }
      return original(input, init);
    });
    const outcome = await plugin.definition.onEnvironmentAcquireLease!(params).then(lease => ({ lease }), error => ({ error }));
    expect("lease" in outcome ? outcome.lease : undefined, "nothing is adopted past the cap").toBeUndefined();
    expect((outcome as { error: any }).error).toMatchObject({ status: 409, boatCode: "idempotency_in_progress" });
    expect(boat.stops, "the caller's cleanup lists the label and stops the late box").toEqual(["bx_1"]);
  }, 20_000);
});
