import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import { environmentAcquireErrorData } from "@paperclipai/plugin-sdk";
import { readTransientEnvironmentProviderFailure } from "../../../../../server/src/services/environment-provider-unavailable-error.js";
vi.mock("node:timers/promises", () => ({ setTimeout: (ms = 0) => new Promise(r => globalThis.setTimeout(r, ms)) }));
const cfg = { hydrationWaitSeconds: 0, apiKey: "boat_edge_fixture", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const p = { driverKey: "boat", companyId: "edgeco", environmentId: "edgeenv", runId: "edgerun", creationOperationId: "edgeattempt", config: cfg };
const labels = { owner: "paperclip:edgeco", environment: "edgeenv", run: "edgerun", "paperclip-acquire": "edgeattempt" };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
beforeEach(async () => {
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
  vi.useFakeTimers(); vi.setSystemTime(0);
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const c = new AbortController(); globalThis.setTimeout(() => c.abort(new DOMException("deadline", "TimeoutError")), ms); return c.signal;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function world(o: { readyAt?: number; setupUntil?: number; commandMs?: number; slowSetupAt?: number } = {}) {
  const calls: { at: number; method: string; path: string }[] = []; let stopped = false;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push({ at: Date.now(), method, path });
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      const h = setTimeout(resolve, ms);
      init.signal?.addEventListener("abort", () => { clearTimeout(h); reject(init.signal.reason); }, { once: true });
    });
    if (method === "POST" && path === "/sandboxes") return await new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    if (method === "GET" && path === "/sandboxes") return res({ sandboxes: Date.now() >= 85_000 ? [{ id: "bx_edgecase", state: "ready", labels }] : [], pageInfo: { nextCursor: null } });
    if (method === "POST" && path.endsWith("/stop")) { stopped = true; return res({ stop: { id: "stop_edge", status: "pending" } }, 202); }
    if (method === "POST" && path.endsWith("/commands")) { await wait(o.commandMs ?? 0); return res({ exitCode: 0, stdout: "", stderr: "" }); }
    if (method === "PUT" && path.endsWith("/files")) return res({ ok: true });
    if (method === "GET" && path === "/sandboxes/bx_edgecase") {
      if (!stopped && Date.now() === o.slowSetupAt) await wait(9_000);
      return res({ sandbox: { id: "bx_edgecase", labels, state: stopped ? "archived" : Date.now() < (o.readyAt ?? 0) ? "provisioning" : "ready", setupStatus: Date.now() >= (o.setupUntil ?? 0) ? "done" : "running", ...(stopped ? { stop: { id: "stop_edge", status: "completed" } } : {}) } });
    }
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  return { calls, stopped: () => stopped };
}
const settle = (work: Promise<unknown>) => work.then(lease => ({ lease, at: Date.now() }), error => ({ error, at: Date.now() }));
it("readiness acquisition-budget exhaustion must carry ETIMEDOUT to the real host retry reader", async () => {
  const w = world({ readyAt: 190_000 });
  const work = settle(plugin.definition.onEnvironmentAcquireLease!(p));
  await vi.advanceTimersByTimeAsync(195_000); const result: any = await work;
  const data = environmentAcquireErrorData(result.error), hostEvidence = readTransientEnvironmentProviderFailure({ data });
  console.info("EDGE_EVIDENCE", JSON.stringify({ name: "readiness-typing", at: result.at, error: { name: result.error?.name, message: result.error?.message, code: result.error?.code }, data, hostEvidence, stop: w.calls.find(c => c.path.endsWith("/stop")) }));
  expect(w.stopped()).toBe(true);
  expect(hostEvidence).toEqual({ errorCode: "ETIMEDOUT" });
});
it("sentinel handoff steps must not dispatch another provider write after the acquisition deadline", async () => {
  const w = world({ setupUntil: 175_000, commandMs: 10_000 });
  const work = settle(plugin.definition.onEnvironmentAcquireLease!({ ...p, agentId: "edgeagent", issueId: "edgeissue", config: { ...cfg, setupScript: "true" } }));
  await vi.advanceTimersByTimeAsync(210_000); const result: any = await work;
  console.info("EDGE_EVIDENCE", JSON.stringify({ name: "late-sentinel", at: result.at, code: result.error?.code, phase: result.error?.phase, stopped: w.stopped(), lateCalls: w.calls.filter(c => c.at >= 175_000) }));
  expect(result).toHaveProperty("error.code", "ETIMEDOUT"); expect(w.stopped()).toBe(true);
  expect(w.calls.filter(c => c.method === "PUT" && c.at >= 180_000)).toEqual([]);
});
it("an in-flight setup GET must stop at the remaining whole-acquisition budget rather than its own 30-second timeout", async () => {
  const w = world({ setupUntil: 220_000, slowSetupAt: 179_000 });
  const work = settle(plugin.definition.onEnvironmentAcquireLease!({ ...p, config: { ...cfg, setupScript: "true", setupTimeoutSeconds: 300 } }));
  await vi.advanceTimersByTimeAsync(220_000); const result: any = await work;
  const stop = w.calls.find(c => c.path.endsWith("/stop"));
  console.info("EDGE_EVIDENCE", JSON.stringify({ name: "inflight-setup", at: result.at, code: result.error?.code, stopped: w.stopped(), stop }));
  expect(result).toHaveProperty("error.code", "ETIMEDOUT"); expect(w.stopped()).toBe(true);
  expect(stop?.at).toBeLessThanOrEqual(180_000);
});
