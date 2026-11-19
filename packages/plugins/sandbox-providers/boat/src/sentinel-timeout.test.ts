import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import { writeWorkspaceSentinel } from "./runner-support.js";

// Boat 11-18/19 storage incident: Boat ANSWERS the sentinel mkdir with "timed
// out". Fix A: the error is ETIMEDOUT, the code the host reads as transient
// (server environment-provider-unavailable-error.ts:19-22), so the server
// retries on a fresh box. Strict HTTP fixtures, never live Boat.
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const p = { driverKey: "boat", companyId: "hco", environmentId: "henv", runId: "hrun", creationOperationId: "hattempt", config: cfg };
const res = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });
beforeEach(async () => {
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
});
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("A: Boat answers the sentinel mkdir 'timed out' => the thrown error carries code ETIMEDOUT", async () => {
  const io = { request: vi.fn(), run: vi.fn(async () => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" })) };
  const scoped = { ...p, agentId: "agent", executionWorkspaceId: "ews" };
  const error: any = await writeWorkspaceSentinel(scoped as any, cfg as any, "bx_hydrate01", "/home/user/paperclip-workspace", io as any).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("ETIMEDOUT");
  expect(io.request).not.toHaveBeenCalled();
});

it("A: a sentinel mkdir that answers a failing exit (not timed out) stays an untyped failure", async () => {
  const io = { request: vi.fn(), run: vi.fn(async () => ({ exitCode: 1, timedOut: false, stdout: "", stderr: "" })) };
  const scoped = { ...p, agentId: "agent", executionWorkspaceId: "ews" };
  const error: any = await writeWorkspaceSentinel(scoped as any, cfg as any, "bx_hydrate01", "/home/user/paperclip-workspace", io as any).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBeUndefined();
});

// review-fleet-4: after A's ETIMEDOUT the failed box is owned and stopped by the
// plugin's acquire cleanup (plugin.ts createOrdinaryLease catch -> cleanupAcquisition
// -> stopSandbox), so the server's retry (a new acquire, new creation attempt)
// never leaves two boxes running.
it("A + review-fleet-4: sentinel 'timed out' => ETIMEDOUT, the box is stopped by the plugin, the retry ends with ONE running box", async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-11-19T00:00:00Z"));
  const boxes = new Map<string, string>(); let made = 0;
  const stops: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const u = new URL(String(input)), path = u.pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (method === "POST" && path === "/sandboxes") {
      const id = `bx_fleet${String(++made).padStart(4, "0")}`; boxes.set(id, "ready");
      return res({ sandbox: { id, state: "ready", labels: body.labels } }, 201);
    }
    const m = /^\/sandboxes\/(bx_fleet\d{4})(\/.*)?$/.exec(path);
    if (!m || !boxes.has(m[1])) throw new Error(`Unexpected ${method} ${path}`);
    const id = m[1], sub = m[2] ?? "";
    if (method === "GET" && sub === "") return res({ sandbox: { id, state: boxes.get(id), team: { id: "team_h" } } });
    if (method === "POST" && sub === "/stop") { stops.push(id); boxes.set(id, "archived"); return res({ sandbox: { id, state: "archived" } }); }
    // Boat 11-18/19: the first box's sentinel command is answered "timed out".
    if (method === "POST" && sub === "/commands") return res(id === "bx_fleet0001"
      ? { exitCode: null, timedOut: true, stdout: "", stderr: "" } : { exitCode: 0, timedOut: false, stdout: "", stderr: "" });
    if (method === "PUT" && sub === "/files") return res({ success: true });
    throw new Error(`Unexpected ${method} ${path}`);
  }));
  const acquire = (attempt: string) => plugin.definition.onEnvironmentAcquireLease!({ ...p, creationOperationId: attempt,
    agentId: "agent", executionWorkspaceId: "ews", adapterType: "paperclip_runner" } as any);
  const first = acquire("hattempt-1").then(() => null, e => e);
  await vi.advanceTimersByTimeAsync(5_000);
  const error: any = await first;
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("ETIMEDOUT");
  expect(error.message).toMatch(/sentinel directory creation timed out/);
  expect(stops).toEqual(["bx_fleet0001"]);
  // The server's retry: a new acquire with its own creation attempt.
  const second = acquire("hattempt-2");
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await second).toMatchObject({ providerLeaseId: "bx_fleet0002" });
  expect([...boxes].filter(([, state]) => state === "ready").map(([id]) => id)).toEqual(["bx_fleet0002"]);
});
