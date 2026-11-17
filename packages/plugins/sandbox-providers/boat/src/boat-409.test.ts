import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentResumeErrorData } from "@paperclipai/plugin-sdk";
import plugin, { boatResumeStateTransition, boatStartDeadlineMessage } from "./plugin.js";

// Keep: smarty-dev#20974 (gate 1 C1: files PUT then commands POST answered 409
// about 21 s after our resume of an archived box). Boat's own docs, read 11-17:
// - readiness.md:9 ready = ready/idle/running; :29 a command sent while the box
//   starts is held up to 60 s, then '409 sandbox_starting': send it again;
//   :31 a stopped or error box answers '409 sandbox_not_ready': resume first.
// - troubleshooting 'Error messages': sandbox_starting (send again),
//   sandbox_not_ready / machine_not_running (run boat resume, then retry; the body
//   carries state and retryable), sandbox_stopping (a resume answer with
//   Retry-After: wait that many seconds, then run the same resume again),
//   snapshot_data_expired (data deleted; no retry can help).
// Only Boat's closed fields code/state/retryable may reach the error object,
// never the raw body. A stateful fake Boat; synthetic keys; never live Boat.
// Each test uses its own box: "our resume" is worker state keyed by box.
let boxes = 0, id = "bx_00000000";
const canary = "synthetic-409-body-canary";
const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const scope = { driverKey: "boat", companyId: "c", environmentId: "e", config };
const SERVER_RESUME_TEXT = /\b(timeout|timed out|rate limit|temporar|network|connection reset|service unavailable)\b/;
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
const ok = (body: unknown): Reply => ({ status: 200, body });
const conflict = (code: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): Reply =>
  ({ status: 409, body: { code, message: `${canary} ${code}`, ...extra }, headers });
function fakeBoat(script: { commands?: Reply[]; files?: Reply[]; resume?: Reply[] } = {}) {
  let state = "archived";
  const calls: { method: string; route: string; at: number }[] = [];
  const queues = { commands: [...(script.commands ?? [])], files: [...(script.files ?? [])], resume: [...(script.resume ?? [])] };
  const reply = (r: Reply) => new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  const fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = new URL(String(input)), method = init.method ?? "GET";
    const route = url.pathname.replace("/api/v1", ""); calls.push({ method, route, at: Date.now() });
    if (method === "POST" && route === `/sandboxes/${id}/resume`) {
      const next = queues.resume.shift();
      if (next && next.status !== 202 && next.status !== 200) return reply(next);
      state = "ready";
      return reply({ status: 202, body: { sandbox: { id, state: "provisioned" } } });
    }
    if (method === "GET" && route === `/sandboxes/${id}`) return reply(ok({ sandbox: { id, state, expiresAt: "2030-01-01T00:00:00Z", ...(state === "archived" ? { stop: { id: "stop", status: "completed" } } : {}) } }));
    if (method === "POST" && route === `/sandboxes/${id}/stop`) { state = "archived"; return reply(ok({ operation: { id: "stop" } })); }
    if (method === "GET" && route === `/sandboxes/${id}/command-history`) return reply(ok({ commands: [] }));
    if (method === "POST" && route === `/sandboxes/${id}/commands`) return reply(queues.commands.shift() ?? ok({ exitCode: 0, stdout: "ran", stderr: "", timedOut: false }));
    if (method === "PUT" && route === `/sandboxes/${id}/files`) return reply(queues.files.shift() ?? ok({ ok: true }));
    if (method === "DELETE" && route === `/sandboxes/${id}/files`) return reply(ok({ ok: true }));
    throw new Error(`Unexpected HTTP ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  const count = (method: string, suffix: string) => calls.filter(c => c.method === method && c.route === `/sandboxes/${id}${suffix}`).length;
  return { calls, fetch, count, setState: (next: string) => { state = next; } };
}
const resume = () => plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id });
const execute = (extra: Record<string, unknown> = {}) => plugin.definition.onEnvironmentExecute!({ ...scope, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000, ...extra } as any);
function assertClosed(error: Error) {
  expect(Object.hasOwn(error, "cause")).toBe(false);
  for (const value of [String(error), error.message, error.stack, JSON.stringify(Object.getOwnPropertyDescriptors(error))]) {
    expect(value?.includes(canary)).toBe(false);
    expect(value?.includes(config.apiKey)).toBe(false);
  }
}
// Keep #20974's data-safety boundary: an arbitrary non-idempotent command
// needs documented not-run evidence or a separate GET proving refusal.
async function assertReplacementRecovery(first: Reply, stale = false, unknown = false) {
  for (const terminal of [false, true]) {
    id = `bx_${String(++boxes).padStart(8, "0")}`;
    const boat = fakeBoat({ commands: terminal ? [first, first] : [first] });
    if (stale) {
      await resume();
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    }
    boat.setState("archived");
    const before = boat.calls.length;
    try {
      const result = await execute({ command: "charge-once" }).catch(e => e);
      if (terminal) {
        expect(result).toBeInstanceOf(Error);
        expect(result).toMatchObject({ status: 409, code: "boat_sandbox_state_transition", boatCode: unknown ? "other" : "machine_not_running" });
        expect(result.boatState).toBe(unknown ? undefined : "archived");
        expect(result.boatRetryable).toBe(unknown ? undefined : false);
        assertClosed(result);
      } else {
        expect(result).toMatchObject({ exitCode: 0, stdout: "ran" });
      }
      expect(boat.count("POST", "/resume")).toBe(stale ? 2 : 1);
      expect(boat.count("POST", "/commands")).toBe(2);
      const order = boat.calls.slice(before).map(c => `${c.method} ${c.route}`);
      const recovery = order.indexOf(`POST /sandboxes/${id}/resume`);
      expect(recovery).toBeGreaterThan(0);
      // The fake only reports ready after resume; this GET must precede resend.
      expect(order.slice(recovery)).toEqual([
        `POST /sandboxes/${id}/resume`, `GET /sandboxes/${id}`, `POST /sandboxes/${id}/commands`,
      ]);
      if (unknown) expect(order.slice(0, recovery)).toEqual([
        `POST /sandboxes/${id}/commands`, `GET /sandboxes/${id}`,
      ]);
      const bodies = boat.fetch.mock.calls
        .filter(([url]) => new URL(String(url)).pathname.endsWith("/commands"))
        .map(([, init]) => JSON.parse(init.body));
      expect(bodies).toHaveLength(2);
      // Each send has its own attempt nonce; both carry the same user command.
      for (const body of bodies) expect(body.command).toContain("charge-once");
      expect(bodies[1].timeoutSeconds).toBe(bodies[0].timeoutSeconds);
    } finally { vi.restoreAllMocks(); }
  }
}
async function assertNoBlindResend(stale = false) {
  id = `bx_${String(++boxes).padStart(8, "0")}`;
  const boat = fakeBoat({ commands: [conflict("unlisted", { state: "archived", retryable: true })] });
  if (stale) {
    await resume();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
  }
  boat.setState("ready");
  const before = boat.calls.length;
  try {
    const error = await execute({ command: "charge-once" }).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ httpStatus: 409, code: "boat_command_possibly_ran", evidence: "unknown", reason: "http_409" });
    expect(boat.count("POST", "/commands")).toBe(1);
    expect(boat.count("POST", "/resume")).toBe(stale ? 1 : 0);
    expect(boat.calls.slice(before).filter(c => c.route === `/sandboxes/${id}`)
      .map(c => c.method)).toEqual(["GET"]);
    assertClosed(error);
  } finally { vi.restoreAllMocks(); }
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { id = `bx_${String(++boxes).padStart(8, "0")}`; await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Unit tests agreed in the R8(c) brief: two pure message/shape checks only;
// the proof remains cluster-lead's LIVE gate row, not this synthetic fixture.
describe("R8(c) resume transition message and shape", () => {
  it("names only a regex-safe last state at the start deadline", () => {
    for (const state of ["provisioned", "cloning", "starting", "archived", "custom_state"]) {
      const message = boatStartDeadlineMessage(id, state);
      expect(message).toBe(`Boat sandbox ${id} is still ${state} at its start deadline`);
      expect(/\bis still [a-z_]+ at its start deadline\b/i.test(message)).toBe(true);
    }
    for (const state of [undefined, null, 1, {}, "", "STARTING", "starting-now", "starting2", "starting\n", canary]) {
      expect(boatStartDeadlineMessage(id, state)).toBe(`Boat sandbox ${id} is still unknown at its start deadline`);
    }
  });
  it("marks only resuming or stopping without an in-budget numeric Retry-After as transient", () => {
    for (const retryAfter of [null, "invalid", "Wed, 17 Nov 2026 18:00:00 GMT", "-1", "Infinity", "31", "9".repeat(400)]) {
      expect(boatResumeStateTransition("sandbox_stopping", retryAfter, 30_000)).toBe(true);
      expect(boatResumeStateTransition("sandbox_resuming", retryAfter, 30_000)).toBe(true);
    }
    for (const retryAfter of ["0", " 2 ", "0.5", "30"]) {
      expect(boatResumeStateTransition("sandbox_stopping", retryAfter, 30_000)).toBe(false);
      expect(boatResumeStateTransition("sandbox_resuming", retryAfter, 30_000)).toBe(true);
    }
    expect(boatResumeStateTransition("sandbox_stopping", "0.5", 499)).toBe(true);
    for (const code of [undefined, "resume_failed", "sandbox_securing", "snapshot_data_expired", "other"]) {
      expect(boatResumeStateTransition(code, null, 30_000)).toBe(false);
    }
  });
});

describe("#20974 (a) a Boat 409 keeps only its closed code, state and retryable", () => {
  it("409-A snapshot_data_expired on resume is surfaced as is, with its closed fields and no raw body", async () => {
    const boat = fakeBoat({ resume: [conflict("snapshot_data_expired", { state: "archived", retryable: false, error: { message: canary } })] });
    const error = await resume().catch(e => e);
    expect(error).toMatchObject({ status: 409, httpStatus: 409, category: "http_error", boatCode: "snapshot_data_expired", boatState: "archived", boatRetryable: false });
    expect(error.message).toBe(`Boat POST /sandboxes/${id}/resume failed (409): http_error [boat 409 code=snapshot_data_expired state=archived retryable=false]`);
    // The host still reads only the status; the run's message names WHICH 409.
    expect(environmentResumeErrorData(error)?.diagnostic).toEqual({ httpStatus: 409 });
    expect(SERVER_RESUME_TEXT.test(error.message.toLowerCase())).toBe(false);
    expect(boat.count("POST", "/resume")).toBe(1);
    assertClosed(error);
  });
  it("(superseded by replacement: frozen8 F-04D documented not-run recovery, Boat readiness.md:31, rf2 record) 409-A nested/unknown fields recover safely once and remain closed on a second 409", async () => {
    await assertReplacementRecovery({ status: 409, body: { error: { code: "machine_not_running", state: "archived", retryable: false, message: canary } } });
    await assertReplacementRecovery({ status: 409, body: { code: `${canary}_code`, state: `${canary} state`, retryable: "yes", message: canary } }, false, true);
    await assertNoBlindResend();
  });
});

describe("#20974 (b) documented 409 handling inside the call's bounded budget", () => {
  it("409-B sandbox_starting on a command is sent again and then runs", async () => {
    const boat = fakeBoat({ commands: [conflict("sandbox_starting", { state: "provisioned", retryable: true })] });
    await expect(execute()).resolves.toMatchObject({ exitCode: 0, stdout: "ran" });
    expect(boat.count("POST", "/commands")).toBe(2);
    expect(boat.count("POST", "/resume")).toBe(0);
  });
  it("409-B sandbox_starting on a files PUT is sent again, then the command runs", async () => {
    const boat = fakeBoat({ files: [conflict("sandbox_starting", { state: "provisioned", retryable: true })] });
    await expect(execute({ stdin: "input" })).resolves.toMatchObject({ exitCode: 0 });
    expect(boat.count("PUT", "/files")).toBe(2);
    expect(boat.count("POST", "/commands")).toBe(1);
    expect(boat.count("POST", "/resume")).toBe(0);
  });
  it("409-B sandbox_starting is resent only within the bound, then surfaced with its code", async () => {
    const starting = conflict("sandbox_starting", { state: "provisioned", retryable: true });
    const boat = fakeBoat({ commands: [starting, starting, starting, starting, starting] });
    const error = await execute().catch(e => e);
    expect(error).toMatchObject({ status: 409, boatCode: "sandbox_starting", boatState: "provisioned", boatRetryable: true });
    expect(boat.count("POST", "/commands")).toBe(3);
    assertClosed(error);
  });
  it.each(["machine_not_running", "sandbox_not_ready"])("409-B %s on a command soon after OUR resume: one more resume + ready wait, then one retry", async code => {
    const boat = fakeBoat({ commands: [conflict(code, { state: "archived", retryable: false })] });
    await expect(resume()).resolves.toMatchObject({ providerLeaseId: id });
    expect(boat.count("POST", "/resume")).toBe(1);
    boat.setState("archived");
    await expect(execute()).resolves.toMatchObject({ exitCode: 0, stdout: "ran" });
    expect(boat.count("POST", "/resume")).toBe(2);
    expect(boat.count("POST", "/commands")).toBe(2);
    // The second resume comes before the retried command, and readiness is observed between them.
    const order = boat.calls.map(c => `${c.method} ${c.route}`);
    const secondResume = order.lastIndexOf(`POST /sandboxes/${id}/resume`);
    expect(order.slice(secondResume + 1)).toEqual([`GET /sandboxes/${id}`, `POST /sandboxes/${id}/commands`]);
  });
  it("409-B machine_not_running on a files PUT soon after OUR resume is recovered the same way", async () => {
    const boat = fakeBoat({ files: [conflict("machine_not_running", { state: "archived", retryable: false })] });
    await resume();
    boat.setState("archived");
    await expect(execute({ stdin: "input" })).resolves.toMatchObject({ exitCode: 0 });
    expect(boat.count("POST", "/resume")).toBe(2);
    expect(boat.count("PUT", "/files")).toBe(2);
  });
  it("409-B the recovery happens once per resume: a second not-ready is surfaced, never another resume", async () => {
    const notRunning = conflict("machine_not_running", { state: "archived", retryable: false });
    const boat = fakeBoat({ commands: [notRunning, notRunning, notRunning] });
    await resume();
    const first = await execute().catch(e => e);
    expect(first).toMatchObject({ status: 409, boatCode: "machine_not_running", boatState: "archived", boatRetryable: false });
    expect(boat.count("POST", "/resume")).toBe(2);
    expect(boat.count("POST", "/commands")).toBe(2);
    const later = await execute().catch(e => e);
    expect(later).toMatchObject({ status: 409, boatCode: "machine_not_running" });
    expect(boat.count("POST", "/resume")).toBe(2);
    expect(boat.count("POST", "/commands")).toBe(3);
    assertClosed(first);
  });
  it("(superseded by replacement: frozen8 F-04D documented not-run recovery, Boat readiness.md:31, rf2 record) 409-B no/stale OUR resume still recovers safely once, with a named error on a second 409", async () => {
    const notRunning = conflict("machine_not_running", { state: "archived", retryable: false });
    for (const stale of [false, true]) {
      await assertReplacementRecovery(notRunning, stale);
      await assertNoBlindResend(stale);
    }
  });
  it("409-B after OUR stop of the box, nothing wakes it: the call is refused before any Boat request", async () => {
    // The lease gate refuses the call; the stop also forgets our resume (defense in depth).
    const boat = fakeBoat({ commands: [conflict("machine_not_running", { state: "archived", retryable: false })] });
    await resume();
    await plugin.definition.onEnvironmentStopLease!({ ...scope, providerLeaseId: id } as any);
    expect(boat.count("POST", "/stop")).toBe(1);
    const error = await execute().catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(boat.count("POST", "/resume")).toBe(1);
    expect(boat.count("POST", "/commands")).toBe(0);
  });
  it("409-B sandbox_stopping on resume with Retry-After waits that long, then runs the same resume again", async () => {
    vi.useFakeTimers();
    const boat = fakeBoat({ resume: [conflict("sandbox_stopping", { state: "archiving" }, { "Retry-After": "2" })] });
    const pending = resume();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(boat.count("POST", "/resume")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ providerLeaseId: id });
    expect(boat.count("POST", "/resume")).toBe(2);
  });
  it("409-B sandbox_stopping without Retry-After, or with one past the budget, retains its 409 fields as a state transition", async () => {
    let boat = fakeBoat({ resume: [conflict("sandbox_stopping", { state: "archiving" })] });
    const bare = await resume().catch(e => e);
    expect(bare).toMatchObject({ status: 409, code: "boat_sandbox_state_transition", boatCode: "sandbox_stopping", boatState: "archiving" });
    expect(bare.message).toBe(`boat_sandbox_state_transition: Boat POST /sandboxes/${id}/resume failed (409): http_error [boat 409 code=sandbox_stopping state=archiving] (state change in progress)`);
    expect(boat.count("POST", "/resume")).toBe(1);
    boat = fakeBoat({ resume: [conflict("sandbox_stopping", { state: "archiving" }, { "Retry-After": "31" })] });
    const long = await resume().catch(e => e);
    expect(long).toMatchObject({ status: 409, code: "boat_sandbox_state_transition", boatCode: "sandbox_stopping" });
    expect(boat.count("POST", "/resume")).toBe(1);
    assertClosed(long);
  });
  it("409-B snapshot_data_expired on a command after our resume is surfaced, never resumed again", async () => {
    const boat = fakeBoat({ commands: [conflict("snapshot_data_expired", { state: "archived", retryable: false })] });
    await resume();
    const error = await execute().catch(e => e);
    expect(error).toMatchObject({ status: 409, boatCode: "snapshot_data_expired" });
    expect(boat.count("POST", "/resume")).toBe(1);
    expect(boat.count("POST", "/commands")).toBe(1);
  });
});
