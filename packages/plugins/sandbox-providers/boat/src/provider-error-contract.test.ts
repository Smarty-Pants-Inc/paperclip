import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentAcquireErrorData, environmentResumeErrorData, PluginEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

// The SDK does not re-export providerErrorDiagnostic itself; its public worker
// envelope environmentResumeErrorData returns exactly that diagnostic
// (packages/plugins/sdk/src/environment-resume-error.ts:34-50).
const providerErrorDiagnostic = (error: unknown) => environmentResumeErrorData(error)?.diagnostic ?? null;

// Keep: frozen7 provider error contract. The host retries a failed acquire only
// from STRUCTURE (integer status/statusCode/response.status, or a closed errno
// `code`, on the error or a cause up to 4 deep), read through the SDK's
// providerErrorDiagnostic. The resume retry reads only message TEXT. Strict
// HTTP fixtures with synthetic noncredential keys, never live Boat.
const id = "bx_23456789";
const canary = "synthetic-transport-canary";
const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const params = { driverKey: "boat", companyId: "company", environmentId: "environment", runId: "run", creationOperationId: "attempt", config };
const labels = { owner: "paperclip:company", environment: "environment", run: "run", "paperclip-acquire": "attempt" };
// server/src/services/environment-provider-unavailable-error.ts:17-23 (acquire, structure only).
const HOST_TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const HOST_TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
// server/src/services/environment-runtime.ts transientSandboxResumeFailure (resume, text).
const SERVER_RESUME_TEXT = /\b(timeout|timed out|rate limit|temporar|network|connection reset|service unavailable)\b/;
function hostWouldRetryAcquire(error: unknown): boolean {
  const data = environmentAcquireErrorData(error) as { providerDiagnostic?: { httpStatus?: number; errorCode?: string } } | undefined;
  const d = data?.providerDiagnostic;
  return !!d && ((d.httpStatus !== undefined && HOST_TRANSIENT_STATUSES.has(d.httpStatus)) || (d.errorCode !== undefined && HOST_TRANSIENT_CODES.has(d.errorCode)));
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function networkFailure(code: string): TypeError {
  // undici's shape: TypeError("fetch failed", { cause: Error & { code } }), the cause text carries host details.
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`connect ${code} 10.0.0.1:443 ${canary}`), { code, syscall: "connect", address: canary }) });
}
type Route = (method: string, route: string, init: any) => Response | Promise<Response> | undefined;
function fixture(create: Route, extra: Route = () => undefined) {
  const calls: { method: string; route: string }[] = [];
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const route = url.pathname.replace("/api/v1", ""); calls.push({ method, route });
    if (method === "POST" && route === "/sandboxes") return create(method, route, init) ?? response({ sandbox: { id } });
    const handled = await extra(method, route, init);
    if (handled) return handled;
    if (method === "GET" && route === "/sandboxes") return response({ sandboxes: [], pageInfo: { nextCursor: null } });
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}
function assertNoRawCause(error: unknown) {
  const e = error as Error;
  expect(Object.hasOwn(e, "cause")).toBe(false);
  for (const value of [String(e), e.message, e.stack, JSON.stringify(Object.getOwnPropertyDescriptors(e))]) {
    expect(value?.includes(canary)).toBe(false);
    expect(value?.includes(config.apiKey)).toBe(false);
  }
}
function timeoutStub() {
  // Our own call deadline: fetch rejects with the AbortSignal.timeout reason (TimeoutError).
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(5));
  return async (_input: unknown, init?: RequestInit) => {
    const signal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("frozen7 acquire error carries host-readable structure", () => {
  it("(a) a 502 on create reaches the host as status 502, transient by the SDK diagnostic", async () => {
    const f = fixture(() => response({ message: canary }, 502));
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(error).toMatchObject({ status: 502, httpStatus: 502, category: "http_error" });
    expect(providerErrorDiagnostic(error)).toEqual({ httpStatus: 502 });
    expect(environmentAcquireErrorData(error)).toMatchObject({ providerDiagnostic: { httpStatus: 502 } });
    expect(hostWouldRetryAcquire(error)).toBe(true);
    assertNoRawCause(error);
    expect(f.calls.filter(c => c.method === "POST" && c.route === "/sandboxes")).toHaveLength(1);
  });
  it.each([503, 504, 500, 408])("a %s on create is host-transient", async status => {
    fixture(() => response({}, status));
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(providerErrorDiagnostic(error)).toEqual({ httpStatus: status });
    expect(hostWouldRetryAcquire(error)).toBe(true);
  });
  it("(c) a 400 on create stays a refusal: status 400, non-transient, no retry loop", async () => {
    const f = fixture(() => response({ message: canary }, 400));
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(error).toMatchObject({ status: 400, httpStatus: 400, category: "http_error" });
    expect(providerErrorDiagnostic(error)).toEqual({ httpStatus: 400 });
    expect(hostWouldRetryAcquire(error)).toBe(false);
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(false);
    expect(f.calls.filter(c => c.method === "POST" && c.route === "/sandboxes")).toHaveLength(1);
    assertNoRawCause(error);
  });
  it("(d) a network error on create carries only the closed errno code ECONNRESET, never the raw cause", async () => {
    fixture(() => { throw networkFailure("ECONNRESET"); });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(error).toMatchObject({ code: "ECONNRESET", httpStatus: null, category: "network_error" });
    expect(error.status).toBeUndefined();
    expect(providerErrorDiagnostic(error)).toEqual({ errorCode: "ECONNRESET" });
    expect(hostWouldRetryAcquire(error)).toBe(true);
    assertNoRawCause(error);
  });
  it("(d) a network error on the post-failure ownership list carries its errno code", async () => {
    fixture(() => { throw networkFailure("ECONNRESET"); }, (method, route) => {
      if (method === "GET" && route === "/sandboxes") throw networkFailure("ECONNREFUSED");
      return undefined;
    });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(error).toMatchObject({ code: "ECONNREFUSED", category: "network_error" });
    expect(providerErrorDiagnostic(error)).toEqual({ errorCode: "ECONNREFUSED" });
    expect(hostWouldRetryAcquire(error)).toBe(true);
    assertNoRawCause(error);
  });
  it("(d) a network error on inspection list carries its errno code", async () => {
    fixture(() => undefined, (method, route) => {
      if (method === "GET" && route === "/sandboxes") throw networkFailure("EAI_AGAIN");
      return undefined;
    });
    const error = await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "attempt", creationOperation: { id: "attempt", runId: "run" } }).catch(e => e);
    expect(error).toMatchObject({ code: "EAI_AGAIN", category: "network_error" });
    assertNoRawCause(error);
  });
  it("copies only a closed errno: an unknown or text code is dropped", async () => {
    fixture(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error(canary), { code: canary }) }); });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(error.code).toBeUndefined();
    expect(providerErrorDiagnostic(error)).toBeNull();
    assertNoRawCause(error);
  });
  it("(e) our own call deadline maps to ETIMEDOUT", async () => {
    vi.stubGlobal("fetch", vi.fn(timeoutStub()));
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(error).toMatchObject({ code: "ETIMEDOUT", httpStatus: null, category: "network_error" });
    expect(providerErrorDiagnostic(error)).toEqual({ errorCode: "ETIMEDOUT" });
    expect(hostWouldRetryAcquire(error)).toBe(true);
    assertNoRawCause(error);
  });
  it("(3) the create cleanup wrapper keeps the create status reachable as errors[0]", async () => {
    let stops = 0;
    fixture(() => response({}, 502), (method, route) => {
      if (method === "GET" && route === "/sandboxes") return response({ sandboxes: [{ id, labels }], pageInfo: { nextCursor: null } });
      if (method === "POST" && route === `/sandboxes/${id}/stop`) { stops++; return response({}, 503); }
      return undefined;
    });
    const error = await plugin.definition.onEnvironmentAcquireLease!(params).catch(e => e);
    expect(error).toBeInstanceOf(PluginEnvironmentCreationCleanupError);
    expect(stops).toBe(3);
    expect((error as PluginEnvironmentCreationCleanupError).errors[0]).toMatchObject({ status: 502 });
    expect(environmentAcquireErrorData(error)).toMatchObject({ providerDiagnostic: { httpStatus: 502 } });
    expect(hostWouldRetryAcquire(error)).toBe(true);
  });
  it("(4) a Boat-side setup deadline carries ETIMEDOUT; setup failed stays a refusal", async () => {
    let setupStatus = "running", state = "ready";
    const extra: Route = (method, route) => {
      if (method === "GET" && route === `/sandboxes/${id}`) return response({ sandbox: { id, state, setupStatus, ...(state === "archived" ? { stop: { id: "stop", status: "completed" } } : {}) } });
      if (method === "POST" && route === `/sandboxes/${id}/stop`) { state = "archived"; return response({ operation: { id: "stop" } }); }
      return undefined;
    };
    fixture(() => undefined, extra);
    const timedOut = await plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, setupScript: "true", setupTimeoutSeconds: 1 } }).catch(e => e);
    expect(timedOut.message).toContain("setup timed out after 1 seconds");
    expect(timedOut).toMatchObject({ code: "ETIMEDOUT" });
    expect(providerErrorDiagnostic(timedOut)).toEqual({ errorCode: "ETIMEDOUT" });
    expect(hostWouldRetryAcquire(timedOut)).toBe(true);
    setupStatus = "failed"; state = "ready";
    fixture(() => undefined, extra);
    const failed = await plugin.definition.onEnvironmentAcquireLease!({ ...params, config: { ...config, setupScript: "true", setupTimeoutSeconds: 1 } }).catch(e => e);
    expect(failed.message).toContain("setup failed");
    expect(providerErrorDiagnostic(failed)).toBeNull();
    expect(hostWouldRetryAcquire(failed)).toBe(false);
  });
});

describe("frozen7 resume error carries the server's transient words", () => {
  const resume = () => plugin.definition.onEnvironmentResumeLease!({ driverKey: "boat", companyId: "c", environmentId: "e", config, providerLeaseId: id });
  it.each([
    [503, "service unavailable"], [502, "service unavailable"], [500, "service unavailable"], [504, "timeout"], [408, "timeout"],
  ])("(g) HTTP %s on resume keeps status and says '%s'", async (status, words) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ message: canary }, status)));
    const error = await resume().catch(e => e);
    expect(error).toMatchObject({ status, httpStatus: status });
    expect(error.message).toContain(words);
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(true);
    expect(environmentResumeErrorData(error)).toMatchObject({ diagnostic: { httpStatus: status } });
    assertNoRawCause(error);
  });
  it("(g) a 429 left after retries says 'rate limit'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "rate_limited" }), { status: 429, headers: { "Retry-After": "31" } })));
    const error = await resume().catch(e => e);
    expect(error).toMatchObject({ status: 429 });
    expect(error.message).toContain("rate limit");
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(true);
  });
  it("(g) a network error on resume says 'network error' and keeps the errno", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw networkFailure("ECONNRESET"); }));
    const error = await resume().catch(e => e);
    expect(error).toMatchObject({ code: "ECONNRESET" });
    expect(error.message).toContain("network error");
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(true);
    assertNoRawCause(error);
  });
  it("(g) our deadline on resume says 'timeout'", async () => {
    vi.stubGlobal("fetch", vi.fn(timeoutStub()));
    const error = await resume().catch(e => e);
    expect(error).toMatchObject({ code: "ETIMEDOUT" });
    expect(error.message).toContain("timeout");
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(true);
  });
  it.each([400, 404, 409])("(b)/(5) HTTP %s on resume stays a non-transient refusal", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ message: canary }, status)));
    const error = await resume().catch(e => e);
    expect(error).toMatchObject({ status, httpStatus: status });
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(false);
    assertNoRawCause(error);
  });
});
