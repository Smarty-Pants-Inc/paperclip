import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// node:timers/promises is not moved by vi.useFakeTimers(). Put the plugin's
// bounded archive/ready waits on the SAME fake clock as renewal and Boat TTL.
vi.mock("node:timers/promises", () => ({
  setTimeout: (ms = 0, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(handle); reject(signal!.reason); };
    const handle = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(value); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  }),
}));
import plugin from "./plugin.js";

// Keep: BOAT-TTL-ARCHIVE-UNDER-RUN / RFL 2026-11-17 11:11Z. Money/data-safety
// boundary: hold one real plugin RUN lease through F-05B's cap, then drive its
// next arbitrary command through F-04D. Paid-box expiry/failure is unsafe to
// seed in daily work. Only the Boat transport and time are fake; no live Boat.
const start = Date.parse("2026-11-17T00:00:00Z");
const config = { apiKey: "fixture-cap-recovery-key", ttlSeconds: 120, runLeaseRenewCapSeconds: 300,
  reuseLease: true, runnerLifecycleMode: "per_turn" };
const scope = { driverKey: "boat", companyId: "cap-recovery-company", environmentId: "cap-recovery-env", config };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const canary = "PRIVATE-cap-recovery-provider-body";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Call = { method: string; route: string; at: number; state: string; body: Record<string, any> };
let sequence = 0, id: string;

function fakeBoat(resumeFails: boolean) {
  let state = "running", deadline = 0, effects = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined, transition: ReturnType<typeof setTimeout> | undefined;
  const calls: Call[] = [], archives: number[] = [];
  const snapshot = () => ({ id, state, archiveAfter: new Date(deadline).toISOString(), team: { id: "team_cap_recovery" } });
  // Boat PATCH sets a from-now TTL; no test manually archives the box. The last
  // granted TTL, not the renewal cap itself, drives archiving -> archived.
  const extend = (ttl: number) => {
    deadline = Date.now() + ttl * 1000;
    clearTimeout(expiry);
    expiry = setTimeout(() => {
      archives.push(Date.now()); state = "archiving";
      transition = setTimeout(() => { state = "archived"; }, 1000);
    }, ttl * 1000);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname.replace("/api/v1", ""), method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, route, at: Date.now(), state, body });
    if (route === "/sandboxes" && method === "POST") { extend(body.ttlSeconds); return json({ sandbox: snapshot() }); }
    if (route === `/sandboxes/${id}`) {
      if (method === "PATCH") {
        if (state !== "running") throw new Error("TTL renewal must not wake an expired box");
        extend(body.ttlSeconds);
      } else if (method !== "GET") throw new Error(`Unexpected method ${method}`);
      return json({ sandbox: snapshot() });
    }
    if (route === `/sandboxes/${id}/resume` && method === "POST") {
      if (state !== "archived") throw new Error("Resume must wait for confirmed archived state");
      if (resumeFails) return json({ code: "sandbox_not_ready", state, retryable: false, message: canary }, 409);
      state = "provisioned"; extend(body.ttlSeconds);
      transition = setTimeout(() => { state = "running"; }, 500);
      return json({ sandbox: snapshot() }, 202);
    }
    if (route === `/sandboxes/${id}/commands` && method === "POST") {
      // Absent-code 409 deliberately requires GET confirmation, not an inference
      // from the error body or a recent OUR-resume (there has been no resume).
      if (state === "archiving" || state === "archived") return json({ state, message: canary }, 409);
      if (state !== "running") throw new Error("Command resent before ready");
      if (body.command.includes("exec 'charge-once'")) { effects++; return json({ exitCode: 0, stdout: "charged-once", stderr: "", timedOut: false }); }
      // Acquisition's plugin-owned sentinel mkdir is the only other command.
      if (body.command.includes("mkdir -p ")) return json({ exitCode: 0, stdout: "", stderr: "" });
    }
    if (route === `/sandboxes/${id}/files` && method === "PUT") return json({ success: true });
    throw new Error(`Unexpected fake Boat request: ${method} ${route}`);
  }));
  return { calls, archives, get state() { return state; }, get deadline() { return deadline; }, get effects() { return effects; },
    cleanup() { clearTimeout(expiry); clearTimeout(transition); } };
}
let fake: ReturnType<typeof fakeBoat> | undefined;
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(start); id = `bx_cap_recovery_${++sequence}`;
  vi.clearAllMocks(); await plugin.definition.setup({ logger } as any);
});
afterEach(async () => {
  await plugin.definition.onShutdown?.(); fake?.cleanup(); fake = undefined;
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

// Both possible arrival states must be GET-confirmed. In each, the failure
// variant settles the SAME execute once, without a resend or a renewal restart.
describe.each(["archiving", "archived"] as const)("RUN cap -> next command during %s", arrival => {
  it.each([false, true])("RED cap expiry composes with F-04 recovery (resumeFails=%s)", async resumeFails => {
    const boat = fake = fakeBoat(resumeFails);
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...scope, runId: "held-run",
      agentId: "cap-recovery-agent", executionWorkspaceId: "cap-recovery-workspace", adapterType: "paperclip_runner" });
    expect(lease.providerLeaseId).toBe(id);
    const patches = () => boat.calls.filter(c => c.method === "PATCH");
    await vi.advanceTimersByTimeAsync(299_999);
    expect(patches().map(c => c.at - start)).toEqual([60_000, 120_000, 180_000, 240_000]);
    expect(patches().every(c => c.body.ttlSeconds === 120)).toBe(true);
    await vi.advanceTimersByTimeAsync(1); // cap: the t=300s PATCH is forbidden
    expect(patches()).toHaveLength(4);
    expect(boat.state).toBe("running");
    expect(boat.deadline).toBe(start + 360_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(boat.state).toBe("running");
    expect(boat.archives).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(boat.archives).toEqual([start + 360_000]);
    expect(boat.state).toBe("archiving");
    if (arrival === "archived") await vi.advanceTimersByTimeAsync(1000);
    expect(boat.state).toBe(arrival);
    expect(patches()).toHaveLength(4);

    const beforeExecute = boat.calls.length;
    let settlements = 0;
    const pending = plugin.definition.onEnvironmentExecute!({ ...scope, lease, command: "charge-once", args: [], timeoutMs: 120_000 })
      .then(value => { settlements++; return { ok: true as const, value }; }, error => { settlements++; return { ok: false as const, error }; });
    await vi.advanceTimersByTimeAsync(0);
    if (arrival === "archiving") {
      await vi.advanceTimersByTimeAsync(999);
      expect(boat.calls.slice(beforeExecute).filter(c => c.route.endsWith("/resume"))).toHaveLength(0);
      expect(settlements).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(settlements, "execute must settle within its existing budget, not silently die").toBe(1);
    const result = await pending;
    const recovery = boat.calls.slice(beforeExecute);
    const resumeIndex = recovery.findIndex(c => c.route.endsWith("/resume"));
    expect(recovery.filter(c => c.route.endsWith("/resume"))).toHaveLength(1);
    expect(recovery[0]).toMatchObject({ method: "POST", route: `/sandboxes/${id}/commands`, state: arrival });
    expect(recovery.slice(1, resumeIndex).every(c => c.method === "GET" && c.route === `/sandboxes/${id}`)).toBe(true);
    expect(recovery[1]).toMatchObject({ method: "GET", state: arrival });
    expect(recovery[resumeIndex - 1]).toMatchObject({ method: "GET", state: "archived" });
    expect(recovery[resumeIndex]).toMatchObject({ method: "POST", state: "archived" });
    const commands = recovery.filter(c => c.route.endsWith("/commands"));
    if (resumeFails) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected one named recovery failure");
      // The confirmed-not-run command refusal remains the public failure; the
      // recovery's provider body/cause is not forwarded by F-04D.
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error).toMatchObject({ code: "boat_sandbox_state_transition", status: 409,
        httpStatus: 409, category: "http_error", boatState: arrival });
      expect(result.error.message).toContain("state change in progress");
      expect(result.error).not.toHaveProperty("cause");
      expect(JSON.stringify(Object.getOwnPropertyDescriptors(result.error))).not.toContain(canary);
      expect(JSON.stringify(Object.getOwnPropertyDescriptors(result.error))).not.toContain(config.apiKey);
      expect(commands).toHaveLength(1);
      expect(recovery.slice(resumeIndex + 1)).toEqual([]);
      expect(boat.effects).toBe(0);
    } else {
      expect(result).toMatchObject({ ok: true, value: { exitCode: 0, stdout: "charged-once", timedOut: false } });
      expect(commands).toHaveLength(2); // the refused original + exactly ONE resend
      expect(boat.effects).toBe(1);
      expect(recovery.slice(resumeIndex + 1).map(c => [c.method, c.state])).toEqual([
        ["GET", "provisioned"], ["GET", "running"], ["POST", "running"],
      ]);
      const unmark = (command: string) => command.replace(/^: paperclip-attempt=[0-9a-f-]+; /, "");
      expect(unmark(commands[1].body.command)).toBe(unmark(commands[0].body.command));
      expect(unmark(commands[1].body.command)).toBe("exec 'charge-once'");
    }
    const settledCalls = boat.calls.length;
    await vi.advanceTimersByTimeAsync(10 * config.ttlSeconds * 1000);
    expect(settlements).toBe(1);
    expect(boat.calls).toHaveLength(settledCalls); // no recovery loop or idle renewal
    expect(patches().map(c => c.at - start)).toEqual([60_000, 120_000, 180_000, 240_000]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(canary);
  });
});
