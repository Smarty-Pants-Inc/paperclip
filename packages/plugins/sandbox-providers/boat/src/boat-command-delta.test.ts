import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import { commandPossiblyRanError, type PossiblyRanReason } from "./command-outcome.js";
import { transientSandboxResumeFailure } from "./test-fixtures/real-resume-predicate.js";

// Keep: F-04B R1-R5, real archived-resume/execute hooks with injected transport
// faults. Data-safety boundary: arbitrary commands must NEVER acquire the
// retryable shape of our explicitly repeatable sentinel/env-directory probes.
const config = { apiKey: "not-live-f04b", type: "small", ttlSeconds: 1800, reuseLease: true, labels: {} };
const scope = { driverKey: "boat", companyId: "f04b-c", environmentId: "f04b-e", config };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const reset = () => Object.assign(new TypeError("PRIVATE-TRANSPORT-TEXT"), {
  cause: Object.assign(new Error("PRIVATE-TRANSPORT-TEXT"), { code: "ECONNRESET" }),
});
let sequence = 0, id: string;
let calls: { method: string; route: string; command?: string }[];
function transport(handle: (route: string, method: string, init: any) => Response | Promise<Response> | undefined) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init: any = {}) => {
    const route = new URL(String(input)).pathname.replace("/api/v1", ""), method = init.method ?? "GET";
    calls.push({ route, method, ...(route.endsWith("/commands") ? { command: JSON.parse(init.body).command } : {}) });
    const scripted = await handle(route, method, init);
    if (scripted) return scripted;
    if (route.endsWith("/commands")) return json({ exitCode: 0, stdout: "FIRST-RUN-ANSWER", stderr: "" });
    if (route.endsWith("/command-history")) return json({ commands: [] });
    if (route.endsWith("/stop")) return json({ operation: { id: "stop", status: "completed" } });
    if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: "archived" } });
    if (route.endsWith("/files")) return json({ ok: true });
    throw new Error(`unexpected ${method} ${route}`);
  }));
}
const commands = () => calls.filter(call => call.route.endsWith("/commands"));
const histories = () => calls.filter(call => call.route.endsWith("/command-history"));
const execute = (extra: Record<string, unknown> = {}) => plugin.definition.onEnvironmentExecute!({
  ...scope, lease: { providerLeaseId: id }, command: "charge-once", args: [], timeoutMs: 1000, ...extra,
} as any);
beforeEach(async () => {
  id = `bx_delta_${++sequence}`; calls = [];
  await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any);
});
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("F-04B R1: explicit repeatable probes preserve frozen7 recovery; arbitrary commands do not", () => {
  it("R1 resume-probe: archived sentinel ECONNRESET remains transient, then the same lease answers on the next resume", async () => {
    let resuming = false, failRead = true, sentinelText = "";
    const params = { ...scope, runId: "f04b-run", creationOperationId: `create-${id}`, agentId: "f04b-a", executionWorkspaceId: "f04b-w", adapterType: "paperclip_runner" };
    transport((route, method, init) => {
      if (route === "/sandboxes" && method === "POST") return json({ sandbox: { id, state: "ready" } });
      if (route === `/sandboxes/${id}`) return json({ sandbox: { id, state: resuming ? "archived" : "ready", team: { id: "f04b-org" } } });
      if (route.endsWith("/resume")) return json({ sandbox: { id, state: "ready" } });
      if (route.endsWith("/files") && method === "PUT") { sentinelText = JSON.parse(init.body).content; return json({ ok: true }); }
      if (resuming && route.endsWith("/commands") && JSON.parse(init.body).command.includes("cat ")) {
        if (failRead) throw reset();
        return json({ exitCode: 0, stdout: sentinelText, stderr: "" });
      }
      return undefined;
    });
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params as any);
    expect(lease.metadata?.workspaceSentinel).toMatchObject({ result: "written" });
    resuming = true;
    // Readiness after POST /resume must be ready, but each new resume starts archived.
    const fetch = globalThis.fetch;
    let resumed = false;
    vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
      const route = new URL(String(input)).pathname;
      if (route.endsWith("/resume")) resumed = true;
      if (resumed && route.endsWith(`/${id}`)) return json({ sandbox: { id, state: "ready", team: { id: "f04b-org" } } });
      return fetch(input, init);
    });
    const error = await plugin.definition.onEnvironmentResumeLease!({ ...params, providerLeaseId: id, leaseMetadata: lease.metadata } as any).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ code: "ECONNRESET", category: "network_error" });
    expect(transientSandboxResumeFailure(error)).toBe(true);
    expect(transientSandboxResumeFailure(new Error(error.message))).toBe(true); // RPC-shaped text consumer
    expect(histories()).toHaveLength(0);
    expect(commands().filter(c => c.command?.includes("cat "))).toHaveLength(1);
    failRead = false; resumed = false;
    const retry = await plugin.definition.onEnvironmentResumeLease!({ ...params, providerLeaseId: id, leaseMetadata: lease.metadata } as any);
    expect(retry).toMatchObject({ providerLeaseId: id, metadata: { workspaceSentinel: { result: "matched" } } });
  });

  it("R1 env mkdir/existence checks keep the transient errno and never dispatch the user command", async () => {
    transport(route => { if (route.endsWith("/commands")) throw reset(); return undefined; });
    const error = await execute({ env: { F04B: "value" } }).catch(e => e);
    expect(commands()).toHaveLength(1);
    expect(commands()[0].command).toContain("/bin/mkdir -p -m 0700");
    expect(commands()[0].command).toContain("test ! -L");
    expect(error).toMatchObject({ code: "ECONNRESET", category: "network_error" });
    expect(transientSandboxResumeFailure(error)).toBe(true);
    expect(histories()).toHaveLength(0);
  });

  it("R1 second RED: non-idempotent environmentExecute ECONNRESET stays possibly_ran with zero resends", async () => {
    transport(route => { if (route.endsWith("/commands")) throw reset(); return undefined; });
    const error = await execute().catch(e => e);
    expect(commands()).toHaveLength(1);
    expect(commands()[0].command).toContain("exec 'charge-once'");
    expect(error).toMatchObject({ code: "boat_command_possibly_ran", evidence: "unknown" });
    expect(transientSandboxResumeFailure(error)).toBe(false);
    expect(histories()).toHaveLength(1);
    expect(String(error)).not.toContain("PRIVATE-TRANSPORT-TEXT");
  });
});

describe("F-04B R2: only the exact documented restoring message; explicit false always forbids resend", () => {
  it.each([
    { message: "previous sandbox_restoring; this command was dispatched", retryable: false },
    { message: "sandbox_restoring", retryable: false },
    { message: "previous sandbox_restoring; this command was dispatched", retryable: undefined },
    { message: " sandbox_restoring", retryable: undefined },
    { message: "sandbox_restoring\n", retryable: undefined },
  ])("R2 $message / retryable=$retryable: exactly one POST", async ({ message, retryable }) => {
    transport(route => route.endsWith("/commands") && commands().length === 1 ? json({ error: {
      code: "sandbox_direct_failed", message, details: { retryable },
    } }, 502) : undefined);
    const error = await execute({ timeoutMs: 5000 }).catch(e => e);
    expect(commands()).toHaveLength(1);
    expect(error).toMatchObject({ code: "boat_command_possibly_ran", evidence: "unknown" });
  });
});

describe("F-04B R3: possibly-ran outcomes are permanent to the REAL server resume predicate", () => {
  it.each(["network_error", "timeout", "aborted", "http_5xx", "unreadable_response"] as PossiblyRanReason[])("R3 %s is non-transient, directly and RPC-shaped", reason => {
    const error = commandPossiblyRanError(`Boat POST /sandboxes/${id}/commands`, reason === "http_5xx" ? 502 : null, "network_error", reason, "unknown");
    expect(error.code).toBe("boat_command_possibly_ran");
    expect(error.message).toMatch(/\(possibly ran\)$/);
    expect(transientSandboxResumeFailure(error)).toBe(false);
    expect(transientSandboxResumeFailure(new Error(error.message))).toBe(false);
  });
});

describe("F-04B gold R4/R5: evidence is exact and admission is fenced at dispatch", () => {
  it.each(["different suffix", "bare marker"])("R4 same nonce but %s is unknown, never ran", async kind => {
    transport(route => {
      if (route.endsWith("/commands")) throw reset();
      if (route.endsWith("/command-history")) {
        const marker = /^: paperclip-attempt=[A-Za-z0-9-]+;/.exec(commands()[0].command!)![0];
        return json({ commands: [{ command: kind === "bare marker" ? marker : `${marker} a-different-command` }] });
      }
      return undefined;
    });
    const error = await execute().catch(e => e);
    expect(error).toMatchObject({ code: "boat_command_possibly_ran", evidence: "unknown" });
    expect(commands()).toHaveLength(1);
  });

  it("R5 admission closes after the early evidence check but before history GET dispatch: zero GETs", async () => {
    const external = new AsyncResource("f04b-external-stop");
    let stopping: Promise<any> | undefined, admissionClosed = false;
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      if (ms === 5000 && !stopping) external.runInAsyncScope(() => queueMicrotask(() => {
        admissionClosed = true;
        stopping = plugin.definition.onEnvironmentStopLease!({ ...scope, providerLeaseId: id, cancelActiveWork: true } as any);
      }));
      return timeout(ms);
    });
    let readsAfterClose = 0;
    transport(route => {
      if (route.endsWith("/commands")) throw reset();
      if (route.endsWith("/command-history") && admissionClosed) readsAfterClose++;
      return undefined;
    });
    try {
      const error = await execute().catch(e => e);
      await stopping;
      expect(admissionClosed).toBe(true);
      expect(error).toMatchObject({ code: "boat_command_possibly_ran", evidence: "unknown" });
      expect(readsAfterClose).toBe(0);
      expect(histories()).toHaveLength(0);
      expect(commands()).toHaveLength(1);
    } finally { external.emitDestroy(); await stopping; }
  });
});
