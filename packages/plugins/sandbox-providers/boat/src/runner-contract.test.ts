import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";
import { PluginEnvironmentRunnerIngressError } from "@paperclipai/plugin-sdk";

// Keep: provider/core trust boundary, retained workspace data safety, and
// failures (foreign allocation, lost reply, secret-bearing errors) unsafe to seed live.
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: true };
const scope = { driverKey: "boat", companyId: "company", environmentId: "environment", config: cfg, leaseMetadata: { boatOrgId: "team_lease" } };
const acquire = { ...scope, runId: "run-1", agentId: "agent", executionWorkspaceId: "workspace", adapterType: "paperclip_runner" };
const path = "/api/runner/v1/connect/run-1";
const inspectId = "bx_22222222";
// Measured Boat sandbox-not-found envelope; route 404s instead name details.path.
const sandboxNotFound = {
  ok: false, type: "sandbox.error", status: 404, code: "not_found", message: "not_found",
  error: { code: "not_found", message: "not_found", status: 404, details: { error: "not_found" } },
  requestId: "inspect-not-found",
};
function reply(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function fixture() {
  let state = "ready", revision = "2026-11-12T00:00:00Z", token = "private-token", sentinel: any;
  const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith("/sandboxes") && init?.method === "POST") return reply({ sandbox: { id: "bx_runner", state: "ready", updatedAt: revision } }, 202);
    if (u.endsWith("/sandboxes/bx_runner")) return reply({ sandbox: { id: "bx_runner", state, updatedAt: revision, archiveAfter: "2030-01-01T00:00:00Z" } });
    if (u.endsWith("/host")) return reply({ port: 43127, url: `https://swift-otter-9021-43127.on.boat.dev?_token=${token}`, isProtected: true, access: "private" });
    if (u.endsWith("/resume")) { state = "ready"; revision = "2026-11-12T00:01:00Z"; return reply({ sandbox: { id: "bx_runner", state, updatedAt: revision } }, 202); }
    if (u.endsWith("/files") && init?.method === "PUT") { sentinel = JSON.parse(body.content); return reply({ success: true }); }
    if (u.includes("/files?")) return reply({ content: JSON.stringify(sentinel), encoding: "utf8" });
    if (u.endsWith("/commands")) return reply({ exitCode: 0, timedOut: false, stdout: body.command?.includes("cat ") ? JSON.stringify(sentinel) : "", stderr: "" });
    if (u.endsWith("/stop")) { state = "archived"; return reply({ operation: { id: "stop_1" } }, 202); }
    if (u.endsWith("/stops/stop_1")) return reply({ stop: { status: "completed" } });
    throw new Error(`Unexpected fixture request ${init?.method ?? "GET"} ${u}`);
  });
  vi.stubGlobal("fetch", network);
  return { network, setState: (value: string) => { state = value; }, setRevision: (value: string) => { revision = value; }, setToken: (value: string) => { token = value; }, getSentinel: () => sentinel, corruptSentinel: () => { sentinel.token = "foreign"; } };
}
async function ingress(lease = { providerLeaseId: "bx_runner" } as any) {
  if (!plugin.definition.onEnvironmentRunnerIngressEndpoint) throw new Error("Runner ingress hook missing");
  return plugin.definition.onEnvironmentRunnerIngressEndpoint({ ...scope, lease, port: 43127, path });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Boat Runner contract", () => {
  it("declares only implemented Runner transport and host-owned lifecycle controls", () => {
    const driver = manifest.environmentDrivers![0];
    expect(driver.sandboxCapabilities).toMatchObject({ reusableLeases: true, runnerWebSocketIngress: true });
    // The existing host has no per-environment config narrowing hook. Do not
    // advertise capability just because SSH methods have been implemented.
    expect(driver.sandboxCapabilities?.duplexCommandStream).toBe(true);
    expect(driver.configSchema?.properties?.duplexCarrier).toMatchObject({ default: "off" });
    expect(driver.configSchema?.properties?.runnerLifecycleMode).toMatchObject({ enum: ["inherit", "per_turn", "warm"], default: "inherit" });
    expect(driver.configSchema?.properties?.runnerIdleTimeoutMs).toMatchObject({ minimum: 1000, maximum: 86400000, default: 300000 });
    expect(driver.defaultAcquireTimeoutMs).toBeGreaterThanOrEqual(120000);
  });
  it("acquires a private fixed-port WSS route with Cookie secret, never a token in its URL", async () => {
    const f = fixture(); const endpoint = await ingress();
    expect(endpoint).toMatchObject({ kind: "authenticated_websocket", websocketUrl: `wss://swift-otter-9021-43127.on.boat.dev${path}`, secretHeaders: [{ name: "Cookie", value: "_port_auth=private-token" }] });
    const call = f.network.mock.calls.find(([url]) => String(url).endsWith("/host"))!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ port: 43127, public: false, localhost: false });
    expect(endpoint.generation).toMatch(/^[a-f0-9]{64}$/);
  });
  it("keeps generation stable across credential rotation and changes it after lifecycle revision", async () => {
    const f = fixture(); const a = await ingress(); f.setToken("rotated-token"); const b = await ingress();
    expect(a.generation).toBe(b.generation); expect(b.secretHeaders[0].value).toBe("_port_auth=rotated-token");
    f.setRevision("2026-11-12T01:00:00Z"); expect((await ingress()).generation).not.toBe(a.generation);
  });
  it.each([{ port: 80, path }, { port: 43127, path: "/wrong" }, { port: 43127, path: `${path}?token=oops` }, { port: 43127, path: "/api/runner/v1/connect/../escape" }])("rejects invalid ingress before provider calls: %j", async input => {
    const f = fixture(); await expect(plugin.definition.onEnvironmentRunnerIngressEndpoint?.({ ...scope, lease: { providerLeaseId: "bx_runner" }, ...input })).rejects.toThrow(); expect(f.network).not.toHaveBeenCalled();
  });
  it.each(["http://swift-otter-9021-43127.on.boat.dev?_token=secret", "https://attacker.test?_token=secret", "https://swift-otter-9021-43127.on.boat.dev?_token=x%3Badmin%3Dtrue", "https://swift-otter-9021-43127.on.boat.dev?_token=x&other=y", "https://swift-otter-9021-43127.on.boat.dev"])("rejects invalid/ungated preview without reflecting credentials: %s", async url => {
    fixture(); vi.stubGlobal("fetch", vi.fn(async (target: string) => target.endsWith("/host") ? reply({ url, isProtected: true, access: "private", port: 43127 }) : reply({ sandbox: { id: "bx_runner", state: "ready" } })));
    await expect(ingress()).rejects.toThrow(/invalid|incomplete/i);
  });
  it.each([401, 403, 404, 429, 503])("serializes safe SDK ingress failure for HTTP %i", async status => {
    fixture(); vi.stubGlobal("fetch", vi.fn(async () => reply({ message: "do not leak private-token" }, status)));
    const error = await ingress().catch(e => e);
    expect(error).toBeInstanceOf(PluginEnvironmentRunnerIngressError);
    expect(error.failure).toEqual({ phase: "sandbox_lookup", httpStatus: status });
    expect(error.message).not.toContain("private-token");
  });
  it("does not send API credentials to a redirected provider endpoint", async () => {
    const f = fixture(); await ingress();
    for (const [, init] of f.network.mock.calls) expect(init?.redirect).toBe("error");
  });
  it("writes a scoped reusable sentinel and records exact allocation file digest", async () => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire);
    expect(lease.metadata).toMatchObject({ adapterType: "paperclip_runner", reuseLease: true, workspaceSentinel: { result: "written", path: "/home/user/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json", token: expect.stringMatching(/^[a-f0-9]{64}$/) }, workspaceAllocationFiles: { providerLeaseId: "bx_runner", remoteCwd: "/home/user/paperclip-workspace", files: [{ relativePath: ".paperclip-runtime/reusable-sandbox-lease.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }] } });
    expect(f.getSentinel()).toMatchObject({ version: 1, provider: "boat", companyId: "company", environmentId: "environment", agentId: "agent", executionWorkspaceId: "workspace" });
  });
  it("fingerprints allocation shape but not the new run ID for a reusable workspace", async () => {
    fixture(); const a = await plugin.definition.onEnvironmentAcquireLease!(acquire);
    const b = await plugin.definition.onEnvironmentAcquireLease!({ ...acquire, runId: "run-2" });
    const c = await plugin.definition.onEnvironmentAcquireLease!({ ...acquire, config: { ...cfg, type: "large" } });
    expect((a.metadata!.workspaceSentinel as any).token).toBe((b.metadata!.workspaceSentinel as any).token);
    expect((a.metadata!.workspaceSentinel as any).token).not.toBe((c.metadata!.workspaceSentinel as any).token);
  });
  it("resumes the same stopped allocation, verifies the sentinel, and preserves allocation ownership", async () => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire); f.setState("archived");
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed).toMatchObject({ providerLeaseId: "bx_runner", metadata: { resumedLease: true, workspaceSentinel: { result: "matched" } }, expiresAt: "2030-01-01T00:00:00Z" });
    expect(resumed.metadata!.workspaceAllocationFiles).toEqual(lease.metadata!.workspaceAllocationFiles);
  });
  it("resumes at the recorded sentinel after Core rewrites remoteCwd to a shared workspace", async () => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire);
    const original = lease.metadata!.remoteCwd as string;
    const remoteCwd = `${original}/.paperclip-workspaces/project/shared`;
    const metadata = { ...lease.metadata, remoteCwd };
    f.setState("archived"); f.network.mockClear();
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: "bx_runner", requestedCwd: remoteCwd, leaseMetadata: metadata });
    expect(resumed).toMatchObject({ providerLeaseId: "bx_runner", metadata: { remoteCwd, workspaceSentinel: { path: `${original}/.paperclip-runtime/reusable-sandbox-lease.json`, result: "matched", token: (lease.metadata!.workspaceSentinel as any).token } } });
    expect(resumed.metadata!.workspaceAllocationFiles).toEqual(lease.metadata!.workspaceAllocationFiles);
    const commands = f.network.mock.calls.filter(([url]) => String(url).endsWith("/commands")).map(([, init]) => JSON.parse(String(init?.body)).command);
    expect(commands).toContain(`cat '${original}/.paperclip-runtime/reusable-sandbox-lease.json'`);
    expect(commands.some(command => command.includes(`${remoteCwd}/.paperclip-runtime`))).toBe(false);
  });
  it.each(["/foreign/.paperclip-runtime/reusable-sandbox-lease.json", "/home/user/paperclip-workspace-other/.paperclip-runtime/reusable-sandbox-lease.json", "/home/user/paperclip-workspace/../foreign/.paperclip-runtime/reusable-sandbox-lease.json"])("refuses a recorded sentinel outside the original allocation cwd: %s", async sentinelPath => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire);
    const metadata = { ...lease.metadata, remoteCwd: "/home/user/paperclip-workspace/.paperclip-workspaces/project/shared", workspaceSentinel: { ...(lease.metadata!.workspaceSentinel as any), path: sentinelPath } };
    f.network.mockClear();
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: "bx_runner", leaseMetadata: metadata })).toMatchObject({ providerLeaseId: null });
    expect(f.network).not.toHaveBeenCalled();
  });
  it("refuses an allocation receipt for a different sandbox after a remoteCwd rewrite", async () => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire);
    const metadata = { ...lease.metadata, remoteCwd: "/home/user/paperclip-workspace/.paperclip-workspaces/project/shared", workspaceAllocationFiles: { ...(lease.metadata!.workspaceAllocationFiles as any), providerLeaseId: "bx_foreign" } };
    f.network.mockClear();
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: "bx_runner", leaseMetadata: metadata })).toMatchObject({ providerLeaseId: null });
    expect(f.network).not.toHaveBeenCalled();
  });
  it("never restarts an already warm sandbox during resume or ingress", async () => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire); f.network.mockClear();
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: "bx_runner", leaseMetadata: lease.metadata }); await ingress(lease);
    expect(f.network.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
  });
  it("expires a mismatched sentinel without destroying or recreating the allocation", async () => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire); f.corruptSentinel(); f.network.mockClear();
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: "bx_runner", leaseMetadata: lease.metadata })).toMatchObject({ providerLeaseId: null, metadata: { expired: true, workspaceSentinel: { result: "mismatch" } } });
    expect(f.network.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
  });
  it("never accepts a pre-Runner lease with no sentinel on the Runner path", async () => {
    const f = fixture(); const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: "bx_runner", leaseMetadata: { adapterType: "paperclip_runner", remoteCwd: "/home/user/paperclip-workspace" } });
    expect(result.providerLeaseId).toBeNull(); expect(f.network).not.toHaveBeenCalled();
  });
  it("refuses changed workspace before resuming", async () => {
    const f = fixture(); const lease = await plugin.definition.onEnvironmentAcquireLease!(acquire); f.network.mockClear();
    await expect(plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: "bx_runner", leaseMetadata: lease.metadata, requestedCwd: "/foreign" })).rejects.toThrow(/directory|workspace/i); expect(f.network).not.toHaveBeenCalled();
  });
  it("does not erase the configured Boat environment on resume", async () => {
    const f = fixture(); const config = { ...cfg, boatEnvironment: "runner" }; const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...acquire, config }); f.setState("archived");
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: "bx_runner", leaseMetadata: lease.metadata });
    const call = f.network.mock.calls.find(([url]) => String(url).endsWith("/resume"))!;
    expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty("noEnv");
  });
  it("refuses a hard caller deadline before allocating because Boat auto-stop can extend", async () => {
    const f = fixture();
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...acquire, requestedExpiresAt: new Date(Date.now() + 120000).toISOString() })).rejects.toThrow(/hard requestedExpiresAt/);
    expect(f.network).not.toHaveBeenCalled();
  });
  it("raises provider TTL above host warm idle and reconnect windows", async () => {
    const f = fixture(); const config = { ...cfg, ttlSeconds: 60, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 600000, runnerReconnectGraceMs: 1200000 };
    await plugin.definition.onEnvironmentAcquireLease!({ ...acquire, config });
    const body = JSON.parse(String(f.network.mock.calls[0][1]?.body)); expect(body.ttlSeconds).toBe(1500);
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config })).toMatchObject({ ok: true, normalizedConfig: { runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 600000 } });
  });
  it.each([{ runnerLifecycleMode: "unknown" }, { runnerIdleTimeoutMs: 999 }, { runnerIdleTimeoutMs: 86400001 }, { runnerIdleTimeoutMs: 1.5 }, { reuseLease: "yes" }])("rejects invalid lifecycle settings %j", async invalid => {
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...cfg, ...invalid } })).toMatchObject({ ok: false });
  });
  it("fails workspace realization loudly rather than reporting a nonexistent cwd", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ exitCode: 1, timedOut: false, stdout: "", stderr: "permission denied" })));
    await expect(plugin.definition.onEnvironmentRealizeWorkspace!({ ...scope, lease: { providerLeaseId: "bx_runner" }, workspace: { remotePath: "/workspace" } })).rejects.toThrow(/workspace/i);
  });
  it("renews an already-running warm lease on handoff without resuming its machine", async () => {
    const f = fixture(); const config = { ...cfg, ttlSeconds: 60, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 600000 };
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...acquire, config }); f.network.mockClear();
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: "bx_runner", leaseMetadata: lease.metadata });
    expect(f.network.mock.calls.some(([, init]) => init?.method === "PATCH" && JSON.parse(String(init.body)).ttlSeconds === 900)).toBe(true);
    expect(f.network.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
  });
  it("fences ingress and commands after confirmed stop, then admits only verified resume", async () => {
    const f = fixture(); const owned = { ...acquire, companyId: "fence-company" }; const lease = await plugin.definition.onEnvironmentAcquireLease!(owned);
    await plugin.definition.onEnvironmentStopLease!({ ...owned, providerLeaseId: "bx_runner" }); f.network.mockClear();
    await expect(plugin.definition.onEnvironmentRunnerIngressEndpoint!({ ...owned, lease, port: 43127, path })).rejects.toThrow(/no longer active/);
    await expect(plugin.definition.onEnvironmentExecute!({ ...owned, lease, command: "true" })).rejects.toThrow(/no longer active/);
    expect(f.network).not.toHaveBeenCalled();
    const resumed = await plugin.definition.onEnvironmentResumeLease!({ ...owned, providerLeaseId: "bx_runner", leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe("bx_runner");
    expect(await plugin.definition.onEnvironmentExecute!({ ...owned, lease: resumed, command: "true" })).toMatchObject({ exitCode: 0 });
  });
  it("a command whose stdin was in flight cannot launch after operator stop", async () => {
    const f = fixture(); const owned = { ...acquire, companyId: "cancel-company" }; const lease = await plugin.definition.onEnvironmentAcquireLease!(owned);
    const delegate = globalThis.fetch;
    let entered!: () => void, finish!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    vi.stubGlobal("fetch", async (url: any, init?: RequestInit) => {
      if (String(url).endsWith("/files") && init?.method === "PUT") { entered(); await blocked; return reply({ success: true }); }
      return delegate(url, init);
    });
    const executing = plugin.definition.onEnvironmentExecute!({ ...owned, lease, command: "dangerous-command", stdin: "input" }).catch(error => error);
    await enteredPromise;
    await plugin.definition.onEnvironmentStopLease!({ ...owned, providerLeaseId: "bx_runner" });
    const refused = await plugin.definition.onEnvironmentResumeLease!({ ...owned, providerLeaseId: "bx_runner", leaseMetadata: lease.metadata }).catch(error => error);
    finish(); const execution = await executing;
    expect(refused).toBeInstanceOf(Error); expect(refused.message).toMatch(/settling/);
    expect(execution).toMatchObject({ category: "request_error", httpStatus: null });
    expect(f.network.mock.calls.some(([, init]) => String(init?.body).includes("dangerous-command"))).toBe(false);
  });
  it.each([
    { state: "cancelled", expected: "destroyed" },
    { state: "archived", stoppedAt: "2026-11-13T12:00:00+00:00", expected: "stopped" },
    { state: "archived", stoppedAt: null, expected: "unknown" },
    { state: "archived", expected: "unknown" },
    { state: "ready", expected: "active" },
    { state: "idle", expected: "active" },
    { state: "running", expected: "active" },
    { state: "archiving", expected: "unknown" },
    { state: "error", expected: "unknown" },
    { state: "provisioning", expected: "unknown" },
    { state: "provisioned", expected: "unknown" },
    { state: "cloning", expected: "unknown" },
    { state: "init", expected: "unknown" },
    { state: "future-state", expected: "unknown" },
  ])("inspects $state with stoppedAt=$stoppedAt as $expected", async ({ state, stoppedAt, expected }) => {
    const sandbox = { id: inspectId, state, ...(stoppedAt === undefined ? {} : { stoppedAt }) };
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox })));
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: sandbox.id })).toEqual({
      providerLeaseId: sandbox.id, state: expected, stoppedAt: stoppedAt ?? null, lastRebootAt: null, observedAt: null,
    });
  });
  it.each([true, false])("preserves liveness timestamps verbatim with response envelope=%s", async wrapped => {
    const sandbox = { id: inspectId, state: "running", stoppedAt: "2026-11-13T11:30:00+00:00", lastReboot: { at: "2026-11-13T11:31:00.123Z", reason: "crash" } };
    vi.stubGlobal("fetch", vi.fn(async () => reply(wrapped ? { sandbox } : sandbox)));
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: sandbox.id })).toEqual({
      providerLeaseId: sandbox.id, state: "active", stoppedAt: sandbox.stoppedAt, lastRebootAt: sandbox.lastReboot.at, observedAt: null,
    });
  });
  it.each([null, {}])("reports a null reboot timestamp for lastReboot=%j", async lastReboot => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id: inspectId, state: "ready", lastReboot } })));
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).toMatchObject({ lastRebootAt: null });
  });
  it.each([
    { date: "Fri, 13 Nov 2026 12:00:00 GMT", expected: "2026-11-13T12:00:00.000Z" },
    { date: "not-a-date", expected: null },
    { date: undefined, expected: null },
  ])("uses only the HTTP Date header for observedAt: $date", async ({ date, expected }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ sandbox: { id: inspectId, state: "ready", observedAt: "1999-01-01T00:00:00Z", updatedAt: "1999-01-01T00:00:00Z" } }), { headers: date === undefined ? {} : { Date: date } })));
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).toMatchObject({ state: "active", observedAt: expected });
  });
  it("reports destroyed only after a real not-found and preserves that response's Date", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    const network = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(sandboxNotFound), { status: 404, headers: { Date: "Fri, 13 Nov 2026 12:00:00 GMT" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, orgs: [{ id: "team_lease", active: true }] }), { headers: { Date: "Fri, 13 Nov 2026 12:01:00 GMT" } }));
    vi.stubGlobal("fetch", network);
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).toEqual({ providerLeaseId: inspectId, state: "destroyed", stoppedAt: null, lastRebootAt: null, observedAt: "2026-11-13T12:00:00.000Z" });
    expect(network.mock.calls).toEqual([
      [`https://boat.dev/api/v1/sandboxes/${inspectId}`, expect.objectContaining({ method: "GET", cache: "no-store", headers: expect.any(Headers), redirect: "error", signal: expect.any(AbortSignal) })],
      ["https://boat.dev/api/v1/orgs", expect.objectContaining({ method: "GET", cache: "no-store", headers: expect.any(Headers), redirect: "error", signal: expect.any(AbortSignal) })],
    ]);
    for (const [, init] of network.mock.calls) expect(init.headers.get("Authorization")).toBe("Bearer boat_test");
  });
  it("performs a fresh uncached GET for each inspection", async () => {
    const network = vi.fn().mockResolvedValueOnce(reply({ sandbox: { id: inspectId, state: "ready" } })).mockResolvedValueOnce(reply({ sandbox: { id: inspectId, state: "cancelled" } }));
    vi.stubGlobal("fetch", network);
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).toMatchObject({ state: "active" });
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).toMatchObject({ state: "destroyed" });
    expect(network).toHaveBeenCalledTimes(2);
    for (const [url, init] of network.mock.calls) {
      expect(url).toBe(`https://boat.dev/api/v1/sandboxes/${inspectId}`);
      expect(init).toMatchObject({ method: "GET", cache: "no-store" });
    }
  });
  it("throws when the inspection's 10-second deadline expires", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => realTimeout(ms === 10_000 ? 10 : ms));
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toMatchObject({ category: "network_error", httpStatus: null });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
  it("throws if the inspection deadline expires while reading the response body", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => realTimeout(ms === 10_000 ? 10 : ms));
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        const signal = init!.signal!;
        if (signal.aborted) controller.error(signal.reason);
        else signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }))));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toMatchObject({ category: "parse_error", httpStatus: 200 });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
  it.each(["{", "null", "", "false", "0", '""'])("never mistakes an invalid success body for a missing sandbox: %j", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toThrow();
  });
  it("throws on an empty 204 inspection response rather than reporting destroyed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toThrow();
  });
  it.each([401, 403, 429, 500, 503])("keeps HTTP %i inspection failures retryable", async status => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ message: "provider unavailable" }, status)));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toMatchObject({ httpStatus: status });
  });
  it("throws on inspection transport failure rather than returning unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network unavailable"); }));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toThrow("network_error");
  });
  it("still rejects a foreign inspection allocation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id: "bx_33333333", state: "running" } })));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toThrow("different allocation");
  });
  it("does not report a deleted lease as active or erase a transient inspection failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(sandboxNotFound, 404)).mockResolvedValueOnce(reply({ ok: true, orgs: [{ id: "team_lease", active: true }] })));
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).toEqual({ providerLeaseId: inspectId, state: "destroyed", stoppedAt: null, lastRebootAt: null, observedAt: null });
    vi.stubGlobal("fetch", vi.fn(async () => reply({}, 503)));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toThrow();
  });
  it("rejects a route-style not-found even if the sandbox list would succeed", async () => {
    const network = vi.fn().mockResolvedValueOnce(reply({
      ...sandboxNotFound, message: "Not Found",
      error: { code: "not_found", message: "Not Found", status: 404, details: { path: `/api/v1/sandboxez/${inspectId}` } },
    }, 404)).mockResolvedValueOnce(reply({ ok: true, sandboxes: [] }));
    vi.stubGlobal("fetch", network);
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toMatchObject({ category: "ambiguous_404", httpStatus: 404 });
    expect(network).toHaveBeenCalledTimes(1);
  });
  it.each([null, "<html>Not Found</html>", "{"])("rejects a 404 without JSON: %j", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 404 })));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toMatchObject({ category: "ambiguous_404", httpStatus: 404 });
  });
  it.each([{}, { code: "unauthorized" }, null])("rejects an unrecognized JSON 404 envelope: %j", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(body, 404)));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toThrow("ambiguous_404");
  });
  it.each([401, 500])("throws if the confirming org lookup returns HTTP %i", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(sandboxNotFound, 404)).mockResolvedValueOnce(reply({ ok: false, code: "unavailable" }, status)));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toMatchObject({ httpStatus: status });
  });
  it.each([{ ok: false, orgs: [] }, { orgs: [] }, { ok: true }, { ok: true, orgs: null }, { ok: true, orgs: {} }])("rejects a malformed or unsuccessful confirming org lookup: %j", async listed => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply(sandboxNotFound, 404)).mockResolvedValueOnce(reply(listed)));
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: inspectId })).rejects.toThrow("could not confirm the lease organization");
  });
  it.each(["bx_inspect", "bx_runner", "bx_2222222", "bx_222222222", "bx_00000000", "bx_iiiiiiii", "bx_oooooooo", "bx_llllllll", "BX_22222222"])("refuses destroyed for an invalid sandbox id: %s", async providerLeaseId => {
    const network = vi.fn().mockResolvedValueOnce(reply(sandboxNotFound, 404)).mockResolvedValueOnce(reply({ ok: true, sandboxes: [] }));
    vi.stubGlobal("fetch", network);
    await expect(plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId })).rejects.toThrow("not a sandbox id");
    expect(network).toHaveBeenCalledTimes(1);
  });
});
