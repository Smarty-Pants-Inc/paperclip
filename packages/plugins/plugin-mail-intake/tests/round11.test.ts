import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { seenKey } from "../src/intake.js";
import { createMailDefinition } from "../src/plugin.js";

// Round 11 (review-fleet-2 residuals, 07:27Z).
// F1: a WORKER-ONLY respawn. The worker manager restarts a crashed process by itself
// (server plugin-worker-manager.ts:3179,3253-3276,3354-3383): no configChanged replay
// (that is only the loader's activation step, plugin-loader.ts:2497-2501), and the
// handle keeps its proactive scope set (plugin-worker-manager.ts:1112-1115). Modelled
// here as a fresh createMailDefinition() over the same host state, with no deliveries.
// F2: plugin-state failures inside an enabled tick keep their own code.
const company = "11111111-1111-1111-1111-111111111111";
const other = "44444444-4444-4444-4444-444444444444";
const now = 1_700_000_000_001;
const day = 86_400_000;
const config = { enabled: false, mailbox: "smarty@smartypants.ai",
  gmailGrantRef: { type: "secret_ref", secretId: "22222222-2222-2222-2222-222222222222" },
  routineFireSecretRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
  routineOrigin: "https://hq.smartypants.ai", routinePublicId: "test-mail" };
const DENIED = 'Plugin "test" is not allowed to perform "config.get": company context is required';
const KNOWN = { scopeKind: "instance", namespace: "mail-intake", stateKey: "configured-companies" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const keyOf = (key: unknown) => JSON.stringify(key);
const SEEN = keyOf(seenKey(company, config.mailbox));

function host() {
  const configs = new Map<string, Record<string, unknown>>([[company, { ...config }]]);
  const scopes = new Set<string>([company]); // the worker handle's proactive scope set
  const states = new Map<string, unknown>(); // plugin_state: survives any worker respawn
  const fires: string[] = [];
  const ctx = {
    companies: { list: vi.fn(async () => [{ id: other }, { id: company }]) },
    config: { get: vi.fn(async (id: string) => {
      if (!scopes.has(id)) throw new Error(DENIED);
      return structuredClone(configs.get(id) ?? {});
    }) },
    state: {
      get: vi.fn(async (key: unknown) => structuredClone(states.get(keyOf(key)) ?? null)),
      set: vi.fn(async (key: unknown, value: unknown) => { states.set(keyOf(key), structuredClone(value)); }),
      delete: vi.fn(async (key: unknown) => { states.delete(keyOf(key)); }),
    },
    logger: { warn: vi.fn() },
    secrets: { resolve: vi.fn(async (_ref: unknown, o?: { configPath?: string }) => o?.configPath === "gmailGrantRef"
      ? JSON.stringify({ client_id: "c", client_secret: "s", refresh_token: "r" }) : "bearer") },
    http: { fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "a", token_type: "Bearer" });
      if (u.pathname.endsWith("/fire")) { fires.push(JSON.parse(String(init?.body)).messageId); return json({}, 202); }
      if (u.pathname.endsWith("/messages")) return json({ messages: [{ id: "aa", threadId: "ff" }] });
      return json({ id: "aa", threadId: "ff", internalDate: String(now - 1) });
    }) },
  };
  /** Start a worker process. `deliver` = the configChanged calls the host makes after start. */
  async function start(deliver: string[]) {
    let tick!: () => Promise<void>;
    const plugin = createMailDefinition();
    await plugin.setup({ ...ctx,
      jobs: { register: (_k: string, fn: typeof tick) => { tick = fn; } },
      actions: { register: () => undefined },
    } as unknown as PluginContext);
    const delivered: unknown[] = [];
    for (const id of deliver) {
      delivered.push(await plugin.onConfigChanged!(configs.get(id) ?? {}, { companyId: id }).then(() => "ok", (e: Error) => e.message));
    }
    return { plugin, delivered, tick: () => tick(), health: () => plugin.onHealth!() };
  }
  return { ctx, configs, scopes, states, fires, start };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("F1 residual: the configured-company set survives a worker-only respawn", () => {
  it("review-fleet-2 case: respawn WITHOUT replay + configured company refused -> FAILED job + health error", async () => {
    const h = host();
    h.states.set(SEEN, { version: 2, seen: [], failures: [] });
    h.configs.set(other, { ...config });
    h.scopes.delete(other); // its scope refresh failed (routes/plugins.ts:2457-2466 swallows it)
    const first = await h.start([company, other]); // host start / config save delivered both rows
    await expect(first.tick()).rejects.toThrow("config read failed");
    // Worker-only respawn: a fresh process, NO configChanged replay, same scopes.
    const respawned = await h.start([]);
    await expect(respawned.tick()).rejects.toThrow("config read failed"); // 0.1.5: resolved (silent skip)
    expect(await respawned.health()).toEqual({ status: "error", message: "config read failed" });
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
    expect(h.states.get(keyOf(KNOWN))).toEqual({ version: 1, companies: [company, other].sort() });
  });
  it("only configured company refused after a respawn without replay: 'config read failed', not 'not configured'", async () => {
    const h = host();
    await h.start([company]);
    h.scopes.delete(company);
    const respawned = await h.start([]);
    await expect(respawned.tick()).rejects.toThrow("config read failed");
    expect(await respawned.health()).toEqual({ status: "error", message: "config read failed" });
  });
  it("the set is rebuilt at worker init (setup), before any tick or health call", async () => {
    const h = host();
    await h.start([company]);
    h.ctx.state.get.mockClear();
    const respawned = await h.start([]);
    expect(h.ctx.state.get.mock.calls[0]?.[0]).toEqual(KNOWN);
    // Loaded once per worker: a tick and a health call do not re-read it.
    h.states.set(SEEN, { version: 2, seen: [], failures: [] });
    await respawned.tick(); await respawned.health();
    expect(h.ctx.state.get.mock.calls.filter(([key]) => keyOf(key) === keyOf(KNOWN))).toHaveLength(1);
  });
  it("an unconfigured company is still skipped after a respawn (never reported by the host)", async () => {
    const h = host();
    h.states.set(SEEN, { version: 2, seen: [], failures: [] });
    await h.start([company]);
    const respawned = await h.start([]);
    await expect(respawned.tick()).resolves.toBeUndefined();
    expect(await respawned.health()).toEqual({ status: "ok", details: { parked: [] } });
    expect(h.ctx.config.get.mock.calls.map(([id]) => id)).toContain(other);
  });
  it("set unreadable after a respawn: the job FAILS 'state read failed' (no skip), health shows it, then recovers", async () => {
    const h = host();
    h.states.set(SEEN, { version: 2, seen: [], failures: [] });
    h.configs.set(other, { ...config });
    h.scopes.delete(other);
    await h.start([company, other]);
    const real = h.ctx.state.get.getMockImplementation()!;
    h.ctx.state.get.mockImplementation(async (key: unknown) => {
      if (keyOf(key) === keyOf(KNOWN)) throw new Error("PRIVATE_HOST_TEXT");
      return real(key);
    });
    const respawned = await h.start([]);
    await expect(respawned.tick()).rejects.toThrow("state read failed");
    expect(await respawned.health()).toEqual({ status: "error", message: "state read failed" });
    h.ctx.state.get.mockImplementation(real);
    await expect(respawned.tick()).rejects.toThrow("config read failed"); // retried, then the refusal is loud
  });
  it("a corrupt stored set is 'state invalid', never an empty set", async () => {
    const h = host();
    h.states.set(keyOf(KNOWN), { version: 1, companies: "everyone" });
    const worker = await h.start([]);
    await expect(worker.tick()).rejects.toThrow("state invalid");
    expect(await worker.health()).toEqual({ status: "error", message: "state invalid" });
  });
  it("configChanged cannot persist: reported as 'state write failed'; every discovery retries until it lands", async () => {
    const h = host();
    h.states.set(SEEN, { version: 2, seen: [], failures: [] });
    h.ctx.state.set.mockRejectedValueOnce(new Error("PRIVATE"));
    const first = await h.start([company]);
    expect(first.delivered).toEqual(["state write failed"]);
    h.ctx.state.set.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(first.tick()).rejects.toThrow("state write failed");
    expect(h.states.has(keyOf(KNOWN))).toBe(false);
    await expect(first.tick()).resolves.toBeUndefined(); // write lands on the next discovery
    expect(h.states.get(keyOf(KNOWN))).toEqual({ version: 1, companies: [company] });
    h.scopes.delete(company);
    await expect((await h.start([])).tick()).rejects.toThrow("config read failed");
  });
  it("an existing install upgrading to 0.1.6 learns its company from the host's startup replay", async () => {
    const h = host();
    expect(h.states.has(keyOf(KNOWN))).toBe(false); // 0.1.5 wrote no such row
    const worker = await h.start([company]);
    expect(worker.delivered).toEqual(["ok"]);
    expect(h.states.get(keyOf(KNOWN))).toEqual({ version: 1, companies: [company] });
    expect(h.ctx.state.set).toHaveBeenCalledTimes(1); // replaying the same row again writes nothing
    await worker.plugin.onConfigChanged!({ ...config }, { companyId: company });
    expect(h.ctx.state.set).toHaveBeenCalledTimes(1);
  });
});

describe("F2 residual: plugin-state failures in an ENABLED tick are not 'mailbox read failed'", () => {
  async function enabled(seen: unknown) {
    const h = host();
    h.configs.set(company, { ...config, enabled: true });
    h.states.set(SEEN, seen);
    return { h, worker: await h.start([company]) };
  }
  const floor = { version: 2, seen: [], failures: [], notBefore: now - 7 * day };
  it("seen-state read inside the tick fails -> 'state read failed'", async () => {
    const { h, worker } = await enabled(floor);
    const real = h.ctx.state.get.getMockImplementation()!;
    let seenReads = 0;
    h.ctx.state.get.mockImplementation(async (key: unknown) => {
      if (keyOf(key) === SEEN && ++seenReads === 2) throw new Error("PRIVATE"); // runTick's own read
      return real(key);
    });
    await expect(worker.tick()).rejects.toThrow("state read failed");
    expect(h.fires).toEqual([]);
  });
  it("pruning write fails -> 'state write failed', nothing fired", async () => {
    const { h, worker } = await enabled({ version: 2, seen: [{ id: "bb", internalDate: now - 8 * day }], failures: [] });
    h.ctx.state.set.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(worker.tick()).rejects.toThrow("state write failed");
    expect(h.fires).toEqual([]);
  });
  it("delivery checkpoint write fails -> 'state write failed'", async () => {
    const { h, worker } = await enabled(floor);
    h.ctx.state.set.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(worker.tick()).rejects.toThrow("state write failed");
    expect(h.fires).toEqual(["aa"]);
  });
  it("control: a Gmail failure in the same tick is still 'mailbox read failed'; success still fires", async () => {
    const { h, worker } = await enabled(floor);
    h.ctx.http.fetch.mockResolvedValueOnce(json({ error: "invalid_client" }, 401));
    await expect(worker.tick()).rejects.toThrow("mailbox read failed");
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(h.fires).toEqual(["aa"]);
    expect(h.states.get(SEEN)).toMatchObject({ seen: [{ id: "aa" }] });
  });
});
