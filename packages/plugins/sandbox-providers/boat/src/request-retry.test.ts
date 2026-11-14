import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const id = "bx_23456789";
function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Boat 429 retry", () => {
  it("retries command POST after Retry-After and succeeds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(response({ message: "private" }, 429, { "Retry-After": "1" })).mockResolvedValueOnce(response({ exitCode: 0, stdout: "ok", stderr: "" }));
    vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ exitCode: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries resume POST and succeeds", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ error: "secret" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "ready", expiresAt: "2030-01-01T00:00:00Z" } }));
    vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ providerLeaseId: id });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][1]?.method).toBe("POST");
    expect(fetch.mock.calls[1][1]?.method).toBe("POST");
  });

  it("fails after three 429s with the existing safe error", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response({ error: "secret" }, 429, { "Retry-After": "1" })); vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).rejects.toMatchObject({ message: `Boat POST /sandboxes/${id}/commands failed (429): http_error`, httpStatus: 429, category: "http_error" });
    expect(fetch).toHaveBeenCalledTimes(3);
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

  it("caps each Retry-After at 15 seconds and total waiting at 30 seconds", async () => {
    const fetch = vi.fn(async () => response({}, 429, { "Retry-After": "60" })); vi.stubGlobal("fetch", fetch);
    const startedAt = Date.now();
    await expect(plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 60_000 })).rejects.toMatchObject({ httpStatus: 429 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(30_500);
  }, 40_000);

  it("stops waiting when the request signal aborts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn().mockResolvedValue(response({}, 429, { "Retry-After": "10" })); vi.stubGlobal("fetch", fetch);
    const pending = plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ httpStatus: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
