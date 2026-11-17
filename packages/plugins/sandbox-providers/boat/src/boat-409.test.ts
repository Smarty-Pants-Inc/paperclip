import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentResumeErrorData } from "@paperclipai/plugin-sdk";
import plugin from "./plugin.js";

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
    if (method === "GET" && route === `/sandboxes/${id}`) return reply(ok({ sandbox: { id, state, expiresAt: "2030-01-01T00:00:00Z" } }));
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
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { id = `bx_${String(++boxes).padStart(8, "0")}`; await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

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
  it("409-A reads the fields nested under error too, and drops unknown or non-closed values", async () => {
    fakeBoat({ commands: [{ status: 409, body: { error: { code: "machine_not_running", state: "archived", retryable: false, message: canary } } }] });
    const nested = await execute().catch(e => e);
    expect(nested).toMatchObject({ status: 409, boatCode: "machine_not_running", boatState: "archived", boatRetryable: false });
    assertClosed(nested);
    fakeBoat({ commands: [{ status: 409, body: { code: `${canary}_code`, state: `${canary} state`, retryable: "yes", message: canary } }] });
    const odd = await execute().catch(e => e);
    expect(odd).toMatchObject({ status: 409, boatCode: "other" });
    expect(odd.boatState).toBeUndefined();
    expect(odd.boatRetryable).toBeUndefined();
    expect(odd.message).toBe(`Boat POST /sandboxes/${id}/commands failed (409): http_error [boat 409 code=other]`);
    assertClosed(odd);
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
  it("409-B machine_not_running with no resume of ours, or long after it, is surfaced without a resume", async () => {
    const notRunning = conflict("machine_not_running", { state: "archived", retryable: false });
    let boat = fakeBoat({ commands: [notRunning] });
    const unowned = await execute().catch(e => e);
    expect(unowned).toMatchObject({ status: 409, boatCode: "machine_not_running" });
    expect(boat.count("POST", "/resume")).toBe(0);
    expect(boat.count("POST", "/commands")).toBe(1);
    boat = fakeBoat({ commands: [notRunning] });
    const now = Date.now();
    await resume();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60_000);
    const stale = await execute().catch(e => e);
    expect(stale).toMatchObject({ status: 409, boatCode: "machine_not_running" });
    expect(boat.count("POST", "/resume")).toBe(1);
    expect(boat.count("POST", "/commands")).toBe(1);
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
  it("409-B sandbox_stopping without Retry-After, or with one past the budget, is surfaced as is", async () => {
    let boat = fakeBoat({ resume: [conflict("sandbox_stopping", { state: "archiving" })] });
    const bare = await resume().catch(e => e);
    expect(bare).toMatchObject({ status: 409, boatCode: "sandbox_stopping", boatState: "archiving" });
    expect(boat.count("POST", "/resume")).toBe(1);
    boat = fakeBoat({ resume: [conflict("sandbox_stopping", { state: "archiving" }, { "Retry-After": "31" })] });
    const long = await resume().catch(e => e);
    expect(long).toMatchObject({ status: 409, boatCode: "sandbox_stopping" });
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
