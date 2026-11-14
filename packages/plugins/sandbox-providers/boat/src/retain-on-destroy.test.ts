import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";

// Keep: raw-session data safety and provider/core termination trust boundary.
// Strict HTTP fixtures only; no live Boat calls or persistence claim.
const config = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const id = "bx_23456789";
const base = { driverKey: "boat", companyId: "company", environmentId: "environment", providerLeaseId: id, config };
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function stopResponses() {
  return vi.fn().mockResolvedValueOnce(response({ operation: { id: "stop_retained", status: "pending" } }, 202))
    .mockResolvedValueOnce(response({ sandbox: { id, state: "archiving", stop: { id: "stop_retained", status: "completed" } } }));
}
function assertNonForceStop(fetch: ReturnType<typeof vi.fn>, offset = 0) {
  expect(fetch.mock.calls.slice(offset).map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
    [`https://boat.dev/api/v1/sandboxes/${id}/stop`, "POST"],
    [`https://boat.dev/api/v1/sandboxes/${id}`, "GET"],
  ]);
  expect(JSON.parse(String(fetch.mock.calls[offset][1]?.body))).toEqual({});
  expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("retainOnDestroy compatibility", () => {
  it("checks state before SSH retirement and sends no commands or files to an archived box", async () => {
    const sshConfig = { ...config, duplexCarrier: "ssh" };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }, 200))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentReleaseLease!({ ...base, config: sshConfig }))
      .resolves.toEqual({ providerLeaseId: id, state: "stopped" });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      [`https://boat.dev/api/v1/sandboxes/${id}`, "GET"],
      [`https://boat.dev/api/v1/sandboxes/${id}/stop`, "POST"],
      [`https://boat.dev/api/v1/sandboxes/${id}`, "GET"],
    ]);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/commands") || String(url).includes("/files"))).toBe(false);
  });
  it("declares an ignored boolean default true and always normalizes retention on", async () => {
    expect(manifest.environmentDrivers?.[0]?.configSchema?.properties?.retainOnDestroy).toMatchObject({
      type: "boolean", default: true, description: "ignored: sandboxes are always stopped and kept",
    });
    for (const reuseLease of [false, true]) for (const retainOnDestroy of [undefined, false, true]) {
      expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, reuseLease, ...(retainOnDestroy === undefined ? {} : { retainOnDestroy }) } }))
        .toMatchObject({ ok: true, normalizedConfig: { reuseLease, retainOnDestroy: true } });
    }
  });

  it.each(["true", 1, null])("rejects a non-boolean compatibility key: %j", async retainOnDestroy => {
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...config, retainOnDestroy } }))
      .toMatchObject({ ok: false, errors: expect.arrayContaining(["retainOnDestroy must be a boolean."]) });
  });
});

describe.each([undefined, false, true])("unconditional retention with retainOnDestroy=%s", retainOnDestroy => {
  // Omit the key entirely for legacy lease configurations, not just set undefined.
  const retainedConfig = { ...config, ...(retainOnDestroy === undefined ? {} : { retainOnDestroy }) };
  it.each([false, true])("destroy confirms STOP, not DELETE, with reuseLease=%s", async reuseLease => {
    const fetch = stopResponses(); vi.stubGlobal("fetch", fetch);
    const receipt = await plugin.definition.onEnvironmentDestroyLease!({ ...base, config: { ...retainedConfig, reuseLease } });
    expect(receipt).toEqual({ providerLeaseId: id, state: "stopped" });
    assertNonForceStop(fetch);
  });

  it.each([false, true])("release confirms STOP independently of reuseLease=%s", async reuseLease => {
    const fetch = stopResponses(); vi.stubGlobal("fetch", fetch);
    expect(await plugin.definition.onEnvironmentReleaseLease!({ ...base, config: { ...retainedConfig, reuseLease } }))
      .toEqual({ providerLeaseId: id, state: "stopped" });
    assertNonForceStop(fetch);
  });

  it.each(["readiness", "setup"])("failed acquisition retains the exact created sandbox after %s failure", async failure => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id, state: "provisioning" } }, 202));
    if (failure === "readiness") fetch.mockResolvedValueOnce(response({ sandbox: { id, state: "error" } }));
    else fetch.mockResolvedValueOnce(response({ sandbox: { id, state: "ready" } }))
      .mockResolvedValueOnce(response({ sandbox: { id, setupStatus: "failed", setupError: "install failed" } }));
    fetch.mockResolvedValueOnce(response({ operation: { id: "stop_retained" } }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archiving", stop: { id: "stop_retained", status: "completed" } } }));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...base, runId: "run", config: { ...retainedConfig, ...(failure === "setup" ? { setupScript: "false" } : {}) } }))
      .rejects.toThrow(failure === "setup" ? "install failed" : "entered error");
    assertNonForceStop(fetch, failure === "setup" ? 3 : 2);
  });

  it("accepts 200 already-stopped response only after GET confirms archived", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }, 200))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentReleaseLease!({ ...base, config: retainedConfig }))
      .resolves.toEqual({ providerLeaseId: id, state: "stopped" });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      [`https://boat.dev/api/v1/sandboxes/${id}/stop`, "POST"],
      [`https://boat.dev/api/v1/sandboxes/${id}`, "GET"],
    ]);
    expect(fetch.mock.calls.some(([url, init]) => String(url).includes("/commands") || String(url).includes("/files") || init?.method === "DELETE")).toBe(false);
  });

  it("does not turn a real Boat 500 into a successful stop", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "internal" }, 500));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentReleaseLease!({ ...base, config: retainedConfig }))
      .rejects.toThrow("failed (500)");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("confirms a 202 without an operation id by polling sandbox state", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ok: true }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archiving" } }))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archived" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentReleaseLease!({ ...base, config: retainedConfig }))
      .resolves.toEqual({ providerLeaseId: id, state: "stopped" });
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method ?? "GET"])).toEqual([
      [`https://boat.dev/api/v1/sandboxes/${id}/stop`, "POST"],
      [`https://boat.dev/api/v1/sandboxes/${id}`, "GET"],
      [`https://boat.dev/api/v1/sandboxes/${id}`, "GET"],
    ]);
  });

  it.each(["http", "superseded", "missing-operation"])("destroy fails honestly without DELETE on %s", async failure => {
    const fetch = failure === "http" ? vi.fn().mockResolvedValueOnce(response({ message: "unavailable" }, 503))
      : failure === "missing-operation" ? vi.fn().mockResolvedValueOnce(response({ ok: true }))
      : vi.fn().mockResolvedValueOnce(response({ operation: { id: "stop_retained" } }))
        .mockResolvedValueOnce(response({ stop: { id: "stop_retained", status: "superseded" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentDestroyLease!({ ...base, config: retainedConfig })).rejects.toThrow();
    expect(fetch.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
  });
});
