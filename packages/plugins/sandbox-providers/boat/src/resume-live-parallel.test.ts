import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

const scope = { driverKey: "boat", companyId: "parallel-company", environmentId: "parallel-environment" };
const oldDeadline = "2026-11-13T18:00:00Z";
function reply(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse(oldDeadline)); });
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Keep: live handoff latency and receipt safety. The controlled transport holds
// real hook I/O in flight; a wall-clock benchmark cannot prove this overlap.
describe("Boat GET-gated live parallel resume", () => {
  const id = "bx_23456789", cwd = "/home/user/paperclip-workspace", token = "a".repeat(64);
  const sentinel = { path: `${cwd}/.paperclip-runtime/reusable-sandbox-lease.json`, token, result: "written" };
  // Persisted shape from spare.12n1, not a lease re-created by the changed code.
  const saved = { adapterType: "paperclip_runner", sandboxId: id, remoteCwd: cwd, reuseLease: true,
    workspaceSentinel: sentinel, boatOrgId: "team_recorded", kept: "unchanged", ttlRefresh: { status: "failed" } };
  const config = { apiKey: "boat_parallel_fixture", ttlSeconds: 1800, reuseLease: true, duplexCarrier: "off" };
  const params = { ...scope, config, providerLeaseId: id, leaseMetadata: saved };
  const deadline = () => new Date(Date.now() + 1800_000).toISOString();
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  let logs: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  beforeEach(async () => {
    logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await plugin.definition.setup({ logger: logs } as any);
  });
  function transport(options: { state?: string; stop?: string; missing?: boolean; wrongId?: boolean; patch?: "fail" | "wrong-id";
    cat?: "missing" | "mismatch" | "timeout"; readGate?: ReturnType<typeof gate>; patchGate?: ReturnType<typeof gate>; catGate?: ReturnType<typeof gate> } = {}) {
    const events: string[] = [];
    let resumed = false;
    const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url).replace("https://boat.dev/api/v1", ""), method = init?.method ?? "GET";
      if (path === `/sandboxes/${id}` && method === "GET") {
        events.push("get:start"); await options.readGate?.promise; events.push("get:end");
        if (options.missing) return reply({ code: "not_found" }, 404);
        return reply({ sandbox: { id: options.wrongId ? "bx_98765432" : id, state: resumed ? "ready" : options.state ?? "running",
          archiveAfter: oldDeadline, team: { id: "team_observed" }, ...(options.stop ? { stop: { status: options.stop } } : {}) } });
      }
      if (path === `/sandboxes/${id}` && method === "PATCH") {
        events.push("patch:start"); await options.patchGate?.promise; events.push("patch:end");
        expect(new Headers(init?.headers).get("X-Boat-Org")).toBe("team_recorded");
        expect(JSON.parse(String(init?.body))).toEqual({ ttlSeconds: 1800 });
        if (options.patch === "fail") return reply({ code: "bad_request" }, 400);
        return reply({ sandbox: { id: options.patch === "wrong-id" ? "bx_98765432" : id, state: "running", archiveAfter: deadline(), team: { id: "team_refreshed" } } });
      }
      if (path.endsWith("/resume")) {
        events.push("resume"); resumed = true;
        expect(JSON.parse(String(init?.body))).toEqual({ ttlSeconds: 1800, noEnv: true });
        return reply({ sandbox: { id, state: "ready" } });
      }
      if (path.endsWith("/commands")) {
        expect(JSON.parse(String(init?.body)).command).toContain(`cat '${sentinel.path}'`);
        events.push("cat:start"); await options.catGate?.promise; events.push("cat:end");
        return reply({ exitCode: options.cat === "missing" ? 1 : 0, timedOut: options.cat === "timeout",
          stdout: JSON.stringify({ version: 1, provider: "boat", token: options.cat === "mismatch" ? "b".repeat(64) : token }), stderr: "" });
      }
      throw new Error(`Unexpected parallel fixture request ${method} ${path}`);
    });
    vi.stubGlobal("fetch", network);
    return { events, network };
  }
  function expectedLease(state: string, refresh?: Record<string, unknown>, owner = "team_refreshed") {
    const { ttlRefresh: _old, boatOrgId: _org, ...retained } = saved;
    return { providerLeaseId: id, expiresAt: refresh && refresh.status !== "failed" ? deadline() : oldDeadline,
      metadata: { ...retained, provider: "boat", resumed: true, resumedLease: true, resumedFromState: state,
        boatOrgId: owner, ...(refresh ? { ttlRefresh: refresh } : {}), workspaceSentinel: { ...sentinel, result: "matched" } } };
  }
  const okReceipt = () => ({ status: "ok", at: new Date(Date.now()).toISOString(), archiveAfter: deadline() });
  it.each(["ready", "idle", "running"])("row 1: GET gates %s; PATCH and cat are simultaneously in flight; exact lease retained", async state => {
    const readGate = gate(), patchGate = gate(), catGate = gate();
    const f = transport({ state, readGate, patchGate, catGate });
    const work = plugin.definition.onEnvironmentResumeLease!(params);
    try {
      await vi.waitFor(() => expect(f.events).toEqual(["get:start"]));
      readGate.resolve();
      await vi.waitFor(() => expect(f.events).toContain("patch:start"));
      await vi.waitFor(() => expect(f.events).toContain("cat:start"), { timeout: 150 });
      expect(f.events).not.toContain("patch:end"); expect(f.events).not.toContain("cat:end");
    } finally { readGate.resolve(); patchGate.resolve(); catGate.resolve(); await work; }
    expect(await work).toEqual(expectedLease(state, okReceipt()));
    expect(f.events.filter(e => e === "patch:start")).toHaveLength(1);
    expect(logs.info).toHaveBeenCalledWith("Boat lease resume path", { providerLeaseId: id, resumePath: "live-parallel" });
    console.info("LIVE_PARALLEL_OVERLAP", JSON.stringify({ state, events: f.events }));
  });
  it.each([
    { state: "stopped" }, { state: "archived" }, { state: "archiving" },
    { state: "running", stop: "failing" }, { state: "ready", stop: "failed" },
  ])("row 2: $state/$stop keeps exact GET-resume-waitReady-cat sequence and metadata", async options => {
    const f = transport(options);
    expect(await plugin.definition.onEnvironmentResumeLease!(params)).toEqual(expectedLease(options.state, undefined, "team_observed"));
    expect(f.events).toEqual(["get:start", "get:end", "resume", "get:start", "get:end", "cat:start", "cat:end"]);
  });
  it.each(["org", "personal"])("row 3: not-found %s keeps today's expiry/refusal semantics", async kind => {
    const f = transport({ missing: true });
    const work = plugin.definition.onEnvironmentResumeLease!({ ...params, leaseMetadata: { ...saved, ...(kind === "personal" ? { boatOwner: { kind: "personal" } } : {}) } });
    if (kind === "personal") await expect(work).rejects.toThrow("personal lease absence is not proven");
    else expect(await work).toEqual({ providerLeaseId: null, metadata: { expired: true } });
    expect(f.events).toEqual(["get:start", "get:end"]);
  });
  it("wrong GET ID never authorizes PATCH or cat", async () => {
    const f = transport({ wrongId: true });
    await expect(plugin.definition.onEnvironmentResumeLease!(params)).rejects.toThrow("different allocation");
    expect(f.events).toEqual(["get:start", "get:end"]);
  });
  it.each(["missing", "mismatch"] as const)("row 4: %s sentinel waits for PATCH and retains its receipt on expiry", async cat => {
    const patchGate = gate(), f = transport({ cat, patchGate });
    let settled = false;
    const work = plugin.definition.onEnvironmentResumeLease!(params).then(value => { settled = true; return value; });
    try {
      await vi.waitFor(() => expect(f.events).toContain("cat:end"), { timeout: 150 });
      expect(settled).toBe(false); expect(f.events).not.toContain("patch:end");
    } finally { patchGate.resolve(); await work; }
    expect(await work).toEqual({ providerLeaseId: null, metadata: { expired: true, workspaceSentinel: { ...sentinel, result: cat }, ttlRefresh: okReceipt() } });
    expect(f.events.filter(e => e === "patch:start")).toHaveLength(1);
  });
  it.each(["fail", "wrong-id"] as const)("row 5: PATCH %s keeps failed receipt, old owner/deadline, matched lease", async patch => {
    transport({ patch });
    const refresh = { status: "failed", at: new Date(Date.now()).toISOString(), category: patch === "fail" ? "http_error" : "parse_error",
      httpStatus: patch === "fail" ? 400 : 200, archiveAfter: oldDeadline };
    expect(await plugin.definition.onEnvironmentResumeLease!(params)).toEqual(expectedLease("running", refresh, "team_observed"));
  });
  it.each([undefined, "fail"] as const)("row 6: cat timeout waits for PATCH %s receipt before preserving lease; rejection handled", async patch => {
    const patchGate = gate(), f = transport({ cat: "timeout", patch, patchGate });
    let settled = false;
    const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on("unhandledRejection", onUnhandled);
    const work = plugin.definition.onEnvironmentResumeLease!(params).then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    try {
      await vi.waitFor(() => expect(f.events).toContain("cat:end"), { timeout: 150 });
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false); expect(f.events).not.toContain("patch:end");
    } finally { patchGate.resolve(); await work; process.off("unhandledRejection", onUnhandled); }
    expect((await work as { error: Error }).error.message).toBe("Boat workspace sentinel verification timed out; preserve the lease.");
    const status = patch ? "failed" : "ok", level = patch ? logs.warn : logs.info;
    expect(level).toHaveBeenCalledWith("Boat warm lease TTL refresh", { providerLeaseId: id, status, category: patch ? "http_error" : null });
    expect(unhandled).toEqual([]);
  });
  it("row 7: GET delayed beyond renew cap cannot send PATCH; failed receipt and sentinel semantics retained", async () => {
    const readGate = gate(), f = transport({ readGate });
    let now = Date.parse(oldDeadline); vi.spyOn(Date, "now").mockImplementation(() => now);
    const work = plugin.definition.onEnvironmentResumeLease!({ ...params, config: { ...config, runLeaseRenewCapSeconds: 1 }, runId: "parallel-cap" });
    await vi.waitFor(() => expect(f.events).toContain("get:start"));
    now += 1000; readGate.resolve();
    const refresh = { status: "failed", at: new Date(now).toISOString(), category: "request_error", httpStatus: null, archiveAfter: oldDeadline };
    expect(await work).toEqual(expectedLease("running", refresh, "team_observed"));
    expect(f.events).toEqual(["get:start", "get:end", "cat:start", "cat:end"]);
  });
});
