import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

// Keep: PR #24's real warm-reuse TTL regression, provider ownership trust boundary,
// and secret-bearing transport failures that cannot safely be seeded live.
const apiKey = "boat_ttl_private_key";
const id = "bx_ttlrenew";
const oldDeadline = "2026-11-13T18:00:00Z";
const refreshedDeadline = "2026-11-14T02:30:00Z";
const configs = [
  { apiKey, reuseLease: true, ttlSeconds: 30600, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 28800000 },
  { apiKey, reuseLease: true, ttlSeconds: 88200, runnerLifecycleMode: "warm", runnerIdleTimeoutMs: 86400000 },
];
const scope = { driverKey: "boat", companyId: "ttl-company", environmentId: "ttl-environment" };
function reply(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
type Failure = "http" | "network" | "wrong_id" | "invalid_json";
function fixture(state: string, failure?: Failure, bare = false, deadline?: { archiveAfter?: unknown; expiresAt?: unknown }, oldArchiveAfter: string | null = oldDeadline) {
  let sentinel: unknown;
  let resumed = false, acquisitionRead = true;
  const network = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.endsWith("/sandboxes") && init?.method === "POST") return reply({ sandbox: { id, state: "ready" } }, 202);
    if (u.endsWith(`/sandboxes/${id}`)) {
      if (init?.method === "PATCH") {
        if (failure === "http") return reply({ message: apiKey, error: { cause: apiKey } }, 500);
        if (failure === "network") throw new Error(`transport secret ${apiKey}`, { cause: new Error(apiKey) });
        if (failure === "invalid_json") return new Response(apiKey, { status: 200 });
        const sandbox = { id: failure === "wrong_id" ? `foreign_${apiKey}` : id, state,
          ...(deadline ?? { archiveAfter: new Date(Date.now() + body.ttlSeconds * 1000).toISOString() }), team: { id: "team_refreshed" } };
        return reply(bare ? sandbox : { sandbox });
      }
      const observedState = acquisitionRead || resumed ? "ready" : state;
      acquisitionRead = false;
      return reply({ sandbox: { id, state: observedState,
        archiveAfter: oldArchiveAfter, team: { id: "team_original" } } });
    }
    if (u.endsWith("/resume")) { resumed = true; return reply({ sandbox: { id, state: "ready" } }, 202); }
    if (u.endsWith("/files") && init?.method === "PUT") { sentinel = JSON.parse(body.content); return reply({ success: true }); }
    if (u.includes("/files?")) return reply({ content: JSON.stringify(sentinel), encoding: "utf8" });
    if (u.endsWith("/commands")) return reply({ exitCode: 0, timedOut: false, stdout: body.command?.includes("cat ") ? JSON.stringify(sentinel) : "", stderr: "" });
    throw new Error("Unexpected TTL fixture request");
  });
  vi.stubGlobal("fetch", network);
  return network;
}
async function acquire(config: Record<string, unknown>) {
  return plugin.definition.onEnvironmentAcquireLease!({ ...scope, config, runId: "ttl-run", agentId: "ttl-agent", executionWorkspaceId: "ttl-workspace", adapterType: "paperclip_runner" });
}
beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(Date.parse(oldDeadline)); });
afterEach(async () => { await plugin.definition.onShutdown?.(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Boat warm reuse TTL refresh", () => {
  for (const config of configs) {
    it.each(["running", "idle", "ready"])(`renews %s once with configured TTL ${config.ttlSeconds} and returns PATCH deadline/owner`, async state => {
      const network = fixture(state); const lease = await acquire(config); network.mockClear();
      const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id,
        leaseMetadata: { ...lease.metadata, ttlRefresh: { status: "failed", category: "http_error" } } });
      const patches = network.mock.calls.filter(([, init]) => init?.method === "PATCH");
      expect(patches).toHaveLength(1);
      expect(String(patches[0][0])).toBe(`https://boat.dev/api/v1/sandboxes/${id}`);
      expect(JSON.parse(String(patches[0][1]?.body))).toEqual({ ttlSeconds: config.ttlSeconds });
      expect(network.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
      const archiveAfter = new Date(Date.now() + config.ttlSeconds * 1000).toISOString();
      expect(result).toMatchObject({ providerLeaseId: id, expiresAt: archiveAfter,
        metadata: { boatOrgId: "team_refreshed", resumedFromState: state, workspaceSentinel: { result: "matched" } } });
      expect(result.metadata!.ttlRefresh).toEqual({ status: "ok", at: new Date(Date.now()).toISOString(), archiveAfter });
    });
  }
  it.each(["stopped", "archived"])("resumes %s with TTL and never PATCHes", async state => {
    const config = configs[0], network = fixture(state); const lease = await acquire(config); network.mockClear();
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    const resumes = network.mock.calls.filter(([url]) => String(url).endsWith("/resume"));
    expect(resumes).toHaveLength(1);
    expect(JSON.parse(String(resumes[0][1]?.body))).toEqual({ ttlSeconds: 30600, noEnv: true });
    expect(network.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(result).toMatchObject({ providerLeaseId: id, expiresAt: oldDeadline, metadata: { boatOrgId: "team_original" } });
  });
  for (const state of ["running", "idle", "ready"]) {
    it.each([
      { failure: "http", category: "http_error", httpStatus: 500 },
      { failure: "network", category: "network_error", httpStatus: null },
      { failure: "wrong_id", category: "parse_error", httpStatus: 200 },
      { failure: "invalid_json", category: "parse_error", httpStatus: 200 },
    ] as const)(`keeps ${state} lease, old deadline/owner and safe warning after $failure failure`, async ({ failure, category, httpStatus }) => {
      // Cover the production TTL AND the old branch that already tried to PATCH.
      for (const ttlSeconds of [30600, 60]) {
        const config = { ...configs[0], ttlSeconds }, network = fixture(state, failure);
        const lease = await acquire(config); network.mockClear();
        const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
        expect(result).toMatchObject({ providerLeaseId: id, expiresAt: oldDeadline,
          metadata: { boatOrgId: "team_original", workspaceSentinel: { result: "matched" }, ttlRefresh: { status: "failed", category, httpStatus } } });
        expect(result.metadata!.ttlRefresh).toEqual({ status: "failed", at: new Date(Date.now()).toISOString(), category, httpStatus, archiveAfter: oldDeadline });
        expect(JSON.stringify(result)).not.toContain(apiKey);
        expect(network.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
        expect(network.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
      }
    });
  }
  it.each(["running", "idle"])("renews %s without spending a start and records the full fetch call list", async state => {
    const config = configs[0], network = fixture(state);
    const lease = await acquire(config); network.mockClear();
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    // Record every request, including safe headers, without ever recording Authorization.
    const calls = network.mock.calls.map(([url, init]) => ({ method: init?.method ?? "GET", url: String(url),
      boatOrg: new Headers(init?.headers).get("X-Boat-Org"), body: init?.body ?? null }));
    console.info("TTL_RENEW_FULL_FETCH_CALL_LIST", JSON.stringify({ state, calls }));
    expect(calls.filter(call => call.method === "PATCH")).toEqual([{
      method: "PATCH", url: `https://boat.dev/api/v1/sandboxes/${id}`, boatOrg: "team_original", body: JSON.stringify({ ttlSeconds: config.ttlSeconds }),
    }]);
    expect(calls.filter(call => call.method === "POST" && /\/(?:resume|sandboxes)$/.test(call.url))).toEqual([]);
    expect(result.metadata!.ttlRefresh).toMatchObject({ status: "ok" });
  });
  it.each([
    { name: "recorded org", metadata: { boatOrgId: "team_recorded" }, expected: "team_recorded" },
    { name: "personal overrides stale org", metadata: { boatOrgId: "team_stale", boatOwner: { kind: "personal" } }, expected: null },
    { name: "missing org", metadata: { boatOrgId: undefined }, expected: null },
    { name: "blank org", metadata: { boatOrgId: "  " }, expected: null },
  ])("scopes PATCH like inspect for $name, never from the mutable GET owner", async ({ metadata, expected }) => {
    const config = configs[0], network = fixture("running"); const lease = await acquire(config); network.mockClear();
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: { ...lease.metadata, ...metadata } });
    const patches = network.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(new Headers(patches[0][1]?.headers).get("X-Boat-Org")).toBe(expected);
  });
  it("anchors confirmation and receipt time to the PATCH request, not the delayed response", async () => {
    let now = Date.parse(oldDeadline); vi.spyOn(Date, "now").mockImplementation(() => now);
    const config = configs[0], network = fixture("running"); const lease = await acquire(config);
    const implementation = network.getMockImplementation()!;
    network.mockImplementation(async (...args) => {
      const response = await implementation(...args);
      if (args[1]?.method === "PATCH") now += 300_000;
      return response;
    });
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    expect(result.metadata!.ttlRefresh).toEqual({ status: "ok", at: new Date(oldDeadline).toISOString(), archiveAfter: new Date(refreshedDeadline).toISOString() });
  });
  it.each([
    { name: "missing", deadline: {}, archiveAfter: null },
    { name: "null", deadline: { archiveAfter: null }, archiveAfter: null },
    { name: "numeric", deadline: { archiveAfter: 1234 }, archiveAfter: null },
    { name: "invalid", deadline: { archiveAfter: "not-a-date" }, archiveAfter: null },
    { name: "impossible calendar date", deadline: { archiveAfter: "2026-02-30T02:30:00Z" }, archiveAfter: null },
    { name: "impossible hour", deadline: { archiveAfter: "2026-11-14T24:00:00Z" }, archiveAfter: null },
    { name: "missing timezone", deadline: { archiveAfter: "2026-11-14T02:30:00" }, archiveAfter: null },
    { name: "non-ISO grammar", deadline: { archiveAfter: "November 14, 2026 02:30:00 GMT" }, archiveAfter: null },
    { name: "one millisecond too early", deadline: { archiveAfter: "2026-11-14T02:27:59.999Z" }, archiveAfter: "2026-11-14T02:27:59.999Z" },
    { name: "one millisecond too late", deadline: { archiveAfter: "2026-11-14T02:32:00.001Z" }, archiveAfter: "2026-11-14T02:32:00.001Z" },
  ])("returns an unconfirmed receipt for $name archiveAfter without throwing", async ({ deadline, archiveAfter }) => {
    const config = configs[0], network = fixture("running", undefined, false, deadline);
    const lease = await acquire(config); network.mockClear();
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    expect(result.metadata!.ttlRefresh).toEqual({ status: "unconfirmed", at: new Date(Date.now()).toISOString(), archiveAfter });
    expect(result.expiresAt).toBe(archiveAfter);
    expect(result.metadata!.boatOrgId).toBe("team_refreshed");
  });
  it.each([
    "2026-11-14T02:28:00Z", "2026-11-14T02:32:00Z", "2026-11-14T04:30:00+02:00",
  ])("confirms a strictly parsed inclusive-window deadline %s", async archiveAfter => {
    const config = configs[0]; fixture("idle", undefined, false, { archiveAfter });
    const lease = await acquire(config);
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    expect(result.metadata!.ttlRefresh).toEqual({ status: "ok", at: new Date(Date.now()).toISOString(), archiveAfter });
    expect(result.expiresAt).toBe(archiveAfter);
  });
  it.each(["2026-11-14T02:30:00Z", "2026-02-30T02:30:00Z", 1234, null])("retains an unconfirmed response expiresAt only when strictly parsed: %s", async expiresAt => {
    const config = configs[0]; fixture("running", undefined, false, { expiresAt }); const lease = await acquire(config);
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    expect(result.metadata!.ttlRefresh).toEqual({ status: "unconfirmed", at: new Date(Date.now()).toISOString(), archiveAfter: null });
    expect(result.expiresAt).toBe(expiresAt === "2026-11-14T02:30:00Z" ? expiresAt : null);
  });
  it.each(["ok", "failed", "unconfirmed"] as const)("logs exactly one safe %s refresh line at the correct severity", async status => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    await plugin.definition.setup({ logger } as any); logger.info.mockClear();
    const config = configs[0]; fixture("running", status === "failed" ? "http" : undefined, false, status === "unconfirmed" ? {} : undefined);
    const lease = await acquire(config);
    await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    const log = status === "ok" ? logger.info : logger.warn;
    expect(log).toHaveBeenCalledExactlyOnceWith("Boat warm lease TTL refresh", {
      providerLeaseId: id, status, category: status === "failed" ? "http_error" : status === "unconfirmed" ? "deadline_mismatch" : null,
    });
    expect(status === "ok" ? logger.warn : logger.info).not.toHaveBeenCalled();
    expect(JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls])).not.toContain(apiKey);
  });
  it("records null when the failed refresh has no pre-PATCH archiveAfter", async () => {
    const config = configs[0]; fixture("running", "network", false, undefined, null); const lease = await acquire(config);
    const result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata });
    expect(result.metadata!.ttlRefresh).toEqual({ status: "failed", at: new Date(Date.now()).toISOString(), category: "network_error", httpStatus: null, archiveAfter: null });
  });
  it("accepts the exact-ID bare PATCH response", async () => {
    const config = configs[0], network = fixture("running", undefined, true); const lease = await acquire(config); network.mockClear();
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata }))
      .toMatchObject({ providerLeaseId: id, expiresAt: new Date(refreshedDeadline).toISOString(), metadata: { boatOrgId: "team_refreshed", ttlRefresh: { status: "ok" } } });
    expect(network.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
});
