import { afterEach, describe, expect, it, vi } from "vitest";
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
function fixture(state: string, failure?: Failure, bare = false) {
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
          archiveAfter: refreshedDeadline, team: { id: "team_refreshed" } };
        return reply(bare ? sandbox : { sandbox });
      }
      const observedState = acquisitionRead || resumed ? "ready" : state;
      acquisitionRead = false;
      return reply({ sandbox: { id, state: observedState,
        archiveAfter: oldDeadline, team: { id: "team_original" } } });
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
      expect(result).toMatchObject({ providerLeaseId: id, expiresAt: refreshedDeadline,
        metadata: { boatOrgId: "team_refreshed", resumedFromState: state, workspaceSentinel: { result: "matched" } } });
      expect(result.metadata).not.toHaveProperty("ttlRefresh");
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
        expect(result.metadata!.ttlRefresh).toEqual({ status: "failed", category, httpStatus });
        expect(JSON.stringify(result)).not.toContain(apiKey);
        expect(network.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
        expect(network.mock.calls.some(([url]) => String(url).endsWith("/resume"))).toBe(false);
      }
    });
  }
  it("accepts the exact-ID bare PATCH response", async () => {
    const config = configs[0], network = fixture("running", undefined, true); const lease = await acquire(config); network.mockClear();
    expect(await plugin.definition.onEnvironmentResumeLease!({ ...scope, config, providerLeaseId: id, leaseMetadata: lease.metadata }))
      .toMatchObject({ providerLeaseId: id, expiresAt: refreshedDeadline, metadata: { boatOrgId: "team_refreshed" } });
    expect(network.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
});
