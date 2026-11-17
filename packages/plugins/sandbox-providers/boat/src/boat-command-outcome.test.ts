import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// Keep: frozen8 F-04 (review-fleet-2 05:25Z, Boat owner #4605). Boat's own
// classification of a failed POST /sandboxes/{id}/commands: resend only what
// Boat says did not run; never resend what possibly ran, and read the command
// history as evidence only. Sources: boat-commands-table.md lines 12-20 and
// boat-command-history.md lines 14-18 and 37-63 (copies beside the F-04 brief).
// Synthetic keys and a fake Boat only; never live Boat.
let boxes = 0, id = "bx_f0000000";
const config = { apiKey: "synthetic-boat-key", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
const scope = { driverKey: "boat", companyId: "c", environmentId: "e", config };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Boat's 502 body (boat-commands-table.md lines 17-26). */
const direct502 = (error: { message?: string; retryable?: boolean }, status = 502) => json({
  ok: false, type: "sandbox.error", status,
  error: { code: "sandbox_direct_failed", ...(error.message !== undefined ? { message: error.message } : {}),
    ...(error.retryable !== undefined ? { details: { retryable: error.retryable } } : {}) },
}, status);
const networkFailure = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
const MARKER = /^: paperclip-attempt=([A-Za-z0-9-]+); /;
const nonceOf = (text: string) => MARKER.exec(text)?.[1];
type Call = { method: string; route: string; at: number; command?: string };
type Handler = (call: Call, n: { commands: number; history: number; files: number }, init: any) => Response | Promise<Response> | undefined;
function fakeBoat(handle: Handler = () => undefined) {
  const calls: Call[] = [];
  const n = { commands: 0, history: 0, files: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const method = init.method ?? "GET", route = new URL(String(input)).pathname.replace("/api/v1", "");
    const call: Call = { method, route, at: Date.now() };
    if (method === "POST" && route === `/sandboxes/${id}/commands`) { n.commands++; call.command = JSON.parse(String(init.body)).command; }
    if (method === "GET" && route === `/sandboxes/${id}/command-history`) n.history++;
    if (method === "PUT" && route === `/sandboxes/${id}/files`) n.files++;
    calls.push(call);
    const scripted = await handle(call, n, init);
    if (scripted) return scripted;
    if (method === "POST" && route === `/sandboxes/${id}/stop`) return json({ operation: { id: "stop", status: "completed" } });
    if (method === "GET" && route === `/sandboxes/${id}`) return json({ sandbox: { id, state: "archived", expiresAt: "2030-01-01T00:00:00Z", stop: { id: "stop", status: "completed" } } });
    if (method === "POST" && route === `/sandboxes/${id}/commands`) return json({ exitCode: 0, stdout: "COMMAND-RAN", stderr: "" });
    if (method === "GET" && route === `/sandboxes/${id}/command-history`) return json({ type: "command.list", commands: [], nextCursor: null });
    if (method === "PUT" && route === `/sandboxes/${id}/files`) return json({ ok: true });
    if (method === "DELETE" && route === `/sandboxes/${id}/files`) return json({ ok: true });
    throw new Error(`unexpected ${method} ${route}`);
  }));
  const commands = () => calls.filter(c => c.method === "POST" && c.route === `/sandboxes/${id}/commands`);
  const after = (index: number, method: string, suffix: string) =>
    calls.slice(index).filter(c => c.method === method && c.route === `/sandboxes/${id}${suffix}`).length;
  /** A history page holding the record of a command we sent (its text, lines 39-41). */
  const historyWith = (text: string | undefined) => json({ type: "command.list", nextCursor: null,
    commands: [{ commandId: "cmd_other", status: "exited", exitCode: 0, command: ": paperclip-attempt=someone-else; true" },
      ...(text ? [{ commandId: "cmd_ours", status: "running", exitCode: null, command: text }] : [])] });
  return { calls, n, commands, after, historyWith };
}
const execute = (extra: Record<string, unknown> = {}) =>
  plugin.definition.onEnvironmentExecute!({ ...scope, lease: { providerLeaseId: id }, command: "true", args: [], timeoutMs: 5000, ...extra } as any);
const stopHooks = ["onEnvironmentStopLease", "onEnvironmentReleaseLease", "onEnvironmentDestroyLease"] as const;
const stop = (hook: typeof stopHooks[number]) => (plugin.definition as any)[hook]({ ...scope, providerLeaseId: id, cancelActiveWork: true });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
beforeEach(async () => { id = `bx_f${String(++boxes).padStart(7, "0")}`; await plugin.definition.setup({ logger } as any); vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const expectPossiblyRan = (error: any, evidence: "ran" | "unknown") => {
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ code: "boat_command_possibly_ran", evidence });
  expect(error.message).toMatch(/\(possibly ran\)$/);
  // Not readable as transient by anything: no HTTP status and no transport errno.
  expect(error).not.toHaveProperty("status");
  expect(Object.hasOwn(error, "cause")).toBe(false);
};

describe("F-04 DID NOT RUN: Boat says the command did not run, so it is sent again inside the call's budget", () => {
  it("RED-1 a 502 sandbox_direct_failed with error.details.retryable true: exactly one resend, then success", async () => {
    const boat = fakeBoat((call, n) => call.route.endsWith("/commands") && n.commands === 1 ? direct502({ retryable: true, message: "direct call failed" }) : undefined);
    const result = await execute();
    expect(result).toMatchObject({ exitCode: 0, stdout: "COMMAND-RAN" });
    expect(boat.n.commands).toBe(2);
    expect(boat.n.history).toBe(0);
    // Each send names its own attempt; the command after the marker is unchanged.
    const [first, second] = boat.commands().map(c => c.command!);
    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(second)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
    expect(first.replace(MARKER, "")).toBe("exec 'true'");
    expect(second.replace(MARKER, "")).toBe("exec 'true'");
  });
  it("RED-2 a 502 sandbox_direct_failed with message sandbox_restoring: one resend after Boat's 1-3 s wait, inside the budget", async () => {
    // Real time: the plugin's wait is node:timers/promises, which fake timers do not move.
    const boat = fakeBoat((call, n) => call.route.endsWith("/commands") && n.commands === 1 ? direct502({ message: "sandbox_restoring" }) : undefined);
    const start = Date.now();
    const work = execute({ timeoutMs: 120_000 });
    await expect(work).resolves.toMatchObject({ exitCode: 0, stdout: "COMMAND-RAN" });
    const [first, second] = boat.commands();
    expect(boat.n.commands).toBe(2);
    expect(second.at - first.at).toBeGreaterThanOrEqual(1_000);
    expect(second.at - first.at).toBeLessThanOrEqual(3_000);
    expect(second.at - start).toBeLessThan(30_000);
  });
  it("RED-2b sandbox_restoring answered when the wait no longer fits the 30 s budget: no resend, surfaced as did-not-run", async () => {
    vi.useFakeTimers();
    const boat = fakeBoat(async (call, n) => {
      if (call.route.endsWith("/commands") && n.commands === 1) { await new Promise(resolve => setTimeout(resolve, 29_000)); return direct502({ message: "sandbox_restoring" }); }
      return undefined;
    });
    const start = Date.now();
    const work = execute({ timeoutMs: 120_000 }).catch(e => e);
    await vi.advanceTimersByTimeAsync(35_000);
    const outcome = await work;
    expect(boat.n.commands).toBe(1);
    expect(boat.calls.filter(c => c.at - start >= 30_000)).toEqual([]);
    expect(outcome).toMatchObject({ status: 502, boatCode: "sandbox_direct_failed", boatMessage: "sandbox_restoring" });
    expect(outcome.code).not.toBe("boat_command_possibly_ran");
  });
});

describe("F-04 POSSIBLY RAN: never sent again; the history is evidence only", () => {
  it("RED-3 a network failure on /commands: 0 resends, boat_command_possibly_ran, evidence 'unknown'", async () => {
    const boat = fakeBoat(call => { if (call.route.endsWith("/commands")) throw networkFailure(); return undefined; });
    const error = await execute().catch(e => e);
    await sleep(2_500);
    expect(boat.n.commands).toBe(1);
    expectPossiblyRan(error, "unknown");
    expect(error).toMatchObject({ reason: "network_error", httpStatus: null });
  });
  it("RED-4 DELAYED HISTORY: the record is absent at the first read and present later; still 0 resends", async () => {
    const boat = fakeBoat((call, n) => {
      if (call.route.endsWith("/commands")) throw networkFailure();
      // Boat's docs promise no time by which the record is visible: absent at the
      // first read, present at every read after it.
      if (call.route.endsWith("/command-history")) return n.history === 1 ? boat.historyWith(undefined) : boat.historyWith(boat.commands()[0].command);
      return undefined;
    });
    const error = await execute().catch(e => e);
    await sleep(2_500);
    expect(boat.n.commands).toBe(1);
    expect(boat.n.history).toBe(1);
    expectPossiblyRan(error, "unknown");
  });
  it("RED-5 the history holds this attempt's nonce at the read: 0 resends, evidence 'ran'", async () => {
    const boat = fakeBoat(call => {
      if (call.route.endsWith("/commands")) throw networkFailure();
      if (call.route.endsWith("/command-history")) return boat.historyWith(boat.commands()[0].command);
      return undefined;
    });
    const error = await execute().catch(e => e);
    await sleep(2_500);
    expect(boat.n.commands).toBe(1);
    expect(boat.n.history).toBe(1);
    expectPossiblyRan(error, "ran");
  });
  it.each([
    { name: "502 retryable false", response: () => direct502({ retryable: false, message: "timeout" }), fields: { boatCode: "sandbox_direct_failed", boatRetryable: false } },
    { name: "502 without details", response: () => direct502({ message: "machine closed" }), fields: { boatCode: "sandbox_direct_failed" } },
    { name: "502 without a body", response: () => new Response(null, { status: 502 }), fields: {} },
    { name: "500 http_500", response: () => json({ ok: false, error: { code: "http_500", message: "internal" } }, 500), fields: {} },
  ])("RED-6 $name: 0 resends, boat_command_possibly_ran", async ({ response, fields }) => {
    const boat = fakeBoat(call => call.route.endsWith("/commands") ? response() : undefined);
    const error = await execute().catch(e => e);
    await sleep(2_500);
    expect(boat.n.commands).toBe(1);
    expectPossiblyRan(error, "unknown");
    expect(error).toMatchObject({ reason: "http_5xx", ...fields });
    expect(error).not.toHaveProperty("boatMessage");
  });
  it("a timeout during the call (our AbortSignal deadline): 0 resends, possibly ran", async () => {
    const boat = fakeBoat((call, _n, init) => call.route.endsWith("/commands")
      ? new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))) : undefined);
    // timeoutMs 1000: runCommand's signal is 1 s + 5 s.
    const error = await execute({ timeoutMs: 1_000 }).catch(e => e);
    expect(boat.n.commands).toBe(1);
    expectPossiblyRan(error, "unknown");
    expect(error).toMatchObject({ reason: "timeout" });
  }, 15_000);
  it("a 2xx whose body cannot be read: the command ran, so it is possibly-ran, not resent", async () => {
    const boat = fakeBoat(call => call.route.endsWith("/commands") ? new Response("{\"exitCode\":0,", { status: 200 }) : undefined);
    const error = await execute().catch(e => e);
    expect(boat.n.commands).toBe(1);
    expectPossiblyRan(error, "unknown");
    expect(error).toMatchObject({ reason: "unreadable_response", httpStatus: 200 });
  });
  it("only closed fields are kept: no provider message, body or key in the error", async () => {
    const canary = "synthetic-provider-canary";
    fakeBoat(call => call.route.endsWith("/commands") ? direct502({ retryable: false, message: `${canary} sandbox_restoringX` }) : undefined);
    const error = await execute().catch(e => e);
    expectPossiblyRan(error, "unknown");
    for (const text of [String(error), error.stack, JSON.stringify(Object.getOwnPropertyDescriptors(error))]) {
      expect(text).not.toContain(canary);
      expect(text).not.toContain("synthetic-boat-key");
    }
    expect(error).not.toHaveProperty("boatMessage");
  });
});

describe("F-04 RED-7 a stop during any of these: 0 sends after the stop (the F-01 guard still holds)", () => {
  it.each(stopHooks)("%s during the sandbox_restoring wait: the command is not sent again", async hook => {
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    const boat = fakeBoat((call, n) => {
      if (call.route.endsWith("/commands") && n.commands === 1) { enter(); return direct502({ message: "sandbox_restoring" }); }
      // Boat answers our stop after 50 ms.
      if (call.route.endsWith("/stop")) return sleep(50).then(() => undefined);
      return undefined;
    });
    let settled = false;
    const work = execute().catch(e => e).finally(() => { settled = true; });
    await entered;
    await expect(stop(hook)).resolves.toMatchObject({ providerLeaseId: id, state: "stopped" });
    // The call was still inside Boat's restoring wait when our stop completed.
    expect(settled).toBe(false);
    const stopped = boat.calls.length;
    const outcome = await work;
    await sleep(500);
    expect(boat.after(stopped, "POST", "/commands")).toBe(0);
    expect(boat.after(stopped, "GET", "/command-history")).toBe(0);
    expect(outcome).toMatchObject({ status: 502, boatCode: "sandbox_direct_failed", boatMessage: "sandbox_restoring" });
  });
  it.each(stopHooks)("%s before Boat answers retryable 502: the command is not sent again", async hook => {
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
    const boat = fakeBoat(async (call, n) => {
      if (call.route.endsWith("/commands") && n.commands === 1) { enter(); await released; return direct502({ retryable: true }); }
      return undefined;
    });
    const work = execute().catch(e => e);
    await entered;
    await expect(stop(hook)).resolves.toMatchObject({ providerLeaseId: id, state: "stopped" });
    const stopped = boat.calls.length;
    release();
    const outcome = await work;
    await sleep(500);
    expect(boat.after(stopped, "POST", "/commands")).toBe(0);
    expect(outcome).toMatchObject({ status: 502, boatCode: "sandbox_direct_failed", boatRetryable: true });
  });
  it.each(stopHooks)("%s before the network failure surfaces: no resend and no history read after the stop", async hook => {
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
    const boat = fakeBoat(async (call, n) => {
      if (call.route.endsWith("/commands") && n.commands === 1) { enter(); await released; throw networkFailure(); }
      return undefined;
    });
    const work = execute().catch(e => e);
    await entered;
    await expect(stop(hook)).resolves.toMatchObject({ providerLeaseId: id, state: "stopped" });
    const stopped = boat.calls.length;
    release();
    const outcome = await work;
    await sleep(500);
    expect(boat.after(stopped, "POST", "/commands")).toBe(0);
    expect(boat.after(stopped, "GET", "/command-history")).toBe(0);
    expectPossiblyRan(outcome, "unknown");
  });
});

describe("F-04 files calls (boat-commands-table.md line 17: 'A file read or write gives the same result again')", () => {
  it("PUT /files answered 502 retryable true: sent again under the same rules", async () => {
    const boat = fakeBoat((call, n) => call.method === "PUT" && n.files === 1 ? direct502({ retryable: true }) : undefined);
    await expect(execute({ stdin: "input" })).resolves.toMatchObject({ exitCode: 0 });
    expect(boat.n.files).toBe(2);
    expect(boat.n.commands).toBe(1);
  });
  it("PUT /files network failure: frozen8's behaviour is kept (no resend, the transport error, no possibly-ran outcome)", async () => {
    const boat = fakeBoat(call => { if (call.method === "PUT") throw networkFailure(); return undefined; });
    const error = await execute({ stdin: "input" }).catch(e => e);
    expect(boat.n.files).toBe(1);
    expect(boat.n.commands).toBe(0);
    expect(error).toMatchObject({ httpStatus: null, category: "network_error", code: "ECONNRESET" });
  });
});

describe("F-04 the attempt marker never changes what the command does", () => {
  const commands = ["exit 3", "echo \"$?\"; false", "cd /tmp && pwd", "set -e; printf '%s\\n' a b | wc -l", "# a comment first\necho done",
    "if true; then echo yes; fi", "exec printf 'exec ok'", "printf '%s' \"$0\" | wc -c"];
  it.each(["/bin/sh", "/bin/bash"])("%s: the marked text gives the same exit code and output", async shell => {
    const boat = fakeBoat();
    for (const command of commands) {
      await plugin.definition.onEnvironmentExecute!({ ...scope, lease: { providerLeaseId: id }, command: "sh", args: ["-c", command], timeoutMs: 5000 } as any);
      const sent = boat.commands().at(-1)!.command!;
      expect(sent).toMatch(MARKER);
      const plain = spawnSync(shell, ["-c", sent.replace(MARKER, "")], { encoding: "utf8" });
      const marked = spawnSync(shell, ["-c", sent], { encoding: "utf8" });
      expect({ status: marked.status, stdout: marked.stdout, stderr: marked.stderr }).toEqual({ status: plain.status, stdout: plain.stdout, stderr: plain.stderr });
      // The same marker in front of the raw text, as any runCommand caller sends it.
      const raw = spawnSync(shell, ["-c", command], { encoding: "utf8" });
      const rawMarked = spawnSync(shell, ["-c", `${MARKER.exec(sent)![0]}${command}`], { encoding: "utf8" });
      expect({ status: rawMarked.status, stdout: rawMarked.stdout, stderr: rawMarked.stderr }).toEqual({ status: raw.status, stdout: raw.stdout, stderr: raw.stderr });
    }
  });
});
