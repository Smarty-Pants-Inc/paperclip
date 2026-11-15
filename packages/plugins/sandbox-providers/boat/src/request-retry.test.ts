import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const id = "bx_23456789";
function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Boat 429 retry", () => {
  it("does not replay commands when docs do not say a 429 means nothing ran, and logs safe details", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ code: "rate_limited", message: "do not log me" }, 429, {
      "Retry-After": "1", RateLimit: '"ip";r=2;t=60', "RateLimit-Policy": '"ip";q=10000;w=60',
    })); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 })).rejects.toMatchObject({ httpStatus: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("Boat API 429", expect.objectContaining({ method: "POST", route: "/sandboxes/{sandboxId}/commands", attempt: "1/3", retryAfter: "1", rateLimit: '"ip";r=2;t=60', rateLimitPolicy: '"ip";q=10000;w=60', code: "rate_limited" }));
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain("synthetic-boat-key"); expect(logged).not.toContain("do not log me");
  });

  it("retries resume POST and succeeds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ code: "rate_limited", error: "secret" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "ready", expiresAt: "2030-01-01T00:00:00Z" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id });
    await vi.advanceTimersByTimeAsync(1200);
    await expect(pending).resolves.toMatchObject({ providerLeaseId: id });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][1]?.method).toBe("POST");
    expect(fetch.mock.calls[1][1]?.method).toBe("POST");
  });

  it("fails at once when Retry-After exceeds the remaining whole-call budget", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ code: "rate_limited" }, 429, { "Retry-After": "31" })); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id })).rejects.toMatchObject({ message: `Boat POST /sandboxes/${id}/resume failed (429): http_error`, httpStatus: 429, category: "http_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([500, 409, 404])("does not retry HTTP %s", async status => {
    const fetch = vi.fn().mockResolvedValue(response({}, status)); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 })).rejects.toMatchObject({ httpStatus: status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry a network error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("secret")); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 })).rejects.toMatchObject({ httpStatus: null, category: "network_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("waits exactly Retry-After before retrying start-limit 429s", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetch = vi.fn().mockResolvedValueOnce(response({ code: "rate_limited" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "ready", expiresAt: "2030-01-01T00:00:00Z" } })); vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ providerLeaseId: id });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("stops waiting when the request signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn().mockResolvedValue(response({}, 429, { "Retry-After": "10" })); vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 60_000 });
    const rejected = expect(pending).rejects.toMatchObject({ httpStatus: 429 });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caps IP pauses at 120 seconds and logs the pause plus a refused call with a distinct code", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response({ code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 9999 }, 429, { "Retry-After": "9999" }));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id }))
      .rejects.toMatchObject({ message: "boat_ip_rate_limit_paused", code: "boat_ip_rate_limit_paused" });
    expect(logger.warn).toHaveBeenCalledWith("Boat IP rate-limit pause", expect.objectContaining({
      reason: "IP_RATE_LIMIT_EXCEEDED", pauseUntil: new Date(Date.now() + 120_000).toISOString(), retryAfter: "9999",
      method: "POST", route: "/sandboxes/{sandboxId}/resume",
    }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Boat IP rate-limit pause until "), expect.objectContaining({
      method: "POST", route: "/sandboxes/{sandboxId}/resume", deadline: expect.any(String),
    }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalledWith("Boat API 429", expect.anything());
  });

  it("honors IP_RATE_LIMIT_EXCEEDED once and pauses other calls in this worker", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 2 }, 429, { "Retry-After": "2" }))
      .mockResolvedValueOnce(response({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    vi.stubGlobal("fetch", fetch);
    const first = plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config,
      lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 });
    const firstRejected = first.then(error => { throw new Error(`expected first call to fail, got ${JSON.stringify(error)}`); }, error => {
      expect(error).toMatchObject({ httpStatus: 429 });
    });
    await vi.advanceTimersByTimeAsync(0);
    const second = plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config,
      lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await firstRejected;
    await expect(second).resolves.toMatchObject({ exitCode: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
