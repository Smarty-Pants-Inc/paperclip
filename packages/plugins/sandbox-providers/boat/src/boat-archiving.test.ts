import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import { transientSandboxResumeFailure } from "./test-fixtures/real-resume-predicate.js";

// Keep: F-04C, run d5698c67's 409 during runnerd supervision. Transport-level
// fault injection through real plugin hooks; no live Boat. Data-safety boundary:
// only explicit F-04B repeatable probes can resume/resend, never user commands.
// The actual supervision caller is in SERVER, not this plugin (see REPORT).
const config = { apiKey: "not-live-f04c", type: "small", ttlSeconds: 1800, reuseLease: true, labels: {} };
const scope = { driverKey: "boat", companyId: "f04c-c", environmentId: "f04c-e", config };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const shapes = [
  { name: "observed absent code / archiving", body: { state: "archiving" } },
  { name: "nested absent code / archiving", body: { error: { details: { state: "archiving" } } } },
  { name: "unknown code / archiving", body: { code: "PRIVATE-UNKNOWN-CODE", state: "archiving", message: "PRIVATE-BODY" } },
  { name: "documented archived refusal", body: { code: "sandbox_not_ready", state: "archived" } },
  { name: "unreadable body", body: undefined },
];
let sequence = 0, id: string;
type Call = { method: string; route: string; at: number; command?: string };
let calls: Call[];
function boat(body: unknown, archiveAfter = 1000, handle?: (call: Call, signal: AbortSignal) => Response | Promise<Response> | undefined) {
  const start = Date.now();
  let resumed = false, stopped = false, commandCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const route = new URL(String(input)).pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    const call = { route, method, at: Date.now(), ...(route.endsWith("/commands") ? { command: JSON.parse(init.body).command } : {}) };
    calls.push(call);
    const scripted = await handle?.(call, init.signal);
    if (scripted) return scripted;
    if (route.endsWith("/commands")) {
      if (++commandCount === 1) return body === undefined ? new Response("not-json PRIVATE-BODY", { status: 409 }) : json(body, 409);
      return json({ exitCode: 0, stdout: "PROBE-OK", stderr: "" });
    }
    if (route.endsWith("/resume")) { resumed = true; return json({ sandbox: { id, state: "ready" } }); }
    if (route.endsWith("/stop")) { stopped = true; return json({ operation: { id: "stop", status: "completed" } }); }
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: stopped ? "archived" : resumed ? "ready" : Date.now() - start >= archiveAfter ? "archived" : "archiving" } });
    throw new Error(`unexpected ${method} ${route}`);
  }));
}
const count = (suffix: string, after = 0) => calls.slice(after).filter(c => c.route.endsWith(suffix));
// The existing plugin-owned workspace mkdir has explicit idempotent_probe intent.
const probe = () => plugin.definition.onEnvironmentRealizeWorkspace!({ ...scope, lease: { providerLeaseId: id }, workspace: { remotePath: "/home/user/f04c" } } as any);
const execute = () => plugin.definition.onEnvironmentExecute!({ ...scope, lease: { providerLeaseId: id }, command: "charge-once", args: [], timeoutMs: 120_000 } as any);
const stopHooks = ["onEnvironmentStopLease", "onEnvironmentReleaseLease", "onEnvironmentDestroyLease"] as const;
beforeEach(async () => {
  id = `bx_f04c_${++sequence}`; calls = []; vi.useFakeTimers();
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
});
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function transient(error: any) {
  expect(error).toMatchObject({ code: "boat_sandbox_state_transition", status: 409 });
  expect(transientSandboxResumeFailure(error)).toBe(true);
  expect(transientSandboxResumeFailure(new Error(error.message))).toBe(true); // real text-only RPC consumer
  for (const value of [String(error), error.stack, JSON.stringify(error)]) {
    expect(value).not.toContain("PRIVATE-"); expect(value).not.toContain(config.apiKey);
  }
  expect(error.cause).toBeUndefined();
}

describe("F-04C R1: an explicit repeatable probe waits for archived, resumes, then succeeds", () => {
  it.each(shapes)("R1 $name", async ({ body }) => {
    boat(body);
    const work = probe().catch(e => e);
    await vi.advanceTimersByTimeAsync(999);
    expect(count("/commands")).toHaveLength(1);
    expect(count("/resume")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await expect(work).resolves.toEqual({ cwd: "/home/user/f04c", metadata: { provider: "boat", remoteCwd: "/home/user/f04c" } });
    expect(count("/commands")).toHaveLength(2);
    expect(count("/resume")).toHaveLength(1);
    const resumeIndex = calls.findIndex(c => c.route.endsWith("/resume"));
    expect(calls[resumeIndex].at - calls[0].at).toBeGreaterThanOrEqual(1000);
    expect(calls[resumeIndex - 1]).toMatchObject({ method: "GET", route: `/sandboxes/${id}` });
    expect(calls.slice(resumeIndex).map(c => c.method)).toEqual(["POST", "GET", "POST"]);
  });
});

it("R1 real read-only sentinel cat: a box archives during resume verification, then the same lease matches", async () => {
  let state = "ready", sentinelText = "", refused = false, archivedAt = Infinity;
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const route = new URL(String(input)).pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    const command = route.endsWith("/commands") ? JSON.parse(init.body).command : undefined;
    calls.push({ route, method, at: Date.now(), ...(command ? { command } : {}) });
    if (route === "/sandboxes") return json({ sandbox: { id, state } });
    if (route.endsWith("/resume")) { state = "ready"; archivedAt = Infinity; return json({ sandbox: { id, state } }); }
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: Date.now() >= archivedAt ? "archived" : state, team: { id: "f04c-org" } } });
    if (route.endsWith("/files") && method === "PUT") { sentinelText = JSON.parse(init.body).content; return json({ ok: true }); }
    if (command) {
      if (command.includes("cat ")) {
        if (!refused) { refused = true; state = "archiving"; archivedAt = Date.now() + 1000; return json({ state: "archiving" }, 409); }
        return json({ exitCode: 0, stdout: sentinelText, stderr: "" });
      }
      return json({ exitCode: 0, stdout: "", stderr: "" });
    }
    throw new Error(`unexpected ${method} ${route}`);
  }));
  const params = { ...scope, runId: "f04c-run", creationOperationId: `create-${id}`, agentId: "f04c-a", executionWorkspaceId: "f04c-w", adapterType: "paperclip_runner" };
  const lease = await plugin.definition.onEnvironmentAcquireLease!(params as any);
  expect(lease.metadata?.workspaceSentinel).toMatchObject({ result: "written" });
  state = "archived";
  const work = plugin.definition.onEnvironmentResumeLease!({ ...params, providerLeaseId: id, leaseMetadata: lease.metadata } as any).catch(e => e);
  await vi.advanceTimersByTimeAsync(1000);
  await expect(work).resolves.toMatchObject({ providerLeaseId: id, metadata: { workspaceSentinel: { result: "matched" } } });
  expect(count("/resume")).toHaveLength(2); // explicit resume + one bounded recovery
  expect(count("/commands").filter(c => c.command?.includes("cat "))).toHaveLength(2);
});

describe("F-04C R2: non-idempotent commands never resume/resend on the same 409", () => {
  it.each(shapes)("R2 $name: one command, named transient for the real resume predicate", async ({ body }) => {
    boat(body);
    const work = execute().catch(e => e);
    await vi.advanceTimersByTimeAsync(1500);
    const error = await work;
    expect(count("/commands")).toHaveLength(1);
    transient(error);
    expect(count("/resume")).toHaveLength(0);
    expect(calls).toHaveLength(1); // no history/read side channel is needed for a definite refusal
    expect(count("/commands")[0].command).toContain("exec 'charge-once'");
  });
});

describe("F-04C R3: existing budget and stop fences cover archiving recovery", () => {
  it("R3 never-archived box spends at most the existing 30 seconds; no resume or resend", async () => {
    boat({ state: "archiving" }, Infinity);
    const start = Date.now(), work = probe().catch(e => e);
    await vi.advanceTimersByTimeAsync(30_000);
    transient(await work);
    expect(Date.now() - start).toBe(30_000);
    expect(calls.filter(c => c.at >= start + 30_000)).toEqual([]);
    expect(count("/commands")).toHaveLength(1);
    expect(count("/resume")).toHaveLength(0);
  });
  it("R3 a fetch still in flight is aborted at the original deadline, not the probe's 35 s signal", async () => {
    // Use fake-clock-backed AbortSignals, and a fetch double that honors them.
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("budget", "TimeoutError")), ms);
      return controller.signal;
    });
    boat({ state: "archiving" }, Infinity, (c, signal) => {
      if (c.method === "GET") return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    let settled = false;
    const start = Date.now(), work = probe().catch(e => e).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    transient(await work);
    expect(Date.now() - start).toBe(30_000);
    expect(count("/commands")).toHaveLength(1);
    expect(count("/resume")).toHaveLength(0);
  });
  it.each(stopHooks)("R3 %s during archive wait: 0 sends after stop", async hook => {
    boat({ state: "archiving" }, Infinity);
    const work = probe().catch(e => e);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.filter(c => c.method === "GET")).toHaveLength(1); // recovery actually entered its wait
    await (plugin.definition as any)[hook]({ ...scope, providerLeaseId: id, cancelActiveWork: true });
    const stopped = calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await work).toBeInstanceOf(Error);
    expect(calls.slice(stopped)).toEqual([]);
    expect(count("/commands")).toHaveLength(1);
    expect(count("/resume")).toHaveLength(0);
  });
  it("R3 a late archived GET cannot authorize a resume past the original deadline", async () => {
    boat({ state: "archiving" }, Infinity, async c => {
      if (c.method === "GET") { await new Promise(r => setTimeout(r, 31_000)); return json({ sandbox: { id, state: "archived" } }); }
    });
    const work = probe().catch(e => e), start = Date.now();
    await vi.advanceTimersByTimeAsync(31_000);
    transient(await work);
    expect(calls.filter(c => c.at >= start + 30_000)).toEqual([]);
    expect(count("/resume")).toHaveLength(0);
  });
});

it.each(["unreadable", "wrong-id", "unknown-state"])("unknown 409 with %s GET never authorizes a resume", async kind => {
  boat(undefined, Infinity, c => {
    if (c.method !== "GET") return undefined;
    if (kind === "unreadable") return new Response("PRIVATE-BODY", { status: 200 });
    return json({ sandbox: { id: kind === "wrong-id" ? "bx_foreign" : id, state: kind === "unknown-state" ? "PRIVATE-STATE" : "archived" } });
  });
  transient(await probe().catch(e => e));
  expect(count("/commands")).toHaveLength(1);
  expect(count("/resume")).toHaveLength(0);
  expect(calls).toHaveLength(2);
});

it("snapshot_data_expired stays permanent, even with archived state", async () => {
  boat({ code: "snapshot_data_expired", state: "archived" });
  const error = await probe().catch(e => e);
  expect(error).toMatchObject({ status: 409, boatCode: "snapshot_data_expired" });
  expect(transientSandboxResumeFailure(error)).toBe(false);
  expect(calls).toHaveLength(1);
});
it("a 409 in a known ready state is not made resendable", async () => {
  boat({ state: "ready", code: "PRIVATE-UNKNOWN-CODE" });
  const error = await probe().catch(e => e);
  expect(error).toMatchObject({ status: 409, boatCode: "other" });
  expect(transientSandboxResumeFailure(error)).toBe(false);
  expect(calls).toHaveLength(1);
});
