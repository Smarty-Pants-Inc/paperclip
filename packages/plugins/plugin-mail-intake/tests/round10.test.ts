import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { initKey, METADATA_CONCURRENCY, seenKey } from "../src/intake.js";
import { createMailDefinition } from "../src/plugin.js";

// Round 10 (review-fleet-2 F1/F2 and live prod F3). Host-faithful fakes:
// - config.get without invocation scope is denied with the SDK gate's text
//   (sdk host-client-factory.ts:639/668) unless the company is in the worker's
//   proactive scope set (server plugin-worker-manager.ts:2873-2884).
// - the host replays configChanged for each saved config row at worker start
//   (server plugin-loader.ts:2497-2501), from the same rows as that scope set.
const company = "11111111-1111-1111-1111-111111111111";
const other = "44444444-4444-4444-4444-444444444444";
const now = 1_700_000_000_001;
const config = { enabled: false, mailbox: "smarty@smartypants.ai",
  gmailGrantRef: { type: "secret_ref", secretId: "22222222-2222-2222-2222-222222222222" },
  routineFireSecretRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
  routineOrigin: "https://hq.smartypants.ai", routinePublicId: "test-mail" };
const DENIED = 'Plugin "test" is not allowed to perform "config.get": company context is required';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const keyOf = (key: unknown) => JSON.stringify(key);
const hex = (i: number) => (0x1000 + i).toString(16);

function host(opts: { messages?: number; latencyMs?: number } = {}) {
  const configs = new Map<string, Record<string, unknown>>([[company, { ...config }]]);
  const scopes = new Set<string>([company]); // proactive scope set (configured companies)
  const states = new Map<string, unknown>();
  const ids = Array.from({ length: opts.messages ?? 1 }, (_, i) => hex(i));
  let inFlight = 0, maxInFlight = 0;
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
    // Latency stub at the HTTP layer (the SDK's ctx.http.fetch, the plugin's only egress).
    http: { fetch: vi.fn(async (url: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (opts.latencyMs) await new Promise(resolve => setTimeout(resolve, opts.latencyMs));
        const u = new URL(url);
        if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "a", token_type: "Bearer" });
        if (u.pathname.endsWith("/messages")) return json({ messages: ids.map(id => ({ id, threadId: "ff" })) });
        const id = u.pathname.split("/").pop();
        return json({ id, threadId: "ff", internalDate: String(now - 1) });
      } finally { inFlight--; }
    }) },
  };
  async function start(deliver = [...scopes]) {
    let tick!: () => Promise<void>;
    let action!: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;
    const plugin = createMailDefinition();
    await plugin.setup({ ...ctx,
      jobs: { register: (_k: string, fn: typeof tick) => { tick = fn; } },
      actions: { register: (_k: string, fn: typeof action) => { action = fn; } },
    } as unknown as PluginContext);
    // Startup config replay, as the loader does for every saved row.
    for (const id of deliver) await plugin.onConfigChanged!(configs.get(id) ?? {}, { companyId: id }).catch(() => undefined);
    const board: PluginPerformActionContext = { companyId: company,
      actor: { type: "user", companyId: company, userId: "operator", agentId: null, runId: null } };
    return { plugin, tick: () => tick(), initialize: (extra: Record<string, unknown> = {}) => action({
      companyId: company, mailbox: config.mailbox, seenIds: [hex(0)], renderEnvironment: null, ...extra }, board) };
  }
  return { ctx, configs, scopes, states, start, maxInFlight: () => maxInFlight };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(() => { vi.useRealTimers(); expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("F1: a configured company the worker cannot read fails loudly", () => {
  it("only company configured, its scope refresh failed: FAILED job and health error, not 'not configured' silence", async () => {
    const h = host();
    const worker = await h.start();
    h.scopes.delete(company); // e.g. routes/plugins.ts:2457-2466 swallowed a scope refresh failure
    await expect(worker.tick()).rejects.toThrow("config read failed");
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "config read failed" });
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("review-fleet-2 repro: a second configured company refused while the first reads: no longer tick ok + health ok", async () => {
    const h = host();
    h.states.set(keyOf(seenKey(company, config.mailbox)), { version: 2, seen: [], failures: [] });
    h.configs.set(other, { ...config });
    const worker = await h.start([company, other]); // host delivered both saved rows
    // `other`'s proactive scope never arrived (refresh failed); before 0.1.5 this was skipped.
    await expect(worker.tick()).rejects.toThrow("config read failed");
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "config read failed" });
  });
  it("still skips a company with no saved config (never delivered by the host)", async () => {
    const h = host();
    h.states.set(keyOf(seenKey(company, config.mailbox)), { version: 2, seen: [], failures: [] });
    const worker = await h.start();
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(await worker.plugin.onHealth!()).toEqual({ status: "ok", details: { parked: [] } });
    expect(h.ctx.config.get.mock.calls.map(([id]) => id)).toContain(other);
  });
  it("any non-denial config.get error is 'config read failed' even for an unknown company", async () => {
    const h = host();
    const worker = await h.start();
    h.ctx.config.get.mockRejectedValueOnce(new Error("PRIVATE_HOST_TEXT"));
    await expect(worker.tick()).rejects.toThrow("config read failed");
  });
});

describe("F2: one code per step", () => {
  it("action: params, config read, config, enabled, state read, state write, pending, busy", async () => {
    const h = host();
    const worker = await h.start();
    await expect(worker.initialize({ mailbox: "other@example.com" })).rejects.toThrow("params invalid");
    await expect(worker.initialize({ seenIds: ["not-hex"] })).rejects.toThrow("params invalid");
    await expect(worker.initialize({ seenIds: ["aa", "aa"] })).rejects.toThrow("params invalid");
    h.ctx.config.get.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(worker.initialize()).rejects.toThrow("config read failed");
    h.configs.set(company, { ...config, routineOrigin: "https://evil.example" });
    await expect(worker.initialize()).rejects.toThrow("config invalid");
    h.configs.set(company, { ...config, enabled: true });
    await expect(worker.initialize()).rejects.toThrow("config enabled");
    h.configs.set(company, { ...config });
    h.ctx.state.get.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(worker.initialize()).rejects.toThrow("state read failed");
    h.ctx.state.set.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(worker.initialize()).rejects.toThrow("state write failed");
    await expect(worker.initialize()).resolves.toEqual({ accepted: true });
    await expect(worker.initialize()).rejects.toThrow("initialization pending");
    let release!: () => void;
    h.ctx.companies.list.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return []; });
    const tick = worker.tick();
    await expect(worker.initialize()).rejects.toThrow("busy");
    release(); await expect(tick).rejects.toThrow("not configured");
  });
  it("tick and health: host read, state read, state invalid, state exists are distinct", async () => {
    const h = host();
    const worker = await h.start();
    h.ctx.companies.list.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(worker.tick()).rejects.toThrow("host read failed");
    h.ctx.companies.list.mockRejectedValueOnce(new Error("PRIVATE"));
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "host read failed" });
    h.ctx.state.get.mockRejectedValueOnce(new Error("PRIVATE"));
    await expect(worker.tick()).rejects.toThrow("state read failed");
    h.ctx.state.get.mockRejectedValueOnce(new Error("PRIVATE"));
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "state read failed" });
    h.configs.set(company, { ...config, enabled: true });
    await expect(worker.tick()).rejects.toThrow("state invalid"); // enabled, never initialized
    h.states.set(keyOf(seenKey(company, config.mailbox)), { version: 2, seen: [], failures: [] });
    h.configs.set(company, { ...config });
    await expect(worker.initialize()).rejects.toThrow("state exists");
  });
});

describe("F3: initialize-seen returns at once; the job reads the mailbox", () => {
  it("300 messages at 2 s per HTTP request: action makes no request; the tick finishes inside the job budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = host({ messages: 300, latencyMs: 2_000 });
    const worker = await h.start();
    // The action must not wait on any timer: it resolves with zero simulated time.
    await expect(worker.initialize({ seenIds: [hex(0), hex(299)] })).resolves.toEqual({ accepted: true });
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
    expect(h.ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(await worker.plugin.onHealth!()).toMatchObject({ status: "ok", message: "initializing" });
    // The tick does the 302 requests (token, 1 list page, 300 metadata reads).
    let done = false, error: unknown;
    const tick = worker.tick().then(() => { done = true; }, e => { done = true; error = e; });
    let elapsed = 0;
    while (!done && elapsed < 600_000) { await vi.advanceTimersByTimeAsync(1_000); elapsed += 1_000; }
    await tick;
    expect(error).toBeUndefined();
    expect(h.ctx.http.fetch).toHaveBeenCalledTimes(302);
    expect(h.maxInFlight()).toBe(METADATA_CONCURRENCY);
    // Sequential would be 302 x 2 s = 604 s, over the 240 s read budget and the host's
    // 300 s job cap (plugin-job-scheduler.ts:50). Bounded pool: 2 + ceil(300/8) x 2 s = 80 s.
    expect(elapsed).toBeLessThanOrEqual(82_000);
    expect(h.states.get(keyOf(seenKey(company, config.mailbox)))).toEqual({ version: 2,
      notBefore: now - 7 * 86_400_000, seen: [{ id: hex(0), internalDate: now - 1 }, { id: hex(299), internalDate: now - 1 }],
      failures: [] });
    expect(h.states.has(keyOf(initKey(company, config.mailbox)))).toBe(false);
    expect(await worker.plugin.onHealth!()).toEqual({ status: "ok", details: { parked: [] } });
  });
  it("a mailbox read failure is reported by the tick (and health), never by the action", async () => {
    const h = host();
    h.ctx.http.fetch.mockResolvedValue(json({ error: "invalid_client" }, 401));
    const worker = await h.start();
    await expect(worker.initialize()).resolves.toEqual({ accepted: true });
    await expect(worker.tick()).rejects.toThrow("mailbox read failed");
    expect(await worker.plugin.onHealth!()).toMatchObject({ status: "error", message: "mailbox read failed",
      details: { initialization: "retrying" } });
    expect(h.states.has(keyOf(seenKey(company, config.mailbox)))).toBe(false);
    // Transient: the next tick retries the same explicit request, and a restart keeps it.
    h.ctx.http.fetch.mockReset();
    h.ctx.http.fetch.mockImplementation(async (url: string) => new URL(url).hostname === "oauth2.googleapis.com"
      ? json({ access_token: "a", token_type: "Bearer" }) : new URL(url).pathname.endsWith("/messages")
        ? json({ messages: [{ id: hex(0), threadId: "ff" }] }) : json({ id: hex(0), threadId: "ff", internalDate: String(now - 1) }));
    await (await h.start()).tick();
    expect(h.states.get(keyOf(seenKey(company, config.mailbox)))).toMatchObject({ seen: [{ id: hex(0) }] });
  });
  it("no implicit initialization: a disabled tick with no request reads nothing and writes nothing", async () => {
    const h = host();
    const worker = await h.start();
    await expect(worker.tick()).resolves.toBeUndefined();
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
    // 0.1.6: only the instance-scoped configured-company set may be written.
    expect(h.ctx.state.set.mock.calls.map(([key]) => (key as { stateKey: string }).stateKey))
      .toEqual(["configured-companies"]);
  });
  it("enabling before the tick runs does not complete a pending request; the enabled tick names missing state", async () => {
    const h = host();
    const worker = await h.start();
    await worker.initialize();
    h.configs.set(company, { ...config, enabled: true });
    await expect(worker.tick()).rejects.toThrow("state invalid");
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("a metadata failure stops new requests in the pool and fails the whole read (no partial baseline)", async () => {
    const h = host({ messages: 50 });
    const original = h.ctx.http.fetch.getMockImplementation()!;
    h.ctx.http.fetch.mockImplementation(async (url: string) =>
      url.includes(`/${hex(3)}?`) ? json({}, 500) : original(url));
    const worker = await h.start();
    await worker.initialize();
    await expect(worker.tick()).rejects.toThrow("mailbox read failed");
    expect(h.ctx.http.fetch.mock.calls.length).toBeLessThan(2 + 50);
    expect(h.states.has(keyOf(seenKey(company, config.mailbox)))).toBe(false);
  });
});
