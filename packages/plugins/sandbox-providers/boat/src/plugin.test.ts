import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import plugin, { setFaultProxyPathsForTest } from "./plugin.js";
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
  const override = "http://boat-fault-proxy:18991/fault/api/v1";
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  let sequence = 0, root: string, allowedFile: string, mountinfoFile: string;
  const escapeMount = (path: string) => path.replace(/\\/g, "\\134").replace(/ /g, "\\040").replace(/\t/g, "\\011").replace(/\n/g, "\\012");
  function mounts(options = "ro", mountPoint = allowedFile): void {
    writeFileSync(mountinfoFile, `1 0 0:1 / / rw,relatime - overlay overlay rw\n2 1 0:2 / ${escapeMount(mountPoint)} ${options},relatime - tmpfs tmpfs rw\n`);
  }
  function allow(content = override): void { writeFileSync(allowedFile, `${content}\n`); mounts(); }
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "boat-proxy "));
    allowedFile = join(root, "paperclip/boat-fault-proxy/ALLOWED");
    mountinfoFile = join(root, "mountinfo");
    mkdirSync(join(root, "paperclip/boat-fault-proxy"), { recursive: true });
    mounts();
    setFaultProxyPathsForTest({ allowedFile, mountinfoFile });
    for (const log of Object.values(logger)) log.mockClear();
    await plugin.definition.setup({ logger } as any);
  });
  afterEach(() => {
    setFaultProxyPathsForTest(); rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });

  // Row 6 is asserted on EVERY refusal below, including errors crossing the
  // plugin boundary; no URL, config object, filesystem exception or key echo.
  async function refused(apiBaseUrl: unknown, reason: RegExp, extra: Record<string, unknown> = {}): Promise<void> {
    const fetch = vi.fn().mockResolvedValue(response({ limits: [] })); vi.stubGlobal("fetch", fetch);
    const config = { ...cfg, apiBaseUrl, ...extra };
    const validation = await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config });
    expect(validation).toMatchObject({ ok: false, errors: [expect.stringMatching(reason)] });
    const probe = await plugin.definition.onEnvironmentProbe!({ driverKey: "boat", companyId: "c", environmentId: "e", config });
    expect(probe).toMatchObject({ ok: false });
    await expect(plugin.definition.onEnvironmentExecute!({ driverKey: "boat", companyId: "c", environmentId: "e", config,
      lease: { providerLeaseId: "bx_refused" }, command: "true", args: [] })).rejects.toThrow(reason);
    expect(fetch).not.toHaveBeenCalled(); // No override AND no boat.dev fallback.
    const logs = JSON.stringify(Object.values(logger).map(log => log.mock.calls));
    expect(logs).not.toContain(cfg.apiKey);
    expect(JSON.stringify({ validation, probe })).not.toContain(cfg.apiKey);
  }

  it("row 1: no operator file refuses an override, including config path spoofing", async () => {
    await refused(override, /apiBaseUrl.*no operator file/);
    const spoofFile = join(root, "forged-ALLOWED"), spoofMountinfo = join(root, "forged-mountinfo");
    writeFileSync(spoofFile, `${override}\n`);
    writeFileSync(spoofMountinfo, `1 0 0:1 / ${escapeMount(root)} ro - tmpfs tmpfs ro\n`);
    await refused(override, /apiBaseUrl.*no operator file/, { allowedFile: spoofFile, mountinfoFile: spoofMountinfo });
  });
  it("row 2: writable file mount is refused even when superblock options say ro", async () => {
    allow(); mounts("rw"); chmodSync(allowedFile, 0o444);
    writeFileSync(mountinfoFile, readFileSync(mountinfoFile, "utf8").replace("tmpfs rw", "tmpfs ro"));
    await refused(override, /apiBaseUrl.*not read-only/);
  });
  it("row 2: the actual kernel mountinfo refuses the writable temporary file", async () => {
    allow(); setFaultProxyPathsForTest({ allowedFile, mountinfoFile: "/proc/self/mountinfo" });
    await refused(override, /apiBaseUrl.*not read-only/);
  });
  it("row 3: different operator and configured URLs are refused", async () => {
    allow("http://other-proxy/api/v1"); await refused(override, /apiBaseUrl.*URL mismatch/);
  });
  it.each(["not a URL", "", "ftp://proxy", "file:///tmp/proxy", "http://user:pass@proxy/api", "http://@proxy/api",
    "http://proxy/api?secret=1", "http://proxy/api?", "http://proxy/api#fragment", "http://proxy/api#", "https://evil.example",
    "http://proxy.example.test/api", "http://192.168.1.1/api", "http://[::2]/api", "http://bad_host/api", "http://-bad/api", 42, null])
    ("row 3: URL not allowed %s even if the operator file matches", async apiBaseUrl => {
      allow(String(apiBaseUrl)); await refused(apiBaseUrl, /apiBaseUrl.*URL not allowed/);
    });
  it("row 3/6: refused URLs containing key bytes never reach captured logs or errors", async () => {
    allow(`https://${cfg.apiKey}.evil.example/api`);
    await refused(`https://${cfg.apiKey}.evil.example/api`, /apiBaseUrl.*URL not allowed/);
  });
  it.each(["", `${override}\nhttp://other-proxy/api`])("row 3: operator file must have exactly one nonempty line: %s", async content => {
    allow(content); await refused(override, /apiBaseUrl.*URL not allowed/);
  });
  it.each(["file", "parent", "paperclip"])("row 7: symlink at %s is refused despite a read-only target mount", async level => {
    allow();
    const path = level === "file" ? allowedFile : join(root, level === "parent" ? "paperclip/boat-fault-proxy" : "paperclip");
    const target = join(root, "readonly-target");
    if (level === "file") writeFileSync(target, `${override}\n`);
    else {
      mkdirSync(level === "parent" ? target : join(target, "boat-fault-proxy"), { recursive: true });
      writeFileSync(join(target, level === "parent" ? "ALLOWED" : "boat-fault-proxy/ALLOWED"), `${override}\n`);
    }
    rmSync(path, { recursive: true }); symlinkSync(target, path);
    mounts("ro", realpathSync(allowedFile));
    await refused(override, /apiBaseUrl.*symlink/);
  });

  async function routeFamilies(config: Record<string, unknown>, base: string) {
    const id = `bx_proxy_${++sequence}`, snapshotId = "12345678-1234-1234-1234-123456789abc";
    const params = { driverKey: "boat", companyId: "proxy_company", environmentId: "proxy_env", config };
    const seen = new Set<string>();
    let sentinel: { version: number; provider: string; token: string } | undefined;
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
      if (route === `/sandboxes/${id}`) return response({ sandbox: { id, state: "ready", stop: { id: "stop_proxy", status: "completed" },
        ...(method === "PATCH" ? { archiveAfter: new Date(Date.now() + Number(JSON.parse(String(init.body)).ttlSeconds) * 1000).toISOString() } : {}) } });
      if (route.endsWith("/stop")) return response({ stop: { id: "stop_proxy", status: "pending" } }, 202);
      if (route.endsWith("/commands")) {
        const command = String(JSON.parse(String(init.body)).command);
        if (command.includes("proxy-ambiguous")) return response({ code: "internal_error" }, 500);
        if (sentinel && command.includes("cat ")) return response({ exitCode: 0, stdout: JSON.stringify(sentinel), stderr: "" });
        return response({ processId: "cmd_proxy" });
      }
      if (route.endsWith("/command-history")) return response({ commands: [] });
      if (route.endsWith("/commands/cmd_proxy")) return response({ status: "completed", exitCode: 0, stdout: "ok", stderr: "" });
      if (route.endsWith("/files/upload-url")) return response({ url: "https://upload.example.test/object" });
      if (route.endsWith("/files")) {
        if (method === "PUT") {
          try { const value = JSON.parse(JSON.parse(String(init.body)).content); if (value?.provider === "boat" && value?.token) sentinel = value; } catch { /* Ordinary stdin, not a sentinel. */ }
        }
        return response({ success: true });
      }
      if (route.endsWith("/host")) return response({ port: 43127, url: "https://proxy-43127.on.boat.dev?_token=test", isProtected: true, access: "private" });
      // Fail after the real SSH registration + forced-command edit, before any
      // local SSH process or key generation. Destination/auth are already read.
      if (route.endsWith("/sshkey")) return response({});
      throw new Error(`Unexpected scripted route: ${method} ${route}`);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config })).toMatchObject({ ok: true });
    expect(await plugin.definition.onEnvironmentProbe!(params)).toMatchObject({ ok: true });
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...params, runId: "proxy_run", agentId: "proxy_agent", executionWorkspaceId: "proxy_workspace",
      config: { ...config, snapshot: snapshotId, duplexCarrier: "ssh" } });
    expect(lease.providerLeaseId).toBe(id);
    await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "operation", creationOperation: { id: "operation", runId: "proxy_run" } } as any);
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: id })).toMatchObject({ state: "active" });
    expect(await plugin.definition.onEnvironmentInspectLease!({ ...params, providerLeaseId: "bx_23456789", leaseMetadata: { boatOrgId: "org_proxy" } }))
      .toMatchObject({ state: "destroyed" });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, lease, command: "cat", args: [], stdin: "small" })).toMatchObject({ exitCode: 0 });
    expect(await plugin.definition.onEnvironmentExecute!({ ...params, lease, command: "cat", args: [], stdin: "x".repeat(4_194_305) })).toMatchObject({ exitCode: 0 });
    await expect(plugin.definition.onEnvironmentExecute!({ ...params, lease, command: "proxy-ambiguous", args: [] }))
      .rejects.toMatchObject({ code: "boat_command_possibly_ran" });
    await plugin.definition.onEnvironmentRunnerIngressEndpoint!({ ...params, lease, port: 43127, path: "/api/runner/v1/connect/test" });
    await expect(plugin.definition.onDuplexChannelOpen!({ ...params, providerLeaseId: id, hostRouteId: `route_${sequence}`, command: guardianCommand("test_runner") }))
      .rejects.toMatchObject({ code: "BOAT_SSH_PREPARE_FAILED" });
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...params, providerLeaseId: id, leaseMetadata: lease.metadata }))
      .toMatchObject({ providerLeaseId: id, metadata: { ttlRefresh: { status: "ok" } } });
    await plugin.definition.onEnvironmentReleaseLease!({ ...params, providerLeaseId: id });
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...params, providerLeaseId: id })).toMatchObject({ providerLeaseId: id });
    await plugin.definition.onEnvironmentDestroyLease!({ ...params, providerLeaseId: id });
    for (const route of ["GET /limits", "GET /orgs", "GET /sandboxes", "POST /sandboxes", "GET /sandboxes/{id}",
      "POST /sandboxes/{id}/commands", "GET /sandboxes/{id}/commands/cmd_proxy", "POST /sandboxes/{id}/stop",
      "POST /sandboxes/{id}/resume", "PATCH /sandboxes/{id}", "GET /sandboxes/{id}/command-history", "PUT /sandboxes/{id}/files", "DELETE /sandboxes/{id}/files",
      "POST /sandboxes/{id}/files/upload-url", "GET /saved-snapshots", "GET /saved-snapshots/proxy-image",
      "POST /sandboxes/{id}/host", "POST /sandboxes/{id}/sshkey"]) expect(seen, route).toContain(route);
    const bearerCalls = fetch.mock.calls.filter(([, init]) => new Headers(init?.headers).has("Authorization"));
    expect(bearerCalls.every(([url]) => url.startsWith(`${base}/`))).toBe(true);
    console.info("BOAT_APIBASE_ROUTES", JSON.stringify({ base, routes: [...seen].sort(),
      bearerOrigins: [...new Set(bearerCalls.map(([url]) => new URL(url).origin))], signedUploadBearer: false }));
  }

  it("row 5: no file and no URL uses Boat for every route family", async () => {
    await routeFamilies(cfg, "https://boat.dev/api/v1");
    expect(logger.warn.mock.calls.filter(([message]) => String(message).includes("apiBaseUrl"))).toHaveLength(0);
  });
  it.each([override, "https://proxy/fault/api/v1/", "http://127.0.0.1:18991/api/v1", "http://[::1]:18991/api/v1", "http://localhost:18991/api/v1"])
    ("row 4: read-only operator URL %s receives every family and is the only bearer destination", async apiBaseUrl => {
      allow(apiBaseUrl);
      await routeFamilies({ ...cfg, apiBaseUrl }, apiBaseUrl.replace(/\/+$/, ""));
      expect(logger.warn.mock.calls.filter(([message]) => String(message).includes("apiBaseUrl"))).toHaveLength(1);
      expect(JSON.stringify(Object.values(logger).map(log => log.mock.calls))).not.toContain(cfg.apiKey);
    });
  it("row 4/6: an allowed host matching the trimmed key is never logged", async () => {
    allow();
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: {
      ...cfg, apiKey: " boat-fault-proxy ", apiBaseUrl: override,
    } })).toMatchObject({ ok: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(Object.values(logger).map(log => log.mock.calls))).not.toContain("boat-fault-proxy");
  });
  it("row 4: normalizes both URLs and trims a single operator line", async () => {
    allow(" \tHTTP://BOAT-FAULT-PROXY:80/fault/api/v1/// \n");
    await routeFamilies({ ...cfg, apiBaseUrl: "http://boat-fault-proxy/fault/api/v1/" }, "http://boat-fault-proxy/fault/api/v1");
  });
  it("row 4: read-only parent mount covers the file, decoding mountinfo escapes", async () => {
    allow(); mounts("ro", join(root, "paperclip"));
    await routeFamilies({ ...cfg, apiBaseUrl: override }, override);
  });
  it("row 2: longest mount prefix wins over a read-only parent", async () => {
    allow(); mounts("ro", join(root, "paperclip"));
    writeFileSync(mountinfoFile, `${readFileSync(mountinfoFile, "utf8")}3 2 0:3 / ${escapeMount(allowedFile)} rw - tmpfs tmpfs ro\n`);
    await refused(override, /apiBaseUrl.*not read-only/);
  });
  it("row 2: a lexical non-directory prefix is not a covering mount", async () => {
    allow(); mounts("ro", `${allowedFile.slice(0, -1)}`);
    await refused(override, /apiBaseUrl.*not read-only/);
  });
  it.each(["removed", "writable", "changed"])("rechecks operator authority after validation: %s", async change => {
    allow();
    expect(await plugin.definition.onEnvironmentValidateConfig!({ driverKey: "boat", config: { ...cfg, apiBaseUrl: override } })).toMatchObject({ ok: true });
    if (change === "removed") rmSync(allowedFile);
    if (change === "writable") mounts("rw");
    if (change === "changed") allow("http://other-proxy/api");
    await refused(override, /apiBaseUrl/);
  });
  it("production cannot switch either fixed path through the module seam", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => setFaultProxyPathsForTest({ allowedFile: "/tmp/forged", mountinfoFile: "/tmp/forged" })).toThrow(/test-only/);
    vi.stubEnv("NODE_ENV", "test");
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
