import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentAcquireErrorData, PluginEnvironmentCreationCleanupError, readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

// Keep: frozen7-VERDICT F2. A create that Boat definitely refused (HTTP 400) is
// followed by the post-failure ownership lookup; when that lookup fails with a
// 503 or ECONNRESET, the acquire error must stay the create's REFUSAL, not
// become transient, so the host does not loop on a refused create. The cleanup
// obligation is kept apart: core's durable creation intent re-runs inspection,
// which repeats the lookup (throwing while it is out) and returns the exact
// ownership envelope for any box it finds. Strict fixtures, never live Boat.
const id = "bx_23456789";
const canary = "synthetic-transport-canary";
const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const params = { driverKey: "boat", companyId: "company", environmentId: "environment", runId: "run", creationOperationId: "attempt", config };
const labels = { owner: "paperclip:company", environment: "environment", run: "run", "paperclip-acquire": "attempt" };
// server/src/services/environment-provider-unavailable-error.ts:17-23 (acquire, structure only).
const HOST_TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const HOST_TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
const SERVER_RESUME_TEXT = /\b(timeout|timed out|rate limit|temporar|network|connection reset|service unavailable)\b/;
function hostWouldRetryAcquire(error: unknown): boolean {
  const d = (environmentAcquireErrorData(error) as { providerDiagnostic?: { httpStatus?: number; errorCode?: string } } | undefined)?.providerDiagnostic;
  return !!d && ((d.httpStatus !== undefined && HOST_TRANSIENT_STATUSES.has(d.httpStatus)) || (d.errorCode !== undefined && HOST_TRANSIENT_CODES.has(d.errorCode)));
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function networkFailure(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code} 10.0.0.1:443 ${canary}`), { code, syscall: "connect", address: canary }) });
}
type Lookup = "503" | "ECONNRESET";
function fixture(lookup: Lookup) {
  const calls: { method: string; route: string }[] = [];
  let listOut = true, boxListed = false;
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const route = url.pathname.replace("/api/v1", ""); calls.push({ method, route });
    if (method === "POST" && route === "/sandboxes") return response({ message: canary, code: "invalid_request" }, 400);
    if (method === "GET" && route === "/sandboxes") {
      expect(url.searchParams.get("label")).toBe("paperclip-acquire=attempt");
      if (listOut) {
        if (lookup === "503") return response({ message: canary }, 503);
        throw networkFailure("ECONNRESET");
      }
      return response({ sandboxes: boxListed ? [{ id, labels }] : [], pageInfo: { nextCursor: null } });
    }
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch, heal: (listed: boolean) => { listOut = false; boxListed = listed; } };
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("frozen8 F2: a definite create refusal survives a failing cleanup lookup", () => {
  it.each<Lookup>(["503", "ECONNRESET"])("F2 create 400 then a %s on the ownership lookup stays a 400 refusal, cleanup kept by inspection", async lookup => {
    const f = fixture(lookup);
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    // The acquire error is the create's refusal.
    expect(error).not.toBeInstanceOf(PluginEnvironmentCreationCleanupError);
    expect(error).toMatchObject({ status: 400, httpStatus: 400, category: "http_error" });
    expect(error.message).toBe("Boat POST /sandboxes failed (400): http_error");
    expect(error.code).toBeUndefined();
    expect(environmentAcquireErrorData(error)).toEqual({ schema: "paperclip/environment-acquire-error/v1", providerDiagnostic: { httpStatus: 400 } });
    expect(hostWouldRetryAcquire(error)).toBe(false);
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(false);
    expect(Object.hasOwn(error, "cause")).toBe(false);
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(canary);
    // One refused create, one failed lookup: no loop.
    expect(f.calls.filter(c => c.method === "POST" && c.route === "/sandboxes")).toHaveLength(1);
    expect(f.calls.filter(c => c.method === "GET" && c.route === "/sandboxes")).toHaveLength(1);
    // The failed lookup is logged without provider text or the key.
    expect(logger.warn).toHaveBeenCalledWith("Boat acquisition ownership lookup failed after a refused create; cleanup stays with the creation intent",
      expect.objectContaining({ attemptId: "attempt", createStatus: 400 }));
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain(canary); expect(logged).not.toContain(config.apiKey);

    // The cleanup obligation is kept: inspection of the durable creation intent
    // repeats the lookup. While the list is out it throws (intent stays scheduled).
    const inspect = () => plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "attempt", creationOperation: { id: "attempt", runId: "run" } });
    await expect(inspect()).rejects.toThrow();
    // A box that did materialize under the attempt label is returned with its exact ownership envelope.
    f.heal(true);
    const observed = await inspect();
    expect(observed.providerLeaseId).toBe(id);
    expect(readEnvironmentCreationCleanupError({ data: { schema: "paperclip/environment-creation-cleanup/v1", cleanup: observed.creationCleanup } }))
      .toMatchObject({ providerLeaseId: id, companyId: "company", environmentId: "environment", runId: "run", attemptId: "attempt", labels: { "paperclip-acquire": "attempt" } });
  });
});
