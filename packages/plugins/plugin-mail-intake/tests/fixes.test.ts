import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig, SAFE_ERROR } from "../src/config.js";
import { ALLOWED_HOSTS, runTick, safeHttp } from "../src/intake.js";

const now = 1_700_000_000_000, day = 86_400_000;
const config = parseConfig({ enabled: true, mailbox: "smarty@smartypants.ai",
  gmailGrantRef: { type: "secret_ref", secretId: "22222222-2222-2222-2222-222222222222" },
  routineFireSecretRef: { type: "secret_ref", secretId: "33333333-3333-3333-3333-333333333333" },
  routineOrigin: "https://hq.smartypants.ai", routinePublicId: "test-mail" });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const empty = () => ({ version: 2, seen: [], failures: [] });
function fixture(initial: unknown = empty()) {
  let saved = structuredClone(initial);
  const ids = ["aa", "bb"], attempts: string[] = [];
  const dates = new Map(ids.map(id => [id, now - day]));
  const ctx = {
    logger: { warn: vi.fn() },
    state: { get: vi.fn(async () => structuredClone(saved)),
      set: vi.fn(async (_key: unknown, value: unknown) => { saved = structuredClone(value); }) },
    secrets: { resolve: vi.fn(async (_ref: unknown, options?: { configPath?: string }) =>
      options?.configPath === "gmailGrantRef" ? JSON.stringify({ client_id: "client", client_secret: "secret", refresh_token: "refresh" }) : "bearer") },
    http: { fetch: vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "access", token_type: "Bearer" });
      if (u.pathname.endsWith("/messages")) return json({ messages: ids.map(id => ({ id, threadId: "ff" })) });
      if (u.pathname.endsWith("/fire")) {
        const id = JSON.parse(String(init?.body)).messageId;
        attempts.push(id);
        return id === "aa" ? json({ secret: "MUST_NOT_PERSIST" }, 400) : json({}, 202);
      }
      const id = u.pathname.split("/").pop()!;
      return json({ id, threadId: "ff", internalDate: String(dates.get(id)) });
    }) },
  };
  return { ctx, ids, attempts, dates, saved: () => saved };
}
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
afterEach(() => { expect(globalThis.fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Keep: credential egress trust boundary, durable data safety and the reviewed
// poison-message starvation failure; all exercise production entry points offline.
describe("review fixes", () => {
  it.each(["https://elsewhere.example", "https://127.0.0.1", "https://[::1]",
    "https://hq.smartypants.ai:443", "https://hq.smartypants.ai:444", "https://user@hq.smartypants.ai"])(
    "rejects off-instance/IP/port/userinfo origin %s", origin => {
      expect(() => parseConfig({ ...config, routineOrigin: origin })).toThrow(SAFE_ERROR);
    });
  it("freezes the host list and config cannot widen or bypass it", async () => {
    const f = fixture();
    expect(Object.isFrozen(ALLOWED_HOSTS)).toBe(true);
    expect(() => parseConfig({ ...config, allowedHosts: ["elsewhere.example"] })).toThrow(SAFE_ERROR);
    const widened = { ...config, routineOrigin: "https://elsewhere.example" };
    await expect(safeHttp(f.ctx, widened, new AbortController().signal)(
      "https://elsewhere.example/api/routine-triggers/public/test-mail/fire", { method: "POST" })).rejects.toThrow(SAFE_ERROR);
    expect(f.ctx.http.fetch).not.toHaveBeenCalled();
  });
  it("poison message does not block later messages; backoff doubles and survives restart", async () => {
    const f = fixture();
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["aa", "bb"]);
    expect(f.saved()).toEqual({ version: 2, notBefore: now - 7 * day, seen: [{ id: "bb", internalDate: now - day }],
      failures: [{ id: "aa", internalDate: now - day, attempts: 1, nextRetryAt: now + 120_000, lastFailureAt: now }] });
    vi.mocked(Date.now).mockReturnValue(now + 119_999);
    f.ids.push("cc"); f.dates.set("cc", now);
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["aa", "bb", "cc"]); // New mail passes an ID still in backoff.
    vi.mocked(Date.now).mockReturnValue(now + 120_000);
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["aa", "bb", "cc", "aa"]);
    expect(f.saved()).toMatchObject({ failures: [{ attempts: 2, nextRetryAt: now + 360_000, lastFailureAt: now + 120_000 }] });
    expect(JSON.stringify(f.saved())).not.toContain("MUST_NOT_PERSIST");
    const restarted = fixture(f.saved());
    await runTick(restarted.ctx, "company", config);
    expect(restarted.attempts).toEqual([]);
  });
  it("caps backoff at six hours and parks the tenth failure with a fixed warning", async () => {
    const f = fixture({ ...empty(), failures: [{ id: "aa", internalDate: now - day, attempts: 9, nextRetryAt: now }] });
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["aa", "bb"]);
    expect(f.saved()).toMatchObject({ failures: [{ attempts: 10, nextRetryAt: now + 6 * 3_600_000, lastFailureAt: now }] });
    expect(f.ctx.logger.warn.mock.calls).toEqual([["mail intake has parked deliveries: aa"]]);
    vi.mocked(Date.now).mockReturnValue(now + 6 * 3_600_000);
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["aa", "bb"]);
    expect(f.ctx.logger.warn).toHaveBeenCalledTimes(2);
  });
  it("names every parked ID in the fixed-text warning without mail or provider content", async () => {
    const f = fixture({ ...empty(), failures: ["aa", "bb"].map(id => ({
      id, internalDate: now - day, attempts: 10, nextRetryAt: now,
    })) });
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual([]);
    expect(f.ctx.logger.warn.mock.calls).toEqual([["mail intake has parked deliveries: aa, bb"]]);
  });
  it("widening seven to thirty days after pruning never re-fires old IDs but new mail fires", async () => {
    const oldDate = now - 8 * day;
    const f = fixture({ ...empty(),
      seen: [{ id: "bb", internalDate: oldDate }],
      failures: [{ id: "aa", internalDate: oldDate, attempts: 10, nextRetryAt: now }],
    });
    f.dates.set("aa", oldDate); f.dates.set("bb", oldDate);
    await runTick(f.ctx, "company", config);
    expect(f.saved()).toEqual({ ...empty(), notBefore: now - 7 * day });
    await runTick(f.ctx, "company", { ...config, scanWindowDays: 30 });
    expect(f.attempts).toEqual([]);
    expect(f.saved()).toEqual({ ...empty(), notBefore: now - 7 * day });
    f.ids.push("cc"); f.dates.set("cc", now);
    await runTick(f.ctx, "company", { ...config, scanWindowDays: 30 });
    expect(f.attempts).toEqual(["cc"]);
    expect(f.saved()).toMatchObject({ notBefore: now - 7 * day, seen: [{ id: "cc", internalDate: now }], failures: [] });
  });
  it("advances the floor on quiet ticks and never moves it backward on widening or clock rollback", async () => {
    const f = fixture({ ...empty(), notBefore: now - 7 * day }); f.ids.splice(0);
    vi.mocked(Date.now).mockReturnValue(now + day);
    await runTick(f.ctx, "company", config);
    expect(f.saved()).toMatchObject({ notBefore: now - 6 * day });
    vi.mocked(Date.now).mockReturnValue(now + 2 * day);
    await runTick(f.ctx, "company", { ...config, scanWindowDays: 30 });
    expect(f.saved()).toMatchObject({ notBefore: now - 6 * day });
    vi.mocked(Date.now).mockReturnValue(now - 2 * day);
    await runTick(f.ctx, "company", config);
    expect(f.saved()).toMatchObject({ notBefore: now - 6 * day });
  });
  it("persists a missing old-state floor on the first complete quiet tick", async () => {
    const f = fixture(); f.ids.splice(0);
    await runTick(f.ctx, "company", config);
    expect(f.saved()).toEqual({ ...empty(), notBefore: now - 7 * day });
    expect(f.ctx.state.set).toHaveBeenCalledTimes(1);
  });
  it("skips dates strictly below the floor without adding seen but admits the floor boundary", async () => {
    const floor = now - 3 * day;
    const f = fixture({ ...empty(), notBefore: floor });
    f.dates.set("aa", floor - 1); f.dates.set("bb", floor);
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["bb"]);
    expect(f.saved()).toEqual({ ...empty(), notBefore: floor, seen: [{ id: "bb", internalDate: floor }] });
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["bb"]); // Boundary seen ID must not be pruned and replayed.
  });
  it.each([-1, "1700000000000", null, Infinity, 1.5])("rejects an invalid persisted floor %s", async notBefore => {
    const f = fixture({ ...empty(), notBefore });
    await expect(runTick(f.ctx, "company", config)).rejects.toThrow(SAFE_ERROR);
    expect(f.ctx.http.fetch).not.toHaveBeenCalled(); expect(f.ctx.state.set).not.toHaveBeenCalled();
  });
  it("does not fire if the new floor cannot be durably checkpointed", async () => {
    const f = fixture();
    f.ctx.state.set.mockRejectedValue(new Error("provider secret"));
    await expect(runTick(f.ctx, "company", config)).rejects.toThrow(SAFE_ERROR);
    expect(f.attempts).toEqual([]); expect(f.saved()).toEqual(empty());
  });
  it.each([-1, "1700000000000", null])("rejects invalid last-failure time %s without leaking state", async lastFailureAt => {
    const f = fixture({ ...empty(), failures: [{ id: "aa", internalDate: now,
      attempts: 10, nextRetryAt: now, lastFailureAt }] });
    await expect(runTick(f.ctx, "company", config)).rejects.toThrow(SAFE_ERROR);
    expect(f.ctx.http.fetch).not.toHaveBeenCalled(); expect(f.ctx.logger.warn).not.toHaveBeenCalled();
  });
  it("uses a default seven-day window on every list page; rejects config beyond 30 days", async () => {
    const f = fixture();
    await runTick(f.ctx, "company", config);
    const lists = f.ctx.http.fetch.mock.calls.map(([url]) => new URL(url)).filter(u => u.pathname.endsWith("/messages"));
    expect(lists[0]!.searchParams.get("q")).toBe("-in:sent -in:drafts -in:chats newer_than:7d");
    const custom = fixture();
    await runTick(custom.ctx, "company", parseConfig({ ...config, scanWindowDays: 30 }));
    expect(custom.ctx.http.fetch.mock.calls.some(([url]) => new URL(url).searchParams.get("q")?.endsWith("newer_than:30d"))).toBe(true);
    for (const scanWindowDays of [0, 31, 1.5, "7", null]) expect(() => parseConfig({ ...config, scanWindowDays })).toThrow(SAFE_ERROR);
  });
  it("prunes old seen IDs and failures even when there are no new messages", async () => {
    const f = fixture({ version: 2,
      seen: [{ id: "cc", internalDate: now - 8 * day }, { id: "dd", internalDate: now - day }],
      failures: [{ id: "ee", internalDate: now - 8 * day, attempts: 10, nextRetryAt: now }] });
    f.ids.splice(0);
    await runTick(f.ctx, "company", config);
    expect(f.saved()).toEqual({ version: 2, notBefore: now - 7 * day,
      seen: [{ id: "dd", internalDate: now - day }], failures: [] });
    expect(f.ctx.logger.warn).not.toHaveBeenCalled();
  });
  it.each([
    { version: 2, seen: [], failures: [{ id: "aa", internalDate: now, attempts: 1, nextRetryAt: now, subject: "private" }] },
    { version: 2, seen: [], failures: [{ id: "aa", internalDate: now, attempts: 11, nextRetryAt: now }] },
    { version: 2, seen: [{ id: "aa", internalDate: -1 }], failures: [] },
    { version: 2, seen: [{ id: "aa", internalDate: now }], failures: [{ id: "aa", internalDate: now, attempts: 1, nextRetryAt: now }] },
  ])("rejects corrupt or content-bearing timestamp/failure state %#", async initial => {
    const f = fixture(initial);
    await expect(runTick(f.ctx, "company", config)).rejects.toThrow(SAFE_ERROR);
    expect(f.ctx.http.fetch).not.toHaveBeenCalled(); expect(f.ctx.state.set).not.toHaveBeenCalled();
  });
  it("does not deliver metadata outside the window or prune on an incomplete scan", async () => {
    const f = fixture(); f.dates.set("aa", now - 8 * day);
    await runTick(f.ctx, "company", config);
    expect(f.attempts).toEqual(["bb"]);
    const broken = fixture({ version: 2, seen: [{ id: "cc", internalDate: now - 8 * day }], failures: [] });
    broken.ctx.http.fetch.mockRejectedValue(new Error("provider secret"));
    await expect(runTick(broken.ctx, "company", config)).rejects.toThrow(SAFE_ERROR);
    expect(broken.ctx.state.set).not.toHaveBeenCalled();
  });
});
