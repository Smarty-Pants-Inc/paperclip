// RFL judge attack tests for Boat plugin 0.1.16 (9b00f48f). Synthetic HTTP only; no live Boat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// node:timers/promises is NOT faked by vi.useFakeTimers(): record every wait and move a virtual clock instead.
const waits: number[] = [];
vi.mock("node:timers/promises", async original => {
  const actual: any = await original();
  return { ...actual, setTimeout: async (ms: number, value?: unknown, options?: { signal?: AbortSignal }) => {
    if (options?.signal?.aborted) throw new Error("aborted");
    waits.push(ms); vi.setSystemTime(Date.now() + ms); return value;
  } };
});
import plugin from "./plugin.js";

const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const id = "bx_23456789";
const base = { driverKey: "boat", companyId: "company", environmentId: "environment", providerLeaseId: id, config };
function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); waits.length = 0; vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const calls = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${String(url).replace("https://boat.dev/api/v1", "")}`);
const resume = () => plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id });

describe("J-retry", () => {
  it("J1 create: 429 rate_limited then success replays the SAME Idempotency-Key and body (one sandbox)", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ code: "rate_limited" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "provisioning" } }, 202))
      .mockResolvedValue(response({ sandbox: { id, state: "error" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentAcquireLease!({ ...base, runId: "run", config } as any).catch(e => e);
    await pending;
    const list = calls(fetch);
    expect(list.slice(0, 2)).toEqual(["POST /sandboxes", "POST /sandboxes"]);
    const h0 = new Headers(fetch.mock.calls[0][1].headers).get("Idempotency-Key");
    const h1 = new Headers(fetch.mock.calls[1][1].headers).get("Idempotency-Key");
    expect(h0).toBeTruthy(); expect(h1).toBe(h0);
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(list.filter(c => c === "POST /sandboxes")).toHaveLength(2);
    await pending;
    expect(calls(fetch).filter(c => c === "POST /sandboxes")).toHaveLength(2);
    expect(calls(fetch).some(c => c.startsWith("DELETE /sandboxes/" + id) && !c.includes("/files") && !c.includes("/commands"))).toBe(false);
  });

  it("J2 at most 3 attempts on a start route, then fails with 429", async () => {
    const fetch = vi.fn().mockImplementation(async () => response({ code: "rate_limited" }, 429, { "Retry-After": "1" })); vi.stubGlobal("fetch", fetch);
    const pending = resume().catch(e => e);
    const error = await pending;
    expect(error).toMatchObject({ httpStatus: 429 });
    expect(calls(fetch)).toEqual([`POST /sandboxes/${id}/resume`, `POST /sandboxes/${id}/resume`, `POST /sandboxes/${id}/resume`]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("J3 whole call stays <= 30 s: second Retry-After past the REMAINING budget fails at once", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const t0 = Date.now();
    const fetch = vi.fn().mockImplementation(async () => response({ code: "rate_limited" }, 429, { "Retry-After": "20" })); vi.stubGlobal("fetch", fetch);
    let doneAt = 0;
    const pending = resume().catch(e => { doneAt = Date.now(); return e; });
    const error = await pending;
    expect(error).toMatchObject({ httpStatus: 429 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(doneAt - t0).toBeLessThanOrEqual(30_000);
    expect(doneAt - t0).toBeGreaterThanOrEqual(20_000);
    process.stderr.write("\n" + "J3_ELAPSED_VIRTUAL_MS " + (doneAt - t0) + " waits=" + JSON.stringify(waits));
  });

  it.each([[0, 1000, 1000], [0.5, 1100, 1100], [0.999999, 1199, 1200]])("J4 jitter bounds: random=%s waits within [Retry-After, 1.2x]", async (random, lower, upper) => {
    vi.spyOn(Math, "random").mockReturnValue(random);
    const fetch = vi.fn().mockResolvedValueOnce(response({ code: "rate_limited" }, 429, { "Retry-After": "1" }))
      .mockImplementation(async () => response({ sandbox: { id, state: "ready", expiresAt: "2030-01-01T00:00:00Z" } })); vi.stubGlobal("fetch", fetch);
    await resume().catch(e => e);
    expect(waits[0]).toBeGreaterThanOrEqual(lower); expect(waits[0]).toBeLessThanOrEqual(upper);
  });

  it.each(["IP_RATE_LIMIT_EXCEEDED", "trial_compute_limit_reached", undefined])("J5 start route 429 with code %s is NOT retried", async code => {
    const fetch = vi.fn().mockImplementation(async () => response(code ? { code } : {}, 429, { "Retry-After": "1" })); vi.stubGlobal("fetch", fetch);
    await expect(resume()).rejects.toMatchObject({ httpStatus: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["PUT files", () => plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "cat", args: [], stdin: "x".repeat(10), timeoutMs: 5000 } as any)],
    ["POST stop", () => plugin.definition.onEnvironmentReleaseLease!({ ...base } as any)],
  ])("J6 429 on %s is not replayed", async (_name, run) => {
    const fetch = vi.fn().mockImplementation(async () => response({ code: "rate_limited" }, 429, { "Retry-After": "1" })); vi.stubGlobal("fetch", fetch);
    await expect(run()).rejects.toBeTruthy();
    const nonGet = calls(fetch).filter(c => !c.startsWith("GET ") && !c.startsWith("DELETE "));
    expect(nonGet).toHaveLength(1);
  });

  it("J7 secrets/message text never reach the log, even from headers or the error body", async () => {
    const fetch = vi.fn().mockImplementation(async () => response({ code: "rate_limited", message: "MSG-TEXT hunter2", error: { code: "rate_limited", message: "nested MSG-TEXT", details: { token: "sk-live-abc" } } }, 429, { "Retry-After": "1" })); vi.stubGlobal("fetch", fetch);
    const pending = resume().catch(e => e);
    const error = await pending;
    const logged = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, logger.error.mock.calls, logger.debug.mock.calls]);
    for (const secret of ["synthetic-boat-key", "MSG-TEXT", "hunter2", "sk-live-abc", "Bearer", id]) expect(logged).not.toContain(secret);
    expect(String(error?.message)).not.toContain("synthetic-boat-key");
    expect(String(error?.message)).not.toContain("MSG-TEXT");
  });
});

describe("J-stop", () => {
  const release = (cfg: any = config) => plugin.definition.onEnvironmentReleaseLease!({ ...base, config: cfg } as any);
  it("S1 archived box: 200 + last stop -> DONE, kept, no DELETE/commands/files", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ stop: { id: "stop_old", status: "completed" } }, 200))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived", stop: { id: "stop_old", status: "completed" } } }));
    vi.stubGlobal("fetch", fetch);
    await expect(release()).resolves.toEqual({ providerLeaseId: id, state: "stopped" });
    expect(calls(fetch)).toEqual([`POST /sandboxes/${id}/stop`, `GET /sandboxes/${id}`]);
  });

  it("S2 'idle' with no stop object is NOT done: bounded 120 s poll, then fails", async () => {
    const fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => init?.method === "POST" ? response({ ok: true }, 200) : response({ sandbox: { id, state: "idle" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = release().then(v => ({ ok: v }), e => ({ err: e }));
    const out: any = await pending;
    expect(out.err).toBeTruthy(); expect(String(out.err.message)).toContain("did not complete");
    const list = calls(fetch);
    expect(list.filter(c => c.startsWith("POST"))).toHaveLength(1);
    process.stderr.write("\n" + "S2_CALLS " + list.length + " posts=" + JSON.stringify(list.filter(c => c.startsWith("POST"))) + " waits=" + waits.length);
    expect(list.length).toBeLessThanOrEqual(82);
    expect(list.some(c => c.startsWith("DELETE") || c.includes("/commands") || c.includes("/files"))).toBe(false);
  });

  it("S3 a 404 on POST /stop is NOT treated as done", async () => {
    const fetch = vi.fn().mockImplementation(async () => response({ code: "not_found" }, 404)); vi.stubGlobal("fetch", fetch);
    await expect(release()).rejects.toMatchObject({ httpStatus: 404 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("S4 a 404 on the confirming GET is NOT treated as done", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ok: true }, 200)).mockImplementation(async () => response({ code: "not_found" }, 404));
    vi.stubGlobal("fetch", fetch);
    await expect(release()).rejects.toMatchObject({ httpStatus: 404 });
    expect(calls(fetch)).toEqual([`POST /sandboxes/${id}/stop`, `GET /sandboxes/${id}`]);
  });

  it("S5 superseded stop still fails honestly (the old assertion, on the new poll shape)", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ stop: { id: "stop_b", status: "pending" } }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "ready", stop: { id: "stop_b", status: "superseded" } } }));
    vi.stubGlobal("fetch", fetch);
    await expect(release()).rejects.toThrow("entered superseded");
  });

  it("S6 wrong sandbox id on the confirming GET is refused", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ok: true }, 200))
      .mockResolvedValueOnce(response({ sandbox: { id: "bx_other999", state: "archived" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(release()).rejects.toBeTruthy();
  });

  // PROBE (records behaviour; see VERDICT finding F1): the completion predicate is not bound to the
  // stop id that POST /stop returned, and falls back to the POST body when the GET has no stop.
  it("P1 PROBE: POST 202 stop_b pending; GET shows state idle + a DIFFERENT completed stop", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ stop: { id: "stop_b", status: "pending" } }, 202))
      .mockResolvedValue(response({ sandbox: { id, state: "idle", stop: { id: "stop_a_old", status: "completed" } } }));
    vi.stubGlobal("fetch", fetch);
    const out = await release().then(v => ({ ok: v }), e => ({ err: String(e?.message) }));
    process.stderr.write("\n" + "P1_RESULT " + JSON.stringify(out));
  });
  it("P2 PROBE: POST 200 last stop completed; confirming GET says state idle and carries no stop", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ stop: { id: "stop_a", status: "completed" } }, 200))
      .mockResolvedValue(response({ sandbox: { id, state: "idle" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = release().then(v => ({ ok: v }), e => ({ err: String(e?.message) }));
    process.stderr.write("\n" + "P2_RESULT " + JSON.stringify(await pending));
  });
  it("P3 PROBE: ssh carrier release when the pre-retire state GET fails (429)", async () => {
    const fetch = vi.fn().mockImplementation(async () => response({ code: "IP_RATE_LIMIT_EXCEEDED" }, 429, { "Retry-After": "1" }));
    vi.stubGlobal("fetch", fetch);
    const out = await release({ ...config, duplexCarrier: "ssh" }).then(v => ({ ok: v }), e => ({ err: String(e?.message) }));
    process.stderr.write("\n" + "P3_RESULT " + JSON.stringify(out) + " calls=" + JSON.stringify(calls(fetch)));
  });
});
