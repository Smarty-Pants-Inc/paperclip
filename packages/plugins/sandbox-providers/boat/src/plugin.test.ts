import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
import manifest from "./manifest.js";
import * as guardianStage from "./guardian-stage.js";
import { OwnedSshAgent } from "./ssh-agent.js";
import { guardianCommand } from "./guardian-contract.js";
const cfg = { apiKey: "boat_test", type: "small", ttlSeconds: 1800, reuseLease: false, labels: {} };
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); }
beforeEach(async () => { await plugin.definition.setup({ logger: { info() {}, warn() {}, error() {}, debug() {} } } as any); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
// Keep: bearer-key destination is a never-OK secret boundary. Exercise the
// actual hooks and HTTP transport, not a replacement base-URL helper.
describe("Boat fault-proxy apiBaseUrl", () => {
  const flag = "PAPERCLIP_BOAT_FAULT_PROXY_ALLOWED";
  const override = "http://127.0.0.1:18991/fault/api/v1";
  const warn = vi.fn();
  let sequence = 0;
  beforeEach(async () => {
    vi.stubEnv(flag, undefined);
    warn.mockClear();
    await plugin.definition.setup({ logger: { info() {}, warn, error() {}, debug() {} } } as any);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([undefined, "0", "true", ""])("row 1: refuses apiBaseUrl when the server flag is %s before any override fetch", async value => {
    vi.stubEnv(flag, value);
    const fetch = vi.fn().mockResolvedValue(response({ limits: [] })); vi.stubGlobal("fetch", fetch);
    const config = { ...cfg, apiBaseUrl: override, [flag]: "1" };
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config }))
      .toMatchObject({ ok: false, errors: [expect.stringMatching(/apiBaseUrl.*PAPERCLIP_BOAT_FAULT_PROXY_ALLOWED/)] });
    expect(await plugin.definition.onEnvironmentProbe!({ driverKey: "boat", companyId: "c", environmentId: "e", config }))
      .toMatchObject({ ok: false });
    await expect(plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config,
      lease: { providerLeaseId: "bx_refused" }, command: "true", args: [] })).rejects.toThrow(/apiBaseUrl/);
    expect(fetch.mock.calls.some(([url]) => String(url).startsWith(override))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  async function routeFamilies(config: Record<string, unknown>, base: string) {
    const id = `bx_proxy_${++sequence}`, snapshotId = "12345678-1234-1234-1234-123456789abc";
    const params = { driverKey: "boat", companyId: "proxy_company", environmentId: "proxy_env", config };
    const seen = new Set<string>();
    // Only the unrelated resident/agent preflight is replaced. SSH API calls
    // still travel from the real duplex hook through the real carrier adapter.
    vi.spyOn(guardianStage, "stageGuardian").mockResolvedValue({ usable: true } as any);
    vi.spyOn(OwnedSshAgent.prototype, "start").mockResolvedValue({ workerId: "test-worker", publicKey: "ssh-ed25519 YQ==" } as any);
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === "https://upload.example.test/object") {
        expect(new Headers(init.headers).has("Authorization")).toBe(false);
        expect(init.redirect).toBe("error");
        return response({});
      }
      // Assert EVERY HTTP call, including retries and cleanup, before replying.
      expect(url.startsWith(`${base}/`)).toBe(true);
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${cfg.apiKey}`);
      expect(init.redirect).toBe("error");
      const route = url.slice(base.length).split("?")[0], method = init.method ?? "GET";
      seen.add(`${method} ${route.replaceAll(id, "{id}")}`);
      if (route === "/limits") return response({ limits: [] });
      if (route === "/orgs") return response({ ok: true, orgs: [{ id: "org_proxy", type: "org" }] });
      if (route === "/sandboxes/bx_23456789") return response({ code: "not_found" }, 404);
      if (route === "/saved-snapshots") return response({ snapshots: [{ name: "proxy-image", snapshotId }] });
      if (route === "/saved-snapshots/proxy-image") return response({ snapshot: { name: "proxy-image", snapshotId, status: "ready", createdAt: "2026-11-18T00:00:00Z" } });
      if (route === "/sandboxes" && method === "GET") return response({ sandboxes: [], pageInfo: {} });
      if (route === "/sandboxes" || route === `/sandboxes/${id}/resume`) return response({ sandbox: { id, state: "ready" } }, 202);
      if (route === `/sandboxes/${id}`) return response({ sandbox: { id, state: "ready", stop: { id: "stop_proxy", status: "completed" } } });
      if (route.endsWith("/stop")) return response({ stop: { id: "stop_proxy", status: "pending" } }, 202);
      if (route.endsWith("/commands")) return response({ processId: "cmd_proxy" });
      if (route.endsWith("/commands/cmd_proxy")) return response({ status: "completed", exitCode: 0, stdout: "ok", stderr: "" });
      if (route.endsWith("/files/upload-url")) return response({ url: "https://upload.example.test/object" });
      if (route.endsWith("/files")) return response({ success: true });
      if (route.endsWith("/host")) return response({ port: 43127, url: "https://proxy-43127.on.boat.dev?_token=test", isProtected: true, access: "private" });
      // Fail after the real SSH registration + forced-command edit, before any
      // local SSH process or key generation. Destination/auth are already read.
      if (route.endsWith("/sshkey")) return response({});
      throw new Error(`Unexpected scripted route: ${method} ${route}`);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config })).toMatchObject({ ok: true });
    expect(await plugin.definition.onEnvironmentProbe!(params)).toMatchObject({ ok: true });
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...params, runId: "proxy_run", config: { ...config, snapshot: snapshotId, duplexCarrier: "ssh" } });
    expect(lease.providerLeaseId).toBe(id);
    await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "operation", creationOperation: { id: "operation", runId: "proxy_run" } } as any);
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: id })).toMatchObject({ state: "active" });
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "bx_23456789", leaseMetadata: { boatOrgId: "org_proxy" } }))
      .toMatchObject({ state: "destroyed" });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, lease, command: "cat", args: [], stdin: "small" })).toMatchObject({ exitCode: 0 });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, lease, command: "cat", args: [], stdin: "x".repeat(4_194_305) })).toMatchObject({ exitCode: 0 });
    await plugin.definition.onEnvironmentRunnerIngressEndpoint!({ ...params, lease, port: 43127, path: "/api/runner/v1/connect/test" });
    await expect(plugin.definition.onDuplexChannelOpen!({ ...params, providerLeaseId: id, hostRouteId: `route_${sequence}`, command: guardianCommand("test_runner") }))
      .rejects.toMatchObject({ code: "BOAT_SSH_PREPARE_FAILED" });
    await plugin.definition.onEnvironmentReleaseLease!({ ...params, providerLeaseId: id });
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...params, providerLeaseId: id })).toMatchObject({ providerLeaseId: id });
    await plugin.definition.onEnvironmentDestroyLease!({ ...params, providerLeaseId: id });
    for (const route of ["GET /limits", "GET /orgs", "GET /sandboxes", "POST /sandboxes", "GET /sandboxes/{id}",
      "POST /sandboxes/{id}/commands", "GET /sandboxes/{id}/commands/cmd_proxy", "POST /sandboxes/{id}/stop",
      "POST /sandboxes/{id}/resume", "PUT /sandboxes/{id}/files", "DELETE /sandboxes/{id}/files",
      "POST /sandboxes/{id}/files/upload-url", "GET /saved-snapshots", "GET /saved-snapshots/proxy-image",
      "POST /sandboxes/{id}/host", "POST /sandboxes/{id}/sshkey"]) expect(seen, route).toContain(route);
    const bearerCalls = fetch.mock.calls.filter(([, init]) => new Headers(init?.headers).has("Authorization"));
    expect(bearerCalls.every(([url]) => url.startsWith(`${base}/`))).toBe(true);
    console.info("BOAT_APIBASE_ROUTES", JSON.stringify({ base, routes: [...seen].sort(),
      bearerOrigins: [...new Set(bearerCalls.map(([url]) => new URL(url).origin))], signedUploadBearer: false }));
  }

  it("row 2: without flag or apiBaseUrl, every route family uses Boat", async () => {
    await routeFamilies(cfg, "https://boat.dev/api/v1");
    expect(warn.mock.calls.filter(([message]) => String(message).includes("apiBaseUrl"))).toHaveLength(0);
  });
  it.each([override, "https://proxy.example.test/fault/api/v1/"])("row 3: flag routes every family to %s, with bearer only there", async apiBaseUrl => {
    vi.stubEnv(flag, "1");
    await routeFamilies({ ...cfg, apiBaseUrl }, apiBaseUrl.replace(/\/+$/, ""));
    const warnings = warn.mock.calls.filter(([message]) => String(message).includes("apiBaseUrl"));
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain(new URL(apiBaseUrl).host);
    expect(JSON.stringify(warnings)).not.toContain(cfg.apiKey);
  });
  it("never logs the trimmed bearer key, even if it occurs in the override host", async () => {
    vi.stubEnv(flag, "1");
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: {
      ...cfg, apiKey: ` ${cfg.apiKey} `, apiBaseUrl: `http://${cfg.apiKey}.example.test/api/v1`,
    } })).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toContain("[REDACTED]");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(cfg.apiKey);
  });
  it("rechecks the process flag if it is removed after configuration validation", async () => {
    vi.stubEnv(flag, "1");
    const config = { ...cfg, apiBaseUrl: override };
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config })).toMatchObject({ ok: true });
    vi.stubEnv(flag, undefined);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(await plugin.definition.onEnvironmentProbe!({ driverKey: "boat", companyId: "c", environmentId: "e", config })).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["not a URL", "", "ftp://proxy.test", "file:///tmp/proxy", "http://user:pass@proxy.test/api", "http://@proxy.test/api",
    "http://proxy.test/api?secret=1", "http://proxy.test/api?", "http://proxy.test/api#fragment", "http://proxy.test/api#", 42, null])
    ("row 4: flag still refuses invalid apiBaseUrl %s", async apiBaseUrl => {
      vi.stubEnv(flag, "1");
      const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
      expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...cfg, apiBaseUrl } })).toMatchObject({ ok: false, errors: [expect.stringContaining("apiBaseUrl")] });
      expect(await plugin.definition.onEnvironmentProbe!({ driverKey: "boat", companyId: "c", environmentId: "e", config: { ...cfg, apiBaseUrl } })).toMatchObject({ ok: false });
      expect(fetch).not.toHaveBeenCalled();
    });
  it("row 5: flag without apiBaseUrl still uses Boat for every family", async () => {
    vi.stubEnv(flag, "1");
    await routeFamilies(cfg, "https://boat.dev/api/v1");
    expect(warn.mock.calls.filter(([message]) => String(message).includes("apiBaseUrl"))).toHaveLength(0);
  });
});

describe("Boat provider", () => {
  it("declares reusable sandbox leases and defaults reuseLease off", async () => {
    expect(manifest.environmentDrivers?.[0]?.sandboxCapabilities?.reusableLeases).toBe(true);
    expect(manifest.environmentDrivers?.[0]?.configSchema?.properties?.reuseLease).toMatchObject({ type: "boolean", default: false });
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: cfg })).toMatchObject({ ok: true, normalizedConfig: { reuseLease: false } });
    const { reuseLease: _omitted, ...withoutReuseOption } = cfg;
    expect(await plugin.definition.onEnvironmentValidateConfig?.({ driverKey: "boat", config: withoutReuseOption })).toEqual({ ok: true, normalizedConfig: withoutReuseOption });
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
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } })).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", setupStatus: "failed", setupError: "dependency install failed" } })).mockResolvedValueOnce(response({ operation: { id: "stop_1", status: "pending" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "archiving", stop: { id: "stop_1", status: "completed" } } })); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentAcquireLease?.({ driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", config: { ...cfg, setupScript: "true" } })).rejects.toThrow("Boat sandbox bx_1 setup failed: dependency install failed");
    expect(fetch.mock.calls[3][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1/stop"); expect(fetch.mock.calls[3][1]?.method).toBe("POST"); expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("stops a sandbox when setup times out", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "ready" } })).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", setupStatus: "running" } })).mockResolvedValueOnce(response({ operation: { id: "stop_1", status: "pending" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "archiving", stop: { id: "stop_1", status: "completed" } } })); vi.stubGlobal("fetch", fetch);
    const acquire = plugin.definition.onEnvironmentAcquireLease?.({ driverKey: "boat", companyId: "co", environmentId: "env", runId: "run", config: { ...cfg, setupScript: "true", setupTimeoutSeconds: 1 } });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(acquire).rejects.toThrow("Boat sandbox bx_1 setup timed out after 1 seconds");
    expect(fetch.mock.calls[3][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1/stop"); expect(fetch.mock.calls[3][1]?.method).toBe("POST"); expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    vi.useRealTimers();
  });
  it("creates one private lease directory then uses three requests for execute-with-env", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => response(init.method === "POST" ? { exitCode: 0, stdout: "ok", stderr: "" } : { success: true })); vi.stubGlobal("fetch", fetch);
    await plugin.definition.onEnvironmentExecute?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg,
      lease: { providerLeaseId: "bx_1" }, command: "true", args: [], env: { BOAT_SECRET: "sensitive-value" }, timeoutMs: 5000 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "PUT", "POST", "DELETE"]);
    const setupCommand = JSON.parse(String(fetch.mock.calls[0][1]?.body)).command as string;
    expect(setupCommand).toContain("/bin/mkdir -p -m 0700"); expect(setupCommand).toContain("test ! -L");
    expect(String(fetch.mock.calls[3][0])).toMatch(/^https:\/\/boat\.dev\/api\/v1\/sandboxes\/bx_1\/files\?path=%2Ftmp%2Fpaperclip-boat-env-.*\.sh$/);
    const command = JSON.parse(String(fetch.mock.calls[2][1]?.body)).command as string;
    expect(command).toContain("/bin/chmod 600"); expect(command).not.toContain("sensitive-value"); expect(command).not.toContain("BOAT_SECRET");
    expect(String(fetch.mock.calls[1][1]?.body)).toContain("sensitive-value");
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
    expect(fetch.mock.calls.filter(([, init]) => init.method === "DELETE")).toHaveLength(2);
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
    const fetch = vi.fn().mockResolvedValueOnce(response({ stop: { id: "stop_1" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "archiving", stop: { id: "stop_1", status: "completed" } } })); vi.stubGlobal("fetch", fetch);
    const receipt = await plugin.definition.onEnvironmentReleaseLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: { ...cfg, reuseLease: true }, providerLeaseId: "bx_1" });
    expect(fetch.mock.calls[0][1]?.method).toBe("POST"); expect(String(fetch.mock.calls[0][0])).toContain("/stop"); expect(receipt).toEqual({ providerLeaseId: "bx_1", state: "stopped" });
  });
  it("confirms stop completion before returning stopped on destroy", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ operation: { id: "stop_1", status: "pending" } }, 202)).mockResolvedValueOnce(response({ sandbox: { id: "bx_1", state: "archiving", stop: { id: "stop_1", status: "completed" } } })); vi.stubGlobal("fetch", fetch);
    const receipt = await plugin.definition.onEnvironmentDestroyLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, providerLeaseId: "bx_1" });
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[0][1]?.method).toBe("POST"); expect(fetch.mock.calls[1][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1"); expect(receipt).toEqual({ providerLeaseId: "bx_1", state: "stopped" });
  });
  it("pins sandbox collection methods across destroy, release, and failed-create cleanup", async () => {
    const rootCalls: Array<[string, string]> = [];
    const stopFetch = vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input), method = init.method ?? "GET";
      rootCalls.push([url.pathname, method]);
      return response(url.pathname.endsWith("/stop") ? { operation: { id: "stop_pin", status: "pending" } }
        : { sandbox: { id: "bx_pin", state: "archiving", stop: { id: "stop_pin", status: "completed" } } }, url.pathname.endsWith("/stop") ? 202 : 200);
    });
    vi.stubGlobal("fetch", stopFetch);
    expect(await plugin.definition.onEnvironmentDestroyLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, providerLeaseId: "bx_pin" }))
      .toEqual({ providerLeaseId: "bx_pin", state: "stopped" });
    await plugin.definition.onEnvironmentReleaseLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, providerLeaseId: "bx_pin" });
    expect(rootCalls).toEqual([
      ["/api/v1/sandboxes/bx_pin/stop", "POST"], ["/api/v1/sandboxes/bx_pin", "GET"],
      ["/api/v1/sandboxes/bx_pin/stop", "POST"], ["/api/v1/sandboxes/bx_pin", "GET"],
    ]);

    const cleanupCalls: Array<[string, string]> = [];
    let cleanupStopped = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input), method = init.method ?? "GET";
      cleanupCalls.push([url.pathname, method]);
      if (url.pathname === "/api/v1/sandboxes") return response({ sandbox: { id: "bx_pin", state: "provisioning" } }, 202);
      if (url.pathname === "/api/v1/sandboxes/bx_pin") {
        if (method === "GET" && cleanupStopped) return response({ sandbox: { id: "bx_pin", state: "archived", stop: { id: "stop_pin", status: "completed" } } });
        return response({ sandbox: { id: "bx_pin", state: "error" } });
      }
      if (url.pathname.endsWith("/stop")) { cleanupStopped = true; return response({ operation: { id: "stop_pin", status: "pending" } }, 202); }
      return response({});
    }));
    await expect(plugin.definition.onEnvironmentAcquireLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", runId: "r", config: cfg }))
      .rejects.toThrow("entered error");
    expect(cleanupCalls).toEqual([
      ["/api/v1/sandboxes", "POST"], ["/api/v1/sandboxes/bx_pin", "GET"],
      ["/api/v1/sandboxes/bx_pin/stop", "POST"], ["/api/v1/sandboxes/bx_pin", "GET"],
    ]);
    const collectionCalls = [...rootCalls, ...cleanupCalls].filter(([path]) => /^\/api\/v1\/sandboxes\/[^/]+$/.test(path));
    expect(collectionCalls.every(([, method]) => ["GET", "POST", "PATCH"].includes(method))).toBe(true);
    expect([...rootCalls, ...cleanupCalls].some(([, method]) => method === "DELETE")).toBe(false);
  });

  it("does not report stopped or destroyed when stop returns 404", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "not_found" }, 404)); vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentReleaseLease?.({ driverKey: "boat", companyId: "c", environmentId: "e", config: cfg, providerLeaseId: "bx_1" })).rejects.toThrow("failed (404)");
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]?.method).toBe("POST"); expect(fetch.mock.calls[0][0]).toBe("https://boat.dev/api/v1/sandboxes/bx_1/stop");
  });
});
