// Keep: retirement trust boundary and retained sandbox data safety. Wrong-org
// credentials and provider failures are unsafe to seed against live daily leases.
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
const id = "bx_23456789", orgId = "team_lease";
const scope = { driverKey: "boat", companyId: "company", environmentId: "environment", config: { apiKey: "boat_test" } };
const inspect = (leaseMetadata: Record<string, unknown> = { boatOrgId: orgId }) => plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: id, leaseMetadata });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const org = (id: unknown = orgId, active: unknown = true) => ({ id, active });
function missing(body: unknown, status = 200) {
  const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith(`/sandboxes/${id}`)) return reply({ code: "not_found" }, 404);
    // A switched-org key remains valid and can list its own sandboxes. This
    // makes the old key-validity check reproduce unsafe retirement on base.
    if (url.endsWith("/sandboxes?limit=1")) return reply({ ok: true, sandboxes: [] });
    if (url.endsWith("/orgs")) return reply(body, status);
    throw new Error("Unexpected fixture endpoint");
  });
  vi.stubGlobal("fetch", fetch); return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("Boat missing-sandbox organization proof", () => {
  it("reports destroyed only for the recorded active org, ignoring inactive orgs", async () => {
    const fetch = missing({ ok: true, orgs: [org("team_other", false), org()] });
    expect(await inspect()).toMatchObject({ providerLeaseId: id, state: "destroyed" });
    expect(fetch.mock.calls[1][0]).toBe("https://boat.dev/api/v1/orgs");
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
  });
  it.each([
    ["different active org", { ok: true, orgs: [org("team_other")] }],
    ["no active org", { ok: true, orgs: [org(orgId, false)] }],
    ["two active orgs", { ok: true, orgs: [org(), org("team_other")] }],
    ["duplicate active org", { ok: true, orgs: [org(), org()] }],
    ["unsuccessful response", { ok: false, orgs: [org()] }],
    ["missing ok", { orgs: [org()] }],
    ["missing orgs", { ok: true }],
    ["non-array orgs", { ok: true, orgs: {} }],
    ["missing active id", { ok: true, orgs: [org(null)] }],
    ["truthy active", { ok: true, orgs: [org(orgId, 1)] }],
  ])("throws for %s", async (_label, body) => {
    missing(body); await expect(inspect()).rejects.toThrow();
  });
  it.each([401, 500])("throws for /orgs HTTP %i", async status => {
    missing({ ok: false }, status); await expect(inspect()).rejects.toMatchObject({ httpStatus: status });
  });
  it.each([{}, { boatOrgId: "" }, { boatOrgId: 42 }, { boatOrgId: null }])("throws without a recorded org: %j", async metadata => {
    missing({ ok: true, orgs: [org()] }); await expect(inspect(metadata)).rejects.toThrow();
  });
});
describe("Boat acquisition organization metadata", () => {
  it.each(["created", "ready", "fallback", "unavailable", "ambiguous"])("records only a proven org from %s", async source => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/orgs")) {
        if (source === "unavailable") return reply({ ok: false }, 500);
        return reply({ ok: true, orgs: source === "ambiguous" ? [org(), org("team_other")] : [org()] });
      }
      return reply({ sandbox: { id, state: "ready", ...((source === "created" && init?.method === "POST") || (source === "ready" && init?.method !== "POST") ? { team: { id: orgId } } : {}) } });
    });
    vi.stubGlobal("fetch", fetch);
    const lease = await plugin.definition.onEnvironmentAcquireLease!(scope);
    expect(lease.metadata).toMatchObject({ provider: "boat", sandboxId: id, resumedLease: false });
    if (["unavailable", "ambiguous"].includes(source)) expect(lease.metadata).not.toHaveProperty("boatOrgId");
    else expect(lease.metadata?.boatOrgId).toBe(orgId);
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/orgs"))).toBe(!["created", "ready"].includes(source));
  });
  it.each([true, false])("resume records the found sandbox org (team present: %s) and retains metadata", async hasTeam => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/orgs") ? reply({ ok: true, orgs: [org()] }) : reply({ sandbox: { id, state: "ready", ...(hasTeam ? { team: { id: orgId } } : {}) } }));
    vi.stubGlobal("fetch", fetch);
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: { preserved: "yes", boatOrgId: "team_old" } });
    expect(lease.metadata).toMatchObject({ boatOrgId: orgId, preserved: "yes", resumedLease: true });
    expect(fetch.mock.calls.some(([url]) => url.endsWith("/orgs"))).toBe(!hasTeam);
  });
});
