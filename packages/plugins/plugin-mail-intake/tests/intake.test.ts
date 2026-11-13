import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { configSchema, parseConfig, SAFE_ERROR, type MailConfig } from "../src/config.js";
import { ALLOWED_HOSTS, INCOMING_QUERY, runTick, safeHttp, seenKey } from "../src/intake.js";
import { createMailDefinition } from "../src/plugin.js";
import manifest from "../src/manifest.js";

const company = "11111111-1111-1111-1111-111111111111";
const config: MailConfig = {
  enabled: true, mailbox: "smarty@smartypants.ai",
  gmailGrantRef: { type: "secret_ref", secretId: "22222222-2222-2222-2222-222222222222" },
  routineFireSecretRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333", version: "latest" },
  routineOrigin: "https://hq.smartypants.ai", routinePublicId: "test-mail", scanWindowDays: 7,
};
const access = "ACCESS_SECRET_SENTINEL", refresh = "REFRESH_SECRET_SENTINEL", bearer = "FIRE_SECRET_SENTINEL";
const message = (id: string) => ({ id, threadId: "ff" });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const state = (ids: string[] = []) => ({ version: 2, notBefore: Date.now() - 7 * 86_400_000,
  seen: ids.map(id => ({ id, internalDate: 1700000000000 })), failures: [] });
function fixture(initial: unknown = []) {
  let saved: unknown = Array.isArray(initial) && initial.every(id => typeof id === "string" && /^[0-9a-f]{1,64}$/.test(id)) && new Set(initial).size === initial.length
    ? state(initial) : structuredClone(initial);
  const pages: unknown[] = [{ messages: [message("aa"), message("bb")] }];
  const writes: unknown[] = [], fires: { payload: unknown; key: string }[] = [], order: string[] = [];
  const ctx = {
    logger: { warn: vi.fn() },
    state: {
      get: vi.fn(async () => structuredClone(saved)),
      set: vi.fn(async (_key: unknown, value: unknown) => {
        saved = structuredClone(value); writes.push(saved); order.push("save");
      }),
    },
    secrets: { resolve: vi.fn(async (_ref: unknown, options?: { configPath?: string }) =>
      options?.configPath === "gmailGrantRef"
        ? JSON.stringify({ client_id: "CLIENT_ID", client_secret: "CLIENT_SECRET", refresh_token: refresh }) : bearer) },
    http: { fetch: vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: access, token_type: "Bearer" });
      if (u.pathname.endsWith("/fire")) {
        order.push("fire");
        fires.push({ payload: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get("Idempotency-Key")! });
        return json({ accepted: true }, 202);
      }
      if (u.pathname.endsWith("/messages")) return json(pages.shift());
      const id = u.pathname.split("/").pop();
      return json({ id, threadId: "ff", internalDate: "1700000000000" });
    }) },
  };
  return { ctx, pages, writes, fires, order, saved: () => saved };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1700000000001);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Keep reasons: egress/secret trust boundary, IDs-only data safety, and failure paths
// (later-page error / accepted HTTP then lost KV) that live flows cannot cheaply seed.
describe("mail-intake job", () => {
  it("uses the documented schedule, minimal capabilities and secret-ref pickers", () => {
    expect(manifest.jobs).toEqual([expect.objectContaining({ jobKey: "mail-intake", schedule: "*/2 * * * *" })]);
    expect(manifest.capabilities).toEqual(["jobs.schedule", "http.outbound", "secrets.read-ref", "plugin.state.read", "plugin.state.write"]);
    expect(configSchema.properties.gmailGrantRef.format).toBe("secret-ref");
    expect(configSchema.properties.routineFireSecretRef.format).toBe("secret-ref");
    expect(parseConfig({ ...config, enabled: undefined }).enabled).toBe(false);
  });
  it("fires exactly once per new id, uses metadata projections and commits IDs only after 2xx", async () => {
    const f = fixture();
    await runTick(f.ctx, company, config);
    expect(f.fires.map(x => x.payload)).toEqual([
      { messageId: "aa", threadId: "ff", receivedTime: "2023-11-14T22:13:20.000Z" },
      { messageId: "bb", threadId: "ff", receivedTime: "2023-11-14T22:13:20.000Z" },
    ]);
    expect(f.writes).toEqual([state(["aa"]), state(["aa", "bb"])]);
    expect(f.order).toEqual(["fire", "save", "fire", "save"]);
    for (const [url, init] of f.ctx.http.fetch.mock.calls) {
      const u = new URL(url);
      expect(ALLOWED_HOSTS).toContain(u.hostname);
      expect(init?.redirect).toBe("error");
      if (u.hostname === "gmail.googleapis.com") {
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${access}`);
        expect(u.pathname).toContain("/users/smarty%40smartypants.ai/messages");
        if (u.pathname.endsWith("/messages")) {
          expect(u.searchParams.get("q")).toBe(`${INCOMING_QUERY} newer_than:7d`);
          expect(u.searchParams.get("fields")).toBe("messages(id,threadId),nextPageToken,resultSizeEstimate");
        } else {
          expect(u.searchParams.get("format")).toBe("metadata");
          expect(u.searchParams.get("fields")).toBe("id,threadId,internalDate");
        }
      }
    }
    expect(f.ctx.secrets.resolve.mock.calls.map(([, opts]) => opts)).toEqual([
      { companyId: company, configPath: "gmailGrantRef" },
      { companyId: company, configPath: "routineFireSecretRef" },
    ]);
    expect(f.ctx.state.set.mock.calls.every(([key]) => JSON.stringify(key) === JSON.stringify(seenKey(company, config.mailbox)))).toBe(true);
    f.pages.push({ messages: [message("aa"), message("bb")] });
    await runTick(f.ctx, company, config); // restart/replay against persisted IDs
    expect(f.fires).toHaveLength(2);
    expect(f.writes).toHaveLength(2);
  });
  it("exhausts every list page before metadata or firing, including an empty first page", async () => {
    const f = fixture(["aa"]);
    f.pages.splice(0, 1, { nextPageToken: "page-two", resultSizeEstimate: 999 },
      { messages: [message("aa"), message("bb")] });
    await runTick(f.ctx, company, config);
    expect(f.fires.map(x => x.payload)).toEqual([{ messageId: "bb", threadId: "ff", receivedTime: "2023-11-14T22:13:20.000Z" }]);
    const urls = f.ctx.http.fetch.mock.calls.map(([u]) => new URL(u));
    expect(urls.filter(u => u.pathname.endsWith("/messages")).every(u =>
      u.searchParams.get("q") === `${INCOMING_QUERY} newer_than:7d`)).toBe(true);
    expect(urls[2]!.searchParams.get("pageToken")).toBe("page-two");
    expect(urls[3]!.pathname).toMatch(/\/messages\/bb$/);
  });
  it("complete empty read creates no fires and no state writes", async () => {
    const f = fixture(); f.pages.splice(0, 1, {});
    await runTick(f.ctx, company, config);
    expect(f.saved()).toEqual(state()); expect(f.fires).toEqual([]); expect(f.writes).toEqual([]);
  });
  it("disabled is a strict no-op even with missing state", async () => {
    const f = fixture(null);
    await runTick(f.ctx, company, { ...config, enabled: false });
    expect(f.ctx.state.get).not.toHaveBeenCalled();
    expect(f.ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(f.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it.each([null, {}, ["aa", "aa"], ["body content"], [{ id: "aa", subject: "private" }]])(
    "fails closed on absent/corrupt state %j", async stored => {
      const f = fixture(stored);
      await expect(runTick(f.ctx, company, config)).rejects.toThrow(SAFE_ERROR);
      expect(f.ctx.http.fetch).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
    });
  it.each([
    { nextPageToken: "repeat" },
    { messages: [{ id: "aa" }] },
    { messages: [message("aa"), message("aa")] },
    { messages: "truncated" },
    { messages: null },
    { messages: [{ ...message("bb"), snippet: "private" }] },
    { error: { message: access } },
    { truncated: true },
    { resultSizeEstimate: -1 },
    { nextPageToken: "" },
  ])("incomplete/malformed list fails without partial delivery: %j", async bad => {
    const f = fixture();
    f.pages.splice(0, 1, { messages: [message("aa")], nextPageToken: "repeat" }, bad);
    await expect(runTick(f.ctx, company, config)).rejects.toThrow(SAFE_ERROR);
    expect(f.saved()).toEqual(state()); expect(f.fires).toEqual([]); expect(f.writes).toEqual([]);
  });
  it.each(["token", "page", "metadata", "secret"])("redacts %s failures; state stays unchanged", async step => {
    const f = fixture(); const original = f.ctx.http.fetch.getMockImplementation()!;
    if (step === "secret") f.ctx.secrets.resolve.mockRejectedValue(new Error(refresh));
    f.ctx.http.fetch.mockImplementation(async (url, init) => {
      if ((step === "token" && url.includes("oauth2")) ||
          (step === "page" && url.includes("pageToken=")) ||
          (step === "metadata" && url.includes("/bb?"))) throw new Error(`${access} ${refresh} ${bearer}`);
      return original(url, init);
    });
    if (step === "page") f.pages.splice(0, 1, { messages: [message("aa")], nextPageToken: "later" });
    const error = await runTick(f.ctx, company, config).catch(e => e);
    expect(error.message).toBe(SAFE_ERROR); expect(error.cause).toBeUndefined();
    expect(String(error.stack)).not.toContain("SECRET_SENTINEL");
    expect(f.saved()).toEqual(state()); expect(f.fires).toEqual([]); expect(f.writes).toEqual([]);
  });
  it.each([302, 401, 429, 500])("later-page HTTP %s is not a quiet scan", async status => {
    const f = fixture(); const original = f.ctx.http.fetch.getMockImplementation()!;
    f.pages.splice(0, 1, { messages: [message("aa")], nextPageToken: "later" });
    f.ctx.http.fetch.mockImplementation(async (url, init) => url.includes("pageToken=") ? json({ error: access }, status) : original(url, init));
    await expect(runTick(f.ctx, company, config)).rejects.toThrow(SAFE_ERROR);
    expect(f.saved()).toEqual(state()); expect(f.fires).toEqual([]);
  });
  it("bad JSON and metadata shape failures never advance seen", async () => {
    for (const bad of [new Response("{truncated"), json({ id: "aa", threadId: "ff", internalDate: "no" }),
      json({ id: "cc", threadId: "ff", internalDate: "1700000000000" }),
      json({ id: "aa", threadId: "ff", internalDate: "1700000000000", payload: { headers: [] } })]) {
      const f = fixture(); const original = f.ctx.http.fetch.getMockImplementation()!;
      f.ctx.http.fetch.mockImplementation(async (url, init) => url.includes("/aa?") ? bad : original(url, init));
      await expect(runTick(f.ctx, company, config)).rejects.toThrow(SAFE_ERROR);
      expect(f.saved()).toEqual(state()); expect(f.fires).toEqual([]);
    }
  });
  it("page cap is a failed read", async () => {
    const f = fixture(); f.pages.splice(0, 1, ...Array.from({ length: 100 }, (_, n) => ({ nextPageToken: `page-${n}` })));
    await expect(runTick(f.ctx, company, config)).rejects.toThrow(SAFE_ERROR);
    expect(f.ctx.http.fetch).toHaveBeenCalledTimes(101); // refresh plus bounded list calls
    expect(f.writes).toEqual([]); expect(f.fires).toEqual([]);
  });
  it("retains each 2xx checkpoint on a later delivery failure; retry skips it", async () => {
    const f = fixture(); const original = f.ctx.http.fetch.getMockImplementation()!;
    f.ctx.http.fetch.mockImplementation(async (url, init) => url.endsWith("/fire") && JSON.parse(String(init?.body)).messageId === "bb"
      ? json({ error: bearer }, 503) : original(url, init));
    await runTick(f.ctx, company, config);
    expect(f.saved()).toMatchObject({ seen: state(["aa"]).seen, failures: [{ id: "bb", attempts: 1 }] });
    expect(f.fires).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(1700000120001);
    f.ctx.http.fetch.mockImplementation(original);
    f.pages.push({ messages: [message("aa"), message("bb")] });
    await runTick(f.ctx, company, config);
    expect(f.fires.map(fire => (fire.payload as { messageId: string }).messageId)).toEqual(["aa", "bb"]);
    expect(f.saved()).toEqual(state(["aa", "bb"]));
  });
  it.each(["lost-response", "lost-kv"])("reuses receiver key across %s without duplicate admission", async mode => {
    const f = fixture(); f.pages.splice(0, 1, { messages: [message("aa")] });
    const accepted = new Set<string>(), keys: string[] = []; let first = true;
    const original = f.ctx.http.fetch.getMockImplementation()!;
    f.ctx.http.fetch.mockImplementation(async (url, init) => {
      if (!url.endsWith("/fire")) return original(url, init);
      const key = new Headers(init?.headers).get("Idempotency-Key")!;
      keys.push(key); accepted.add(key);
      if (mode === "lost-response" && first) { first = false; throw new Error(bearer); }
      return json({ accepted: true }, 202);
    });
    if (mode === "lost-kv") f.ctx.state.set.mockRejectedValueOnce(new Error(access));
    if (mode === "lost-kv") {
      await expect(runTick(f.ctx, company, config)).rejects.toThrow(SAFE_ERROR);
      expect(f.saved()).toEqual(state());
    } else {
      await runTick(f.ctx, company, config);
      expect(f.saved()).toMatchObject({ seen: [], failures: [{ id: "aa", attempts: 1 }] });
      vi.mocked(Date.now).mockReturnValue(1700000120001);
    }
    f.pages.push({ messages: [message("aa")] });
    await runTick(f.ctx, company, config);
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(accepted.size).toBe(1);
    expect(f.saved()).toEqual(state(["aa"]));
  });
});

describe("egress trust boundary", () => {
  it("exports exactly the two Google hosts and frozen HQ routine host", () => {
    const hosts = ALLOWED_HOSTS;
    expect(hosts).toEqual(["gmail.googleapis.com", "oauth2.googleapis.com", "hq.smartypants.ai"]);
    expect(Object.isFrozen(hosts)).toBe(true);
  });
  it.each([
    "https://evil.example/token", "https://gmail.googleapis.com.evil.example/token",
    "http://gmail.googleapis.com/gmail/v1/users/me/messages", "https://oauth2.googleapis.com:444/token",
    "https://user:password@gmail.googleapis.com/gmail/v1/users/me/messages", "https://gmail.googleapis.com/upload",
    "https://hq.smartypants.ai/api/companies", "https://hq.smartypants.ai/api/routine-triggers/public/other/fire",
    "https://hq.smartypants.ai/api/routine-triggers/public/test-mail/fire?redirect=evil",
  ])("refuses %s before invoking host HTTP", async url => {
    const f = fixture();
    await expect(safeHttp(f.ctx, config, new AbortController().signal)(url, { method: "POST" })).rejects.toThrow(SAFE_ERROR);
    expect(f.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("enforces an aborted tick even when the SDK transport ignores the signal", async () => {
    for (const abortBefore of [true, false]) {
      const f = fixture(); const controller = new AbortController();
      if (abortBefore) controller.abort();
      else f.ctx.http.fetch.mockImplementation(async () => { controller.abort(); return json({}); });
      await expect(safeHttp(f.ctx, config, controller.signal)("https://oauth2.googleapis.com/token", { method: "POST" })).rejects.toThrow(SAFE_ERROR);
      expect(f.ctx.http.fetch).toHaveBeenCalledTimes(abortBefore ? 0 : 1);
    }
  });
  it("rejects redirects even when a transport returns one or already followed it", async () => {
    for (const response of [new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      Object.defineProperty(json({}), "redirected", { value: true })]) {
      const f = fixture(); f.ctx.http.fetch.mockResolvedValue(response);
      await expect(safeHttp(f.ctx, config, new AbortController().signal)("https://oauth2.googleapis.com/token", { method: "POST" })).rejects.toThrow(SAFE_ERROR);
    }
  });
});

describe("registered job and explicit company binding", () => {
  async function worker(initial: unknown = []) {
    const f = fixture(initial); let job: (() => Promise<void>) | undefined;
    let action: (params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>;
    const ctx = { ...f.ctx, jobs: { register: vi.fn((_key: string, fn: () => Promise<void>) => { job = fn; }) },
      actions: { register: vi.fn((_key: string, fn: typeof action) => { action = fn; }) },
      config: { get: vi.fn(async () => ({ ...config })) } };
    const plugin = createMailDefinition();
    await plugin.setup(ctx as unknown as PluginContext);
    const actor = { type: "user" as const, companyId: company, userId: "operator", agentId: null, runId: null };
    return { ...f, ctx, plugin, tick: () => job!(), seed: (params: Record<string, unknown>, scope = company) =>
      action(params, { companyId: scope, actor: { ...actor, companyId: scope } }) };
  }
  it("initializes seen explicitly while disabled, once only, with mailbox and host company confirmation", async () => {
    const f = await worker(null);
    await f.plugin.onConfigChanged!({ ...config, enabled: false }, { companyId: company });
    f.ctx.config.get.mockResolvedValue({ ...config, enabled: false });
    const params = { companyId: company, mailbox: config.mailbox, seenIds: ["aa"] };
    await expect(f.seed(params, "other-company")).rejects.toThrow(SAFE_ERROR);
    await expect(f.seed({ ...params, seenIds: ["private subject"] })).rejects.toThrow(SAFE_ERROR);
    await expect(f.seed({ ...params, mailbox: "other@example.com" })).rejects.toThrow(SAFE_ERROR);
    expect(f.saved()).toBeNull();
    await expect(f.seed(params)).resolves.toEqual({ initialized: true });
    expect(f.saved()).toEqual(state(["aa"]));
    expect(f.ctx.http.fetch.mock.calls.some(([url]) => new URL(url).searchParams.get("q") === `${INCOMING_QUERY} newer_than:7d`)).toBe(true);
    await expect(f.seed({ ...params, seenIds: [] })).rejects.toThrow(SAFE_ERROR);
    f.ctx.config.get.mockResolvedValue({ ...config });
    f.pages.push({ messages: [message("aa"), message("bb")] });
    await f.tick(); expect(f.fires).toHaveLength(1); expect(f.saved()).toEqual(state(["aa", "bb"]));
  });
  it("initialization persists the scanned window floor even with an empty approved baseline", async () => {
    const f = await worker(null);
    const disabled = { ...config, enabled: false, scanWindowDays: 3 };
    await f.plugin.onConfigChanged!(disabled, { companyId: company });
    f.ctx.config.get.mockResolvedValue(disabled);
    await f.seed({ companyId: company, mailbox: config.mailbox, seenIds: [] });
    expect(f.saved()).toEqual({ version: 2, notBefore: Date.now() - 3 * 86_400_000, seen: [], failures: [] });
  });
  it("health exposes parked IDs, attempt counts and last failure times from durable state only", async () => {
    const lastFailureAt = Date.now() - 1_000;
    const f = await worker({ ...state(), failures: [
      { id: "aa", internalDate: Date.now(), attempts: 10, nextRetryAt: Date.now() + 1_000, lastFailureAt },
      { id: "bb", internalDate: Date.now(), attempts: 2, nextRetryAt: Date.now() + 1_000, lastFailureAt },
    ] });
    await f.plugin.onConfigChanged!({ ...config }, { companyId: company });
    expect(await f.plugin.onHealth?.()).toEqual({ status: "degraded", message: "mail intake has parked deliveries: aa",
      details: { parked: [{ id: "aa", attempts: 10, lastFailureAt }] } });
    expect(f.ctx.state.get).toHaveBeenCalledWith(seenKey(company, config.mailbox));
    expect(f.ctx.http.fetch).not.toHaveBeenCalled(); expect(f.ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(f.ctx.state.set).not.toHaveBeenCalled();
    const restarted = await worker(f.saved());
    await restarted.plugin.onConfigChanged!({ ...config }, { companyId: company });
    expect(await restarted.plugin.onHealth?.()).toEqual(await f.plugin.onHealth?.());
  });
  it("a tenth delivery failure reaches warning and health with its recorded time, even when disabled", async () => {
    const f = await worker({ ...state(), failures: [
      { id: "aa", internalDate: Date.now(), attempts: 9, nextRetryAt: Date.now() },
    ] });
    const original = f.ctx.http.fetch.getMockImplementation()!;
    f.ctx.http.fetch.mockImplementation(async (url, init) => url.endsWith("/fire") && JSON.parse(String(init?.body)).messageId === "aa"
      ? json({ subject: access, from: refresh, body: bearer }, 400) : original(url, init));
    await f.plugin.onConfigChanged!({ ...config }, { companyId: company });
    await f.tick();
    expect(f.ctx.logger.warn.mock.calls).toEqual([["mail intake has parked deliveries: aa"]]);
    expect(f.fires.map(fire => (fire.payload as { messageId: string }).messageId)).toEqual(["bb"]);
    f.ctx.config.get.mockResolvedValue({ ...config, enabled: false });
    expect(await f.plugin.onHealth?.()).toEqual({ status: "degraded", message: "mail intake has parked deliveries: aa",
      details: { parked: [{ id: "aa", attempts: 10, lastFailureAt: Date.now() }] } });
    expect(JSON.stringify(f.saved())).not.toContain("SECRET_SENTINEL");
  });
  it("health represents unknown legacy failure time explicitly rather than fabricating it", async () => {
    const f = await worker({ ...state(), failures: [
      { id: "aa", internalDate: Date.now(), attempts: 10, nextRetryAt: Date.now() },
    ] });
    await f.plugin.onConfigChanged!({ ...config }, { companyId: company });
    expect(await f.plugin.onHealth?.()).toMatchObject({ status: "degraded",
      details: { parked: [{ id: "aa", attempts: 10, lastFailureAt: null }] } });
  });
  it("health is quiet before company binding and redacts corrupt content-bearing state", async () => {
    const f = await worker({ ...state(), failures: [
      { id: "aa", internalDate: Date.now(), attempts: 10, nextRetryAt: Date.now(), subject: access },
    ] });
    expect(await f.plugin.onHealth?.()).toEqual({ status: "ok" });
    expect(f.ctx.config.get).not.toHaveBeenCalled(); expect(f.ctx.state.get).not.toHaveBeenCalled();
    await f.plugin.onConfigChanged!({ ...config }, { companyId: company });
    expect(await f.plugin.onHealth?.()).toEqual({ status: "error", message: SAFE_ERROR });
    expect(f.ctx.http.fetch).not.toHaveBeenCalled(); expect(f.ctx.state.set).not.toHaveBeenCalled();
  });
  it("initialization uses the configured window and rejects IDs outside it", async () => {
    const f = await worker(null);
    const disabled = { ...config, enabled: false, scanWindowDays: 3 };
    await f.plugin.onConfigChanged!(disabled, { companyId: company });
    f.ctx.config.get.mockResolvedValue(disabled);
    const original = f.ctx.http.fetch.getMockImplementation()!;
    f.ctx.http.fetch.mockImplementation(async (url, init) => url.includes("/aa?")
      ? json({ id: "aa", threadId: "ff", internalDate: String(1700000000001 - 4 * 86_400_000) }) : original(url, init));
    await expect(f.seed({ companyId: company, mailbox: config.mailbox, seenIds: ["aa"] })).rejects.toThrow(SAFE_ERROR);
    expect(f.saved()).toBeNull(); expect(f.fires).toEqual([]);
    expect(f.ctx.http.fetch.mock.calls.some(([url]) => new URL(url).searchParams.get("q") === `${INCOMING_QUERY} newer_than:3d`)).toBe(true);
  });
  it("initialization does not write on an incomplete bounded scan", async () => {
    const f = await worker(null);
    const disabled = { ...config, enabled: false };
    await f.plugin.onConfigChanged!(disabled, { companyId: company });
    f.ctx.config.get.mockResolvedValue(disabled);
    f.pages.splice(0, 1, { nextPageToken: "repeat" }, { nextPageToken: "repeat" });
    await expect(f.seed({ companyId: company, mailbox: config.mailbox, seenIds: [] })).rejects.toThrow(SAFE_ERROR);
    expect(f.saved()).toBeNull(); expect(f.ctx.state.set).not.toHaveBeenCalled();
  });
  it("cannot initialize while enabled", async () => {
    const f = await worker(null);
    await f.plugin.onConfigChanged!({ ...config }, { companyId: company });
    await expect(f.seed({ companyId: company, mailbox: config.mailbox, seenIds: [] })).rejects.toThrow(SAFE_ERROR);
    expect(f.saved()).toBeNull();
  });
  it("no config is quiet; saved config re-reads only the explicit company and fires", async () => {
    const f = await worker();
    await f.tick(); expect(f.ctx.config.get).not.toHaveBeenCalled(); expect(f.ctx.http.fetch).not.toHaveBeenCalled();
    await f.plugin.onConfigChanged!(config as unknown as Record<string, unknown>, { companyId: company });
    await f.tick(); expect(f.ctx.config.get).toHaveBeenCalledWith(company); expect(f.fires).toHaveLength(2);
    f.ctx.config.get.mockResolvedValue({ ...config, enabled: false });
    await f.tick(); expect(f.fires).toHaveLength(2);
  });
  it.each([null, "44444444-4444-4444-4444-444444444444"])("rejects wrong/global company %s and fails closed", async wrong => {
    const f = await worker();
    await f.plugin.onConfigChanged!(config as unknown as Record<string, unknown>, { companyId: company });
    await expect(f.plugin.onConfigChanged!(config as unknown as Record<string, unknown>, { companyId: wrong })).rejects.toThrow(SAFE_ERROR);
    await expect(f.tick()).rejects.toThrow(SAFE_ERROR); expect(f.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("config errors do not leak values and invalidate old enabled config", async () => {
    const f = await worker();
    await f.plugin.onConfigChanged!(config as unknown as Record<string, unknown>, { companyId: company });
    const raw = { ...config, routineOrigin: access };
    expect(await f.plugin.onValidateConfig!(raw)).toEqual({ ok: false, errors: [SAFE_ERROR] });
    await expect(f.plugin.onConfigChanged!(raw, { companyId: company })).rejects.toThrow(SAFE_ERROR);
    await expect(f.tick()).rejects.toThrow(SAFE_ERROR); expect(f.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("does not overlap jobs", async () => {
    const f = await worker();
    await f.plugin.onConfigChanged!(config as unknown as Record<string, unknown>, { companyId: company });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.ctx.config.get.mockImplementationOnce(async () => { await gate; return { ...config, enabled: false }; });
    const first = f.tick();
    await expect(f.tick()).rejects.toThrow(SAFE_ERROR);
    release(); await first;
  });
});
