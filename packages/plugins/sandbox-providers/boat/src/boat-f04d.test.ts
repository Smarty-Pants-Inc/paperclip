import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import { transientSandboxResumeFailure } from "./test-fixtures/real-resume-predicate.js";

// Keep: d5698c67 supervision failure, and data-safety/Stop boundaries. Transport
// fault injection through public hooks; no Boat credentials or live requests.
const config = { apiKey: "not-live-f04d", type: "small", ttlSeconds: 1800, labels: {} };
const scope = { driverKey: "boat", companyId: "f04d-c", environmentId: "f04d-e", config };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let sequence = 0, id: string, calls: { route: string; method: string }[];
function transport(handle: (route: string, method: string, init: any) => Response | Promise<Response> | undefined) {
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const route = new URL(String(input)).pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push({ route, method });
    const result = await handle(route, method, init);
    if (result) return result;
    if (route.endsWith("/command-history")) return json({ commands: [] });
    if (route.endsWith("/stop")) return json({ operation: { id: "stop", status: "completed" } });
    if (route.endsWith("/commands")) return json({ exitCode: 0, stdout: "observed", stderr: "" });
    return json({ sandbox: { id, state: "archived" } });
  });
}
const count = (suffix: string) => calls.filter(c => c.route.endsWith(suffix)).length;
const execute = () => plugin.definition.onEnvironmentExecute!({ ...scope, lease: { providerLeaseId: id }, command: "charge-once", timeoutMs: 120_000 } as any);
beforeEach(async () => {
  id = `bx_f04d_${++sequence}`; calls = []; vi.useFakeTimers();
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
});
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["running", "ready", "idle", "provisioned", "error", "stopping", "stopped", "unknown", "unreadable", "network", "wrong-id"])("unknown/unparsed 409 + GET %s stays possibly_ran, one command POST", async state => {
  transport((route) => {
    if (route.endsWith("/commands")) return new Response("not JSON", { status: 409 });
    if (route === `/sandboxes/${id}`) {
      if (state === "network") throw new TypeError("PRIVATE-NETWORK");
      if (state === "unreadable") return new Response("PRIVATE-BODY", { status: 200 });
      return json({ sandbox: { id: state === "wrong-id" ? "bx_foreign" : id, state } });
    }
    return undefined;
  });
  const error = await execute().catch(e => e);
  expect(error).toMatchObject({ code: "boat_command_possibly_ran", httpStatus: 409, evidence: "unknown", reason: "http_409" });
  expect(transientSandboxResumeFailure(error)).toBe(false);
  expect(transientSandboxResumeFailure(new Error(error.message))).toBe(false);
  expect(count("/commands")).toBe(1); expect(count("/resume")).toBe(0);
  expect(calls.filter(c => c.route === `/sandboxes/${id}` && c.method === "GET")).toHaveLength(1);
  expect(String(error)).not.toContain("PRIVATE-");
});

it.each(["sandbox_not_ready", "machine_not_running", "sandbox_starting"])("documented %s recovers a non-idempotent command without a prior resume", async code => {
  let resumed = false;
  transport(route => {
    if (route.endsWith("/commands") && count("/commands") === 1) return json({ error: { code, state: "archived" } }, 409);
    if (route.endsWith("/resume")) { resumed = true; return json({ sandbox: { id, state: "provisioned" } }); }
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: resumed ? "running" : "archived" } });
    return undefined;
  });
  const work = execute().catch(e => e); await vi.advanceTimersByTimeAsync(1500);
  expect(await work).toMatchObject({ exitCode: 0, stdout: "observed" });
  expect(count("/commands")).toBe(2); expect(count("/resume")).toBe(1);
});

it.each([{}, { code: "sandbox_not_ready" }, { code: "sandbox_starting" }, { code: "machine_not_running" }])("second 409 %j after resume is one true named transient, never a loop", async second => {
  let resumed = false;
  transport(route => {
    if (route.endsWith("/commands")) return json(count("/commands") === 1 ? {} : second, 409);
    if (route.endsWith("/resume")) { resumed = true; return json({ sandbox: { id, state: "ready" } }); }
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: resumed ? "running" : "archived" } });
    return undefined;
  });
  const work = execute().catch(e => e); await vi.advanceTimersByTimeAsync(2000);
  const error = await work;
  expect(error).toMatchObject({ code: "boat_sandbox_state_transition", status: 409 });
  expect(transientSandboxResumeFailure(error)).toBe(true);
  expect(transientSandboxResumeFailure(new Error(error.message))).toBe(true);
  expect(count("/commands")).toBe(2); expect(count("/resume")).toBe(1);
});

it("snapshot_data_expired remains permanent even on the second command response", async () => {
  let resumed = false;
  transport(route => {
    if (route.endsWith("/commands")) return json(count("/commands") === 1 ? {} : { code: "snapshot_data_expired", state: "archived" }, 409);
    if (route.endsWith("/resume")) { resumed = true; return json({ sandbox: { id, state: "ready" } }); }
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: resumed ? "running" : "archived" } });
    return undefined;
  });
  const error = await execute().catch(e => e);
  expect(error).toMatchObject({ status: 409, boatCode: "snapshot_data_expired" });
  expect(transientSandboxResumeFailure(error)).toBe(false);
  expect(transientSandboxResumeFailure(new Error(error.message))).toBe(false);
  expect(count("/commands")).toBe(2); expect(count("/resume")).toBe(1);
});

it.each(["poll", "resume"])("Stop during %s of general execute recovery: zero later sends", async phase => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  transport(async (route, method) => {
    if (route.endsWith("/commands")) return json({}, 409);
    if (route.endsWith("/stop")) { stopped = true; return undefined; }
    if (!stopped && ((phase === "poll" && method === "GET") || (phase === "resume" && route.endsWith("/resume")))) { enter(); await released; }
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: "archived" } });
    return undefined;
  });
  const work = execute().catch(e => e);
  await vi.advanceTimersByTimeAsync(0);
  expect(calls.some(c => phase === "poll" ? c.method === "GET" : c.route.endsWith("/resume"))).toBe(true);
  await entered;
  await plugin.definition.onEnvironmentStopLease!({ ...scope, providerLeaseId: id, cancelActiveWork: true } as any);
  const atStop = calls.length; release(); await vi.advanceTimersByTimeAsync(2000);
  expect(await work).toBeInstanceOf(Error); expect(calls.slice(atStop)).toEqual([]);
  expect(count("/commands")).toBe(1);
});

it("unknown 409 archive poll cannot run beyond the original request deadline", async () => {
  transport(route => route.endsWith("/commands") ? json({}, 409) : json({ sandbox: { id, state: "archiving" } }));
  const start = Date.now(), work = execute().catch(e => e);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await work).toMatchObject({ code: "boat_sandbox_state_transition", status: 409 });
  const atDeadline = calls.length; await vi.advanceTimersByTimeAsync(5000);
  expect(Date.now() - start).toBe(35_000); expect(calls.slice(atDeadline)).toEqual([]);
  expect(count("/commands")).toBe(1); expect(count("/resume")).toBe(0);
});

it("a second-send 502 sandbox_direct_failed is still possibly_ran, never a third command", async () => {
  let resumed = false;
  transport(route => {
    if (route.endsWith("/commands")) return count("/commands") === 1 ? json({}, 409) : json({ error: { code: "sandbox_direct_failed", details: { retryable: false } } }, 502);
    if (route.endsWith("/resume")) { resumed = true; return json({ sandbox: { id, state: "ready" } }); }
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: resumed ? "running" : "archived" } });
    return undefined;
  });
  const error = await execute().catch(e => e);
  expect(error).toMatchObject({ code: "boat_command_possibly_ran", httpStatus: 502 });
  expect(count("/commands")).toBe(2); expect(count("/resume")).toBe(1);
});
