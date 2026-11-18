import { afterEach, describe, expect, it, vi } from "vitest";
import { findReusableSandboxProviderLeaseId } from "../../../../../server/src/services/sandbox-provider-runtime.js";
import { PluginEnvironmentStopError } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

// Keep: data safety and the provider/core trust boundary (review 0.1.3 F1–F3).
// HTTP is mocked; these checks do not establish a live Boat session survived.
const config = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, setupTimeoutSeconds: 180, reuseLease: true, labels: {} };
const base = { driverKey: "boat", companyId: "company", environmentId: "environment", config, providerLeaseId: "bx_23456789" };
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
afterEach(() => vi.unstubAllGlobals());

describe("0.1.3 review regressions", () => {
  it.each([{}, { team: "daily", owner: "configured-owner" }])("F1: acquire metadata preserves config labels for the real core selector: %j", async labels => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ sandbox: { id: base.providerLeaseId, state: "provisioning" } }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id: base.providerLeaseId, state: "ready" } }));
    vi.stubGlobal("fetch", fetch);
    const coreConfig = { provider: "boat", ...config, labels };
    const acquired = await plugin.definition.onEnvironmentAcquireLease!({ ...base, config: coreConfig, runId: "run", creationOperationId: "creation" });
    const recorded = { ...acquired, metadata: { ...coreConfig, ...acquired.metadata } };
    expect(findReusableSandboxProviderLeaseId({ config: coreConfig, leases: [recorded] })).toBe(base.providerLeaseId);
    expect(recorded.metadata.labels).toEqual(labels);
    const requestLabels = JSON.parse(String(fetch.mock.calls[0][1]?.body)).labels;
    expect(requestLabels).toMatchObject({ ...labels, owner: "paperclip:company", environment: "environment", run: "run", creation: "creation" });
    expect(acquired.metadata?.providerLabels).toEqual(requestLabels);
  });

  it.each(["operation", "stop", "sandbox.stop"])("F2: release accepts the %s stop envelope without DELETE", async envelope => {
    const stop = { id: "stop_123", status: "pending" };
    const body = envelope === "sandbox.stop" ? { sandbox: { id: base.providerLeaseId, stop } } : { [envelope]: stop };
    const fetch = vi.fn().mockResolvedValueOnce(response(body, 202))
      .mockResolvedValueOnce(response({ sandbox: { id: base.providerLeaseId, state: "archiving", stop: { ...stop, status: "completed" } } }));
    vi.stubGlobal("fetch", fetch);
    expect(await plugin.definition.onEnvironmentReleaseLease!(base)).toEqual({ providerLeaseId: base.providerLeaseId, state: "stopped" });
    expect(fetch.mock.calls.map(call => call[1]?.method ?? "GET")).toEqual(["POST", "GET"]);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({}); // never force away unsaved data
  });

  it("F2: a failing stop is not a receipt; Boat's failing stop record returns its refusal at once (PARITY rows 1+2)", async () => {
    // Boat's documented shapes: the 202 carries the stop {id, status}; GET /sandboxes/{id}/stops/{stopId}
    // reads it; a failed save shows `failing` with its `error` (staged boat-llms-full.txt :1785-1789, :1850-1856).
    // Superseded contract: this test used to wait through `failing` until `completed`; a refused stop now
    // returns at once, typed and non-terminal, and is not resent inside a back-off. Own box id: the back-off is per box.
    const id = "bx_f2refuse";
    const stop = { id: "stop_123", status: "failing", error: "Refusing archive/stop: no successful snapshot in the last 30 minutes" };
    const fetch = vi.fn().mockResolvedValueOnce(response({ operation: stop }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id, state: "archiving", stop } }))
      .mockResolvedValueOnce(response({ stop }));
    vi.stubGlobal("fetch", fetch);
    const error = await plugin.definition.onEnvironmentReleaseLease!({ ...base, providerLeaseId: id }).catch(e => e);
    expect(error).toBeInstanceOf(PluginEnvironmentStopError);
    expect(error.message).toContain(stop.error);
    expect(fetch.mock.calls.map(call => `${call[1]?.method ?? "GET"} ${new URL(String(call[0])).pathname}`)).toEqual([
      `POST /api/v1/sandboxes/${id}/stop`, `GET /api/v1/sandboxes/${id}`, `GET /api/v1/sandboxes/${id}/stops/stop_123`]);
  });

  it("F3: dedicated stop retains the exact allocation even when reuse is disabled", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ operation: { id: "stop_123" } }, 202))
      .mockResolvedValueOnce(response({ sandbox: { id: base.providerLeaseId, state: "archiving", stop: { id: "stop_123", status: "completed" } } }));
    vi.stubGlobal("fetch", fetch);
    expect(await plugin.definition.onEnvironmentStopLease?.({ ...base, config: { ...config, reuseLease: false }, resourceDisposition: "stop_and_retain" })).toEqual({ providerLeaseId: base.providerLeaseId, state: "stopped" });
    expect(fetch.mock.calls.map(call => call[1]?.method ?? "GET")).toEqual(["POST", "GET"]);
  });

  it("F3: stop-only errors propagate without a fabricated receipt or deletion", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ message: "temporarily unavailable" }, 503));
    vi.stubGlobal("fetch", fetch);
    expect(plugin.definition.onEnvironmentStopLease).toBeTypeOf("function");
    await expect(plugin.definition.onEnvironmentStopLease!({ ...base, resourceDisposition: "stop_and_retain" })).rejects.toThrow("failed (503)");
    expect(fetch.mock.calls.map(call => call[1]?.method ?? "GET")).toEqual(["POST"]);
  });
});
