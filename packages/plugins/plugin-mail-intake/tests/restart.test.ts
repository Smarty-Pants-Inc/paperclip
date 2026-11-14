import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { SAFE_ERROR } from "../src/config.js";
import { seenKey } from "../src/intake.js";
import { createMailDefinition } from "../src/plugin.js";

const company = "11111111-1111-1111-1111-111111111111";
const foreign = "44444444-4444-4444-4444-444444444444";
const now = 1_700_000_000_001;
const config = { enabled: true, mailbox: "smarty@smartypants.ai",
  gmailGrantRef: { type: "secret_ref", secretId: "22222222-2222-2222-2222-222222222222" },
  routineFireSecretRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
  routineOrigin: "https://hq.smartypants.ai", routinePublicId: "test-mail" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const keyOf = (key: unknown) => JSON.stringify(key);

// Keep: live C9 restart regression (PR #26), company trust boundary and durable
// IDs-only data safety. Host config/KV survive; every start creates a NEW worker.
function host(savedConfig: Record<string, unknown> | null = config, baseline = true) {
  const configs = new Map<string, Record<string, unknown>>(savedConfig ? [[company, savedConfig]] : []);
  const states = new Map<string, unknown>();
  if (baseline) states.set(keyOf(seenKey(company, config.mailbox)), {
    version: 2, notBefore: now - 7 * 86_400_000, seen: [], failures: [],
  });
  const fires: unknown[] = [];
  const ctx = {
    config: { get: vi.fn(async (id?: string) => {
      if (!id) throw new Error("global config forbidden");
      // Host-faithful proactive scope: setup/job calls may read only companies
      // represented by saved company config rows (server/src/services/
      // plugin-worker-manager.ts:2856-2865). The SDK gate requires invocation
      // scope or a matching proactive scope (host-client-factory.ts:610-643).
      // A board action gets its company from the host invocation context.
      if (id === foreign && !configs.has(foreign)) throw new Error('Plugin "test" is not allowed to perform "config.get": company context is required');
      return structuredClone(configs.get(id) ?? {});
    }) },
    companies: { list: vi.fn(async () => [{ id: foreign }, { id: company }]) },
    state: {
      get: vi.fn(async (key: unknown) => structuredClone(states.get(keyOf(key)) ?? null)),
      set: vi.fn(async (key: unknown, value: unknown) => { states.set(keyOf(key), structuredClone(value)); }),
      delete: vi.fn(async (key: unknown) => { states.delete(keyOf(key)); }),
    },
    logger: { warn: vi.fn() },
    secrets: { resolve: vi.fn(async (_ref: unknown, options?: { configPath?: string }) =>
      options?.configPath === "gmailGrantRef" ? JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh" }) : "bearer") },
    http: { fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "access", token_type: "Bearer" });
      if (u.pathname.endsWith("/messages")) return json({ messages: [{ id: "aa", threadId: "ff" }] });
      if (u.pathname.endsWith("/fire")) { fires.push(JSON.parse(String(init?.body))); return json({}, 202); }
      return json({ id: "aa", threadId: "ff", internalDate: String(now - 1) });
    }) },
  };
  async function start() {
    let tick!: () => Promise<void>;
    let action!: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;
    const plugin = createMailDefinition();
    await plugin.setup({ ...ctx,
      jobs: { register: (_key: string, handler: typeof tick) => { tick = handler; } },
      actions: { register: (_key: string, handler: typeof action) => { action = handler; } },
    } as unknown as PluginContext);
    // SDK protocol.ts:442-460: the host's BOARD actor is exposed as "user".
    const board: PluginPerformActionContext = { companyId: company,
      actor: { type: "user", companyId: company, userId: "operator", agentId: null, runId: null } };
    return { plugin, tick: () => tick(), board,
      // Host-faithful params: the action route forwards `renderEnvironment ?? null`
      // (server routes/plugins.ts:1772) and the SDK merges it into params
      // (sdk worker-rpc-host.ts:2115-2120), so a REST board call always carries it.
      initialize: (context = board, paramsCompany = company, extra: Record<string, unknown> = {}) => action({
        companyId: paramsCompany, mailbox: config.mailbox, seenIds: ["aa"], renderEnvironment: null, ...extra,
      }, context) };
  }
  return { ctx, configs, states, fires, start };
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("durable worker startup and board initialization", () => {
  it("continues discovery after host scope-denies an unconfigured company", async () => {
    const h = host();
    const worker = await h.start();
    await worker.tick();
    expect(h.ctx.config.get.mock.calls.map(([id]) => id)).toEqual([foreign, company, foreign, company]);
    expect(h.fires).toHaveLength(1);
  });
  it("runs a fresh worker's tick from saved config without onConfigChanged, then survives another restart", async () => {
    const h = host();
    await (await h.start()).tick();
    expect(h.fires).toEqual([{ messageId: "aa", threadId: "ff", receivedTime: new Date(now - 1).toISOString() }]);
    await (await h.start()).tick();
    expect(h.fires).toHaveLength(1);
    expect(h.ctx.config.get.mock.calls.every(([id]) => Boolean(id))).toBe(true);
  });
  it("initializes after restart with saved disabled config and ZERO plugin_state rows", async () => {
    const h = host({ ...config, enabled: false }, false);
    await h.start(); // Boot one; no config-save callback in either worker.
    const restarted = await h.start();
    await expect(restarted.initialize()).resolves.toEqual({ accepted: true });
    expect(h.states.has(keyOf(seenKey(company, config.mailbox)))).toBe(false);
    await (await h.start()).tick(); // The request survives a restart; the job completes it.
    expect(h.states.get(keyOf(seenKey(company, config.mailbox)))).toMatchObject({
      seen: [{ id: "aa", internalDate: now - 1 }], failures: [],
    });
    h.configs.set(company, config);
    await restarted.tick();
    expect(h.fires).toEqual([]); // Approved baseline is not backfilled.
  });
  it("accepts the documented company-scoped BOARD/user actor without requiring an agent or run", async () => {
    const h = host({ ...config, enabled: false }, false);
    const worker = await h.start();
    await expect(worker.initialize(worker.board)).resolves.toEqual({ accepted: true });
    expect(h.ctx.secrets.resolve).not.toHaveBeenCalled();
    await worker.tick();
    expect(h.ctx.secrets.resolve).toHaveBeenCalled();
  });
  it("accepts the host-forwarded renderEnvironment (null or object) but still refuses unknown params", async () => {
    const h = host({ ...config, enabled: false }, false);
    const worker = await h.start();
    await expect(worker.initialize(worker.board, company, { unexpected: true })).rejects.toThrow("params invalid");
    await expect(worker.initialize(worker.board, company, { renderEnvironment: "x" })).rejects.toThrow("params invalid");
    expect(h.ctx.secrets.resolve).not.toHaveBeenCalled();
    await expect(worker.initialize(worker.board, company, { renderEnvironment: { surface: "page" } }))
      .resolves.toEqual({ accepted: true });
  });
  it("names missing seen state on an enabled tick instead of reporting a mailbox read failure", async () => {
    const h = host(config, false);
    const worker = await h.start();
    await expect(worker.tick()).rejects.toThrow("state invalid");
    expect(h.ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it.each(["scope", "actor", "params", "global"])("refuses foreign/missing %s company before secret, mail or KV writes", async mismatch => {
    const h = host({ ...config, enabled: false }, false);
    const worker = await h.start();
    const context = { ...worker.board, actor: { ...worker.board.actor } };
    if (mismatch === "scope") context.companyId = foreign;
    if (mismatch === "actor") context.actor.companyId = foreign;
    if (mismatch === "global") { context.companyId = null; context.actor.companyId = null; }
    await expect(worker.initialize(context, mismatch === "params" ? foreign : company)).rejects.toThrow("actor/company mismatch");
    expect(h.ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
    expect(h.ctx.state.set).not.toHaveBeenCalled();
  });
  it("reports not configured, and FAILS the tick instead of silently succeeding, when no saved config resolves", async () => {
    const h = host(null, false);
    const worker = await h.start();
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "mail intake is not configured" });
    await expect(worker.tick()).rejects.toThrow("not configured");
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("re-resolves host config on each tick, including removal and later creation without a callback", async () => {
    const h = host(null);
    const worker = await h.start();
    h.configs.set(company, config);
    await worker.tick();
    expect(h.fires).toHaveLength(1);
    h.configs.delete(company);
    await expect(worker.tick()).rejects.toThrow("not configured");
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "mail intake is not configured" });
  });
  it("does not choose an arbitrary company when two have saved config", async () => {
    const h = host(); h.configs.set(foreign, config);
    const worker = await h.start();
    await expect(worker.tick()).rejects.toThrow("multiple companies configured");
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "multiple companies configured" });
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("surfaces company discovery errors without leaking host/provider text", async () => {
    const h = host(); h.ctx.companies.list.mockRejectedValue(new Error("PRIVATE_PROVIDER_SENTINEL"));
    const worker = await h.start();
    await expect(worker.tick()).rejects.toThrow("host read failed");
    expect(await worker.plugin.onHealth!()).toEqual({ status: "error", message: "host read failed" });
    expect(h.ctx.http.fetch).not.toHaveBeenCalled();
  });
});
