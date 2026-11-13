import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
afterEach(() => vi.unstubAllGlobals());
describe("Boat provider", () => {
  it("declares reusable sandbox leases and defaults reuseLease off", async () => {
    expect(manifest.environmentDrivers?.[0]?.sandboxCapabilities?.reusableLeases).toBe(true);
    expect(manifest.environmentDrivers?.[0]?.configSchema?.properties?.reuseLease).toMatchObject({ type: "boolean", default: false });
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: cfg })).toMatchObject({ ok: true, normalizedConfig: { reuseLease: false } });
    const { reuseLease: _omitted, ...withoutReuseOption } = cfg;
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: withoutReuseOption })).toMatchObject({ ok: true, normalizedConfig: { reuseLease: false } });
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: { ...cfg, reuseLease: true } })).toMatchObject({ ok: true, normalizedConfig: { reuseLease: true } });
  });
  it("validates and normalizes configuration", async () => {
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: { ...cfg, labels: { team: "x" } } })).toMatchObject({ ok: true, normalizedConfig: { apiKey: "boat_test", type: "small" } });
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: { ...cfg, ttlSeconds: -1 } })).toMatchObject({ ok: false });
  });
  it("accepts setupScript through 16 KiB and rejects larger or non-string values", async () => {
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: { ...cfg, setupScript: "x".repeat(16 * 1024) } })).toMatchObject({ ok: true });
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: { ...cfg, setupScript: "x".repeat(16 * 1024 + 1) } })).toMatchObject({ ok: false, errors: expect.arrayContaining(["setupScript must be at most 16 KiB."]) });
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: { ...cfg, setupScript: 42 } })).toMatchObject({ ok: false, errors: expect.arrayContaining(["setupScript must be a string."]) });
  });
  it("probes the cheap limits endpoint", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ limits: [] })); vi.stubGlobal("fetch", fetch);
    expect(await plugin.definition.onEnvironmentProbe?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg })).toMatchObject({ ok: true });
    expect(fetch.mock.calls[0][0]).toBe("https://boat.dev/api/v1/limits");
  });
  it("creates with bounded TTL, ownership labels and idempotency then waits ready", async () => {
    const setupScript = "#!/bin/sh\nprintf setup\n";
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "provisioning" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready", expiresAt: "2030-01-01T00:00:00Z" } })).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", setupStatus: "done" } })); vi.stubGlobal("fetch", fetch);
    const lease = await plugin.definition.onEnvironmentAcquireLease?.({ driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", creationOperationId: "op", config: { ...cfg, setupScript } });
    const init = fetch.mock.calls[0][1] as RequestInit; const body = JSON.parse(String(init.body));
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe("op"); expect(body.setupScript).toBe(setupScript); expect(body.ttlSeconds).toBe(1800); expect(body.labels).toMatchObject({ owner: "paperclip:co", purpose: "run", environment: "env", run: "run" }); expect(typeof body.labels.expiry).toBe("string"); expect(body.noEnv).toBe(true);
    expect(lease).toMatchObject({ providerLeaseId: "bx_1", expiresAt: "2030-01-01T00:00:00Z" });
  });
  it("stops a sandbox when setup fails and includes Boat's setup error", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } })).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", setupStatus: "failed", setupError: "dependency install failed" } })).mockResolvedValueOnce(response({ operation: { id: "stop_1", status: "pending" } }, 202)).mockResolvedValueOnce(response({ stop: { status: "completed" } })); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentAcquireLease?.({ driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", config: { ...cfg, setupScript: "true" } })).rejects.toThrow("Boat sandbox bx_1 setup failed: dependency install failed");
    expect(fetch.mock.calls[3][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1/stop"); expect(fetch.mock.calls[3][1]?.method).toBe("POST"); expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("stops a sandbox when setup times out", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } })).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", setupStatus: "running" } })).mockResolvedValueOnce(response({ operation: { id: "stop_1", status: "pending" } }, 202)).mockResolvedValueOnce(response({ stop: { status: "completed" } })); vi.stubGlobal("fetch", fetch);
    const acquire = plugin.definition.onEnvironmentAcquireLease?.({ driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", config: { ...cfg, setupScript: "true", setupTimeoutSeconds: 1 } });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(acquire).rejects.toThrow("Boat sandbox bx_1 setup timed out after 1 seconds");
    expect(fetch.mock.calls[3][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1/stop"); expect(fetch.mock.calls[3][1]?.method).toBe("POST"); expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    vi.useRealTimers();
  });
  it("quotes shell arguments and safely stages stdin", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => response(init.method === "POST" ? { exitCode: 0, stdout: "ok", stderr: "" } : { success: true })); vi.stubGlobal("fetch", fetch);
    const result = await plugin.definition.onEnvironmentExecute?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, lease: { providerLeaseId: "bx_1" }, command: "printf", args: ["a'b"], cwd: "/tmp/my dir", env: { FOO: "a'b" }, stdin: "hello", timeoutMs: 5000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });
    const staged = fetch.mock.calls.filter(([, init]) => init.method === "PUT").map(([, init]) => JSON.parse(String(init.body)));
    expect(staged.some(file => file.content === "hello")).toBe(true);
    expect(staged.some(file => file.content === "export FOO='a'\"'\"'b'\n")).toBe(true);
    const cmd = fetch.mock.calls.filter(([, init]) => init.method === "POST").map(([, init]) => JSON.parse(String(init.body)).command).at(-1);
    expect(cmd).toContain("cd '/tmp/my dir'"); expect(cmd).not.toContain("FOO="); expect(cmd).toContain("'printf' 'a'\"'\"'b'"); expect(cmd).toContain("< '/tmp/paperclip-stdin-");
    expect(fetch.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(3);
  });
  it("caps the synchronous timeout at 600 seconds and preserves provider timeout results", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ exitCode: null, timedOut: true, stdout: "partial", stderr: "timeout" })); vi.stubGlobal("fetch", fetch);
    const result = await plugin.definition.onEnvironmentExecute?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, lease: { providerLeaseId: "bx_1" }, command: "sleep", args: ["99"], timeoutMs: 900_000 });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ detached: true, timeoutSeconds: 600 }); expect(result).toMatchObject({ timedOut: true, exitCode: null, stdout: "partial" });
  });
  it("resumes an archived sandbox, waits for ready, and reapplies configured TTL", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id: "bx_archived", state: "archived" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_archived", state: "archived" } })).mockResolvedValueOnce(response({ sandbox: { id: "bx_archived", state: "ready", expiresAt: "2030-01-01T00:00:00Z", team: { id: "team_lease" } } })); vi.stubGlobal("fetch", fetch);
    const lease = await plugin.definition.onEnvironmentResumeLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: { ...cfg, reuseLease: true }, providerLeaseId: "bx_archived" });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ ttlSeconds: 1800, noEnv: true }); expect(lease).toMatchObject({ providerLeaseId: "bx_archived", expiresAt: "2030-01-01T00:00:00Z" }); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("stops and retains on release when reuseLease is enabled", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ stop: { id: "stop_1" } }, 202)).mockResolvedValueOnce(response({ stop: { status: "completed" } })); vi.stubGlobal("fetch", fetch);
    const receipt = await plugin.definition.onEnvironmentReleaseLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: { ...cfg, reuseLease: true }, providerLeaseId: "bx_1" });
    expect(fetch.mock.calls[0][1]?.method).toBe("POST"); expect(String(fetch.mock.calls[0][0])).toContain("/stop"); expect(receipt).toEqual({ providerLeaseId: "bx_1", state: "stopped" });
  });
  it("confirms stop completion before returning stopped on destroy", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ operation: { id: "stop_1", status: "pending" } }, 202)).mockResolvedValueOnce(response({ stop: { status: "completed" } })); vi.stubGlobal("fetch", fetch);
    const receipt = await plugin.definition.onEnvironmentDestroyLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, providerLeaseId: "bx_1" });
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[0][1]?.method).toBe("POST"); expect(fetch.mock.calls[1][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1/stops/stop_1"); expect(receipt).toEqual({ providerLeaseId: "bx_1", state: "stopped" });
  });
  it("does not report stopped or destroyed when stop returns 404", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "not_found" }, 404)); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentReleaseLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, providerLeaseId: "bx_1" })).rejects.toThrow("failed (404)");
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]?.method).toBe("POST"); expect(fetch.mock.calls[0][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1/stop");
  });
});
