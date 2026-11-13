// Keep: retirement trust boundary and retained sandbox data safety. Wrong-org
// credentials and provider failures are unsafe to seed against live daily leases.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import plugin from "./plugin.js";
const id = "bx_23456789", orgId = "team_lease";
const scope = { driverKey: "boat", companyId: "company", environmentId: "environment", config: { apiKey: "boat_test" } };
const inspect = (leaseMetadata: Record<string, unknown> = { boatOrgId: orgId }) => plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: id, leaseMetadata });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const org = (id: unknown = orgId, active: unknown = true, type: unknown = "org") => ({ id, active, type });
function missing(body: unknown, status = 200) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith(`/sandboxes/${id}`)) return reply({ code: "not_found" }, 404);
    if (url.endsWith("/orgs")) return reply(body, status);
    throw new Error("Unexpected fixture endpoint");
  });
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Boat missing-sandbox organization proof", () => {
  it.each([true, false])("binds the sandbox read to the recorded org, independent of active wallet (%s)", async active => {
    const fetch = missing({ ok: true, orgs: [org(orgId, active)] });
    expect(await inspect()).toMatchObject({ providerLeaseId: id, state: "destroyed" });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("X-Boat-Org")).toBe(orgId);
    expect(fetch.mock.calls[1][0]).toBe("https://boat.dev/api/v1/orgs");
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    // This is the whole account inventory, not a header-filtered substitute.
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has("X-Boat-Org")).toBe(false);
  });
  it.each([
    ["different org", { ok: true, orgs: [org("team_other")] }],
    ["one active, one inactive org", { ok: true, orgs: [org(), org("team_other", false)] }],
    ["inactive Personal plus active org", { ok: true, orgs: [org("personal", false, "personal"), org()] }],
    ["active Personal plus inactive org", { ok: true, orgs: [org("personal", true, "personal"), org(orgId, false)] }],
    ["two active orgs", { ok: true, orgs: [org(), org("team_other")] }],
    ["duplicate org", { ok: true, orgs: [org(), org()] }],
    ["sole Personal with matching id", { ok: true, orgs: [org(orgId, true, "personal")] }],
    ["missing type", { ok: true, orgs: [{ id: orgId, active: true }] }],
    ["unsuccessful response", { ok: false, orgs: [org()] }],
    ["missing ok", { orgs: [org()] }],
    ["missing orgs", { ok: true }],
    ["empty orgs", { ok: true, orgs: [] }],
    ["non-array orgs", { ok: true, orgs: {} }],
    ["missing id", { ok: true, orgs: [org(null)] }],
    ["null row", { ok: true, orgs: [null] }],
  ])("throws not proven for %s", async (_label, body) => {
    missing(body); await expect(inspect()).rejects.toThrow("not proven");
  });
  it.each([401, 403, 500])("throws for /orgs HTTP %i", async status => {
    missing({ ok: false }, status); await expect(inspect()).rejects.toMatchObject({ httpStatus: status });
  });
  it.each([{}, { boatOrgId: "" }, { boatOrgId: 42 }, { boatOrgId: null }])("throws without a recorded org: %j", async metadata => {
    missing({ ok: true, orgs: [org()] }); await expect(inspect(metadata)).rejects.toThrow("no recorded boatOrgId");
  });
  it.each([{}, { boatOrgId: orgId }])("personal 404 is not proven even with conflicting metadata: %j", async metadata => {
    const fetch = missing({ ok: true, orgs: [org()] });
    await expect(inspect({ ...metadata, boatOwner: { kind: "personal" } })).rejects.toThrow("personal lease absence is not proven");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has("X-Boat-Org")).toBe(false);
  });
  it("does not turn an org-key scope mismatch into absence", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => reply({ code: "api_key_org_mismatch" }, 403));
    vi.stubGlobal("fetch", fetch);
    await expect(inspect()).rejects.toMatchObject({ httpStatus: 403 });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("X-Boat-Org")).toBe(orgId);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
const ownershipCases = [
  ["organization", { team: { id: orgId } }, { boatOrgId: orgId }],
  ["personal", { team: null }, { boatOwner: { kind: "personal" } }],
  ["omitted", {}, {}],
  ["empty team", { team: {} }, {}],
  ["blank team id", { team: { id: " " } }, {}],
] as const;
function lifecycleFixture(latest: Record<string, unknown>, options: { created?: Record<string, unknown>; resumed?: Record<string, unknown>; setup?: Record<string, unknown>; patch?: Record<string, unknown> } = {}) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/orgs")) throw new Error("Ownership must never fall back to an account wallet");
    if (url.endsWith("/stop")) return reply({ operation: { id: "stop_owned" } });
    if (url.endsWith("/stops/stop_owned")) return reply({ stop: { status: "completed" } });
    if (url.endsWith("/sandboxes")) return reply({ sandbox: { id, state: "ready", team: { id: "team_create" }, ...options.created } });
    if (url.endsWith("/resume")) return reply({ sandbox: { id, state: "ready", team: { id: "team_post" }, ...options.resumed } });
    if (init?.method === "PATCH") return reply({ sandbox: { id, state: "ready", ...options.patch } });
    if (url.endsWith("/commands")) return reply({ exitCode: 0, stdout: JSON.stringify({ version: 1, provider: "boat", token: "a".repeat(64) }) });
    if (url.endsWith(`/sandboxes/${id}`)) return reply({ sandbox: { id, state: "ready", ...latest, ...(options.setup && fetch.mock.calls.filter(([u]) => u.endsWith(`/sandboxes/${id}`)).length > 1 ? options.setup : {}) } });
    throw new Error("Unexpected fixture endpoint");
  });
  vi.stubGlobal("fetch", fetch); return fetch;
}
function expectOwnership(metadata: Record<string, unknown> | undefined, expected: Record<string, unknown>) {
  expect(metadata).toMatchObject(expected);
  if (!("boatOrgId" in expected)) expect(metadata).not.toHaveProperty("boatOrgId");
  if (!("boatOwner" in expected)) expect(metadata).not.toHaveProperty("boatOwner");
}
describe("Boat ownership is the latest exact allocation observation", () => {
  it.each(ownershipCases)("acquire records %s from readiness, never the create or active wallet", async (_name, latest, expected) => {
    const fetch = lifecycleFixture(latest);
    const lease = await plugin.definition.onEnvironmentAcquireLease!(scope);
    expect(lease.metadata).toMatchObject({ provider: "boat", sandboxId: id, resumedLease: false });
    expectOwnership(lease.metadata, expected);
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/orgs"))).toBe(false);
  });
  it.each(ownershipCases)("resume replaces all stale ownership with %s, preserving unrelated metadata", async (_name, latest, expected) => {
    const fetch = lifecycleFixture(latest);
    const prior = { boatOrgId: "team_old", boatOwner: { kind: "personal" }, preserved: "yes" };
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: prior });
    expect(lease.metadata).toMatchObject({ preserved: "yes", resumedLease: true });
    expectOwnership(lease.metadata, expected);
    expect(prior.boatOrgId).toBe("team_old");
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/orgs"))).toBe(false);
  });
  it.each(["ready", "provisioning"])("acquire rejects a different allocation before using %s readiness", async state => {
    lifecycleFixture({ id: "bx_33333333", state, team: { id: "team_foreign" } });
    await expect(plugin.definition.onEnvironmentAcquireLease!(scope)).rejects.toThrow("different allocation");
  });
  it.each(["ready", "provisioning"])("resume rejects a different allocation before using %s readiness", async state => {
    lifecycleFixture({ id: "bx_33333333", state, team: { id: "team_foreign" } });
    await expect(plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id })).rejects.toThrow("different allocation");
  });
  it.each(["bx_33333333", undefined])("resume rejects an unchecked POST sandbox id %s even if the later GET would match", async wrongId => {
    const fetch = lifecycleFixture({ team: { id: orgId } }, { resumed: { id: wrongId } });
    await expect(plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id })).rejects.toThrow("different allocation");
    expect(fetch.mock.calls.some(([url]) => url.endsWith(`/sandboxes/${id}`))).toBe(false);
  });
  it("acquire refuses a mismatched setup observation", async () => {
    lifecycleFixture({ team: { id: orgId } }, { setup: { id: "bx_33333333", setupStatus: "done" } });
    await expect(plugin.definition.onEnvironmentAcquireLease!({ ...scope, config: { ...scope.config, setupScript: "true" } })).rejects.toThrow("different allocation");
  });
  it("a personally billed final setup observation supersedes an earlier organization", async () => {
    lifecycleFixture({ team: { id: orgId } }, { setup: { team: null, setupStatus: "done" } });
    const lease = await plugin.definition.onEnvironmentAcquireLease!({ ...scope, config: { ...scope.config, setupScript: "true" } });
    expectOwnership(lease.metadata, { boatOwner: { kind: "personal" } });
  });
  const warmMetadata = { sandboxId: id, boatOrgId: "team_old", preserved: "yes", workspaceSentinel: { path: "/home/user/paperclip-workspace/.paperclip-runtime/reusable-sandbox-lease.json", token: "a".repeat(64) } };
  it.each([{}, { boatOrgId: orgId }])("personal warm resume 404 is not proven despite conflicting metadata: %j", async prior => {
    const fetch = vi.fn(async () => reply({ code: "not_found" }, 404));
    vi.stubGlobal("fetch", fetch);
    await expect(plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: { ...warmMetadata, boatOrgId: undefined, ...prior, boatOwner: { kind: "personal" } } })).rejects.toThrow("personal lease absence is not proven");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(ownershipCases)("already-running resume records only its new PATCH's %s ownership", async (_name, latest, expected) => {
    const fetch = lifecycleFixture({ team: { id: "team_before_patch" } }, { patch: latest });
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: warmMetadata });
    expectOwnership(lease.metadata, expected);
    expect(lease.metadata?.preserved).toBe("yes");
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/resume"))).toBe(false);
  });
  it("already-running resume rejects a foreign read", async () => {
    lifecycleFixture({ id: "bx_33333333", team: { id: "team_foreign" } });
    await expect(plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: warmMetadata })).rejects.toThrow("different allocation");
  });
  it.each(ownershipCases)("TTL-refresh resume uses only the PATCH's %s ownership", async (_name, latest, expected) => {
    lifecycleFixture({ team: { id: "team_before_patch" } }, { patch: latest });
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config: { ...scope.config, ttlSeconds: 60, runnerReconnectGraceMs: 600_000 }, providerLeaseId: id, leaseMetadata: warmMetadata });
    expectOwnership(lease.metadata, expected);
  });
  it("TTL-refresh resume ignores a foreign patch, preserving read ownership with a safe warning", async () => {
    const fetch = lifecycleFixture({ team: { id: orgId }, archiveAfter: "2030-01-01T00:00:00Z" }, { patch: { id: "bx_33333333", team: { id: "team_foreign" }, archiveAfter: "2030-01-02T00:00:00Z" } });
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...scope, config: { ...scope.config, ttlSeconds: 60, runnerReconnectGraceMs: 600_000 }, providerLeaseId: id, leaseMetadata: warmMetadata });
    expectOwnership(lease.metadata, { boatOrgId: orgId });
    expect(lease).toMatchObject({ providerLeaseId: id, expiresAt: "2030-01-01T00:00:00Z", metadata: { ttlRefresh: { status: "failed", category: "parse_error", httpStatus: 200 } } });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
});
describe("Native HTTP org confirmation timeout", () => {
  it.each(["headers", "body"])("keeps a stalled org %s unproven after 10 seconds", async part => {
    let server: Server | undefined;
    const realFetch = globalThis.fetch;
    try {
      server = createServer((_req, res) => {
        if (part === "body") { res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":true,"orgs":'); }
      });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => url.endsWith("/orgs")
        ? realFetch(`http://127.0.0.1:${port}/orgs`, init) : Promise.resolve(reply({ code: "not_found" }, 404))));
      const started = performance.now();
      await expect(inspect()).rejects.toThrow();
      const elapsed = performance.now() - started;
      console.log(JSON.stringify({ check: `org-${part}-timeout`, elapsedMs: Math.round(elapsed) }));
      expect(elapsed).toBeGreaterThanOrEqual(9800); expect(elapsed).toBeLessThan(11500);
    } finally {
      server?.closeAllConnections();
      if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
  }, 15000);
});
