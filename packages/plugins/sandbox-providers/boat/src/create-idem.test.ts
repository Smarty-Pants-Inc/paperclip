import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentAcquireErrorData, JsonRpcCallError, PLUGIN_RPC_ERROR_CODES, readEnvironmentCreationIdempotencyCode } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

/** What the host reads after the worker RPC host wraps the acquire error (worker-rpc-host: data = environmentAcquireErrorData(err)). */
const hostIdempotencyCode = (error: unknown) => readEnvironmentCreationIdempotencyCode(new JsonRpcCallError({
  code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: String((error as Error)?.message), data: environmentAcquireErrorData(error) }));

// The plugin polls with node:timers/promises; keep it on the global timer
// (the create-adopt.test.ts pattern). Only Date is faked below, so waits are real.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    if (options?.signal?.aborted) { reject(options.signal.reason); return; }
    const handle = globalThis.setTimeout(() => resolve(value), ms);
    options?.signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(handle); reject(options.signal!.reason); }, { once: true });
  }),
}));

// Create-retry money unit, plugin half. The server re-sends a predecessor's
// pending creation with the SAME creation id, so the SAME Idempotency-Key.
// Boat (https://docs.boat.dev/llms-full.txt lines 2224-2246, fetched
// 2026-11-19, sha256 b847b73fc630a7fc): a retry with the "same account, key and
// request body" returns that same sandbox (:2229); "Retry while the first
// sandbox is still being created -> 409 idempotency_in_progress. Retry shortly
// with the same key." (:2242); "Same key, different request body -> 409
// idempotency_key_reused." (:2243). This fake Boat enforces exactly that.
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const params = { driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", creationOperationId: "op-1", config: cfg };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeBoat(options: {
  /** The first create under a key is accepted but its answer is lost (a 503 after Boat accepted it, :2224). */
  firstAnswerLost?: boolean;
  /** Repeats answered 409 idempotency_in_progress before the box is made. */
  inProgressRepeats?: number;
  /** A key Boat already holds with another body (a create from before this fix). */
  preseed?: { key: string; body: string };
} = {}) {
  const keys = new Map<string, { body: string; id: string }>();
  if (options.preseed) keys.set(options.preseed.key, { body: options.preseed.body, id: "bx_old" });
  const boxes: string[] = options.preseed ? ["bx_old"] : [];
  const creates: { key: string | null; body: string }[] = [];
  const stops: string[] = [];
  let inProgress = options.inProgressRepeats ?? 0;
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const path = url.pathname.replace("/api/v1", "");
    if (method === "POST" && path === "/sandboxes") {
      const key = new Headers(init.headers).get("Idempotency-Key"), body = String(init.body);
      creates.push({ key, body });
      const prior = key ? keys.get(key) : undefined;
      if (prior) {
        if (prior.body !== body) return response({ error: { code: "idempotency_key_reused", message: "Idempotency-Key reused with a different request body" } }, 409);
        if (inProgress > 0) { inProgress--; return response({ error: { code: "idempotency_in_progress", message: "A request with this Idempotency-Key is in progress" } }, 409); }
        return response({ sandbox: { id: prior.id, state: "provisioning" } }, 202);
      }
      const id = `bx_${boxes.length + 1}`;
      boxes.push(id);
      if (key) keys.set(key, { body, id });
      if (options.firstAnswerLost && creates.length === 1) return response({ error: { code: "internal_error" } }, 503);
      return response({ sandbox: { id, state: "provisioning" } }, 202);
    }
    // While Boat is still creating, the box is not listed yet: the lost
    // answer's cleanup lookup finds nothing to stop.
    if (method === "GET" && path === "/sandboxes") return response({ sandboxes: [], pageInfo: { nextCursor: null } });
    const box = /^\/sandboxes\/([^/]+)$/.exec(path)?.[1];
    if (method === "GET" && box && boxes.includes(box)) {
      return response({ sandbox: { id: box, state: stops.includes(box) ? "archived" : "ready", expiresAt: "2030-01-01T00:00:00Z" } });
    }
    const stop = /^\/sandboxes\/([^/]+)\/stop$/.exec(path)?.[1];
    if (method === "POST" && stop) { stops.push(stop); return response({ stop: { id: "stop_1", status: "pending" } }, 202); }
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { boxes, creates, stops };
}

const logger = { info() {}, warn() {}, error() {}, debug() {} };
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-19T01:00:00.000Z"));
  await plugin.definition.setup({ logger } as any);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Boat create re-sent under the same creation id (create-retry money unit)", () => {
  it("R1: two creates with the same creation id 40 s apart send byte-identical bodies, so Boat makes ONE box", async () => {
    const boat = fakeBoat({ firstAnswerLost: true });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
    vi.setSystemTime(new Date(Date.now() + 40_000));
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    expect(boat.creates).toHaveLength(2);
    expect(boat.creates.map(c => c.key)).toEqual(["op-1", "op-1"]);
    expect(boat.creates[1].body).toBe(boat.creates[0].body);
    expect(JSON.parse(boat.creates[0].body).labels.expiry).toBe("2026-11-19T01:30:00.000Z");
    expect(boat.boxes).toEqual(["bx_1"]);
    expect(lease.providerLeaseId).toBe("bx_1");
    expect(boat.stops).toEqual([]);
  });

  it("R1b: the body survives a worker restart through plugin state, so a re-send after restart still matches", async () => {
    const store = new Map<string, unknown>();
    const scope = (k: any) => `${k.scopeKind}:${k.scopeId}:${k.namespace}:${k.stateKey}`;
    const state = { get: async (k: any) => store.get(scope(k)) ?? null, set: async (k: any, v: unknown) => { store.set(scope(k), JSON.parse(JSON.stringify(v))); }, delete: async (k: any) => { store.delete(scope(k)); } };
    await plugin.definition.setup({ logger, state } as any);
    const boat = fakeBoat({ firstAnswerLost: true });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
    vi.setSystemTime(new Date(Date.now() + 40_000));
    await plugin.definition.setup({ logger, state } as any); // a new worker: no memory of the first send
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    expect(boat.creates[1].body).toBe(boat.creates[0].body);
    expect(boat.boxes).toEqual(["bx_1"]);
    expect(lease.providerLeaseId).toBe("bx_1");
  });

  it("R2: a create still in progress (409 idempotency_in_progress) is sent again with the same key and body, and its one box is adopted", async () => {
    const boat = fakeBoat({ firstAnswerLost: true, inProgressRepeats: 1 });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
    vi.setSystemTime(new Date(Date.now() + 40_000));
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    expect(boat.creates).toHaveLength(3);
    expect(new Set(boat.creates.map(c => c.key))).toEqual(new Set(["op-1"]));
    expect(new Set(boat.creates.map(c => c.body)).size).toBe(1);
    expect(boat.boxes).toEqual(["bx_1"]);
    expect(lease.providerLeaseId).toBe("bx_1");
    expect(boat.stops).toEqual([]);
  });

  it("R2b: a key that stays in progress is re-sent only within the create cap, then fails as that 409", async () => {
    const boat = fakeBoat({ firstAnswerLost: true, inProgressRepeats: 1_000 });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
    const fetch = globalThis.fetch as any;
    const original = fetch.getMockImplementation();
    // Each send moves Boat's clock 30 s: the 90 s create cap allows a few sends, not a loop.
    fetch.mockImplementation(async (input: any, init: any = {}) => {
      if ((init.method ?? "GET") === "POST" && new URL(String(input)).pathname.endsWith("/sandboxes")) vi.setSystemTime(new Date(Date.now() + 30_000));
      return original(input, init);
    });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 409, boatCode: "idempotency_in_progress" });
    expect(boat.creates.length).toBeGreaterThan(2);
    expect(boat.creates.length).toBeLessThanOrEqual(5);
    expect(new Set(boat.creates.map(c => c.body)).size).toBe(1);
    expect(boat.boxes).toEqual(["bx_1"]);
  }, 20_000);

  it("R3: an ordinary first create sends one create under its creation id and gets its box", async () => {
    const boat = fakeBoat();
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    expect(boat.creates).toHaveLength(1);
    expect(boat.creates[0].key).toBe("op-1");
    const body = JSON.parse(boat.creates[0].body);
    expect(body).toMatchObject({ type: "small", ttlSeconds: 1800, noEnv: true });
    expect(body.labels).toMatchObject({ owner: "paperclip:co", purpose: "run", environment: "env", run: "run", creation: "op-1",
      "paperclip-acquire": "op-1", expiry: "2026-11-19T01:30:00.000Z" });
    expect(boat.boxes).toEqual(["bx_1"]);
    expect(lease.providerLeaseId).toBe("bx_1");
  });

  it("R4: 409 idempotency_key_reused is its own plain error, and no create is sent under a new key", async () => {
    const boat = fakeBoat({ preseed: { key: "op-1", body: "{\"other\":true}" } });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).then(() => undefined, e => e);
    expect(error).toMatchObject({ status: 409, boatCode: "idempotency_key_reused", code: "boat_idempotency_key_reused" });
    expect(String(error.message)).toMatch(/^boat_idempotency_key_reused: /);
    expect(boat.creates).toHaveLength(1);
    expect(boat.creates.map(c => c.key)).toEqual(["op-1"]);
    expect(boat.boxes).toEqual(["bx_old"]);
  });

  // The server spends a key_reused creation and mints a fresh key only if it can
  // SEE Boat's code across the worker connection: the SDK's closed creationIdempotencyCode.
  it("R5: 409 idempotency_key_reused reaches the host as creationIdempotencyCode idempotency_key_reused (SDK reader)", async () => {
    fakeBoat({ preseed: { key: "op-1", body: "{\"other\":true}" } });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).then(() => undefined, e => e);
    expect(error).toMatchObject({ status: 409, boatCode: "idempotency_key_reused", code: "boat_idempotency_key_reused" });
    expect(hostIdempotencyCode(error)).toBe("idempotency_key_reused");
    expect(environmentAcquireErrorData(error)).toMatchObject({ providerDiagnostic: { httpStatus: 409 }, creationIdempotencyCode: "idempotency_key_reused" });
  });

  it("R6: a key still in progress at the create cap reaches the host as creationIdempotencyCode idempotency_in_progress (SDK reader)", async () => {
    fakeBoat({ firstAnswerLost: true, inProgressRepeats: 1_000 });
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).rejects.toMatchObject({ status: 503 });
    const fetch = globalThis.fetch as any;
    const original = fetch.getMockImplementation();
    fetch.mockImplementation(async (input: any, init: any = {}) => {
      if ((init.method ?? "GET") === "POST" && new URL(String(input)).pathname.endsWith("/sandboxes")) vi.setSystemTime(new Date(Date.now() + 30_000));
      return original(input, init);
    });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).then(() => undefined, e => e);
    expect(error).toMatchObject({ status: 409, boatCode: "idempotency_in_progress" });
    expect(hostIdempotencyCode(error)).toBe("idempotency_in_progress");
  }, 20_000);

  it("R6-GUARD: an in-progress key that finishes inside the cap is a lease, and a plain failure names no idempotency code", async () => {
    fakeBoat({ firstAnswerLost: true, inProgressRepeats: 1 });
    const lost = await plugin.definition.onEnvironmentAcquireLease!(params).then(() => undefined, e => e);
    expect(lost).toMatchObject({ status: 503 });
    expect(hostIdempotencyCode(lost)).toBeNull();
    vi.setSystemTime(new Date(Date.now() + 40_000));
    await expect(plugin.definition.onEnvironmentAcquireLease!(params)).resolves.toMatchObject({ providerLeaseId: "bx_1" });
  });
});
