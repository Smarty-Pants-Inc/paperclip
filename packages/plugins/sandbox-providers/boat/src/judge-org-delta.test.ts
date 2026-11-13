// Independent delta judge. Synthetic trust-boundary cases; no Boat access or real keys.
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";
const id = "bx_23456789";
const scope = { driverKey: "boat", companyId: "judge", environmentId: "judge", config: { apiKey: "judge-noncredential" } };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const inspect = (leaseMetadata: Record<string, unknown>) => plugin.definition.onEnvironmentInspectLease!({ ...scope, providerLeaseId: id, leaseMetadata });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("RFL delta requirements", () => {
  it("refuses an account key with two organizations even if only one is the active wallet", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/orgs")
      ? reply({ ok: true, orgs: [{ id: "team_A", type: "org", active: true }, { id: "team_B", type: "org", active: false }] })
      : reply({ code: "not_found" }, 404)));
    await expect(inspect({ boatOrgId: "team_A" })).rejects.toThrow();
  });
  it.each(["unavailable", "ambiguous"])("does not retain old ownership on resume when org proof is %s", async mode => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/orgs")
      ? mode === "unavailable" ? reply({ ok: false }, 500) : reply({ ok: true, orgs: [{ id: "team_B", active: true }, { id: "team_C", active: true }] })
      : reply({ sandbox: { id, state: "ready", team: null } })));
    let result: any;
    try {
      result = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: { boatOrgId: "team_A", preserved: "yes" } });
    } catch { return; } // Refusal is a safe outcome.
    expect(result.metadata.preserved).toBe("yes");
    expect(result.metadata).not.toHaveProperty("boatOrgId", "team_A");
  });
  it("does not relabel a personally billed sandbox as the current active organization", async () => {
    // Documented team:null means personal billing, NOT an older response missing team.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/orgs")
      ? reply({ ok: true, orgs: [{ id: "personal-owner", type: "personal", active: false }, { id: "team_B", type: "org", active: true }] })
      : reply({ sandbox: { id, state: "ready", team: null } })));
    let lease: any;
    try { lease = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id }); }
    catch { return; }
    expect(lease.metadata?.boatOrgId).not.toBe("team_B");
  });
  it.each(["acquire", "resume"])("%s must not bind ownership from a ready response for another sandbox", async mode => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => reply({ sandbox: {
      id: init?.method === "POST" ? id : "bx_33333333", state: "ready",
      team: { id: init?.method === "POST" ? "team_A" : "team_B" },
    } })));
    let lease: any;
    try {
      lease = mode === "acquire"
        ? await plugin.definition.onEnvironmentAcquireLease!(scope)
        : await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: { boatOrgId: "team_A" } });
    } catch { return; }
    expect(lease.providerLeaseId).toBe(id);
    expect(lease.metadata?.boatOrgId).not.toBe("team_B");
  });
  it("a positive inspect does not backfill an old lease; its later 404 stays blocked", async () => {
    const metadata = { preserved: "old-row" };
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id, state: "running", team: { id: "team_A" } } })));
    expect(await inspect(metadata)).toMatchObject({ state: "active" });
    expect(metadata).not.toHaveProperty("boatOrgId");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/orgs")
      ? reply({ ok: true, orgs: [{ id: "team_A", active: true }] }) : reply({ code: "not_found" }, 404)));
    await expect(inspect(metadata)).rejects.toThrow("no recorded boatOrgId");
  });
  it("positive resume overwrites an old organization rather than keeping it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply({ sandbox: { id, state: "ready", team: { id: "team_B" } } })));
    const lease = await plugin.definition.onEnvironmentResumeLease!({ ...scope, providerLeaseId: id, leaseMetadata: { boatOrgId: "team_A", preserved: true } });
    expect(lease.metadata).toMatchObject({ boatOrgId: "team_B", preserved: true });
  });
});
