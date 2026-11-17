import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentAcquireErrorData, environmentResumeErrorData } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

// Keep: frozen7-VERDICT F1 (IP-rate-limit strand). When Boat's IP rate-limit
// pause outlasts a call's budget, request() refuses the call without sending it.
// That refusal must read like frozen7's other transient errors: integer status
// 429 for the host's structure-only acquire retry (SDK providerErrorDiagnostic)
// and the words "(rate limit)" for the server's text-only resume retry. Its own
// code stays distinct. This file has its own module instance: the worker-wide
// pause it sets cannot leak into other test files. Synthetic keys, never live Boat.
const id = "bx_23456789";
const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const acquire = { driverKey: "boat", companyId: "company", environmentId: "environment", runId: "run", creationOperationId: "attempt", config };
// server/src/services/environment-provider-unavailable-error.ts:17-23 (acquire, structure only).
const HOST_TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// server/src/services/environment-runtime.ts transientSandboxResumeFailure (resume, text).
const SERVER_RESUME_TEXT = /\b(timeout|timed out|rate limit|temporar|network|connection reset|service unavailable)\b/;
function response(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("frozen8 F1: an IP rate-limit pause refusal is a transient 429", () => {
  it("F1 resume, execute and acquire refused by the pause carry status 429 and the '(rate limit)' words", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValue(response({ code: "IP_RATE_LIMIT_EXCEEDED", retryAfter: 9999, message: "do not keep me" }, 429, { "Retry-After": "9999" }));
    vi.stubGlobal("fetch", fetch);

    // 1. The call that meets the 429 and then the over-budget pause.
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id }).catch(e => e);
    expect(resumed).toMatchObject({ status: 429, httpStatus: 429, category: "http_error", code: "boat_ip_rate_limit_paused" });
    expect(resumed.message).toBe(`Boat POST /sandboxes/${id}/resume failed (429): http_error (rate limit)`);
    expect(SERVER_RESUME_TEXT.test(resumed.message.toLowerCase())).toBe(true);
    expect(environmentResumeErrorData(resumed)?.diagnostic).toEqual({ httpStatus: 429 });
    expect(Object.hasOwn(resumed, "cause")).toBe(false);
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(resumed))).not.toContain("do not keep me");
    expect(fetch).toHaveBeenCalledTimes(1);

    // 2. A call refused without a request while the pause holds.
    const executed = await plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config,
      lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000 }).catch(e => e);
    expect(executed).toMatchObject({ status: 429, httpStatus: 429, code: "boat_ip_rate_limit_paused" });
    expect(executed.message).toBe(`Boat POST /sandboxes/${id}/commands failed (429): http_error (rate limit)`);
    expect(fetch).toHaveBeenCalledTimes(1);

    // 3. An acquire refused by the pause is host-transient by structure.
    const acquired = await plugin.definition.onEnvironmentAcquireLease!(acquire).catch(e => e);
    expect(acquired).toMatchObject({ status: 429, httpStatus: 429 });
    expect(acquired.message).toContain("(rate limit)");
    const diagnostic = (environmentAcquireErrorData(acquired) as { providerDiagnostic?: { httpStatus?: number } } | undefined)?.providerDiagnostic;
    expect(diagnostic).toEqual({ httpStatus: 429 });
    expect(HOST_TRANSIENT_STATUSES.has(diagnostic!.httpStatus!)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
